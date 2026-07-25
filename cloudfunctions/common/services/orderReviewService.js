"use strict";

const crypto = require("crypto");
const path = require("path");
const { applyInventoryMutationInTransaction: canonicalInventoryMutation } = require("./inventoryMutationService");
const {
  MAX_ORDER_ITEMS,
  includeApprovedOrderInTransaction,
  normalizeReviewItems: normalizeSharedReviewItems,
  normalizeOrderAmount: normalizeSharedOrderAmount,
  versionOf: sharedVersionOf,
  nextVersionOf: sharedNextVersionOf
} = require("./orderApprovalService");
const policyDirectory = path.basename(__dirname) === "services"
  ? path.join(__dirname, "..")
  : __dirname;
const orderStatusPolicy = require(path.join(policyDirectory, "orderStatusPolicy"));
const {
  canReviewOrder,
  isApprovedOrder,
  isApprovedOrderStatus,
  isTerminalReviewStatus
} = orderStatusPolicy;
const SYNC_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_RECALCULATION_WARNING = "订单已审核，客户账款汇总将在稍后更新";

class OrderReviewError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "OrderReviewError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function hasPermission(actor, permission) {
  if (!actor || actor.status !== "active" || actor.isActive === false) return false;
  if (actor.role === "super_admin") return true;
  return Array.isArray(actor.permissions) && (actor.permissions.includes("*") || actor.permissions.includes(permission));
}

function normalizeReviewActor(actor = {}, decision) {
  const id = cleanString(actor.id || actor._id || actor.openid, 128);
  const role = cleanString(actor.role, 50);
  if (!id || !role || actor.status !== "active" || actor.isActive === false) {
    throw new OrderReviewError("INVALID_ACTOR", "管理员身份无效", 403);
  }
  const permission = decision === "reject" ? "order:reject" : "order:review";
  if (!hasPermission(actor, permission)) throw new OrderReviewError("FORBIDDEN", "无权执行订单审核操作", 403);
  return {
    id,
    openid: cleanString(actor.openid, 128),
    role,
    permissions: Array.isArray(actor.permissions) ? actor.permissions.slice() : [],
    status: "active",
    isActive: true,
    sourceClient: actor.sourceClient === "miniprogram" ? "miniprogram" : "admin_web"
  };
}

