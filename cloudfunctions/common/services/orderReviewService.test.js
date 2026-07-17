const test = require("node:test");
const assert = require("node:assert/strict");
const { createOrderReviewService, OrderReviewError } = require("./orderReviewService");

function service() {
  return createOrderReviewService({ db: {}, command: {} });
}

function actor(role = "customer_service", permissions = ["order:review", "order:reject"]) {
  return { id: `${role}-1`, openid: `${role}-openid`, role, status: "active", isActive: true, permissions };
}

function database(initial = {}, options = {}) {
  let state = structuredClone({ orders: [], order_items: [], products: [], customer_accounts: [], inventory_logs: [], account_logs: [], admin_operation_logs: [], sync_events: [], stock_alert_records: [], idempotency_records: [], ...initial });
  let nextId = 1;
  const command = { neq: (value) => ({ __neq: value }) };
  function match(row, where = {}) {
    return Object.entries(where).every(([key, expected]) => expected && expected.__neq !== undefined ? row[key] !== expected.__neq : row[key] === expected);
  }
  function createCollection(target, name) {
    const queryState = { where: {}, skip: 0, limit: Infinity };
    const query = {
      where(where) { queryState.where = where || {}; return query; },
      skip(skip) { queryState.skip = skip; return query; },
      limit(limit) { queryState.limit = limit; return query; },
      async get() { return { data: target[name].filter((row) => match(row, queryState.where)).slice(queryState.skip, queryState.skip + queryState.limit).map((row) => structuredClone(row)) }; },
      async add({ data }) {
        if (options.failOn && options.failOn({ operation: "add", collection: name, data })) throw new Error(`forced ${name}.add failure`);
        const row = { ...structuredClone(data), _id: data._id || `${name}-${nextId++}` };
        target[name].push(row);
        return { _id: row._id };
      },
      doc(id) {
        return {
          async get() { const row = target[name].find((item) => item._id === id); return { data: row ? structuredClone(row) : null }; },
          async update({ data }) {
            if (options.failOn && options.failOn({ operation: "update", collection: name, id, data })) throw new Error(`forced ${name}.update failure`);
            const row = target[name].find((item) => item._id === id);
            if (!row) throw new Error("document not exist");
            Object.assign(row, structuredClone(data));
            return { stats: { updated: 1 } };
          }
        };
      }
    };
    return query;
  }
  const collection = (name) => createCollection(state, name);
  const db = {
    command,
    serverDate: () => new Date("2026-07-13T00:00:00.000Z"),
    collection,
    async createCollection() {},
    async runTransaction(fn) {
      const draft = structuredClone(state);
      const result = await fn({ collection: (name) => createCollection(draft, name), command, serverDate: db.serverDate });
      state = draft;
      return result;
    },
    snapshot: () => structuredClone(state)
  };
  return { db, command };
}

function stockAlert() {
  return {
    buildStockStatusUpdate(product, { stock, now }) {
      const warningStock = Number(product.warningStock ?? 10);
      return { stock, warningStock, stockStatus: stock <= 0 ? "out_of_stock" : stock <= warningStock ? "warning" : "normal", isActive: stock > 0 || product.autoHideWhenOutOfStock !== true, updatedAt: now, lastStockCheckAt: now, autoHideWhenOutOfStock: product.autoHideWhenOutOfStock === true };
    },
    async syncStockAlertRecord() {}
  };
}

function idempotency() {
  return {
    async ensureCollection() {},
    assertIdempotencyKey(key) { if (!key) { const error = new Error("missing"); error.code = "IDEMPOTENCY_KEY_REQUIRED"; throw error; } return key; },
    async runIdempotentAction(options, execute) { return { ok: true, data: await execute() }; }
  };
}

