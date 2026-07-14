const crypto = require("crypto");

const USER_CANCELABLE_STATUSES = new Set(["pending_admin", "auto_reviewing"]);
const ADMIN_CANCELABLE_STATUSES = new Set(["pending_admin", "auto_reviewing", "approved_pending_payment"]);
const PAID_STATUSES = new Set(["paid", "partial_paid"]);
const SHIPPED_STATUSES = new Set(["shipped", "completed", "picked_up"]);
const PAID_RECORD_STATUSES = new Set(["paid", "partial", "partial_paid"]);
const SYNC_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class OrderCancellationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "OrderCancellationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function safeInteger(value, field, { min = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) {
    throw new OrderCancellationError("INVENTORY_DATA_INVALID", `${field} 数据异常，暂不能取消订单`, 409);
  }
  return number;
}

function versionOf(value, entityName) {
  if (value === undefined || value === null || value === "") return 0;
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new OrderCancellationError("DATA_VERSION_INVALID", `${entityName}数据版本异常，暂不能取消`, 409);
  }
  return version;
}

function eventId(prefix, businessKey) {
  return `${prefix}:${crypto.createHash("sha256").update(businessKey).digest("hex").slice(0, 32)}`;
}

function missingDocument(err) {
  return /DOCUMENT_NOT_EXIST|document not exist|not found|ResourceNotFound/i
    .test(String(err && err.message || err || ""));
}

async function getDocument(store, collection, id) {
  try {
    return (await store.collection(collection).doc(id).get()).data || null;
  } catch (err) {
    if (missingDocument(err)) return null;
    throw err;
  }
}

function normalizeActor(actor = {}) {
  const id = cleanString(actor.id || actor._id || actor.openid, 128);
  const openid = cleanString(actor.openid, 128);
  if (!id || !openid) throw new OrderCancellationError("UNAUTHENTICATED", "登录状态无效", 401);
  const isAdmin = actor.kind === "admin";
  if (isAdmin && !["super_admin", "customer_service"].includes(actor.role)) {
    throw new OrderCancellationError("FORBIDDEN", "当前角色无权取消订单", 403);
  }
  return {
    id,
    openid,
    kind: isAdmin ? "admin" : "user",
    role: isAdmin ? cleanString(actor.role, 50) : "user",
    sourceClient: actor.sourceClient === "admin_web" ? "admin_web" : "miniprogram"
  };
}

function validateCancellation(order, actor) {
  if (order.status === "cancelled") return;
  if (actor.kind !== "admin" && order.userOpenid !== actor.openid) {
    throw new OrderCancellationError("FORBIDDEN", "无权取消此订单", 403);
  }
  const allowed = actor.kind === "admin" ? ADMIN_CANCELABLE_STATUSES : USER_CANCELABLE_STATUSES;
  if (!allowed.has(order.status)) {
    throw new OrderCancellationError("ORDER_NOT_CANCELABLE", "当前订单状态不能取消", 409);
  }

  const paidAmount = Number(order.paidAmount || 0);
  if (!Number.isFinite(paidAmount) || paidAmount < 0) {
    throw new OrderCancellationError("ORDER_PAYMENT_DATA_INVALID", "订单付款数据异常，暂不能取消", 409);
  }
  if (paidAmount > 0 || PAID_STATUSES.has(order.paymentStatus)) {
    throw new OrderCancellationError("ORDER_ALREADY_PAID", "订单已付款，不能取消", 409);
  }
  if (SHIPPED_STATUSES.has(order.deliveryStatus) || SHIPPED_STATUSES.has(order.shippingStatus)) {
    throw new OrderCancellationError("ORDER_ALREADY_SHIPPED", "订单已发货，不能取消", 409);
  }
}

function validateDeductionLog(log, orderId, productId) {
  const expectedKey = `order_deduct:${orderId}:${productId}`;
  if (!log || log.businessKey !== expectedKey || log.relatedOrderId !== orderId || log.productId !== productId) {
    throw new OrderCancellationError("INVENTORY_DEDUCTION_LOG_INVALID", "订单扣库存流水异常，暂不能取消", 409);
  }
  const beforeStock = safeInteger(log.beforeStock, "扣减前库存");
  const afterStock = safeInteger(log.afterStock, "扣减后库存");
  const changeAmount = safeInteger(log.changeAmount, "库存扣减数量", { min: Number.MIN_SAFE_INTEGER });
  if (changeAmount >= 0 || beforeStock + changeAmount !== afterStock) {
    throw new OrderCancellationError("INVENTORY_DEDUCTION_LOG_INVALID", "订单扣库存流水不一致，暂不能取消", 409);
  }
  return -changeAmount;
}

