const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const events = [];
let definition;
const originalWx = global.wx;
const wxMock = {
  navigateTo(options) {
    events.push("navigate");
    if (typeof options.success === "function") options.success({});
  }
};

function loadPageDefinition() {
  const originalLoad = Module._load;
  const originalPage = global.Page;
  global.Page = (value) => { definition = value; };
  global.wx = wxMock;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.endsWith("utils/performanceCache")) return {
      stageProductPreview(product) { events.push(`stage:${product._id}`); return { productId: product._id }; },
      readCache() { return null; }, readCartCache() { return null; }, scopedCacheKey() { return "k"; },
      clearDirty() {}, isDirty() { return false; }, writeCache() {}, writeCartCache() {},
      cartItemFromAddResult() {}, cartCountFromPayload() { return 0; }, upsertCartCacheItem() {}
    };
    if (request.endsWith("utils/api")) return { call: () => Promise.resolve({}), moneyText: String, toast() {}, feedback: { showInfo() {} } };
    if (request.endsWith("utils/auth")) return { ensureFrontendAccess: () => Promise.resolve(), ensureLogin: () => Promise.resolve(), redirectDefaultEntry: () => Promise.resolve({}) };
    if (request.endsWith("utils/searchNormalize")) return { normalizeSearchText: String };
    if (request.endsWith("utils/tabbar")) return { setTabBarCartBadge() {}, setTabBarSelected() {} };
    if (request.endsWith("utils/orientation")) return { initOrientation() {}, cleanupOrientation() {} };
    if (request.endsWith("utils/sync")) return { subscribe: () => () => {} };
    if (request.endsWith("utils/haptics")) return { selection() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./index.js")];
    require("./index.js");
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
  }
}

loadPageDefinition();
test.after(() => { global.wx = originalWx; });

function pageWith(products, visibleRecommendSections = []) {
  return { ...definition, data: { ...definition.data, products, visibleRecommendSections } };
}

test("home list stages preview and navigates without persistence", () => {
  events.length = 0;
  const page = pageWith([{ _id: "p1", name: "商品" }]);
  page.goDetail({ currentTarget: { dataset: { id: "p1" } } });
  assert.deepEqual(events, ["stage:p1", "navigate"]);
});

test("visible recommendation stages preview and navigates without persistence", () => {
  events.length = 0;
  const page = pageWith([], [{ products: [{ _id: "p2", name: "推荐商品" }] }]);
  page.goDetail({ currentTarget: { dataset: { id: "p2" } } });
  assert.deepEqual(events, ["stage:p2", "navigate"]);
});

test("missing product still navigates without attempting persistence", () => {
  events.length = 0;
  const page = pageWith([]);
  page.goDetail({ currentTarget: { dataset: { id: "missing" } } });
  assert.deepEqual(events, ["navigate"]);
});

test("home recommendation cards keep the compact matched heights", () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, "index.wxss"), "utf8");
  const template = fs.readFileSync(path.join(__dirname, "index.wxml"), "utf8");
  assert.match(stylesheet, /\.recommend-skeleton-card\s*\{[^}]*height:\s*464rpx;/s);
  assert.match(stylesheet, /\.recommend-card\.home-rail-card\s*\{[^}]*height:\s*464rpx;/s);
  assert.match(stylesheet, /\.recommend-visual-row\s*\{[^}]*height:\s*168rpx;/s);
  assert.match(stylesheet, /\.recommend-image\s*\{[^}]*width:\s*168rpx;[^}]*height:\s*168rpx;/s);
  assert.doesNotMatch(stylesheet, /\.page\.is-wide\s+\.recommend-image\s*\{/);
  assert.match(template, /recommend-seal-\{\{item\.sectionKey\}\}/);
  ["frequent_purchase", "new_arrivals", "hot_selling"].forEach((sectionKey) => {
    assert.match(template, new RegExp(`item\\.sectionKey === '${sectionKey}'`));
  });
});