function createReview(current, overrides = {}) {
  return createOrderReviewService({
    db: current.db,
    command: current.command,
    stockAlert: stockAlert(),
    idempotency: idempotency(),
    ownerKeyFor: (value, secret) => value && secret ? `owner:${String(value).length}:${String(secret).length}` : "",
    syncOwnerPepper: "s".repeat(32),
    ...overrides
  });
}

test("strict review input requires snapshots, a valid decision, and a Web idempotency key", () => {
  assert.throws(
    () => service().normalizeReviewInput({ id: "order-1", decision: "approve" }, { strict: true }),
    (error) => error instanceof OrderReviewError && error.code === "EXPECTED_VERSION_REQUIRED"
  );
  assert.throws(
    () => service().normalizeReviewInput({ id: "order-1", decision: "reject", expectedVersion: 2, expectedStatus: "pending_admin", reason: "" }, { strict: true }),
    (error) => error.code === "REASON_REQUIRED"
  );
  assert.throws(
    () => service().normalizeReviewInput({ id: "order-1", decision: "approve", expectedVersion: 2, expectedStatus: "pending_admin", extra: true }, { strict: true }),
    (error) => error.code === "UNKNOWN_FIELD"
  );
});

test("review actor permissions are separated for approval and rejection", () => {
  assert.throws(
    () => service().normalizeReviewActor(actor("finance", ["order:view"]), "approve"),
    (error) => error.code === "FORBIDDEN"
  );
  assert.throws(
    () => service().normalizeReviewActor(actor("customer_service", ["order:review"]), "reject"),
    (error) => error.code === "FORBIDDEN"
  );
  assert.equal(service().normalizeReviewActor(actor(), "approve").id, "customer_service-1");
});

test("review item normalization aggregates duplicate products and rejects unsafe quantities", () => {
  const normalized = service().normalizeReviewItems([
    { productId: "p-1", quantity: 2, _id: "i-1" },
    { productId: "p-1", quantity: 3, _id: "i-2" },
    { productId: "p-2", quantity: 1, _id: "i-3" }
  ]);
  assert.deepEqual(normalized.map((item) => [item.productId, item.quantity]), [["p-1", 5], ["p-2", 1]]);
  assert.throws(() => service().normalizeReviewItems([{ productId: "p-1", quantity: -1 }]), /数量/);
  assert.throws(() => service().normalizeReviewItems(Array.from({ length: 101 }, () => ({ productId: "p-1", quantity: 1 }))), /明细/);
  assert.throws(() => service().normalizeReviewItems([{ productId: "p-1", quantity: Number.MAX_SAFE_INTEGER }, { productId: "p-1", quantity: 1 }]), /数量/);
});

test("order amount normalization fails closed for negative, decimal, and unsafe values", () => {
  assert.equal(service().normalizeOrderAmount(12345), 12345);
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "12345"]) {
    assert.throws(() => service().normalizeOrderAmount(value), (error) => error.code === "ORDER_AMOUNT_INVALID");
  }
});

test("approve aggregates duplicate products, deducts once, writes account and sync effects", async () => {
  const current = database({
    orders: [{ _id: "o-1", userId: "u-1", userOpenid: "openid-1", status: "pending_admin", paymentStatus: "pending_confirm", totalAmount: 1000, version: 2 }],
    order_items: [{ _id: "i-1", orderId: "o-1", productId: "p-1", quantity: 2 }, { _id: "i-2", orderId: "o-1", productId: "p-1", quantity: 3 }],
    products: [{ _id: "p-1", stock: 8, isActive: true, warningStock: 2, version: 4 }],
    customer_accounts: [{ _id: "account-1", userId: "u-1", totalOrderAmount: 0, totalUnpaidAmount: 0, unpaidAmount: 0, orderCount: 0, unpaidOrderCount: 0 }]
  });
  const review = createReview(current);
  const result = await review.reviewOrder({ actor: actor(), input: { id: "o-1", decision: "approve", expectedVersion: 2, expectedStatus: "pending_admin" }, idempotencyKey: "review-o-1", strict: true });
  assert.equal(result.item.status, "approved_pending_payment");
  assert.equal(current.db.snapshot().products[0].stock, 3);
  assert.equal(current.db.snapshot().inventory_logs.length, 1);
  assert.equal(current.db.snapshot().inventory_logs[0].businessKey, "order_deduct:o-1:p-1");
  assert.equal(current.db.snapshot().customer_accounts[0].unpaidAmount, 1000);
  assert.equal(current.db.snapshot().sync_events.filter((event) => event.audience === "admin").length, 1);
  assert.equal(current.db.snapshot().sync_events.filter((event) => event.audience === "owner").length, 1);
});

