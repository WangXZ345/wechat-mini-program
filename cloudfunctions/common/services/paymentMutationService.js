"use strict";

const crypto = require("crypto");

const PAYMENT_ROLES = new Set(["finance", "super_admin"]);
const LEGACY_STATUSES = new Set(["paid", "partial_paid", "abnormal", "unpaid"]);

class PaymentMutationError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "PaymentMutationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanText(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function normalizeActor(actor = {}, decision) {
  const id = cleanText(actor.id || actor._id || actor.openid, 128);
  const role = cleanText(actor.role, 50);
  if (!id || !role || actor.status !== "active" || actor.isActive === false) {
    throw new PaymentMutationError("INVALID_ACTOR", "管理员身份无效", 403);
  }
  if (!PAYMENT_ROLES.has(role)) throw new PaymentMutationError("FORBIDDEN", "无权执行付款审核操作", 403);
  const permission = decision === "reject" ? "payment:update_status" : "payment:confirm";
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (!permissions.includes("*") && !permissions.includes(permission)) {
    throw new PaymentMutationError("FORBIDDEN", "无权执行付款审核操作", 403);
  }
  return {
    id,
    openid: cleanText(actor.openid, 128),
    role,
    permissions: permissions.slice(),
    status: "active",
    isActive: true,
    sourceClient: actor.sourceClient === "miniprogram" ? "miniprogram" : "admin_web"
  };
}

function expectedVersion(value) {
  if (value === undefined || value === null || value === "") {
    throw new PaymentMutationError("EXPECTED_VERSION_REQUIRED", "缺少付款记录版本，请刷新后重试", 400);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PaymentMutationError("EXPECTED_VERSION_INVALID", "付款记录版本无效，请刷新后重试", 400);
  }
  return value;
}

function expectedUpdatedAt(value) {
  if (value === undefined || value === null || value === "") {
    throw new PaymentMutationError("EXPECTED_UPDATED_AT_REQUIRED", "缺少付款记录更新时间，请刷新后重试", 400);
  }
  if (typeof value !== "string") throw new PaymentMutationError("EXPECTED_UPDATED_AT_INVALID", "付款记录更新时间无效，请刷新后重试", 400);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new PaymentMutationError("EXPECTED_UPDATED_AT_INVALID", "付款记录更新时间无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeWebInput(input = {}) {
  const allowed = new Set(["paymentId", "decision", "expectedStatus", "expectedVersion", "expectedUpdatedAt", "reason"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new PaymentMutationError("UNKNOWN_FIELD", "付款审核请求包含未知字段", 400, { field: key });
  }
  if (input.paymentId === undefined || input.paymentId === null || input.paymentId === "") throw new PaymentMutationError("PAYMENT_ID_REQUIRED", "缺少付款记录 ID", 400);
  if (typeof input.paymentId !== "string" || !input.paymentId.trim() || input.paymentId.trim().length > 128) {
    throw new PaymentMutationError("PAYMENT_ID_INVALID", "付款记录 ID 格式无效", 400);
  }
  const paymentId = input.paymentId.trim();
  const decision = cleanText(input.decision, 20);
  if (!["confirm", "reject"].includes(decision)) throw new PaymentMutationError("DECISION_INVALID", "付款审核操作无效", 400);
  if (input.expectedStatus === undefined || input.expectedStatus === null || input.expectedStatus === "") {
    throw new PaymentMutationError("EXPECTED_STATUS_REQUIRED", "缺少付款当前状态，请刷新后重试", 400);
  }
  if (input.expectedStatus !== "pending_confirm") throw new PaymentMutationError("EXPECTED_STATUS_INVALID", "付款当前状态无效", 400);
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== "string") {
    throw new PaymentMutationError("REASON_INVALID", "付款审核原因格式无效", 400);
  }
  if (typeof input.reason === "string" && input.reason.length > 300) throw new PaymentMutationError("REASON_INVALID", "付款审核原因过长", 400);
  const reason = input.reason === undefined || input.reason === null ? "" : input.reason.trim();
  if (decision === "reject" && !reason) throw new PaymentMutationError("REASON_REQUIRED", "请填写驳回原因", 400);
  return {
    paymentId,
    decision,
    expectedStatus: "pending_confirm",
    expectedVersion: expectedVersion(input.expectedVersion),
    expectedUpdatedAt: expectedUpdatedAt(input.expectedUpdatedAt),
    reason
  };
}

function legacyCents(value, source) {
  if (value === undefined || value === null || value === "") return undefined;
  if (source === "paidAmountCents") {
    if ((typeof value !== "number" && typeof value !== "string") || !/^-?\d+$/.test(String(value).trim())) {
      throw new PaymentMutationError("PAID_AMOUNT_INVALID", "实收金额格式错误", 400);
    }
    const cents = Number(value);
    if (!Number.isSafeInteger(cents)) throw new PaymentMutationError("PAID_AMOUNT_INVALID", "实收金额格式错误", 400);
    return cents;
  }
  const raw = String(value).trim();
  if (!raw || !/^-?\d+(?:\.\d+)?$/.test(raw)) throw new PaymentMutationError("PAID_AMOUNT_INVALID", "实收金额格式错误", 400);
  const parsed = Number(raw.includes(".") ? Number(raw) * 100 : raw);
  if (!Number.isFinite(parsed)) throw new PaymentMutationError("PAID_AMOUNT_INVALID", "实收金额格式错误", 400);
  const rounded = Math.round(parsed);
  if (!Number.isSafeInteger(rounded)) throw new PaymentMutationError("PAID_AMOUNT_INVALID", "实收金额格式错误", 400);
  return rounded;
}

function normalizeLegacyInput(input = {}) {
  const orderId = cleanText(input.orderId, 128);
  if (!orderId) throw new PaymentMutationError("ORDER_ID_REQUIRED", "缺少订单 ID", 400);
  const requested = input.paymentStatus || (input.isPartial ? "partial_paid" : "paid");
  const paymentStatus = requested === "partial" ? "partial_paid" : cleanText(requested, 40);
  if (!LEGACY_STATUSES.has(paymentStatus)) throw new PaymentMutationError("PAYMENT_STATUS_INVALID", "付款状态无效", 400);
  const paidAmountCents = paymentStatus !== "partial_paid"
    ? undefined
    : input.paidAmountCents !== undefined && input.paidAmountCents !== null
      ? legacyCents(input.paidAmountCents, "paidAmountCents")
      : legacyCents(input.paidAmount, "paidAmount");
  return {
    orderId,
    paymentStatus,
    paidAmountCents,
    remark: cleanText(input.remark !== undefined ? input.remark : input.paymentRemark, 300),
    applyBatch: input.applyBatch !== false,
    paymentMethod: cleanText(input.paymentMethod, 80)
  };
}

function versionOf(row = {}, entity = "付款记录") {
  const value = row.version === undefined || row.version === null || row.version === "" ? 0 : row.version;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PaymentMutationError("DATA_VERSION_INVALID", `${entity}版本数据异常`, 409);
  }
  return value;
}

