const test = require("node:test");
const assert = require("node:assert/strict");

const { createAccountQueryService } = require("./accountQueryService");

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.getTime();
}

function matches(row, condition) {
  if (!condition) return true;
  if (condition.__op === "and") return condition.values.every((value) => matches(row, value));
  if (condition.__op === "or") return condition.values.some((value) => matches(row, value));
  return Object.entries(condition).every(([key, expected]) => {
    const actual = row[key];
    if (expected && expected.__op === "lt") return comparable(actual) < comparable(expected.value);
    if (expected && expected.__op === "gt") return comparable(actual) > comparable(expected.value);
    if (expected && expected.__op === "in") return expected.values.includes(actual);
    if (expected && expected.__op === "exists") return expected.value ? actual !== undefined : actual === undefined;
    if (expected && expected.__op === "regex") return new RegExp(expected.source, expected.flags).test(String(actual || ""));
    return comparable(actual) === comparable(expected);
  });
}

function fakeDatabase(seed = {}, options = {}) {
  const reads = [];
  const command = {
    and(values) { return { __op: "and", values }; },
    or(values) { return { __op: "or", values }; },
    lt(value) { return { __op: "lt", value }; },
    gt(value) { return { __op: "gt", value }; },
    exists(value) { return { __op: "exists", value }; },
    in(values) { return { __op: "in", values }; }
  };

  class Query {
    constructor(name, rows) {
      this.name = name;
      this.rows = rows.slice();
      this.orders = [];
      this.max = Infinity;
    }
    where(condition) { this.rows = this.rows.filter((row) => matches(row, condition)); return this; }
    orderBy(field, direction) { this.orders.push([field, direction]); return this; }
    limit(value) { this.max = value; return this; }
    async get() {
      reads.push({ name: this.name, limit: this.max });
      if ((options.missing || []).includes(this.name)) throw new Error("DATABASE_COLLECTION_NOT_EXIST");
      if ((options.fail || []).includes(this.name)) throw new Error("index not found: unsafe detail omitted");
      const sorted = this.rows.slice().sort((left, right) => {
        for (const [field, direction] of this.orders) {
          const a = comparable(left[field]);
          const b = comparable(right[field]);
          if (a === b) continue;
          return (a < b ? -1 : 1) * (direction === "desc" ? -1 : 1);
        }
        return 0;
      });
      return { data: sorted.slice(0, this.max) };
    }
  }

  const db = {
    RegExp({ regexp, options: flags }) { return { __op: "regex", source: regexp, flags }; },
    collection(name) {
      const rows = Array.isArray(seed[name]) ? seed[name] : [];
      return {
        where(condition) { return new Query(name, rows).where(condition); },
        orderBy(field, direction) { return new Query(name, rows).orderBy(field, direction); },
        limit(value) { return new Query(name, rows).limit(value); },
        doc(id) {
          return {
            async get() {
              reads.push({ name, doc: id });
              if ((options.docFail || []).includes(name)) throw new Error("document not exists");
              if ((options.missing || []).includes(name)) throw new Error("DATABASE_COLLECTION_NOT_EXIST");
              if ((options.fail || []).includes(name)) throw new Error("private database failure details");
              return { data: rows.find((row) => row._id === id) || null };
            }
          };
        }
      };
    }
  };
  return { db, command, reads };
}

const finance = {
  role: "finance",
  status: "active",
  isActive: true,
  permissions: ["customer:view_account", "customer:view_basic", "customer:view_phone_masked"]
};

function account(overrides = {}) {
  return {
    _id: "account-1",
    userId: "user-1",
    nickname: "张三",
    phoneMasked: "13812345678",
    orderCount: 3,
    totalOrderAmount: 3000,
    totalPaidAmount: 1000,
    totalUnpaidAmount: 2000,
    pendingConfirmAmount: 0,
    abnormalCount: 0,
    isSettled: false,
    lastOrderAt: new Date("2026-07-12T01:00:00.000Z"),
    lastPaymentAt: new Date("2026-07-11T01:00:00.000Z"),
    createdAt: new Date("2026-07-01T01:00:00.000Z"),
    updatedAt: new Date("2026-07-13T01:00:00.000Z"),
    ...overrides
  };
}

function assertNoWebSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of [
    "openid-secret", "13812345678", "广东省深圳市完整地址", "cloud://proof",
    "transaction-secret", "内部备注", "blocked", "operator-secret", "business-secret"
  ]) assert.equal(text.includes(secret), false, `Web DTO leaked ${secret}`);
}

test("Web list requires an active finance or super_admin with explicit customer:view_account", async () => {
  const service = createAccountQueryService(fakeDatabase({ customer_accounts: [] }));
  for (const actor of [
    { ...finance, role: "customer_service" },
    { ...finance, role: "procurement" },
    { ...finance, permissions: [] },
    { ...finance, isActive: false },
    null
  ]) {
    await assert.rejects(() => service.listWebAccounts({ actor, query: {} }), (error) => error.code === "FORBIDDEN" && error.statusCode === 403);
  }
  assert.deepEqual(await service.listWebAccounts({ actor: finance, query: {} }), {
    items: [], pageSize: 20, hasMore: false, nextCursor: null
  });
  assert.deepEqual(await service.listWebAccounts({ actor: { ...finance, role: "super_admin" }, query: {} }), {
    items: [], pageSize: 20, hasMore: false, nextCursor: null
  });
});

test("Web list maps missing collections, index failures and unavailable search safely", async () => {
  for (const options of [{ missing: ["customer_accounts"] }, { fail: ["customer_accounts"] }]) {
    const service = createAccountQueryService(fakeDatabase({}, options));
    await assert.rejects(() => service.listWebAccounts({ actor: finance, query: {} }), (error) => error.code === "ACCOUNT_READ_FAILED" && error.statusCode === 503 && !/index|collection/i.test(error.message));
  }
  const database = fakeDatabase({ customer_accounts: [] });
  delete database.db.RegExp;
  await assert.rejects(
    () => createAccountQueryService(database).listWebAccounts({ actor: finance, query: { search: "张" } }),
    (error) => error.code === "ACCOUNT_READ_FAILED" && error.statusCode === 503
  );
});

test("Web list uses current cents before legacy cents and exposes four financial states", async () => {
  const rows = [
    account({ _id: "a-abnormal", updatedAt: new Date("2026-07-13T06:00:00Z"), abnormalCount: 2 }),
    account({ _id: "a-pending", updatedAt: new Date("2026-07-13T05:00:00Z"), pendingConfirmAmount: 500 }),
    account({ _id: "a-unpaid", updatedAt: new Date("2026-07-13T04:00:00Z") }),
    account({ _id: "a-settled", updatedAt: new Date("2026-07-13T03:00:00Z"), totalUnpaidAmount: 0, isSettled: true }),
    account({
      _id: "a-current-zero", updatedAt: new Date("2026-07-13T02:00:00Z"),
      totalOrderAmount: 0, totalReceivableAmount: 999,
      totalPaidAmount: 0, paidAmount: 888,
      totalUnpaidAmount: 0, unpaidAmount: 777,
      isSettled: true
    })
  ];
  const service = createAccountQueryService(fakeDatabase({ customer_accounts: rows }));
  const result = await service.listWebAccounts({ actor: finance, query: { pageSize: 10 } });
  assert.deepEqual(result.items.map((row) => row.status), ["abnormal", "pending_confirm", "unpaid", "settled", "settled"]);
  assert.deepEqual(result.items.at(-1), {
    id: "a-current-zero",
    customerMasked: "张* 138****5678",
    totalOrders: 3,
    receivableCents: 0,
    receivedCents: 0,
    unpaidAmountCents: 0,
    pendingConfirmAmountCents: 0,
    abnormalCount: 0,
    status: "settled",
    lastOrderAt: "2026-07-12T01:00:00.000Z",
    lastPaymentAt: "2026-07-11T01:00:00.000Z",
    updatedAt: "2026-07-13T02:00:00.000Z"
  });
  for (const status of ["unpaid", "pending_confirm", "abnormal", "settled"]) {
    const filtered = await service.listWebAccounts({ actor: finance, query: { status, pageSize: 10 } });
    assert.ok(filtered.items.length > 0);
    assert.ok(filtered.items.every((row) => status === "unpaid" ? row.unpaidAmountCents > 0 : status === "pending_confirm" ? row.pendingConfirmAmountCents > 0 : status === "abnormal" ? row.abnormalCount > 0 : row.status === "settled"));
  }
});

