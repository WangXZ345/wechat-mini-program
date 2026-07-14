const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ProductAnalyticsError,
  createCloudBaseProductAnalyticsRepository,
  createProductAnalyticsQueryService,
  inventoryDelta,
  normalizeRange
} = require("../productAnalyticsQueryService");

const NOW = new Date("2026-07-11T04:00:00.000Z");

function atShanghai(value) {
  return new Date(`${value}+08:00`);
}

function cursorAfter(row, cursor) {
  if (!cursor) return true;
  const rowTime = new Date(row.createdAt).getTime();
  const cursorTime = cursor.createdAt.getTime();
  return rowTime > cursorTime || (rowTime === cursorTime && String(row._id) > cursor.id);
}

function page(rows, { start, end, cursor, limit, filter = () => true }) {
  return rows
    .filter(filter)
    .filter((row) => !start || new Date(row.createdAt) >= start)
    .filter((row) => !end || new Date(row.createdAt) < end)
    .filter((row) => cursorAfter(row, cursor))
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt) || String(left._id).localeCompare(String(right._id)))
    .slice(0, limit);
}

function memoryRepository(state = {}, options = {}) {
  const data = {
    products: state.products || [],
    orders: state.orders || [],
    orderItems: state.orderItems || [],
    priceLogs: state.priceLogs || [],
    inventoryLogs: state.inventoryLogs || []
  };
  const calls = [];
  function shouldFail(name) {
    if (options.failSource === name) throw new Error("collection not exists");
  }
  return {
    calls,
    async getProduct(productId) {
      calls.push({ name: "getProduct", productId });
      shouldFail("products");
      return data.products.find((item) => item._id === productId) || null;
    },
    async getProductsByIds(productIds) {
      calls.push({ name: "getProductsByIds", productIds });
      shouldFail("products");
      return data.products.filter((item) => productIds.includes(item._id));
    },
    async scanOrdersPage(args) {
      calls.push({ name: "scanOrdersPage", ...args });
      shouldFail("orders");
      return page(data.orders, args);
    },
    async scanOrderItemsPage(args) {
      calls.push({ name: "scanOrderItemsPage", ...args });
      shouldFail("order_items");
      return page(data.orderItems, {
        ...args,
        filter: (item) => args.orderIds.includes(item.orderId)
      });
    },
    async scanPriceLogsPage(args) {
      calls.push({ name: "scanPriceLogsPage", ...args });
      shouldFail("price_logs");
      return page(data.priceLogs, {
        ...args,
        filter: (item) => !args.productId || item.productId === args.productId
      });
    },
    async scanInventoryLogsPage(args) {
      calls.push({ name: "scanInventoryLogsPage", ...args });
      shouldFail("inventory_logs");
      return page(data.inventoryLogs, {
        ...args,
        filter: (item) => !args.productId || item.productId === args.productId
      });
    }
  };
}

function product(id, extra = {}) {
  return { _id: id, name: `商品${id}`, sku: `SKU-${id}`, price: 100, stock: 20, ...extra };
}

function order(id, createdAt, extra = {}) {
  return { _id: id, createdAt: atShanghai(createdAt), status: "paid", paymentStatus: "paid", ...extra };
}

function item(id, orderId, productId, quantity, unitPrice, createdAt = "2026-07-11T10:00:00") {
  return {
    _id: id,
    orderId,
    productId,
    productName: `快照${productId}`,
    quantity,
    unitPrice,
    totalAmount: quantity * unitPrice,
    createdAt: atShanghai(createdAt)
  };
}