function storedCents(value, field) {
  const normalized = value === undefined || value === null || value === "" ? 0 : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < 0) {
    throw new PaymentMutationError("ORDER_AMOUNT_INVALID", `订单${field}数据异常`, 409);
  }
  return normalized;
}

function sameInstant(left, right) {
  const leftTime = left instanceof Date ? left.getTime() : new Date(left).getTime();
  const rightTime = right instanceof Date ? right.getTime() : new Date(right).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function deterministicId(prefix, value) {
  return `${prefix}:${crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40)}`;
}

function mutationResult(payment, order, decision, options = {}) {
  return {
    paymentId: cleanText(payment && payment._id, 128),
    orderNo: cleanText(order && order.orderNo, 100),
    status: cleanText(payment && (payment.status || payment.paymentStatus), 60),
    version: versionOf(payment || {}),
    updatedAt: payment && payment.updatedAt || null,
    affected: Number.isSafeInteger(options.affected) && options.affected > 0 ? options.affected : 0,
    reused: options.reused === true,
    decision,
    accountRecalculationPending: options.accountRecalculationPending === true,
    updatedCount: Number.isSafeInteger(options.updatedCount) && options.updatedCount > 0 ? options.updatedCount : 0
  };
}

function createPaymentMutationService({ db, idempotency, ownerKeyFor, syncOwnerPepper = "", recalculateAccount, now = () => new Date(), randomId = () => crypto.randomUUID() } = {}) {
  function assertDependencies() {
    if (!db || typeof db.runTransaction !== "function") throw new Error("payment mutation service requires db");
    if (!idempotency || typeof idempotency.assertIdempotencyKey !== "function" || typeof idempotency.runIdempotentAction !== "function") {
      throw new Error("payment mutation service requires idempotency helpers");
    }
  }

  async function ensureCollections() {
    if (!idempotency || typeof idempotency.ensureCollection !== "function") return;
    for (const name of ["payment_records", "customer_accounts", "account_logs", "delivery_logs", "admin_operation_logs", "sync_events"]) {
      await idempotency.ensureCollection(db, name);
    }
  }

  function ownerKey(order) {
    if (typeof ownerKeyFor !== "function") throw new PaymentMutationError("SYNC_OWNER_CONFIG_REQUIRED", "付款同步安全配置不完整", 503);
    const subject = cleanText(order.userOpenid || order.openid || order.userId, 256);
    const key = cleanText(ownerKeyFor(subject, syncOwnerPepper), 128);
    if (!key) throw new PaymentMutationError("SYNC_OWNER_CONFIG_REQUIRED", "付款同步安全配置不完整", 503);
    return key;
  }

  async function findAccount(tx, order) {
    const userId = cleanText(order.userId, 128);
    const userOpenid = cleanText(order.userOpenid || order.openid, 128);
    const searches = [];
    if (userId) searches.push({ userId });
    if (userOpenid) searches.push({ userOpenid });
    const found = new Map();
    for (const where of searches) {
      const response = await tx.collection("customer_accounts").where(where).limit(2).get();
      const rows = Array.isArray(response.data) ? response.data : [];
      if (rows.length > 1) throw new PaymentMutationError("ACCOUNT_DUPLICATE", "客户账款记录重复，暂不能确认付款", 409);
      if (rows[0]) found.set(rows[0]._id, rows[0]);
    }
    if (found.size > 1) throw new PaymentMutationError("ACCOUNT_IDENTITY_CONFLICT", "客户账款身份不一致，暂不能确认付款", 409);
    const account = Array.from(found.values())[0] || null;
    if (account && ((userId && account.userId && account.userId !== userId) || (userOpenid && account.userOpenid && account.userOpenid !== userOpenid))) {
      throw new PaymentMutationError("ACCOUNT_IDENTITY_CONFLICT", "客户账款身份不一致，暂不能确认付款", 409);
    }
    return account;
  }

  function buildNext(order, paymentStatus, paidAmountCents, options = {}) {
    const total = storedCents(order.totalAmount, "总金额");
    const paidBefore = storedCents(order.paidAmount, "已付金额");
    const unpaidStored = order.unpaidAmount === undefined || order.unpaidAmount === null || order.unpaidAmount === ""
      ? Math.max(total - paidBefore, 0)
      : storedCents(order.unpaidAmount, "未付金额");
    if (paidBefore > total || unpaidStored > total || paidBefore + unpaidStored > total || (options.requireExactBalance === true && paidBefore + unpaidStored !== total)) {
      throw new PaymentMutationError("ORDER_AMOUNT_INVALID", "订单金额数据不一致", 409);
    }
    if (paymentStatus === "paid") {
      if (unpaidStored <= 0) throw new PaymentMutationError("ORDER_ALREADY_PAID", "订单已结清，不能重复确认付款", 409);
      return { changeAmount: unpaidStored, paidAmount: paidBefore + unpaidStored, unpaidAmount: 0, paymentStatus: "paid", orderStatus: "paid", confirmStatus: "confirmed", changeType: "payment_confirmed" };
    }
    if (paymentStatus === "partial_paid") {
      if (paidAmountCents === undefined) throw new PaymentMutationError("PAID_AMOUNT_REQUIRED", "部分付款缺少实收金额", 400);
      if (!Number.isSafeInteger(paidAmountCents) || paidAmountCents <= 0) throw new PaymentMutationError("PAID_AMOUNT_INVALID", "部分付款的实收金额必须大于 0", 400);
      if (paidAmountCents > unpaidStored) throw new PaymentMutationError("PAYMENT_OVERPAY", "实收金额不能大于订单未付金额", 409);
      const paidAmount = paidBefore + paidAmountCents;
      const unpaidAmount = Math.max(total - paidAmount, 0);
      const settled = unpaidAmount === 0;
      return { changeAmount: paidAmountCents, paidAmount, unpaidAmount, paymentStatus: settled ? "paid" : "partial_paid", orderStatus: settled ? "paid" : "partial_paid", confirmStatus: "confirmed", changeType: settled ? "payment_confirmed" : "partial_payment_confirmed" };
    }
    if (paymentStatus === "abnormal") return { changeAmount: 0, paidAmount: paidBefore, unpaidAmount: unpaidStored, paymentStatus: "abnormal", orderStatus: "abnormal", confirmStatus: "abnormal", changeType: "payment_abnormal" };
    if (paymentStatus === "unpaid") return { changeAmount: 0, paidAmount: paidBefore, unpaidAmount: unpaidStored, paymentStatus: "unpaid", orderStatus: "approved_pending_payment", confirmStatus: "rejected", changeType: "payment_rejected" };
    throw new PaymentMutationError("PAYMENT_STATUS_INVALID", "付款状态无效", 400);
  }

  function nextDeliveryStatus(next, order) {
    if (next.paymentStatus !== "paid") return cleanText(order.deliveryStatus, 60) || "pending";
    if (order.deliveryType === "self_pickup") return "waiting_pickup";
    if (order.deliveryType === "shipping") return "waiting_shipping";
    return cleanText(order.deliveryStatus, 60) || "pending";
  }

  async function writeAccountReceipt(tx, { order, paymentId, next, actor, timestamp, reason }) {
    if (next.changeAmount <= 0) return;
    const logKey = `payment_receipt:${paymentId}:${next.changeAmount}`;
    const priorResponse = await tx.collection("account_logs").where({ businessKey: logKey }).limit(2).get();
    const prior = Array.isArray(priorResponse.data) ? priorResponse.data : [];
    if (prior.length > 1) throw new PaymentMutationError("ACCOUNT_LOG_DUPLICATE", "付款账款流水重复，暂不能继续", 409);
    if (prior[0]) throw new PaymentMutationError("ACCOUNT_LOG_CONFLICT", "付款账款流水已存在但订单状态不一致", 409);

    const account = await findAccount(tx, order);
    const beforeOrder = account
      ? storedCents(account.totalOrderAmount !== undefined ? account.totalOrderAmount : account.totalReceivableAmount, "账款总额")
      : storedCents(order.totalAmount, "总金额");
    const beforePaid = account
      ? storedCents(account.totalPaidAmount !== undefined ? account.totalPaidAmount : account.paidAmount, "账款已付金额")
      : next.paidAmount - next.changeAmount;
    const beforeUnpaid = account
      ? storedCents(account.totalUnpaidAmount !== undefined ? account.totalUnpaidAmount : account.unpaidAmount, "账款未付金额")
      : beforeOrder - beforePaid;
    if (!Number.isSafeInteger(beforePaid) || !Number.isSafeInteger(beforeUnpaid) || beforePaid < 0 || beforeUnpaid < 0 || beforePaid + beforeUnpaid !== beforeOrder || next.changeAmount > beforeUnpaid) {
      throw new PaymentMutationError("ACCOUNT_AMOUNT_INVALID", "客户账款金额不一致，暂不能确认付款", 409);
    }
    const afterPaid = beforePaid + next.changeAmount;
    const afterUnpaid = Math.max(beforeUnpaid - next.changeAmount, 0);
    if (!Number.isSafeInteger(afterPaid) || afterPaid > beforeOrder || afterPaid + afterUnpaid !== beforeOrder) throw new PaymentMutationError("ACCOUNT_AMOUNT_INVALID", "客户账款金额异常", 409);

    if (account) {
      await tx.collection("customer_accounts").doc(account._id).update({ data: {
        totalPaidAmount: afterPaid,
        paidAmount: afterPaid,
        totalUnpaidAmount: afterUnpaid,
        unpaidAmount: afterUnpaid,
        lastPaymentAt: timestamp,
        isSettled: afterUnpaid === 0,
        updatedAt: timestamp
      } });
    } else {
      await tx.collection("customer_accounts").add({ data: {
        userId: cleanText(order.userId, 128),
        userOpenid: cleanText(order.userOpenid || order.openid, 128),
        totalOrderAmount: beforeOrder,
        totalReceivableAmount: beforeOrder,
        totalPaidAmount: afterPaid,
        paidAmount: afterPaid,
        totalUnpaidAmount: afterUnpaid,
        unpaidAmount: afterUnpaid,
        lastPaymentAt: timestamp,
        isSettled: next.unpaidAmount === 0,
        createdAt: timestamp,
        updatedAt: timestamp
      } });
    }
    await tx.collection("account_logs").add({ data: {
      businessKey: logKey,
      sourceType: "payment",
      sourceId: paymentId,
      relatedOrderId: order._id,
      relatedPaymentRecordId: paymentId,
      userId: cleanText(order.userId, 128),
      userOpenid: cleanText(order.userOpenid || order.openid, 128),
      changeType: next.changeType,
      beforeTotalOrderAmount: beforeOrder,
      afterTotalOrderAmount: beforeOrder,
      beforeTotalPaidAmount: beforePaid,
      afterTotalPaidAmount: afterPaid,
      beforeTotalUnpaidAmount: beforeUnpaid,
      afterTotalUnpaidAmount: afterUnpaid,
      changeAmount: next.changeAmount,
      operatorId: actor.id,
      operatorOpenid: actor.openid,
      operatorRole: actor.role,
      remark: reason,
      createdAt: timestamp
    } });
  }

  async function writeSyncEvents(tx, { order, payment, actor, businessKey, decision, timestamp }) {
    const changedFields = ["status", "paymentStatus", "confirmStatus", "version", "updatedAt"];
    const common = {
      eventType: "payment.status_changed",
      entityType: "payment",
      entityId: payment._id,
      action: decision,
      version: versionOf(payment),
      changedFields,
      actorType: "admin",
      actorRole: actor.role,
      sourceClient: actor.sourceClient,
      createdAt: timestamp,
      expiresAt: new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000)
    };
    await tx.collection("sync_events").add({ data: { ...common, eventId: deterministicId("payment_event_owner", businessKey), audience: "owner", ownerKey: ownerKey(order) } });
    await tx.collection("sync_events").add({ data: { ...common, eventId: deterministicId("payment_event_admin", businessKey), audience: "admin" } });
  }

  async function recoverCommitted({ operationId, paymentId, decision }) {
    const businessKey = `payment_mutation:${operationId}:${paymentId}:${decision}`;
    const response = await db.collection("admin_operation_logs").where({ businessKey }).limit(2).get();
    const logs = Array.isArray(response.data) ? response.data : [];
    if (logs.length > 1) throw new PaymentMutationError("BUSINESS_LOG_DUPLICATE", "付款审核业务日志重复", 409);
    if (!logs[0]) return null;
    if (cleanText(logs[0].resourceId, 128) !== paymentId || cleanText(logs[0].decision, 20) !== decision) {
      throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核业务日志冲突", 409);
    }
    const payment = (await db.collection("payment_records").doc(paymentId).get()).data;
    if (!payment) return null;
    const order = payment.orderId ? (await db.collection("orders").doc(payment.orderId).get()).data : null;
    if (!order) return null;
    validateRecoveryLog(logs[0], payment, order, decision);
    return {
      ...mutationResult(payment, order, decision, { affected: 0, reused: true, updatedCount: 1, accountRecalculationPending: order.accountRecalculationPending === true }),
      _internal: { orderIds: [order._id], userId: cleanText(order.userId, 128), userOpenid: cleanText(order.userOpenid || order.openid, 128) }
    };
  }

  function expectedRecoveryState(decision, requestedStatus, payment) {
    if (decision === "reject") return { recordStatus: "rejected", paymentStatus: "unpaid", confirmStatus: "rejected", orderStatus: "approved_pending_payment", orderPaymentStatus: "unpaid" };
    if (decision === "abnormal") return { recordStatus: "abnormal", paymentStatus: "abnormal", confirmStatus: "abnormal", orderStatus: "abnormal", orderPaymentStatus: "abnormal" };
    if (requestedStatus === "partial_paid") {
      const current = cleanText(payment && payment.paymentStatus, 60);
      if (!["partial_paid", "paid"].includes(current)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "部分付款恢复状态无效", 409);
      return { recordStatus: current, paymentStatus: current, confirmStatus: "confirmed", orderStatus: current, orderPaymentStatus: current };
    }
    return { recordStatus: "paid", paymentStatus: "paid", confirmStatus: "confirmed", orderStatus: "paid", orderPaymentStatus: "paid" };
  }

  function validateRecoveryLog(log, payment, order, decision, requestedStatus) {
    const expected = expectedRecoveryState(decision, requestedStatus, payment);
    const after = log && log.afterData || {};
    const conflict = [
      cleanText(log && log.resourceId, 128) !== cleanText(payment._id, 128),
      cleanText(log && log.orderId, 128) !== cleanText(order._id, 128),
      cleanText(log && log.decision, 20) !== decision,
      cleanText(payment.status || payment.paymentStatus, 60) !== expected.recordStatus,
      cleanText(payment.paymentStatus, 60) !== expected.paymentStatus,
      cleanText(payment.confirmStatus, 60) !== expected.confirmStatus,
      cleanText(order.status, 60) !== expected.orderStatus,
      cleanText(order.paymentStatus, 60) !== expected.orderPaymentStatus,
      cleanText(after.status, 60) !== cleanText(payment.status || payment.paymentStatus, 60),
      cleanText(after.paymentStatus, 60) !== cleanText(payment.paymentStatus, 60),
      after.version !== versionOf(payment),
      cleanText(after.orderStatus, 60) !== cleanText(order.status, 60),
      cleanText(after.orderPaymentStatus, 60) !== cleanText(order.paymentStatus, 60),
      after.orderVersion !== versionOf(order, "订单")
    ];
    if (conflict.some(Boolean)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核业务日志与当前状态不一致", 409);
  }

  async function recoverLegacyCommitted({ operationId, input }) {
    const seed = (await db.collection("orders").doc(input.orderId).get()).data;
    if (!seed) return null;
    let orders = [seed];
    if (seed.paymentBatchId && input.applyBatch !== false && ["paid", "abnormal", "unpaid"].includes(input.paymentStatus)) {
      const response = await db.collection("orders").where({ paymentBatchId: seed.paymentBatchId }).limit(101).get();
      orders = Array.isArray(response.data) ? response.data : [];
      validateBatchIdentity(seed, orders);
    }
    if (!orders.length) return null;
    const decision = input.paymentStatus === "unpaid" ? "reject" : input.paymentStatus === "abnormal" ? "abnormal" : "confirm";
    const recovered = [];
    for (const order of orders) {
      if (!order.latestPaymentRecordId) return null;
      const payment = (await db.collection("payment_records").doc(order.latestPaymentRecordId).get()).data;
      if (!payment) return null;
      const businessKey = `payment_mutation:${operationId}:${order._id}:${payment._id}:${decision}`;
      const response = await db.collection("admin_operation_logs").where({ businessKey }).limit(2).get();
      const logs = Array.isArray(response.data) ? response.data : [];
      if (logs.length > 1) throw new PaymentMutationError("BUSINESS_LOG_DUPLICATE", "付款审核业务日志重复", 409);
      if (!logs[0]) return null;
      validateRecoveryLog(logs[0], payment, order, decision, input.paymentStatus);
      recovered.push({ payment, order });
    }
    const first = recovered[0];
    return {
      ...mutationResult(first.payment, first.order, decision, { affected: 0, reused: true, updatedCount: recovered.length, accountRecalculationPending: recovered.some((item) => item.order.accountRecalculationPending === true) }),
      _internal: { orderIds: recovered.map((item) => item.order._id), userId: cleanText(seed.userId, 128), userOpenid: cleanText(seed.userOpenid || seed.openid, 128) }
    };
  }

  async function targetOrders(tx, seedOrder, input) {
    if (!seedOrder.paymentBatchId || input.applyBatch === false || !["paid", "abnormal", "unpaid"].includes(input.paymentStatus)) return [seedOrder];
    const response = await tx.collection("orders").where({ paymentBatchId: seedOrder.paymentBatchId }).limit(101).get();
    const rows = Array.isArray(response.data) ? response.data : [];
    validateBatchIdentity(seedOrder, rows);
    const eligible = rows.filter((row) => row.paymentStatus === "pending_confirm" && row.status === "pending_payment_confirm");
    return eligible.length ? eligible : [seedOrder];
  }

  function validateBatchIdentity(seedOrder, rows) {
    if (rows.length > 100) throw new PaymentMutationError("PAYMENT_BATCH_LIMIT_EXCEEDED", "付款批次订单超过 100 条，不能批量处理", 409);
    const seedUserId = cleanText(seedOrder.userId, 128);
    const seedOpenid = cleanText(seedOrder.userOpenid || seedOrder.openid, 128);
    if (!seedUserId && !seedOpenid) throw new PaymentMutationError("PAYMENT_BATCH_IDENTITY_REQUIRED", "付款批次缺少稳定客户身份", 409);
    for (const row of rows) {
      const rowUserId = cleanText(row.userId, 128);
      const rowOpenid = cleanText(row.userOpenid || row.openid, 128);
      if ((!rowUserId && !rowOpenid) || (seedUserId && rowUserId !== seedUserId) || (seedOpenid && rowOpenid !== seedOpenid)) {
        throw new PaymentMutationError("PAYMENT_BATCH_CUSTOMER_CONFLICT", "付款批次包含不同客户，不能批量处理", 409);
      }
    }
  }

  async function mutateOne(tx, { order, payment, next, actor, decision, reason, idempotencyKey, operationId }) {
    const timestamp = db.serverDate ? db.serverDate() : now();
    const businessPaymentId = payment && payment._id || cleanText(order.latestPaymentRecordId, 128) || deterministicId("legacy_payment", `${operationId}:${order._id}`);
    const businessKey = `payment_mutation:${operationId}:${businessPaymentId}:${decision}`;
    const priorAuditResponse = await tx.collection("admin_operation_logs").where({ businessKey }).limit(2).get();
    const priorAudits = Array.isArray(priorAuditResponse.data) ? priorAuditResponse.data : [];
    if (priorAudits.length > 1) throw new PaymentMutationError("BUSINESS_LOG_DUPLICATE", "付款审核业务日志重复", 409);
    if (priorAudits[0]) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核业务日志已存在但付款状态不一致", 409);
    const paymentVersion = versionOf(payment || {});
    const recordStatus = decision === "reject" || next.confirmStatus === "rejected" ? "rejected" : next.paymentStatus;
    const reviewData = {
      status: recordStatus,
      paymentStatus: next.paymentStatus,
      confirmStatus: next.confirmStatus,
      reviewPaidAmount: next.changeAmount,
      reviewUnpaidAmount: next.unpaidAmount,
      reviewPaymentMethod: cleanText(next.paymentMethod || order.paymentMethod, 80),
      confirmedBy: actor.id,
      confirmedAt: timestamp,
      rejectReason: next.confirmStatus === "rejected" ? reason : "",
      reviewRemark: reason,
      reviewIdempotencyKey: idempotencyKey || "",
      reviewBusinessKey: businessKey,
      version: paymentVersion + 1,
      updatedAt: timestamp
    };
    let paymentId = businessPaymentId;
    let nextPayment;
    if (payment) {
      await tx.collection("payment_records").doc(payment._id).update({ data: reviewData });
      nextPayment = { ...payment, ...reviewData, _id: payment._id };
    } else {
      const createData = {
        ...reviewData,
        _id: businessPaymentId,
        orderId: order._id,
        orderNo: cleanText(order.orderNo, 100),
        userId: cleanText(order.userId, 128),
        userOpenid: cleanText(order.userOpenid || order.openid, 128),
        orderAmount: storedCents(order.totalAmount, "总金额"),
        paidAmount: next.changeAmount,
        unpaidAmount: next.unpaidAmount,
        paymentMethod: cleanText(next.paymentMethod || order.paymentMethod, 80),
        paymentMethodId: cleanText(order.paymentMethodId, 128),
        paymentMethodType: cleanText(order.paymentMethodType, 80),
        paymentMethodName: cleanText(order.paymentMethodName || next.paymentMethod || order.paymentMethod, 120),
        paymentBatchId: cleanText(order.paymentBatchId, 128),
        paymentBatchOrderIds: Array.isArray(order.paymentBatchOrderIds) ? order.paymentBatchOrderIds.slice(0, 100) : [],
        paymentBatchAmount: storedCents(order.paymentBatchAmount, "付款批次金额"),
        paymentBatchCount: storedCents(order.paymentBatchCount, "付款批次数量"),
        paymentScreenshotUrl: order.paymentScreenshotUrl || "",
        screenshotUrls: Array.isArray(order.paymentScreenshotUrls) ? order.paymentScreenshotUrls.slice() : order.paymentScreenshotUrl ? [order.paymentScreenshotUrl] : [],
        wechatPayTransactionId: cleanText(order.wechatPayTransactionId, 160),
        wechatPayOutTradeNo: cleanText(order.wechatPayOutTradeNo, 160),
        idempotencyKey: idempotencyKey || "",
        businessKey,
        remark: reason,
        createdAt: timestamp
      };
      const created = await tx.collection("payment_records").add({ data: createData });
      paymentId = created._id || businessPaymentId;
      nextPayment = { ...createData, _id: paymentId };
    }

    await writeAccountReceipt(tx, { order, paymentId, next, actor, timestamp, reason });
    const deliveryStatus = nextDeliveryStatus(next, order);
    const nextOrder = {
      ...order,
      latestPaymentRecordId: paymentId,
      paymentStatus: next.paymentStatus,
      status: next.orderStatus,
      deliveryStatus,
      paidAmount: next.paidAmount,
      unpaidAmount: next.unpaidAmount,
      paymentMethod: cleanText(next.paymentMethod || order.paymentMethod, 80),
      paymentConfirmedAt: next.confirmStatus === "confirmed" ? timestamp : order.paymentConfirmedAt || null,
      paymentConfirmedBy: next.confirmStatus === "confirmed" ? actor.id : order.paymentConfirmedBy || "",
      paymentRemark: reason,
      paidMarkedAt: next.confirmStatus === "confirmed" ? timestamp : order.paidMarkedAt || null,
      accountRecalculationPending: next.changeAmount > 0,
      version: versionOf(order, "订单") + 1,
      updatedAt: timestamp
    };
    await tx.collection("orders").doc(order._id).update({ data: {
      latestPaymentRecordId: nextOrder.latestPaymentRecordId,
      paymentStatus: nextOrder.paymentStatus,
      status: nextOrder.status,
      deliveryStatus: nextOrder.deliveryStatus,
      paidAmount: nextOrder.paidAmount,
      unpaidAmount: nextOrder.unpaidAmount,
      paymentMethod: nextOrder.paymentMethod,
      paymentConfirmedAt: nextOrder.paymentConfirmedAt,
      paymentConfirmedBy: nextOrder.paymentConfirmedBy,
      paymentRemark: nextOrder.paymentRemark,
      paidMarkedAt: nextOrder.paidMarkedAt,
      accountRecalculationPending: nextOrder.accountRecalculationPending,
      version: nextOrder.version,
      updatedAt: nextOrder.updatedAt
    } });
    if ((cleanText(order.deliveryStatus, 60) || "pending") !== deliveryStatus) {
      const deliveryBusinessKey = `payment_delivery:${paymentId}:${deliveryStatus}`;
      const priorDeliveryResponse = await tx.collection("delivery_logs").where({ businessKey: deliveryBusinessKey }).limit(2).get();
      const priorDeliveries = Array.isArray(priorDeliveryResponse.data) ? priorDeliveryResponse.data : [];
      if (priorDeliveries.length > 1) throw new PaymentMutationError("DELIVERY_LOG_DUPLICATE", "付款配送流水重复，暂不能继续", 409);
      if (priorDeliveries[0]) throw new PaymentMutationError("DELIVERY_LOG_CONFLICT", "付款配送流水已存在但订单状态不一致", 409);
      await tx.collection("delivery_logs").add({ data: {
        businessKey: deliveryBusinessKey,
        orderId: order._id,
        orderNo: cleanText(order.orderNo, 100),
        deliveryType: cleanText(order.deliveryType, 40),
        beforeStatus: cleanText(order.deliveryStatus, 60) || "pending",
        afterStatus: deliveryStatus,
        action: "payment_confirmed",
        operatorId: actor.id,
        operatorOpenid: actor.openid,
        createdAt: timestamp
      } });
    }
    await tx.collection("admin_operation_logs").add({ data: {
      businessKey,
      sourceId: operationId,
      idempotencyKey: idempotencyKey || "",
      action: decision === "reject" ? "payment_reject" : "payment_confirm",
      decision,
      resourceType: "payment",
      resourceId: paymentId,
      orderId: order._id,
      beforeData: { status: payment && (payment.status || payment.paymentStatus) || "", version: paymentVersion },
      afterData: { status: nextPayment.status, paymentStatus: nextPayment.paymentStatus, version: nextPayment.version, orderStatus: nextOrder.status, orderPaymentStatus: nextOrder.paymentStatus, orderVersion: nextOrder.version },
      operatorId: actor.id,
      operatorOpenid: actor.openid,
      operatorRole: actor.role,
      reason,
      status: "success",
      createdAt: timestamp
    } });
    await writeSyncEvents(tx, { order: nextOrder, payment: nextPayment, actor, businessKey, decision, timestamp });
    return { payment: nextPayment, order: nextOrder };
  }

  async function executeWeb({ actor, input, idempotencyKey, operationId }) {
    return db.runTransaction(async (tx) => {
      const payment = (await tx.collection("payment_records").doc(input.paymentId).get()).data;
      if (!payment) throw new PaymentMutationError("PAYMENT_NOT_FOUND", "付款记录不存在", 404);
      if ((payment.status || payment.paymentStatus) !== "pending_confirm") throw new PaymentMutationError("PAYMENT_STATUS_CONFLICT", "付款记录状态已变化，请刷新后重试", 409);
      if (versionOf(payment) !== input.expectedVersion || !sameInstant(payment.updatedAt, input.expectedUpdatedAt)) throw new PaymentMutationError("DATA_VERSION_CONFLICT", "付款记录已变化，请刷新后重试", 409);
      const order = payment.orderId ? (await tx.collection("orders").doc(payment.orderId).get()).data : null;
      if (!order) throw new PaymentMutationError("ORDER_NOT_FOUND", "关联订单不存在", 404);
      if (order.latestPaymentRecordId !== payment._id) throw new PaymentMutationError("PAYMENT_RECORD_STALE", "付款凭证已不是订单当前凭证，请刷新后重试", 409);
      if (order.paymentStatus !== "pending_confirm" || order.status !== "pending_payment_confirm") throw new PaymentMutationError("ORDER_STATUS_CONFLICT", "订单付款状态已变化，请刷新后重试", 409);
      const legacyStatus = input.decision === "reject" ? "unpaid" : "paid";
      const next = { ...buildNext(order, legacyStatus, undefined, { requireExactBalance: true }), paymentMethod: cleanText(order.paymentMethod || payment.paymentMethod, 80) };
      const updated = await mutateOne(tx, { order, payment, next, actor, decision: input.decision, reason: input.reason, idempotencyKey, operationId });
      return {
        ...mutationResult(updated.payment, updated.order, input.decision, { affected: 1, reused: false, updatedCount: 1, accountRecalculationPending: next.changeAmount > 0 }),
        _internal: { orderIds: [order._id], userId: cleanText(order.userId, 128), userOpenid: cleanText(order.userOpenid || order.openid, 128) }
      };
    });
  }

  async function executeLegacy({ actor, input, idempotencyKey, operationId }) {
    return db.runTransaction(async (tx) => {
      const seed = (await tx.collection("orders").doc(input.orderId).get()).data;
      if (!seed) throw new PaymentMutationError("ORDER_NOT_FOUND", "订单不存在", 404);
      const orders = await targetOrders(tx, seed, input);
      const updated = [];
      for (const order of orders) {
        let payment = null;
        if (order.latestPaymentRecordId) payment = (await tx.collection("payment_records").doc(order.latestPaymentRecordId).get()).data;
        if (input.paymentStatus === "paid" && (order.paymentStatus === "paid" || order.status === "paid")) {
          if (!payment) throw new PaymentMutationError("PAYMENT_NOT_FOUND", "付款记录不存在", 404);
          updated.push({ payment, order, reused: true });
          continue;
        }
        if (input.paymentStatus === "unpaid" && order.paymentStatus === "unpaid" && order.status === "approved_pending_payment") {
          if (!payment) throw new PaymentMutationError("PAYMENT_NOT_FOUND", "付款记录不存在", 404);
          updated.push({ payment, order, reused: true });
          continue;
        }
        const next = { ...buildNext(order, input.paymentStatus, input.paidAmountCents), paymentMethod: input.paymentMethod || cleanText(order.paymentMethod, 80) };
        updated.push(await mutateOne(tx, { order, payment, next, actor, decision: input.paymentStatus === "unpaid" ? "reject" : input.paymentStatus === "abnormal" ? "abnormal" : "confirm", reason: input.remark, idempotencyKey, operationId: `${operationId}:${order._id}` }));
      }
      const first = updated[0];
      const decision = input.paymentStatus === "unpaid" ? "reject" : input.paymentStatus === "abnormal" ? "abnormal" : "confirm";
      return {
        ...mutationResult(first.payment, first.order, decision, { affected: updated.filter((item) => !item.reused).length, reused: updated.every((item) => item.reused), updatedCount: updated.length, accountRecalculationPending: updated.some((item) => item.order.accountRecalculationPending === true) }),
        _internal: { orderIds: updated.map((item) => item.order._id), userId: cleanText(seed.userId, 128), userOpenid: cleanText(seed.userOpenid || seed.openid, 128) }
      };
    });
  }

  function throwIdempotencyOutcome(outcome) {
    const code = cleanText(outcome && outcome.code, 80) || "IDEMPOTENCY_FAILED";
    const statusCode = ["IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400;
    throw new PaymentMutationError(code, cleanText(outcome && outcome.message, 240) || "付款操作未完成", statusCode);
  }

  function safePublicResult(result) {
    return mutationResult(
      { _id: result.paymentId, status: result.status, version: result.version, updatedAt: result.updatedAt },
      { orderNo: result.orderNo },
      result.decision,
      { affected: result.affected, reused: result.reused, updatedCount: result.updatedCount, accountRecalculationPending: result.accountRecalculationPending }
    );
  }

  async function postCommitRecalculation(result) {
    const publicResult = safePublicResult(result);
    if (!publicResult.accountRecalculationPending || typeof recalculateAccount !== "function") return publicResult;
    try {
      const internal = result && result._internal || {};
      const orderIds = Array.isArray(internal.orderIds) ? internal.orderIds.map((id) => cleanText(id, 128)).filter(Boolean) : [];
      let userId = cleanText(internal.userId, 128);
      let userOpenid = cleanText(internal.userOpenid, 128);
      if ((!userId && !userOpenid) || !orderIds.length) return publicResult;
      if (userId.includes("***") || userOpenid.includes("***")) {
        const seedOrder = (await db.collection("orders").doc(orderIds[0]).get()).data;
        userId = cleanText(seedOrder && seedOrder.userId, 128);
        userOpenid = cleanText(seedOrder && (seedOrder.userOpenid || seedOrder.openid), 128);
      }
      const recalculated = await recalculateAccount({
        userId,
        userOpenid,
        orderId: orderIds[0] || "",
        orderIds: orderIds.slice()
      });
      if ((recalculated && recalculated.ok === false) || (recalculated && recalculated.result && recalculated.result.ok === false)) return publicResult;
      await db.runTransaction(async (tx) => {
        for (const orderId of orderIds) await tx.collection("orders").doc(orderId).update({ data: { accountRecalculationPending: false, accountRecalculatedAt: db.serverDate ? db.serverDate() : now() } });
      });
      return { ...publicResult, accountRecalculationPending: false };
    } catch (_) {
      return publicResult;
    }
  }

  async function reviewWebPayment(command = {}) {
    assertDependencies();
    const input = normalizeWebInput(command.input);
    const actor = normalizeActor(command.actor, input.decision);
    await ensureCollections();
    const key = idempotency.assertIdempotencyKey(command.idempotencyKey);
    const outcome = await idempotency.runIdempotentAction({
      db,
      actionType: `payment_${input.decision}`,
      idempotencyKey: key,
      operatorIdentity: actor.id,
      operatorType: "admin",
      scope: "payment",
      scopeId: input.paymentId,
      openid: actor.openid,
      adminId: actor.id,
      payload: input,
      recoverProcessingResult: () => recoverCommitted({ operationId: key, paymentId: input.paymentId, decision: input.decision })
    }, () => executeWeb({ actor, input, idempotencyKey: key, operationId: key }));
    if (!outcome || outcome.ok !== true) throwIdempotencyOutcome(outcome);
    const replay = outcome.data && outcome.data.duplicate === true;
    const result = replay ? { ...outcome.data, affected: 0, reused: true } : outcome.data;
    return postCommitRecalculation(result);
  }

  async function updateLegacyPayment(command = {}) {
    assertDependencies();
    const input = normalizeLegacyInput(command.input);
    const actor = normalizeActor(command.actor, "confirm");
    await ensureCollections();
    let key = cleanText(command.idempotencyKey, 180);
    if (key) key = idempotency.assertIdempotencyKey(key);
    if (!key && command.allowMissingIdempotencyKey !== true) throw new PaymentMutationError("IDEMPOTENCY_KEY_REQUIRED", "缺少操作凭证", 400);
    const operationId = key || `legacy_${cleanText(randomId(), 128)}`;
    const outcome = !key
      ? { ok: true, data: await executeLegacy({ actor, input, idempotencyKey: "", operationId }) }
      : await idempotency.runIdempotentAction({
        db,
        actionType: `payment_legacy_${input.paymentStatus}`,
        idempotencyKey: key,
        operatorIdentity: actor.id,
        operatorType: "admin",
        scope: "order",
        scopeId: input.orderId,
        openid: actor.openid,
        adminId: actor.id,
        payload: input,
        recoverProcessingResult: () => recoverLegacyCommitted({ operationId, input })
      }, () => executeLegacy({ actor, input, idempotencyKey: key, operationId }));
    if (!outcome || outcome.ok !== true) throwIdempotencyOutcome(outcome);
    const replay = outcome.data && outcome.data.duplicate === true;
    const result = replay ? { ...outcome.data, affected: 0, reused: true } : outcome.data;
    return postCommitRecalculation(result);
  }

  return {
    reviewWebPayment,
    updateLegacyPayment,
    normalizeActor,
    normalizeWebInput,
    normalizeLegacyInput
  };
}

module.exports = {
  PaymentMutationError,
  createPaymentMutationService,
  normalizeActor,
  normalizeWebInput,
  normalizeLegacyInput
};
