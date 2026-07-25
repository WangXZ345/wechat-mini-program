"use strict";

const MAX_ORDER_ITEMS = 100;

class OrderApprovalError extends Error {
  constructor(code, message, statusCode = 409, details) {
    super(message);
    this.name = "OrderApprovalError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function normalizeReviewItems(items) {
  if (!Array.isArray(items) || !items.length) {
    throw new OrderApprovalError("ORDER_ITEMS_REQUIRED", "订单缺少商品明细");
  }
  if (items.length > MAX_ORDER_ITEMS) {
    throw new OrderApprovalError("ORDER_ITEMS_LIMIT_EXCEEDED", "订单商品明细过多，暂不能审核", 503);
  }
  const grouped = new Map();
  for (const item of items) {
    const productId = cleanString(item && item.productId, 128);
    if (!productId) throw new OrderApprovalError("ORDER_ITEM_INVALID", "订单商品缺少商品 ID");
    const quantity = item && item.quantity;
    if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new OrderApprovalError("ORDER_ITEM_QUANTITY_INVALID", "订单商品数量无效");
    }
    const previous = grouped.get(productId);
    const totalQuantity = (previous ? previous.quantity : 0) + quantity;
    if (!Number.isSafeInteger(totalQuantity) || totalQuantity <= 0) {
      throw new OrderApprovalError("ORDER_ITEM_QUANTITY_INVALID", "订单商品数量无效");
    }
    grouped.set(productId, { productId, quantity: totalQuantity });
  }
  return Array.from(grouped.values());
}

function normalizeOrderAmount(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderApprovalError("ORDER_AMOUNT_INVALID", "订单金额数据异常，暂不能审核");
  }
  return value;
}

function versionOf(row = {}) {
  const value = row.version === undefined || row.version === null || row.version === "" ? 0 : row.version;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderApprovalError("DATA_VERSION_INVALID", "订单版本数据异常，暂不能审核");
  }
  return value;
}

function nextVersionOf(row = {}) {
  const currentVersion = versionOf(row);
  if (currentVersion >= Number.MAX_SAFE_INTEGER) {
    throw new OrderApprovalError("DATA_VERSION_INVALID", "订单版本数据异常，暂不能审核");
  }
  return currentVersion + 1;
}

function safeStoredAmount(value) {
  return normalizeOrderAmount(value === undefined || value === null || value === "" ? 0 : value);
}

function accountAmount(row, primary, fallback) {
  const value = row && row[primary] !== undefined && row[primary] !== null
    ? row[primary]
    : row && row[fallback];
  return safeStoredAmount(value);
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new OrderApprovalError("DATE_INVALID", "订单审核时间无效", 500);
  }
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function accountBusinessKey(orderId) {
  const id = cleanString(orderId, 128);
  if (!id) throw new OrderApprovalError("ORDER_ID_REQUIRED", "缺少订单 ID", 400);
  return `order_debt:${id}`;
}

function validateAccountLog(log, order, amount) {
  const conflicts = [
    cleanString(log.businessKey, 180) !== accountBusinessKey(order._id),
    cleanString(log.sourceType, 80) !== "order",
    cleanString(log.sourceId, 128) !== cleanString(order._id, 128),
    cleanString(log.relatedOrderId, 128) !== cleanString(order._id, 128),
    cleanString(log.relatedPaymentRecordId, 128) !== "",
    cleanString(log.changeType, 80) !== "order_approved",
    log.changeAmount !== amount,
    Boolean(order.userId) && cleanString(log.userId, 128) !== cleanString(order.userId, 128),
    Boolean(order.userOpenid || order.openid)
      && cleanString(log.userOpenid, 128) !== cleanString(order.userOpenid || order.openid, 128)
  ];
  if (conflicts.some(Boolean)) {
    throw new OrderApprovalError("ACCOUNT_LOG_CONFLICT", "历史账款流水与订单不一致");
  }
}

