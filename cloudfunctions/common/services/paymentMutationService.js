"use strict";

const crypto = require("crypto");

const PAYMENT_ROLES = new Set(["finance", "super_admin"]);
const LEGACY_STATUSES = new Set(["paid", "partial_paid", "abnormal", "unpaid"]);
const PAYMENT_MUTATION_REQUIRED_UNIQUE_INDEXES = Object.freeze([
  Object.freeze({
    collection: "account_logs",
    indexName: "uniq_account_payment_mutation_version",
    unique: true,
    fields: Object.freeze(["accountId", "afterPaymentMutationVersion"])
  }),
  Object.freeze({
    collection: "sync_events",
    indexName: "uniq_payment_sync_event_id",
    unique: true,
    fields: Object.freeze(["eventId"])
  })
]);

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
  const reason = input.reason === undefined || input.reason === null ? "" : input.reason.trim();
  if (reason.length > 300) throw new PaymentMutationError("REASON_INVALID", "付款审核原因过长", 400);
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

function paymentMutationVersionOf(row = {}) {
  const value = row.paymentMutationVersion === undefined || row.paymentMutationVersion === null || row.paymentMutationVersion === ""
    ? 0
    : row.paymentMutationVersion;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PaymentMutationError("ACCOUNT_MUTATION_VERSION_INVALID", "客户账款付款序列异常，暂不能确认付款", 409);
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

function recalculationMarker(log = {}) {
  const recalculation = log.journal && log.journal.recalculation || {};
  if (recalculation.required !== true) return null;
  const orderId = cleanText(log.orderId, 128);
  const owner = cleanText(recalculation.owner, 180);
  const expectedVersion = recalculation.expectedOrderVersion;
  const journalId = cleanText(log._id, 128);
  const journalBusinessKey = cleanText(log.businessKey, 512);
  const completionBusinessKey = cleanText(recalculation.completionBusinessKey, 512);
  if (!orderId || !owner || !journalId || !journalBusinessKey || !completionBusinessKey || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
  return { orderId, owner, expectedVersion, journalId, journalBusinessKey, completionBusinessKey };
}

function recalculationMarkers(logs = []) {
  return logs.map(recalculationMarker).filter(Boolean);
}

function createPaymentMutationService({ db, idempotency, ownerKeyFor, syncOwnerPepper = "", recalculateAccount, now = () => new Date(), randomId = () => crypto.randomUUID() } = {}) {
  const PAYMENT_PREFLIGHT_TOKEN = Symbol("paymentMutationPreflight");
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

  function businessTimestamp() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new PaymentMutationError("CLOCK_INVALID", "付款审核时间源无效，暂不能继续", 503);
    }
    return value;
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

  async function writeAccountReceipt(tx, { order, paymentId, next, actor, timestamp, reason, receiptOperationId }) {
    if (next.changeAmount <= 0) return null;
    const logKey = `payment_receipt:${receiptOperationId}:${paymentId}`;
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

    const beforePaymentMutationVersion = paymentMutationVersionOf(account || {});
    const afterPaymentMutationVersion = beforePaymentMutationVersion + 1;
    if (!Number.isSafeInteger(afterPaymentMutationVersion)) {
      throw new PaymentMutationError("ACCOUNT_MUTATION_VERSION_INVALID", "客户账款付款序列异常，暂不能确认付款", 409);
    }

    const accountUserId = cleanText(order.userId, 128);
    const accountUserOpenid = cleanText(order.userOpenid || order.openid, 128);
    const accountIdentity = accountUserId || accountUserOpenid ? `${accountUserId}|${accountUserOpenid}` : `order:${cleanText(order._id, 128)}`;
    let accountId = (account && cleanText(account._id, 128)) || deterministicId("customer_account", accountIdentity);
    if (!accountId) throw new PaymentMutationError("ACCOUNT_ID_REQUIRED", "客户账款标识缺失，暂不能确认付款", 409);
    const sequenceResponse = await tx.collection("account_logs").where({ accountId, afterPaymentMutationVersion }).limit(2).get();
    const sequenceOwners = Array.isArray(sequenceResponse.data) ? sequenceResponse.data : [];
    if (sequenceOwners.length > 1) throw new PaymentMutationError("ACCOUNT_MUTATION_LOG_DUPLICATE", "客户账款付款序列流水重复，暂不能继续", 409);
    if (sequenceOwners[0]) throw new PaymentMutationError("ACCOUNT_MUTATION_LOG_CONFLICT", "客户账款付款序列已被其他流水占用", 409);

    if (account) {
      await tx.collection("customer_accounts").doc(account._id).update({ data: {
        totalPaidAmount: afterPaid,
        paidAmount: afterPaid,
        totalUnpaidAmount: afterUnpaid,
        unpaidAmount: afterUnpaid,
        lastPaymentAt: timestamp,
        isSettled: afterUnpaid === 0,
        paymentMutationVersion: afterPaymentMutationVersion,
        updatedAt: timestamp
      } });
    } else {
      const created = await tx.collection("customer_accounts").add({ data: {
        _id: accountId,
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
        paymentMutationVersion: afterPaymentMutationVersion,
        createdAt: timestamp,
        updatedAt: timestamp
      } });
      accountId = cleanText(created && created._id, 128);
    }
    if (!accountId) throw new PaymentMutationError("ACCOUNT_ID_REQUIRED", "客户账款标识缺失，暂不能确认付款", 409);
    await tx.collection("account_logs").add({ data: {
      businessKey: logKey,
      accountId,
      beforePaymentMutationVersion,
      afterPaymentMutationVersion,
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
    return {
      required: true,
      businessKey: logKey,
      accountId,
      beforePaymentMutationVersion,
      afterPaymentMutationVersion
    };
  }

  function syncEventIds(businessKey) {
    return {
      ownerEventId: deterministicId("payment_event_owner", businessKey),
      adminEventId: deterministicId("payment_event_admin", businessKey)
    };
  }

  async function writeSyncEvents(tx, { order, payment, actor, businessKey, decision, timestamp, eventIds = syncEventIds(businessKey) }) {
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
      expiresAt: new Date(timestamp.getTime() + 7 * 24 * 60 * 60 * 1000)
    };
    const ownerExistingResponse = await tx.collection("sync_events").where({ eventId: eventIds.ownerEventId }).limit(2).get();
    const adminExistingResponse = await tx.collection("sync_events").where({ eventId: eventIds.adminEventId }).limit(2).get();
    const ownerExisting = Array.isArray(ownerExistingResponse.data) ? ownerExistingResponse.data : [];
    const adminExisting = Array.isArray(adminExistingResponse.data) ? adminExistingResponse.data : [];
    if (ownerExisting.length > 1 || adminExisting.length > 1) {
      throw new PaymentMutationError("SYNC_EVENT_DUPLICATE", "付款同步事件标识重复，暂不能继续", 409);
    }
    if (ownerExisting[0] || adminExisting[0]) {
      throw new PaymentMutationError("SYNC_EVENT_CONFLICT", "付款同步事件标识已被占用，暂不能继续", 409);
    }
    await tx.collection("sync_events").add({ data: { ...common, eventId: eventIds.ownerEventId, audience: "owner", ownerKey: ownerKey(order) } });
    await tx.collection("sync_events").add({ data: { ...common, eventId: eventIds.adminEventId, audience: "admin" } });
    return eventIds;
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
    const journal = validateJournal(logs[0], decision);
    const payment = (await db.collection("payment_records").doc(paymentId).get()).data;
    if (!payment) return null;
    const order = journal.order.id ? (await db.collection("orders").doc(journal.order.id).get()).data : null;
    if (!order) return null;
    const requestedStatus = decision === "reject" ? "unpaid" : "paid";
    const invalidMetadata = [
      cleanText(logs[0].sourceId, 180) !== operationId,
      cleanText(logs[0].rootOperationId, 180) !== operationId,
      cleanText(logs[0].operationKind, 40) !== "web_payment",
      logs[0].operationMemberCount !== 1,
      logs[0].operationMemberIndex !== 0,
      cleanText(logs[0].operationSeedOrderId, 128) !== cleanText(order._id, 128),
      cleanText(logs[0].requestedPaymentStatus, 40) !== requestedStatus
    ];
    if (invalidMetadata.some(Boolean)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核业务日志元数据冲突", 409);
    await validateRecoveryEvidence(logs[0], payment, order, decision, requestedStatus);
    return replayJournalResult(logs[0], 1);
  }

  function sameStoredValue(left, right) {
    if (left === right) return true;
    if (sameInstant(left, right)) return true;
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch (_) {
      return false;
    }
  }

  function validateJournal(log, decision) {
    const journal = log && log.journal || {};
    const result = journal.result || {};
    const payment = journal.payment || {};
    const order = journal.order || {};
    const receipt = journal.receipt || {};
    const delivery = journal.delivery || {};
    const sync = journal.sync || {};
    const recalculation = journal.recalculation || {};
    const resultKeys = Object.keys(result).sort();
    const publicKeys = ["accountRecalculationPending", "affected", "decision", "orderNo", "paymentId", "reused", "status", "updatedAt", "updatedCount", "version"].sort();
    const invalid = [
      journal.schemaVersion !== 1,
      journal.committedAt === undefined || journal.committedAt === null,
      JSON.stringify(resultKeys) !== JSON.stringify(publicKeys),
      !cleanText(result.paymentId, 128),
      !cleanText(result.status, 60),
      !Number.isSafeInteger(result.version) || result.version < 0,
      !Number.isSafeInteger(result.affected) || result.affected < 1,
      result.reused !== false,
      cleanText(result.decision, 20) !== decision,
      typeof result.accountRecalculationPending !== "boolean",
      !Number.isSafeInteger(result.updatedCount) || result.updatedCount < 1,
      !sameStoredValue(journal.committedAt, result.updatedAt),
      cleanText(payment.id, 128) !== cleanText(log.resourceId, 128),
      cleanText(payment.orderId, 128) !== cleanText(log.orderId, 128),
      !Number.isSafeInteger(payment.committedVersion) || payment.committedVersion < 0,
      !cleanText(payment.status, 60),
      !cleanText(payment.paymentStatus, 60),
      !cleanText(payment.confirmStatus, 60),
      cleanText(payment.reviewBusinessKey, 512) !== cleanText(log.businessKey, 512),
      cleanText(order.id, 128) !== cleanText(log.orderId, 128),
      !Number.isSafeInteger(order.committedVersion) || order.committedVersion < 0,
      !cleanText(order.status, 60),
      !cleanText(order.paymentStatus, 60),
      cleanText(order.latestPaymentRecordId, 128) !== cleanText(payment.id, 128),
      cleanText(result.paymentId, 128) !== cleanText(payment.id, 128),
      result.version !== payment.committedVersion,
      cleanText(result.status, 60) !== cleanText(payment.status, 60),
      typeof receipt.required !== "boolean",
      typeof delivery.changed !== "boolean",
      !cleanText(delivery.businessKey, 512),
      !cleanText(delivery.beforeStatus, 60),
      !cleanText(delivery.afterStatus, 60),
      !cleanText(sync.ownerEventId, 128),
      !cleanText(sync.adminEventId, 128),
      typeof recalculation.required !== "boolean"
    ];
    if (receipt.required === true) {
      invalid.push(
        !cleanText(receipt.businessKey, 512),
        !cleanText(receipt.accountId, 128),
        !Number.isSafeInteger(receipt.beforePaymentMutationVersion) || receipt.beforePaymentMutationVersion < 0,
        receipt.afterPaymentMutationVersion !== receipt.beforePaymentMutationVersion + 1
      );
    }
    if (recalculation.required === true) {
      invalid.push(
        !cleanText(recalculation.owner, 180),
        !Number.isSafeInteger(recalculation.expectedOrderVersion) || recalculation.expectedOrderVersion < 0,
        !cleanText(recalculation.completionBusinessKey, 512)
      );
    }
    if (invalid.some(Boolean)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核操作日志快照无效", 409);
    return journal;
  }

  function replayJournalResult(log, updatedCount) {
    const journal = validateJournal(log, cleanText(log.decision, 20));
    const result = safePublicResult(journal.result);
    return {
      ...result,
      affected: 0,
      reused: true,
      updatedCount: Number.isSafeInteger(updatedCount) && updatedCount > 0 ? updatedCount : result.updatedCount
    };
  }

  function validateCurrentMonotonicity(log, payment, order, decision) {
    const journal = validateJournal(log, decision);
    const paymentVersion = versionOf(payment);
    const orderVersion = versionOf(order, "订单");
    const identityConflict = [
      cleanText(payment._id, 128) !== cleanText(journal.payment.id, 128),
      cleanText(payment.orderId, 128) !== cleanText(journal.payment.orderId, 128),
      cleanText(order._id, 128) !== cleanText(journal.order.id, 128),
      cleanText(log.resourceId, 128) !== cleanText(journal.payment.id, 128),
      cleanText(log.orderId, 128) !== cleanText(journal.order.id, 128),
      paymentVersion < journal.payment.committedVersion,
      orderVersion < journal.order.committedVersion
    ];
    if (identityConflict.some(Boolean)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核当前实体与操作日志冲突", 409);

    if (paymentVersion === journal.payment.committedVersion) {
      const paymentConflict = [
        cleanText(payment.status || payment.paymentStatus, 60) !== cleanText(journal.payment.status, 60),
        cleanText(payment.paymentStatus, 60) !== cleanText(journal.payment.paymentStatus, 60),
        cleanText(payment.confirmStatus, 60) !== cleanText(journal.payment.confirmStatus, 60),
        cleanText(payment.reviewBusinessKey, 512) !== cleanText(journal.payment.reviewBusinessKey, 512)
      ];
      if (paymentConflict.some(Boolean)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款记录与提交快照冲突", 409);
    }

    if (orderVersion === journal.order.committedVersion) {
      const orderConflict = [
        cleanText(order.status, 60) !== cleanText(journal.order.status, 60),
        cleanText(order.paymentStatus, 60) !== cleanText(journal.order.paymentStatus, 60),
        cleanText(order.latestPaymentRecordId, 128) !== cleanText(journal.order.latestPaymentRecordId, 128)
      ];
      if (orderConflict.some(Boolean)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "订单与提交快照冲突", 409);
    }
    return journal;
  }

  function recoveryCents(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款恢复金额证据无效", 409);
    }
    return value;
  }

  async function uniqueRecoveryRow(collectionName, where, missingMessage, duplicateMessage) {
    const response = await db.collection(collectionName).where(where).limit(2).get();
    const rows = Array.isArray(response.data) ? response.data : [];
    if (rows.length > 1) throw new PaymentMutationError("BUSINESS_LOG_DUPLICATE", duplicateMessage, 409);
    if (!rows[0]) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", missingMessage, 409);
    return rows[0];
  }

  async function validateReceiptAndAccountEvidence(log, payment, order, requestedStatus) {
    const journal = validateJournal(log, cleanText(log.decision, 20));
    const frozen = journal.receipt;
    if (frozen.required !== true) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款账款流水快照缺失", 409);
    const receiptBusinessKey = cleanText(frozen.businessKey, 512);
    const receipt = await uniqueRecoveryRow("account_logs", { businessKey: receiptBusinessKey }, "付款账款流水证据缺失", "付款账款流水证据重复");
    const beforeOrder = recoveryCents(receipt.beforeTotalOrderAmount);
    const afterOrder = recoveryCents(receipt.afterTotalOrderAmount);
    const beforePaid = recoveryCents(receipt.beforeTotalPaidAmount);
    const afterPaid = recoveryCents(receipt.afterTotalPaidAmount);
    const beforeUnpaid = recoveryCents(receipt.beforeTotalUnpaidAmount);
    const afterUnpaid = recoveryCents(receipt.afterTotalUnpaidAmount);
    const changeAmount = recoveryCents(receipt.changeAmount);
    const expectedChangeType = requestedStatus === "partial_paid" && cleanText(journal.order.paymentStatus, 60) !== "paid"
      ? "partial_payment_confirmed"
      : "payment_confirmed";
    const invalidReceipt = [
      receiptBusinessKey !== cleanText(receipt.businessKey, 512),
      cleanText(receipt.sourceType, 40) !== "payment",
      cleanText(receipt.sourceId, 128) !== cleanText(payment._id, 128),
      cleanText(receipt.relatedPaymentRecordId, 128) !== cleanText(payment._id, 128),
      cleanText(receipt.relatedOrderId, 128) !== cleanText(order._id, 128),
      cleanText(receipt.accountId, 128) !== cleanText(frozen.accountId, 128),
      receipt.beforePaymentMutationVersion !== frozen.beforePaymentMutationVersion,
      receipt.afterPaymentMutationVersion !== frozen.afterPaymentMutationVersion,
      receipt.afterPaymentMutationVersion !== receipt.beforePaymentMutationVersion + 1,
      cleanText(order.userId, 128) && cleanText(receipt.userId, 128) !== cleanText(order.userId, 128),
      cleanText(order.userOpenid || order.openid, 128) && cleanText(receipt.userOpenid, 128) !== cleanText(order.userOpenid || order.openid, 128),
      cleanText(receipt.changeType, 80) !== expectedChangeType,
      beforeOrder !== afterOrder,
      beforePaid + beforeUnpaid !== beforeOrder,
      afterPaid + afterUnpaid !== afterOrder,
      changeAmount <= 0,
      beforePaid + changeAmount !== afterPaid,
      beforeUnpaid - changeAmount !== afterUnpaid,
      versionOf(payment) === journal.payment.committedVersion && recoveryCents(payment.reviewPaidAmount) !== changeAmount
    ];
    if (invalidReceipt.some(Boolean)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款账款流水证据冲突", 409);

    const account = await findAccount(db, order);
    if (!account) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "客户账款证据缺失", 409);
    if (cleanText(account._id, 128) !== cleanText(frozen.accountId, 128)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "客户账款标识与付款流水冲突", 409);
    const orderUserId = cleanText(order.userId, 128);
    const orderOpenid = cleanText(order.userOpenid || order.openid, 128);
    if ((orderUserId && cleanText(account.userId, 128) !== orderUserId) || (orderOpenid && cleanText(account.userOpenid, 128) !== orderOpenid)) {
      throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "客户账款双身份证据冲突", 409);
    }
    const currentPaymentMutationVersion = paymentMutationVersionOf(account);
    if (currentPaymentMutationVersion < frozen.afterPaymentMutationVersion) {
      throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "客户账款当前证据未包含付款流水", 409);
    }
    const owner = await uniqueRecoveryRow(
      "account_logs",
      { accountId: frozen.accountId, afterPaymentMutationVersion: frozen.afterPaymentMutationVersion },
      "付款账款序列归属缺失",
      "付款账款序列归属重复"
    );
    if (cleanText(owner.businessKey, 512) !== receiptBusinessKey || cleanText(owner._id, 128) !== cleanText(receipt._id, 128)) {
      throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款账款序列归属冲突", 409);
    }
  }

  async function validateDeliveryEvidence(log, payment, order) {
    const journal = validateJournal(log, cleanText(log.decision, 20));
    const deliverySnapshot = journal.delivery;
    const businessKey = cleanText(deliverySnapshot.businessKey, 512);
    if (deliverySnapshot.changed !== true) {
      const response = await db.collection("delivery_logs").where({ businessKey }).limit(2).get();
      const rows = Array.isArray(response.data) ? response.data : [];
      if (rows.length > 1) throw new PaymentMutationError("BUSINESS_LOG_DUPLICATE", "付款配送流水证据重复", 409);
      if (rows[0]) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "未变更配送状态却存在付款配送流水", 409);
      return;
    }
    const delivery = await uniqueRecoveryRow("delivery_logs", { businessKey }, "付款配送流水证据缺失", "付款配送流水证据重复");
    const invalid = [
      cleanText(delivery.businessKey, 512) !== businessKey,
      cleanText(delivery.orderId, 128) !== cleanText(order._id, 128),
      cleanText(delivery.beforeStatus, 60) !== cleanText(deliverySnapshot.beforeStatus, 60),
      cleanText(delivery.afterStatus, 60) !== cleanText(deliverySnapshot.afterStatus, 60),
      cleanText(delivery.beforeStatus, 60) === cleanText(delivery.afterStatus, 60),
      cleanText(delivery.action, 80) !== "payment_confirmed"
    ];
    if (invalid.some(Boolean)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款配送流水证据冲突", 409);
  }

  async function validateSyncEvidence(log, payment, order, decision) {
    const journal = validateJournal(log, decision);
    const changedFields = ["status", "paymentStatus", "confirmStatus", "version", "updatedAt"];
    for (const audience of ["owner", "admin"]) {
      const eventId = audience === "owner" ? journal.sync.ownerEventId : journal.sync.adminEventId;
      const expectedEventId = deterministicId(audience === "owner" ? "payment_event_owner" : "payment_event_admin", log.businessKey);
      const event = await uniqueRecoveryRow("sync_events", { eventId }, "付款同步事件证据缺失", "付款同步事件证据重复");
      const invalid = [
        cleanText(eventId, 128) !== expectedEventId,
        cleanText(event.eventId, 128) !== cleanText(eventId, 128),
        cleanText(event.audience, 20) !== audience,
        cleanText(event.eventType, 80) !== "payment.status_changed",
        cleanText(event.entityType, 40) !== "payment",
        cleanText(event.entityId, 128) !== cleanText(payment._id, 128),
        cleanText(event.action, 20) !== decision,
        event.version !== journal.payment.committedVersion,
        JSON.stringify(event.changedFields) !== JSON.stringify(changedFields),
        audience === "owner" && cleanText(event.ownerKey, 128) !== ownerKey(order)
      ];
      if (invalid.some(Boolean)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款同步事件证据冲突", 409);
    }
  }

  async function validateRecoveryEvidence(log, payment, order, decision, requestedStatus) {
    const journal = validateCurrentMonotonicity(log, payment, order, decision);
    const hasReceipt = decision === "confirm" && ["paid", "partial_paid"].includes(requestedStatus || "paid");
    if (hasReceipt !== (journal.receipt.required === true)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款账款流水要求与操作日志冲突", 409);
    if (hasReceipt) {
      await validateReceiptAndAccountEvidence(log, payment, order, requestedStatus || "paid");
    }
    await validateDeliveryEvidence(log, payment, order);
    await validateSyncEvidence(log, payment, order, decision);
  }

  async function legacyRootAudits(source, operationId) {
    const response = await source.collection("admin_operation_logs").where({ rootOperationId: operationId, operationKind: "legacy_payment" }).limit(101).get();
    const logs = Array.isArray(response.data) ? response.data : [];
    if (logs.length > 100) throw new PaymentMutationError("BUSINESS_LOG_DUPLICATE", "付款审核业务日志超过恢复上限", 409);
    return logs;
  }

  function validateLegacyRecoveryAudits(logs, operationId, input, decision) {
    if (!logs.length) return [];
    const memberCount = logs[0].operationMemberCount;
    if (!Number.isSafeInteger(memberCount) || memberCount < 1 || memberCount > 100 || memberCount !== logs.length) {
      throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核业务日志成员不完整", 409);
    }
    const indexes = new Set();
    const orderIds = new Set();
    const paymentIds = new Set();
    const businessKeys = new Set();
    for (const log of logs) {
      const orderId = cleanText(log && log.orderId, 128);
      const paymentId = cleanText(log && log.resourceId, 128);
      const index = log && log.operationMemberIndex;
      const childOperationId = `${operationId}:${orderId}`;
      const expectedBusinessKey = `payment_mutation:${childOperationId}:${paymentId}:${decision}`;
      const invalid = [
        cleanText(log && log.rootOperationId, 180) !== operationId,
        cleanText(log && log.operationKind, 40) !== "legacy_payment",
        log && log.operationMemberCount !== memberCount,
        !Number.isSafeInteger(index) || index < 0 || index >= memberCount,
        cleanText(log && log.operationSeedOrderId, 128) !== input.orderId,
        cleanText(log && log.requestedPaymentStatus, 40) !== input.paymentStatus,
        cleanText(log && log.sourceId, 320) !== childOperationId,
        cleanText(log && log.decision, 20) !== decision,
        !orderId,
        !paymentId,
        cleanText(log && log.businessKey, 512) !== expectedBusinessKey
      ];
      if (invalid.some(Boolean) || indexes.has(index) || orderIds.has(orderId) || paymentIds.has(paymentId) || businessKeys.has(expectedBusinessKey)) {
        throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核业务日志成员冲突", 409);
      }
      indexes.add(index);
      orderIds.add(orderId);
      paymentIds.add(paymentId);
      businessKeys.add(expectedBusinessKey);
    }
    for (let index = 0; index < memberCount; index += 1) {
      if (!indexes.has(index)) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核业务日志成员不完整", 409);
    }
    return logs.slice().sort((left, right) => left.operationMemberIndex - right.operationMemberIndex);
  }

  async function recoverLegacyCommitted({ operationId, input }) {
    const decision = input.paymentStatus === "unpaid" ? "reject" : input.paymentStatus === "abnormal" ? "abnormal" : "confirm";
    const logs = validateLegacyRecoveryAudits(await legacyRootAudits(db, operationId), operationId, input, decision);
    if (!logs.length) return null;
    const recovered = [];
    for (const log of logs) {
      const order = (await db.collection("orders").doc(log.orderId).get()).data;
      const payment = (await db.collection("payment_records").doc(log.resourceId).get()).data;
      if (!order || !payment) {
        throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核业务日志关联结果缺失", 409);
      }
      await validateRecoveryEvidence(log, payment, order, decision, input.paymentStatus);
      recovered.push({ payment, order, log });
    }
    const seed = (await db.collection("orders").doc(input.orderId).get()).data;
    if (!seed) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核入口订单证据缺失", 409);
    validateBatchIdentity(seed, recovered.map((item) => item.order));
    const first = recovered[0];
    return replayJournalResult(first.log, recovered.length);
  }

  async function contextFromAuditLogs(logs, seedOrderId) {
    const markers = recalculationMarkers(logs);
    if (!markers.length) return null;
    const seed = (await db.collection("orders").doc(seedOrderId).get()).data;
    if (!seed) return null;
    return {
      markers,
      userId: cleanText(seed.userId, 128),
      userOpenid: cleanText(seed.userOpenid || seed.openid, 128)
    };
  }

  async function loadWebRecalculationContext({ operationId, paymentId, decision }) {
    const businessKey = `payment_mutation:${operationId}:${paymentId}:${decision}`;
    const response = await db.collection("admin_operation_logs").where({ businessKey }).limit(2).get();
    const logs = Array.isArray(response.data) ? response.data : [];
    if (logs.length !== 1) return null;
    return contextFromAuditLogs(logs, cleanText(logs[0].orderId, 128));
  }

  async function loadLegacyRecalculationContext({ operationId, input }) {
    const decision = input.paymentStatus === "unpaid" ? "reject" : input.paymentStatus === "abnormal" ? "abnormal" : "confirm";
    const logs = validateLegacyRecoveryAudits(await legacyRootAudits(db, operationId), operationId, input, decision);
    if (!logs.length) return null;
    return contextFromAuditLogs(logs, input.orderId);
  }

  async function bestEffortRecalculationContext(loader) {
    try {
      return await loader();
    } catch (_) {
      return null;
    }
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

  function mutationPreflightFields({ order, payment, next, decision, operationId, requestedPaymentStatus }) {
    const paymentId = payment && payment._id || cleanText(order.latestPaymentRecordId, 128) || deterministicId("legacy_payment", `${operationId}:${order._id}`);
    const businessKey = `payment_mutation:${operationId}:${paymentId}:${decision}`;
    const deliveryStatus = nextDeliveryStatus(next, order);
    const deliveryBeforeStatus = cleanText(order.deliveryStatus, 60) || "pending";
    return {
      operationId,
      orderId: order._id,
      paymentId,
      decision,
      requestedPaymentStatus,
      nextPaymentStatus: next.paymentStatus,
      recordStatus: decision === "reject" || next.confirmStatus === "rejected" ? "rejected" : next.paymentStatus,
      businessKey,
      deliveryStatus,
      deliveryBeforeStatus,
      deliveryChanged: deliveryBeforeStatus !== deliveryStatus,
      deliveryBusinessKey: `payment_delivery:${operationId}:${paymentId}`
    };
  }

  async function preflightMutation(tx, mutation) {
    const fields = mutationPreflightFields(mutation);
    const priorAuditResponse = await tx.collection("admin_operation_logs").where({ businessKey: fields.businessKey }).limit(2).get();
    const priorAudits = Array.isArray(priorAuditResponse.data) ? priorAuditResponse.data : [];
    if (priorAudits.length > 1) throw new PaymentMutationError("BUSINESS_LOG_DUPLICATE", "付款审核业务日志重复", 409);
    if (priorAudits[0]) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核业务日志已存在但付款状态不一致", 409);
    const priorDeliveryResponse = await tx.collection("delivery_logs").where({ businessKey: fields.deliveryBusinessKey }).limit(2).get();
    const priorDeliveries = Array.isArray(priorDeliveryResponse.data) ? priorDeliveryResponse.data : [];
    if (priorDeliveries.length > 1) throw new PaymentMutationError("DELIVERY_LOG_DUPLICATE", "付款配送流水重复，暂不能继续", 409);
    if (priorDeliveries[0]) throw new PaymentMutationError("DELIVERY_LOG_CONFLICT", "付款配送流水已存在但订单状态不一致", 409);
    return Object.freeze({ ...fields, [PAYMENT_PREFLIGHT_TOKEN]: true });
  }

  function assertMutationPreflight(preflight, mutation) {
    const expected = mutationPreflightFields(mutation);
    const fields = [
      "operationId",
      "orderId",
      "paymentId",
      "decision",
      "requestedPaymentStatus",
      "nextPaymentStatus",
      "recordStatus",
      "businessKey",
      "deliveryStatus",
      "deliveryBeforeStatus",
      "deliveryChanged",
      "deliveryBusinessKey"
    ];
    if (!preflight || preflight[PAYMENT_PREFLIGHT_TOKEN] !== true || fields.some((field) => preflight[field] !== expected[field])) {
      throw new PaymentMutationError("PAYMENT_PREFLIGHT_INVALID", "付款审核预检结果与当前操作不匹配", 409);
    }
    return preflight;
  }

  async function mutateOne(tx, {
    order,
    payment,
    next,
    actor,
    decision,
    reason,
    idempotencyKey,
    operationId,
    rootOperationId,
    operationKind,
    operationMemberCount,
    operationMemberIndex,
    operationSeedOrderId,
    requestedPaymentStatus,
    timestamp,
    preflight
  }) {
    const verified = assertMutationPreflight(preflight, {
      order,
      payment,
      next,
      decision,
      operationId,
      requestedPaymentStatus
    });
    const businessPaymentId = verified.paymentId;
    const businessKey = verified.businessKey;
    const deliveryStatus = verified.deliveryStatus;
    const deliveryBeforeStatus = verified.deliveryBeforeStatus;
    const deliveryChanged = verified.deliveryChanged;
    const deliveryBusinessKey = verified.deliveryBusinessKey;
    const paymentVersion = versionOf(payment || {});
    const recordStatus = verified.recordStatus;
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

    const receiptEvidence = await writeAccountReceipt(tx, { order, paymentId, next, actor, timestamp, reason, receiptOperationId: operationId });
    const nextOrderVersion = versionOf(order, "订单") + 1;
    const ownsRecalculation = next.changeAmount > 0;
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
      accountRecalculationPending: ownsRecalculation ? true : order.accountRecalculationPending === true,
      accountRecalculationOwner: ownsRecalculation ? rootOperationId : cleanText(order.accountRecalculationOwner, 180),
      accountRecalculationExpectedVersion: ownsRecalculation
        ? nextOrderVersion
        : Number.isSafeInteger(order.accountRecalculationExpectedVersion) && order.accountRecalculationExpectedVersion >= 0
          ? order.accountRecalculationExpectedVersion
          : 0,
      version: nextOrderVersion,
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
      accountRecalculationOwner: nextOrder.accountRecalculationOwner,
      accountRecalculationExpectedVersion: nextOrder.accountRecalculationExpectedVersion,
      version: nextOrder.version,
      updatedAt: nextOrder.updatedAt
    } });
    if (deliveryChanged) {
      await tx.collection("delivery_logs").add({ data: {
        businessKey: deliveryBusinessKey,
        orderId: order._id,
        orderNo: cleanText(order.orderNo, 100),
        deliveryType: cleanText(order.deliveryType, 40),
        beforeStatus: deliveryBeforeStatus,
        afterStatus: deliveryStatus,
        action: "payment_confirmed",
        operatorId: actor.id,
        operatorOpenid: actor.openid,
        createdAt: timestamp
      } });
    }
    const eventIds = syncEventIds(businessKey);
    const completionBusinessKey = `payment_recalculation:${rootOperationId}:${order._id}`;
    const journalResult = mutationResult(nextPayment, nextOrder, decision, {
      affected: operationMemberCount,
      reused: false,
      updatedCount: operationMemberCount,
      accountRecalculationPending: ownsRecalculation
    });
    const journal = {
      schemaVersion: 1,
      committedAt: timestamp,
      result: journalResult,
      payment: {
        id: paymentId,
        orderId: order._id,
        committedVersion: versionOf(nextPayment),
        status: cleanText(nextPayment.status || nextPayment.paymentStatus, 60),
        paymentStatus: cleanText(nextPayment.paymentStatus, 60),
        confirmStatus: cleanText(nextPayment.confirmStatus, 60),
        reviewBusinessKey: businessKey
      },
      order: {
        id: order._id,
        committedVersion: nextOrder.version,
        status: cleanText(nextOrder.status, 60),
        paymentStatus: cleanText(nextOrder.paymentStatus, 60),
        latestPaymentRecordId: paymentId
      },
      receipt: receiptEvidence || { required: false },
      delivery: {
        changed: deliveryChanged,
        businessKey: deliveryBusinessKey,
        beforeStatus: deliveryBeforeStatus,
        afterStatus: deliveryStatus
      },
      sync: eventIds,
      recalculation: ownsRecalculation
        ? {
            required: true,
            owner: rootOperationId,
            expectedOrderVersion: nextOrder.version,
            completionBusinessKey
          }
        : { required: false }
    };
    const auditCreated = await tx.collection("admin_operation_logs").add({ data: {
      businessKey,
      sourceId: operationId,
      rootOperationId,
      operationKind,
      operationMemberCount,
      operationMemberIndex,
      operationSeedOrderId,
      requestedPaymentStatus,
      idempotencyKey: idempotencyKey || "",
      action: decision === "reject" ? "payment_reject" : "payment_confirm",
      decision,
      resourceType: "payment",
      resourceId: paymentId,
      orderId: order._id,
      journal,
      operatorId: actor.id,
      operatorOpenid: actor.openid,
      operatorRole: actor.role,
      status: "success",
      createdAt: timestamp
    } });
    await writeSyncEvents(tx, { order: nextOrder, payment: nextPayment, actor, businessKey, decision, timestamp, eventIds });
    return {
      payment: nextPayment,
      order: nextOrder,
      recalculationAuditId: auditCreated && auditCreated._id,
      recalculationOwned: ownsRecalculation
    };
  }

  async function executeWeb({ actor, input, idempotencyKey, operationId }) {
    return db.runTransaction(async (tx) => {
      const timestamp = businessTimestamp();
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
      const requestedPaymentStatus = input.decision === "reject" ? "unpaid" : "paid";
      const mutation = {
        order,
        payment,
        next,
        actor,
        decision: input.decision,
        reason: input.reason,
        idempotencyKey,
        operationId,
        rootOperationId: operationId,
        operationKind: "web_payment",
        operationMemberCount: 1,
        operationMemberIndex: 0,
        operationSeedOrderId: order._id,
        requestedPaymentStatus,
        timestamp
      };
      const preflight = await preflightMutation(tx, mutation);
      const updated = await mutateOne(tx, { ...mutation, preflight });
      return mutationResult(updated.payment, updated.order, input.decision, { affected: 1, reused: false, updatedCount: 1, accountRecalculationPending: next.changeAmount > 0 });
    });
  }

  async function executeLegacy({ actor, input, idempotencyKey, operationId }) {
    return db.runTransaction(async (tx) => {
      const timestamp = businessTimestamp();
      const priorRootAudits = await legacyRootAudits(tx, operationId);
      if (priorRootAudits.length) throw new PaymentMutationError("BUSINESS_LOG_CONFLICT", "付款审核操作已有不完整或冲突日志", 409);
      const seed = (await tx.collection("orders").doc(input.orderId).get()).data;
      if (!seed) throw new PaymentMutationError("ORDER_NOT_FOUND", "订单不存在", 404);
      const orders = await targetOrders(tx, seed, input);
      const prepared = [];
      for (let index = 0; index < orders.length; index += 1) {
        const order = orders[index];
        let payment = null;
        if (order.latestPaymentRecordId) payment = (await tx.collection("payment_records").doc(order.latestPaymentRecordId).get()).data;
        if (input.paymentStatus === "paid" && (order.paymentStatus === "paid" || order.status === "paid")) {
          if (!payment) throw new PaymentMutationError("PAYMENT_NOT_FOUND", "付款记录不存在", 404);
          prepared.push({ payment, order, reused: true });
          continue;
        }
        if (input.paymentStatus === "unpaid" && order.paymentStatus === "unpaid" && order.status === "approved_pending_payment") {
          if (!payment) throw new PaymentMutationError("PAYMENT_NOT_FOUND", "付款记录不存在", 404);
          prepared.push({ payment, order, reused: true });
          continue;
        }
        const next = { ...buildNext(order, input.paymentStatus, input.paidAmountCents), paymentMethod: input.paymentMethod || cleanText(order.paymentMethod, 80) };
        prepared.push({
          reused: false,
          mutation: {
            order,
            payment,
            next,
            actor,
            decision: input.paymentStatus === "unpaid" ? "reject" : input.paymentStatus === "abnormal" ? "abnormal" : "confirm",
            reason: input.remark,
            idempotencyKey,
            operationId: `${operationId}:${order._id}`,
            rootOperationId: operationId,
            operationKind: "legacy_payment",
            operationMemberCount: orders.length,
            operationMemberIndex: index,
            operationSeedOrderId: input.orderId,
            requestedPaymentStatus: input.paymentStatus,
            timestamp
          }
        });
      }
      for (const member of prepared) {
        if (!member.reused) member.preflight = await preflightMutation(tx, member.mutation);
      }
      const updated = [];
      for (const member of prepared) {
        if (member.reused) updated.push(member);
        else updated.push(await mutateOne(tx, { ...member.mutation, preflight: member.preflight }));
      }
      const first = updated[0];
      const decision = input.paymentStatus === "unpaid" ? "reject" : input.paymentStatus === "abnormal" ? "abnormal" : "confirm";
      return mutationResult(first.payment, first.order, decision, { affected: updated.filter((item) => !item.reused).length, reused: updated.every((item) => item.reused), updatedCount: updated.length, accountRecalculationPending: updated.some((item) => item.order.accountRecalculationPending === true) });
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

  function contextRecalculationMarkers(context) {
    const source = Array.isArray(context && context.markers) ? context.markers : [];
    const markers = [];
    const seen = new Set();
    for (const value of source) {
      const marker = {
        orderId: cleanText(value && value.orderId, 128),
        owner: cleanText(value && value.owner, 180),
        expectedVersion: value && value.expectedVersion,
        journalId: cleanText(value && value.journalId, 128),
        journalBusinessKey: cleanText(value && value.journalBusinessKey, 512),
        completionBusinessKey: cleanText(value && value.completionBusinessKey, 512)
      };
      if (!marker.orderId || !marker.owner || !marker.journalId || !marker.journalBusinessKey || !marker.completionBusinessKey || !Number.isSafeInteger(marker.expectedVersion) || marker.expectedVersion < 0 || seen.has(marker.orderId)) return [];
      seen.add(marker.orderId);
      markers.push(marker);
    }
    return markers;
  }

  function markerMatchesOrder(marker, order) {
    return Boolean(order)
      && cleanText(order.accountRecalculationOwner, 180) === marker.owner
      && order.accountRecalculationExpectedVersion === marker.expectedVersion
      && versionOf(order, "订单") === marker.expectedVersion;
  }

  function markerMatchesJournal(marker, audit) {
    const recalculation = audit && audit.journal && audit.journal.recalculation || {};
    return Boolean(audit)
      && cleanText(audit._id, 128) === marker.journalId
      && cleanText(audit.businessKey, 512) === marker.journalBusinessKey
      && cleanText(audit.orderId, 128) === marker.orderId
      && recalculation.required === true
      && cleanText(recalculation.owner, 180) === marker.owner
      && recalculation.expectedOrderVersion === marker.expectedVersion
      && cleanText(recalculation.completionBusinessKey, 512) === marker.completionBusinessKey;
  }

  async function uniqueRecalculationCompletion(source, marker) {
    const response = await source.collection("admin_operation_logs").where({ businessKey: marker.completionBusinessKey }).limit(2).get();
    const rows = Array.isArray(response.data) ? response.data : [];
    if (rows.length > 1) return { conflict: true, row: null };
    const row = rows[0] || null;
    if (!row) return { conflict: false, row: null };
    const valid = cleanText(row.operationKind, 80) === "payment_recalculation_completion"
      && cleanText(row.sourceBusinessKey, 512) === marker.journalBusinessKey
      && cleanText(row.resourceId, 128) === marker.orderId
      && cleanText(row.status, 20) === "success";
    return { conflict: !valid, row: valid ? row : null };
  }

  async function replayRecalculationState(result, context) {
    const publicResult = safePublicResult(result);
    if (!publicResult.accountRecalculationPending) return publicResult;
    const markers = contextRecalculationMarkers(context);
    if (!markers.length) return publicResult;
    try {
      for (const marker of markers) {
        const audit = (await db.collection("admin_operation_logs").doc(marker.journalId).get()).data;
        const completion = await uniqueRecalculationCompletion(db, marker);
        if (!markerMatchesJournal(marker, audit) || completion.conflict || !completion.row) return publicResult;
      }
      return { ...publicResult, accountRecalculationPending: false };
    } catch (_) {
      return publicResult;
    }
  }

  async function clearOwnedRecalculationMarkers(markers) {
    if (!markers.length) return false;
    return db.runTransaction(async (tx) => {
      let clearedAll = true;
      for (const marker of markers) {
        const order = (await tx.collection("orders").doc(marker.orderId).get()).data;
        const audit = (await tx.collection("admin_operation_logs").doc(marker.journalId).get()).data;
        const completion = await uniqueRecalculationCompletion(tx, marker);
        if (!markerMatchesJournal(marker, audit) || completion.conflict) {
          clearedAll = false;
          continue;
        }
        if (completion.row && order && order.accountRecalculationPending === false) continue;
        if (completion.row || !markerMatchesOrder(marker, order)) {
          clearedAll = false;
          continue;
        }
        if (order.accountRecalculationPending !== true) {
          clearedAll = false;
          continue;
        }
        await tx.collection("orders").doc(marker.orderId).update({
          data: {
            accountRecalculationPending: false,
            accountRecalculatedAt: db.serverDate ? db.serverDate() : now()
          }
        });
        await tx.collection("admin_operation_logs").add({ data: {
          businessKey: marker.completionBusinessKey,
          sourceBusinessKey: marker.journalBusinessKey,
          operationKind: "payment_recalculation_completion",
          action: "payment_account_recalculated",
          resourceType: "order",
          resourceId: marker.orderId,
          status: "success",
          createdAt: db.serverDate ? db.serverDate() : now()
        } });
      }
      return clearedAll;
    });
  }

  async function postCommitRecalculation(result, context) {
    const publicResult = safePublicResult(result);
    if (!publicResult.accountRecalculationPending || typeof recalculateAccount !== "function") return publicResult;
    try {
      const markers = contextRecalculationMarkers(context);
      const orderIds = markers.map((marker) => marker.orderId);
      const userId = cleanText(context && context.userId, 128);
      const userOpenid = cleanText(context && context.userOpenid, 128);
      if ((!userId && !userOpenid) || !orderIds.length) return publicResult;
      const recalculated = await recalculateAccount({
        userId,
        userOpenid,
        orderId: orderIds[0] || "",
        orderIds: orderIds.slice()
      });
      if ((recalculated && recalculated.ok === false) || (recalculated && recalculated.result && recalculated.result.ok === false)) return publicResult;
      const cleared = await clearOwnedRecalculationMarkers(markers);
      return cleared ? { ...publicResult, accountRecalculationPending: false } : publicResult;
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
    const context = result.accountRecalculationPending === true
      ? await bestEffortRecalculationContext(() => loadWebRecalculationContext({ operationId: key, paymentId: input.paymentId, decision: input.decision }))
      : null;
    return replay ? replayRecalculationState(result, context) : postCommitRecalculation(result, context);
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
    const context = result.accountRecalculationPending === true
      ? await bestEffortRecalculationContext(() => loadLegacyRecalculationContext({ operationId, input }))
      : null;
    return replay ? replayRecalculationState(result, context) : postCommitRecalculation(result, context);
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
  PAYMENT_MUTATION_REQUIRED_UNIQUE_INDEXES,
  createPaymentMutationService,
  normalizeActor,
  normalizeWebInput,
  normalizeLegacyInput
};
