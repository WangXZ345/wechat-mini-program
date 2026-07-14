"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPaymentMutationService, PaymentMutationError } = require("./paymentMutationService");
const sharedIdempotency = require("../idempotency");

const FIXED_DATE = new Date("2026-07-14T00:00:00.000Z");

function bareService() {
  return createPaymentMutationService({ db: {} });
}

function actor(role = "finance", permissions = ["payment:confirm", "payment:update_status"], overrides = {}) {
  return {
    id: `${role}-1`,
    openid: `${role}-openid`,
    role,
    status: "active",
    isActive: true,
    permissions,
    ...overrides
  };
}

function webInput(overrides = {}) {
  return {
    paymentId: "payment-1",
    decision: "confirm",
    expectedStatus: "pending_confirm",
    expectedVersion: 2,
    expectedUpdatedAt: "2026-07-14T00:00:00.000Z",
    reason: "已核对到账",
    ...overrides
  };
}

test("Web actor requires an active finance or super_admin with the exact decision permission", () => {
  const service = bareService();
  assert.equal(service.normalizeActor(actor(), "confirm").role, "finance");
  assert.equal(service.normalizeActor(actor("super_admin", ["payment:update_status"]), "reject").role, "super_admin");
  for (const invalid of [
    actor("procurement"),
    actor("customer_service"),
    actor("finance", ["payment:update_status"]),
    actor("super_admin", ["payment:update_status"]),
    actor("finance", ["payment:confirm"], { status: "disabled", isActive: false })
  ]) {
    assert.throws(
      () => service.normalizeActor(invalid, "confirm"),
      (error) => error instanceof PaymentMutationError && ["INVALID_ACTOR", "FORBIDDEN"].includes(error.code)
    );
  }
  assert.throws(
    () => service.normalizeActor(actor("finance", ["payment:confirm"]), "reject"),
    (error) => error.code === "FORBIDDEN"
  );
});

test("strict Web input requires exact snapshots and rejects aliases, amounts, actor fields, and unknown fields", () => {
  const service = bareService();
  assert.deepEqual(service.normalizeWebInput(webInput()), webInput());

  const missingCases = [
    ["paymentId", "PAYMENT_ID_REQUIRED"],
    ["expectedStatus", "EXPECTED_STATUS_REQUIRED"],
    ["expectedVersion", "EXPECTED_VERSION_REQUIRED"],
    ["expectedUpdatedAt", "EXPECTED_UPDATED_AT_REQUIRED"]
  ];
  for (const [field, code] of missingCases) {
    const input = webInput();
    delete input[field];
    assert.throws(() => service.normalizeWebInput(input), (error) => error.code === code);
  }

  for (const [field, value] of [
    ["id", "alias"],
    ["orderId", "order-1"],
    ["paidAmount", "1.00"],
    ["paidAmountCents", 100],
    ["paymentStatus", "paid"],
    ["actor", actor()],
    ["role", "super_admin"],
    ["openid", "forged"],
    ["paymentScreenshotUrl", "cloud://secret"],
    ["unexpected", true]
  ]) {
    assert.throws(
      () => service.normalizeWebInput({ ...webInput(), [field]: value }),
      (error) => error.code === "UNKNOWN_FIELD" && error.details.field === field
    );
  }
});

test("strict Web decision, version, timestamp, and rejection reason fail closed", () => {
  const service = bareService();
  for (const [patch, code] of [
    [{ decision: "paid" }, "DECISION_INVALID"],
    [{ expectedStatus: "paid" }, "EXPECTED_STATUS_INVALID"],
    [{ expectedVersion: -1 }, "EXPECTED_VERSION_INVALID"],
    [{ expectedVersion: "2" }, "EXPECTED_VERSION_INVALID"],
    [{ expectedUpdatedAt: "yesterday" }, "EXPECTED_UPDATED_AT_INVALID"],
    [{ decision: "reject", reason: "   " }, "REASON_REQUIRED"],
    [{ decision: "reject", reason: 123 }, "REASON_INVALID"]
  ]) {
    assert.throws(() => service.normalizeWebInput(webInput(patch)), (error) => error.code === code);
  }
});

test("strict Web text fields reject non-strings and overlong values without coercion or truncation", () => {
  const service = bareService();
  for (const [patch, code] of [
    [{ paymentId: 123 }, "PAYMENT_ID_INVALID"],
    [{ paymentId: "p".repeat(129) }, "PAYMENT_ID_INVALID"],
    [{ reason: "r".repeat(301) }, "REASON_INVALID"]
  ]) {
    assert.throws(() => service.normalizeWebInput(webInput(patch)), (error) => error.code === code);
  }
});

test("legacy normalization preserves status and amount aliases without leaking them into Web", () => {
  const service = bareService();
  assert.deepEqual(
    service.normalizeLegacyInput({ orderId: "order-1", isPartial: true, paidAmount: "12.34", paymentRemark: "到账" }),
    { orderId: "order-1", paymentStatus: "partial_paid", paidAmountCents: 1234, remark: "到账", applyBatch: true, paymentMethod: "" }
  );
  assert.equal(service.normalizeLegacyInput({ orderId: "order-1", paymentStatus: "partial", paidAmount: "1234" }).paidAmountCents, 1234);
  assert.equal(service.normalizeLegacyInput({ orderId: "order-1", paymentStatus: "partial_paid", paidAmountCents: 88 }).paidAmountCents, 88);
  assert.equal(service.normalizeLegacyInput({ orderId: "order-1", paymentStatus: "partial_paid", paidAmountCents: "88" }).paidAmountCents, 88);
  assert.equal(service.normalizeLegacyInput({ orderId: "order-1", paymentStatus: "paid", paidAmount: "ignored legacy noise" }).paidAmountCents, undefined);
  for (const payload of [
    { orderId: "", paymentStatus: "paid" },
    { orderId: "order-1", paymentStatus: "settled" },
    { orderId: "order-1", paymentStatus: "partial_paid", paidAmount: "dirty" },
    { orderId: "order-1", paymentStatus: "partial_paid", paidAmountCents: 1.5 }
  ]) {
    assert.throws(() => service.normalizeLegacyInput(payload), (error) => error instanceof PaymentMutationError);
  }
});