test("Web list supplements only missing display identity from users and still remasks it", async () => {
  const row = account({ nickname: "", customerName: "", phoneMasked: "", phoneNumber: undefined });
  const service = createAccountQueryService(fakeDatabase({
    customer_accounts: [row],
    users: [{ _id: "user-1", nickname: "李四", phoneNumber: "13987654321", openid: "openid-secret" }]
  }));
  const result = await service.listWebAccounts({ actor: finance, query: {} });
  assert.equal(result.items[0].customerMasked, "李* 139****4321");
  assertNoWebSecrets(result);
});

test("Web list supports only bounded whitelist search and a filter-bound stable cursor", async () => {
  const rows = [1, 2, 3, 4].map((number) => account({
    _id: `a-${number}`,
    nickname: number === 4 ? "白名单命中" : `客户${number}`,
    adminRemark: number === 3 ? "白名单命中" : "",
    updatedAt: new Date(`2026-07-13T0${number}:00:00Z`)
  }));
  const service = createAccountQueryService(fakeDatabase({ customer_accounts: rows }));
  const search = await service.listWebAccounts({ actor: finance, query: { search: "白名单命中" } });
  assert.deepEqual(search.items.map((row) => row.id), ["a-4"]);
  await assert.rejects(() => service.listWebAccounts({ actor: finance, query: { search: "x".repeat(81) } }), (error) => error.code === "ACCOUNT_QUERY_INVALID");

  const first = await service.listWebAccounts({ actor: finance, query: { pageSize: 2 } });
  assert.deepEqual(first.items.map((row) => row.id), ["a-4", "a-3"]);
  assert.equal(first.hasMore, true);
  const second = await service.listWebAccounts({ actor: finance, query: { pageSize: 2, cursor: first.nextCursor } });
  assert.deepEqual(second.items.map((row) => row.id), ["a-2", "a-1"]);
  await assert.rejects(() => service.listWebAccounts({ actor: finance, query: { pageSize: 3, cursor: first.nextCursor } }), (error) => error.code === "ACCOUNT_CURSOR_INVALID");
  await assert.rejects(() => service.listWebAccounts({ actor: finance, query: { status: "unpaid", pageSize: 2, cursor: first.nextCursor } }), (error) => error.code === "ACCOUNT_CURSOR_INVALID");
  await assert.rejects(() => service.listWebAccounts({ actor: finance, query: { cursor: "not-a-cursor" } }), (error) => error.code === "ACCOUNT_CURSOR_INVALID");
});

test("Web account projection fails closed on dirty, negative or unsafe amounts", async () => {
  for (const bad of ["100", -1, Number.MAX_SAFE_INTEGER + 1]) {
    const service = createAccountQueryService(fakeDatabase({ customer_accounts: [account({ totalUnpaidAmount: bad })] }));
    await assert.rejects(() => service.listWebAccounts({ actor: finance, query: {} }), (error) => error.code === "ACCOUNT_DATA_INVALID" && error.statusCode === 503);
  }
});

test("Web account projection rejects missing stable identity or updatedAt", async () => {
  for (const row of [account({ _id: "" }), account({ updatedAt: "not-a-date" })]) {
    const service = createAccountQueryService(fakeDatabase({ customer_accounts: [row] }));
    await assert.rejects(() => service.listWebAccounts({ actor: finance, query: {} }), (error) => error.code === "ACCOUNT_DATA_INVALID" && error.statusCode === 503);
  }
});

