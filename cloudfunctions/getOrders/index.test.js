const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.getTime();
}

function matches(record, where = {}) {
  if (where && where.__op === "and") return where.conditions.every((condition) => matches(record, condition));
  if (where && where.__op === "or") return where.conditions.some((condition) => matches(record, condition));
  return Object.entries(where).every(([field, expected]) => {
    const actual = record[field];
    if (!expected || typeof expected !== "object" || !expected.__op) return actual === expected;
    if (expected.__op === "in") return expected.values.includes(actual);
    if (expected.__op === "neq") return actual !== expected.value;
    if (expected.__op === "lt") return comparable(actual) < comparable(expected.value);
    if (expected.__op === "gte") return comparable(actual) >= comparable(expected.value);
    if (expected.__op === "lte") return comparable(actual) <= comparable(expected.value);
    if (expected.__op === "range") {
      return comparable(actual) >= comparable(expected.min) && comparable(actual) <= comparable(expected.max);
    }
    return false;
  });
}

function createFakeCloud() {
  const state = {
    openid: "admin-openid",
    collections: {},
    calls: [],
    docCalls: []
  };
  const command = {
    in: (values) => ({ __op: "in", values }),
    neq: (value) => ({ __op: "neq", value }),
    gte: (value) => ({
      __op: "gte",
      value,
      and(other) {
        return { __op: "range", min: value, max: other.value };
      }
    }),
    lte: (value) => ({ __op: "lte", value }),
    lt: (value) => ({ __op: "lt", value }),
    and: (conditions) => ({ __op: "and", conditions }),
    or: (conditions) => ({ __op: "or", conditions })
  };

  function collection(name) {
    const query = {
      where: {},
      offset: 0,
      max: 100,
      selectedFields: null,
      sortField: "",
      sortDirection: "",
      where(value) {
        this.where = value || {};
        return this;
      },
      field(value) {
        this.selectedFields = value || null;
        return this;
      },
      orderBy(field, direction) {
        if (!this.sortField) {
          this.sortField = field;
          this.sortDirection = direction;
        }
        return this;
      },
      skip(value) {
        this.offset = value;
        return this;
      },
      limit(value) {
        this.max = value;
        return this;
      },
      async get() {
        state.calls.push({
          name,
          where: this.where,
          fields: this.selectedFields,
          orderBy: this.sortField,
          orderDirection: this.sortDirection,
          offset: this.offset,
          limit: this.max
        });
        const records = (state.collections[name] || [])
          .filter((record) => matches(record, this.where))
          .sort((left, right) => {
            if (!this.sortField) return 0;
            const delta = comparable(left[this.sortField]) - comparable(right[this.sortField]);
            if (Number.isNaN(delta)) return 0;
            return this.sortDirection === "desc" ? -delta : delta;
          });
        return { data: records.slice(this.offset, this.offset + this.max) };
      }
    };
    return {
      where(value) {
        query.where = value || {};
        return query;
      },
      doc(id) {
        state.docCalls.push({ name, id });
        return {
          async get() {
            const record = (state.collections[name] || []).find((item) => item._id === id);
            if (!record) throw new Error("document not found");
            return { data: record };
          }
        };
      }
    };
  }

  const db = { command, collection };
  return {
    state,
    sdk: {
      DYNAMIC_CURRENT_ENV: "dynamic",
      init() {},
      database: () => db,
      getWXContext: () => ({ OPENID: state.openid })
    }
  };
}

const fakeCloud = createFakeCloud();
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "wx-server-sdk") return fakeCloud.sdk;
  return originalLoad.call(this, request, parent, isMain);
};
const getOrders = require("./index");
Module._load = originalLoad;

function baseAdmin() {
  return {
    _id: "admin-1",
    openid: "admin-openid",
    role: "super_admin",
    isActive: true,
    status: "active"
  };
}

test.beforeEach(() => {
  fakeCloud.state.openid = "admin-openid";
  fakeCloud.state.calls = [];
  fakeCloud.state.docCalls = [];
  fakeCloud.state.collections = { admin_users: [baseAdmin()] };
});