test("reject changes only the order decision and leaves inventory/account untouched", async () => {
  const current = database({ orders: [{ _id: "o-2", userId: "u-2", status: "auto_reviewing", totalAmount: 500, version: 1 }], products: [{ _id: "p-2", stock: 9 }], customer_accounts: [{ _id: "a-2", userId: "u-2", unpaidAmount: 0 }] });
  const review = createReview(current);
  const result = await review.reviewOrder({ actor: actor(), input: { id: "o-2", decision: "reject", expectedVersion: 1, expectedStatus: "auto_reviewing", reason: "库存需复核" }, idempotencyKey: "reject-o-2", strict: true });
  assert.equal(result.item.status, "rejected");
  assert.equal(current.db.snapshot().products[0].stock, 9);
  assert.equal(current.db.snapshot().customer_accounts[0].unpaidAmount, 0);
  assert.equal(current.db.snapshot().inventory_logs.length, 0);
});

test("approval fails on version conflict or insufficient stock before writes", async () => {
  const current = database({ orders: [{ _id: "o-3", userId: "u-3", status: "pending_admin", totalAmount: 500, version: 3 }], order_items: [{ _id: "i-3", orderId: "o-3", productId: "p-3", quantity: 4 }], products: [{ _id: "p-3", stock: 2, isActive: true }] });
  const review = createReview(current);
  await assert.rejects(() => review.reviewOrder({ actor: actor(), input: { id: "o-3", decision: "approve", expectedVersion: 2, expectedStatus: "pending_admin" }, idempotencyKey: "review-o-3", strict: true }), (error) => error.code === "DATA_VERSION_CONFLICT");
  await assert.rejects(() => review.reviewOrder({ actor: actor(), input: { id: "o-3", decision: "approve", expectedVersion: 3, expectedStatus: "pending_admin" }, idempotencyKey: "review-o-3b", strict: true }), (error) => error.code === "INSUFFICIENT_STOCK");
  assert.equal(current.db.snapshot().products[0].stock, 2);
  assert.equal(current.db.snapshot().inventory_logs.length, 0);
});

