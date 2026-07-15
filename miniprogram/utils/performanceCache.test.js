const test = require("node:test");
const assert = require("node:assert/strict");

const storage = new Map();
const asyncWrites = [];
let now = 1_000;

const originalGetApp = global.getApp;
const originalWx = global.wx;
global.getApp = () => ({ globalData: { user: { userId: "user-1" } } });
global.wx = {
  getStorageSync(key) { return storage.get(key); },
  setStorageSync(key, value) { storage.set(key, value); },
  removeStorageSync(key) { storage.delete(key); },
  setStorage({ key, data, success }) {
    asyncWrites.push({ key, data });
    storage.set(key, data);
    success();
  }
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

test("async persistence uses wx.setStorage and keeps the cache envelope", async () => {
  asyncWrites.length = 0;
  const preview = await cache.writeProductPreviewAsync(product());
  assert.equal(preview.productId, "p1");
  assert.equal(asyncWrites.length, 1);
  assert.match(asyncWrites[0].key, /^product_preview_v1_user-1_/);
  assert.equal(asyncWrites[0].data.data.productId, "p1");
});

test("clearProductPreview clears memory and persistent layers", () => {
  cache.stageProductPreview(product());
  cache.writeProductPreview(product());
  cache.clearProductPreview("p1");
  assert.equal(cache.consumeProductPreview("p1"), null);
  assert.equal(cache.readProductPreview("p1"), null);
});