test("deployable order query service copy matches the canonical service", () => {
  const deployablePath = path.join(__dirname, "orderQueryService.js");
  const canonicalPath = path.join(__dirname, "..", "common", "services", "orderQueryService.js");

  assert.equal(
    fs.readFileSync(deployablePath, "utf8"),
    fs.readFileSync(canonicalPath, "utf8")
  );
  assert.doesNotMatch(fs.readFileSync(deployablePath, "utf8"), /require\(["']\.\.\/common\//);
});

test("admin enrichment batches related collections and paginates over 100 order items", async () => {
  const manyItems = Array.from({ length: 105 }, (_, index) => ({
    _id: `item-${index}`,
    orderId: "order-1",
    productId: "product-1",
    productName: `商品 ${index}`,
    quantity: 1,
    unitPrice: 100,
    totalAmount: 100
  }));
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: [
      { _id: "order-1", orderNo: "A1", userId: "user-1", userOpenid: "openid-1", totalAmount: 10500 },
      { _id: "order-2", orderNo: "A2", userId: "user-2", userOpenid: "openid-2", totalAmount: 200 }
    ],
    order_items: [...manyItems, {
      _id: "item-last",
      orderId: "order-2",
      productId: "product-2",
      productName: "第二件商品",
      quantity: 2,
      unitPrice: 100,
      totalAmount: 200
    }],
    products: [
      { _id: "product-1", stock: 88, productIndex: "IDX-1", skuCode: "SKU-1" },
      { _id: "product-2", stock: 9, productIndex: "IDX-2", skuCode: "SKU-2" }
    ],
    users: [
      { _id: "user-1", openid: "openid-1", nickname: "客户一" },
      { _id: "user-2", openid: "openid-2", nickname: "客户二" }
    ],
    customer_accounts: [
      { _id: "account-1", userId: "user-1", userOpenid: "openid-1", riskLevel: "watch", adminTags: ["重点"] },
      { _id: "account-2", userId: "user-2", userOpenid: "openid-2", riskLevel: "normal" }
    ]
  };

  const result = await getOrders.main({ admin: true });

  assert.equal(result.ok, true);
  assert.equal(result.data.orders.length, 2);
  assert.equal(result.data.orders[0].items.length, 105);
  assert.equal(result.data.orders[0].items[0].currentStock, 88);
  assert.equal(result.data.orders[0].customerRiskLevel, "important");
  assert.equal(result.data.orders[0].user.nickname, "客户一");
  assert.equal(fakeCloud.state.docCalls.length, 0);
  assert.deepEqual(
    fakeCloud.state.calls.filter((call) => call.name === "order_items").map((call) => call.offset),
    [0, 100]
  );
  assert.equal(fakeCloud.state.calls.filter((call) => call.name === "products").length, 1);
  assert.equal(fakeCloud.state.calls.filter((call) => call.name === "users").length, 2);
  assert.equal(fakeCloud.state.calls.filter((call) => call.name === "customer_accounts").length, 2);
});

test("normal user response strips admin-only fields without admin enrichment queries", async () => {
  fakeCloud.state.openid = "customer-openid";
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: [{
      _id: "customer-order",
      userOpenid: "customer-openid",
      adminNote: "内部备注",
      riskLevelSnapshot: "risk",
      customerPhoneSnapshot: "13800138000",
      totalAmount: 500
    }],
    order_items: [{
      _id: "customer-item",
      orderId: "customer-order",
      productId: "product-1",
      productName: "普通商品",
      quantity: 1,
      unitPrice: 500,
      totalAmount: 500
    }]
  };

  const result = await getOrders.main({});
  const order = result.data.orders[0];

  assert.equal(result.ok, true);
  assert.equal(order.adminNote, undefined);
  assert.equal(order.riskLevelSnapshot, undefined);
  assert.equal(order.customerPhoneSnapshot, undefined);
  assert.equal(order.items.length, 1);
  assert.equal(fakeCloud.state.calls.some((call) => ["products", "users", "customer_accounts"].includes(call.name)), false);
});

test("legacy order fallback keeps snapshot item, product enrichment and keyword filtering", async () => {
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: [{
      _id: "legacy-order",
      orderNo: "OLD-1",
      userId: "legacy-user",
      userOpenid: "legacy-openid",
      productId: "legacy-product",
      productName: "旧单商品",
      quantity: 3,
      unitPrice: 200,
      totalAmount: 600
    }],
    order_items: [],
    products: [{ _id: "legacy-product", stock: 12, skuCode: "SKU-LEGACY" }],
    users: [{ _id: "legacy-user", openid: "legacy-openid", nickname: "旧客户" }],
    customer_accounts: []
  };

  const result = await getOrders.main({
    admin: true,
    filters: { productKeyword: "sku-legacy", includeCancelled: true }
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.orders.length, 1);
  assert.equal(result.data.orders[0].items[0].productName, "旧单商品");
  assert.equal(result.data.orders[0].items[0].currentStock, 12);
  assert.equal(result.data.orders[0].items[0].skuCode, "SKU-LEGACY");
});

test("product enrichment supports multiple bounded query chunks", async () => {
  const items = Array.from({ length: 45 }, (_, index) => ({
    _id: `chunk-item-${index}`,
    orderId: "chunk-order",
    productId: `chunk-product-${index}`,
    productName: `分块商品 ${index}`,
    quantity: 1
  }));
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: [{ _id: "chunk-order", userId: "chunk-user", userOpenid: "chunk-openid" }],
    order_items: items,
    products: items.map((item, index) => ({ _id: item.productId, stock: index + 1 })),
    users: [{ _id: "chunk-user", openid: "chunk-openid", nickname: "分块客户" }],
    customer_accounts: []
  };

  const result = await getOrders.main({ admin: true });

  assert.equal(result.ok, true);
  assert.equal(result.data.orders[0].items.length, 45);
  assert.equal(result.data.orders[0].items[44].currentStock, 45);
  assert.equal(fakeCloud.state.calls.filter((call) => call.name === "products").length, 3);
});

