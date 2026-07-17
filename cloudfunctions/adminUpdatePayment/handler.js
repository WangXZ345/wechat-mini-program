"use strict";

const crypto = require("crypto");

const CONTEXT_WARNING = "付款状态已提交，购买统计仅按入口订单刷新";
const LEGACY_STATUSES = new Set(["paid", "partial_paid", "abnormal", "unpaid"]);

function cleanText(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function normalizedRequestedStatus(event = {}) {
  const requested = event.paymentStatus || (event.isPartial ? "partial_paid" : "paid");
  return requested === "partial" ? "partial_paid" : cleanText(requested, 40);
}

function actorFromAdmin(admin = {}) {
  return {
    id: cleanText(admin.id || admin._id || admin.openid, 128),
    openid: cleanText(admin.openid, 128),
    role: cleanText(admin.role, 50),
    permissions: Array.isArray(admin.permissions) ? admin.permissions.slice() : [],
    status: admin.status === "disabled" ? "disabled" : "active",
    isActive: admin.isActive !== false,
    sourceClient: "miniprogram"
  };
}

function operationKey(event, randomId) {
  const supplied = cleanText(event && event.idempotencyKey, 180);
  if (supplied) return supplied;
  const generated = cleanText(randomId(), 128).replace(/[^A-Za-z0-9_.*:-]/g, "_");
  return `legacy_payment_${generated || crypto.randomUUID()}`;
}

function legacyInput(event = {}) {
  const remark = cleanText(event.remark, 300) || cleanText(event.paymentRemark, 300);
  return {
    orderId: cleanText(event.orderId, 128),
    paymentStatus: event.paymentStatus,
    isPartial: event.isPartial,
    paidAmount: event.paidAmount,
    paidAmountCents: event.paidAmountCents,
    remark,
    applyBatch: event.applyBatch,
    paymentMethod: event.paymentMethod
  };
}

function decisionFor(status) {
  return status === "unpaid" ? "reject" : status === "abnormal" ? "abnormal" : "confirm";
}

function validateLegacyAudits(logs, { operationId, seedOrderId, requestedStatus }) {
  if (!Array.isArray(logs) || !logs.length || logs.length > 100) throw new Error("legacy payment journals unavailable");
  const memberCount = logs[0] && logs[0].operationMemberCount;
  if (!Number.isSafeInteger(memberCount) || memberCount < 1 || memberCount > 100 || memberCount !== logs.length) {
    throw new Error("legacy payment journals incomplete");
  }
  const decision = decisionFor(requestedStatus);
  const indexes = new Set();
  const orderIds = new Set();
  const paymentIds = new Set();
  const businessKeys = new Set();
  for (const log of logs) {
    const orderId = cleanText(log && log.orderId, 128);
    const paymentId = cleanText(log && log.resourceId, 128);
    const index = log && log.operationMemberIndex;
    const childOperationId = `${operationId}:${orderId}`;
    const businessKey = `payment_mutation:${childOperationId}:${paymentId}:${decision}`;
    const journal = log && log.journal || {};
    const journalPayment = journal.payment || {};
    const journalOrder = journal.order || {};
    const journalResult = journal.result || {};
    const invalid = [
      cleanText(log && log.rootOperationId, 180) !== operationId,
      cleanText(log && log.operationKind, 40) !== "legacy_payment",
      log && log.operationMemberCount !== memberCount,
      !Number.isSafeInteger(index) || index < 0 || index >= memberCount,
      cleanText(log && log.operationSeedOrderId, 128) !== seedOrderId,
      cleanText(log && log.requestedPaymentStatus, 40) !== requestedStatus,
      cleanText(log && log.sourceId, 320) !== childOperationId,
      cleanText(log && log.decision, 20) !== decision,
      cleanText(log && log.businessKey, 512) !== businessKey,
      journal.schemaVersion !== 1,
      cleanText(journalPayment.id, 128) !== paymentId,
      cleanText(journalPayment.orderId, 128) !== orderId,
      cleanText(journalOrder.id, 128) !== orderId,
      cleanText(journalOrder.latestPaymentRecordId, 128) !== paymentId,
      cleanText(journalResult.paymentId, 128) !== paymentId,
      journalResult.updatedCount !== memberCount,
      !orderId,
      !paymentId
    ];
    if (invalid.some(Boolean) || indexes.has(index) || orderIds.has(orderId) || paymentIds.has(paymentId) || businessKeys.has(businessKey)) {
      throw new Error("legacy payment journals conflict");
    }
    indexes.add(index);
    orderIds.add(orderId);
    paymentIds.add(paymentId);
    businessKeys.add(businessKey);
  }
  for (let index = 0; index < memberCount; index += 1) {
    if (!indexes.has(index)) throw new Error("legacy payment journals incomplete");
  }
  return logs.slice().sort((left, right) => left.operationMemberIndex - right.operationMemberIndex);
}

async function readSeedOrder(db, orderId) {
  const response = await db.collection("orders").doc(orderId).get();
  return response && response.data || null;
}

function contextFromSeed(seed, seedOrderId, updatedCount, exact, warning) {
  return {
    orderId: seedOrderId,
    orderIds: [seedOrderId],
    updatedCount: Number.isSafeInteger(updatedCount) && updatedCount > 0 ? updatedCount : 1,
    paymentBatchId: cleanText(seed && seed.paymentBatchId, 128),
    userId: cleanText(seed && seed.userId, 128),
    userOpenid: cleanText(seed && (seed.userOpenid || seed.openid), 128),
    exact,
    warning
  };
}

async function loadLegacyContext({ db, operationId, seedOrderId, requestedStatus, updatedCount }) {
  let seed = null;
  try {
    const response = await db.collection("admin_operation_logs")
      .where({ rootOperationId: operationId, operationKind: "legacy_payment" })
      .limit(101)
      .get();
    const logs = validateLegacyAudits(response && response.data, { operationId, seedOrderId, requestedStatus });
    seed = await readSeedOrder(db, seedOrderId);
    if (!seed) throw new Error("seed order unavailable");
    return {
      orderId: seedOrderId,
      orderIds: logs.map((log) => cleanText(log.orderId, 128)),
      updatedCount: logs.length,
      paymentBatchId: cleanText(seed.paymentBatchId, 128),
      userId: cleanText(seed.userId, 128),
      userOpenid: cleanText(seed.userOpenid || seed.openid, 128),
      exact: true,
      warning: ""
    };
  } catch (_) {
    if (!seed) {
      try {
        seed = await readSeedOrder(db, seedOrderId);
      } catch (_) {
        seed = null;
      }
    }
    return contextFromSeed(seed, seedOrderId, updatedCount, false, CONTEXT_WARNING);
  }
}

function paymentStatusFrom(result, requestedStatus) {
  const status = cleanText(result && result.status, 40);
  if (status === "rejected") return "unpaid";
  return LEGACY_STATUSES.has(status) ? status : requestedStatus;
}

function errorEnvelope(error) {
  const response = { ok: false, message: error && error.message || "更新付款状态失败" };
  if (error && error.code) response.code = error.code;
  return response;
}

async function refreshPurchaseStats(callFunction, orderIds) {
  try {
    const response = await callFunction("updateUserPurchaseStats", { orderIds: orderIds.slice() });
    return response && response.result && response.result.data || null;
  } catch (error) {
    return { success: false, warning: cleanText(error && error.message, 240) || "updateUserPurchaseStats failed" };
  }
}

function createHandler({ service, requirePermission, db, callFunction, randomId = () => crypto.randomUUID() } = {}) {
  if (!service || typeof service.updateLegacyPayment !== "function") throw new Error("payment mutation service is required");
  if (typeof requirePermission !== "function") throw new Error("permission helper is required");
  if (!db || typeof db.collection !== "function") throw new Error("database is required");
  if (typeof callFunction !== "function") throw new Error("cloud function caller is required");
  if (typeof randomId !== "function") throw new Error("random id helper is required");

  return async function adminUpdatePayment(event = {}) {
    const orderId = cleanText(event.orderId, 128);
    if (!orderId) return { ok: false, code: "ORDER_ID_REQUIRED", message: "缺少订单 ID" };
    try {
      const admin = await requirePermission("payment:confirm");
      const key = operationKey(event, randomId);
      const input = legacyInput({ ...event, orderId });
      const result = await service.updateLegacyPayment({
        actor: actorFromAdmin(admin),
        input,
        idempotencyKey: key,
        allowMissingIdempotencyKey: false
      });
      const requestedStatus = normalizedRequestedStatus(input);
      const context = await loadLegacyContext({
        db,
        operationId: key,
        seedOrderId: orderId,
        requestedStatus,
        updatedCount: result && result.updatedCount
      });
      const purchaseStatsResult = await refreshPurchaseStats(callFunction, context.orderIds);
      const data = {
        orderId: context.orderId,
        orderIds: context.orderIds,
        updatedCount: context.updatedCount,
        paymentBatchId: context.paymentBatchId,
        userId: context.userId,
        userOpenid: context.userOpenid,
        paymentStatus: paymentStatusFrom(result, requestedStatus),
        purchaseStatsResult
      };
      if (context.warning) data.warning = context.warning;
      return { ok: true, data };
    } catch (error) {
      return errorEnvelope(error);
    }
  };
}

module.exports = {
  CONTEXT_WARNING,
  actorFromAdmin,
  createHandler,
  legacyInput,
  loadLegacyContext,
  normalizedRequestedStatus,
  validateLegacyAudits
};
