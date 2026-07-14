const test = require("node:test");
const assert = require("node:assert/strict");
const { createProductWriteHandler } = require("../productWriteHandler");

function admin() {
  return { _id: "admin-id", openid: "server-openid", role: "procurement", permissions: ["product:create", "product:update"], status: "active", isActive: true };
}

test("legacy create maps the server admin and preserves the old response shape", async () => {
  let command;
  const handler = createProductWriteHandler({ service: {
    async createProduct(value) { command = value; return { productId: "product-1", version: 1 }; },
    async updateLegacyFull() { throw new Error("must not run"); }
  } });
  const product = { name: "商品", price: 100, stock: 1 };
  assert.deepEqual(await handler({ action: "create", product }, admin()), { ok: true, data: { productId: "product-1", version: 1 } });
  assert.deepEqual(command.actor, {
    id: "server-openid", openid: "server-openid", role: "procurement", permissions: ["product:create", "product:update"],
    status: "active", isActive: true, sourceClient: "miniprogram"
  });
  assert.equal(command.input, product);
  assert.equal(command.allowMissingIdempotencyKey, true);
  assert.equal(command.legacy, true);
});

test("legacy update accepts missing lock and idempotency fields while returning version", async () => {
  let command;
  const handler = createProductWriteHandler({ service: {
    async createProduct() { throw new Error("must not run"); },
    async updateLegacyFull(value) { command = value; return { productId: "product-1", version: 4, changed: false }; }
  } });
  const result = await handler({ action: "update", productId: "product-1", product: { name: "商品" } }, admin());
  assert.deepEqual(result, { ok: true, data: { productId: "product-1", version: 4, unchanged: true } });
  assert.equal(command.input.expectedVersion, undefined);
  assert.equal(command.input.expectedStock, undefined);
  assert.equal(command.idempotencyKey, undefined);
  assert.equal(command.allowMissingIdempotencyKey, true);
});

test("legacy update forwards the trusted stock snapshot to the canonical service", async () => {
  let command;
  const handler = createProductWriteHandler({ service: {
    async createProduct() { throw new Error("must not run"); },
    async updateLegacyFull(value) { command = value; return { productId: "product-1", version: 5, changed: true }; }
  } });
  await handler({ action: "update", productId: "product-1", product: { name: "商品", stock: 9 }, expectedVersion: 4, expectedStock: 7 }, admin());
  assert.equal(command.input.expectedVersion, 4);
  assert.equal(command.input.expectedStock, 7);
});

test("legacy adapter validates id and preserves idempotency errors", async () => {
  const handler = createProductWriteHandler({ service: {
    async createProduct() { throw new Error("must not run"); },
    async updateLegacyFull() { const error = new Error("请求已被用于其他操作"); error.code = "IDEMPOTENCY_KEY_CONFLICT"; throw error; }
  } });
  assert.deepEqual(await handler({ action: "update", productId: "" }, admin()), { ok: false, message: "缺少商品 ID" });
  assert.deepEqual(await handler({ action: "update", productId: "product-1" }, admin()), {
    ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", message: "请求已被用于其他操作",
    data: { duplicate: true, idempotencyStatus: "conflict" }
  });
});
