const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const state = {
  authCalls: [],
  authDeferred: null,
  calls: [],
  cleared: [],
  deferredResponses: {},
  feedbackErrors: [],
  feedbackWarnings: [],
  nextTicks: [],
  persisted: null,
  persistedWrites: [],
  responses: {},
  staged: null,
  subscribeCalls: [],
  unsubscribeCalls: 0
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
          if (state.deferredResponses[name]) return state.deferredResponses[name].promise;
          return Promise.resolve(state.responses[name] || {});
        },
        moneyText(value) {
          return (Number(value) / 100).toFixed(2);
        },
        toast(message) {
          state.feedbackErrors.push(message);
        },
        feedback: {
          showWarning(message) {
            state.feedbackWarnings.push(message);
          },
          showError(message) {
            state.feedbackErrors.push(message);
          }
        }
      };
    }
    if (request.endsWith("utils/auth")) {
      return {
        ensureFrontendAccess() {
          state.authCalls.push("ensureFrontendAccess");
          if (state.authDeferred) return state.authDeferred.promise;
          return Promise.resolve();
        },
        ensureLogin(options) {
          state.authCalls.push({ name: "ensureLogin", options });
          if (state.authDeferred) return state.authDeferred.promise;
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
        writeProductPreview(product) {
          state.persistedWrites.push(product);
        },
        markDirty() {},
        cartItemFromAddResult() {},
        upsertCartCacheItem() {}
      };
    }
    if (request.endsWith("utils/orientation")) {
      return { initOrientation() {}, cleanupOrientation() {} };
    }
    if (request.endsWith("utils/sync")) {
      return {
        subscribe(owner, topics, handler) {
          state.subscribeCalls.push({ owner, topics, handler });
          return () => {
            state.unsubscribeCalls += 1;
          };
        }
      };
    }
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
  state.authDeferred = null;
  state.calls.length = 0;
  state.cleared.length = 0;
  state.deferredResponses = {};
  state.feedbackErrors.length = 0;
  state.feedbackWarnings.length = 0;
  state.nextTicks.length = 0;
  state.persisted = null;
  state.persistedWrites.length = 0;
  state.responses = {};
  state.staged = null;
  state.subscribeCalls.length = 0;
  state.unsubscribeCalls = 0;
}

function createPage() {
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data))
  };
  page.setData = function setData(patch, callback) {
    if (this._testUnloaded) this._testSetDataAfterUnload = (this._testSetDataAfterUnload || 0) + 1;
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  page.updateTotal = function updateTotal() {
    this.data.totalUpdated = true;
  };
  return page;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function unloadPage(page) {
  page.onUnload();
  page._testUnloaded = true;
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
  assert.equal(state.subscribeCalls.length, 0);
  assert.equal(state.nextTicks.length, 1);
});

