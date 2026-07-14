const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBatchUpdateProductTagsHandler } = require("../handler");

test("legacy idempotency deployment copies match the repaired canonical helper", () => {
  const canonical = fs.readFileSync(path.resolve(__dirname, "../../common/idempotency.js"), "utf8");
  assert.equal(fs.readFileSync(path.resolve(__dirname, "../idempotency.js"), "utf8"), canonical);
  assert.equal(fs.readFileSync(path.resolve(__dirname, "../common/idempotency.js"), "utf8"), canonical);
});

test("legacy handler keeps old parameters and response while mapping item failures safely", async () => {
  let permission;
  let command;
  const handler = createBatchUpdateProductTagsHandler({
    async requirePermission(value) {
      permission = value;
      return {
        _id: "admin-1",
        openid: "openid-1",
        role: "procurement",
        permissions: ["product:tag:batch_update"],
        status: "active",
        isActive: true
      };
    },
    service: {
      async setManyLegacyTags(value) {
        command = value;
        return {
          changedCount: 1,
          unchangedCount: 1,
          failedCount: 1,
          warningCount: 1,
          failures: [{ id: "product-3", code: "DATA_VERSION_CONFLICT", message: "must not leak" }],
          duplicate: false,
          idempotencyStatus: "success"
        };
      }
    }
  });
  const result = await handler({
    productIds: ["product-1", "product-2", "product-3"],
    addTags: ["新货"],
    removeTags: ["热销"],
    addInternalTags: ["采购关注"],
    removeInternalTags: [],
    setFlags: { isDefective: true },
    defectDescription: "外盒压痕",
    reason: "批量整理",
    batchOperationId: "batch-operation-1",
    idempotencyKey: "legacy-handler-key-0001"
  });

  assert.equal(permission, "product:tag:batch_update");
  assert.deepEqual(command.actor, {
    id: "admin-1",
    openid: "openid-1",
    role: "procurement",
    permissions: ["product:tag:batch_update"],
    status: "active",
    isActive: true,
    sourceClient: "miniprogram"
  });
  assert.deepEqual(command.input, {
    productIds: ["product-1", "product-2", "product-3"],
    addTags: ["新货"],
    removeTags: ["热销"],
    addInternalTags: ["采购关注"],
    removeInternalTags: [],
    setFlags: { isDefective: true },
    defectDescription: "外盒压痕",
    reason: "批量整理"
  });
  assert.deepEqual(result, {
    ok: true,
    data: {
      batchOperationId: "batch-operation-1",
      successCount: 2,
      failureCount: 1,
      failures: [{ productId: "product-3", reason: "商品已变化，请刷新后重试" }],
      warning: "有 1 个瑕疵商品尚未填写瑕疵说明。",
      duplicate: false,
      idempotencyStatus: "success"
    }
  });
  assert.equal(JSON.stringify(result).includes("must not leak"), false);
  assert.equal(JSON.stringify(result).includes("采购关注"), false);
});

test("legacy handler omits absent defectDescription instead of clearing it", async () => {
  let command;
  const handler = createBatchUpdateProductTagsHandler({
    async requirePermission() {
      return {
        _id: "admin-1",
        role: "super_admin",
        permissions: ["*"],
        status: "active",
        isActive: true
      };
    },
    service: {
      async setManyLegacyTags(value) {
        command = value;
        return {
          changedCount: 0,
          unchangedCount: 1,
          failedCount: 0,
          warningCount: 0,
          failures: []
        };
      }
    }
  });
  await handler({
    productIds: ["product-1"],
    removeTags: ["瑕疵"],
    idempotencyKey: "legacy-handler-key-0002"
  });
  assert.equal(Object.hasOwn(command.input, "defectDescription"), false);
});

test("unknown infrastructure errors use one fixed non-leaking response", async () => {
  const handler = createBatchUpdateProductTagsHandler({
    async requirePermission() {
      return { _id: "admin-1", role: "super_admin", permissions: ["*"], status: "active" };
    },
    service: {
      async setManyLegacyTags() {
        throw new Error("database path products/product-1 openid-secret");
      }
    }
  });
  const result = await handler({ productIds: ["product-1"], idempotencyKey: "legacy-handler-key-0003" });
  assert.deepEqual(result, {
    ok: false,
    code: "BATCH_UPDATE_PRODUCT_TAGS_FAILED",
    message: "批量更新商品标签失败"
  });
});

test("known validation and idempotency errors remain compatible", async () => {
  const validationHandler = createBatchUpdateProductTagsHandler({
    async requirePermission() {
      return { _id: "admin-1", role: "super_admin", permissions: ["*"], status: "active" };
    },
    service: {
      async setManyLegacyTags() {
        const error = new Error("请选择要修改的商品");
        error.code = "BATCH_ITEMS_REQUIRED";
        throw error;
      }
    }
  });
  assert.deepEqual(await validationHandler({ idempotencyKey: "legacy-handler-key-0004" }), {
    ok: false,
    code: "BATCH_ITEMS_REQUIRED",
    message: "请选择要修改的商品"
  });

  const idempotencyHandler = createBatchUpdateProductTagsHandler({
    async requirePermission() {
      return { _id: "admin-1", role: "super_admin", permissions: ["*"], status: "active" };
    },
    service: {
      async setManyLegacyTags() {
        const error = new Error("操作正在处理中");
        error.code = "IDEMPOTENCY_PROCESSING";
        throw error;
      }
    },
    idempotencyErrorResponse(error) {
      return { ok: false, code: error.code, message: "操作正在处理中" };
    }
  });
  assert.deepEqual(await idempotencyHandler({ productIds: ["product-1"] }), {
    ok: false,
    code: "IDEMPOTENCY_PROCESSING",
    message: "操作正在处理中"
  });
});
