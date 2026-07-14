# Client Order Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add accurate, paginated keyword, date, payment-status, delivery-status, and processing-stage filters to the customer “我的订单” page without changing order data or privileged visibility.

**Architecture:** Keep `getOrders` as the only data source. Add a customer-only normalized filter contract and bounded cursor scan that always anchors queries to the current WeChat `openid`, then add draft/applied filter state and a native bottom drawer to the existing page. Preserve all admin, detail, and legacy page-number paths.

**Tech Stack:** WeChat Mini Program native WXML/WXSS/CommonJS, WeChat Cloud Development `wx-server-sdk`, Node.js built-in `node:test`.

## Global Constraints

- Modify only the customer order page and `getOrders`; do not change order creation, inventory, payment, account, review, shipment, after-sales, refund, admin-order, or export behavior.
- Do not add collections, indexes, order fields, runtime dependencies, or data migrations.
- Customer queries must derive `openid` from `cloud.getWXContext()` and must not honor a client-supplied identity.
- Do not return inventory, cost, admin notes/tags, risk data, payment screenshots, transaction numbers, full phone numbers, or full addresses.
- Payment and delivery filters are multi-select; time includes today, 7 days, 30 days, and a custom inclusive range.
- Re-entering “我的订单”, including returning from order detail, restores default filters.
- Filtered scans use 50-candidate batches and scan at most 500 candidates per cloud-function invocation.
- No cloud-function upload or mini-program release without a new explicit user confirmation.
- The current `.git` directory has no `HEAD` or `config`; restore valid repository metadata outside this plan before commit steps. Do not run `git init` automatically.

---

## File Structure

- Modify `cloudfunctions/getOrders/index.js`: customer filter normalization, canonical status mapping, keyword matching, cursor encode/decode, bounded scanning, and customer-only filtered response path.
- Modify `cloudfunctions/getOrders/index.test.js`: fake database range/order behavior plus contract, security, keyword, legacy-status, scan, and cursor regression tests.
- Modify `miniprogram/pages/order/list.js`: draft/applied filter state, query payload, cursor pagination, deduplication, auto-continuation, reset-on-reentry, and UI event handlers.
- Create `miniprogram/pages/order/list.test.js`: Node harness that captures the Page definition and tests filter state/request behavior plus WXML/WXSS contracts.
- Modify `miniprogram/pages/order/list.wxml`: search row, active chips, existing stage tabs, bottom filter drawer, progressive-empty states, and retry actions.
- Modify `miniprogram/pages/order/list.wxss`: compact responsive styling for the new controls and drawer.
- Keep `miniprogram/pages/order/list.json` unchanged; use native page elements only.

---

### Task 1: Define and test the customer filter contract

**Files:**
- Modify: `cloudfunctions/getOrders/index.test.js`
- Modify: `cloudfunctions/getOrders/index.js`

**Interfaces:**
- Consumes: existing `normalizeSearchText(value)`, `toDate(value)`, and order summary fields.
- Produces: `normalizeCustomerFilters(input)`, `normalizeDeliveryStatus(order)`, `deriveOrderStage(order)`, `matchesCustomerFilters(order, itemSummary, filters)`, and `exports.__test` hooks used only by Node tests.

- [ ] **Step 1: Extend the fake command matcher so date ranges are testable**

Replace the range portion of `matches()` and the fake `command` object with:

```js
function comparable(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.getTime();
}

function matches(record, where = {}) {
  return Object.entries(where).every(([field, expected]) => {
    const actual = record[field];
    if (!expected || typeof expected !== "object" || !expected.__op) return actual === expected;
    if (expected.__op === "in") return expected.values.includes(actual);
    if (expected.__op === "neq") return actual !== expected.value;
    if (expected.__op === "gte") return comparable(actual) >= comparable(expected.value);
    if (expected.__op === "lte") return comparable(actual) <= comparable(expected.value);
    if (expected.__op === "range") {
      return comparable(actual) >= comparable(expected.min) && comparable(actual) <= comparable(expected.max);
    }
    return false;
  });
}

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
  lte: (value) => ({ __op: "lte", value })
};
```

- [ ] **Step 2: Write failing contract tests**

Append these tests after the existing test setup:

```js
test("customer filter normalization validates dates and canonical multi-select values", () => {
  const normalized = getOrders.__test.normalizeCustomerFilters({
    orderStage: "shipping",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-31T23:59:59.999Z",
    paymentStatuses: ["unpaid", "partial_paid", "unpaid"],
    deliveryStatuses: ["waiting_shipping", "shipped"],
    keyword: "  ORDER-18  "
  });

  assert.equal(normalized.orderStage, "shipping");
  assert.deepEqual(normalized.paymentStatuses, ["unpaid", "partial_paid"]);
  assert.deepEqual(normalized.deliveryStatuses, ["waiting_shipping", "shipped"]);
  assert.equal(normalized.keyword, "order-18");
  assert.equal(normalized.startDate.toISOString(), "2026-07-01T00:00:00.000Z");
});

test("customer filter normalization rejects reversed dates and long keywords", () => {
  assert.throws(
    () => getOrders.__test.normalizeCustomerFilters({
      startDate: "2026-07-10T00:00:00.000Z",
      endDate: "2026-07-01T23:59:59.999Z"
    }),
    /开始日期不能晚于结束日期/
  );
  assert.throws(
    () => getOrders.__test.normalizeCustomerFilters({ keyword: "x".repeat(65) }),
    /关键词不能超过 64 个字符/
  );
});

test("delivery aliases and order stages preserve existing customer semantics", () => {
  assert.equal(getOrders.__test.normalizeDeliveryStatus({ shippingStatus: "created" }), "waiting_shipping");
  assert.equal(getOrders.__test.normalizeDeliveryStatus({ deliveryStatus: "pending_shipment" }), "waiting_shipping");
  assert.equal(getOrders.__test.deriveOrderStage({ status: "pending_admin" }), "review");
  assert.equal(getOrders.__test.deriveOrderStage({ status: "approved_pending_payment" }), "payment");
  assert.equal(getOrders.__test.deriveOrderStage({ paymentStatus: "pending_confirm" }), "confirm");
  assert.equal(getOrders.__test.deriveOrderStage({ shippingStatus: "shipped" }), "shipping");
  assert.equal(getOrders.__test.deriveOrderStage({ status: "completed" }), "done");
});

test("keyword matching checks the order number and every item product name", () => {
  const filters = getOrders.__test.normalizeCustomerFilters({ keyword: "隐藏商品" });
  const matched = getOrders.__test.matchesCustomerFilters(
    { orderNo: "ORDER-1", status: "paid", paymentStatus: "paid" },
    { items: [{ productName: "首件商品" }, { productName: "隐藏商品" }] },
    filters
  );
  assert.equal(matched, true);
});
```