test("Web detail caps related orders at 50 and logs at 100 and strips sensitive fields recursively", async () => {
  const orders = Array.from({ length: 52 }, (_, index) => ({
    _id: `order-${String(index).padStart(2, "0")}`,
    userId: "user-1",
    orderNo: `NO-${index}`,
    status: "approved",
    paymentStatus: "unpaid",
    totalAmount: 100 + index,
    createdAt: new Date(Date.UTC(2026, 6, 13, 0, index)),
    userOpenid: "openid-secret",
    customerPhoneSnapshot: "13812345678",
    shippingAddressSnapshot: { detailAddress: "广东省深圳市完整地址" },
    paymentScreenshotUrl: "cloud://proof",
    transactionId: "transaction-secret",
    adminRemark: "内部备注",
    riskLevel: "blocked"
  }));
  const accountLogs = Array.from({ length: 102 }, (_, index) => ({
    _id: `log-${String(index).padStart(3, "0")}`,
    userId: "user-1",
    changeType: "payment_confirmed",
    beforeTotalOrderAmount: 3000,
    afterTotalOrderAmount: 3000,
    beforeTotalPaidAmount: index,
    afterTotalPaidAmount: index + 1,
    beforeTotalUnpaidAmount: 2000 - index,
    afterTotalUnpaidAmount: 1999 - index,
    changeAmount: -1,
    orderNo: `NO-${index}`,
    remark: "客户 138 1234 5678 已确认",
    createdAt: new Date(Date.UTC(2026, 6, 13, 0, index)),
    operatorId: "operator-secret",
    beforeData: { businessKey: "business-secret" }
  }));
  const service = createAccountQueryService(fakeDatabase({
    customer_accounts: [account({ userOpenid: "openid-secret", phone: "13812345678", adminRemark: "内部备注", riskLevel: "blocked" })],
    orders,
    account_logs: accountLogs
  }));
  const detail = await service.getWebAccount({ actor: finance, id: "account-1" });
  assert.equal(detail.orders.length, 50);
  assert.equal(detail.logs.length, 100);
  assert.equal(detail.ordersHasMore, true);
  assert.equal(detail.logsHasMore, true);
  assert.equal(detail.relatedDataStatus, "complete");
  assert.deepEqual(detail.warnings, []);
  assert.deepEqual(Object.keys(detail.orders[0]).sort(), ["createdAt", "id", "orderNo", "paymentStatus", "status", "totalAmountCents"].sort());
  assert.deepEqual(Object.keys(detail.logs[0]).sort(), [
    "afterReceivableCents", "afterReceivedCents", "afterUnpaidCents", "beforeReceivableCents",
    "beforeReceivedCents", "beforeUnpaidCents", "changeAmountCents", "changeType", "createdAt", "id", "orderNo", "summary"
  ].sort());
  assert.match(detail.logs[0].summary, /138\*\*\*\*5678/);
  assertNoWebSecrets(detail);
});

test("Web detail resolves account log orderNo from its related order without exposing identifiers", async () => {
  const service = createAccountQueryService(fakeDatabase({
    customer_accounts: [account()],
    orders: [{ _id: "order-1", userId: "user-1", orderNo: "NO-1", totalAmount: 100, createdAt: new Date("2026-07-13T01:00:00Z") }],
    account_logs: [{
      _id: "log-1", userId: "user-1", relatedOrderId: "order-1", changeType: "order_approved",
      beforeTotalOrderAmount: 0, afterTotalOrderAmount: 100,
      beforeTotalPaidAmount: 0, afterTotalPaidAmount: 0,
      beforeTotalUnpaidAmount: 0, afterTotalUnpaidAmount: 100,
      changeAmount: 100, createdAt: new Date("2026-07-13T01:00:00Z")
    }]
  }));
  const detail = await service.getWebAccount({ actor: finance, id: "account-1" });
  assert.equal(detail.logs[0].orderNo, "NO-1");
  assert.equal("relatedOrderId" in detail.logs[0], false);
});

test("Web detail returns fixed partial warnings for related read failures and safe main errors", async () => {
  const missingOrders = createAccountQueryService(fakeDatabase({ customer_accounts: [account()], account_logs: [] }, { missing: ["orders"] }));
  const partial = await missingOrders.getWebAccount({ actor: finance, id: "account-1" });
  assert.equal(partial.relatedDataStatus, "partial");
  assert.deepEqual(partial.orders, []);
  assert.deepEqual(partial.warnings, ["关联订单暂不可用"]);

  const bothMissing = createAccountQueryService(fakeDatabase({ customer_accounts: [account()] }, { missing: ["orders", "account_logs"] }));
  assert.deepEqual((await bothMissing.getWebAccount({ actor: finance, id: "account-1" })).warnings, ["关联订单暂不可用", "账款流水暂不可用"]);

  const absent = createAccountQueryService(fakeDatabase({ customer_accounts: [] }));
  await assert.rejects(() => absent.getWebAccount({ actor: finance, id: "missing" }), (error) => error.code === "ACCOUNT_NOT_FOUND" && error.statusCode === 404);
  const failed = createAccountQueryService(fakeDatabase({}, { fail: ["customer_accounts"] }));
  await assert.rejects(() => failed.getWebAccount({ actor: finance, id: "account-1" }), (error) => error.code === "ACCOUNT_READ_FAILED" && error.statusCode === 503 && !error.message.includes("private"));
});

