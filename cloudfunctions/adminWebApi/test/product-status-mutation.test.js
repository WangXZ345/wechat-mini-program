const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const security = require("../security");
const api = require("../index");

const {
  buildRequest,
  dispatch,
  productStatusRoute,
  normalizeProductStatusMutation,
  productStatusMutationResult,
  defaultProductStatusService,
  productBatchEnableRoute,
  normalizeProductBatchEnableMutation,
  productBatchEnableMutationResult
} = api._test;

const tokenPepper = "s".repeat(32);
const csrfToken = "csrf-token-for-product-status";
const config = { tokenPepper };

test("deployable BFF status service matches the canonical implementation", () => {
  assert.equal(
    fs.readFileSync(path.resolve(__dirname, "../lib/productStatusService.js"), "utf8"),
    fs.readFileSync(path.resolve(__dirname, "../../common/services/productStatusService.js"), "utf8")
  );
});

function auth(overrides = {}) {
  return {
    principal: {
      id: "admin-session-id",
      role: "procurement",
      permissions: ["product:update_status"],
      status: "active",
      ...overrides.principal
    },
    rawAdmin: {
      _id: "raw-admin-id",
      openid: "server-openid",
      role: "finance",
      ...overrides.rawAdmin
    },
    session: {
      csrfTokenHash: security.tokenHash(csrfToken, tokenPepper),
      ...overrides.session
    }
  };
}

function request(action = "toggle-status", overrides = {}) {
  return {
    route: { action: "mutate", resource: "products", mutationAction: action },
    body: {
      id: "product-1",
      isActive: false,
      expectedIsActive: true,
      expectedVersion: 4,
      reason: "运营下架"
    },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": "product-status-key-0001" },
    http: true,
    requestId: "request-status-1",
    ...overrides
  };
}

function batchRequest(overrides = {}) {
  return request("batch-enable", {
    body: {
      isActive: true,
      items: [
        { id: "product-1", expectedIsActive: false, expectedVersion: 4 },
        { id: "product-2", expectedIsActive: true, expectedVersion: 7 }
      ],
      reason: "批量恢复销售"
    },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": "product-batch-enable-key-0001" },
    requestId: "request-batch-enable-1",
    ...overrides
  });
}

test("only the explicit product status routes are migrated", () => {
  assert.equal(typeof defaultProductStatusService.setStatus, "function");
  assert.equal(typeof defaultProductStatusService.setManyStatuses, "function");
  assert.equal(productStatusRoute({ resource: "products", mutationAction: "toggle-status" }), true);
  assert.equal(productBatchEnableRoute({ resource: "products", mutationAction: "batch-enable" }), true);
  assert.equal(productStatusRoute({ resource: "products", mutationAction: "batch-enable" }), false);
  assert.equal(productBatchEnableRoute({ resource: "products", mutationAction: "toggle-status" }), false);
  assert.equal(productStatusRoute({ resource: "products", mutationAction: "edit" }), false);
  assert.equal(productStatusRoute({ resource: "inventory", mutationAction: "set-warning" }), false);
});

test("normalizes strict batch-enable snapshots and deduplicates identical product ids", () => {
  assert.deepEqual(normalizeProductBatchEnableMutation(batchRequest({
    body: {
      isActive: true,
      items: [
        { id: " product-1 ", expectedIsActive: false, expectedVersion: 4 },
        { id: "product-1", expectedIsActive: false, expectedVersion: 4 },
        { id: "product-2", expectedIsActive: true, expectedVersion: 7 }
      ],
      reason: " 批量恢复销售 "
    }
  })), {
    idempotencyKey: "product-batch-enable-key-0001",
    input: {
      isActive: true,
      items: [
        { id: "product-1", expectedIsActive: false, expectedVersion: 4 },
        { id: "product-2", expectedIsActive: true, expectedVersion: 7 }
      ],
      reason: "批量恢复销售"
    }
  });
});