function database(initial = {}, options = {}) {
  let state = structuredClone({
    payment_records: [],
    orders: [],
    customer_accounts: [],
    account_logs: [],
    delivery_logs: [],
    admin_operation_logs: [],
    sync_events: [],
    idempotency_records: [],
    ...initial
  });
  let nextId = 1;

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, expected]) => row[key] === expected);
  }

  function collection(target, name) {
    if (!target[name]) target[name] = [];
    const queryState = { where: {}, limit: Infinity, orderBy: null };
    const query = {
      where(where) { queryState.where = where || {}; return query; },
      limit(limit) { queryState.limit = limit; return query; },
      orderBy(field, direction) { queryState.orderBy = { field, direction }; return query; },
      async get() {
        if (options.failOn && options.failOn({ operation: "get", collection: name })) throw new Error(`forced ${name}.get failure`);
        let rows = target[name].filter((row) => matches(row, queryState.where));
        if (queryState.orderBy) {
          const { field, direction } = queryState.orderBy;
          rows = rows.slice().sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (direction === "desc" ? -1 : 1));
        }
        return { data: rows.slice(0, queryState.limit).map((row) => structuredClone(row)) };
      },
      async add({ data }) {
        if (options.failOn && options.failOn({ operation: "add", collection: name, data })) throw new Error(`forced ${name}.add failure`);
        const row = { ...structuredClone(data), _id: data._id || `${name}-${nextId++}` };
        if (target[name].some((item) => item._id === row._id)) throw new Error("duplicate key");
        target[name].push(row);
        return { _id: row._id };
      },
      doc(id) {
        return {
          async get() {
            if (options.failOn && options.failOn({ operation: "get", collection: name, id })) throw new Error(`forced ${name}.get failure`);
            const row = target[name].find((item) => item._id === id);
            return { data: row ? structuredClone(row) : null };
          },
          async update({ data }) {
            if (options.failOn && options.failOn({ operation: "update", collection: name, id, data })) throw new Error(`forced ${name}.update failure`);
            const row = target[name].find((item) => item._id === id);
            if (!row) throw new Error("document not exist");
            Object.assign(row, structuredClone(data));
            return { stats: { updated: 1 } };
          },
          async set({ data }) {
            const index = target[name].findIndex((item) => item._id === id);
            const row = { ...structuredClone(data), _id: id };
            if (index >= 0) target[name][index] = row;
            else target[name].push(row);
            return { stats: { updated: index >= 0 ? 1 : 0, created: index < 0 ? 1 : 0 } };
          }
        };
      }
    };
    return query;
  }

  const db = {
    serverDate: () => new Date(FIXED_DATE),
    collection(name) { return collection(state, name); },
    async createCollection(name) { if (!state[name]) state[name] = []; },
    async runTransaction(executor) {
      const draft = structuredClone(state);
      const tx = { collection: (name) => collection(draft, name), serverDate: db.serverDate };
      const result = await executor(tx);
      state = draft;
      return result;
    },
    snapshot: () => structuredClone(state)
  };
  return db;
}