test("customer filter normalization validates dates and canonical multi-select values", () => {
  const { normalizeCustomerFilters } = require("./filtering");
  const normalized = normalizeCustomerFilters({
    orderStage: "shipping",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-31T23:59:59.999Z",
    paymentStatuses: ["unpaid", "partial_paid", "unpaid", "partial"],
    deliveryStatuses: ["waiting_shipping", "shipped", "abnormal"],
    keyword: "  ORDER-18  "
  });

  assert.equal(normalized.orderStage, "shipping");
  assert.deepEqual(normalized.paymentStatuses, ["unpaid", "partial_paid"]);
  assert.deepEqual(normalized.deliveryStatuses, ["waiting_shipping", "shipped"]);
  assert.equal(normalized.keyword, "order-18");
  assert.equal(normalized.startDate.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(normalized.endDate.toISOString(), "2026-07-31T23:59:59.999Z");
});

test("customer filter normalization rejects invalid or reversed dates and long keywords", () => {
  const { normalizeCustomerFilters, toDate } = require("./filtering");
  const invalidDate = new Date("invalid");

  assert.equal(toDate(invalidDate), invalidDate);
  assert.throws(
    () => normalizeCustomerFilters({ startDate: invalidDate }),
    (error) => error.code === "INVALID_ORDER_FILTERS" && /开始日期无效/.test(error.message)
  );
  assert.throws(
    () => normalizeCustomerFilters({
      startDate: "2026-07-10T00:00:00.000Z",
      endDate: "2026-07-01T23:59:59.999Z"
    }),
    /开始日期不能晚于结束日期/
  );
  assert.throws(
    () => normalizeCustomerFilters({ keyword: "x".repeat(65) }),
    /关键词不能超过 64 个字符/
  );
});

test("customer filter normalization keeps every canonical group and enforces selection limits", () => {
  const { normalizeCustomerFilters } = require("./filtering");
  const normalized = normalizeCustomerFilters({
    paymentStatuses: ["unpaid", "pending_confirm", "partial_paid", "paid", "abnormal", "refunded"],
    deliveryStatuses: ["pending", "waiting_pickup", "picked_up", "waiting_shipping", "shipped", "completed", "after_sales"]
  });

  assert.deepEqual(normalized.paymentStatuses, ["unpaid", "pending_confirm", "partial_paid", "paid", "abnormal", "refunded"]);
  assert.deepEqual(normalized.deliveryStatuses, ["pending", "waiting_pickup", "picked_up", "waiting_shipping", "shipped", "completed", "after_sales"]);
  assert.throws(
    () => normalizeCustomerFilters({ paymentStatuses: Array.from({ length: 11 }, () => "unpaid") }),
    /付款状态最多选择 10 项/
  );
});

test("payment filter groups match canonical selections and historical aliases", () => {
  const { normalizeCustomerFilters, matchesCustomerFilters } = require("./filtering");
  const unpaid = normalizeCustomerFilters({ paymentStatuses: ["unpaid"] });
  const partialPaid = normalizeCustomerFilters({ paymentStatuses: ["partial_paid"] });

  assert.equal(matchesCustomerFilters({ paymentStatus: "" }, null, unpaid), true);
  assert.equal(matchesCustomerFilters({ paymentStatus: "none" }, null, unpaid), true);
  assert.equal(matchesCustomerFilters({ paymentStatus: "unpaid" }, null, unpaid), true);
  assert.equal(matchesCustomerFilters({ paymentStatus: "partial" }, null, partialPaid), true);
  assert.equal(matchesCustomerFilters({ paymentStatus: "partial_paid" }, null, partialPaid), true);

  const cases = [
    { group: "pending_confirm", matching: "pending_confirm", nonmatching: "paid" },
    { group: "paid", matching: "paid", nonmatching: "unpaid" },
    { group: "abnormal", matching: "abnormal", nonmatching: "refunded" },
    { group: "refunded", matching: "refunded", nonmatching: "abnormal" }
  ];
  for (const { group, matching, nonmatching } of cases) {
    const filters = normalizeCustomerFilters({ paymentStatuses: [group] });
    assert.equal(matchesCustomerFilters({ paymentStatus: matching }, null, filters), true, `${group} should match ${matching}`);
    assert.equal(matchesCustomerFilters({ paymentStatus: nonmatching }, null, filters), false, `${group} should reject ${nonmatching}`);
  }
});

test("delivery aliases normalize without merging pickup or abnormal states", () => {
  const { normalizeCustomerFilters, normalizeDeliveryStatus, matchesCustomerFilters } = require("./filtering");

  assert.equal(normalizeDeliveryStatus({ shippingStatus: "created" }), "waiting_shipping");
  assert.equal(normalizeDeliveryStatus({ deliveryStatus: "pending_shipment" }), "waiting_shipping");
  assert.equal(normalizeDeliveryStatus({ shipmentDisplay: { shippingStatus: "waiting_shipping" } }), "waiting_shipping");
  assert.equal(normalizeDeliveryStatus({ deliveryStatus: "waiting_pickup" }), "waiting_pickup");
  assert.equal(normalizeDeliveryStatus({ deliveryStatus: "picked_up" }), "picked_up");
  assert.equal(normalizeDeliveryStatus({ deliveryStatus: "abnormal" }), "abnormal");
  assert.equal(normalizeDeliveryStatus({ deliveryStatus: "after_sales" }), "after_sales");
  assert.equal(normalizeDeliveryStatus({ shippingStatus: "shipped", deliveryStatus: "after_sales" }), "shipped");

  const afterSalesFilters = normalizeCustomerFilters({ deliveryStatuses: ["after_sales"] });
  const persistedAfterSales = { deliveryStatus: "after_sales", shippingStatus: "abnormal" };
  assert.equal(normalizeDeliveryStatus(persistedAfterSales), "after_sales");
  assert.equal(matchesCustomerFilters(persistedAfterSales, null, afterSalesFilters), true);
});

test("order stages preserve existing customer semantics", () => {
  const { deriveOrderStage } = require("./filtering");

  assert.equal(deriveOrderStage({ status: "pending_admin" }), "review");
  assert.equal(deriveOrderStage({ status: "approved_pending_payment" }), "payment");
  assert.equal(deriveOrderStage({ paymentStatus: "none" }), "payment");
  assert.equal(deriveOrderStage({ paymentStatus: "" }), "all");
  assert.equal(deriveOrderStage({ paymentStatus: "pending_confirm" }), "confirm");
  assert.equal(deriveOrderStage({ paymentStatus: "partial" }), "confirm");
  assert.equal(deriveOrderStage({ paymentStatus: "abnormal" }), "confirm");
  assert.equal(deriveOrderStage({ shippingStatus: "waiting_shipping" }), "shipping");
  assert.equal(deriveOrderStage({ shippingStatus: "shipped" }), "shipping");
  assert.equal(deriveOrderStage({ status: "paid" }), "shipping");
  assert.equal(deriveOrderStage({ deliveryStatus: "waiting_pickup" }), "all");
  assert.equal(deriveOrderStage({ deliveryStatus: "picked_up" }), "all");
  assert.equal(deriveOrderStage({ deliveryStatus: "abnormal" }), "all");
  assert.equal(deriveOrderStage({ shippingStatus: "shipped", deliveryStatus: "after_sales" }), "shipping");
  assert.equal(deriveOrderStage({ status: "completed" }), "done");
});

test("keyword matching checks order number and every item product name", () => {
  const { normalizeCustomerFilters, matchesCustomerFilters } = require("./filtering");
  const orderNumberFilters = normalizeCustomerFilters({ keyword: "order-18" });
  const productFilters = normalizeCustomerFilters({ keyword: "隐藏商品" });

  assert.equal(matchesCustomerFilters(
    { orderNo: "ORDER-18", status: "paid", paymentStatus: "paid" },
    { items: [{ productName: "首件商品" }] },
    orderNumberFilters
  ), true);
  assert.equal(matchesCustomerFilters(
    { orderNo: "ORDER-1", status: "paid", paymentStatus: "paid" },
    { items: [{ productName: "首件商品" }, { productName: "隐藏商品" }] },
    productFilters
  ), true);
});

test("customer keyword scan crosses batches, stays inside current openid, and uses the bounded query contract", async () => {
  fakeCloud.state.openid = "customer-openid";
  const orders = Array.from({ length: 61 }, (_, index) => ({
    _id: `order-${index}`,
    orderNo: `ORDER-${index}`,
    userOpenid: "customer-openid",
    status: "paid",
    paymentStatus: "paid",
    createdAt: new Date(Date.UTC(2026, 6, 31, 12, 0, 0) - index * 60_000),
    adminNote: "不得返回",
    riskLevelSnapshot: "risk",
    paymentScreenshotUrl: "cloud://private-proof"
  }));
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: orders.concat({
      _id: "other-user-order",
      orderNo: "SECRET-MATCH",
      userOpenid: "other-openid",
      status: "paid",
      paymentStatus: "paid",
      createdAt: new Date(Date.UTC(2026, 7, 1, 12, 0, 0))
    }),
    order_items: orders.map((order, index) => ({
      _id: `item-${index}`,
      orderId: order._id,
      productName: index === 60 ? "目标商品" : "普通商品",
      quantity: 1
    }))
  };

  const result = await getOrders.main({
    userOpenid: "other-openid",
    summaryOnly: true,
    pageSize: 1,
    filters: {
      keyword: "目标商品",
      startDate: new Date(Date.UTC(2026, 6, 1, 0, 0, 0)),
      endDate: new Date(Date.UTC(2026, 7, 1, 23, 59, 59))
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.orders.map((order) => order._id), ["order-60"]);
  assert.equal(result.data.orders[0].adminNote, undefined);
  assert.equal(result.data.orders[0].riskLevelSnapshot, undefined);
  assert.equal(result.data.orders[0].paymentScreenshotUrl, undefined);
  const orderCalls = fakeCloud.state.calls.filter((call) => call.name === "orders");
  assert.equal(orderCalls.length >= 2, true);
  assert.deepEqual(Object.keys(orderCalls[0].where).sort(), ["createdAt", "userOpenid"]);
  assert.equal(orderCalls[0].where.userOpenid, "customer-openid");
  assert.equal(orderCalls[0].fields._id, true);
  assert.equal(orderCalls[0].fields.adminNote, undefined);
  assert.equal(orderCalls[0].orderBy, "createdAt");
  assert.equal(orderCalls[0].orderDirection, "desc");
  assert.equal(orderCalls[0].limit, 51);
});

test("customer filtered pagination advances by consumed rows without skipping the rest of a batch", async () => {
  fakeCloud.state.openid = "customer-openid";
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: [0, 1, 2].map((index) => ({
      _id: `paid-${index}`,
      orderNo: `PAID-${index}`,
      userOpenid: "customer-openid",
      status: "paid",
      paymentStatus: "paid",
      shippingStatus: "shipped",
      createdAt: new Date(Date.UTC(2026, 6, 13 - index, 12, 0, 0))
    })),
    order_items: []
  };

  const first = await getOrders.main({ summaryOnly: true, pageSize: 2, filters: { paymentStatuses: ["paid"] } });
  assert.equal(typeof first.data.nextCursor, "string");
  const firstCursor = JSON.parse(Buffer.from(first.data.nextCursor, "base64").toString("utf8"));
  const second = await getOrders.main({
    summaryOnly: true,
    pageSize: 2,
    cursor: first.data.nextCursor,
    filters: { paymentStatuses: ["paid"] }
  });

  assert.deepEqual(first.data.orders.map((order) => order._id), ["paid-0", "paid-1"]);
  assert.deepEqual(firstCursor, { offset: 2 });
  assert.deepEqual(second.data.orders.map((order) => order._id), ["paid-2"]);
  assert.equal(first.data.hasMore, true);
  assert.equal(second.data.hasMore, false);
  assert.equal(second.data.nextCursor, "");
});

test("customer filtered scans exclude cancelled orders unless explicitly included", async () => {
  fakeCloud.state.openid = "customer-openid";
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: [
      {
        _id: "active-unpaid",
        orderNo: "ACTIVE-UNPAID",
        userOpenid: "customer-openid",
        status: "unpaid",
        paymentStatus: "unpaid",
        createdAt: new Date(Date.UTC(2026, 6, 13, 12, 0, 0))
      },
      {
        _id: "cancelled-unpaid",
        orderNo: "CANCELLED-UNPAID",
        userOpenid: "customer-openid",
        status: "cancelled",
        paymentStatus: "unpaid",
        createdAt: new Date(Date.UTC(2026, 6, 12, 12, 0, 0))
      }
    ],
    order_items: []
  };

  const defaults = await getOrders.main({ summaryOnly: true, filters: {} });
  const unpaid = await getOrders.main({
    summaryOnly: true,
    filters: { paymentStatuses: ["unpaid"] }
  });
  const explicit = await getOrders.main({
    summaryOnly: true,
    filters: { includeCancelled: true }
  });

  assert.deepEqual(defaults.data.orders.map((order) => order._id), ["active-unpaid"]);
  assert.deepEqual(unpaid.data.orders.map((order) => order._id), ["active-unpaid"]);
  assert.deepEqual(explicit.data.orders.map((order) => order._id), ["active-unpaid", "cancelled-unpaid"]);
  const orderCalls = fakeCloud.state.calls.filter((call) => call.name === "orders");
  assert.equal(orderCalls.length > 0, true);
  assert.equal(orderCalls.every((call) => !Object.hasOwn(call.where, "status")), true);
  assert.equal(orderCalls.every((call) => Object.keys(call.where).every((key) => ["userOpenid", "createdAt"].includes(key))), true);
});