function mixedState() {
  return {
    products: [product("p1", { price: 120 }), product("p2", { price: 60 })],
    orders: [
      order("o-prev", "2026-07-04T12:00:00", { productId: "p1", productName: "旧快照p1", quantity: 3, unitPrice: 90, totalAmount: 270 }),
      order("o-inline", "2026-07-09T12:00:00", { items: [
        { productId: "p1", productName: "内联p1", quantity: 2, unitPrice: 80, totalAmount: 160 },
        { productId: "p2", productName: "内联p2", quantity: 1, unitPrice: 40, totalAmount: 40 }
      ] }),
      order("o-old", "2026-07-10T09:00:00", { productId: "p2", productName: "旧快照p2", quantity: 4, unitPrice: 50, totalAmount: 200 }),
      order("o-mixed", "2026-07-10T10:00:00", { productId: "p1", productName: "不应回退", quantity: 99, unitPrice: 1, totalAmount: 99 }),
      order("o-partial", "2026-07-10T11:00:00", { productId: "p1", quantity: 1, unitPrice: 70, totalAmount: 70, status: "partial_refunded", refundStatus: "partial_refunded" }),
      order("o-new", "2026-07-11T10:00:00", { productId: "p1", quantity: 100, unitPrice: 1, totalAmount: 100 }),
      order("o-cancel", "2026-07-11T11:00:00", { productId: "p1", quantity: 100, unitPrice: 1, totalAmount: 100, status: "cancelled" }),
      order("o-refund", "2026-07-11T12:00:00", { productId: "p1", quantity: 100, unitPrice: 1, totalAmount: 100, refundStatus: "full_refunded" })
    ],
    orderItems: [
      item("i-mixed", "o-mixed", "p2", 1, 30, "2026-07-10T10:00:00"),
      item("i-new-1", "o-new", "p1", 2, 100),
      item("i-new-1", "o-new", "p1", 2, 100),
      item("i-new-2", "o-new", "p1", 1, 100)
    ],
    priceLogs: [
      { _id: "price-1", productId: "p1", afterPrice: 110, createdAt: atShanghai("2026-07-10T08:00:00") },
      { _id: "price-2", productId: "p2", newPrice: 60, createdAt: atShanghai("2026-07-10T08:30:00") }
    ],
    inventoryLogs: [
      { _id: "stock-1", businessKey: "sale:o-new:p1", productId: "p1", beforeStock: 10, afterStock: 8, changeAmount: -2, createdAt: atShanghai("2026-07-11T10:00:00") },
      { _id: "stock-duplicate", businessKey: "sale:o-new:p1", productId: "p1", beforeStock: 10, afterStock: 8, changeAmount: -2, createdAt: atShanghai("2026-07-11T10:01:00") },
      { _id: "stock-2", productId: "p2", changeAmount: 5, createdAt: atShanghai("2026-07-11T11:00:00") }
    ]
  };
}

function serviceFor(state, options = {}) {
  const repository = options.repository || memoryRepository(state, options);
  return {
    repository,
    service: createProductAnalyticsQueryService({
      repository,
      now: () => NOW,
      limits: options.limits
    })
  };
}

test("overview merges direct, inline and top-level legacy items per order without collapsing distinct rows", async () => {
  const { service } = serviceFor(mixedState());
  const result = await service.getOverview({ range: "7d" });

  assert.equal(result.status, "available");
  assert.equal(result.summary.salesCount, 12);
  assert.equal(result.summary.salesAmountCents, 800);
  assert.equal(result.summary.orderCount, 5);
  assert.equal(result.summary.averagePriceCents, 67);
  assert.equal(result.summary.changes.salesCount, 300);
  assert.equal(result.ranking.length, 2);
  assert.deepEqual(result.ranking.map((row) => [row.id, row.salesCount]), [["p1", 6], ["p2", 6]]);
  assert.equal(result.ranking[0].change, 100);
  assert.equal(result.ranking[1].change, null);
  assert.equal(result.message.includes("部分退款未冲减"), true);
});