function inMemoryIdempotency(options = {}) {
  const records = new Map();
  return {
    async ensureCollection() {},
    assertIdempotencyKey(key) {
      const normalized = String(key || "").trim();
      if (!normalized) throw new PaymentMutationError("IDEMPOTENCY_KEY_REQUIRED", "缺少操作凭证", 400);
      return normalized;
    },
    async runIdempotentAction(config, executor) {
      const recordKey = `${config.actionType}:${config.operatorIdentity}:${config.idempotencyKey}`;
      const hash = JSON.stringify(config.payload);
      const current = records.get(recordKey);
      if (current && current.hash !== hash) return { ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", message: "conflict" };
      if (current && current.status === "success") return { ok: true, data: { ...structuredClone(current.data), duplicate: true } };
      if (options.processingRecovery) {
        const recovered = await config.recoverProcessingResult();
        if (!recovered) return { ok: false, code: "IDEMPOTENCY_PROCESSING", message: "processing" };
        records.set(recordKey, { hash, status: "success", data: recovered });
        return { ok: true, data: { ...recovered, duplicate: true } };
      }
      const data = await executor();
      records.set(recordKey, { hash, status: "success", data: structuredClone(data) });
      return { ok: true, data };
    }
  };
}

function staleProcessingRecord(actionType, operatorIdentity, idempotencyKey, payload) {
  return {
    _id: sharedIdempotency.buildIdempotencyRecordId(actionType, operatorIdentity, idempotencyKey),
    actionType,
    operatorIdentity,
    idempotencyKey,
    requestHash: sharedIdempotency.hashPayload(payload),
    status: "processing",
    lockedAt: new Date("2020-01-01T00:00:00.000Z"),
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2020-01-01T00:00:00.000Z")
  };
}

function fixture(overrides = {}) {
  const payment = {
    _id: "payment-1",
    orderId: "order-1",
    orderNo: "SUBMITTED-SO-001",
    status: "pending_confirm",
    paymentStatus: "pending_confirm",
    confirmStatus: "pending",
    version: 2,
    updatedAt: new Date(FIXED_DATE),
    idempotencyKey: "proof-upload-key",
    businessKey: "proof-upload-business",
    remark: "客户提交说明",
    paidAmount: 123,
    unpaidAmount: 877,
    paymentMethod: "offline_qr",
    paymentMethodId: "method-private-id",
    paymentMethodType: "offline_qr",
    paymentMethodName: "线下二维码",
    paymentBatchId: "proof-batch",
    paymentBatchOrderIds: ["order-1"],
    paymentBatchAmount: 1000,
    paymentBatchCount: 1,
    wechatPayTransactionId: "transaction-private",
    wechatPayOutTradeNo: "trade-private",
    paymentScreenshotUrl: "cloud://private-proof",
    screenshotUrls: ["cloud://private-proof"],
    ...overrides.payment
  };
  const order = {
    _id: "order-1",
    orderNo: "SO-001",
    userId: "user-1",
    userOpenid: "openid-private",
    totalAmount: 1000,
    paidAmount: 200,
    unpaidAmount: 800,
    status: "pending_payment_confirm",
    paymentStatus: "pending_confirm",
    latestPaymentRecordId: payment._id,
    deliveryType: "shipping",
    deliveryStatus: "pending",
    version: 4,
    ...overrides.order
  };
  const account = {
    _id: "account-1",
    userId: order.userId,
    userOpenid: order.userOpenid,
    totalOrderAmount: 1000,
    totalReceivableAmount: 1000,
    totalPaidAmount: 200,
    paidAmount: 200,
    totalUnpaidAmount: 800,
    unpaidAmount: 800,
    paidOrderCount: 0,
    partialPaidOrderCount: 1,
    unpaidOrderCount: 1,
    ...overrides.account
  };
  return { payment_records: [payment], orders: [order], customer_accounts: [account], ...(overrides.state || {}) };
}

function paymentService(db, options = {}) {
  return createPaymentMutationService({
    db,
    idempotency: options.idempotency || inMemoryIdempotency(),
    ownerKeyFor: (subject, pepper) => subject && pepper ? `owner:${subject.length}:${pepper.length}` : "",
    syncOwnerPepper: "s".repeat(32),
    recalculateAccount: options.recalculateAccount,
    now: () => new Date(FIXED_DATE),
    randomId: () => "random-id"
  });
}

async function confirm(service, overrides = {}, key = "confirm-key-0001") {
  return service.reviewWebPayment({ actor: actor(), input: webInput(overrides), idempotencyKey: key });
}

test("Web confirmation calculates the unpaid cents server-side and closes the original pending record transactionally", async () => {
  let recalculated = 0;
  let recalculationContext = null;
  const db = database(fixture());
  const result = await confirm(paymentService(db, { async recalculateAccount(context) { recalculated += 1; recalculationContext = context; return { ok: true }; } }));
  const state = db.snapshot();
  assert.deepEqual(Object.keys(result).sort(), ["accountRecalculationPending", "affected", "decision", "orderNo", "paymentId", "reused", "status", "updatedAt", "updatedCount", "version"].sort());
  assert.deepEqual({ paymentId: result.paymentId, status: result.status, version: result.version, affected: result.affected, reused: result.reused, decision: result.decision, updatedCount: result.updatedCount }, { paymentId: "payment-1", status: "paid", version: 3, affected: 1, reused: false, decision: "confirm", updatedCount: 1 });
  assert.equal(state.payment_records.length, 1);
  assert.equal(state.payment_records[0].paymentScreenshotUrl, "cloud://private-proof");
  assert.equal(state.payment_records[0].confirmStatus, "confirmed");
  assert.deepEqual({
    idempotencyKey: state.payment_records[0].idempotencyKey,
    orderNo: state.payment_records[0].orderNo,
    businessKey: state.payment_records[0].businessKey,
    remark: state.payment_records[0].remark,
    paidAmount: state.payment_records[0].paidAmount,
    unpaidAmount: state.payment_records[0].unpaidAmount,
    paymentMethod: state.payment_records[0].paymentMethod,
    paymentMethodId: state.payment_records[0].paymentMethodId,
    paymentMethodType: state.payment_records[0].paymentMethodType,
    paymentMethodName: state.payment_records[0].paymentMethodName,
    paymentBatchId: state.payment_records[0].paymentBatchId,
    paymentBatchOrderIds: state.payment_records[0].paymentBatchOrderIds,
    paymentBatchAmount: state.payment_records[0].paymentBatchAmount,
    paymentBatchCount: state.payment_records[0].paymentBatchCount,
    wechatPayTransactionId: state.payment_records[0].wechatPayTransactionId,
    wechatPayOutTradeNo: state.payment_records[0].wechatPayOutTradeNo
  }, {
    idempotencyKey: "proof-upload-key",
    orderNo: "SUBMITTED-SO-001",
    businessKey: "proof-upload-business",
    remark: "客户提交说明",
    paidAmount: 123,
    unpaidAmount: 877,
    paymentMethod: "offline_qr",
    paymentMethodId: "method-private-id",
    paymentMethodType: "offline_qr",
    paymentMethodName: "线下二维码",
    paymentBatchId: "proof-batch",
    paymentBatchOrderIds: ["order-1"],
    paymentBatchAmount: 1000,
    paymentBatchCount: 1,
    wechatPayTransactionId: "transaction-private",
    wechatPayOutTradeNo: "trade-private"
  });
  assert.equal(state.payment_records[0].reviewPaidAmount, 800);
  assert.equal(state.payment_records[0].reviewUnpaidAmount, 0);
  assert.equal(state.payment_records[0].reviewPaymentMethod, "offline_qr");
  assert.equal(state.payment_records[0].reviewRemark, "已核对到账");
  assert.equal(state.payment_records[0].reviewIdempotencyKey, "confirm-key-0001");
  assert.match(state.payment_records[0].reviewBusinessKey, /^payment_mutation:/);
  assert.deepEqual({ paid: state.orders[0].paidAmount, unpaid: state.orders[0].unpaidAmount, status: state.orders[0].status, payment: state.orders[0].paymentStatus, delivery: state.orders[0].deliveryStatus, version: state.orders[0].version }, { paid: 1000, unpaid: 0, status: "paid", payment: "paid", delivery: "waiting_shipping", version: 5 });
  assert.deepEqual({ paid: state.customer_accounts[0].totalPaidAmount, unpaid: state.customer_accounts[0].totalUnpaidAmount }, { paid: 1000, unpaid: 0 });
  assert.equal(state.account_logs.length, 1);
  assert.equal(state.delivery_logs.length, 1);
  assert.equal(state.admin_operation_logs.length, 1);
  assert.equal(state.sync_events.length, 2);
  assert.deepEqual(state.sync_events.map((event) => event.audience).sort(), ["admin", "owner"]);
  for (const event of state.sync_events) {
    for (const forbidden of ["amount", "paidAmount", "unpaidAmount", "userId", "userOpenid", "openid", "paymentScreenshotUrl", "screenshotUrls", "businessKey"]) assert.equal(Object.hasOwn(event, forbidden), false);
  }
  assert.equal(recalculated, 1);
  assert.equal(recalculationContext.userId, "user-1");
  assert.equal(recalculationContext.userOpenid, "openid-private");
  assert.equal(result.accountRecalculationPending, false);
  assert.equal(state.orders[0].accountRecalculationPending, false);
  assert.deepEqual(state.orders[0].paidMarkedAt, FIXED_DATE);
});

test("strict Web confirmation rejects a positive stored amount gap instead of silently settling it", async () => {
  const db = database(fixture({ order: { totalAmount: 1000, paidAmount: 100, unpaidAmount: 800 } }));
  await assert.rejects(() => confirm(paymentService(db)), (error) => error.code === "ORDER_AMOUNT_INVALID");
  assert.equal(db.snapshot().payment_records[0].status, "pending_confirm");
});

test("post-commit reads and marker cleanup failures never turn a committed payment into an API failure", async () => {
  let failPostCommitRead = false;
  const readFailureDb = database(fixture(), {
    failOn(entry) {
      return failPostCommitRead && entry.collection === "orders" && entry.operation === "get" && entry.id === "order-1";
    }
  });
  await confirm(paymentService(readFailureDb, { idempotency: sharedIdempotency }), {}, "post-read-failure");
  failPostCommitRead = true;
  const readFailure = await confirm(paymentService(readFailureDb, { idempotency: sharedIdempotency, async recalculateAccount() { return { ok: true }; } }), {}, "post-read-failure");
  assert.equal(readFailure.status, "paid");
  assert.equal(readFailure.reused, true);
  assert.equal(readFailure.accountRecalculationPending, true);

  const markerFailureDb = database(fixture(), {
    failOn: (entry) => entry.collection === "orders" && entry.operation === "update" && entry.data && entry.data.accountRecalculationPending === false
  });
  const markerFailure = await confirm(paymentService(markerFailureDb, { async recalculateAccount() { return { ok: true }; } }), {}, "marker-failure");
  assert.equal(markerFailure.status, "paid");
  assert.equal(markerFailure.accountRecalculationPending, true);
  assert.equal(markerFailureDb.snapshot().orders[0].status, "paid");
});

test("transaction fails closed on an existing mutation audit or delivery business key", async () => {
  const auditDb = database(fixture({ state: { admin_operation_logs: [{ _id: "audit-existing", businessKey: "payment_mutation:conflicting-business-key:payment-1:confirm" }] } }));
  await assert.rejects(
    () => confirm(paymentService(auditDb), {}, "conflicting-business-key"),
    (error) => error.code === "BUSINESS_LOG_CONFLICT"
  );
  assert.equal(auditDb.snapshot().payment_records[0].status, "pending_confirm");

  const deliveryDb = database(fixture({ state: { delivery_logs: [{ _id: "delivery-existing", businessKey: "payment_delivery:payment-1:waiting_shipping" }] } }));
  await assert.rejects(
    () => confirm(paymentService(deliveryDb), {}, "conflicting-delivery-key"),
    (error) => error.code === "DELIVERY_LOG_CONFLICT"
  );
  assert.equal(deliveryDb.snapshot().payment_records[0].status, "pending_confirm");
});

test("Web rejection closes the current record without receipt, account, or delivery side effects", async () => {
  let recalculated = 0;
  const db = database(fixture());
  const service = paymentService(db, { async recalculateAccount() { recalculated += 1; } });
  const result = await service.reviewWebPayment({ actor: actor(), input: webInput({ decision: "reject", reason: "凭证不清晰" }), idempotencyKey: "reject-key-0001" });
  const state = db.snapshot();
  assert.equal(result.status, "rejected");
  assert.equal(state.payment_records[0].status, "rejected");
  assert.equal(state.payment_records[0].rejectReason, "凭证不清晰");
  assert.equal(state.orders[0].status, "approved_pending_payment");
  assert.equal(state.orders[0].paymentStatus, "unpaid");
  assert.equal(state.orders[0].paidAmount, 200);
  assert.equal(state.account_logs.length, 0);
  assert.equal(state.delivery_logs.length, 0);
  assert.equal(recalculated, 0);
});

test("legacy partial and abnormal updates preserve historical amount semantics", async () => {
  const partialDb = database(fixture());
  const partial = await paymentService(partialDb).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "partial", paidAmount: "3.00", paymentMethod: "bank_transfer", applyBatch: false }, idempotencyKey: "legacy-partial-1", allowMissingIdempotencyKey: true });
  assert.equal(partial.status, "partial_paid");
  assert.equal(partialDb.snapshot().orders[0].paidAmount, 500);
  assert.equal(partialDb.snapshot().orders[0].unpaidAmount, 500);
  assert.equal(partialDb.snapshot().account_logs[0].changeAmount, 300);
  assert.equal(partialDb.snapshot().payment_records[0].paymentMethod, "offline_qr");
  assert.equal(partialDb.snapshot().payment_records[0].reviewPaymentMethod, "bank_transfer");
  assert.equal(partialDb.snapshot().orders[0].paymentMethod, "bank_transfer");

  const abnormalDb = database(fixture());
  const abnormal = await paymentService(abnormalDb).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "abnormal", applyBatch: false }, idempotencyKey: "legacy-abnormal-1", allowMissingIdempotencyKey: true });
  assert.equal(abnormal.status, "abnormal");
  assert.equal(abnormalDb.snapshot().orders[0].paidAmount, 200);
  assert.equal(abnormalDb.snapshot().orders[0].unpaidAmount, 800);
  assert.equal(abnormalDb.snapshot().account_logs.length, 0);
});