test("customer filtered page size clamps finite values and preserves the limit alias", async () => {
  fakeCloud.state.openid = "customer-openid";
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: Array.from({ length: 8 }, (_, index) => ({
      _id: `page-size-${index}`,
      orderNo: `PAGE-SIZE-${index}`,
      userOpenid: "customer-openid",
      status: "paid",
      paymentStatus: "paid",
      createdAt: new Date(Date.UTC(2026, 6, 13, 12, 0, 0) - index * 1000)
    })),
    order_items: []
  };

  const zero = await getOrders.main({ summaryOnly: true, filters: {}, pageSize: 0, limit: 5 });
  const negative = await getOrders.main({ summaryOnly: true, filters: {}, pageSize: -4 });
  const nonNumeric = await getOrders.main({ summaryOnly: true, filters: {}, pageSize: "not-a-number", limit: 3 });
  const alias = await getOrders.main({ summaryOnly: true, filters: {}, limit: 2 });

  assert.equal(zero.data.pageSize, 1);
  assert.equal(zero.data.orders.length, 1);
  assert.equal(negative.data.pageSize, 1);
  assert.equal(nonNumeric.data.pageSize, 100);
  assert.equal(alias.data.pageSize, 2);
  assert.equal(alias.data.orders.length, 2);
});