test("batch-enable rejects false targets, aliases, invalid snapshots, conflicts and more than 100 raw items", () => {
  const invalidBodies = [
    { isActive: false, items: [{ id: "product-1", expectedIsActive: false, expectedVersion: 4 }] },
    { isActive: true, items: [] },
    { isActive: true, items: [{ id: "product-1", expectedIsActive: false }] },
    { isActive: true, items: [{ id: "product-1", expectedIsActive: "false", expectedVersion: 4 }] },
    { isActive: true, items: [{ id: "product-1", expectedIsActive: false, expectedVersion: 4, status: "inactive" }] },
    { isActive: true, items: [{ id: "product-1", expectedIsActive: false, expectedVersion: 4 }], productIds: ["product-1"] },
    {
      isActive: true,
      items: [
        { id: "product-1", expectedIsActive: false, expectedVersion: 4 },
        { id: "product-1", expectedIsActive: true, expectedVersion: 5 }
      ]
    },
    {
      isActive: true,
      items: Array.from({ length: 101 }, (_, index) => ({
        id: `product-${index}`,
        expectedIsActive: false,
        expectedVersion: index
      }))
    },
    {
      isActive: true,
      items: Array.from({ length: 101 }, () => ({
        id: "product-1",
        expectedIsActive: false,
        expectedVersion: 4
      }))
    }
  ];
  for (const body of invalidBodies) {
    assert.throws(
      () => normalizeProductBatchEnableMutation(batchRequest({ body })),
      (error) => [
        "BATCH_TARGET_INVALID",
        "BATCH_ITEMS_REQUIRED",
        "BATCH_ITEM_INVALID",
        "BATCH_SIZE_EXCEEDED",
        "DUPLICATE_ITEM_CONFLICT",
        "EXPECTED_STATUS_INVALID",
        "EXPECTED_VERSION_INVALID",
        "INVALID_REQUEST_BODY"
      ].includes(error.code),
      JSON.stringify(body).slice(0, 200)
    );
  }
});

test("batch-enable dispatch derives the actor from the session and projects partial failures without messages", async () => {
  let command;
  const result = await dispatch(batchRequest(), auth(), config, {
    productStatusService: {
      async setManyStatuses(value) {
        command = value;
        return {
          changedCount: 1,
          unchangedCount: 0,
          failedCount: 1,
          failures: [{
            id: "product-2",
            code: "DATA_VERSION_CONFLICT",
            message: "internal products/product-2",
            openid: "must-not-leak"
          }]
        };
      }
    }
  });
  assert.deepEqual(command, {
    actor: {
      id: "admin-session-id",
      openid: "server-openid",
      role: "procurement",
      permissions: ["product:update_status"],
      status: "active",
      isActive: true,
      sourceClient: "admin_web"
    },
    input: {
      isActive: true,
      items: [
        { id: "product-1", expectedIsActive: false, expectedVersion: 4 },
        { id: "product-2", expectedIsActive: true, expectedVersion: 7 }
      ],
      reason: "批量恢复销售"
    },
    idempotencyKey: "product-batch-enable-key-0001",
    requireExpectedVersion: true
  });
  assert.deepEqual(result, {
    affected: 1,
    changedCount: 1,
    unchangedCount: 0,
    failedCount: 1,
    failures: [{ id: "product-2", code: "DATA_VERSION_CONFLICT" }],
    message: "已上架 1 个商品，1 个未处理",
    requestId: "request-batch-enable-1"
  });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(result).includes("products/product-2"), false);
});