test("legacy rejection retains the historical payment:confirm permission contract", async () => {
  const db = database(fixture());
  const confirmOnly = actor("finance", ["payment:confirm"]);
  const result = await paymentService(db).updateLegacyPayment({ actor: confirmOnly, input: { orderId: "order-1", paymentStatus: "unpaid", applyBatch: false }, idempotencyKey: "legacy-unpaid-permission", allowMissingIdempotencyKey: true });
  assert.equal(result.status, "rejected");
  await assert.rejects(
    () => paymentService(database(fixture())).reviewWebPayment({ actor: confirmOnly, input: webInput({ decision: "reject", reason: "不通过" }), idempotencyKey: "web-reject-permission" }),
    (error) => error.code === "FORBIDDEN"
  );
});

test("legacy creation retains payment method, batch, proof, transaction snapshots, and paidMarkedAt", async () => {
  const state = fixture({
    order: {
      latestPaymentRecordId: "",
      paymentMethod: "bank_transfer",
      paymentMethodId: "method-1",
      paymentMethodType: "bank",
      paymentMethodName: "银行转账",
      paymentBatchId: "batch-snapshot",
      paymentBatchOrderIds: ["order-1"],
      paymentBatchAmount: 1000,
      paymentBatchCount: 1,
      paymentScreenshotUrl: "cloud://legacy-proof",
      paymentScreenshotUrls: ["cloud://legacy-proof"],
      wechatPayTransactionId: "legacy-transaction",
      wechatPayOutTradeNo: "legacy-trade"
    },
    state: { payment_records: [] }
  });
  const db = database(state);
  const result = await paymentService(db).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "paid", applyBatch: false }, allowMissingIdempotencyKey: true });
  const payment = db.snapshot().payment_records[0];
  assert.equal(result.status, "paid");
  assert.deepEqual({
    paymentMethod: payment.paymentMethod,
    paymentMethodId: payment.paymentMethodId,
    paymentMethodType: payment.paymentMethodType,
    paymentMethodName: payment.paymentMethodName,
    paymentBatchId: payment.paymentBatchId,
    paymentBatchOrderIds: payment.paymentBatchOrderIds,
    paymentBatchAmount: payment.paymentBatchAmount,
    paymentBatchCount: payment.paymentBatchCount,
    paymentScreenshotUrl: payment.paymentScreenshotUrl,
    screenshotUrls: payment.screenshotUrls,
    wechatPayTransactionId: payment.wechatPayTransactionId,
    wechatPayOutTradeNo: payment.wechatPayOutTradeNo
  }, {
    paymentMethod: "bank_transfer",
    paymentMethodId: "method-1",
    paymentMethodType: "bank",
    paymentMethodName: "银行转账",
    paymentBatchId: "batch-snapshot",
    paymentBatchOrderIds: ["order-1"],
    paymentBatchAmount: 1000,
    paymentBatchCount: 1,
    paymentScreenshotUrl: "cloud://legacy-proof",
    screenshotUrls: ["cloud://legacy-proof"],
    wechatPayTransactionId: "legacy-transaction",
    wechatPayOutTradeNo: "legacy-trade"
  });
  assert.deepEqual(db.snapshot().orders[0].paidMarkedAt, FIXED_DATE);
});

