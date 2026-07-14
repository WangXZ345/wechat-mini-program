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

test("payment Web reads are role guarded and project a safe DTO", async () => {
  const service = createPaymentQueryService(fakeDatabase({ payment_records: [record("1", 1)] }));
  await assert.rejects(() => service.listWebPayments({ actor: { ...finance, role: "procurement" }, query: {} }), (error) => error.code === "FORBIDDEN");
  const result = await service.listWebPayments({ actor: finance, query: {} });
  assert.equal(result.items[0].proofLabel, "已提交凭证");
  assert.equal(result.items[0].proofCount, 1);
  assert.equal(JSON.stringify(result).includes("cloud://private"), false);
});

test("payment reads validate status, search and filter-bound cursors", async () => {
  const service = createPaymentQueryService(fakeDatabase({ payment_records: [record("1", 1), record("2", 2, { paymentStatus: "paid", orderNo: "HIT" }), record("3", 3)] }));
  const first = await service.listWebPayments({ actor: finance, query: { pageSize: 2 } });
  assert.equal(first.hasMore, true);
  const second = await service.listWebPayments({ actor: finance, query: { pageSize: 2, cursor: first.nextCursor } });
  assert.equal(second.items.length, 1);
  assert.deepEqual((await service.listWebPayments({ actor: finance, query: { status: "paid", search: "HIT" } })).items.map((item) => item.orderNo), ["HIT"]);
  await assert.rejects(() => service.listWebPayments({ actor: finance, query: { status: "processing" } }), (error) => error.code === "PAYMENT_QUERY_INVALID");
  await assert.rejects(() => service.listWebPayments({ actor: finance, query: { cursor: first.nextCursor, status: "paid" } }), (error) => error.code === "PAYMENT_CURSOR_INVALID");
});

test("payment reads fail closed on malformed money or dates", async () => {
  for (const bad of [{ amount: 1.5 }, { amount: -1 }, { updatedAt: "invalid" }]) {
    const service = createPaymentQueryService(fakeDatabase({ payment_records: [record("bad", 1, bad)] }));
    await assert.rejects(() => service.listWebPayments({ actor: finance, query: {} }), (error) => error.code === "PAYMENT_DATA_INVALID" && error.statusCode === 503);
  }
});
