const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const state = {
  authCalls: [],
  calls: [],
  cleared: [],
  nextTicks: [],
  persisted: null,
  responses: {},
  staged: null
};

let definition;
const originalWx = global.wx;
const wxMock = {
  nextTick(callback) {
    state.nextTicks.push(callback);
  },
  getStorageSync() {
    return null;
  }
};

function loadDefinition() {
  const originalLoad = Module._load;
  const originalPage = global.Page;
  global.Page = (value) => {
    definition = value;
  };
  global.wx = wxMock;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.endsWith("utils/api")) {
      return {
        call(name, payload) {
          state.calls.push({ name, payload });
          return Promise.resolve(state.responses[name] || {});
        },
        moneyText(value) {
          return (Number(value) / 100).toFixed(2);
        },
        toast() {},
        feedback: {
          showWarning() {},
          showError() {}
        }
      };
    }
    if (request.endsWith("utils/auth")) {
      return {
        ensureFrontendAccess() {
          state.authCalls.push("ensureFrontendAccess");
          return Promise.resolve();
        },
        ensureLogin(options) {
          state.authCalls.push({ name: "ensureLogin", options });
          return Promise.resolve();
        }
      };
    }
    if (request.endsWith("utils/delivery")) {
      return {
        DELIVERY_TYPE_OPTIONS: [],
        EMPTY_SHIPPING_ADDRESS: {},
        normalizeShippingAddress: (value) => value || {}
      };
    }
    if (request.endsWith("utils/idempotency")) {
      return {
        createSubmitKey() {},
        clearSubmitKey() {},
        generateIdempotencyKey() {}
      };
    }
    if (request.endsWith("utils/performanceCache")) {
      return {
        consumeProductPreview() {
          return state.staged;
        },
        readProductPreview() {
          return state.persisted;
        },
        clearProductPreview(productId) {
          state.cleared.push(productId);
        },
        writeProductPreview() {},
        markDirty() {},
        cartItemFromAddResult() {},
        upsertCartCacheItem() {}
      };
    }
    if (request.endsWith("utils/orientation")) {
      return { initOrientation() {}, cleanupOrientation() {} };
    }
    if (request.endsWith("utils/sync")) return { subscribe: () => () => {} };
    if (request.endsWith("utils/haptics")) return { selection() {} };
    if (request.endsWith("utils/phone")) {
      return {
        ensurePhoneBeforeOrder: () => Promise.resolve(true),
        handlePhoneRequiredError() {}
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./detail.js")];
    require("./detail.js");
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
  }
}

loadDefinition();
test.after(() => {
  global.wx = originalWx;
});

function resetState() {
  state.authCalls.length = 0;
  state.calls.length = 0;
  state.cleared.length = 0;
  state.nextTicks.length = 0;
  state.persisted = null;
  state.responses = {};
  state.staged = null;
}

function createPage() {
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data))
  };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  page.updateTotal = function updateTotal() {
    this.data.totalUpdated = true;
  };
  return page;
}

function runNextTicks() {
  const callbacks = state.nextTicks.splice(0);
  callbacks.forEach((callback) => callback());
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test.beforeEach(resetState);

test("staged preview wins over persistent cache and renders before authentication or network", () => {
  state.staged = { data: { _id: "p1", productId: "p1", name: "内存商品", price: 100 } };
  state.persisted = { data: { _id: "p1", productId: "p1", name: "旧商品", price: 100 } };
  const page = createPage();

  page.onLoad({ id: "p1" });

  assert.equal(page.data.product.name, "内存商品");
  assert.equal(page.data.loading, false);
  assert.equal(page.data.initialized, true);
  assert.deepEqual(state.authCalls, []);
  assert.deepEqual(state.calls, []);
  assert.equal(state.nextTicks.length, 1);
});

test("persistent preview remains the fallback", () => {
  state.persisted = { data: { _id: "p1", productId: "p1", name: "持久商品", price: 100 } };
  const page = createPage();

  assert.equal(page.applyProductPreview("p1"), true);
  assert.equal(page.data.product.name, "持久商品");
});

test("network initialization begins after nextTick and preserves exact detail calls", async () => {
  state.staged = { data: { _id: "p1", productId: "p1", name: "内存商品", price: 100 } };
  state.responses.getProducts = { products: [{ _id: "p1", name: "校准商品", price: 200 }] };
  state.responses.getUserDeliveryPreference = {};
  state.responses.getSettings = {};
  state.responses.getDefaultAddress = {};
  const page = createPage();

  page.onLoad({ id: "p1" });
  assert.deepEqual(state.calls, []);

  runNextTicks();
  await flushPromises();

  assert.deepEqual(state.authCalls[0], { name: "ensureLogin", options: { showLoading: false } });
  assert.equal(state.authCalls[1], "ensureFrontendAccess");
  assert.equal(state.calls.some((item) => item.name === "getProducts"
    && item.payload.onlyActive === true
    && item.payload.productId === "p1"), true);
  ["getUserDeliveryPreference", "getSettings", "getDefaultAddress", "getFavoriteStatus"]
    .forEach((name) => assert.equal(state.calls.some((item) => item.name === name), true));
  assert.equal(page.data.product.name, "校准商品");
});

test("onShow authentication does not start before the first paint", async () => {
  const page = createPage();

  page.onShow();

  assert.deepEqual(state.authCalls, []);
  assert.equal(state.nextTicks.length, 1);
  runNextTicks();
  await flushPromises();
  assert.deepEqual(state.authCalls, ["ensureFrontendAccess"]);
});

test("an unavailable exact network result clears the product preview", async () => {
  state.responses.getProducts = { products: [] };
  const page = createPage();
  page.data.id = "p1";

  await page.loadProduct({ silent: true });

  assert.deepEqual(state.cleared, ["p1"]);
  assert.equal(page.data.product, null);
  assert.equal(page.data.isFavorite, false);
});