test("stored and legacy money validation rejects zero, overpayment, decimals, negatives, and unsafe cents", async () => {
  for (const amount of [0, 801, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const db = database(fixture());
    await assert.rejects(
      () => paymentService(db).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "partial_paid", paidAmountCents: amount, applyBatch: false }, idempotencyKey: `bad-${String(amount)}`, allowMissingIdempotencyKey: true }),
      (error) => ["PAID_AMOUNT_INVALID", "PAID_AMOUNT_REQUIRED", "PAYMENT_OVERPAY"].includes(error.code)
    );
    assert.equal(db.snapshot().account_logs.length, 0);
  }
  for (const orderPatch of [
    { totalAmount: "1000" },
    { paidAmount: 1.5 },
    { unpaidAmount: -1 },
    { totalAmount: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    const db = database(fixture({ order: orderPatch }));
    await assert.rejects(() => confirm(paymentService(db)), (error) => error.code === "ORDER_AMOUNT_INVALID");
  }
});

test("Web confirmation rejects stale latest record, order state, record status, version, and timestamp", async () => {
  const cases = [
    [fixture({ order: { latestPaymentRecordId: "payment-other" } }), {}, "PAYMENT_RECORD_STALE"],
    [fixture({ order: { status: "approved_pending_payment" } }), {}, "ORDER_STATUS_CONFLICT"],
    [fixture({ order: { paymentStatus: "unpaid" } }), {}, "ORDER_STATUS_CONFLICT"],
    [fixture({ payment: { status: "paid", paymentStatus: "paid" } }), {}, "PAYMENT_STATUS_CONFLICT"],
    [fixture(), { expectedVersion: 1 }, "DATA_VERSION_CONFLICT"],
    [fixture(), { expectedUpdatedAt: "2026-07-13T00:00:00.000Z" }, "DATA_VERSION_CONFLICT"]
  ];
  for (const [state, input, code] of cases) {
    const db = database(state);
    await assert.rejects(() => confirm(paymentService(db), input), (error) => error.code === code);
    assert.equal(db.snapshot().admin_operation_logs.length, 0);
  }
});