test("account debt logs fail closed on duplicates or conflicts and reuse a valid prior debt", async () => {
  const base = {
    orders: [{ _id: "o-debt", userId: "u-debt", userOpenid: "openid-debt", status: "pending_admin", totalAmount: 700, version: 1 }],
    order_items: [{ _id: "i-debt", orderId: "o-debt", productId: "p-debt", quantity: 1 }],
    products: [{ _id: "p-debt", stock: 5, isActive: true, warningStock: 1, version: 1 }],
    customer_accounts: [{ _id: "a-debt", userId: "u-debt", totalOrderAmount: 700, totalReceivableAmount: 700, totalUnpaidAmount: 700, unpaidAmount: 700, orderCount: 1, unpaidOrderCount: 1 }]
  };
  const validLog = { _id: "l-debt", businessKey: "order_debt:o-debt", sourceType: "order", sourceId: "o-debt", userId: "u-debt", userOpenid: "openid-debt", relatedOrderId: "o-debt", relatedPaymentRecordId: "", changeType: "order_approved", changeAmount: 700 };
  const valid = database({ ...base, account_logs: [validLog] });
  await createReview(valid).reviewOrder({ actor: actor(), input: { id: "o-debt", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: "valid-debt", strict: true });
  assert.equal(valid.db.snapshot().customer_accounts[0].totalOrderAmount, 700);
  assert.equal(valid.db.snapshot().account_logs.length, 1);

  for (const logs of [[validLog, { ...validLog, _id: "l-debt-2" }], [{ ...validLog, changeAmount: 701 }]]) {
    const invalid = database({ ...base, account_logs: logs });
    await assert.rejects(
      () => createReview(invalid).reviewOrder({ actor: actor(), input: { id: "o-debt", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: `invalid-debt-${logs.length}`, strict: true }),
      (error) => ["ACCOUNT_LOG_DUPLICATE", "ACCOUNT_LOG_CONFLICT"].includes(error.code)
    );
    assert.equal(invalid.db.snapshot().products[0].stock, 5);
  }
});

test("account lookup falls back to userOpenid, preserves unrelated fields, and updates the legacy account contract", async () => {
  const current = database({
    orders: [{ _id: "o-account", userId: "u-new", userOpenid: "openid-existing", nickname: "订单昵称", phone: "13800000000", status: "pending_admin", totalAmount: 900, version: 1 }],
    order_items: [{ _id: "i-account", orderId: "o-account", productId: "p-account", quantity: 1 }],
    products: [{ _id: "p-account", stock: 5, isActive: true, warningStock: 1, version: 1 }],
    customer_accounts: [{ _id: "a-account", userId: "u-old", userOpenid: "openid-existing", nickname: "保留昵称", phone: "13900000000", adminNote: "保留备注", adminTags: ["重点"], riskLevel: "important", totalOrderAmount: 100, totalReceivableAmount: 100, totalUnpaidAmount: 80, unpaidAmount: 80, todayOrderAmount: 100, todayDate: "2026-07-13", orderCount: 2, unpaidOrderCount: 1 }]
  });
  await createReview(current, { now: () => new Date("2026-07-14T00:00:00.000Z") }).reviewOrder({ actor: actor(), input: { id: "o-account", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: "account-fallback", strict: true });
  const account = current.db.snapshot().customer_accounts[0];
  assert.equal(current.db.snapshot().customer_accounts.length, 1);
  assert.equal(account.adminNote, "保留备注");
  assert.deepEqual(account.adminTags, ["重点"]);
  assert.equal(account.riskLevel, "important");
  assert.equal(account.totalOrderAmount, 1000);
  assert.equal(account.totalReceivableAmount, 1000);
  assert.equal(account.totalUnpaidAmount, 980);
  assert.equal(account.unpaidAmount, 980);
  assert.equal(account.todayOrderAmount, 1000);
  assert.equal(account.todayDate, "2026-07-13");
  assert.equal(account.orderCount, 3);
  assert.equal(account.unpaidOrderCount, 2);
  assert.ok(account.lastOrderAt instanceof Date);
  assert.ok(account.updatedAt instanceof Date);
});

test("new accounts and account logs initialize the full legacy contract", async () => {
  const current = database({
    orders: [{ _id: "o-new-account", userId: "u-new-account", userOpenid: "openid-new-account", nickname: "新客户", phone: "13800001111", status: "pending_admin", totalAmount: 1200, version: 0 }],
    order_items: [{ _id: "i-new-account", orderId: "o-new-account", productId: "p-new-account", quantity: 2 }],
    products: [{ _id: "p-new-account", stock: 10, isActive: true, warningStock: 2, version: 0 }]
  });
  await createReview(current).reviewOrder({ actor: actor(), input: { id: "o-new-account", decision: "approve", expectedVersion: 0, expectedStatus: "pending_admin" }, idempotencyKey: "new-account", strict: true });
  const account = current.db.snapshot().customer_accounts[0];
  assert.deepEqual({
    nickname: account.nickname, phone: account.phone, totalPaidAmount: account.totalPaidAmount,
    historyUnpaidAmount: account.historyUnpaidAmount, pendingConfirmAmount: account.pendingConfirmAmount,
    abnormalAmount: account.abnormalAmount, abnormalCount: account.abnormalCount,
    paidOrderCount: account.paidOrderCount, partialPaidOrderCount: account.partialPaidOrderCount,
    lastPaymentAt: account.lastPaymentAt, riskLevel: account.riskLevel, isSettled: account.isSettled,
    adminRemark: account.adminRemark, adminNote: account.adminNote, adminTags: account.adminTags,
    paidAmount: account.paidAmount
  }, {
    nickname: "新客户", phone: "13800001111", totalPaidAmount: 0,
    historyUnpaidAmount: 0, pendingConfirmAmount: 0, abnormalAmount: 0, abnormalCount: 0,
    paidOrderCount: 0, partialPaidOrderCount: 0, lastPaymentAt: null, riskLevel: "normal",
    isSettled: false, adminRemark: "", adminNote: "", adminTags: [], paidAmount: 0
  });
  const log = current.db.snapshot().account_logs[0];
  for (const field of ["businessKey", "sourceType", "sourceId", "userId", "userOpenid", "relatedOrderId", "relatedPaymentRecordId", "changeType", "beforeTotalOrderAmount", "afterTotalOrderAmount", "beforeTotalPaidAmount", "afterTotalPaidAmount", "beforeTotalUnpaidAmount", "afterTotalUnpaidAmount", "changeAmount", "operatorId", "operatorOpenid", "remark", "createdAt"]) {
    assert.ok(Object.hasOwn(log, field), `missing account log field ${field}`);
  }
});

test("pending orders with accountIncluded already set fail closed instead of masquerading as a replay", async () => {
  const current = database({ orders: [{ _id: "o-inconsistent", userId: "u-1", status: "pending_admin", accountIncluded: true, totalAmount: 100, version: 1 }] });
  await assert.rejects(
    () => createReview(current).reviewOrder({ actor: actor(), input: { id: "o-inconsistent", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: "inconsistent", strict: true }),
    (error) => error.code === "ORDER_ACCOUNT_STATE_CONFLICT"
  );
});

test("approval writes safe admin, public availability, and anonymous owner outbox events", async () => {
  const current = database({
    orders: [{ _id: "o-events", userId: "u-events", userOpenid: "private-openid", phone: "13800000000", address: "private-address", status: "pending_admin", totalAmount: 4321, version: 1 }],
    order_items: [{ _id: "i-events", orderId: "o-events", productId: "p-events", quantity: 2 }],
    products: [{ _id: "p-events", stock: 2, isActive: true, autoHideWhenOutOfStock: true, warningStock: 1, version: 3 }]
  });
  await createReview(current).reviewOrder({ actor: actor(), input: { id: "o-events", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: "event-review", strict: true });
  const events = current.db.snapshot().sync_events;
  assert.ok(events.some((event) => event.eventType === "inventory.stock_adjusted" && event.audience === "admin"));
  assert.ok(events.some((event) => event.eventType === "product.availability_changed" && event.audience === "public"));
  const owner = events.find((event) => event.eventType === "order.status_changed" && event.audience === "owner");
  assert.equal(owner.ownerKey, "owner:14:32");
  assert.equal(Object.hasOwn(owner, "userOpenid"), false);
  for (const event of events) {
    for (const forbidden of ["amount", "phone", "address", "beforeStock", "afterStock", "stock"]) assert.equal(Object.hasOwn(event, forbidden), false);
  }
});

test("a mid-transaction failure rolls back order, stock, accounts, logs, and outbox", async () => {
  const current = database({
    orders: [{ _id: "o-rollback", userId: "u-rollback", userOpenid: "openid-rollback", status: "pending_admin", totalAmount: 500, version: 1 }],
    order_items: [{ _id: "i-rollback", orderId: "o-rollback", productId: "p-rollback", quantity: 1 }],
    products: [{ _id: "p-rollback", stock: 4, isActive: true, warningStock: 1, version: 1 }]
  }, { failOn: ({ operation, collection }) => operation === "add" && collection === "admin_operation_logs" });
  await assert.rejects(() => createReview(current).reviewOrder({ actor: actor(), input: { id: "o-rollback", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: "rollback", strict: true }), /forced admin_operation_logs\.add failure/);
  const state = current.db.snapshot();
  assert.equal(state.orders[0].status, "pending_admin");
  assert.equal(state.products[0].stock, 4);
  assert.equal(state.customer_accounts.length, 0);
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.account_logs.length, 0);
  assert.equal(state.sync_events.length, 0);
});

test("legacy success retains status and owner identifiers while Web can project only the safe item", async () => {
  const current = database({ orders: [{ _id: "o-legacy", userId: "u-legacy", userOpenid: "openid-legacy", status: "rejected", totalAmount: 100, version: 2 }] });
  const result = await createReview(current).reviewOrder({ actor: actor(), input: { orderId: "o-legacy", action: "reject" }, strict: false });
  assert.deepEqual({ status: result.status, userId: result.userId, userOpenid: result.userOpenid, reused: result.reused }, { status: "rejected", userId: "u-legacy", userOpenid: "openid-legacy", reused: true });
});

test("account recalculation failure keeps approval successful and retry does not repeat business writes", async () => {
  const cache = new Map();
  const replayingIdempotency = {
    async ensureCollection() {},
    assertIdempotencyKey(key) { return key; },
    async runIdempotentAction(options, execute) {
      if (!cache.has(options.idempotencyKey)) cache.set(options.idempotencyKey, { ok: true, data: await execute() });
      return cache.get(options.idempotencyKey);
    }
  };
  let recalcCalls = 0;
  const current = database({
    orders: [{ _id: "o-recalc", userId: "u-recalc", userOpenid: "openid-recalc", status: "pending_admin", totalAmount: 600, version: 1 }],
    order_items: [{ _id: "i-recalc", orderId: "o-recalc", productId: "p-recalc", quantity: 1 }],
    products: [{ _id: "p-recalc", stock: 3, isActive: true, warningStock: 1, version: 1 }]
  });
  const review = createReview(current, {
    idempotency: replayingIdempotency,
    async recalculateAccount() {
      recalcCalls += 1;
      if (recalcCalls === 1) throw new Error("internal recalc unavailable: private detail");
      if (recalcCalls === 2) return { result: { ok: false, message: "internal returned failure: private detail" } };
      return { result: { ok: true } };
    }
  });
  const command = { actor: actor(), input: { id: "o-recalc", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: "recalc", strict: true };
  const first = await review.reviewOrder(command);
  assert.equal(first.status, "approved_pending_payment");
  assert.equal(first.accountRecalculationPending, true);
  assert.equal(first.warning, "订单已审核，客户账款汇总将在稍后更新");
  assert.equal(JSON.stringify(first).includes("private detail"), false);
  assert.equal(current.db.snapshot().orders[0].status, "approved_pending_payment");
  assert.equal(current.db.snapshot().orders[0].accountRecalculationPending, true);
  assert.equal(current.db.snapshot().products[0].stock, 2);
  assert.equal(current.db.snapshot().inventory_logs.length, 1);
  assert.equal(current.db.snapshot().account_logs.length, 1);
  assert.equal(current.db.snapshot().admin_operation_logs.length, 1);
  const second = await review.reviewOrder(command);
  assert.equal(second.accountRecalculationPending, true);
  assert.equal(second.warning, "订单已审核，客户账款汇总将在稍后更新");
  assert.equal(JSON.stringify(second).includes("private detail"), false);
  assert.equal(current.db.snapshot().orders[0].accountRecalculationPending, true);
  const result = await review.reviewOrder(command);
  assert.equal(result.status, "approved_pending_payment");
  assert.equal(Object.hasOwn(result, "accountRecalculationPending"), false);
  assert.equal(Object.hasOwn(result, "warning"), false);
  assert.equal(recalcCalls, 3);
  assert.equal(current.db.snapshot().orders[0].accountRecalculationPending, false);
  assert.ok(current.db.snapshot().orders[0].accountRecalculatedAt instanceof Date);
  assert.equal(current.db.snapshot().products[0].stock, 2);
  assert.equal(current.db.snapshot().inventory_logs.length, 1);
  assert.equal(current.db.snapshot().account_logs.length, 1);
  assert.equal(current.db.snapshot().admin_operation_logs.length, 1);
});

test("a valid order deduction replay recovers even when the product is now out of stock and inactive", async () => {
  const current = database({
    orders: [{ _id: "o-replay", userId: "u-replay", userOpenid: "openid-replay", status: "pending_admin", totalAmount: 500, version: 1 }],
    order_items: [{ _id: "i-replay", orderId: "o-replay", productId: "p-replay", quantity: 1 }],
    products: [{ _id: "p-replay", stock: 0, isActive: false, autoHideWhenOutOfStock: true, warningStock: 1, version: 2 }],
    inventory_logs: [{
      _id: "inventory-replay",
      businessKey: "order_deduct:o-replay:p-replay",
      sourceType: "order",
      sourceId: "o-replay",
      relatedOrderId: "o-replay",
      productId: "p-replay",
      beforeStock: 1,
      afterStock: 0,
      changeAmount: -1
    }]
  });
  const result = await createReview(current).reviewOrder({ actor: actor(), input: { id: "o-replay", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: "replay", strict: true });
  assert.equal(result.status, "approved_pending_payment");
  assert.equal(current.db.snapshot().products[0].stock, 0);
  assert.equal(current.db.snapshot().products[0].isActive, false);
  assert.equal(current.db.snapshot().inventory_logs.length, 1);
  assert.equal(current.db.snapshot().account_logs.length, 1);
});

test("order deduction replay fails closed on duplicate or conflicting logs before current product availability", async () => {
  const baseLog = {
    businessKey: "order_deduct:o-replay-invalid:p-replay-invalid",
    sourceType: "order",
    sourceId: "o-replay-invalid",
    relatedOrderId: "o-replay-invalid",
    productId: "p-replay-invalid",
    beforeStock: 1,
    afterStock: 0,
    changeAmount: -1
  };
  for (const [logs, code] of [
    [[{ ...baseLog, _id: "log-1" }, { ...baseLog, _id: "log-2" }], "INVENTORY_LOG_DUPLICATE"],
    [[{ ...baseLog, _id: "log-conflict", changeAmount: -2 }], "INVENTORY_LOG_CONFLICT"]
  ]) {
    const current = database({
      orders: [{ _id: "o-replay-invalid", userId: "u-replay-invalid", status: "pending_admin", totalAmount: 500, version: 1 }],
      order_items: [{ _id: "i-replay-invalid", orderId: "o-replay-invalid", productId: "p-replay-invalid", quantity: 1 }],
      products: [{ _id: "p-replay-invalid", stock: 0, isActive: false, autoHideWhenOutOfStock: true, warningStock: 1, version: 2 }],
      inventory_logs: logs
    });
    await assert.rejects(
      () => createReview(current).reviewOrder({ actor: actor(), input: { id: "o-replay-invalid", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: `replay-${code}`, strict: true }),
      (error) => error.code === code
    );
    assert.equal(current.db.snapshot().orders[0].status, "pending_admin");
    assert.equal(current.db.snapshot().account_logs.length, 0);
  }
});

test("without an order deduction replay product existence, active status, and stock remain mandatory", async () => {
  for (const [products, code] of [
    [[], "PRODUCT_NOT_FOUND"],
    [[{ _id: "p-precheck", stock: 5, isActive: false }], "PRODUCT_INACTIVE"],
    [[{ _id: "p-precheck", stock: 0, isActive: true }], "INSUFFICIENT_STOCK"]
  ]) {
    const current = database({
      orders: [{ _id: "o-precheck", userId: "u-precheck", status: "pending_admin", totalAmount: 500, version: 1 }],
      order_items: [{ _id: "i-precheck", orderId: "o-precheck", productId: "p-precheck", quantity: 1 }],
      products
    });
    await assert.rejects(
      () => createReview(current).reviewOrder({ actor: actor(), input: { id: "o-precheck", decision: "approve", expectedVersion: 1, expectedStatus: "pending_admin" }, idempotencyKey: `precheck-${code}`, strict: true }),
      (error) => error.code === code
    );
    assert.equal(current.db.snapshot().inventory_logs.length, 0);
    assert.equal(current.db.snapshot().account_logs.length, 0);
  }
});

test("legacy approval without an idempotency key still retries best-effort account recalculation", async () => {
  let recalcCalls = 0;
  const current = database({
    orders: [{ _id: "o-legacy-recalc", userId: "u-legacy-recalc", userOpenid: "openid-legacy-recalc", status: "pending_admin", totalAmount: 800, version: 1 }],
    order_items: [{ _id: "i-legacy-recalc", orderId: "o-legacy-recalc", productId: "p-legacy-recalc", quantity: 2 }],
    products: [{ _id: "p-legacy-recalc", stock: 5, isActive: true, warningStock: 1, version: 1 }]
  });
  const review = createReview(current, {
    async recalculateAccount() {
      recalcCalls += 1;
      if (recalcCalls === 1) throw new Error("legacy private recalculation failure");
      if (recalcCalls === 2) return { result: { ok: false, message: "legacy private returned failure" } };
      return { result: { ok: true } };
    }
  });
  const command = { actor: actor(), input: { orderId: "o-legacy-recalc", action: "approve" }, strict: false };

  const first = await review.reviewOrder(command);
  assert.equal(first.status, "approved_pending_payment");
  assert.equal(first.accountRecalculationPending, true);
  assert.equal(first.warning, "订单已审核，客户账款汇总将在稍后更新");
  assert.equal(JSON.stringify(first).includes("private"), false);
  assert.equal(current.db.snapshot().orders[0].accountRecalculationPending, true);

  const second = await review.reviewOrder(command);
  assert.equal(second.reused, true);
  assert.equal(second.accountRecalculationPending, true);
  assert.equal(JSON.stringify(second).includes("private"), false);
  assert.equal(current.db.snapshot().orders[0].accountRecalculationPending, true);

  const third = await review.reviewOrder(command);
  assert.equal(third.reused, true);
  assert.equal(Object.hasOwn(third, "accountRecalculationPending"), false);
  assert.equal(current.db.snapshot().orders[0].accountRecalculationPending, false);
  assert.equal(recalcCalls, 3);
  assert.equal(current.db.snapshot().products[0].stock, 3);
  assert.equal(current.db.snapshot().inventory_logs.length, 1);
  assert.equal(current.db.snapshot().account_logs.length, 1);
  assert.equal(current.db.snapshot().admin_operation_logs.length, 1);
});

test("legacy rejection without an idempotency key never recalculates the account", async () => {
  let recalcCalls = 0;
  const current = database({ orders: [{ _id: "o-legacy-reject", userId: "u-legacy-reject", status: "pending_admin", totalAmount: 100, version: 1 }] });
  const review = createReview(current, { async recalculateAccount() { recalcCalls += 1; } });
  const result = await review.reviewOrder({ actor: actor(), input: { orderId: "o-legacy-reject", action: "reject", reason: "legacy reject" }, strict: false });
  assert.equal(result.status, "rejected");
  assert.equal(recalcCalls, 0);
});