test("customer scan stops at 500 candidates and returns a cursor when candidates remain", async () => {
  fakeCloud.state.openid = "customer-openid";
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: Array.from({ length: 501 }, (_, index) => ({
      _id: `scan-${index}`,
      orderNo: `SCAN-${index}`,
      userOpenid: "customer-openid",
      status: "paid",
      paymentStatus: "paid",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - index * 1000)
    })),
    order_items: []
  };

  const result = await getOrders.main({ summaryOnly: true, pageSize: 999, filters: { keyword: "not-found" } });
  assert.equal(typeof result.data.nextCursor, "string");
  const cursor = JSON.parse(Buffer.from(result.data.nextCursor, "base64").toString("utf8"));
  const orderCalls = fakeCloud.state.calls.filter((call) => call.name === "orders");

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.orders, []);
  assert.equal(result.data.pageSize, 100);
  assert.equal(result.data.hasMore, true);
  assert.deepEqual(cursor, { offset: 500 });
  assert.equal(orderCalls.length, 10);
  assert.equal(orderCalls.every((call) => call.limit === 51), true);
});

test("customer scan reports final exhaustion at exactly 500 candidates", async () => {
  fakeCloud.state.openid = "customer-openid";
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: Array.from({ length: 500 }, (_, index) => ({
      _id: `exhausted-${index}`,
      orderNo: `EXHAUSTED-${index}`,
      userOpenid: "customer-openid",
      status: "paid",
      paymentStatus: "paid",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - index * 1000)
    })),
    order_items: []
  };

  const result = await getOrders.main({
    summaryOnly: true,
    pageSize: 100,
    filters: { keyword: "not-found" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.orders, []);
  assert.equal(result.data.hasMore, false);
  assert.equal(result.data.nextCursor, "");
});

