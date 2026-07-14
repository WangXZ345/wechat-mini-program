const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  actorFromAdmin,
  createStatusHandler,
  createBulkActivateHandler,
  legacyBatchResult
} = require("../statusHandler");

function admin() {
  return {
    _id: "admin-id",
    openid: "server-openid",
    role: "procurement",
    permissions: ["product:update_status"],
    status: "active",
    isActive: true
  };
}

test("delete is a thin explicit-deactivate adapter with server-derived actor", async () => {
  let permission;
  let command;
  const handler = createStatusHandler({
    async requirePermission(value) {
      permission = value;
      return admin();
    },
    service: {
      async setStatus(value) {
        command = value;
        return { productId: "product-1", isActive: false, changed: true, version: 4 };
      }
    }
  });
  const result = await handler({
    productId: "product-1",
    expectedIsActive: true,
    expectedVersion: 3,
    reason: "后台商品下架",
    idempotencyKey: "product-status-key-0001",
    actor: { role: "super_admin" }
  });
  assert.equal(permission, "product:update_status");
  assert.deepEqual(command.actor, actorFromAdmin(admin()));
  assert.deepEqual(command.input, {
    productId: "product-1",
    isActive: false,
    expectedIsActive: true,
    expectedVersion: 3,
    reason: "后台商品下架"
  });
  assert.equal(command.idempotencyKey, "product-status-key-0001");
  assert.equal(command.requireExpectedVersion, false);
  assert.equal(command.allowMissingIdempotencyKey, true);
  assert.deepEqual(result, {
    ok: true,
    data: { productId: "product-1", isActive: false, version: 4 }
  });
});

test("legacy callers may omit optimistic-lock fields and a no-op stays explicit", async () => {
  let command;
  const handler = createStatusHandler({
    async requirePermission() { return admin(); },
    service: {
      async setStatus(value) {
        command = value;
        return { productId: "product-1", isActive: false, version: 3, changed: false };
      }
    }
  });
  assert.deepEqual(await handler({ productId: "product-1" }), {
    ok: true,
    data: { productId: "product-1", isActive: false, version: 3, unchanged: true }
  });
  assert.equal(command.input.isActive, false);
  assert.equal(command.input.expectedIsActive, undefined);
  assert.equal(command.input.expectedVersion, undefined);
  assert.equal(command.idempotencyKey, undefined);
});

test("adapter validates product id and preserves stable idempotency errors", async () => {
  let calls = 0;
  const invalidHandler = createStatusHandler({
    async requirePermission() { return admin(); },
    service: { async setStatus() { calls += 1; return {}; } }
  });
  assert.deepEqual(await invalidHandler({ productId: "" }), { ok: false, message: "缺少商品 ID" });
  assert.equal(calls, 0);

  const conflictHandler = createStatusHandler({
    async requirePermission() { return admin(); },
    service: {
      async setStatus() {
        const error = new Error("请求已被用于其他操作");
        error.code = "IDEMPOTENCY_KEY_CONFLICT";
        error.details = { duplicate: true, idempotencyStatus: "conflict" };
        throw error;
      }
    }
  });
  assert.deepEqual(await conflictHandler({ productId: "product-1", idempotencyKey: "status-key-0001" }), {
    ok: false,
    code: "IDEMPOTENCY_KEY_CONFLICT",
    message: "请求已被用于其他操作",
    data: { duplicate: true, idempotencyStatus: "conflict" }
  });
});

test("bulkActivate is a strict thin adapter when snapshot items are provided", async () => {
  let permission;
  let command;
  const handler = createBulkActivateHandler({
    async requirePermission(value) {
      permission = value;
      return admin();
    },
    service: {
      async setManyStatuses(value) {
        command = value;
        return {
          changedCount: 2,
          unchangedCount: 1,
          failedCount: 1,
          failures: [{
            id: "product-4",
            code: "DATA_VERSION_CONFLICT",
            message: "must not leak"
          }]
        };
      }
    }
  });
  const items = [
    { id: "product-1", expectedIsActive: false, expectedVersion: 3 },
    { id: "product-2", expectedIsActive: false, expectedVersion: 7 }
  ];
  const result = await handler({
    items,
    productIds: ["ignored-legacy-id"],
    isActive: true,
    reason: "批量恢复销售",
    idempotencyKey: "batch-enable-key-0001",
    actor: { role: "super_admin" }
  });
  assert.equal(permission, "product:update_status");
  assert.deepEqual(command, {
    actor: actorFromAdmin(admin()),
    input: { isActive: true, items, reason: "批量恢复销售" },
    idempotencyKey: "batch-enable-key-0001",
    requireExpectedVersion: true,
    allowMissingIdempotencyKey: true
  });
  assert.deepEqual(result, {
    ok: true,
    data: {
      changedCount: 2,
      unchangedCount: 1,
      failedCount: 1,
      failures: [{ id: "product-4", code: "DATA_VERSION_CONFLICT" }],
      updatedCount: 3
    }
  });
});

test("bulkActivate keeps legacy productIds and missing-key compatibility", async () => {
  let command;
  const handler = createBulkActivateHandler({
    async requirePermission() { return admin(); },
    service: {
      async setManyStatuses(value) {
        command = value;
        return { changedCount: 1, unchangedCount: 1, failedCount: 0, failures: [] };
      }
    }
  });
  const result = await handler({ productIds: ["product-1", "product-2"] });
  assert.deepEqual(command.input, {
    isActive: true,
    items: [{ id: "product-1" }, { id: "product-2" }],
    reason: "后台批量上架"
  });
  assert.equal(command.requireExpectedVersion, false);
  assert.equal(command.allowMissingIdempotencyKey, true);
  assert.equal(command.idempotencyKey, undefined);
  assert.equal(result.data.updatedCount, 2);
});

test("bulkActivate preserves batch idempotency errors", async () => {
  const handler = createBulkActivateHandler({
    async requirePermission() { return admin(); },
    service: {
      async setManyStatuses() {
        const error = new Error("批次操作正在处理中");
        error.code = "IDEMPOTENCY_PROCESSING";
        error.details = { duplicate: true, idempotencyStatus: "processing" };
        throw error;
      }
    }
  });
  assert.deepEqual(await handler({ productIds: ["product-1"], idempotencyKey: "batch-key-0001" }), {
    ok: false,
    code: "IDEMPOTENCY_PROCESSING",
    message: "批次操作正在处理中",
    data: { duplicate: true, idempotencyStatus: "processing" }
  });
});

test("legacy batch result counts only changed and unchanged items as updated", () => {
  assert.deepEqual(legacyBatchResult({
    changedCount: 2,
    unchangedCount: 3,
    failedCount: 9,
    failures: [{ id: "product-6", code: "PRODUCT_NOT_FOUND", path: "products/product-6" }]
  }), {
    changedCount: 2,
    unchangedCount: 3,
    failedCount: 1,
    failures: [{ id: "product-6", code: "PRODUCT_NOT_FOUND" }],
    updatedCount: 5
  });
});

test("deployable status service matches canonical and idempotency proxy resolves canonical", () => {
  assert.equal(
    fs.readFileSync(path.resolve(__dirname, "../productStatusService.js"), "utf8"),
    fs.readFileSync(path.resolve(__dirname, "../../common/services/productStatusService.js"), "utf8")
  );
  assert.equal(require("../idempotency"), require("../../common/idempotency"));
});