test("real price and deduplicated inventory logs populate daily series without synthetic quotes", async () => {
  const { service } = serviceFor(mixedState());
  const result = await service.getOverview({ range: "7d" });
  const july10 = result.series.find((row) => row.date === "2026-07-10");
  const july11 = result.series.find((row) => row.date === "2026-07-11");

  assert.equal(july10.quotePriceCents, 85);
  assert.equal(july11.quotePriceCents, null);
  assert.equal(july11.inventoryChange, 3);
  assert.equal(result.series.length, 7);
});

test("single-product DTO keeps legacy shape, daily extrema and only real target-product price logs", async () => {
  const { service, repository } = serviceFor(mixedState());
  const result = await service.getProductDetail({ productId: "p1", range: "7d" });

  assert.deepEqual(Object.keys(result).sort(), ["dealPriceTrend", "listPriceTrend", "message", "product", "range", "salesTrend", "summary"]);
  assert.equal(result.product.currentPrice, 120);
  assert.equal(result.summary.totalQuantity, 6);
  assert.equal(result.summary.totalAmount, 530);
  assert.equal(result.summary.minDealPrice, 70);
  assert.equal(result.summary.maxDealPrice, 100);
  assert.deepEqual(result.listPriceTrend, [{ date: "2026-07-10", price: 110, source: "price_logs" }]);
  assert.equal(result.listPriceTrend.some((row) => row.source === "current_product"), false);
  const july10 = result.dealPriceTrend.find((row) => row.date === "2026-07-10");
  const july9 = result.dealPriceTrend.find((row) => row.date === "2026-07-09");
  assert.deepEqual(july9, { date: "2026-07-09", avgPrice: 80, maxPrice: 80, minPrice: 80 });
  assert.deepEqual(july10, { date: "2026-07-10", avgPrice: 70, maxPrice: 70, minPrice: 70 });
  const priceCalls = repository.calls.filter((call) => call.name === "scanPriceLogsPage");
  assert.equal(priceCalls.every((call) => call.productId === "p1"), true);
  const orderCalls = repository.calls.filter((call) => call.name === "scanOrdersPage");
  assert.equal(orderCalls.every((call) => call.start.getTime() === atShanghai("2026-07-05T00:00:00").getTime()), true);
  assert.equal(repository.calls.some((call) => call.name === "scanInventoryLogsPage"), false);
});

test("single-product detail never appends the current product price when no price log exists", async () => {
  const state = mixedState();
  state.priceLogs = [];
  const { service } = serviceFor(state);
  const result = await service.getProductDetail({ productId: "p1", range: "7d" });
  assert.deepEqual(result.listPriceTrend, []);
  assert.equal(result.message.includes("未合成当前价"), true);
});

test("Shanghai boundaries are start-inclusive and end-exclusive", async () => {
  const state = {
    products: [product("p1")],
    orders: [
      order("at-start", "2026-07-05T00:00:00", { productId: "p1", quantity: 1, unitPrice: 10, totalAmount: 10 }),
      order("before-end", "2026-07-11T23:59:59", { productId: "p1", quantity: 2, unitPrice: 10, totalAmount: 20 }),
      order("at-end", "2026-07-12T00:00:00", { productId: "p1", quantity: 100, unitPrice: 10, totalAmount: 1000 })
    ]
  };
  const { service } = serviceFor(state);
  const result = await service.getOverview({ range: "7d" });
  assert.equal(result.summary.salesCount, 3);
  assert.equal(result.series[0].date, "2026-07-05");
  assert.equal(result.series.at(-1).date, "2026-07-11");
});

test("missing range defaults to 30d while explicit invalid overview ranges fail with 400", async () => {
  const normalized = normalizeRange({}, { now: NOW });
  assert.equal(normalized.range, "30d");
  assert.equal(normalized.days, 30);
  assert.throws(
    () => normalizeRange({ range: "custom" }, { now: NOW }),
    (error) => error.code === "ANALYTICS_RANGE_INVALID" && error.statusCode === 400
  );
  const { service } = serviceFor({});
  await assert.rejects(service.getOverview({ range: "" }), (error) => error.code === "ANALYTICS_RANGE_INVALID");
});