- [ ] **Step 3: Run the tests and confirm the new tests fail**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/getOrders/index.test.js
```

Expected: existing tests pass, and the new tests fail because `getOrders.__test` is undefined.

- [ ] **Step 4: Add the minimal filter helpers to `index.js`**

Add these constants and helpers after `cleanFilters()`:

```js
const CUSTOMER_FILTER_LIMITS = Object.freeze({ keyword: 64, statuses: 10, batch: 50, scan: 500 });
const ORDER_STAGE_VALUES = new Set(["all", "review", "payment", "confirm", "shipping", "done"]);
const PAYMENT_FILTER_GROUPS = Object.freeze({
  unpaid: ["", "none", "unpaid"],
  pending_confirm: ["pending_confirm"],
  partial_paid: ["partial", "partial_paid"],
  paid: ["paid"],
  abnormal: ["abnormal"],
  refunded: ["refunded"]
});
const DELIVERY_FILTER_VALUES = new Set([
  "pending", "waiting_pickup", "picked_up", "waiting_shipping", "shipped", "completed", "after_sales"
]);

function invalidCustomerFilter(message) {
  const error = new Error(message);
  error.code = "INVALID_ORDER_FILTERS";
  return error;
}

function uniqueLimited(values, allowed, label) {
  const input = Array.isArray(values) ? values : [];
  const unique = Array.from(new Set(input.filter((value) => allowed.has(value))));
  if (input.length > CUSTOMER_FILTER_LIMITS.statuses) {
    throw invalidCustomerFilter(`${label}最多选择 ${CUSTOMER_FILTER_LIMITS.statuses} 项`);
  }
  return unique;
}

function parseCustomerFilterDate(value, label) {
  if (!value) return null;
  const parsed = toDate(value);
  if (!parsed) throw invalidCustomerFilter(`${label}无效`);
  return parsed;
}

function normalizeCustomerFilters(input = {}) {
  const rawKeyword = String(input.keyword || "").trim();
  if (rawKeyword.length > CUSTOMER_FILTER_LIMITS.keyword) {
    throw invalidCustomerFilter(`关键词不能超过 ${CUSTOMER_FILTER_LIMITS.keyword} 个字符`);
  }
  const startDate = parseCustomerFilterDate(input.startDate, "开始日期");
  const endDate = parseCustomerFilterDate(input.endDate, "结束日期");
  if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
    throw invalidCustomerFilter("开始日期不能晚于结束日期");
  }
  const requestedStage = String(input.orderStage || "all");
  return {
    orderStage: ORDER_STAGE_VALUES.has(requestedStage) ? requestedStage : "all",
    startDate,
    endDate,
    paymentStatuses: uniqueLimited(input.paymentStatuses, new Set(Object.keys(PAYMENT_FILTER_GROUPS)), "付款状态"),
    deliveryStatuses: uniqueLimited(input.deliveryStatuses, DELIVERY_FILTER_VALUES, "配送状态"),
    keyword: normalizeSearchText(rawKeyword)
  };
}

function normalizeDeliveryStatus(order = {}) {
  const raw = (order.shipmentDisplay && order.shipmentDisplay.shippingStatus)
    || order.shippingStatus
    || order.deliveryStatus
    || "pending";
  if (["created", "pending_shipment", "waiting_shipping"].includes(raw)) return "waiting_shipping";
  if (raw === "abnormal") return "abnormal";
  return DELIVERY_FILTER_VALUES.has(raw) ? raw : "pending";
}

function deriveOrderStage(order = {}) {
  const status = order.status || "";
  const paymentStatus = order.paymentStatus || "";
  const shippingStatus = normalizeDeliveryStatus(order);
  if (["pending_system", "auto_reviewing", "pending_admin"].includes(status)) return "review";
  if (["approved_pending_payment", "unpaid"].includes(status) || ["none", "unpaid"].includes(paymentStatus)) return "payment";
  if (status === "pending_payment_confirm" || ["pending_confirm", "partial", "partial_paid", "abnormal"].includes(paymentStatus)) return "confirm";
  if (["waiting_shipping", "shipped"].includes(shippingStatus) || status === "paid") return "shipping";
  if (status === "completed" || shippingStatus === "completed") return "done";
  return "all";
}

function matchesCustomerFilters(order, itemSummary, filters) {
  if (filters.orderStage !== "all" && deriveOrderStage(order) !== filters.orderStage) return false;
  if (filters.paymentStatuses.length) {
    const raw = order.paymentStatus || "";
    if (!filters.paymentStatuses.some((group) => PAYMENT_FILTER_GROUPS[group].includes(raw))) return false;
  }
  if (filters.deliveryStatuses.length && !filters.deliveryStatuses.includes(normalizeDeliveryStatus(order))) return false;
  if (filters.keyword) {
    const productNames = ((itemSummary && itemSummary.items) || []).map((item) => item.productName || "");
    const text = normalizeSearchText([order.orderNo || "", order.productName || "", ...productNames].join(" "));
    if (!text.includes(filters.keyword)) return false;
  }
  return true;
}
```

Expose test hooks after `exports.main`:

```js
exports.__test = {
  CUSTOMER_FILTER_LIMITS,
  normalizeCustomerFilters,
  normalizeDeliveryStatus,
  deriveOrderStage,
  matchesCustomerFilters
};
```

- [ ] **Step 5: Run the test suite and confirm Task 1 passes**

Run the same Node command. Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- cloudfunctions/getOrders/index.js cloudfunctions/getOrders/index.test.js
git commit -m "test: define customer order filter contract"
```