test("batch-enable result validation fails closed", () => {
  const invalidResults = [
    {},
    { changedCount: 0, unchangedCount: 0, failedCount: 1, failures: [] },
    { changedCount: 0, unchangedCount: 0, failedCount: 1, failures: [{ id: "", code: "FAILED" }] },
    { changedCount: 0, unchangedCount: 0, failedCount: 1, failures: [{ id: "product-1", code: "" }] },
    { changedCount: 0, unchangedCount: 0, failedCount: 1, failures: [{ id: "product-1", code: "internal-error" }] },
    { changedCount: 0, unchangedCount: 0, failedCount: 1, failures: [{ id: "other-product", code: "FAILED" }] },
    { changedCount: 101, unchangedCount: 0, failedCount: 0, failures: [] }
  ];
  for (const invalidResult of invalidResults) {
    assert.throws(
      () => productBatchEnableMutationResult(invalidResult, "request-1", [{ id: "product-1" }]),
      (error) => error.code === "INVALID_SERVICE_RESPONSE" && error.statusCode === 502
    );
  }
});

test("batch-enable permission and CSRF checks run before normalization or service", async () => {
  let calls = 0;
  const dependencies = {
    productStatusService: {
      async setManyStatuses() {
        calls += 1;
        return {};
      }
    }
  };
  await assert.rejects(
    dispatch(batchRequest(), auth({ principal: { permissions: [] } }), config, dependencies),
    (error) => error.code === "FORBIDDEN"
  );
  await assert.rejects(
    dispatch(batchRequest({
      headers: { "x-admin-csrf": "wrong", "idempotency-key": "product-batch-enable-key-0001" }
    }), auth(), config, dependencies),
    (error) => error.code === "CSRF_VALIDATION_FAILED"
  );
  assert.equal(calls, 0);
});

test("HTTP and trusted Action transports preserve the strict batch-enable body", async () => {
  const payload = {
    isActive: true,
    items: [{ id: "product-1", expectedIsActive: false, expectedVersion: 4 }],
    reason: "批量恢复销售"
  };
  const requests = [
    buildRequest({
      httpMethod: "POST",
      rawPath: "/api/admin/v1/products/batch-enable",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "batch-status-http-key-0001" },
      body: JSON.stringify(payload)
    }),
    buildRequest({
      action: "mutate",
      resource: "products",
      mutationAction: "batch-enable",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "batch-status-action-key-0001" },
      data: payload
    })
  ];
  for (const transportRequest of requests) {
    let command;
    const result = await dispatch(transportRequest, auth(), config, {
      productStatusService: {
        async setManyStatuses(value) {
          command = value;
          return { changedCount: 1, unchangedCount: 0, failedCount: 0, failures: [] };
        }
      }
    });
    assert.deepEqual(command.input, payload);
    assert.equal(result.changedCount, 1);
    assert.equal(result.failedCount, 0);
  }
});

test("canonical batch parameter errors map to stable non-leaking responses", async () => {
  for (const code of ["STATUS_INVALID", "BATCH_LIMIT_EXCEEDED", "BATCH_ITEM_CONFLICT"]) {
    await assert.rejects(
      dispatch(batchRequest(), auth(), config, {
        productStatusService: {
          async setManyStatuses() {
            const error = new Error(`internal ${code} products/product-1`);
            error.code = code;
            error.details = { path: "products/product-1", openid: "must-not-leak" };
            throw error;
          }
        }
      }),
      (error) => error.code === code
        && error.statusCode === 400
        && error.details === undefined
        && !JSON.stringify(error).includes("products/product-1")
        && !JSON.stringify(error).includes("must-not-leak"),
      code
    );
  }
});

test("normalizes the strict explicit-state contract and header idempotency key", () => {
  assert.deepEqual(normalizeProductStatusMutation(request()), {
    idempotencyKey: "product-status-key-0001",
    input: {
      productId: "product-1",
      isActive: false,
      expectedIsActive: true,
      expectedVersion: 4,
      reason: "运营下架"
    }
  });
  assert.throws(
    () => normalizeProductStatusMutation(request("toggle-status", { headers: { "x-admin-csrf": csrfToken } })),
    (error) => error.code === "IDEMPOTENCY_KEY_REQUIRED"
  );
});