test("single-product legacy custom range remains strict, Shanghai-based and capped at 90 days", async () => {
  const state = {
    products: [product("p1")],
    orders: [order("custom-order", "2026-07-01T00:00:00", { productId: "p1", quantity: 1, unitPrice: 10, totalAmount: 10 })]
  };
  const { service } = serviceFor(state);
  const result = await service.getProductDetail({ productId: "p1", range: "custom", startDate: "2026-07-01", endDate: "2026-07-01" });
  assert.equal(result.summary.totalQuantity, 1);
  assert.equal(result.range.days, 1);
  await assert.rejects(
    service.getProductDetail({ productId: "p1", range: "custom", startDate: "2026-02-30", endDate: "2026-03-01" }),
    (error) => error.code === "ANALYTICS_RANGE_INVALID" && error.statusCode === 400
  );
  await assert.rejects(
    service.getProductDetail({ productId: "p1", range: "custom", startDate: "2026-01-01", endDate: "2026-04-02" }),
    (error) => error.code === "ANALYTICS_RANGE_INVALID"
  );
});

test("a period with no current sales, quote or inventory event returns a real empty contract", async () => {
  const state = {
    products: [product("p1")],
    orders: [order("previous-only", "2026-07-04T12:00:00", { productId: "p1", quantity: 1, unitPrice: 10, totalAmount: 10 })]
  };
  const { service } = serviceFor(state);
  const result = await service.getOverview({ range: "7d" });
  assert.equal(result.status, "empty");
  assert.deepEqual(result.series, []);
  assert.deepEqual(result.ranking, []);
});

for (const [label, mutate] of [
  ["numeric strings", (state) => { state.orders[0].quantity = "1"; }],
  ["decimal quantities", (state) => { state.orders[0].quantity = 1.5; }],
  ["negative amounts", (state) => { state.orders[0].totalAmount = -1; }]
]) {
  test(`strict source validation rejects ${label} instead of rounding or zeroing`, async () => {
    const state = {
      products: [product("p1")],
      orders: [order("bad", "2026-07-11T10:00:00", { productId: "p1", quantity: 1, unitPrice: 10, totalAmount: 10 })]
    };
    mutate(state);
    const { service } = serviceFor(state);
    await assert.rejects(
      service.getOverview({ range: "7d" }),
      (error) => error.code === "ANALYTICS_DATA_INVALID" && error.statusCode === 422
    );
  });
}

test("safe-integer accumulation overflow fails closed", async () => {
  const state = {
    products: [product("p1")],
    orders: [
      order("max", "2026-07-10T10:00:00", { productId: "p1", quantity: 1, unitPrice: Number.MAX_SAFE_INTEGER, totalAmount: Number.MAX_SAFE_INTEGER }),
      order("plus-one", "2026-07-11T10:00:00", { productId: "p1", quantity: 1, unitPrice: 1, totalAmount: 1 })
    ]
  };
  const { service } = serviceFor(state);
  await assert.rejects(service.getOverview({ range: "7d" }), (error) => error.code === "ANALYTICS_DATA_INVALID");
});

test("inventory delta validates before/after first and rejects inconsistent changeAmount", () => {
  assert.equal(inventoryDelta({ beforeStock: 10, afterStock: 7, changeAmount: -3 }), -3);
  assert.equal(inventoryDelta({ changeAmount: 5 }), 5);
  assert.throws(
    () => inventoryDelta({ beforeStock: 10, afterStock: 7, changeAmount: -2 }),
    (error) => error.code === "ANALYTICS_DATA_INVALID"
  );
});