---

### Task 2: Implement secure bounded cursor scanning in `getOrders`

**Files:**
- Modify: `cloudfunctions/getOrders/index.test.js`
- Modify: `cloudfunctions/getOrders/index.js`

**Interfaces:**
- Consumes: Task 1 helpers and existing `getOrderItemSummaryMap()`, `attachShipmentDisplay()`, `stripAdminFields()`, `sanitizeOrderAddress()`, and `summarizeOrder()`.
- Produces: `encodeCustomerCursor(offset)`, `decodeCustomerCursor(cursor)`, `queryFilteredCustomerOrders(openid, event, pageSize)`, plus `{ orders, pageSize, hasMore, nextCursor }` for customer filtered requests.

- [ ] **Step 1: Make the fake query honor `orderBy`**

Add `sortField` and `sortDirection` to the fake query, replace `orderBy()` and the data slice inside `get()` with:

```js
orderBy(field, direction) {
  this.sortField = field;
  this.sortDirection = direction;
  return this;
},
async get() {
  state.calls.push({ name, where: this.where, offset: this.offset, limit: this.max });
  const records = (state.collections[name] || [])
    .filter((record) => matches(record, this.where))
    .sort((left, right) => {
      if (!this.sortField) return 0;
      const delta = comparable(left[this.sortField]) - comparable(right[this.sortField]);
      return this.sortDirection === "desc" ? -delta : delta;
    });
  return { data: records.slice(this.offset, this.offset + this.max) };
}
```

- [ ] **Step 2: Write failing end-to-end customer filter tests**

Append tests that seed 60 unmatched orders followed by one matching order, and verify cross-batch search, user isolation, cursor continuation, scan cap, and field stripping:

```js
test("customer keyword scan crosses candidate batches and cannot escape current openid", async () => {
  fakeCloud.state.openid = "customer-openid";
  const orders = Array.from({ length: 61 }, (_, index) => ({
    _id: `order-${index}`,
    orderNo: `ORDER-${index}`,
    userOpenid: index === 60 ? "customer-openid" : "customer-openid",
    status: "paid",
    paymentStatus: "paid",
    createdAt: new Date(Date.UTC(2026, 6, 31 - index, 12, 0, 0)),
    adminNote: "不得返回"
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
    filters: { keyword: "目标商品" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.orders.map((order) => order._id), ["order-60"]);
  assert.equal(result.data.orders[0].adminNote, undefined);
  assert.equal(fakeCloud.state.calls.filter((call) => call.name === "orders").length >= 2, true);
});

test("customer filtered pagination returns a cursor without duplicates", async () => {
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
  const second = await getOrders.main({
    summaryOnly: true,
    pageSize: 2,
    cursor: first.data.nextCursor,
    filters: { paymentStatuses: ["paid"] }
  });

  assert.deepEqual(first.data.orders.map((order) => order._id), ["paid-0", "paid-1"]);
  assert.deepEqual(second.data.orders.map((order) => order._id), ["paid-2"]);
  assert.equal(first.data.hasMore, true);
  assert.equal(second.data.hasMore, false);
});

test("customer scan stops at 500 candidates and returns continuation state", async () => {
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

  const result = await getOrders.main({ summaryOnly: true, pageSize: 1, filters: { keyword: "not-found" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.orders, []);
  assert.equal(result.data.hasMore, true);
  assert.equal(typeof result.data.nextCursor, "string");
  assert.notEqual(result.data.nextCursor, "");
});
```

- [ ] **Step 3: Run tests and verify the cursor tests fail**

Run the getOrders Node test command. Expected: new tests fail because filtered customer requests still use one page and return no `nextCursor`.

- [ ] **Step 4: Add cursor and filtered query helpers**

Add these functions before `exports.main`:

```js
function encodeCustomerCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64");
}

function decodeCustomerCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8"));
    if (!Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error("invalid offset");
    return parsed.offset;
  } catch (error) {
    throw invalidCustomerFilter("分页游标无效");
  }
}

function buildCustomerWhere(openid, filters) {
  const where = { userOpenid: openid };
  if (filters.startDate && filters.endDate) {
    where.createdAt = _.gte(filters.startDate).and(_.lte(filters.endDate));
  } else if (filters.startDate) {
    where.createdAt = _.gte(filters.startDate);
  } else if (filters.endDate) {
    where.createdAt = _.lte(filters.endDate);
  }
  return where;
}

async function shapeCustomerSummaryBatch(rows) {
  const itemSummaryMap = await getOrderItemSummaryMap(rows);
  return rows.map((rawOrder) => {
    let safeOrder = attachShipmentDisplay(rawOrder);
    safeOrder = stripAdminFields(safeOrder);
    safeOrder = sanitizeOrderAddress(safeOrder, { role: "super_admin" });
    return {
      order: summarizeOrder(safeOrder, itemSummaryMap[rawOrder._id]),
      itemSummary: itemSummaryMap[rawOrder._id] || { items: [] }
    };
  });
}

async function queryFilteredCustomerOrders(openid, event, pageSize) {
  const filters = normalizeCustomerFilters(event.filters || {});
  const where = buildCustomerWhere(openid, filters);
  let offset = decodeCustomerCursor(event.cursor);
  let scanned = 0;
  const orders = [];
  let hasMore = true;

  while (orders.length < pageSize && scanned < CUSTOMER_FILTER_LIMITS.scan && hasMore) {
    const remaining = CUSTOMER_FILTER_LIMITS.scan - scanned;
    const batchSize = Math.min(CUSTOMER_FILTER_LIMITS.batch, remaining);
    const response = await db.collection("orders")
      .where(where)
      .field(ORDER_SUMMARY_FIELDS)
      .orderBy("createdAt", "desc")
      .skip(offset)
      .limit(batchSize + 1)
      .get();
    const sourceRows = response.data || [];
    const rows = sourceRows.slice(0, batchSize);
    const shapedRows = await shapeCustomerSummaryBatch(rows);
    const batchHasMore = sourceRows.length > batchSize;
    let consumed = 0;

    for (const shaped of shapedRows) {
      consumed += 1;
      scanned += 1;
      if (matchesCustomerFilters(shaped.order, shaped.itemSummary, filters)) orders.push(shaped.order);
      if (orders.length >= pageSize || scanned >= CUSTOMER_FILTER_LIMITS.scan) break;
    }

    offset += consumed;
    const leftInBatch = consumed < rows.length;
    hasMore = leftInBatch || batchHasMore;
    if (!rows.length) hasMore = false;
  }

  return {
    orders,
    page: 1,
    pageSize,
    hasMore,
    nextCursor: hasMore ? encodeCustomerCursor(offset) : ""
  };
}

function isCustomerFilteredRequest(event = {}) {
  return event.admin !== true && !event.orderId && (Boolean(event.cursor) || Boolean(event.filters));
}
```