test("customer cursor rejects malformed, negative, and non-integer offsets without querying orders", async () => {
  fakeCloud.state.openid = "customer-openid";
  fakeCloud.state.collections = { admin_users: [baseAdmin()], orders: [] };
  const cursors = [
    "not-base64-json",
    Buffer.from(JSON.stringify({ offset: -1 }), "utf8").toString("base64"),
    Buffer.from(JSON.stringify({ offset: 1.5 }), "utf8").toString("base64")
  ];

  for (const cursor of cursors) {
    const result = await getOrders.main({ summaryOnly: true, cursor });
    assert.deepEqual(result, { ok: false, message: "分页游标无效" });
  }
  assert.equal(fakeCloud.state.calls.some((call) => call.name === "orders"), false);
});

test("admin filters, customer orderId, and unfiltered customer page-number requests keep legacy routing", async () => {
  fakeCloud.state.collections = {
    admin_users: [baseAdmin()],
    orders: [0, 1, 2].map((index) => ({
      _id: `legacy-${index}`,
      orderNo: `LEGACY-${index}`,
      userOpenid: "customer-openid",
      status: "paid",
      paymentStatus: "paid",
      createdAt: new Date(Date.UTC(2026, 6, 13 - index, 12, 0, 0))
    })),
    order_items: [],
    products: [],
    users: [],
    customer_accounts: []
  };

  const adminResult = await getOrders.main({ admin: true, summaryOnly: true, filters: { paymentStatuses: ["paid"] } });
  assert.equal(adminResult.ok, true);
  assert.equal(adminResult.data.isAdmin, true);
  assert.equal(adminResult.data.nextCursor, undefined);

  fakeCloud.state.openid = "customer-openid";
  const orderIdResult = await getOrders.main({ orderId: "legacy-1", summaryOnly: true, filters: { keyword: "not-a-match" } });
  assert.deepEqual(orderIdResult.data.orders.map((order) => order._id), ["legacy-1"]);
  assert.equal(orderIdResult.data.nextCursor, undefined);

  const pageResult = await getOrders.main({ page: 2, pageSize: 1, summaryOnly: true });
  assert.deepEqual(pageResult.data.orders.map((order) => order._id), ["legacy-1"]);
  assert.equal(pageResult.data.page, 2);
  assert.equal(pageResult.data.nextCursor, undefined);

  const filteredFirstPage = await getOrders.main({
    page: 2,
    pageSize: 1,
    cursor: "",
    filters: {},
    summaryOnly: true
  });
  assert.deepEqual(filteredFirstPage.data.orders.map((order) => order._id), ["legacy-0"]);
  assert.equal(filteredFirstPage.data.page, 1);
  assert.equal(typeof filteredFirstPage.data.nextCursor, "string");
});