test("requires expected state and version without scalar coercion", () => {
  const invalidBodies = [
    { id: "product-1", isActive: false, expectedVersion: 4 },
    { id: "product-1", isActive: false, expectedIsActive: true },
    { id: "product-1", isActive: 0, expectedIsActive: true, expectedVersion: 4 },
    { id: "product-1", isActive: false, expectedIsActive: "true", expectedVersion: 4 },
    { id: "product-1", isActive: false, expectedIsActive: true, expectedVersion: "4" },
    { id: "product-1", isActive: false, expectedIsActive: true, expectedVersion: -1 },
    { id: "product-1", isActive: false, expectedIsActive: true, expectedVersion: 4, reason: 1 }
  ];
  for (const body of invalidBodies) {
    assert.throws(
      () => normalizeProductStatusMutation(request("toggle-status", { body })),
      (error) => [
        "STATUS_INVALID",
        "EXPECTED_STATUS_REQUIRED",
        "EXPECTED_STATUS_INVALID",
        "EXPECTED_VERSION_REQUIRED",
        "EXPECTED_VERSION_INVALID",
        "INVALID_REQUEST_BODY"
      ].includes(error.code),
      JSON.stringify(body)
    );
  }
});

test("rejects aliases, client actor fields and every unknown body field", () => {
  for (const field of ["actor", "role", "openid", "idempotencyKey", "productId", "active", "value", "status", "unknown"]) {
    assert.throws(
      () => normalizeProductStatusMutation(request("toggle-status", {
        body: {
          id: "product-1",
          isActive: false,
          expectedIsActive: true,
          expectedVersion: 4,
          [field]: "forged"
        }
      })),
      (error) => error.code === "INVALID_REQUEST_BODY",
      field
    );
  }
});

test("dispatch derives actor only from the session and maps the strict MutationResult", async () => {
  let command;
  const result = await dispatch(request(), auth(), config, {
    productStatusService: {
      async setStatus(value) {
        command = value;
        return {
          productId: "product-1",
          beforeIsActive: true,
          afterIsActive: false,
          isActive: false,
          status: "",
          version: 5,
          updatedAt: new Date("2026-07-11T08:00:00.000Z"),
          changed: true
        };
      }
    }
  });
  assert.deepEqual(command, {
    actor: {
      id: "admin-session-id",
      openid: "server-openid",
      role: "procurement",
      permissions: ["product:update_status"],
      status: "active",
      isActive: true,
      sourceClient: "admin_web"
    },
    input: {
      productId: "product-1",
      isActive: false,
      expectedIsActive: true,
      expectedVersion: 4,
      reason: "运营下架"
    },
    idempotencyKey: "product-status-key-0001",
    requireExpectedVersion: true
  });
  assert.deepEqual(result, {
    item: {
      id: "product-1",
      status: "inactive",
      isActive: false,
      version: 5,
      updatedAt: "2026-07-11T08:00:00.000Z"
    },
    affected: 1,
    message: "商品已下架",
    requestId: "request-status-1"
  });
});

test("inactive wins over stale draft status and active draft remains draft", () => {
  const inactive = productStatusMutationResult({
    productId: "product-1",
    isActive: false,
    status: "draft",
    version: 5,
    changed: true
  }, "request-1");
  const activeDraft = productStatusMutationResult({
    productId: "product-1",
    isActive: true,
    status: "draft",
    version: 6,
    changed: true
  }, "request-2");
  assert.equal(inactive.item.status, "inactive");
  assert.equal(inactive.item.isActive, false);
  assert.equal(activeDraft.item.status, "draft");
  assert.equal(activeDraft.item.isActive, true);
});

test("no-op and recovered writes do not report another affected row", async () => {
  const result = await dispatch(request(), auth(), config, {
    productStatusService: {
      async setStatus() {
        return {
          productId: "product-1",
          beforeIsActive: false,
          afterIsActive: false,
          isActive: false,
          version: 5,
          changed: false,
          reused: true
        };
      }
    }
  });
  assert.equal(result.affected, 0);
  assert.equal(result.message, "商品上下架状态未重复写入");
  assert.equal(result.item.isActive, false);
});