test("missing preview keeps the initial loading state until first paint", () => {
  const page = createPage();

  page.onLoad({ id: "p1" });

  assert.equal(page.data.product, null);
  assert.equal(page.data.loading, true);
  assert.equal(page.data.initialized, false);
  assert.deepEqual(state.authCalls, []);
  assert.deepEqual(state.calls, []);
  assert.equal(state.subscribeCalls.length, 0);
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
  assert.equal(state.subscribeCalls.length, 0);

  runNextTicks();
  assert.equal(state.subscribeCalls.length, 1);
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

test("product sync subscribes once and is cancelled on unload", async () => {
  const page = createPage();

  page.onLoad({ id: "p1" });
  runNextTicks();
  await flushPromises();
  await page.initializeAfterFirstPaint(false);

  assert.equal(state.subscribeCalls.length, 1);
  page.onUnload();
  assert.equal(state.unsubscribeCalls, 1);
});

test("unload before pending first-paint callback prevents subscription, authentication and API calls", async () => {
  const page = createPage();

  page.onLoad({ id: "p1" });
  unloadPage(page);
  runNextTicks();
  await flushPromises();

  assert.equal(state.subscribeCalls.length, 0);
  assert.deepEqual(state.authCalls, []);
  assert.deepEqual(state.calls, []);
  assert.equal(state.unsubscribeCalls, 0);
});

test("initialization stopped by unload does not continue from authentication into API calls", async () => {
  state.authDeferred = deferred();
  const page = createPage();

  page.onLoad({ id: "p1" });
  runNextTicks();
  unloadPage(page);
  state.authDeferred.resolve();
  await flushPromises();

  assert.equal(state.subscribeCalls.length, 1);
  assert.equal(state.unsubscribeCalls, 1);
  assert.deepEqual(state.calls, []);
  assert.equal(page._testSetDataAfterUnload || 0, 0);
  assert.deepEqual(state.feedbackErrors, []);
});

test("in-flight product, favorite and delivery results do not update or toast after unload", async () => {
  const productResponse = deferred();
  const favoriteResponse = deferred();
  const preferenceResponse = deferred();
  const settingsResponse = deferred();
  const addressResponse = deferred();
  state.deferredResponses = {
    getProducts: productResponse,
    getFavoriteStatus: favoriteResponse,
    getUserDeliveryPreference: preferenceResponse,
    getSettings: settingsResponse,
    getDefaultAddress: addressResponse
  };
  const page = createPage();
  page.data.id = "p1";

  const productRequest = page.loadProduct({ silent: true });
  const favoriteRequest = page.loadFavoriteStatus();
  const deliveryRequest = page.loadDeliveryOptions();
  unloadPage(page);
  productResponse.resolve({ products: [{ _id: "p1", name: "late", price: 200 }] });
  favoriteResponse.resolve({ isFavorite: true });
  preferenceResponse.resolve({});
  settingsResponse.resolve({});
  addressResponse.resolve({});
  await Promise.all([productRequest, favoriteRequest, deliveryRequest]);

  assert.equal(page._testSetDataAfterUnload || 0, 0);
  assert.deepEqual(state.feedbackErrors, []);
  assert.deepEqual(state.feedbackWarnings, []);
  assert.equal(page.productLoading, null);
});

test("rejected product, delivery and authentication requests after unload are safely consumed", async () => {
  const productResponse = deferred();
  const preferenceResponse = deferred();
  const settingsResponse = deferred();
  const addressResponse = deferred();
  state.authDeferred = deferred();
  state.deferredResponses = {
    getProducts: productResponse,
    getUserDeliveryPreference: preferenceResponse,
    getSettings: settingsResponse,
    getDefaultAddress: addressResponse
  };
  const page = createPage();
  page.data.id = "p1";

  const authRequest = page.initializeAfterFirstPaint(false);
  const productRequest = page.loadProduct({ silent: true });
  const deliveryRequest = page.loadDeliveryOptions();
  unloadPage(page);
  state.authDeferred.reject(new Error("late auth failure"));
  productResponse.reject(new Error("late product failure"));
  preferenceResponse.reject(new Error("late delivery failure"));
  settingsResponse.resolve({});
  addressResponse.resolve({});
  await Promise.all([authRequest, productRequest, deliveryRequest]);
  await flushPromises();

  assert.equal(page._testSetDataAfterUnload || 0, 0);
  assert.deepEqual(state.feedbackErrors, []);
  assert.deepEqual(state.feedbackWarnings, []);
  assert.equal(page.productLoading, null);
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

test("in-flight onShow authentication does not apply stored address after unload", async () => {
  state.authDeferred = deferred();
  const page = createPage();
  page.applySelectedAddressFromStorage = () => page.setData({ selectedAddressText: "late" });

  page.onShow();
  runNextTicks();
  unloadPage(page);
  state.authDeferred.resolve();
  await flushPromises();

  assert.equal(page._testSetDataAfterUnload || 0, 0);
  assert.equal(page.data.selectedAddressText, "");
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