function validateRestoreLog(log, orderId, productId, quantity) {
  const expectedKey = `order_restore:${orderId}:${productId}`;
  if (!log || log.businessKey !== expectedKey || log.relatedOrderId !== orderId || log.productId !== productId) {
    throw new OrderCancellationError("INVENTORY_RESTORE_LOG_INVALID", "订单恢复库存流水异常，暂不能取消", 409);
  }
  const beforeStock = safeInteger(log.beforeStock, "恢复前库存");
  const afterStock = safeInteger(log.afterStock, "恢复后库存");
  const changeAmount = safeInteger(log.changeAmount, "库存恢复数量");
  if (changeAmount !== quantity || beforeStock + changeAmount !== afterStock) {
    throw new OrderCancellationError("INVENTORY_RESTORE_LOG_INVALID", "订单恢复库存流水不一致，暂不能取消", 409);
  }
}

async function uniqueBusinessLog(tx, businessKey, missingCode, missingMessage) {
  const result = await tx.collection("inventory_logs").where({ businessKey }).limit(2).get();
  const rows = result.data || [];
  if (!rows.length && missingCode) throw new OrderCancellationError(missingCode, missingMessage, 409);
  if (rows.length > 1) {
    throw new OrderCancellationError("INVENTORY_LOG_CONFLICT", "库存流水存在重复记录，暂不能取消订单", 409);
  }
  return rows[0] || null;
}

