const test = require("node:test");
const assert = require("node:assert/strict");
const { createPaymentQueryService } = require("./paymentQueryService");

function comparable(value) { const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? value : date.getTime(); }
function matches(row, condition) {
  if (!condition) return true;
  if (condition.__op === "and") return condition.values.every((value) => matches(row, value));
  if (condition.__op === "or") return condition.values.some((value) => matches(row, value));
  return Object.entries(condition).every(([key, expected]) => {
    const actual = row[key];
    if (expected && expected.__op === "lt") return comparable(actual) < comparable(expected.value);
    if (expected && expected.__op === "in") return expected.values.includes(actual);
    if (expected && expected.__op === "regex") return new RegExp(expected.source, expected.flags).test(String(actual || ""));
    return comparable(actual) === comparable(expected);
  });
}
function fakeDatabase(seed = {}) {
  const command = {
    and(values) { return { __op: "and", values }; },
    or(values) { return { __op: "or", values }; },
    lt(value) { return { __op: "lt", value }; },
    in(values) { return { __op: "in", values }; }
  };
  class Query {
    constructor(name, rows) { this.name = name; this.rows = rows.slice(); this.orders = []; this.max = Infinity; }
    where(condition) { this.rows = this.rows.filter((row) => matches(row, condition)); return this; }
    orderBy(field, direction) { this.orders.push([field, direction]); return this; }
    limit(value) { this.max = value; return this; }
    async get() {
      const rows = this.rows.slice().sort((left, right) => {
        for (const [field, direction] of this.orders) { const a = comparable(left[field]); const b = comparable(right[field]); if (a !== b) return (a < b ? -1 : 1) * (direction === "desc" ? -1 : 1); }
        return 0;
      });
      return { data: rows.slice(0, this.max) };
    }
  }
  return {
    db: {
      RegExp({ regexp, options }) { return { __op: "regex", source: regexp, flags: options }; },
      collection(name) {
        const rows = Array.isArray(seed[name]) ? seed[name] : [];
        return {
          where(condition) { return new Query(name, rows).where(condition); },
          orderBy(field, direction) { return new Query(name, rows).orderBy(field, direction); },
          doc(id) { return { async get() { return { data: rows.find((row) => row._id === id) || null }; } }; }
        };
      }
    },
    command
  };
}

const finance = { role: "finance", status: "active", isActive: true, permissions: ["payment:view_screenshot"] };
const record = (id, minute, overrides = {}) => ({
  _id: id,
  orderId: "order-" + id,
  orderNo: "ORDER-" + id,
  amount: 32000,
  paymentStatus: "pending_confirm",
  screenshotUrls: ["cloud://private"],
  submittedAt: new Date("2026-07-13T00:" + String(minute).padStart(2, "0") + ":00Z"),
  updatedAt: new Date("2026-07-13T00:" + String(minute).padStart(2, "0") + ":00Z"),
  ...overrides
});
const pendingOrder = (paymentId, overrides = {}) => ({
  _id: `order-${paymentId}`,
  orderNo: `ORDER-${paymentId}`,
  latestPaymentRecordId: paymentId,
  paymentStatus: "pending_confirm",
  status: "pending_payment_confirm",
  ...overrides
});

test("payment Web reads are role guarded and project a safe DTO", async () => {
  const service = createPaymentQueryService(fakeDatabase({ payment_records: [record("1", 1)], orders: [pendingOrder("1")] }));
  await assert.rejects(() => service.listWebPayments({ actor: { ...finance, role: "procurement" }, query: {} }), (error) => error.code === "FORBIDDEN");
  const result = await service.listWebPayments({ actor: finance, query: {} });
  assert.equal(result.items[0].proofLabel, "已提交凭证");
  assert.equal(result.items[0].proofCount, 1);
  assert.equal(JSON.stringify(result).includes("cloud://private"), false);
});

test("payment reads validate status, search and filter-bound cursors", async () => {
  const service = createPaymentQueryService(fakeDatabase({
    payment_records: [record("1", 1), record("2", 2, { paymentStatus: "paid", orderNo: "HIT" }), record("3", 3)],
    orders: [pendingOrder("1"), pendingOrder("3")]
  }));
  const first = await service.listWebPayments({ actor: finance, query: { pageSize: 2 } });
  assert.equal(first.hasMore, true);
  const second = await service.listWebPayments({ actor: finance, query: { pageSize: 2, cursor: first.nextCursor } });
  assert.equal(second.items.length, 1);
  assert.deepEqual((await service.listWebPayments({ actor: finance, query: { status: "paid", search: "HIT" } })).items.map((item) => item.orderNo), ["HIT"]);
  await assert.rejects(() => service.listWebPayments({ actor: finance, query: { status: "processing" } }), (error) => error.code === "PAYMENT_QUERY_INVALID");
  await assert.rejects(() => service.listWebPayments({ actor: finance, query: { cursor: first.nextCursor, status: "paid" } }), (error) => error.code === "PAYMENT_CURSOR_INVALID");
});

test("payment reads fail closed on malformed money or dates", async () => {
  for (const bad of [{ amount: 1.5 }, { amount: -1 }, { updatedAt: "invalid" }, { updatedAt: undefined }]) {
    const service = createPaymentQueryService(fakeDatabase({ payment_records: [record("bad", 1, bad)], orders: [pendingOrder("bad")] }));
    await assert.rejects(() => service.listWebPayments({ actor: finance, query: {} }), (error) => error.code === "PAYMENT_DATA_INVALID" && error.statusCode === 503);
  }
});

