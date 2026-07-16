const test = require("node:test");
const assert = require("node:assert/strict");

const storage = new Map();
const asyncWrites = [];
const pendingAsyncWrites = [];
let deferAsyncWrites = false;
let now = 1_000;
let currentUser = { userId: "user-1" };

const originalGetApp = global.getApp;
const originalWx = global.wx;
global.getApp = () => ({ globalData: { user: currentUser } });
global.wx = {
  getStorageSync(key) { return storage.get(key); },
  setStorageSync(key, value) { storage.set(key, value); },
  removeStorageSync(key) { storage.delete(key); },
  setStorage({ key, data, success, fail }) {
    asyncWrites.push({ key, data });
    if (deferAsyncWrites) {
      pendingAsyncWrites.push({
        complete() {
          storage.set(key, data);
          success();
        },
        fail() {
          if (fail) fail();
        }
      });
      return;
    }
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

test.beforeEach(() => {
  storage.clear();
  asyncWrites.length = 0;
  pendingAsyncWrites.length = 0;
  deferAsyncWrites = false;
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

test("async persistence uses wx.setStorage and keeps the cache envelope", async () => {
  asyncWrites.length = 0;
  const preview = await cache.writeProductPreviewAsync(product());
  assert.equal(preview.productId, "p1");
  assert.equal(asyncWrites.length, 1);
  assert.match(asyncWrites[0].key, /^product_preview_v1_user-1_/);
  assert.equal(asyncWrites[0].data.data.productId, "p1");
});

test("late async preview completion reconciles the exact preview", async () => {
  deferAsyncWrites = true;
  const oldWrite = cache.writeProductPreviewAsync(product({ name: "old" }));
  assert.equal(pendingAsyncWrites.length, 1);

  cache.writeProductPreview(product({ name: "exact" }));
  pendingAsyncWrites[0].complete();
  assert.equal((await oldWrite).name, "old");

  assert.equal(cache.readProductPreview("p1").data.name, "exact");
});

test("late async preview completion reconciles a clear tombstone", async () => {
  deferAsyncWrites = true;
  const oldWrite = cache.writeProductPreviewAsync(product({ name: "old" }));
  assert.equal(pendingAsyncWrites.length, 1);

  cache.clearProductPreview("p1");
  pendingAsyncWrites[0].complete();
  await oldWrite;

  assert.equal(cache.readProductPreview("p1"), null);
  assert.equal(Array.from(storage.keys()).some((key) => key.includes("product_preview_v1_user-1_p1")), false);
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
