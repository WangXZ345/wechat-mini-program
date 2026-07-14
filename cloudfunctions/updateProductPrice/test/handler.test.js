const test = require("node:test");
const assert = require("node:assert/strict");
const { actorFromAdmin, createLegacyHandler } = require("../handler");

function admin() {
  return {
    _id: "admin-id",
    openid: "server-openid",
    role: "procurement",
    permissions: ["product:update_price"],
    status: "active",
    isActive: true
  };
}

test("legacy handler preserves event and response fields while deriving actor from auth", async () => {
  let permission;
  let command;
  const handler = createLegacyHandler({
    async requirePermission(value) {
      permission = value;
      return admin();
    },
    service: {
      async setPrice(value) {
        command = value;
        return { productId: "product-1", beforePrice: 6900, afterPrice: 7200, changed: true, version: 4 };
      }
    }
  });
  const result = await handler({ productId: "product-1", newPrice: 7200, reason: "后台单个改价", actor: { role: "super_admin" } });
  assert.equal(permission, "product:update_price");
  assert.deepEqual(command.actor, actorFromAdmin(admin()));
  assert.deepEqual(command.input, { productId: "product-1", newPriceCents: 7200, reason: "后台单个改价" });
  assert.equal(command.requireExpectedVersion, false);
  assert.equal(command.allowMissingIdempotencyKey, true);
  assert.equal(command.idempotencyKey, undefined);
  assert.deepEqual(result, { ok: true, data: { productId: "product-1", beforePrice: 6900, afterPrice: 7200 } });
});

test("legacy no-op retains the unchanged response flag", async () => {
  const handler = createLegacyHandler({
    async requirePermission() { return admin(); },
    service: { async setPrice() { return { productId: "product-1", beforePrice: 6900, afterPrice: 6900, changed: false }; } }
  });
  assert.deepEqual(await handler({ productId: "product-1", newPrice: 6900 }), {
    ok: true,
    data: { productId: "product-1", beforePrice: 6900, afterPrice: 6900, unchanged: true }
  });
});

test("legacy handler keeps numeric coercion and old validation failures", async () => {
  let calls = 0;
  const handler = createLegacyHandler({
    async requirePermission() { return admin(); },
    service: { async setPrice() { calls += 1; return {}; } }
  });
  assert.equal((await handler({ productId: "product-1", newPrice: "7200" })).ok, true);
  assert.deepEqual(await handler({ productId: "", newPrice: 7200 }), { ok: false, message: "缺少商品 ID" });
  assert.deepEqual(await handler({ productId: "product-1", newPrice: -1 }), { ok: false, message: "Invalid price" });
  assert.equal(calls, 1);
});

test("legacy handler returns stable idempotency errors", async () => {
  const handler = createLegacyHandler({
    async requirePermission() { return admin(); },
    service: {
      async setPrice() {
        const error = new Error("请求已被用于其他操作");
        error.code = "IDEMPOTENCY_KEY_CONFLICT";
        error.details = { duplicate: true, idempotencyStatus: "conflict" };
        throw error;
      }
    }
  });
  assert.deepEqual(await handler({ productId: "product-1", newPrice: 7200, idempotencyKey: "price-key-0001" }), {
    ok: false,
    code: "IDEMPOTENCY_KEY_CONFLICT",
    message: "请求已被用于其他操作",
    data: { duplicate: true, idempotencyStatus: "conflict" }
  });
});

test("development service proxy resolves the canonical implementation", () => {
  assert.equal(require("../productPriceService"), require("../../common/services/productPriceService"));
});