test("invalid shared-service success data fails closed", async () => {
  const validResult = {
    productId: "product-1",
    isActive: false,
    version: 5,
    changed: true
  };
  const invalidResults = [
    {},
    { ...validResult, productId: "" },
    { ...validResult, productId: 123 },
    { ...validResult, isActive: undefined },
    { ...validResult, isActive: 0 },
    { ...validResult, version: "5" },
    { ...validResult, version: -1 },
    { ...validResult, changed: "false" },
    { ...validResult, changed: undefined }
  ];
  for (const invalidResult of invalidResults) {
    await assert.rejects(
      dispatch(request(), auth(), config, {
        productStatusService: { async setStatus() { return invalidResult; } }
      }),
      (error) => error.code === "INVALID_SERVICE_RESPONSE"
        && error.statusCode === 502
        && error.message === "商品上下架结果无效",
      JSON.stringify(invalidResult)
    );
  }
});

test("permission and CSRF checks run before normalization or the shared service", async () => {
  let calls = 0;
  const dependencies = { productStatusService: { async setStatus() { calls += 1; return {}; } } };
  await assert.rejects(
    dispatch(request(), auth({ principal: { permissions: [] } }), config, dependencies),
    (error) => error.code === "FORBIDDEN"
  );
  await assert.rejects(
    dispatch(request("toggle-status", {
      headers: { "x-admin-csrf": "wrong", "idempotency-key": "product-status-key-0001" }
    }), auth(), config, dependencies),
    (error) => error.code === "CSRF_VALIDATION_FAILED"
  );
  assert.equal(calls, 0);
});

test("HTTP and trusted Action transports preserve the same strict body", async () => {
  const payload = {
    id: "product-1",
    isActive: true,
    expectedIsActive: false,
    expectedVersion: 5,
    reason: "重新上架"
  };
  const requests = [
    buildRequest({
      httpMethod: "POST",
      rawPath: "/api/admin/v1/products/toggle-status",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "status-http-key-0001" },
      body: JSON.stringify(payload)
    }),
    buildRequest({
      action: "mutate",
      resource: "products",
      mutationAction: "toggle-status",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "status-action-key-0001" },
      data: payload
    })
  ];
  for (const transportRequest of requests) {
    let command;
    await dispatch(transportRequest, auth(), config, {
      productStatusService: {
        async setStatus(value) {
          command = value;
          return { productId: "product-1", isActive: true, version: 6, changed: true };
        }
      }
    });
    assert.deepEqual(command.input, {
      productId: "product-1",
      isActive: true,
      expectedIsActive: false,
      expectedVersion: 5,
      reason: "重新上架"
    });
  }
});

test("conflicts and corrupt stored data map to stable non-leaking 409 errors", async () => {
  for (const code of ["DATA_VERSION_CONFLICT", "DATA_VERSION_INVALID", "DATA_STATUS_INVALID"]) {
    await assert.rejects(
      dispatch(request(), auth(), config, {
        productStatusService: {
          async setStatus() {
            const error = new Error(`internal ${code} products/product-1`);
            error.code = code;
            error.statusCode = 409;
            error.details = { documentPath: "products/product-1", rawStatus: "false" };
            throw error;
          }
        }
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.statusCode, 409);
        if (code !== "DATA_VERSION_CONFLICT") {
          assert.equal(error.details, undefined);
          assert.equal(JSON.stringify(error).includes("products/product-1"), false);
          assert.equal(JSON.stringify(error).includes("rawStatus"), false);
        }
        return true;
      },
      code
    );
  }
});

test("remaining product mutations stay explicitly unmigrated", async () => {
  for (const [action, permission] of [["import-confirm", "inventory:import"]]) {
    await assert.rejects(
      dispatch(request(action), auth({ principal: { permissions: [permission] } }), config, {
        productStatusService: { async setStatus() { throw new Error("must not run"); } }
      }),
      (error) => error.code === "SERVICE_NOT_MIGRATED" && error.statusCode === 501,
      action
    );
  }
});