test("idempotent replay is read-only, changed payload conflicts, and processing recovery uses one matching business log", async () => {
  const db = database(fixture());
  const service = paymentService(db);
  const first = await confirm(service, {}, "same-key-0001");
  const replay = await confirm(service, {}, "same-key-0001");
  assert.equal(first.affected, 1);
  assert.equal(replay.affected, 0);
  assert.equal(replay.reused, true);
  assert.equal(db.snapshot().account_logs.length, 1);
  await assert.rejects(() => confirm(service, { reason: "different" }, "same-key-0001"), (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT");

  const committed = database(fixture({
    payment: { status: "paid", paymentStatus: "paid", confirmStatus: "confirmed", version: 3 },
    order: { status: "paid", paymentStatus: "paid", paidAmount: 1000, unpaidAmount: 0, version: 5 },
    state: { admin_operation_logs: [{ _id: "audit-1", businessKey: "payment_mutation:recover-key-0001:payment-1:confirm", sourceId: "recover-key-0001", resourceId: "payment-1", orderId: "order-1", decision: "confirm", afterData: { status: "paid", paymentStatus: "paid", version: 3, orderStatus: "paid", orderPaymentStatus: "paid", orderVersion: 5 } }] }
  }));
  const recovered = await confirm(paymentService(committed, { idempotency: inMemoryIdempotency({ processingRecovery: true }) }), {}, "recover-key-0001");
  assert.equal(recovered.reused, true);
  assert.equal(recovered.affected, 0);
  assert.equal(committed.snapshot().account_logs.length, 0);
});

test("canonical service interoperates with the shared idempotency helper without exposing helper metadata", async () => {
  const db = database(fixture());
  const service = paymentService(db, { idempotency: sharedIdempotency });
  const first = await confirm(service, {}, "shared-idem-key-1");
  const replay = await confirm(service, {}, "shared-idem-key-1");
  assert.equal(first.affected, 1);
  assert.equal(replay.affected, 0);
  assert.equal(replay.reused, true);
  assert.equal(Object.hasOwn(replay, "duplicate"), false);
  assert.equal(Object.hasOwn(replay, "idempotencyStatus"), false);
  assert.equal(db.snapshot().account_logs.length, 1);
  assert.equal(db.snapshot().idempotency_records.length, 1);
  await assert.rejects(
    () => confirm(service, { reason: "changed" }, "shared-idem-key-1"),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT"
  );
});

test("real shared idempotency recovery validates Web audit state before returning a committed result", async () => {
  const key = "real-web-recovery-key";
  const input = webInput();
  const committed = fixture({
    payment: { status: "paid", paymentStatus: "paid", confirmStatus: "confirmed", version: 3 },
    order: { status: "paid", paymentStatus: "paid", paidAmount: 1000, unpaidAmount: 0, version: 5, accountRecalculationPending: false },
    state: {
      admin_operation_logs: [{
        _id: "audit-web-recovery",
        businessKey: `payment_mutation:${key}:payment-1:confirm`,
        sourceId: key,
        resourceId: "payment-1",
        orderId: "order-1",
        decision: "confirm",
        afterData: { status: "paid", paymentStatus: "paid", version: 3, orderStatus: "paid", orderPaymentStatus: "paid", orderVersion: 5 }
      }],
      idempotency_records: [staleProcessingRecord("payment_confirm", "finance-1", key, input)]
    }
  });
  const recoveredDb = database(committed);
  const recovered = await confirm(paymentService(recoveredDb, { idempotency: sharedIdempotency }), {}, key);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.affected, 0);
  assert.equal(recoveredDb.snapshot().admin_operation_logs.length, 1);

  const invalid = structuredClone(committed);
  invalid.admin_operation_logs[0].afterData.orderVersion = 4;
  const invalidDb = database(invalid);
  await assert.rejects(
    () => confirm(paymentService(invalidDb, { idempotency: sharedIdempotency }), {}, key),
    (error) => ["PAYMENT_STATUS_CONFLICT", "BUSINESS_LOG_CONFLICT"].includes(error.code)
  );
});

test("real shared idempotency recovers every order in a committed legacy batch", async () => {
  const key = "real-legacy-batch-recovery";
  const legacyInput = { orderId: "order-1", paymentStatus: "paid", paidAmountCents: undefined, remark: "", applyBatch: true, paymentMethod: "" };
  const orders = ["1", "2"].map((suffix) => ({
    ...fixture().orders[0],
    _id: `order-${suffix}`,
    orderNo: `SO-00${suffix}`,
    latestPaymentRecordId: `payment-${suffix}`,
    paymentBatchId: "batch-recovery",
    status: "paid",
    paymentStatus: "paid",
    paidAmount: 1000,
    unpaidAmount: 0,
    version: 5,
    accountRecalculationPending: false
  }));
  const payments = orders.map((order, index) => ({ ...fixture().payment_records[0], _id: `payment-${index + 1}`, orderId: order._id, status: "paid", paymentStatus: "paid", confirmStatus: "confirmed", version: 3 }));
  const audits = orders.map((order, index) => ({
    _id: `audit-${index + 1}`,
    businessKey: `payment_mutation:${key}:${order._id}:payment-${index + 1}:confirm`,
    sourceId: `${key}:${order._id}`,
    resourceId: `payment-${index + 1}`,
    orderId: order._id,
    decision: "confirm",
    afterData: { status: "paid", paymentStatus: "paid", version: 3, orderStatus: "paid", orderPaymentStatus: "paid", orderVersion: 5 }
  }));
  const db = database(fixture({ state: {
    orders,
    payment_records: payments,
    admin_operation_logs: audits,
    idempotency_records: [staleProcessingRecord("payment_legacy_paid", "finance-1", key, legacyInput)]
  } }));
  const result = await paymentService(db, { idempotency: sharedIdempotency }).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "paid" }, idempotencyKey: key, allowMissingIdempotencyKey: true });
  assert.equal(result.reused, true);
  assert.equal(result.updatedCount, 2);
  assert.equal(db.snapshot().admin_operation_logs.length, 2);
});

test("real shared idempotency recovers a committed legacy partial payment without applying it twice", async () => {
  const key = "real-legacy-partial-recovery";
  const legacyInput = { orderId: "order-1", paymentStatus: "partial_paid", paidAmountCents: 300, remark: "", applyBatch: false, paymentMethod: "" };
  const payment = { ...fixture().payment_records[0], status: "partial_paid", paymentStatus: "partial_paid", confirmStatus: "confirmed", version: 3 };
  const order = { ...fixture().orders[0], status: "partial_paid", paymentStatus: "partial_paid", paidAmount: 500, unpaidAmount: 500, version: 5, accountRecalculationPending: false };
  const audit = {
    _id: "audit-partial",
    businessKey: `payment_mutation:${key}:order-1:payment-1:confirm`,
    sourceId: `${key}:order-1`,
    resourceId: "payment-1",
    orderId: "order-1",
    decision: "confirm",
    afterData: { status: "partial_paid", paymentStatus: "partial_paid", version: 3, orderStatus: "partial_paid", orderPaymentStatus: "partial_paid", orderVersion: 5 }
  };
  const db = database(fixture({ state: {
    payment_records: [payment],
    orders: [order],
    admin_operation_logs: [audit],
    idempotency_records: [staleProcessingRecord("payment_legacy_partial_paid", "finance-1", key, legacyInput)]
  } }));
  const result = await paymentService(db, { idempotency: sharedIdempotency }).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "partial", paidAmountCents: 300, applyBatch: false }, idempotencyKey: key, allowMissingIdempotencyKey: true });
  assert.equal(result.reused, true);
  assert.equal(result.affected, 0);
  assert.equal(db.snapshot().orders[0].paidAmount, 500);
  assert.equal(db.snapshot().admin_operation_logs.length, 1);
});

