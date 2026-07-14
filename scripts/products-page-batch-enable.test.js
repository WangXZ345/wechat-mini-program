const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const productsPath = path.resolve(__dirname, "../miniprogram/pages/admin/products.js");
const originalLoad = Module._load;
let callImpl = () => Promise.reject(new Error("unexpected call"));
let keySequence = 0;
let pageDefinition;

Module._load = function loadProductsDependencies(request, parent, isMain) {
  if (parent && parent.filename === productsPath) {
    if (request === "../../utils/orientation") {
      return { initOrientation() {}, cleanupOrientation() {} };
    }
    if (request === "../../utils/api") {
      return {
        call(...args) { return callImpl(...args); },
        moneyText(value) { return String(value); },
        toast() {}
      };
    }
    if (request === "../../utils/auth") return { ensureAdmin() { return Promise.resolve(); } };
    if (request === "../../utils/searchNormalize") {
      return { normalizeSearchText(value) { return String(value || "").trim().toLowerCase(); } };
    }
    if (request === "../../utils/idempotency") {
      return { generateIdempotencyKey() { keySequence += 1; return `batch-key-${keySequence}`; } };
    }
    if (request === "../../utils/haptics") {
      return { error() {}, medium() {}, selection() {}, warning() {} };
    }
  }
  return originalLoad(request, parent, isMain);
};

global.Page = (definition) => { pageDefinition = definition; };
require(productsPath);
Module._load = originalLoad;
delete global.Page;

function createPage() {
  const page = {
    ...pageDefinition,
    data: structuredClone(pageDefinition.data),
    selectedProductSnapshots: new Map(),
    productSelectionRequestId: 0,
    bulkActivateAttempt: null,
    productSaveAttempt: null
  };
  page.setData = (updates, callback) => {
    Object.entries(updates).forEach(([key, value]) => {
      const parts = key.split(".");
      let target = page.data;
      while (parts.length > 1) {
        const part = parts.shift();
        target[part] = target[part] || {};
        target = target[part];
      }
      target[parts[0]] = value;
    });
    if (callback) callback();
  };
  return page;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("changing an internal-tag filter cancels an in-flight select-all request", async () => {
  const page = createPage();
  const pending = deferred();
  const requests = [];
  callImpl = (name, payload) => {
    requests.push({ name, payload });
    return pending.promise;
  };

  const selecting = page.selectAllMatching();
  assert.equal(page.data.selectingAll, true);
  page.onInternalTagFilterInput({ detail: { value: "重点" } });
  clearTimeout(page.filterTimer);
  pending.resolve({
    products: [{ _id: "old-product", isActive: false, version: 2 }],
    hasMore: false
  });
  await selecting;

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].payload.filters, {});
  assert.equal(page.data.internalTagFilter, "重点");
  assert.deepEqual(page.data.selectedIds, []);
  assert.equal(page.selectedProductSnapshots.size, 0);
  assert.equal(page.data.selectingAll, false);
});

test("loading another rendered page preserves every id selected by select-all", async () => {
  const page = createPage();
  page.productRequestVersion = 0;
  page.productRequestId = 0;
  page.activeProductRequest = null;
  page.productLoading = null;
  page.pendingProductReset = null;
  page.productResetPromise = null;
  page.resolveProductReset = null;
  page.data.products = [{ _id: "product-1", checked: true }];
  page.data.selectedIds = ["product-1", "product-2", "product-3"];
  page.data.page = 1;
  page.data.total = 3;
  page.data.hasMore = true;
  callImpl = () => Promise.resolve({
    products: [{ _id: "product-2", isActive: false, version: 2 }],
    total: 3,
    hasMore: true
  });

  await page.startProductRequest({ reset: false, version: 0, silent: true });

  assert.deepEqual(page.data.selectedIds, ["product-1", "product-2", "product-3"]);
  assert.equal(page.data.products.find((item) => item._id === "product-2").checked, true);
  assert.equal(page.data.allSelected, true);
});

test("a timed-out batch retry reuses every per-batch idempotency key", async () => {
  const page = createPage();
  const ids = Array.from({ length: 101 }, (_, index) => `product-${index}`);
  ids.forEach((id, index) => {
    page.selectedProductSnapshots.set(id, {
      id,
      expectedIsActive: false,
      expectedVersion: index
    });
  });
  const calls = [];
  callImpl = (name, payload) => {
    calls.push({ name, payload });
    if (calls.length === 2) return Promise.reject(new Error("request timeout"));
    return Promise.resolve({
      updatedCount: payload.items.length,
      changedCount: payload.items.length,
      unchangedCount: 0,
      failedCount: 0
    });
  };

  await assert.rejects(page.runBulkActivate(ids), /request timeout/);
  const result = await page.runBulkActivate(ids);

  assert.equal(calls.length, 4);
  assert.equal(calls[0].payload.idempotencyKey, calls[2].payload.idempotencyKey);
  assert.equal(calls[1].payload.idempotencyKey, calls[3].payload.idempotencyKey);
  assert.notEqual(calls[0].payload.idempotencyKey, calls[1].payload.idempotencyKey);
  assert.equal(result.changedCount, 101);
  assert.deepEqual(calls.map((entry) => entry.payload.items.length), [100, 1, 100, 1]);
});

test("product save sends the loaded version, reuses its key on retry, and does not double-write tags", async () => {
  const page = createPage();
  page.data.form = {
    ...page.data.form,
    _id: "product-1",
    version: 7,
    name: "商品 A",
    price: 6900,
    stock: 12,
    keywordsText: "精华 修护",
    tags: ["热销"],
    internalTagsText: "重点"
  };
  const calls = [];
  callImpl = (name, payload) => {
    calls.push({ name, payload });
    return calls.length === 1 ? Promise.reject(new Error("request timeout")) : Promise.resolve({ productId: "product-1" });
  };

  await page.saveProduct();
  await page.saveProduct();

  const writes = calls.filter((entry) => entry.name === "manageProduct");
  assert.equal(writes.length, 2);
  assert.equal(calls.some((entry) => entry.name === "updateProductTags"), false);
  assert.equal(writes[0].payload.expectedVersion, 7);
  assert.equal(writes[0].payload.idempotencyKey, writes[1].payload.idempotencyKey);
  assert.deepEqual(writes[0].payload.product.tags, ["热销"]);
  assert.deepEqual(writes[0].payload.product.internalTags, ["重点"]);
});

test("changing the product save payload rotates the idempotency key", async () => {
  const page = createPage();
  page.data.form = {
    ...page.data.form,
    _id: "product-1",
    version: 3,
    name: "商品 A",
    price: 6900,
    stock: 12
  };
  const calls = [];
  callImpl = (name, payload) => {
    calls.push({ name, payload });
    return Promise.reject(new Error("request timeout"));
  };

  await page.saveProduct();
  page.data.form.name = "商品 B";
  await page.saveProduct();

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].payload.idempotencyKey, calls[1].payload.idempotencyKey);
});
