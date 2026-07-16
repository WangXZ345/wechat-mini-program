const test = require("node:test");
const assert = require("node:assert/strict");

const storage = new Map();
let now = 1_000;
let currentUser = { userId: "user-1" };

const originalGetApp = global.getApp;
const originalWx = global.wx;
global.getApp = () => ({ globalData: { user: currentUser } });
global.wx = {
  getStorageSync(key) { return storage.get(key); },
  setStorageSync(key, value) { storage.set(key, value); },
  removeStorageSync(key) { storage.delete(key); }
};

const realNow = Date.now;
Date.now = () => now;
const cache = require("./performanceCache");

test.after(() => {
  Date.now = realNow;
  global.getApp = originalGetApp;
  global.wx = originalWx;
});

function product(overrides = {}) {
  return {
    _id: "p1",
    name: "公开商品",
    price: 1234,
    imageUrl: "thumb.jpg",
    tags: ["热销", "internal"],
    stock: 88,
    costPrice: 456,
    supplier: "secret",
    internalTags: ["secret"],
    adminRemark: "secret",
    ...overrides
  };
}

test.beforeEach(() => {
  storage.clear();
  now = 1_000;
  currentUser = { userId: "user-1" };
});

test("staged preview is public, isolated and consumed once", () => {
  const staged = cache.stageProductPreview(product());
  assert.equal(staged.productId, "p1");
  ["stock", "costPrice", "supplier", "internalTags", "adminRemark"]
    .forEach((key) => assert.equal(key in staged, false));
  assert.deepEqual(staged.tags, ["热销"]);

  assert.equal(cache.consumeProductPreview("p2"), null);
  const hit = cache.consumeProductPreview("p1");
  assert.equal(hit.data.name, "公开商品");
  assert.equal(cache.consumeProductPreview("p1"), null);
});

test("expired staged preview is rejected", () => {
  cache.stageProductPreview(product(), { ttlMs: 50 });
  now += 51;
  assert.equal(cache.consumeProductPreview("p1"), null);
});

test("invalid staged preview TTL falls back to the default TTL", () => {
  cache.stageProductPreview(product({ _id: "ttl-negative" }), { ttlMs: -10 });
  now += 2;
  assert.equal(cache.consumeProductPreview("ttl-negative").data.productId, "ttl-negative");

  cache.stageProductPreview(product({ _id: "ttl-infinite" }), { ttlMs: Infinity });
  now += 2;
  assert.equal(cache.consumeProductPreview("ttl-infinite").data.productId, "ttl-infinite");
});

test("staged previews are explicitly isolated across openid and userId scopes", () => {
  currentUser = { openid: "openid-a", userId: "user-a" };
  cache.stageProductPreview(product());

  currentUser = { userId: "user-b" };
  assert.equal(cache.consumeProductPreview("p1"), null);

  currentUser = { openid: "openid-a", userId: "user-a" };
  assert.equal(cache.consumeProductPreview("p1").data.name, "公开商品");
});

test("synchronous exact preview is persisted and readable", () => {
  const preview = cache.writeProductPreview(product());
  assert.equal(preview.productId, "p1");
  assert.equal(cache.readProductPreview("p1").data.name, "公开商品");
});

test("expired persistent preview is rejected and removed", () => {
  cache.writeProductPreview(product());
  const key = Array.from(storage.keys()).find((item) => item.includes("product_preview_v1_user-1_p1"));
  assert.ok(key);

  now += cache.PRODUCT_PREVIEW_TTL_MS + 1;

  assert.equal(cache.readProductPreview("p1"), null);
  assert.equal(storage.has(key), false);
});

test("clearProductPreview clears memory and persistent layers", () => {
  cache.stageProductPreview(product());
  cache.writeProductPreview(product());
  cache.clearProductPreview("p1");
  assert.equal(cache.consumeProductPreview("p1"), null);
  assert.equal(cache.readProductPreview("p1"), null);
});