test("customer account identity and amount invariants fail closed before receipt writes", async () => {
  const identityDb = database(fixture({ state: { customer_accounts: [{ ...fixture().customer_accounts[0], userOpenid: "other-openid" }, { ...fixture().customer_accounts[0], _id: "account-2", userId: "other-user", userOpenid: "openid-private" }] } }));
  await assert.rejects(() => confirm(paymentService(identityDb)), (error) => error.code === "ACCOUNT_IDENTITY_CONFLICT");

  for (const accountPatch of [
    { totalOrderAmount: 1000, totalPaidAmount: 100, totalUnpaidAmount: 800 },
    { totalOrderAmount: 1000, totalPaidAmount: 200, totalUnpaidAmount: 100 }
  ]) {
    const db = database(fixture({ account: accountPatch }));
    await assert.rejects(() => confirm(paymentService(db)), (error) => error.code === "ACCOUNT_AMOUNT_INVALID");
    assert.equal(db.snapshot().account_logs.length, 0);
  }
});

test("missing customer account reconstruction includes the order's already-paid balance", async () => {
  const db = database(fixture({ state: { customer_accounts: [] } }));
  await confirm(paymentService(db), {}, "account-reconstruct");
  const account = db.snapshot().customer_accounts[0];
  assert.deepEqual({ total: account.totalOrderAmount, paid: account.totalPaidAmount, unpaid: account.totalUnpaidAmount }, { total: 1000, paid: 1000, unpaid: 0 });
  const log = db.snapshot().account_logs[0];
  assert.deepEqual({ beforePaid: log.beforeTotalPaidAmount, afterPaid: log.afterTotalPaidAmount }, { beforePaid: 200, afterPaid: 1000 });
});

test("processing recovery fails closed when business logs are duplicated or conflicting", async () => {
  for (const logs of [
    [
      { _id: "audit-1", businessKey: "payment_mutation:recover-key-0002:payment-1:confirm", resourceId: "payment-1", decision: "confirm" },
      { _id: "audit-2", businessKey: "payment_mutation:recover-key-0002:payment-1:confirm", resourceId: "payment-1", decision: "confirm" }
    ],
    [{ _id: "audit-1", businessKey: "payment_mutation:recover-key-0002:payment-1:confirm", resourceId: "payment-other", decision: "reject" }]
  ]) {
    const db = database(fixture({ state: { admin_operation_logs: logs } }));
    await assert.rejects(
      () => confirm(paymentService(db, { idempotency: inMemoryIdempotency({ processingRecovery: true }) }), {}, "recover-key-0002"),
      (error) => ["BUSINESS_LOG_DUPLICATE", "BUSINESS_LOG_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(error.code)
    );
  }
});

test("failure of any transactional companion write rolls back payment, order, account, audit, and outbox", async () => {
  const failures = [
    ["payment_records", "update"],
    ["orders", "update"],
    ["customer_accounts", "update"],
    ["account_logs", "add"],
    ["delivery_logs", "add"],
    ["admin_operation_logs", "add"],
    ["sync_events", "add"]
  ];
  for (const [collection, operation] of failures) {
    const db = database(fixture(), { failOn: (entry) => entry.collection === collection && entry.operation === operation });
    await assert.rejects(() => confirm(paymentService(db), {}, `rollback-${collection}`), new RegExp(`forced ${collection}`));
    const state = db.snapshot();
    assert.equal(state.payment_records[0].status, "pending_confirm");
    assert.equal(state.orders[0].status, "pending_payment_confirm");
    assert.equal(state.customer_accounts[0].totalPaidAmount, 200);
    assert.equal(state.account_logs.length, 0);
    assert.equal(state.delivery_logs.length, 0);
    assert.equal(state.admin_operation_logs.length, 0);
    assert.equal(state.sync_events.length, 0);
  }
});

test("customer account creation and the second sync event are both inside the rollback boundary", async () => {
  const noAccountDb = database(fixture({ state: { customer_accounts: [] } }), {
    failOn: (entry) => entry.collection === "customer_accounts" && entry.operation === "add"
  });
  await assert.rejects(() => confirm(paymentService(noAccountDb), {}, "rollback-account-add"), /forced customer_accounts\.add failure/);
  assert.equal(noAccountDb.snapshot().payment_records[0].status, "pending_confirm");
  assert.equal(noAccountDb.snapshot().orders[0].status, "pending_payment_confirm");
  assert.equal(noAccountDb.snapshot().account_logs.length, 0);

  let syncAdds = 0;
  const secondSyncDb = database(fixture(), {
    failOn(entry) {
      if (entry.collection === "sync_events" && entry.operation === "add") {
        syncAdds += 1;
        return syncAdds === 2;
      }
      return false;
    }
  });
  await assert.rejects(() => confirm(paymentService(secondSyncDb), {}, "rollback-second-sync"), /forced sync_events\.add failure/);
  const state = secondSyncDb.snapshot();
  assert.equal(state.payment_records[0].status, "pending_confirm");
  assert.equal(state.orders[0].status, "pending_payment_confirm");
  assert.equal(state.customer_accounts[0].totalPaidAmount, 200);
  assert.equal(state.account_logs.length, 0);
  assert.equal(state.admin_operation_logs.length, 0);
  assert.equal(state.sync_events.length, 0);
});

test("legacy batch fails closed above 100 orders or across customers and single mode touches only one order", async () => {
  const manyOrders = Array.from({ length: 101 }, (_, index) => ({
    ...fixture().orders[0],
    _id: `order-${index}`,
    latestPaymentRecordId: `payment-${index}`,
    paymentBatchId: "batch-1"
  }));
  const manyPayments = manyOrders.map((order, index) => ({ ...fixture().payment_records[0], _id: `payment-${index}`, orderId: order._id }));
  const overLimit = database(fixture({ state: { orders: manyOrders, payment_records: manyPayments } }));
  await assert.rejects(
    () => paymentService(overLimit).updateLegacyPayment({ actor: actor(), input: { orderId: "order-0", paymentStatus: "paid" }, idempotencyKey: "batch-limit-1", allowMissingIdempotencyKey: true }),
    (error) => error.code === "PAYMENT_BATCH_LIMIT_EXCEEDED"
  );

  const otherOrder = { ...fixture().orders[0], _id: "order-2", latestPaymentRecordId: "payment-2", paymentBatchId: "batch-2", userId: "user-2" };
  const crossCustomer = database(fixture({ order: { paymentBatchId: "batch-2" }, state: { orders: [fixture({ order: { paymentBatchId: "batch-2" } }).orders[0], otherOrder], payment_records: [fixture().payment_records[0], { ...fixture().payment_records[0], _id: "payment-2", orderId: "order-2" }] } }));
  await assert.rejects(
    () => paymentService(crossCustomer).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "paid" }, idempotencyKey: "batch-cross-1", allowMissingIdempotencyKey: true }),
    (error) => error.code === "PAYMENT_BATCH_CUSTOMER_CONFLICT"
  );

  const singleDb = database(fixture({
    order: { paymentBatchId: "batch-single" },
    state: {
      orders: [fixture({ order: { paymentBatchId: "batch-single" } }).orders[0], { ...fixture().orders[0], _id: "order-2", latestPaymentRecordId: "payment-2", paymentBatchId: "batch-single" }],
      payment_records: [fixture().payment_records[0], { ...fixture().payment_records[0], _id: "payment-2", orderId: "order-2" }]
    }
  }));
  const single = await paymentService(singleDb).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "paid", applyBatch: false }, idempotencyKey: "batch-single-1", allowMissingIdempotencyKey: true });
  assert.equal(single.updatedCount, 1);
  assert.equal(singleDb.snapshot().orders.find((row) => row._id === "order-2").status, "pending_payment_confirm");
});