function normalizeExpectedVersion(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new OrderReviewError("EXPECTED_VERSION_REQUIRED", "缺少订单版本，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderReviewError("EXPECTED_VERSION_INVALID", "订单版本无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeExpectedStatus(value, required) {
  const status = cleanString(value, 60);
  if (!status) {
    if (required) throw new OrderReviewError("EXPECTED_STATUS_REQUIRED", "缺少订单当前状态，请刷新后重试", 400);
    return undefined;
  }
  if (!canReviewOrder(status)) throw new OrderReviewError("EXPECTED_STATUS_INVALID", "订单当前状态无效", 400);
  return status;
}

function normalizeReviewInput(input = {}, options = {}) {
  const strict = options.strict === true;
  const allowed = new Set(["id", "orderId", "decision", "action", "expectedVersion", "expectedStatus", "reason"]);
  if (strict) {
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new OrderReviewError("UNKNOWN_FIELD", "订单审核请求包含未知字段", 400, { field: key });
  }
  const id = cleanString(input.id || input.orderId, 128);
  if (!id) throw new OrderReviewError("ORDER_ID_REQUIRED", "缺少订单 ID", 400);
  const decision = cleanString(input.decision || (input.action === "approve" ? "approve" : input.action === "reject" ? "reject" : ""), 20);
  if (!['approve', 'reject'].includes(decision)) throw new OrderReviewError("DECISION_INVALID", "审核操作无效", 400);
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion, strict);
  const expectedStatus = normalizeExpectedStatus(input.expectedStatus, strict);
  const reason = input.reason === undefined || input.reason === null ? "" : cleanString(input.reason, 300);
  if (input.reason !== undefined && typeof input.reason !== "string") throw new OrderReviewError("REASON_INVALID", "审核原因格式无效", 400);
  if (strict && decision === "reject" && !reason) throw new OrderReviewError("REASON_REQUIRED", "请填写驳回原因", 400);
  return { id, decision, expectedVersion, expectedStatus, reason };
}

function normalizeReviewItems(items) {
  return normalizeSharedReviewItems(items);
}

function normalizeOrderAmount(value) {
  return normalizeSharedOrderAmount(value);
}

function versionOf(row = {}) {
  return sharedVersionOf(row);
}

function safeStoredAmount(value) {
  return normalizeOrderAmount(value === undefined || value === null || value === "" ? 0 : value);
}

function missingDocument(error) {
  return /not exist|not found|ResourceNotFound|DOCUMENT_NOT_EXIST/i.test(String(error && error.message || error || ""));
}

function deterministicKey(prefix, value) {
  return `${prefix}:${crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40)}`;
}

function resultItem(order, decision, reused = false) {
  return {
    id: cleanString(order._id, 128),
    orderNo: cleanString(order.orderNo, 100),
    status: cleanString(order.status, 60),
    reviewType: cleanString(order.reviewType, 40),
    paymentStatus: cleanString(order.paymentStatus, 60),
    version: versionOf(order),
    updatedAt: order.updatedAt || null,
    decision,
    reused
  };
}

function reviewResult(order, decision, options = {}) {
  return {
    item: resultItem(order, decision, options.reused === true),
    affected: options.affected === 1 ? 1 : 0,
    reused: options.reused === true,
    decision,
    requestId: cleanString(options.requestId, 160),
    status: cleanString(order.status, 60),
    userId: cleanString(order.userId, 128),
    userOpenid: cleanString(order.userOpenid || order.openid, 128)
  };
}

function createOrderReviewService({
  db,
  command,
  stockAlert: stock,
  idempotency: idem,
  now = () => new Date(),
  applyInventoryMutationInTransaction = canonicalInventoryMutation,
  ownerKeyFor,
  syncOwnerPepper = "",
  recalculateAccount
} = {}) {
  function assertDb() {
    if (!db || !command) throw new Error("order review service requires db and command");
  }

  async function ensureCollections() {
    if (!idem || typeof idem.ensureCollection !== "function") return;
    for (const name of ["inventory_logs", "stock_alert_records", "admin_operation_logs", "sync_events", "account_logs"]) {
      await idem.ensureCollection(db, name);
    }
  }

  async function readItems(tx, order) {
    const response = await tx.collection("order_items").where({ orderId: order._id }).limit(MAX_ORDER_ITEMS + 1).get();
    const rows = Array.isArray(response.data) ? response.data : [];
    if (rows.length > MAX_ORDER_ITEMS) throw new OrderReviewError("ORDER_ITEMS_LIMIT_EXCEEDED", "订单商品明细过多，暂不能审核", 503);
    if (rows.length) return rows;
    if (!order.productId) throw new OrderReviewError("ORDER_ITEMS_REQUIRED", "订单缺少商品明细", 409);
    return [{ productId: order.productId, quantity: order.quantity, unitPrice: order.unitPrice, totalAmount: order.totalAmount }];
  }

  async function recoverCommittedResult({ operationId, orderId, decision }) {
    const businessKey = `order_review:${operationId}:${orderId}:${decision}`;
    const logs = await db.collection("admin_operation_logs").where({ businessKey }).limit(1).get();
    if (!logs.data || !logs.data[0]) return null;
    const current = (await db.collection("orders").doc(orderId).get()).data;
    if (!current) return null;
    return reviewResult(current, decision, { affected: 0, reused: true, requestId: logs.data[0].sourceId || operationId });
  }

  function ownerKey(order) {
    if (typeof ownerKeyFor !== "function") throw new OrderReviewError("SYNC_OWNER_CONFIG_REQUIRED", "订单同步安全配置不完整", 503);
    const subject = cleanString(order.userOpenid || order.openid || order.userId, 256);
    const key = cleanString(ownerKeyFor(subject, syncOwnerPepper), 128);
    if (!key) throw new OrderReviewError("SYNC_OWNER_CONFIG_REQUIRED", "订单同步安全配置不完整", 503);
    return key;
  }

  async function writeOrderEvent(tx, { order, actor, businessKey, decision, timestamp, version }) {
    await tx.collection("sync_events").add({ data: {
      eventId: deterministicKey("order_review_event", businessKey),
      eventType: "order.status_changed",
      entityType: "order",
      entityId: order._id,
      action: decision,
      version,
      changedFields: decision === "reject" ? ["status", "reviewType", "version", "updatedAt"] : ["status", "paymentStatus", "version", "updatedAt"],
      actorType: "admin",
      actorRole: actor.role,
      sourceClient: actor.sourceClient,
      businessKey,
      audience: "owner",
      ownerKey: ownerKey(order),
      createdAt: timestamp,
      expiresAt: new Date(now().getTime() + SYNC_EVENT_TTL_MS)
    } });
  }

  async function includeAccount(tx, { order, actor, amount, timestamp }) {
    return includeApprovedOrderInTransaction({
      store: tx,
      order,
      actor,
      amount,
      timestamp,
      calendarDate: now()
    });
  }

  async function hasInventoryReplayCandidate(tx, orderId, productId) {
    const businessKey = `order_deduct:${orderId}:${productId}`;
    const response = await tx.collection("inventory_logs").where({ businessKey }).limit(1).get();
    return Array.isArray(response.data) && response.data.length > 0;
  }

  async function execute({ actor, input, idempotencyKey, operationId }) {
    const businessKey = `order_review:${operationId}:${input.id}:${input.decision}`;
    return db.runTransaction(async (tx) => {
      const orderResult = await tx.collection("orders").doc(input.id).get();
      const order = orderResult && orderResult.data;
      if (!order) throw new OrderReviewError("ORDER_NOT_FOUND", "订单不存在", 404);
      const currentVersion = versionOf(order);
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) throw new OrderReviewError("DATA_VERSION_CONFLICT", "订单已变化，请刷新后重试", 409);
      if (input.expectedStatus !== undefined && input.expectedStatus !== order.status) throw new OrderReviewError("DATA_VERSION_CONFLICT", "订单状态已变化，请刷新后重试", 409);

      if (input.decision === "reject") {
        if (order.status === "rejected") return reviewResult(order, "reject", { affected: 0, reused: true, requestId: operationId });
        if (isApprovedOrder(order.status, order.paymentStatus)) throw new OrderReviewError("ORDER_ALREADY_APPROVED", "已通过订单不能拒绝", 409);
        if (!canReviewOrder(order.status)) throw new OrderReviewError("ORDER_STATUS_INVALID", "当前订单状态不能审核", 409);
        const nextVersion = sharedNextVersionOf(order);
        const next = { ...order, status: "rejected", reviewType: "manual", rejectedAt: db.serverDate ? db.serverDate() : now(), rejectedBy: actor.id, version: nextVersion, updatedAt: db.serverDate ? db.serverDate() : now() };
        await tx.collection("orders").doc(input.id).update({ data: { status: next.status, reviewType: next.reviewType, rejectedAt: next.rejectedAt, rejectedBy: next.rejectedBy, version: next.version, updatedAt: next.updatedAt } });
        await tx.collection("admin_operation_logs").add({ data: { businessKey, sourceId: operationId, idempotencyKey: idempotencyKey || "", action: "order_reject", resourceType: "order", resourceId: input.id, beforeData: { status: order.status, version: currentVersion }, afterData: { status: next.status, version: next.version }, operatorId: actor.id, operatorOpenid: actor.openid, operatorRole: actor.role, reason: input.reason, status: "success", createdAt: next.updatedAt } });
        await writeOrderEvent(tx, { order, actor, businessKey, decision: "reject", timestamp: next.updatedAt, version: next.version });
        return reviewResult(next, "reject", { affected: 1, reused: false, requestId: operationId });
      }

      if (isApprovedOrderStatus(order.status)) return reviewResult(order, "approve", { affected: 0, reused: true, requestId: operationId });
      if (isTerminalReviewStatus(order.status)) throw new OrderReviewError("ORDER_STATUS_INVALID", "已拒绝或已取消订单不能审核通过", 409);
      if (!canReviewOrder(order.status)) throw new OrderReviewError("ORDER_STATUS_INVALID", "当前订单状态不能审核", 409);

      const nextVersion = sharedNextVersionOf(order);
      const amount = safeStoredAmount(order.totalAmount);
      const items = await readItems(tx, order);
      const grouped = normalizeReviewItems(items);
      for (const item of grouped) {
        if (await hasInventoryReplayCandidate(tx, input.id, item.productId)) continue;
        let product;
        try { product = (await tx.collection("products").doc(item.productId).get()).data; } catch (error) { if (!missingDocument(error)) throw error; }
        if (!product || product.isDeleted === true) throw new OrderReviewError("PRODUCT_NOT_FOUND", "订单商品不存在", 409);
        if (product.isActive === false) throw new OrderReviewError("PRODUCT_INACTIVE", "订单商品已下架，不能审核", 409);
        if (typeof product.stock !== "number" || !Number.isSafeInteger(product.stock) || product.stock < item.quantity) throw new OrderReviewError("INSUFFICIENT_STOCK", "库存不足，不能通过订单", 409);
      }

      const timestamp = db.serverDate ? db.serverDate() : now();
      for (const item of grouped) {
        const inventoryResult = await applyInventoryMutationInTransaction({
          db,
          store: tx,
          stockAlert: stock,
          input: {
            productId: item.productId,
            mode: "delta",
            delta: -item.quantity,
            reason: order.orderType === "cart" ? "admin_cart_order_approved" : "admin_order_approved"
          },
          actor,
          context: {
            businessKey: `order_deduct:${input.id}:${item.productId}`,
            sourceType: "order",
            sourceId: input.id,
            relatedOrderId: input.id,
            idempotencyKey: idempotencyKey || "",
            reasonCode: order.orderType === "cart" ? "admin_cart_order_approved" : "admin_order_approved",
            operationReason: "订单审核通过扣减库存",
            writeAudit: false,
            writeSync: true,
            now: now()
          }
        });
        if (inventoryResult.changed !== false) {
          const product = (await tx.collection("products").doc(item.productId).get()).data;
          const totalSales = Number(product.totalSales || 0) + item.quantity;
          if (!Number.isSafeInteger(totalSales) || totalSales < 0) throw new OrderReviewError("PRODUCT_SALES_INVALID", "商品销量数据异常，暂不能审核", 409);
          await tx.collection("products").doc(item.productId).update({ data: { totalSales, lastSoldAt: timestamp } });
        }
      }
      for (const item of items) if (item._id) await tx.collection("order_items").doc(item._id).update({ data: { stockCheckStatus: "enough" } });

      await includeAccount(tx, { order, actor, amount, timestamp });
      const next = { ...order, status: "approved_pending_payment", reviewType: "manual", paymentStatus: "unpaid", paidAmount: 0, unpaidAmount: amount, accountIncluded: true, accountRecalculationPending: true, version: nextVersion, approvedAt: timestamp, updatedAt: timestamp };
      await tx.collection("orders").doc(input.id).update({ data: { status: next.status, reviewType: next.reviewType, paymentStatus: next.paymentStatus, paidAmount: next.paidAmount, unpaidAmount: next.unpaidAmount, accountIncluded: true, accountRecalculationPending: true, version: next.version, approvedAt: next.approvedAt, updatedAt: next.updatedAt } });
      await tx.collection("admin_operation_logs").add({ data: { businessKey, sourceId: operationId, idempotencyKey: idempotencyKey || "", action: "order_approve", resourceType: "order", resourceId: input.id, beforeData: { status: order.status, version: currentVersion }, afterData: { status: next.status, version: next.version }, operatorId: actor.id, operatorOpenid: actor.openid, operatorRole: actor.role, status: "success", createdAt: timestamp } });
      await writeOrderEvent(tx, { order, actor, businessKey, decision: "approve", timestamp, version: next.version });
      return reviewResult(next, "approve", { affected: 1, reused: false, requestId: operationId });
    });
  }

  async function reviewOrder(commandInput = {}) {
    assertDb();
    const strict = commandInput.strict !== false;
    const input = normalizeReviewInput(commandInput.input, { strict });
    const actor = normalizeReviewActor(commandInput.actor, input.decision);
    await ensureCollections();
    let key = cleanString(commandInput.idempotencyKey, 180);
    let operationId = key;
    if (key && idem && typeof idem.assertIdempotencyKey === "function") key = idem.assertIdempotencyKey(key);
    if (!key) {
      if (strict) throw new OrderReviewError("IDEMPOTENCY_KEY_REQUIRED", "缺少操作凭证，请刷新后重试", 400);
      operationId = `legacy_${crypto.randomUUID()}`;
    }
    const outcome = !key
      ? { ok: true, data: await execute({ actor, input, idempotencyKey: "", operationId }) }
      : idem && typeof idem.runIdempotentAction === "function"
        ? await idem.runIdempotentAction({ db, actionType: `order_${input.decision}`, idempotencyKey: key, operatorIdentity: actor.id, operatorType: "admin", scope: "order", scopeId: input.id, openid: actor.openid, adminId: actor.id, payload: input, recoverProcessingResult: () => recoverCommittedResult({ operationId: key, orderId: input.id, decision: input.decision }) }, () => execute({ actor, input, idempotencyKey: key, operationId: key }))
        : { ok: true, data: await execute({ actor, input, idempotencyKey: key, operationId: key }) };
    if (!outcome || outcome.ok !== true) {
      const code = cleanString(outcome && outcome.code, 80) || "IDEMPOTENCY_FAILED";
      throw new OrderReviewError(code, cleanString(outcome && outcome.message, 240) || "审核操作未完成", code === "IDEMPOTENCY_PROCESSING" || code === "IDEMPOTENCY_KEY_CONFLICT" ? 409 : 400);
    }
    if (input.decision === "approve" && typeof recalculateAccount === "function") {
      try {
        const recalculated = await recalculateAccount({ userId: outcome.data.userId, userOpenid: outcome.data.userOpenid, orderId: input.id });
        if ((recalculated && recalculated.ok === false) || (recalculated && recalculated.result && recalculated.result.ok === false)) {
          return { ...outcome.data, accountRecalculationPending: true, warning: ACCOUNT_RECALCULATION_WARNING };
        }
        await db.collection("orders").doc(input.id).update({ data: {
          accountRecalculationPending: false,
          accountRecalculatedAt: db.serverDate ? db.serverDate() : now(),
          updatedAt: db.serverDate ? db.serverDate() : now()
        } });
      } catch (_) {
        return { ...outcome.data, accountRecalculationPending: true, warning: ACCOUNT_RECALCULATION_WARNING };
      }
    }
    return outcome.data;
  }

  return { reviewOrder, normalizeReviewActor, normalizeReviewInput, normalizeReviewItems, normalizeOrderAmount };
}

const orderReviewExports = {
  MAX_ORDER_ITEMS,
  ACCOUNT_RECALCULATION_WARNING,
  OrderReviewError,
  createOrderReviewService,
  normalizeReviewActor,
  normalizeReviewInput,
  normalizeReviewItems,
  normalizeOrderAmount
};

Object.defineProperty(orderReviewExports, "ORDER_REVIEW_STATUSES", {
  enumerable: true,
  get() {
    return orderStatusPolicy.MANUAL_REVIEWABLE_STATUSES;
  }
});

module.exports = orderReviewExports;