test("conflicting inventory rows with the same business key fail closed", async () => {
  const state = mixedState();
  state.inventoryLogs.push({
    _id: "stock-conflict",
    businessKey: "sale:o-new:p1",
    productId: "p1",
    beforeStock: 10,
    afterStock: 7,
    changeAmount: -3,
    createdAt: atShanghai("2026-07-11T10:02:00")
  });
  const { service } = serviceFor(state);
  await assert.rejects(
    service.getOverview({ range: "7d" }),
    (error) => error.code === "ANALYTICS_DATA_INVALID" && error.statusCode === 422
  );
});

test("row caps and missing collections map to safe 503 instead of partial or fake empty data", async () => {
  const state = {
    products: [product("p1")],
    orders: [
      order("one", "2026-07-10T10:00:00", { productId: "p1", quantity: 1, unitPrice: 10, totalAmount: 10 }),
      order("two", "2026-07-11T10:00:00", { productId: "p1", quantity: 1, unitPrice: 10, totalAmount: 10 })
    ]
  };
  const capped = serviceFor(state, { limits: { orders: { pageSize: 2, maxRows: 2, maxQueries: 2 } } }).service;
  await assert.rejects(
    capped.getOverview({ range: "7d" }),
    (error) => error.code === "ANALYTICS_SOURCE_UNAVAILABLE" && error.statusCode === 503
  );
  const missing = serviceFor(state, { failSource: "price_logs" }).service;
  await assert.rejects(
    missing.getOverview({ range: "7d" }),
    (error) => error.code === "ANALYTICS_SOURCE_UNAVAILABLE" && error.statusCode === 503
  );
});

test("CloudBase repository uses field projections and createdAt+_id cursor ordering without skip", async () => {
  const calls = [];
  function operator(name, value) {
    return { op: name, value, and(other) { return { op: "chain-and", left: this, right: other }; } };
  }
  const command = {
    gte: (value) => operator("gte", value),
    gt: (value) => operator("gt", value),
    lt: (value) => operator("lt", value),
    in: (value) => operator("in", value),
    and: (value) => operator("and", value),
    or: (value) => operator("or", value)
  };
  const db = {
    collection(name) {
      calls.push({ method: "collection", name });
      const query = {
        where(value) { calls.push({ method: "where", value }); return query; },
        field(value) { calls.push({ method: "field", value }); return query; },
        orderBy(field, direction) { calls.push({ method: "orderBy", field, direction }); return query; },
        limit(value) { calls.push({ method: "limit", value }); return query; },
        async get() { calls.push({ method: "get" }); return { data: [] }; }
      };
      return query;
    }
  };
  const repository = createCloudBaseProductAnalyticsRepository({ db, command });
  await repository.scanOrdersPage({
    start: atShanghai("2026-07-01T00:00:00"),
    end: atShanghai("2026-07-12T00:00:00"),
    cursor: { createdAt: atShanghai("2026-07-05T00:00:00"), id: "o-1" },
    limit: 100
  });
  await repository.scanPriceLogsPage({
    start: atShanghai("2026-07-01T00:00:00"),
    end: atShanghai("2026-07-12T00:00:00"),
    productId: "p1",
    cursor: null,
    limit: 100
  });

  assert.equal(calls.some((call) => call.method === "skip"), false);
  assert.deepEqual(calls.filter((call) => call.method === "orderBy").slice(0, 2).map((call) => call.field), ["createdAt", "_id"]);
  const projections = calls.filter((call) => call.method === "field").map((call) => call.value);
  const projectionText = JSON.stringify(projections);
  for (const forbidden of ["openid", "phone", "address", "operator", "reason", "orderNo", "relatedOrderId"]) {
    assert.equal(projectionText.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
  assert.equal(JSON.stringify(calls.filter((call) => call.method === "where")).includes("p1"), true);
});

test("known analytics errors retain stable public codes and statuses", () => {
  const error = new ProductAnalyticsError("ANALYTICS_SOURCE_UNAVAILABLE", "safe", 503);
  assert.equal(error.code, "ANALYTICS_SOURCE_UNAVAILABLE");
  assert.equal(error.statusCode, 503);
});