function accountLogEvidenceKey(log = {}) {
  const id = cleanString(log._id, 128);
  if (id) return `id:${id}`;
  return `fields:${JSON.stringify([
    cleanString(log.businessKey, 180),
    cleanString(log.sourceType, 80),
    cleanString(log.sourceId, 128),
    cleanString(log.userId, 128),
    cleanString(log.userOpenid, 128),
    cleanString(log.relatedOrderId, 128),
    cleanString(log.relatedPaymentRecordId, 128),
    cleanString(log.changeType, 80),
    log.changeAmount
  ])}`;
}

function mergeAccountLogEvidence(...groups) {
  const evidence = new Map();
  for (const group of groups) {
    for (const log of Array.isArray(group) ? group : []) {
      evidence.set(accountLogEvidenceKey(log), log);
    }
  }
  return Array.from(evidence.values());
}

function hasCanonicalAccountLogMetadata(log, order) {
  const requiredFields = [
    "businessKey",
    "sourceType",
    "sourceId",
    "relatedOrderId",
    "relatedPaymentRecordId",
    "changeType",
    "changeAmount"
  ];
  if (order.userId) requiredFields.push("userId");
  if (order.userOpenid || order.openid) requiredFields.push("userOpenid");
  return cleanString(log.businessKey, 180) === accountBusinessKey(order._id)
    && requiredFields.every((field) => Object.prototype.hasOwnProperty.call(log, field));
}

async function findAccount(store, order) {
  if (order.userId) {
    const byUserId = await store.collection("customer_accounts").where({ userId: order.userId }).limit(1).get();
    if (byUserId.data && byUserId.data[0]) return byUserId.data[0];
  }
  const userOpenid = order.userOpenid || order.openid;
  if (userOpenid) {
    const byOpenid = await store.collection("customer_accounts").where({ userOpenid }).limit(1).get();
    if (byOpenid.data && byOpenid.data[0]) return byOpenid.data[0];
  }
  return null;
}

function normalizeOperator(actor = {}) {
  return {
    id: cleanString(actor.id || actor._id || actor.openid || "system", 128) || "system",
    openid: cleanString(actor.openid, 128),
    role: cleanString(actor.role || "system", 50) || "system"
  };
}

