const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const api = require("../index");
const durableBatchIdempotency = require("../lib/idempotency");

const { dispatch, inventoryWarningRoute } = api._test;
const tokenPepper = "t".repeat(32);
const csrfToken = "csrf-token-for-inventory-warning";
const config = { tokenPepper };
const passThroughBatchIdempotency = {
  async runIdempotentAction(_options, executor) {
    return { ok: true, data: await executor() };
  }
};

function createIdempotencyDatabase(options = {}) {
  const records = new Map();
  const collection = () => ({
    async add({ data }) {
      if (records.has(data._id)) throw new Error("duplicate key");
      records.set(data._id, structuredClone(data));
      return { _id: data._id };
    },
    doc(id) {
      return {
        async get() { return { data: records.has(id) ? structuredClone(records.get(id)) : null }; },
        async set({ data }) { records.set(id, { ...structuredClone(data), _id: id }); },
        async update({ data }) {
          if (!records.has(id)) throw new Error("document not exist");
          if (options.failFinalize === true && data.status === "success") throw new Error("forced finalize failure");
          records.set(id, { ...records.get(id), ...structuredClone(data), _id: id });
        }
      };
    }
  });
  return {
    async createCollection() {},
    collection,
    async runTransaction(executor) { return executor({ collection }); },
    snapshot() { return Array.from(records.values()).map((record) => structuredClone(record)); }
  };
}

function auth(overrides = {}) {
  return {
    principal: {
      id: "admin-session-id",
      role: "procurement",
      permissions: ["inventory:set_warning"],
      status: "active",
      ...overrides.principal
    },
    rawAdmin: { _id: "raw-admin-id", openid: "server-openid", ...overrides.rawAdmin },
    session: {
      csrfTokenHash: security.tokenHash(csrfToken, tokenPepper),
      ...overrides.session
    }
  };
}

function item(id, version, warningThreshold = 12, expectedWarningThreshold = 6, reason = "季度阈值调整") {
  return {
    id,
    key: id,
    version,
    payload: { warningThreshold, expectedWarningThreshold, reason }
  };
}

function request(overrides = {}) {
  return {
    route: { action: "mutate", resource: "inventory", mutationAction: "batch-warning" },
    body: {
      requestId: "batch-request-001",
      batchId: "warning-batch-001",
      items: [item("product-1", 4), item("product-2", 8, 20, 11, "季度阈值调整")]
    },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": "warning-batch-key-0001" },
    http: true,
    requestId: "transport-request-001",
    ...overrides
  };
}

test("migrates batch warning only for inventory and inventory alerts", () => {
  assert.equal(inventoryWarningRoute({ resource: "inventory", mutationAction: "batch-warning" }), true);
  assert.equal(inventoryWarningRoute({ resource: "inventory-alerts", mutationAction: "batch-warning" }), true);
  assert.equal(inventoryWarningRoute({ resource: "products", mutationAction: "batch-warning" }), false);
  assert.equal(inventoryWarningRoute({ resource: "inventory", mutationAction: "adjust" }), false);
});

test("rejects duplicate product identities and more than 50 items before any write", async () => {
  let calls = 0;
  const dependencies = { inventoryWarningService: { async setWarningStock() { calls += 1; return {}; } } };
  const duplicate = request({ body: { requestId: "batch-request-002", batchId: "warning-batch-002", items: [item("product-1", 1), item("product-1", 2)] } });
  await assert.rejects(dispatch(duplicate, auth(), config, dependencies), (error) => error.code === "BATCH_DUPLICATE_ITEM_ID");
  const overLimit = request({
    body: {
      requestId: "batch-request-003",
      batchId: "warning-batch-003",
      items: Array.from({ length: 51 }, (_, index) => item(`product-${index + 1}`, index))
    }
  });
  await assert.rejects(dispatch(overLimit, auth(), config, dependencies), (error) => error.code === "BATCH_ITEM_LIMIT_EXCEEDED");
  assert.equal(calls, 0);
});