test("legacy batch requires stable dual customer identity and accepts exactly 100 orders", async () => {
  const emptyOrders = ["1", "2"].map((suffix) => ({ ...fixture().orders[0], _id: `order-${suffix}`, latestPaymentRecordId: `payment-${suffix}`, paymentBatchId: "batch-empty", userId: "", userOpenid: "" }));
  const emptyPayments = emptyOrders.map((order, index) => ({ ...fixture().payment_records[0], _id: `payment-${index + 1}`, orderId: order._id }));
  const emptyDb = database(fixture({ state: { orders: emptyOrders, payment_records: emptyPayments } }));
  await assert.rejects(
    () => paymentService(emptyDb).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "abnormal" }, idempotencyKey: "batch-empty-identity", allowMissingIdempotencyKey: true }),
    (error) => error.code === "PAYMENT_BATCH_IDENTITY_REQUIRED"
  );

  const crossedOrders = [
    { ...fixture().orders[0], _id: "order-1", latestPaymentRecordId: "payment-1", paymentBatchId: "batch-cross-openid" },
    { ...fixture().orders[0], _id: "order-2", latestPaymentRecordId: "payment-2", paymentBatchId: "batch-cross-openid", userOpenid: "different-openid" }
  ];
  const crossedPayments = crossedOrders.map((order, index) => ({ ...fixture().payment_records[0], _id: `payment-${index + 1}`, orderId: order._id }));
  const crossedDb = database(fixture({ state: { orders: crossedOrders, payment_records: crossedPayments } }));
  await assert.rejects(
    () => paymentService(crossedDb).updateLegacyPayment({ actor: actor(), input: { orderId: "order-1", paymentStatus: "abnormal" }, idempotencyKey: "batch-cross-openid", allowMissingIdempotencyKey: true }),
    (error) => error.code === "PAYMENT_BATCH_CUSTOMER_CONFLICT"
  );

  const boundaryOrders = Array.from({ length: 100 }, (_, index) => ({ ...fixture().orders[0], _id: `order-${index}`, latestPaymentRecordId: `payment-${index}`, paymentBatchId: "batch-100" }));
  const boundaryPayments = boundaryOrders.map((order, index) => ({ ...fixture().payment_records[0], _id: `payment-${index}`, orderId: order._id }));
  const boundaryDb = database(fixture({ state: { orders: boundaryOrders, payment_records: boundaryPayments } }));
  const result = await paymentService(boundaryDb).updateLegacyPayment({ actor: actor(), input: { orderId: "order-0", paymentStatus: "abnormal" }, idempotencyKey: "batch-boundary-100", allowMissingIdempotencyKey: true });
  assert.equal(result.updatedCount, 100);
  assert.equal(boundaryDb.snapshot().orders.filter((order) => order.status === "abnormal").length, 100);
});

test("post-commit account recalculation failure is safe and retryable while success clears the pending marker", async () => {
  const failedDb = database(fixture());
  const failed = await confirm(paymentService(failedDb, { async recalculateAccount() { throw new Error("private recalculation detail"); } }), {}, "recalc-fail-1");
  assert.equal(failed.accountRecalculationPending, true);
  assert.equal(failedDb.snapshot().orders[0].accountRecalculationPending, true);
  assert.equal(JSON.stringify(failed).includes("private"), false);

  const okDb = database(fixture());
  const ok = await confirm(paymentService(okDb, { async recalculateAccount() { return { result: { ok: true } }; } }), {}, "recalc-ok-1");
  assert.equal(ok.accountRecalculationPending, false);
  assert.equal(okDb.snapshot().orders[0].accountRecalculationPending, false);
});
