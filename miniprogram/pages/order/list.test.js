const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const apiState = {
  calls: [],
  responses: [],
  toastMessages: []
};

function resetApiState() {
  apiState.calls.length = 0;
  apiState.responses.length = 0;
  apiState.toastMessages.length = 0;
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

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

function loadPageDefinition() {
  let definition = null;
  const originalPage = global.Page;
  const originalWx = global.wx;
  const originalLoad = Module._load;
  global.Page = (value) => { definition = value; };
  global.wx = {
    stopPullDownRefresh() {},
    navigateTo() {}
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.endsWith("utils/api")) {
      return {
        call(name, payload, options) {
          apiState.calls.push({ name, payload, options });
          const response = apiState.responses.shift();
          return response instanceof Error ? Promise.reject(response) : Promise.resolve(response || {});
        },
        moneyText: String,
        toast(message) { apiState.toastMessages.push(message); },
        feedback: { showError() {} }
      };
    }
    if (request.endsWith("utils/auth")) return { ensureFrontendAccess: () => Promise.resolve(), ensureLogin: () => Promise.resolve() };
    if (request.endsWith("utils/status")) return { ORDER_STATUS_TEXT: {}, getStatusMeta: () => ({ label: "", className: "" }), orderStatusMap: {}, paymentStatusMap: {} };
    if (request.endsWith("utils/tabbar")) return { syncTabBar() {} };
    if (request.endsWith("utils/orientation")) return { initOrientation() {}, cleanupOrientation() {} };
    if (request.endsWith("utils/sync")) return { subscribe: () => () => {} };
    if (request.endsWith("utils/motion")) return { staggerClass: () => "" };
    if (request.endsWith("utils/haptics")) return { selection() {} };
    if (request.endsWith("utils/performanceCache")) return { clearDirty() {}, isDirty: () => false };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const file = require.resolve("./list.js");
    delete require.cache[file];
    require("./list.js");
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
    global.wx = originalWx;
  }
  return definition;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPage(definition) {
  const page = { ...definition, data: clone(definition.data) };
  page.setData = function setData(patch, callback) {
    Object.entries(patch).forEach(([key, value]) => {
      const path = key.split(".");
      let target = this.data;
      for (let index = 0; index < path.length - 1; index += 1) target = target[path[index]];
      target[path[path.length - 1]] = value;
    });
    if (callback) callback();
  };
  return page;
}

const helpers = require("./orderFilters");
const definition = loadPageDefinition();

const wxml = fs.readFileSync(path.join(__dirname, "list.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(__dirname, "list.wxss"), "utf8");

test("WXML exposes search, active chips and always-visible stage tabs", () => {
  assert.match(wxml, /<input[\s\S]*?maxlength="64"[\s\S]*?bindinput="onSearchInput"[\s\S]*?bindconfirm="submitSearch"[\s\S]*?\/>/);
  assert.match(wxml, /class="order-filter-trigger[^\"]*"[^>]*bindtap="openFilterDrawer"[\s\S]*?activeFilterCount/);
  assert.match(wxml, /wx:for="\{\{activeFilterChips\}\}"[^>]*wx:key="key"/);
  assert.match(wxml, /bindtap="clearAllFilters"[^>]*>[\s\S]*?清除/);
  const stageScroll = wxml.match(/<scroll-view[^>]*class="order-filter-scroll[^\"]*"[^>]*>/);
  assert.ok(stageScroll, "处理阶段 tabs 必须存在");
  assert.doesNotMatch(stageScroll[0], /wx:if=/);
});

test("WXML distinguishes filtered empty state and progressive older-order search", () => {
  assert.match(wxml, /!orders\.length && !hasMore && !loadError/);
  assert.match(wxml, /没有符合条件的订单/);
  assert.match(wxml, /暂无订单/);
  assert.match(wxml, /class="btn btn-secondary empty-clear-button"[\s\S]*?bindtap="clearAllFilters"/);
  assert.match(wxml, /wx:if="\{\{searchingOlderOrders\}\}"[\s\S]*?正在查找更早订单/);
  assert.match(wxml, /wx:if="\{\{showContinueOlderSearch\}\}"[\s\S]*?bindtap="continueOlderSearch"[\s\S]*?继续查找更早订单/);
  assert.doesNotMatch(wxml, /当前筛选暂无订单/);
});

test("WXML drawer binds native mask, draft controls and actions to existing handlers", () => {
  assert.match(wxml, /class="filter-drawer-mask"[^>]*bindtap="closeFilterDrawer"[^>]*catchtouchmove="noop"/);
  assert.match(wxml, /class="order-filter-drawer"[^>]*catchtap="noop"/);
  assert.match(wxml, /wx:for="\{\{timePresets\}\}"[^>]*wx:key="value"[^>]*bindtap="selectTimePreset"/);
  assert.match(wxml, /draftFilters\.timePreset === 'custom'/);
  assert.match(wxml, /<picker[^>]*mode="date"[^>]*value="\{\{draftFilters\.startDate\}\}"[^>]*bindchange="onCustomStartDateChange"/);
  assert.match(wxml, /<picker[^>]*mode="date"[^>]*value="\{\{draftFilters\.endDate\}\}"[^>]*bindchange="onCustomEndDateChange"/);
  assert.match(wxml, /wx:for="\{\{paymentFilterOptions\}\}"[^>]*bindtap="togglePaymentStatus"/);
  assert.match(wxml, /wx:for="\{\{deliveryFilterOptions\}\}"[^>]*bindtap="toggleDeliveryStatus"/);
  assert.match(wxml, /bindtap="resetDraftFilters"[\s\S]*?bindtap="applyDraftFilters"/);
});

test("WXML event handlers exist and repeated nodes avoid if-for/key hazards", () => {
  const handlers = Array.from(wxml.matchAll(/(?:bindtap|catchtap|bindinput|bindconfirm|bindchange|catchtouchmove)="([A-Za-z_$][\w$]*)"/g), (match) => match[1]);
  handlers.forEach((name) => assert.equal(typeof definition[name], "function", `缺少 WXML handler: ${name}`));
  assert.doesNotMatch(wxml, /<[^>]+wx:if="[^"]+"[^>]+wx:for="[^"]+"[^>]*>/);
  assert.doesNotMatch(wxml, /<[^>]+wx:for="[^"]+"[^>]+wx:if="[^"]+"[^>]*>/);
  Array.from(wxml.matchAll(/<[^>]+wx:for="[^"]+"[^>]*>/g), (match) => match[0])
    .forEach((tag) => assert.match(tag, /wx:key="[^"]+"/));
});

test("WXSS keeps controls compact and drawer scrollable above the safe area", () => {
  assert.match(wxss, /\.order-search-row\s*\{[\s\S]*?display:\s*flex[\s\S]*?\}/);
  assert.match(wxss, /\.order-search-input\s*\{[\s\S]*?min-width:\s*0[\s\S]*?box-sizing:\s*border-box[\s\S]*?\}/);
  assert.match(wxss, /\.order-filter-trigger\s*\{[\s\S]*?flex-shrink:\s*0[\s\S]*?\}/);
  assert.match(wxss, /\.order-filter-drawer\s*\{[\s\S]*?max-height:\s*82vh[\s\S]*?overflow-y:\s*auto[\s\S]*?env\(safe-area-inset-bottom\)[\s\S]*?\}/);
  assert.match(wxss, /\.filter-drawer-actions\s*\{[\s\S]*?position:\s*sticky[\s\S]*?\}/);
  assert.match(wxss, /@media\s*\(max-width:\s*360px\)[\s\S]*?\.filter-option\s*\{[\s\S]*?min-width:\s*calc\(50% - 6rpx\)/);
});

test("empty filters and local YYYY-MM-DD conversion are stable", () => {
  assert.deepEqual(helpers.emptyDetailedFilters(), {
    timePreset: "all",
    startDate: "",
    endDate: "",
    paymentStatuses: [],
    deliveryStatuses: []
  });
  assert.equal(helpers.localDateIso("2026-07-01", false), new Date(2026, 6, 1, 0, 0, 0, 0).toISOString());
  assert.equal(helpers.localDateIso("2026-07-01", true), new Date(2026, 6, 1, 23, 59, 59, 999).toISOString());
  assert.throws(() => helpers.localDateIso("2026-02-30", false), /日期无效/);
});

test("today, 7d and 30d ranges use inclusive local calendar days", () => {
  const now = new Date(2026, 6, 13, 12, 30, 0, 0);
  assert.deepEqual(helpers.presetRange("today", now), {
    startDate: new Date(2026, 6, 13, 0, 0, 0, 0).toISOString(),
    endDate: new Date(2026, 6, 13, 23, 59, 59, 999).toISOString()
  });
  assert.equal(helpers.presetRange("7d", now).startDate, new Date(2026, 6, 7, 0, 0, 0, 0).toISOString());
  assert.equal(helpers.presetRange("30d", now).startDate, new Date(2026, 5, 14, 0, 0, 0, 0).toISOString());
});

test("custom filter validation requires complete ordered dates", () => {
  assert.throws(() => helpers.validateDetailedFilters({ timePreset: "custom", startDate: "", endDate: "2026-07-01" }), /请选择完整/);
  assert.throws(() => helpers.validateDetailedFilters({ timePreset: "custom", startDate: "2026-07-10", endDate: "2026-07-01" }), /开始日期不能晚于结束日期/);
  assert.equal(helpers.validateDetailedFilters({ timePreset: "custom", startDate: "2026-07-01", endDate: "2026-07-01" }), true);
});

test("unknown time presets are rejected instead of falling back to 30d", () => {
  assert.throws(
    () => helpers.validateDetailedFilters({ ...helpers.emptyDetailedFilters(), timePreset: "90d" }),
    /时间范围无效/
  );
  assert.throws(() => helpers.presetRange("90d", new Date(2026, 6, 13)), /时间范围无效/);
});

test("filter query contains stage, dates, multi-select statuses, keyword and cursor", () => {
  const query = helpers.buildCustomerOrderQuery({
    activeOrderFilter: "shipping",
    searchKeyword: " ORDER-18 ",
    appliedFilters: {
      timePreset: "custom",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      paymentStatuses: ["paid", "partial_paid"],
      deliveryStatuses: ["shipped"]
    }
  }, "cursor-1");
  assert.equal(query.pageSize, 10);
  assert.equal(query.cursor, "cursor-1");
  assert.equal(query.filters.orderStage, "shipping");
  assert.equal(query.filters.keyword, "ORDER-18");
  assert.deepEqual(query.filters.paymentStatuses, ["paid", "partial_paid"]);
  assert.equal(query.filters.startDate, new Date(2026, 6, 1, 0, 0, 0, 0).toISOString());
  assert.equal(query.filters.endDate, new Date(2026, 6, 31, 23, 59, 59, 999).toISOString());
});

test("filter summary counts selections and condenses status dimensions into chips", () => {
  assert.deepEqual(helpers.deriveAppliedFilterSummary({
    timePreset: "7d",
    startDate: "",
    endDate: "",
    paymentStatuses: ["paid", "partial_paid"],
    deliveryStatuses: ["shipped"]
  }), {
    activeFilterCount: 4,
    activeFilterChips: [
      { key: "time", label: "近 7 天" },
      { key: "payment", label: "付款 2 项" },
      { key: "delivery", label: "已发货" }
    ]
  });
});

test("dedupe uses _id or orderId and keeps the newest occurrence", () => {
  assert.deepEqual(
    helpers.dedupeOrders([{ _id: "a", value: 1 }, { orderId: "a", value: 2 }, { orderId: "b", value: 3 }]),
    [{ orderId: "a", value: 2 }, { orderId: "b", value: 3 }]
  );
});

test("page exposes filter state and Task 4 bindable handlers", () => {
  const page = createPage(definition);
  assert.equal(page.data.pageSize, 10);
  assert.deepEqual(page.data.visibleOrders, []);
  [
    "onHide", "onSearchInput", "submitSearch", "openFilterDrawer", "closeFilterDrawer",
    "togglePaymentStatus", "toggleDeliveryStatus", "selectTimePreset",
    "onCustomStartDateChange", "onCustomEndDateChange", "resetDraftFilters",
    "applyDraftFilters", "clearAllFilters", "continueOlderSearch", "noop"
  ].forEach((name) => assert.equal(typeof page[name], "function", name));
});

test("drawer drafts, toggles, applies and clears without persisting", async () => {
  resetApiState();
  const page = createPage(definition);
  page.loadOrders = () => Promise.resolve();
  page.setData({
    appliedFilters: { timePreset: "7d", startDate: "", endDate: "", paymentStatuses: ["paid"], deliveryStatuses: [] }
  });
  page.openFilterDrawer();
  page.togglePaymentStatus({ currentTarget: { dataset: { value: "partial_paid" } } });
  page.toggleDeliveryStatus({ currentTarget: { dataset: { value: "shipped" } } });
  page.selectTimePreset({ currentTarget: { dataset: { value: "custom" } } });
  page.onCustomStartDateChange({ detail: { value: "2026-07-01" } });
  page.onCustomEndDateChange({ detail: { value: "2026-07-31" } });
  await page.applyDraftFilters();
  assert.deepEqual(page.data.appliedFilters.paymentStatuses, ["paid", "partial_paid"]);
  assert.equal(page.data.activeFilterCount, 4);
  await page.clearAllFilters();
  assert.equal(page.data.activeOrderFilter, "all");
  assert.equal(page.data.searchKeyword, "");
  assert.deepEqual(page.data.appliedFilters, helpers.emptyDetailedFilters());
});

test("filter drawer hides the custom tab bar and restores its previous visibility", async () => {
  const page = createPage(definition);
  const tabBar = {
    data: { visible: true },
    setData(patch) { Object.assign(this.data, patch); }
  };
  page.getTabBar = () => tabBar;
  page.loadOrders = () => Promise.resolve();

  page.openFilterDrawer();
  assert.equal(tabBar.data.visible, false);
  page.closeFilterDrawer();
  assert.equal(tabBar.data.visible, true);

  tabBar.data.visible = false;
  page.openFilterDrawer();
  await page.applyDraftFilters();
  assert.equal(tabBar.data.visible, false);

  tabBar.data.visible = true;
  page.openFilterDrawer();
  page.onHide();
  assert.equal(tabBar.data.visible, true);
});

test("search confirmation and stage selection reload from the server", async () => {
  const page = createPage(definition);
  const calls = [];
  page.loadOrders = (options) => { calls.push(options); return Promise.resolve(); };
  page.onSearchInput({ detail: { value: "  A-18  " } });
  await page.submitSearch();
  await page.selectOrderFilter({ currentTarget: { dataset: { filter: "shipping" } } });
  assert.equal(page.data.searchKeyword, "A-18");
  assert.equal(page.data.activeOrderFilter, "shipping");
  assert.deepEqual(calls, [{ reset: true, force: true }, { reset: true, force: true }]);
});

test("loadOrders sends cursor filters, replaces first page and dedupes appended pages", async () => {
  resetApiState();
  const page = createPage(definition);
  apiState.responses.push(
    { orders: [{ _id: "a", status: "completed" }], hasMore: true, nextCursor: "cursor-1" },
    { orders: [{ _id: "a", status: "completed", orderNo: "new" }, { _id: "b" }], hasMore: false, nextCursor: "" }
  );
  await page.loadOrders({ reset: true, force: true });
  await page.loadOrders({ reset: false, force: true });
  assert.equal(apiState.calls[0].payload.pageSize, 10);
  assert.equal(apiState.calls[0].payload.cursor, "");
  assert.equal(apiState.calls[1].payload.cursor, "cursor-1");
  assert.deepEqual(page.data.orders.map((order) => order._id), ["a", "b"]);
  assert.equal(page.data.orders[0].orderNo, "new");
  assert.strictEqual(page.data.visibleOrders, page.data.orders);
  assert.equal(page.data.hasMore, false);
});

test("in-flight all request is superseded by one latest shipping reload", async () => {
  resetApiState();
  const page = createPage(definition);
  const allRequest = deferred();
  const shippingRequest = deferred();
  apiState.responses.push(allRequest.promise, shippingRequest.promise);

  const initialLoad = page.loadOrders({ reset: true, force: true });
  const switchLoad = page.selectOrderFilter({ currentTarget: { dataset: { filter: "shipping" } } });
  assert.equal(apiState.calls.length, 1);

  allRequest.resolve({ orders: [{ _id: "old-all" }], hasMore: false, nextCursor: "" });
  await flushPromises();
  assert.equal(apiState.calls.length, 2);
  assert.equal(apiState.calls[1].payload.filters.orderStage, "shipping");
  assert.deepEqual(page.data.orders, []);

  shippingRequest.resolve({ orders: [{ _id: "shipping-result" }], hasMore: false, nextCursor: "" });
  await Promise.all([initialLoad, switchLoad]);
  assert.deepEqual(page.data.orders.map((order) => order._id), ["shipping-result"]);
  assert.equal(apiState.calls.length, 2);
});

test("multiple rapid forced stage changes coalesce to the final filter", async () => {
  resetApiState();
  const page = createPage(definition);
  const allRequest = deferred();
  const shippingRequest = deferred();
  apiState.responses.push(allRequest.promise, shippingRequest.promise);

  const initialLoad = page.loadOrders({ reset: true, force: true });
  const paymentLoad = page.selectOrderFilter({ currentTarget: { dataset: { filter: "payment" } } });
  const shippingLoad = page.selectOrderFilter({ currentTarget: { dataset: { filter: "shipping" } } });
  allRequest.resolve({ orders: [{ _id: "stale-all" }], hasMore: false, nextCursor: "" });
  await flushPromises();

  assert.equal(apiState.calls.length, 2);
  assert.equal(apiState.calls[1].payload.filters.orderStage, "shipping");
  shippingRequest.resolve({ orders: [{ _id: "latest-shipping" }], hasMore: false, nextCursor: "" });
  await Promise.all([initialLoad, paymentLoad, shippingLoad]);
  assert.deepEqual(page.data.orders.map((order) => order._id), ["latest-shipping"]);
  assert.equal(apiState.calls.length, 2);
});

test("in-flight shipping request cannot overwrite reset-on-reentry all results", async () => {
  resetApiState();
  const page = createPage(definition);
  const shippingRequest = deferred();
  const allRequest = deferred();
  apiState.responses.push(shippingRequest.promise, allRequest.promise);
  page.setData({ activeOrderFilter: "shipping" });

  const initialLoad = page.loadOrders({ reset: true, force: true });
  page.onHide();
  const showLoad = page.onShow();
  await flushPromises();
  assert.equal(page.data.activeOrderFilter, "all");
  assert.equal(apiState.calls.length, 1);

  shippingRequest.resolve({ orders: [{ _id: "stale-shipping" }], hasMore: false, nextCursor: "" });
  await flushPromises();
  assert.equal(apiState.calls.length, 2);
  assert.equal(apiState.calls[1].payload.filters.orderStage, "all");
  assert.deepEqual(page.data.orders, []);

  allRequest.resolve({ orders: [{ _id: "fresh-all" }], hasMore: false, nextCursor: "" });
  await Promise.all([initialLoad, showLoad]);
  assert.deepEqual(page.data.orders.map((order) => order._id), ["fresh-all"]);
  assert.equal(apiState.calls.length, 2);
});

test("ordinary duplicate loads share one in-flight request without queuing another", async () => {
  resetApiState();
  const page = createPage(definition);
  const request = deferred();
  apiState.responses.push(request.promise);
  const first = page.loadOrders({ reset: true, force: true });
  const duplicate = page.loadOrders({ reset: true });
  assert.strictEqual(duplicate, first);
  assert.equal(apiState.calls.length, 1);
  request.resolve({ orders: [{ _id: "only" }], hasMore: false, nextCursor: "" });
  await Promise.all([first, duplicate]);
  assert.equal(apiState.calls.length, 1);
});

test("empty cursor pages auto-continue twice then expose manual continuation", async () => {
  resetApiState();
  const page = createPage(definition);
  apiState.responses.push(
    { orders: [], hasMore: true, nextCursor: "c1" },
    { orders: [], hasMore: true, nextCursor: "c2" },
    { orders: [], hasMore: true, nextCursor: "c3" },
    { orders: [{ _id: "older" }], hasMore: false, nextCursor: "" }
  );
  await page.loadOrders({ reset: true, force: true });
  assert.equal(apiState.calls.length, 3);
  assert.equal(page.data.nextCursor, "c3");
  assert.equal(page.data.showContinueOlderSearch, true);
  await page.continueOlderSearch();
  assert.equal(apiState.calls.length, 4);
  assert.deepEqual(page.data.orders.map((order) => order._id), ["older"]);
  assert.equal(page.data.showContinueOlderSearch, false);
  assert.equal(page.data.hasMore, false);
});

test("failed automatic continuation clears the searching-older state", async () => {
  resetApiState();
  const page = createPage(definition);
  apiState.responses.push(
    { orders: [], hasMore: true, nextCursor: "c1" },
    new Error("network failed")
  );
  await page.loadOrders({ reset: true, force: true });
  assert.equal(page.data.searchingOlderOrders, false);
  assert.equal(page.data.loadError, "network failed");
});

test("onHide marks reset and onShow resets filters after authentication", async () => {
  const page = createPage(definition);
  const loads = [];
  page.loadOrders = (options) => { loads.push(options); return Promise.resolve(); };
  page.setData({
    activeOrderFilter: "shipping",
    searchInput: "x",
    searchKeyword: "x",
    appliedFilters: { timePreset: "7d", startDate: "", endDate: "", paymentStatuses: ["paid"], deliveryStatuses: [] }
  });
  page.onHide();
  await page.onShow();
  assert.equal(page.data.activeOrderFilter, "all");
  assert.equal(page.data.searchKeyword, "");
  assert.deepEqual(page.data.appliedFilters, helpers.emptyDetailedFilters());
  assert.deepEqual(loads, [{ reset: true, force: true }]);
});