function recordTime(record = {}, fallback = 0) {
  const value = record.updatedAt || record.confirmedAt || record.createdAt;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value && typeof value === "object") {
    const nested = value.$date || value.date || value._date;
    const parsed = nested instanceof Date ? nested.getTime() : Date.parse(String(nested || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

async function validatePaymentRecords(tx, orderId) {
  const result = await tx.collection("payment_records").where({ orderId }).limit(100).get();
  const rows = (result.data || []).map((row, index) => ({ row, index }));
  if (!rows.length) return;
  if (rows.some(({ row }) => PAID_RECORD_STATUSES.has(row.status)
    || PAID_RECORD_STATUSES.has(row.paymentStatus)
    || row.confirmStatus === "confirmed")) {
    throw new OrderCancellationError("ORDER_ALREADY_PAID", "订单已有确认付款记录，不能取消", 409);
  }
  rows.sort((left, right) => {
    const timeDiff = recordTime(right.row, right.index) - recordTime(left.row, left.index);
    return timeDiff || right.index - left.index;
  });
  const latest = rows[0].row;
  if (latest.status === "pending_confirm" || latest.paymentStatus === "pending_confirm"
    || latest.confirmStatus === "pending" || latest.confirmStatus === "pending_confirm") {
    throw new OrderCancellationError("ORDER_PAYMENT_PENDING_CONFIRM", "订单有待确认付款凭证，暂不能取消", 409);
  }
}

async function orderProductIds(tx, orderId, order) {
  const result = await tx.collection("order_items").where({ orderId }).limit(100).get();
  const ids = (result.data || []).map((item) => cleanString(item.productId, 128)).filter(Boolean);
  if (order.productId) ids.push(cleanString(order.productId, 128));
  const unique = Array.from(new Set(ids));
  if (!unique.length) {
    throw new OrderCancellationError("ORDER_ITEMS_MISSING", "订单商品明细缺失，暂不能取消", 409);
  }
  return unique;
}

function createOrderCancellationService({ db, stockAlert, applyInventoryMutationInTransaction, now = () => new Date() } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("order cancellation service requires db.runTransaction");
  if (!stockAlert || typeof stockAlert.buildStockStatusUpdate !== "function" || typeof stockAlert.syncStockAlertRecord !== "function") {
    throw new Error("order cancellation service requires stockAlert helpers");
  }
  if (typeof applyInventoryMutationInTransaction !== "function") {
    throw new Error("order cancellation service requires applyInventoryMutationInTransaction");
  }

  async function restoreProduct(tx, { orderId, productId, actor, idempotencyKey }) {
    const deductionKey = `order_deduct:${orderId}:${productId}`;
    const deductionLog = await uniqueBusinessLog(
      tx,
      deductionKey,
      "INVENTORY_DEDUCTION_EVIDENCE_MISSING",
      "找不到订单扣库存流水，暂不能取消"
    );
    const quantity = validateDeductionLog(deductionLog, orderId, productId);
    const restoreKey = `order_restore:${orderId}:${productId}`;
    const existingRestore = await uniqueBusinessLog(tx, restoreKey);
    if (existingRestore) {
      validateRestoreLog(existingRestore, orderId, productId, quantity);
      return { productId, quantity, reused: true };
    }

    const mutation = await applyInventoryMutationInTransaction({
      db,
      store: tx,
      stockAlert,
      input: {
        productId,
        mode: "delta",
        delta: quantity,
        reason: "订单取消恢复库存"
      },
      actor,
      context: {
        businessKey: restoreKey,
        sourceType: "order_restore",
        sourceId: orderId,
        idempotencyKey,
        reasonCode: "order_cancel_restore",
        relatedOrderId: orderId,
        writeAudit: false,
        writeSync: true,
        now: now()
      }
    });
    if (!mutation || mutation.productId !== productId || mutation.changed !== true) {
      throw new OrderCancellationError("INVENTORY_RESTORE_FAILED", "订单库存恢复结果异常，暂不能取消", 409);
    }
    return { productId, quantity, reused: mutation.reused === true };
  }

  async function cancel(command = {}) {
    const actor = normalizeActor(command.actor);
    const orderId = cleanString(command.orderId, 128);
    if (!orderId) throw new OrderCancellationError("ORDER_ID_REQUIRED", "缺少订单 ID", 400);
    if (command.reason !== undefined && command.reason !== null && typeof command.reason !== "string") {
      throw new OrderCancellationError("CANCEL_REASON_INVALID", "取消原因格式无效", 400);
    }
    const reason = cleanString(command.reason, 200) || (actor.kind === "admin" ? "管理员取消" : "用户取消");
    const idempotencyKey = cleanString(command.idempotencyKey, 200);

    return db.runTransaction(async (tx) => {
      const order = await getDocument(tx, "orders", orderId);
      if (!order) throw new OrderCancellationError("ORDER_NOT_FOUND", "订单不存在", 404);
      if (order.status === "cancelled") {
        if (actor.kind !== "admin" && order.userOpenid !== actor.openid) {
          throw new OrderCancellationError("FORBIDDEN", "无权访问此订单", 403);
        }
        return {
          orderId,
          status: "cancelled",
          reused: true,
          restoredProducts: [],
          inventoryRestored: order.inventoryRestored === true,
          accountRecalculationRequired: order.accountRecalculationPending === true,
          userId: cleanString(order.userId, 128),
          userOpenid: cleanString(order.userOpenid, 128),
          message: "订单已取消"
        };
      }

      validateCancellation(order, actor);
      await validatePaymentRecords(tx, orderId);
      const timestamp = db.serverDate();
      const restoredProducts = [];
      if (order.status === "approved_pending_payment") {
        const productIds = await orderProductIds(tx, orderId, order);
        for (const productId of productIds) {
          restoredProducts.push(await restoreProduct(tx, {
            orderId,
            productId,
            actor,
            idempotencyKey
          }));
        }
      }

      const currentVersion = versionOf(order.version !== undefined ? order.version : order.dataVersion, "订单");
      const nextVersion = currentVersion + 1;
      if (!Number.isSafeInteger(nextVersion)) {
        throw new OrderCancellationError("DATA_VERSION_INVALID", "订单数据版本异常，暂不能取消", 409);
      }
      const orderBusinessKey = `order_cancel:${orderId}`;
      await tx.collection("sync_events").add({
        data: {
          eventId: eventId("order_cancel", orderBusinessKey),
          eventType: "order.cancelled",
          entityType: "order",
          entityId: orderId,
          action: "cancel",
          version: nextVersion,
          changedFields: ["status", "updatedAt", "version"],
          actorType: actor.kind,
          actorRole: actor.role,
          sourceClient: actor.sourceClient,
          businessKey: orderBusinessKey,
          audienceRoles: ["customer_service", "finance", "super_admin"],
          createdAt: timestamp,
          expiresAt: new Date(now().getTime() + SYNC_EVENT_TTL_MS)
        }
      });

      const hadDeductedInventory = order.status === "approved_pending_payment";
      const accountRecalculationRequired = hadDeductedInventory && order.accountIncluded === true;
      const orderUpdate = {
        status: "cancelled",
        cancelledBy: actor.openid,
        cancelledAt: timestamp,
        cancelReason: reason,
        cancelType: actor.kind === "admin" ? "admin_cancel" : "user_cancel",
        stockDeducted: false,
        inventoryRestored: hadDeductedInventory,
        accountIncluded: false,
        accountRecalculationPending: accountRecalculationRequired,
        updatedAt: timestamp,
        version: nextVersion
      };
      if (hadDeductedInventory) {
        orderUpdate.inventoryRestoredAt = timestamp;
        orderUpdate.inventoryRestoredBy = actor.id;
      }
      // Keep this as the last transaction write: no cancelled order can commit before its inventory effects.
      await tx.collection("orders").doc(orderId).update({ data: orderUpdate });

      return {
        orderId,
        status: "cancelled",
        reused: false,
        restoredProducts,
        inventoryRestored: hadDeductedInventory,
        accountRecalculationRequired,
        userId: cleanString(order.userId, 128),
        userOpenid: cleanString(order.userOpenid, 128),
        message: "订单已取消"
      };
    });
  }

  return { cancel };
}

module.exports = {
  OrderCancellationError,
  createOrderCancellationService,
  validateDeductionLog,
  validateRestoreLog
};