test("legacy list preserves filters, offset paging, role-aware fields and old top-level keys", async () => {
  const rows = [
    account({ _id: "a-1", userId: "u-1", userOpenid: "o-1", todayOrderAmount: 100, updatedAt: new Date("2026-07-13T03:00:00Z") }),
    account({ _id: "a-2", userId: "u-2", userOpenid: "o-2", todayOrderAmount: 200, updatedAt: new Date("2026-07-13T02:00:00Z") }),
    account({ _id: "a-3", userId: "u-3", userOpenid: "o-3", todayOrderAmount: 300, updatedAt: new Date("2026-07-13T01:00:00Z") })
  ];
  const service = createAccountQueryService(fakeDatabase({ customer_accounts: rows, users: [] }));
  const customerService = { role: "customer_service", isActive: true, permissions: ["customer:view_basic", "customer:view_phone_masked"] };
  const result = await service.listLegacyAccounts({ actor: customerService, query: { filter: "today", sortBy: "today", page: 2, pageSize: 1 } });
  assert.deepEqual(Object.keys(result).sort(), ["accounts", "hasMore", "page", "pageSize", "total"].sort());
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 1);
  assert.equal(result.total, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.accounts[0]._id, "a-2");
  assert.equal("totalUnpaidAmount" in result.accounts[0], false);
  assert.equal("phoneNumber" in result.accounts[0], false);

  const financeResult = await service.listLegacyAccounts({ actor: finance, query: { pageSize: 1 } });
  assert.equal(financeResult.accounts[0].totalUnpaidAmount, 2000);
});

test("legacy list enriches only the requested page when keyword search is empty", async () => {
  const rows = [1, 2, 3].map((number) => account({ _id: `a-${number}`, userId: `u-${number}`, totalUnpaidAmount: 4000 - number }));
  const database = fakeDatabase({ customer_accounts: rows, users: [] });
  const service = createAccountQueryService(database);
  await service.listLegacyAccounts({ actor: finance, query: { page: 2, pageSize: 1 } });
  assert.equal(database.reads.filter((read) => read.name === "users").length, 1);
});

test("legacy phone enrichment falls back to openid when the users document lookup fails", async () => {
  const database = fakeDatabase({
    customer_accounts: [account({ userOpenid: "user-openid", phoneMasked: "" })],
    users: [{ _id: "different-id", openid: "user-openid", phoneMasked: "137****2468" }]
  }, { docFail: ["users"] });
  const result = await createAccountQueryService(database).listLegacyAccounts({ actor: finance, query: { pageSize: 1 } });
  assert.equal(result.accounts[0].phoneMasked, "137****2468");
});

test("legacy detail preserves selector support and account/orders/paymentRecords/accountLogs keys", async () => {
  const service = createAccountQueryService(fakeDatabase({
    customer_accounts: [account({ userOpenid: "openid-1" })],
    users: [],
    orders: [{ _id: "order-1", userId: "user-1", orderNo: "NO-1", totalAmount: 100, paidAmount: 20, unpaidAmount: 80, status: "approved", paymentStatus: "partial", createdAt: new Date() }],
    payment_records: [{ _id: "payment-1", userId: "user-1", orderId: "order-1", orderAmount: 100, paidAmount: 20, unpaidAmount: 80, paymentMethod: "bank", confirmStatus: "confirmed", remark: "已核对", createdAt: new Date() }],
    account_logs: [{ _id: "log-1", userId: "user-1", changeType: "payment", changeAmount: -20, remark: "付款", createdAt: new Date() }]
  }));
  const detail = await service.getLegacyAccountDetail({ actor: finance, selector: { userOpenid: "openid-1" } });
  assert.deepEqual(Object.keys(detail).sort(), ["account", "accountLogs", "orders", "paymentRecords"].sort());
  assert.equal(detail.account._id, "account-1");
  assert.equal(detail.orders[0].totalAmount, 100);
  assert.equal(detail.paymentRecords[0].paymentMethod, "bank");
  assert.equal(detail.accountLogs[0].changeType, "payment");
});