Add `encodeCustomerCursor`, `decodeCustomerCursor`, and `queryFilteredCustomerOrders` to `exports.__test`.

- [ ] **Step 5: Route only customer filtered requests through the new path**

Inside `exports.main`, after computing `page`, `pageSize`, and before the existing collection query, add:

```js
if (isCustomerFilteredRequest(event)) {
  const data = await queryFilteredCustomerOrders(openid, event, pageSize);
  return { ok: true, data: { ...data, isAdmin: false } };
}
```

Do not alter the existing `admin === true`, `orderId`, or old customer page-number branches.

- [ ] **Step 6: Run getOrders tests and syntax check**

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/getOrders/index.test.js
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check cloudfunctions/getOrders/index.js
```

Expected: all tests pass; syntax check exits with code 0 and no output.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- cloudfunctions/getOrders/index.js cloudfunctions/getOrders/index.test.js
git commit -m "feat: filter customer orders in getOrders"
```

---

### Task 3: Add tested filter state and cursor requests to the customer page

**Files:**
- Create: `miniprogram/pages/order/list.test.js`
- Modify: `miniprogram/pages/order/list.js`

**Interfaces:**
- Consumes: Task 2 request `{ cursor, filters }` and response `{ orders, hasMore, nextCursor }`.
- Produces: `emptyDetailedFilters()`, `validateDetailedFilters(filters)`, `buildCustomerOrderQuery(data, cursor)`, `dedupeOrders(orders)`, plus Page handlers named in Task 4.

- [ ] **Step 1: Create the Node Page harness and failing state tests**

Create `miniprogram/pages/order/list.test.js` with:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadPageDefinition() {
  let definition = null;
  const originalPage = global.Page;
  const originalLoad = Module._load;
  global.Page = (value) => { definition = value; };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.endsWith("utils/api")) return { call() {}, moneyText: String, toast() {}, feedback: { showError() {} } };
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
  const file = require.resolve("./list.js");
  delete require.cache[file];
  const exported = require("./list.js");
  Module._load = originalLoad;
  global.Page = originalPage;
  return { definition, helpers: exported.__test };
}

const { definition, helpers } = loadPageDefinition();

function createPage() {
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  return page;
}

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

test("filter validation rejects reversed custom dates", () => {
  assert.throws(
    () => helpers.validateDetailedFilters({
      timePreset: "custom",
      startDate: "2026-07-10",
      endDate: "2026-07-01",
      paymentStatuses: [],
      deliveryStatuses: []
    }),
    /开始日期不能晚于结束日期/
  );
});

test("dedupe keeps the newest occurrence of each order id", () => {
  assert.deepEqual(
    helpers.dedupeOrders([{ _id: "a", value: 1 }, { _id: "a", value: 2 }, { _id: "b", value: 3 }]),
    [{ _id: "a", value: 2 }, { _id: "b", value: 3 }]
  );
});

test("page exposes reset-on-reentry and filter handlers", () => {
  const page = createPage();
  assert.equal(typeof page.onHide, "function");
  assert.equal(typeof page.openFilterDrawer, "function");
  assert.equal(typeof page.applyDraftFilters, "function");
  assert.equal(typeof page.clearAllFilters, "function");
});

```

- [ ] **Step 2: Run the page tests and verify they fail**

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test miniprogram/pages/order/list.test.js
```

Expected: FAIL because helper exports and new handlers do not exist, and WXML/WXSS do not contain the new controls.

- [ ] **Step 3: Add pure helpers and filter constants to `list.js`**

Change `PAGE_SIZE` to `10`, then add:

```js
const TIME_PRESETS = [
  { value: "all", label: "全部" },
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "custom", label: "自定义" }
];
const PAYMENT_FILTER_OPTIONS = [
  { value: "unpaid", label: "未付款" },
  { value: "pending_confirm", label: "待确认" },
  { value: "partial_paid", label: "部分付款" },
  { value: "paid", label: "已付款" },
  { value: "abnormal", label: "付款异常" },
  { value: "refunded", label: "已退款" }
];
const DELIVERY_FILTER_OPTIONS = [
  { value: "pending", label: "待处理" },
  { value: "waiting_pickup", label: "待自提" },
  { value: "picked_up", label: "已自提" },
  { value: "waiting_shipping", label: "待发货" },
  { value: "shipped", label: "已发货" },
  { value: "completed", label: "已完成" },
  { value: "after_sales", label: "售后中" }
];

function emptyDetailedFilters() {
  return { timePreset: "all", startDate: "", endDate: "", paymentStatuses: [], deliveryStatuses: [] };
}

function localDateIso(text, endOfDay) {
  const parts = String(text || "").split("-").map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return date.toISOString();
}

function presetRange(preset, now = new Date()) {
  if (preset === "all" || preset === "custom") return { startDate: "", endDate: "" };
  const days = preset === "today" ? 0 : preset === "7d" ? 6 : 29;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function validateDetailedFilters(filters) {
  if (filters.timePreset !== "custom") return true;
  if (!filters.startDate || !filters.endDate) throw new Error("请选择完整的开始和结束日期");
  if (localDateIso(filters.startDate, false) > localDateIso(filters.endDate, true)) {
    throw new Error("开始日期不能晚于结束日期");
  }
  return true;
}

function buildCustomerOrderQuery(data, cursor = "") {
  validateDetailedFilters(data.appliedFilters);
  const range = data.appliedFilters.timePreset === "custom"
    ? {
      startDate: localDateIso(data.appliedFilters.startDate, false),
      endDate: localDateIso(data.appliedFilters.endDate, true)
    }
    : presetRange(data.appliedFilters.timePreset);
  return {
    summaryOnly: true,
    pageSize: PAGE_SIZE,
    cursor,
    filters: {
      orderStage: data.activeOrderFilter || "all",
      startDate: range.startDate,
      endDate: range.endDate,
      paymentStatuses: data.appliedFilters.paymentStatuses.slice(),
      deliveryStatuses: data.appliedFilters.deliveryStatuses.slice(),
      keyword: String(data.searchKeyword || "").trim()
    }
  };
}

function dedupeOrders(orders) {
  const map = new Map();
  orders.forEach((order) => map.set(order._id, order));
  return Array.from(map.values());
}
```

- [ ] **Step 4: Add page data and handlers**

Add these data fields inside `Page({ data: ... })`:

```js
searchInput: "",
searchKeyword: "",
filterDrawerVisible: false,
timePresets: TIME_PRESETS,
paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
draftFilters: emptyDetailedFilters(),
appliedFilters: emptyDetailedFilters(),
activeFilterCount: 0,
activeFilterChips: [],
nextCursor: "",
searchingOlderOrders: false,
showContinueOlderSearch: false,
visibleOrders: []
```

Add handlers with these exact behaviors:

```js
onHide() {
  this._resetFiltersOnNextShow = true;
},

onSearchInput(e) {
  this.setData({ searchInput: e.detail.value || "" });
},

submitSearch() {
  this.setData({ searchKeyword: String(this.data.searchInput || "").trim() });
  return this.loadOrders({ reset: true, force: true });
},

openFilterDrawer() {
  const draft = JSON.parse(JSON.stringify(this.data.appliedFilters));
  this.setData({
    filterDrawerVisible: true,
    draftFilters: draft,
    paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: draft.paymentStatuses.includes(item.value) })),
    deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: draft.deliveryStatuses.includes(item.value) }))
  });
},

closeFilterDrawer() {
  this.setData({ filterDrawerVisible: false });
},

toggleFilterValue(key, value, optionsKey, sourceOptions) {
  const selected = new Set(this.data.draftFilters[key]);
  if (selected.has(value)) selected.delete(value); else selected.add(value);
  const values = Array.from(selected);
  this.setData({
    [`draftFilters.${key}`]: values,
    [optionsKey]: sourceOptions.map((item) => ({ ...item, selected: values.includes(item.value) }))
  });
},

togglePaymentStatus(e) {
  this.toggleFilterValue("paymentStatuses", e.currentTarget.dataset.value, "paymentFilterOptions", PAYMENT_FILTER_OPTIONS);
},

toggleDeliveryStatus(e) {
  this.toggleFilterValue("deliveryStatuses", e.currentTarget.dataset.value, "deliveryFilterOptions", DELIVERY_FILTER_OPTIONS);
},

selectTimePreset(e) {
  this.setData({ "draftFilters.timePreset": e.currentTarget.dataset.value || "all" });
},

onCustomStartDateChange(e) {
  this.setData({ "draftFilters.startDate": e.detail.value || "" });
},

onCustomEndDateChange(e) {
  this.setData({ "draftFilters.endDate": e.detail.value || "" });
},

resetDraftFilters() {
  const draft = emptyDetailedFilters();
  this.setData({
    draftFilters: draft,
    paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
    deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: false }))
  });
},

applyDraftFilters() {
  try {
    validateDetailedFilters(this.data.draftFilters);
  } catch (error) {
    toast(error.message);
    return Promise.resolve();
  }
  const applied = JSON.parse(JSON.stringify(this.data.draftFilters));
  this.setData({ filterDrawerVisible: false, appliedFilters: applied });
  this.updateAppliedFilterSummary();
  return this.loadOrders({ reset: true, force: true });
},

clearAllFilters() {
  this.setData({
    activeOrderFilter: "all",
    searchInput: "",
    searchKeyword: "",
    draftFilters: emptyDetailedFilters(),
    appliedFilters: emptyDetailedFilters(),
    activeFilterCount: 0,
    activeFilterChips: [],
    paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
    deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: false }))
  });
  return this.loadOrders({ reset: true, force: true });
},

noop() {}
```

Add the exact summary method below. Time contributes one condition; each selected status contributes one condition to the numeric count, while each status dimension is condensed to one chip:

```js
updateAppliedFilterSummary() {
  const filters = this.data.appliedFilters;
  const chips = [];
  if (filters.timePreset !== "all") {
    const preset = TIME_PRESETS.find((item) => item.value === filters.timePreset);
    const label = filters.timePreset === "custom"
      ? `${filters.startDate} 至 ${filters.endDate}`
      : (preset && preset.label) || "时间";
    chips.push({ key: "time", label });
  }
  if (filters.paymentStatuses.length) {
    const selected = PAYMENT_FILTER_OPTIONS.find((item) => item.value === filters.paymentStatuses[0]);
    const label = filters.paymentStatuses.length === 1 ? (selected && selected.label) : `付款 ${filters.paymentStatuses.length} 项`;
    chips.push({ key: "payment", label: label || "付款状态" });
  }
  if (filters.deliveryStatuses.length) {
    const selected = DELIVERY_FILTER_OPTIONS.find((item) => item.value === filters.deliveryStatuses[0]);
    const label = filters.deliveryStatuses.length === 1 ? (selected && selected.label) : `配送 ${filters.deliveryStatuses.length} 项`;
    chips.push({ key: "delivery", label: label || "配送状态" });
  }
  this.setData({
    activeFilterChips: chips,
    activeFilterCount: (filters.timePreset === "all" ? 0 : 1)
      + filters.paymentStatuses.length
      + filters.deliveryStatuses.length
  });
},
```

