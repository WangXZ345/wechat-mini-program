const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const pagePath = path.join(__dirname, "..", "miniprogram", "pages", "admin", "orders.js");
const pageSource = fs.readFileSync(pagePath, "utf8");
const templatePath = path.join(__dirname, "..", "miniprogram", "pages", "admin", "orders.wxml");
const template = fs.readFileSync(templatePath, "utf8");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assignData(target, key, value) {
  const segments = key.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!cursor[segment]) cursor[segment] = /^\d+$/.test(segments[index + 1]) ? [] : {};
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
}

function createPage(responses) {
  let definition;
  const calls = [];
  const call = (name, data) => {
    calls.push({ name, data });
    const response = responses.shift();
    if (response instanceof Error) return Promise.reject(response);
    if (response && response.promise) return response.promise;
    return Promise.resolve(response || { orders: [], hasMore: false });
  };
  const sandbox = {
    Page: (value) => { definition = value; },
    require(request) {
      if (request === "../../utils/api") return { call, moneyText: (amount) => String(amount || 0), toast: () => {} };
      if (request === "../../utils/auth") return { ensureAdmin: () => Promise.resolve() };
      if (request === "../../utils/orientation") return { initOrientation: () => {}, cleanupOrientation: () => {} };
      if (request === "../../utils/status") return { ORDER_STATUS_TEXT: {}, PAYMENT_STATUS_TEXT: {} };
      if (request === "../../utils/idempotency") return { generateIdempotencyKey: () => "test-key" };
      if (request === "../../utils/haptics") return { selection: () => {}, warning: () => {}, success: () => {}, error: () => {} };
      throw new Error(`Unexpected require: ${request}`);
    },
    wx: { stopPullDownRefresh: () => {} },
    console,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(pageSource, sandbox, { filename: pagePath });
  const page = { ...definition, data: clone(definition.data) };
  page.setData = (updates, callback) => {
    Object.entries(updates).forEach(([key, value]) => assignData(page.data, key, value));
    if (callback) callback();
  };
  return { page, calls };
}

async function settles(promise) {
  await promise;
  await Promise.resolve();
}

async function run() {
  {
    const { page, calls } = createPage([{ orders: [{ _id: "a" }], hasMore: true }]);
    await settles(page.load());
    assert.equal(calls.length, 1, "首次加载应只发起一次请求");
    assert.equal(calls[0].name, "getOrders");
    assert.equal(calls[0].data.admin, true);
    assert.equal(calls[0].data.page, 1, "首次加载必须从第 1 页开始");
    assert.equal(calls[0].data.pageSize, 20, "首次加载必须使用固定分页大小");
    assert.equal(page.data.orders.length, 1);
    assert.equal(page.data.hasMore, true);
  }

  {
    const { page, calls } = createPage([
      { orders: [{ _id: "a" }, { _id: "b" }], hasMore: true },
      { orders: [{ _id: "b" }, { _id: "c" }], hasMore: false }
    ]);
    await settles(page.load());
    await settles(page.loadMore());
    assert.equal(calls[1].data.page, 2, "加载更多必须请求下一页");
    assert.deepEqual(page.data.orders.map((item) => item._id), ["a", "b", "c"], "重叠页必须按 _id 去重后追加");
    assert.equal(page.data.hasMore, false);
  }

  {
    const { page, calls } = createPage([
      { orders: [{ _id: "a" }], hasMore: true },
      { orders: [{ _id: "b" }], hasMore: true },
      { orders: [{ _id: "filtered" }], hasMore: false }
    ]);
    await settles(page.load());
    await settles(page.loadMore());
    page.onOrderStatusChange({ detail: { value: 1 } });
    await settles(page.load());
    assert.equal(calls[2].data.page, 1, "应用新筛选时必须重置到第 1 页");
    assert.equal(calls[2].data.filters.orderStatus, "auto_reviewing");
    assert.deepEqual(page.data.orders.map((item) => item._id), ["filtered"], "筛选刷新不能保留旧页数据");
  }

  {
    let release;
    const secondPage = new Promise((resolve) => { release = resolve; });
    const { page, calls } = createPage([
      { orders: [{ _id: "a" }], hasMore: true },
      { promise: secondPage }
    ]);
    await settles(page.load());
    const firstLoadMore = page.loadMore();
    const secondLoadMore = page.loadMore();
    assert.equal(calls.length, 2, "重复点击加载更多时只能发起一个请求");
    assert.strictEqual(secondLoadMore, firstLoadMore, "请求锁应复用进行中的加载更多请求");
    release({ orders: [{ _id: "b" }], hasMore: false });
    await settles(firstLoadMore);
  }

  {
    const { page, calls } = createPage([{ orders: [{ _id: "a" }], hasMore: false }]);
    await settles(page.load());
    await settles(page.loadMore());
    assert.equal(calls.length, 1, "hasMore=false 时不得再请求下一页");
  }

  {
    const { page, calls } = createPage([
      { orders: [{ _id: "a" }], hasMore: true },
      { orders: [{ _id: "b" }], hasMore: true },
      { orders: [{ _id: "refresh" }], hasMore: false }
    ]);
    await settles(page.load());
    await settles(page.loadMore());
    await settles(page.load());
    assert.equal(calls[2].data.page, 1, "刷新必须重置到第 1 页");
    assert.deepEqual(page.data.orders.map((item) => item._id), ["refresh"]);
  }

  {
    const { page } = createPage([
      { orders: [{ _id: "a" }], hasMore: true },
      new Error("network failed")
    ]);
    await settles(page.load());
    await settles(page.loadMore());
    assert.deepEqual(page.data.orders.map((item) => item._id), ["a"], "加载更多失败不得丢失已加载订单");
    assert.equal(page.data.hasMore, true, "加载更多失败不得错误关闭后续重试");
  }

  {
    let releaseSecondPage;
    const secondPage = new Promise((resolve) => { releaseSecondPage = resolve; });
    let releaseFilteredFirstPage;
    const filteredFirstPage = new Promise((resolve) => { releaseFilteredFirstPage = resolve; });
    const { page, calls } = createPage([
      { orders: [{ _id: "a" }], hasMore: true },
      { promise: secondPage },
      { promise: filteredFirstPage }
    ]);
    await settles(page.load());
    const append = page.loadMore();
    page.onOrderStatusChange({ detail: { value: 1 } });
    page.onPaymentStatusChange({ detail: { value: 4 } });
    const reset = page.load();
    assert.equal(calls.length, 3, "page2 在途时应用筛选必须另起 page1 请求");
    assert.notStrictEqual(reset, append, "筛选重置不得复用在途 page2 Promise");
    assert.equal(calls[2].data.page, 1);
    assert.equal(calls[2].data.filters.orderStatus, "auto_reviewing");
    assert.equal(calls[2].data.filters.paymentStatus, "paid");
    releaseFilteredFirstPage({ orders: [{ _id: "filtered" }], hasMore: false });
    await settles(reset);
    releaseSecondPage({ orders: [{ _id: "stale" }], hasMore: false });
    await settles(append);
    assert.deepEqual(page.data.orders.map((item) => item._id), ["filtered"], "旧 page2 晚到不得覆盖筛选后的 page1");
  }

  {
    let releaseAppend;
    const appendPage = new Promise((resolve) => { releaseAppend = resolve; });
    let releaseRefresh;
    const refreshPage = new Promise((resolve) => { releaseRefresh = resolve; });
    const { page, calls } = createPage([
      { orders: [{ _id: "a" }], hasMore: true },
      { promise: appendPage },
      { promise: refreshPage }
    ]);
    await settles(page.load());
    const append = page.loadMore();
    page.onPullDownRefresh();
    assert.equal(calls.length, 3, "page2 在途时下拉刷新必须另起 page1 请求");
    releaseRefresh({ orders: [{ _id: "refresh" }], hasMore: false });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(page.data.orders.map((item) => item._id), ["refresh"]);
    releaseAppend({ orders: [{ _id: "stale" }], hasMore: false });
    await settles(append);
    assert.deepEqual(page.data.orders.map((item) => item._id), ["refresh"], "旧 append 完成后不得覆盖刷新结果");
  }

  {
    let releaseFirstReset;
    const firstReset = new Promise((resolve) => { releaseFirstReset = resolve; });
    let releaseSecondReset;
    const secondReset = new Promise((resolve) => { releaseSecondReset = resolve; });
    const { page, calls } = createPage([
      { orders: [{ _id: "initial" }], hasMore: true },
      { promise: firstReset },
      { promise: secondReset }
    ]);
    await settles(page.load());
    const staleReset = page.load();
    const currentReset = page.load();
    assert.equal(calls.length, 3, "新的 page1 刷新必须替换旧 page1 请求");
    releaseFirstReset({ orders: [{ _id: "stale" }], hasMore: false });
    await settles(staleReset);
    assert.equal(page.data.loading, true, "旧 generation 的 finally 不得清掉新请求 loading 锁");
    releaseSecondReset({ orders: [{ _id: "current" }], hasMore: false });
    await settles(currentReset);
    assert.deepEqual(page.data.orders.map((item) => item._id), ["current"]);
  }

  {
    let releaseStaleAppend;
    const staleAppendPage = new Promise((resolve) => { releaseStaleAppend = resolve; });
    let releaseCurrentAppend;
    const currentAppendPage = new Promise((resolve) => { releaseCurrentAppend = resolve; });
    const { page } = createPage([
      { orders: [{ _id: "initial" }], hasMore: true },
      { promise: staleAppendPage },
      { orders: [{ _id: "fresh" }], hasMore: true },
      { promise: currentAppendPage }
    ]);
    await settles(page.load());
    const staleAppend = page.loadMore();
    await settles(page.load());
    const currentAppend = page.loadMore();
    assert.equal(page.data.loadingMore, true);
    releaseStaleAppend({ orders: [{ _id: "stale" }], hasMore: false });
    await settles(staleAppend);
    assert.equal(page.data.loadingMore, true, "旧 generation 的 finally 不得清掉新 append 的 loadingMore");
    assert.strictEqual(page.ordersAppendLoading, currentAppend, "旧 generation 的 finally 不得清掉新 append 锁");
    releaseCurrentAppend({ orders: [{ _id: "current-page2" }], hasMore: false });
    await settles(currentAppend);
  }

  {
    const { page } = createPage([
      { orders: [{ _id: "shipped", shippingStatus: "shipped" }], hasMore: true },
      { orders: [{ _id: "pending", shippingStatus: "pending_shipment" }], hasMore: false }
    ]);
    page.setData({ shipmentFilterIndex: 1, selectedShipmentFilterLabel: "待发货" });
    await settles(page.load());
    assert.deepEqual(page.data.orders, [], "本地发货筛选可令第一页可见订单为 0");
    assert.deepEqual(page.data.rawOrders.map((item) => item._id), ["shipped"], "不可见订单仍必须保存在 rawOrders");
    assert.equal(page.data.hasMore, true);
    await settles(page.loadMore());
    assert.deepEqual(page.data.orders.map((item) => item._id), ["pending"], "下一页命中本地筛选时必须从 rawOrders 重算可见订单");
    assert.match(template, /wx:if="\{\{initialized && \(orders\.length \|\| hasMore\)\}\}" class="orders-pagination"/, "可见订单为 0 且 hasMore=true 时仍应显示加载更多入口");
    assert.match(template, /initialized && !orders\.length && !hasMore/, "最终空态只能在没有更多数据时显示");
  }

  {
    const { page } = createPage([
      { orders: [{ _id: "a", status: "pending_admin" }], hasMore: true },
      { orders: [{ _id: "a", status: "paid" }, { _id: "b" }], hasMore: false }
    ]);
    await settles(page.load());
    await settles(page.loadMore());
    assert.deepEqual(page.data.rawOrders.map((item) => item._id), ["a", "b"], "重叠 _id 必须保持首次出现顺序");
    assert.equal(page.data.rawOrders[0].status, "paid", "重叠 _id 必须使用较新响应字段覆盖旧状态");
  }

  {
    let releaseOldAppend;
    const oldAppendPage = new Promise((resolve) => { releaseOldAppend = resolve; });
    const { page, calls } = createPage([
      { orders: [{ _id: "all-page1" }], hasMore: true },
      { promise: oldAppendPage },
      { orders: [{ _id: "paid-page1" }], hasMore: false }
    ]);
    await settles(page.load());
    page.onPaymentStatusChange({ detail: { value: 4 } });
    const oldAppend = page.loadMore();
    assert.equal(calls[1].data.filters.paymentStatus, "all", "未应用的付款筛选草稿不得改变同 generation 的 page2 查询");
    const paidReset = page.load();
    assert.equal(calls[2].data.page, 1);
    assert.equal(calls[2].data.filters.paymentStatus, "paid", "应用筛选必须让新 page1 使用新的服务端筛选快照");
    await settles(paidReset);
    assert.equal(page.ordersAppliedFilters.paymentStatus, "paid");
    releaseOldAppend({ orders: [{ _id: "stale-all-page2" }], hasMore: false });
    await settles(oldAppend);
    assert.equal(page.ordersAppliedFilters.paymentStatus, "paid", "旧 append 晚到不得覆盖新 generation 的筛选快照");
    assert.deepEqual(page.data.orders.map((item) => item._id), ["paid-page1"], "旧 append 晚到不得覆盖新 generation 数据");
  }

  {
    const { page, calls } = createPage([
      { orders: [{ _id: "all-page1" }], hasMore: true },
      { orders: [{ _id: "all-page2" }], hasMore: true },
      new Error("paid filter failed"),
      { orders: [{ _id: "all-page3" }], hasMore: false }
    ]);
    await settles(page.load());
    await settles(page.loadMore());
    page.onPaymentStatusChange({ detail: { value: 4 } });
    await settles(page.load());
    assert.equal(calls[2].data.page, 1);
    assert.equal(calls[2].data.filters.paymentStatus, "paid");
    assert.equal(page.ordersAppliedFilters.paymentStatus, "all", "新筛选 page1 失败后必须保留上一份已应用筛选快照");
    assert.deepEqual(page.data.rawOrders.map((item) => item._id), ["all-page1", "all-page2"], "新筛选 page1 失败后不得替换旧列表");
    await settles(page.loadMore());
    assert.equal(calls[3].data.page, 3, "筛选 reset 失败后应沿已应用列表继续请求下一页");
    assert.equal(calls[3].data.filters.paymentStatus, "all", "不得用新筛选草稿请求旧页码");
    assert.deepEqual(page.data.rawOrders.map((item) => item._id), ["all-page1", "all-page2", "all-page3"], "筛选 reset 失败后加载更多不得混入新筛选数据");
  }

  {
    let releaseAppend;
    const appendPage = new Promise((resolve) => { releaseAppend = resolve; });
    const { page, calls } = createPage([
      { orders: [{ _id: "a", status: "pending_admin" }], hasMore: true },
      { promise: appendPage },
      { orders: [{ _id: "after-review" }], hasMore: false }
    ]);
    await settles(page.load());
    const append = page.loadMore();
    page.review({ currentTarget: { dataset: { id: "a", action: "approve" } } });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls[2].name, "adminReviewOrder");
    assert.equal(calls.length, 4, "审核完成时必须另起 page1 请求，不能等待旧 page2");
    assert.equal(calls[3].data.page, 1);
    releaseAppend({ orders: [{ _id: "stale" }], hasMore: false });
    await settles(append);
  }

  {
    let releaseAppend;
    const appendPage = new Promise((resolve) => { releaseAppend = resolve; });
    const { page, calls } = createPage([
      { orders: [{ _id: "a", status: "pending_payment_confirm" }], hasMore: true },
      { promise: appendPage },
      {},
      { orders: [{ _id: "after-payment" }], hasMore: false }
    ]);
    await settles(page.load());
    const append = page.loadMore();
    page.markPayment({ currentTarget: { dataset: { id: "a", status: "paid" } } });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls[2].name, "adminUpdatePayment");
    assert.equal(calls.length, 4, "付款完成时必须另起 page1 请求，不能等待旧 page2");
    assert.equal(calls[3].data.page, 1);
    releaseAppend({ orders: [{ _id: "stale" }], hasMore: false });
    await settles(append);
  }
}

run().then(() => {
  console.log("admin orders pagination regression check passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