test("passes the session actor and each immutable warning snapshot to the canonical service", async () => {
  const commands = [];
  const result = await dispatch(request(), auth(), config, {
    batchIdempotency: passThroughBatchIdempotency,
    inventoryWarningService: {
      async setWarningStock(command) {
        commands.push(command);
        return {
          productId: command.input.productId,
          stock: 8,
          warningStock: command.input.warningThreshold,
          stockStatus: "warning",
          version: command.input.expectedVersion + 1,
          changed: true
        };
      }
    }
  });
  assert.deepEqual(commands.map((command) => command.actor), [
    { id: "admin-session-id", openid: "server-openid", role: "procurement", permissions: ["inventory:set_warning"], status: "active", isActive: true, sourceClient: "admin_web" },
    { id: "admin-session-id", openid: "server-openid", role: "procurement", permissions: ["inventory:set_warning"], status: "active", isActive: true, sourceClient: "admin_web" }
  ]);
  assert.deepEqual(commands.map((command) => command.input), [
    { productId: "product-1", warningThreshold: 12, expectedWarningThreshold: 6, expectedVersion: 4, reason: "季度阈值调整" },
    { productId: "product-2", warningThreshold: 20, expectedWarningThreshold: 11, expectedVersion: 8, reason: "季度阈值调整" }
  ]);
  assert.deepEqual(result.counts, { total: 2, success: 2, skipped: 0, validation: 0, not_allowed: 0, conflict: 0, permission: 0, business_error: 0, failed: 0, retryable: 0 });
  assert.equal(result.overallStatus, "success");
  assert.deepEqual(result.items.map((entry) => ({ id: entry.id, key: entry.key, version: entry.version, status: entry.status, code: entry.code })), [
    { id: "product-1", key: "product-1", version: 4, status: "success", code: "OK" },
    { id: "product-2", key: "product-2", version: 8, status: "success", code: "OK" }
  ]);
});