test("payment projection exposes only a non-negative safe-integer version with legacy zero fallback", async () => {
  const service = createPaymentQueryService(fakeDatabase({
    payment_records: [record("legacy", 1), record("versioned", 2, { version: 4 })],
    orders: [pendingOrder("legacy"), pendingOrder("versioned")]
  }));
  const result = await service.listWebPayments({ actor: finance, query: {} });
  assert.deepEqual(result.items.map((item) => [item.id, item.version]), [["versioned", 4], ["legacy", 0]]);
  assert.deepEqual(Object.keys(result.items[0]).sort(), ["amountCents", "customerMasked", "id", "orderNo", "proofCount", "proofLabel", "status", "submittedAt", "updatedAt", "version"].sort());

  const invalid = createPaymentQueryService(fakeDatabase({
    payment_records: [record("bad-version", 3, { version: -1 })],
    orders: [pendingOrder("bad-version")]
  }));
  await assert.rejects(
    () => invalid.getWebPayment({ actor: finance, id: "bad-version" }),
    (error) => error.code === "PAYMENT_DATA_INVALID" && error.statusCode === 503
  );
});

test("pending confirmation list skips stale credentials without ending a page or advancing an unsafe cursor", async () => {
  const payments = [
    record("stale-new", 5),
    record("current-new", 4),
    record("stale-middle", 3),
    record("current-middle", 2),
    record("current-old", 1)
  ];
  const orders = [
    pendingOrder("stale-new", { latestPaymentRecordId: "replacement-new" }),
    pendingOrder("current-new"),
    pendingOrder("stale-middle", { status: "paid", paymentStatus: "paid" }),
    pendingOrder("current-middle"),
    pendingOrder("current-old")
  ];
  const service = createPaymentQueryService(fakeDatabase({ payment_records: payments, orders }));

  const first = await service.listWebPayments({ actor: finance, query: { status: "pending_confirm", pageSize: 2 } });
  assert.deepEqual(first.items.map((item) => item.id), ["current-new", "current-middle"]);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = await service.listWebPayments({ actor: finance, query: { status: "pending_confirm", pageSize: 2, cursor: first.nextCursor } });
  assert.deepEqual(second.items.map((item) => item.id), ["current-old"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
});

test("stale pending detail is hidden while current pending and closed history remain readable", async () => {
  const payments = [
    record("stale", 3),
    record("current", 2),
    record("closed", 1, { paymentStatus: "paid", status: "paid", version: 2 })
  ];
  const orders = [
    pendingOrder("stale", { latestPaymentRecordId: "replacement" }),
    pendingOrder("current"),
    pendingOrder("closed", { latestPaymentRecordId: "closed", paymentStatus: "paid", status: "paid" })
  ];
  const service = createPaymentQueryService(fakeDatabase({ payment_records: payments, orders }));

  await assert.rejects(
    () => service.getWebPayment({ actor: finance, id: "stale" }),
    (error) => error.code === "PAYMENT_NOT_FOUND" && error.statusCode === 404
  );
  assert.equal((await service.getWebPayment({ actor: finance, id: "current" })).status, "pending_confirm");
  assert.equal((await service.getWebPayment({ actor: finance, id: "closed" })).status, "paid");
});

test("unfiltered lists fail closed for missing, non-current, or no-longer-pending order authority", async () => {
  const payments = [
    record("missing-order", 5),
    record("non-current", 4),
    record("closed-order", 3),
    record("current", 2),
    record("history", 1, { paymentStatus: "rejected", status: "rejected" })
  ];
  const orders = [
    pendingOrder("non-current", { latestPaymentRecordId: "replacement" }),
    pendingOrder("closed-order", { paymentStatus: "paid", status: "paid" }),
    pendingOrder("current"),
    pendingOrder("history", { paymentStatus: "unpaid", status: "approved_pending_payment" })
  ];
  const service = createPaymentQueryService(fakeDatabase({ payment_records: payments, orders }));
  const result = await service.listWebPayments({ actor: finance, query: { pageSize: 10 } });
  assert.deepEqual(result.items.map((item) => [item.id, item.status]), [["current", "pending_confirm"], ["history", "rejected"]]);
});

test("authority scanning fails closed when a raw row cannot produce a stable scan cursor", async () => {
  const rows = Array.from({ length: 99 }, (_, index) => record(`stale-${String(index).padStart(3, "0")}`, 1, {
    updatedAt: new Date("2026-07-13T00:01:00.001Z")
  }));
  rows.push(record("", 1, { updatedAt: new Date("2026-07-13T00:01:00.000Z") }));
  const service = createPaymentQueryService(fakeDatabase({ payment_records: rows }));
  await assert.rejects(
    () => service.listWebPayments({ actor: finance, query: { pageSize: 2 } }),
    (error) => error.code === "PAYMENT_DATA_INVALID" && error.statusCode === 503
  );
});

test("scan-cap cursor advances only past rows already proven stale", async () => {
  const base = Date.parse("2026-07-13T01:00:00.000Z");
  const stale = Array.from({ length: 500 }, (_, index) => record(`stale-${String(index).padStart(3, "0")}`, 1, {
    updatedAt: new Date(base - index)
  }));
  const current = record("current-after-cap", 1, { updatedAt: new Date(base - 500) });
  const service = createPaymentQueryService(fakeDatabase({
    payment_records: [...stale, current],
    orders: [pendingOrder("current-after-cap")]
  }));
  const first = await service.listWebPayments({ actor: finance, query: { status: "pending_confirm", pageSize: 2 } });
  assert.deepEqual(first.items, []);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await service.listWebPayments({ actor: finance, query: { status: "pending_confirm", pageSize: 2, cursor: first.nextCursor } });
  assert.deepEqual(second.items.map((item) => item.id), ["current-after-cap"]);
  assert.equal(second.hasMore, false);
});