- [ ] **Step 5: Replace client-side stage filtering with server requests and cursor loading**

Replace `selectOrderFilter()` with:

```js
selectOrderFilter(e) {
  const filter = e.currentTarget.dataset.filter || "all";
  if (filter === this.data.activeOrderFilter) return Promise.resolve();
  haptics.selection();
  return new Promise((resolve) => {
    this.setData({ activeOrderFilter: filter }, () => {
      Promise.resolve(this.loadOrders({ reset: true, force: true })).finally(resolve);
    });
  });
},
```

Replace the request payload inside `loadOrders()` with `buildCustomerOrderQuery(this.data, reset ? "" : this.data.nextCursor)`. Add a helper that follows at most two empty cursor pages:

```js
fetchFilteredPage(payload, remainingAutoContinues = 2) {
  return call("getOrders", payload, { showLoading: false }).then((data) => {
    const rows = data.orders || [];
    if (!rows.length && data.hasMore && data.nextCursor && remainingAutoContinues > 0) {
      this.setData({ searchingOlderOrders: true });
      return this.fetchFilteredPage({ ...payload, cursor: data.nextCursor }, remainingAutoContinues - 1);
    }
    return data;
  });
},
```

When merging results, use:

```js
const nextOrders = this.shapeOrders(data.orders || []);
const orders = dedupeOrders(reset ? nextOrders : this.data.orders.concat(nextOrders));
this.setData({
  orders,
  visibleOrders: orders,
  nextCursor: data.nextCursor || "",
  hasMore: Boolean(data.hasMore),
  showContinueOlderSearch: !nextOrders.length && Boolean(data.hasMore),
  searchingOlderOrders: false
});
```

Add:

```js
continueOlderSearch() {
  this.setData({ showContinueOlderSearch: false });
  return this.loadOrders({ reset: false, force: true });
},
```

Preserve the existing loading lock, dirty-flag handling, silent refresh behavior, errors, and pull-to-refresh.

Replace `onShow()` with this reset-aware version. It authenticates before reloading and avoids a duplicate request while initial `onLoad` is still running:

```js
onShow() {
  syncTabBar(this, 2);
  if (this._orderInitializing) return;
  const shouldReset = this._resetFiltersOnNextShow === true;
  this._resetFiltersOnNextShow = false;
  if (shouldReset) {
    this.setData({
      activeOrderFilter: "all",
      searchInput: "",
      searchKeyword: "",
      draftFilters: emptyDetailedFilters(),
      appliedFilters: emptyDetailedFilters(),
      activeFilterCount: 0,
      activeFilterChips: [],
      nextCursor: "",
      paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
      deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: false }))
    });
  }
  ensureLogin({ showLoading: false })
    .then(() => ensureFrontendAccess())
    .then(() => {
      if (shouldReset) return this.loadOrders({ reset: true, force: true });
      const elapsed = Date.now() - Number(this.orderLastFetchAt || 0);
      if (isDirty("order") || !this.data.initialized || elapsed >= ORDER_REFRESH_INTERVAL) {
        return this.loadOrders({ reset: true, silent: this.data.orders.length > 0 });
      }
      return null;
    })
    .catch(() => null);
},
```

- [ ] **Step 6: Export test hooks and rerun page tests**

Add after `Page(...)`:

```js
module.exports.__test = {
  emptyDetailedFilters,
  validateDetailedFilters,
  buildCustomerOrderQuery,
  dedupeOrders
};
```