test("continues after conflicts and safely projects not-found and internal service failures", async () => {
  const calls = [];
  const result = await dispatch(request(), auth(), config, {
    batchIdempotency: passThroughBatchIdempotency,
    inventoryWarningService: {
      async setWarningStock(command) {
        calls.push(command.input.productId);
        if (command.input.productId === "product-1") {
          const error = new Error("database details should never reach the browser");
          error.code = "DATA_VERSION_CONFLICT";
          error.statusCode = 409;
          throw error;
        }
        const error = new Error("raw storage path /private/customer-record");
        error.code = "PRODUCT_NOT_FOUND";
        error.statusCode = 404;
        throw error;
      }
    }
  });
  assert.deepEqual(calls, ["product-1", "product-2"]);
  assert.equal(result.overallStatus, "failed");
  assert.deepEqual(result.counts, { total: 2, success: 0, skipped: 0, validation: 0, not_allowed: 1, conflict: 1, permission: 0, business_error: 0, failed: 2, retryable: 0 });
  assert.deepEqual(result.items.map((entry) => ({ status: entry.status, code: entry.code, message: entry.message })), [
    { status: "conflict", code: "DATA_VERSION_CONFLICT", message: "数据已更新，请刷新后重试" },
    { status: "not_allowed", code: "NOT_ALLOWED", message: "当前状态不允许处理" }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /database details|private\/customer-record/);
});

test("uses durable outer idempotency to replay an identical batch and reject a changed batch before new work", async () => {
  const commands = [];
  const idempotencyDb = createIdempotencyDatabase();
  const dependencies = {
    batchIdempotency: {
      async runIdempotentAction(options, executor) {
        return durableBatchIdempotency.runIdempotentAction({ ...options, db: idempotencyDb }, executor);
      }
    },
    inventoryWarningService: {
      async setWarningStock(command) {
        commands.push(command);
        return { productId: command.input.productId, stock: 8, warningStock: command.input.warningThreshold, stockStatus: "normal", version: command.input.expectedVersion + 1, changed: true };
      }
    }
  };
  const first = await dispatch(request(), auth(), config, dependencies);
  const replay = await dispatch(request(), auth(), config, dependencies);
  assert.deepEqual(replay, first);
  assert.equal(commands.length, 2);
  assert.notEqual(commands[0].idempotencyKey, commands[1].idempotencyKey);
  assert.match(commands[0].idempotencyKey, /^[a-f0-9]{64}$/);
  await assert.rejects(
    dispatch(request({ body: { ...request().body, items: [...request().body.items, item("product-3", 2)] } }), auth(), config, dependencies),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409
  );
  assert.equal(commands.length, 2);
  assert.equal(idempotencyDb.snapshot().length, 1);
  await assert.rejects(dispatch(request(), auth({ principal: { permissions: [] } }), config, dependencies), (error) => error.code === "FORBIDDEN");
  await assert.rejects(dispatch(request({ headers: { "x-admin-csrf": "bad", "idempotency-key": "warning-batch-key-0001" } }), auth(), config, dependencies), (error) => error.code === "CSRF_VALIDATION_FAILED");
  assert.equal(commands.length, 2);
});

test("does not report a batch success when durable finalization fails", async () => {
  const idempotencyDb = createIdempotencyDatabase({ failFinalize: true });
  let calls = 0;
  const dependencies = {
    batchIdempotency: {
      async runIdempotentAction(options, executor) {
        return durableBatchIdempotency.runIdempotentAction({ ...options, db: idempotencyDb }, executor);
      }
    },
    inventoryWarningService: {
      async setWarningStock(command) {
        calls += 1;
        return { productId: command.input.productId, stock: 8, warningStock: command.input.warningThreshold, stockStatus: "normal", version: command.input.expectedVersion + 1, changed: true };
      }
    }
  };
  const failedRequest = request({ body: { requestId: "batch-request-finalize", batchId: "warning-batch-finalize", items: [item("product-finalize", 4)] } });

  await assert.rejects(
    dispatch(failedRequest, auth(), config, dependencies),
    (error) => error.code === "INVENTORY_SERVICE_UNAVAILABLE" && error.statusCode === 502
  );
  assert.equal(calls, 1);
  await assert.rejects(
    dispatch(failedRequest, auth(), config, dependencies),
    (error) => error.code === "IDEMPOTENCY_PROCESSING" && error.statusCode === 409
  );
  assert.equal(calls, 1);
});

test("projects canonical item key conflicts and rejects malformed canonical success data", async () => {
  const conflict = await dispatch(request({ body: { requestId: "batch-request-009", batchId: "warning-batch-009", items: [item("product-1", 4)] } }), auth(), config, {
    batchIdempotency: passThroughBatchIdempotency,
    inventoryWarningService: {
      async setWarningStock() {
        const error = new Error("raw canonical conflict text");
        error.code = "IDEMPOTENCY_KEY_CONFLICT";
        error.statusCode = 409;
        throw error;
      }
    }
  });
  assert.deepEqual(conflict.items.map((entry) => ({ status: entry.status, code: entry.code, message: entry.message })), [
    { status: "conflict", code: "BATCH_ITEM_FINGERPRINT_CONFLICT", message: "批量项与已完成请求不一致" }
  ]);
  const malformed = await dispatch(request({ body: { requestId: "batch-request-010", batchId: "warning-batch-010", items: [item("product-1", 4)] } }), auth(), config, {
    batchIdempotency: passThroughBatchIdempotency,
    inventoryWarningService: { async setWarningStock() { return { productId: "product-1" }; } }
  });
  assert.equal(malformed.items[0].status, "business_error");
  assert.equal(malformed.items[0].code, "SERVICE_UNAVAILABLE");
  assert.equal(malformed.counts.success, 0);
});