async function includeApprovedOrderInTransaction({
  store,
  order,
  actor = {},
  amount,
  timestamp,
  calendarDate,
  remark = "订单批准计入客户账款"
} = {}) {
  if (!store || typeof store.collection !== "function") {
    throw new Error("order approval transaction store is required");
  }
  if (!order || !cleanString(order._id, 128)) {
    throw new OrderApprovalError("ORDER_ID_REQUIRED", "缺少订单 ID", 400);
  }
  const safeAmount = normalizeOrderAmount(amount);
  const businessKey = accountBusinessKey(order._id);
  const priorLogs = await store.collection("account_logs").where({ businessKey }).limit(2).get();
  const legacyResult = await store.collection("account_logs")
    .where({
      relatedOrderId: cleanString(order._id, 128),
      changeType: "order_approved"
    })
    .limit(2)
    .get();
  const logs = mergeAccountLogEvidence(priorLogs.data, legacyResult.data);
  if (logs.length > 1) {
    throw new OrderApprovalError("ACCOUNT_LOG_DUPLICATE", "订单账款流水重复，暂不能继续审核");
  }
  if (logs[0]) {
    if (!hasCanonicalAccountLogMetadata(logs[0], order)) {
      throw new OrderApprovalError(
        "ACCOUNT_LOG_LEGACY_CONFLICT",
        "检测到缺少规范幂等元数据的历史账款流水，暂不能继续审核"
      );
    }
    validateAccountLog(logs[0], order, safeAmount);
    return { reused: true, businessKey };
  }
  if (order.accountIncluded === true) {
    throw new OrderApprovalError(
      "ORDER_ACCOUNT_STATE_CONFLICT",
      "订单审核与账款状态不一致，暂不能继续审核"
    );
  }

  const account = await findAccount(store, order);
  const beforeTotalOrder = accountAmount(account, "totalOrderAmount", "totalReceivableAmount");
  const beforeTotalPaid = accountAmount(account, "totalPaidAmount", "paidAmount");
  const beforeTotalUnpaid = accountAmount(account, "totalUnpaidAmount", "unpaidAmount");
  const afterTotalOrder = beforeTotalOrder + safeAmount;
  const afterTotalUnpaid = beforeTotalUnpaid + safeAmount;
  if (!Number.isSafeInteger(afterTotalOrder) || !Number.isSafeInteger(afterTotalUnpaid)) {
    throw new OrderApprovalError("ACCOUNT_AMOUNT_INVALID", "客户账款数据异常，暂不能审核");
  }
  const todayDate = localDateKey(calendarDate === undefined ? timestamp : calendarDate);
  if (account) {
    const sameDay = cleanString(account.todayDate, 20) === todayDate;
    const todayOrderAmount = (sameDay ? accountAmount(account, "todayOrderAmount", "todayOrderAmount") : 0) + safeAmount;
    await store.collection("customer_accounts").doc(account._id).update({ data: {
      totalOrderAmount: afterTotalOrder,
      totalReceivableAmount: afterTotalOrder,
      totalUnpaidAmount: afterTotalUnpaid,
      unpaidAmount: afterTotalUnpaid,
      todayOrderAmount,
      todayDate,
      orderCount: safeStoredAmount(account.orderCount) + 1,
      unpaidOrderCount: safeStoredAmount(account.unpaidOrderCount) + 1,
      lastOrderAt: timestamp,
      isSettled: false,
      updatedAt: timestamp
    } });
  } else {
    await store.collection("customer_accounts").add({ data: {
      userId: cleanString(order.userId, 128),
      userOpenid: cleanString(order.userOpenid || order.openid, 128),
      nickname: cleanString(order.nickname || order.customerName, 120),
      phone: cleanString(order.phone || order.customerPhone, 40),
      totalOrderAmount: safeAmount,
      totalReceivableAmount: safeAmount,
      totalPaidAmount: 0,
      paidAmount: 0,
      totalUnpaidAmount: safeAmount,
      unpaidAmount: safeAmount,
      todayOrderAmount: safeAmount,
      todayDate,
      historyUnpaidAmount: 0,
      pendingConfirmAmount: 0,
      abnormalAmount: 0,
      abnormalCount: 0,
      orderCount: 1,
      unpaidOrderCount: 1,
      paidOrderCount: 0,
      partialPaidOrderCount: 0,
      lastOrderAt: timestamp,
      lastPaymentAt: null,
      riskLevel: "normal",
      isSettled: false,
      adminRemark: "",
      adminNote: "",
      adminTags: [],
      createdAt: timestamp,
      updatedAt: timestamp
    } });
  }

  const operator = normalizeOperator(actor);
  await store.collection("account_logs").add({ data: {
    businessKey,
    sourceType: "order",
    sourceId: cleanString(order._id, 128),
    userId: cleanString(order.userId, 128),
    userOpenid: cleanString(order.userOpenid || order.openid, 128),
    relatedOrderId: cleanString(order._id, 128),
    relatedPaymentRecordId: "",
    changeType: "order_approved",
    beforeTotalOrderAmount: beforeTotalOrder,
    afterTotalOrderAmount: afterTotalOrder,
    beforeTotalPaidAmount: beforeTotalPaid,
    afterTotalPaidAmount: beforeTotalPaid,
    beforeTotalUnpaidAmount: beforeTotalUnpaid,
    afterTotalUnpaidAmount: afterTotalUnpaid,
    changeAmount: safeAmount,
    operatorId: operator.id,
    operatorOpenid: operator.openid,
    operatorRole: operator.role,
    remark: cleanString(remark, 120),
    createdAt: timestamp
  } });
  return { reused: false, businessKey };
}

module.exports = {
  MAX_ORDER_ITEMS,
  OrderApprovalError,
  accountBusinessKey,
  normalizeReviewItems,
  normalizeOrderAmount,
  versionOf,
  nextVersionOf,
  validateAccountLog,
  includeApprovedOrderInTransaction
};