Run the page test command. Expected: all Task 3 page tests pass with zero failures.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- miniprogram/pages/order/list.js miniprogram/pages/order/list.test.js
git commit -m "feat: add customer order filter state"
```

---

### Task 4: Build the native search, chips, and filter drawer UI

**Files:**
- Modify: `miniprogram/pages/order/list.wxml`
- Modify: `miniprogram/pages/order/list.wxss`
- Test: `miniprogram/pages/order/list.test.js`

**Interfaces:**
- Consumes: Task 3 data fields and handlers.
- Produces: visible search/filter controls, accessible tap targets, progressive older-order search, and responsive portrait/landscape layout.

- [ ] **Step 1: Add and run a failing markup/style contract test**

Add these imports to `miniprogram/pages/order/list.test.js`:

```js
const fs = require("node:fs");
const path = require("node:path");
```

Append:

```js
test("WXML and WXSS expose the agreed filter controls", () => {
  const wxml = fs.readFileSync(path.join(__dirname, "list.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(__dirname, "list.wxss"), "utf8");
  assert.match(wxml, /bindconfirm="submitSearch"/);
  assert.match(wxml, /bindtap="openFilterDrawer"/);
  assert.match(wxml, /bindtap="applyDraftFilters"/);
  assert.match(wxml, /继续查找更早订单/);
  assert.match(wxss, /\.order-search-row/);
  assert.match(wxss, /\.order-filter-drawer/);
});
```

Run the page Node test command. Expected: the new test fails because the existing WXML/WXSS do not yet contain the controls or selectors.

- [ ] **Step 2: Insert the search row and active chips above the existing stage tabs**

Add this WXML after `.order-header` and before `.order-filter-scroll`:

```xml
<view class="order-search-row fade-up">
  <input
    class="order-search-input"
    value="{{searchInput}}"
    placeholder="搜索订单号 / 商品名称"
    maxlength="64"
    confirm-type="search"
    bindinput="onSearchInput"
    bindconfirm="submitSearch"
  />
  <button class="order-filter-trigger {{activeFilterCount ? 'active' : ''}}" bindtap="openFilterDrawer">
    筛选<text wx:if="{{activeFilterCount}}"> {{activeFilterCount}}</text>
  </button>
</view>

<scroll-view wx:if="{{searchKeyword || activeFilterChips.length}}" class="active-filter-scroll" scroll-x enable-flex>
  <view class="active-filter-track">
    <view wx:if="{{searchKeyword}}" class="active-filter-chip">关键词：{{searchKeyword}}</view>
    <view wx:for="{{activeFilterChips}}" wx:key="key" class="active-filter-chip">{{item.label}}</view>
    <button class="clear-filter-button" bindtap="clearAllFilters">清除</button>
  </view>
</scroll-view>
```

Keep the existing stage tabs immediately below this block.
Remove the existing `wx:if="{{orders.length || loading || loadError}}"` from `.order-filter-scroll` so the stage tabs remain available when a server-side filter returns no orders.

- [ ] **Step 3: Replace empty/loading footer conditions**

Use `orders` as the server-filtered visible list. Replace both old empty-state blocks with:

```xml
<ui-empty
  wx:if="{{initialized && !loading && !orders.length && !hasMore && !loadError}}"
  icon="≡"
  title="{{searchKeyword || activeFilterCount || activeOrderFilter !== 'all' ? '没有符合条件的订单' : '暂无订单'}}"
  description="{{searchKeyword || activeFilterCount || activeOrderFilter !== 'all' ? '调整条件或清除筛选后重试' : '提交预订单后会显示在这里'}}">
</ui-empty>

<button
  wx:if="{{initialized && !loading && !orders.length && !hasMore && !loadError && (searchKeyword || activeFilterCount || activeOrderFilter !== 'all')}}"
  class="btn btn-secondary empty-clear-button"
  bindtap="clearAllFilters">
  清除筛选
</button>

<view wx:if="{{searchingOlderOrders}}" class="bottom-loading">
  <view class="loading-dot"></view>
  <text>正在查找更早订单</text>
</view>
```

When `showContinueOlderSearch` is true, render:

```xml
<view class="older-search-action">
  <text>暂未找到匹配订单，还可以继续查找更早记录</text>
  <button class="btn btn-secondary" bindtap="continueOlderSearch">继续查找更早订单</button>
</view>
```

Remove the old “当前筛选暂无订单” block because stage filtering no longer operates only on the current page.

- [ ] **Step 4: Add the bottom filter drawer**

Add before the closing page `</view>`:

```xml
<view wx:if="{{filterDrawerVisible}}" class="filter-drawer-layer">
  <view class="filter-drawer-mask" bindtap="closeFilterDrawer" catchtouchmove="noop"></view>
  <view class="order-filter-drawer" catchtap="noop">
    <view class="filter-drawer-head">
      <view class="filter-drawer-title">筛选订单</view>
      <button class="filter-close-button" bindtap="closeFilterDrawer">关闭</button>
    </view>

    <view class="filter-section">
      <view class="filter-section-title">下单时间</view>
      <view class="filter-option-grid">
        <view wx:for="{{timePresets}}" wx:key="value" class="filter-option {{draftFilters.timePreset === item.value ? 'selected' : ''}}" data-value="{{item.value}}" bindtap="selectTimePreset">{{item.label}}</view>
      </view>
      <view wx:if="{{draftFilters.timePreset === 'custom'}}" class="custom-date-row">
        <picker mode="date" value="{{draftFilters.startDate}}" bindchange="onCustomStartDateChange"><view class="date-picker">{{draftFilters.startDate || '开始日期'}}</view></picker>
        <text class="date-separator">至</text>
        <picker mode="date" value="{{draftFilters.endDate}}" bindchange="onCustomEndDateChange"><view class="date-picker">{{draftFilters.endDate || '结束日期'}}</view></picker>
      </view>
    </view>

    <view class="filter-section">
      <view class="filter-section-title">付款状态（可多选）</view>
      <view class="filter-option-grid">
        <view wx:for="{{paymentFilterOptions}}" wx:key="value" class="filter-option {{item.selected ? 'selected' : ''}}" data-value="{{item.value}}" bindtap="togglePaymentStatus">{{item.label}}</view>
      </view>
    </view>

    <view class="filter-section">
      <view class="filter-section-title">配送状态（可多选）</view>
      <view class="filter-option-grid">
        <view wx:for="{{deliveryFilterOptions}}" wx:key="value" class="filter-option {{item.selected ? 'selected' : ''}}" data-value="{{item.value}}" bindtap="toggleDeliveryStatus">{{item.label}}</view>
      </view>
    </view>

    <view class="filter-drawer-actions">
      <button class="btn btn-secondary" bindtap="resetDraftFilters">重置</button>
      <button class="btn btn-primary" bindtap="applyDraftFilters">应用筛选</button>
    </view>
  </view>
</view>
```

- [ ] **Step 5: Add responsive styles**

Add styles using existing color/radius variables. The required layout rules are:

```css
.order-search-row { display:flex; align-items:center; gap:16rpx; margin-bottom:16rpx; }
.order-search-input { flex:1; min-width:0; height:72rpx; padding:0 22rpx; border:1rpx solid var(--color-border-light); border-radius:18rpx; background:var(--color-card); box-sizing:border-box; }
.order-filter-trigger { flex-shrink:0; min-width:120rpx; height:72rpx; margin:0; padding:0 20rpx; border-radius:18rpx; font-size:24rpx; line-height:72rpx; }
.order-filter-trigger.active { color:#fff; background:var(--color-primary); }
.active-filter-scroll { margin-bottom:14rpx; white-space:nowrap; }
.active-filter-track { display:inline-flex; align-items:center; gap:10rpx; min-width:100%; }
.active-filter-chip { padding:8rpx 16rpx; border-radius:999rpx; color:var(--color-primary-deep); background:rgba(53,108,246,.10); font-size:22rpx; }
.clear-filter-button { flex-shrink:0; height:48rpx; margin:0; padding:0 12rpx; color:var(--color-text-secondary); background:transparent; font-size:22rpx; line-height:48rpx; }
.filter-drawer-layer { position:fixed; z-index:1000; inset:0; }
.filter-drawer-mask { position:absolute; inset:0; background:rgba(26,22,18,.42); }
.order-filter-drawer { position:absolute; left:0; right:0; bottom:0; max-height:82vh; padding:28rpx 24rpx calc(24rpx + env(safe-area-inset-bottom)); overflow-y:auto; border-radius:30rpx 30rpx 0 0; background:var(--color-card); box-sizing:border-box; }
.filter-drawer-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:24rpx; }
.filter-drawer-title { font-size:34rpx; font-weight:800; }
.filter-close-button { margin:0; padding:0 12rpx; background:transparent; font-size:24rpx; }
.filter-section { margin-bottom:26rpx; }
.filter-section-title { margin-bottom:14rpx; color:var(--color-text-main); font-size:25rpx; font-weight:700; }
.filter-option-grid { display:flex; flex-wrap:wrap; gap:12rpx; }
.filter-option { min-width:132rpx; padding:16rpx 18rpx; border:1rpx solid var(--color-border-light); border-radius:16rpx; text-align:center; font-size:23rpx; box-sizing:border-box; }
.filter-option.selected { color:var(--color-primary-deep); border-color:var(--color-primary); background:rgba(53,108,246,.10); font-weight:700; }
.custom-date-row { display:flex; align-items:center; gap:12rpx; margin-top:16rpx; }
.custom-date-row picker { flex:1; min-width:0; }
.date-picker { padding:16rpx; border:1rpx solid var(--color-border-light); border-radius:14rpx; text-align:center; font-size:23rpx; }
.filter-drawer-actions { position:sticky; bottom:0; display:grid; grid-template-columns:1fr 2fr; gap:16rpx; padding-top:16rpx; background:var(--color-card); }
.older-search-action { margin:20rpx 0; padding:20rpx; border-radius:18rpx; background:var(--color-card); text-align:center; }
```

Extend the existing `@media (max-width: 360px)` block so `.filter-option` uses `min-width: calc(50% - 6rpx)` and the search input/filter button remain on one row.

- [ ] **Step 6: Run page tests and static checks**

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test miniprogram/pages/order/list.test.js
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check miniprogram/pages/order/list.js
Get-Content -Raw -Encoding UTF8 miniprogram/pages/order/list.json | ConvertFrom-Json | Out-Null
```

Expected: page tests pass, JS syntax exits 0, JSON parsing emits no error.

- [ ] **Step 7: Commit Task 4**

```powershell
git add -- miniprogram/pages/order/list.wxml miniprogram/pages/order/list.wxss miniprogram/pages/order/list.test.js
git commit -m "feat: add customer order filter controls"
```

---

### Task 5: Run full regression and document the deployment boundary

**Files:**
- Verify: `cloudfunctions/getOrders/index.js`
- Verify: `cloudfunctions/getOrders/index.test.js`
- Verify: `miniprogram/pages/order/list.js`
- Verify: `miniprogram/pages/order/list.test.js`
- Verify: `miniprogram/pages/order/list.wxml`
- Verify: `miniprogram/pages/order/list.wxss`

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: evidence that the local implementation is ready for WeChat Developer Tools preview and that only `getOrders` requires a later confirmed upload.

- [ ] **Step 1: Run both automated suites together**

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/getOrders/index.test.js miniprogram/pages/order/list.test.js
```

Expected: zero failures.

- [ ] **Step 2: Run all modified-JS syntax checks**

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check cloudfunctions/getOrders/index.js
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check cloudfunctions/getOrders/index.test.js
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check miniprogram/pages/order/list.js
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check miniprogram/pages/order/list.test.js
```

Expected: all commands exit 0 with no syntax errors.

- [ ] **Step 3: Perform targeted source-contract checks**

```powershell
rg -n "userOpenid = openid|where = \{ userOpenid: openid \}|INVALID_ORDER_FILTERS|nextCursor|CUSTOMER_FILTER_LIMITS" cloudfunctions/getOrders/index.js
rg -n "bindconfirm=\"submitSearch\"|openFilterDrawer|applyDraftFilters|继续查找更早订单" miniprogram/pages/order/list.wxml
rg -n "order-search-row|order-filter-drawer|filter-option\.selected" miniprogram/pages/order/list.wxss
```

Expected: each required security, cursor, event, and style contract appears at least once.

- [ ] **Step 4: Preview in WeChat Developer Tools without uploading**

Verify manually:

1. Default entry shows all orders and no active chips.
2. Order number and a product name from a non-first item both match.
3. Today, 7-day, 30-day, and custom inclusive dates work.
4. Payment and delivery statuses accept multiple choices.
5. Stage tabs combine with detailed filters.
6. Loading more does not duplicate orders.
7. A scan with no early match shows progress or “继续查找更早订单”, not a false final empty state.
8. Network failure preserves the previous list and retry works.
9. Returning from order detail restores default filters.
10. No customer card exposes admin notes, risk data, full phone/address, screenshot URLs, transaction numbers, or inventory.

- [ ] **Step 5: Record the final deployment ledger in the handoff**

Use this exact distinction:

```text
需要上传的云函数（A-Z）：
- getOrders

只需重新编译/预览的小程序文件：
- miniprogram/pages/order/list.js
- miniprogram/pages/order/list.wxml
- miniprogram/pages/order/list.wxss

本次未改动并保持兼容：
- createOrder、submitCartOrder、后台订单、付款、库存、账款、审核、发货、售后、退款、导出

当前状态：
- 仅本地修改
- 尚未上传云函数
- 尚未发布小程序
```

- [ ] **Step 6: Do not upload or publish**

Stop after local verification. Upload `getOrders` only after a separate explicit user confirmation and the project’s cloud-function dry-run workflow.
