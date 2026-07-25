"use strict";

const { canAutoReviewOrder } = require("./orderStatusPolicy");

const ACCOUNT_RECALCULATION_WARNING = "订单已审核，客户账款汇总将在稍后更新";
const SYNC_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ORDER_EVENT_FIELDS = Object.freeze([
  "eventId",
  "eventType",
  "entityType",
  "entityId",
  "action",
  "version",
  "changedFields",
  "actorType",
  "actorRole",
  "sourceClient",
  "businessKey",
  "audience",
  "ownerKey",
  "createdAt",
  "expiresAt"
]);
const STORED_ORDER_EVENT_FIELDS = new Set(["_id", ...ORDER_EVENT_FIELDS]);

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function normalizeRiskLevel(value) {
  if (value === "watch") return "important";
  if (value === "risky") return "risk";
  return value || "normal";
}

function systemActor() {
  return {
    id: "system",
    openid: "",
    role: "system",
    sourceClient: "system"
  };
}

function inventoryReasonCode(order = {}) {
  return order.orderType === "cart"
    ? "auto_cart_order_approved"
    : "auto_order_approved";
}

function inventoryContext(orderId, productId, reasonCode, now) {
  return {
    businessKey: `order_deduct:${orderId}:${productId}`,
    sourceType: "order",
    sourceId: orderId,
    relatedOrderId: orderId,
    idempotencyKey: "",
    reasonCode,
    operationReason: "订单自动审核通过扣减库存",
    writeAudit: false,
    writeSync: true,
    now
  };
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function timestampMillis(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : NaN;
  }
  if (typeof value === "object" && Number.isFinite(Number(value.$date))) {
    return Number(value.$date);
  }
  return new Date(value).getTime();
}

function orderStateBusinessKey(orderId, status, version) {
  return `auto_order_state:${cleanString(orderId, 128)}:${cleanString(status, 60)}:${version}`;
}

function orderStateProjection(status) {
  if (status === "approved_pending_payment") {
    return {
      action: "auto_approve",
      changedFields: ["status", "paymentStatus", "updatedAt", "version"]
    };
  }
  return {
    action: "manual_review_required",
    changedFields: ["status", "updatedAt", "version"]
  };
}

function createHandler({
  db,
  cloud,
  stockAlert,
  applyInventoryMutationInTransaction,
  validateInventoryReplay,
  approval,
  ownerKeyFor,
  stableEventId,
  syncOwnerPepper = "",
  now = () => new Date()
} = {}) {
  if (!db || typeof db.runTransaction !== "function" || typeof db.serverDate !== "function") {
    throw new Error("auto review handler requires db transaction support");
  }
  if (!cloud || typeof cloud.callFunction !== "function") {
    throw new Error("auto review handler requires cloud.callFunction");
  }
  if (!stockAlert
    || typeof stockAlert.buildStockStatusUpdate !== "function"
    || typeof stockAlert.syncStockAlertRecord !== "function") {
    throw new Error("auto review handler requires stock alert helpers");
  }
  if (typeof applyInventoryMutationInTransaction !== "function"
    || typeof validateInventoryReplay !== "function") {
    throw new Error("auto review handler requires canonical inventory primitives");
  }
  if (!approval
    || typeof approval.normalizeReviewItems !== "function"
    || typeof approval.normalizeOrderAmount !== "function"
    || typeof approval.nextVersionOf !== "function"
    || typeof approval.includeApprovedOrderInTransaction !== "function") {
    throw new Error("auto review handler requires shared approval rules");
  }
  if (typeof ownerKeyFor !== "function" || typeof stableEventId !== "function") {
    throw new Error("auto review handler requires canonical sync event helpers");
  }

  async function ensureCollection(name) {
    if (typeof db.createCollection !== "function") return;
    try {
      await db.createCollection(name);
    } catch (error) {
      const message = String((error && error.message) || error || "");
      if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) {
        throw error;
      }
    }
  }

  async function getOrderItems(tx, orderId, order) {
    const response = await tx.collection("order_items")
      .where({ orderId })
      .limit(approval.MAX_ORDER_ITEMS + 1)
      .get();
    const items = Array.isArray(response.data) ? response.data : [];
    if (items.length) return items;
    return [{
      _id: "",
      orderId,
      productId: order.productId,
      productName: order.productName,
      quantity: order.quantity,
      unitPrice: order.unitPrice,
      totalAmount: order.totalAmount
    }];
  }

  async function getCurrentRiskLevel(tx, order) {
    if (order.riskLevelSnapshot) return normalizeRiskLevel(order.riskLevelSnapshot);
    const filters = [];
    if (order.userId) filters.push({ userId: order.userId });
    if (order.userOpenid) filters.push({ userOpenid: order.userOpenid });
    for (const where of filters) {
      const response = await tx.collection("customer_accounts").where(where).limit(1).get();
      if (response.data && response.data[0] && response.data[0].riskLevel) {
        return normalizeRiskLevel(response.data[0].riskLevel);
      }
    }
    return "normal";
  }

  async function inspectInventory(tx, orderId, item, reasonCode) {
    const input = {
      productId: item.productId,
      mode: "delta",
      delta: -item.quantity,
      reason: reasonCode
    };
    const context = inventoryContext(orderId, item.productId, reasonCode, now());
    const existing = await tx.collection("inventory_logs")
      .where({ businessKey: context.businessKey })
      .limit(2)
      .get();
    const replay = validateInventoryReplay(existing.data || [], input, context);
    if (replay) {
      return { item, input, context, product: null, enough: true, replay: true };
    }
    const productResult = await tx.collection("products").doc(item.productId).get();
    const product = productResult && productResult.data;
    const enough = Boolean(product)
      && product.isDeleted !== true
      && product.isActive !== false
      && typeof product.stock === "number"
      && Number.isSafeInteger(product.stock)
      && product.stock >= item.quantity;
    return { item, input, context, product, enough, replay: false };
  }

  function orderOwnerKey(order) {
    const subject = cleanString(
      order && (order.userOpenid || order.openid),
      256
    );
    const key = cleanString(ownerKeyFor(subject, syncOwnerPepper), 128);
    if (!key) {
      const error = new Error("订单同步安全配置不完整");
      error.code = "SYNC_OWNER_CONFIG_REQUIRED";
      throw error;
    }
    return key;
  }

  function eventMatches(actual, expected) {
    if (!actual || typeof actual !== "object") return false;
    if (Object.keys(actual).some((field) => !STORED_ORDER_EVENT_FIELDS.has(field))) return false;
    const exactFields = ORDER_EVENT_FIELDS.filter((field) => !["changedFields", "createdAt", "expiresAt"].includes(field));
    if (exactFields.some((field) => actual[field] !== expected[field])) return false;
    if (!Array.isArray(actual.changedFields)
      || actual.changedFields.length !== expected.changedFields.length
      || actual.changedFields.some((field, index) => field !== expected.changedFields[index])) {
      return false;
    }
    const createdAtMs = timestampMillis(actual.createdAt);
    const expiresAtMs = timestampMillis(actual.expiresAt);
    const nowMs = timestampMillis(now());
    return Number.isFinite(createdAtMs)
      && Number.isFinite(expiresAtMs)
      && Number.isFinite(nowMs)
      && createdAtMs <= nowMs
      && expiresAtMs > nowMs
      && expiresAtMs - createdAtMs === SYNC_EVENT_TTL_MS;
  }

  async function writeOrderEvent(tx, { order, status, version }) {
    const businessKey = orderStateBusinessKey(order._id, status, version);
    const projection = orderStateProjection(status);
    const eventId = stableEventId("auto_order_state", businessKey, 0);
    const eventCreatedAtMs = timestampMillis(now());
    const eventExpiresAt = new Date(eventCreatedAtMs + SYNC_EVENT_TTL_MS);
    if (!Number.isFinite(eventCreatedAtMs) || !Number.isFinite(eventExpiresAt.getTime())) {
      throw new Error("自动审核时间无效");
    }
    const event = {
      eventId,
      eventType: "order.status_changed",
      entityType: "order",
      entityId: cleanString(order._id, 128),
      action: projection.action,
      version,
      changedFields: projection.changedFields,
      actorType: "system",
      actorRole: "system",
      sourceClient: "system",
      businessKey,
      audience: "owner",
      ownerKey: orderOwnerKey(order),
      createdAt: new Date(eventCreatedAtMs),
      expiresAt: eventExpiresAt
    };
    const existingResponse = await tx.collection("sync_events")
      .where({ eventId })
      .limit(2)
      .get();
    const existing = Array.isArray(existingResponse.data) ? existingResponse.data : [];
    if (existing.length > 1) {
      throw new Error("订单同步事件重复，暂不能继续");
    }
    if (existing.length === 1) {
      if (!eventMatches(existing[0], event)) {
        throw new Error("订单同步事件冲突，暂不能继续");
      }
      return { eventId, reused: true };
    }
    await tx.collection("sync_events").add({ data: event });
    return { eventId, reused: false };
  }

  return async function autoReviewOrder(event = {}) {
    const orderId = event.orderId;
    if (!orderId) return fail("缺少订单 ID");

    try {
      for (const name of ["account_logs", "inventory_logs", "stock_alert_records", "sync_events"]) {
        await ensureCollection(name);
      }
      const result = await db.runTransaction(async (tx) => {
        const orderResult = await tx.collection("orders").doc(orderId).get();
        const order = orderResult && orderResult.data;
        if (!order) throw new Error("订单不存在");
        if (!canAutoReviewOrder(order.status)) {
          return { skipped: true, status: order.status };
        }

        const nextVersion = approval.nextVersionOf(order);
        const riskLevel = await getCurrentRiskLevel(tx, order);
        if (riskLevel === "risk") {
          const timestamp = db.serverDate();
          await tx.collection("orders").doc(orderId).update({ data: {
            status: "pending_admin",
            reviewType: "manual",
            riskLevelSnapshot: riskLevel,
            version: nextVersion,
            updatedAt: timestamp
          } });
          await tx.collection("admin_notifications").add({ data: {
            type: "manual_order_review",
            orderId,
            userOpenid: order.userOpenid || "",
            isRead: false,
            createdAt: timestamp
          } });
          await writeOrderEvent(tx, {
            order,
            status: "pending_admin",
            version: nextVersion
          });
          return { skipped: true, status: "pending_admin", reason: "risk_customer" };
        }

        const amount = approval.normalizeOrderAmount(
          order.totalAmount === undefined || order.totalAmount === null || order.totalAmount === ""
            ? 0
            : order.totalAmount
        );
        const items = await getOrderItems(tx, orderId, order);
        const groupedItems = approval.normalizeReviewItems(items);
        const reasonCode = inventoryReasonCode(order);
        const checks = [];
        for (const item of groupedItems) {
          checks.push(await inspectInventory(tx, orderId, item, reasonCode));
        }
        const checksByProduct = new Map(checks.map((row) => [row.item.productId, row]));

        if (checks.some((row) => !row.enough)) {
          const timestamp = db.serverDate();
          await tx.collection("orders").doc(orderId).update({ data: {
            status: "pending_admin",
            reviewType: "manual",
            version: nextVersion,
            updatedAt: timestamp
          } });
          for (const item of items) {
            if (!item._id) continue;
            const check = checksByProduct.get(item.productId);
            await tx.collection("order_items").doc(item._id).update({ data: {
              stockCheckStatus: check && check.enough ? "enough" : "insufficient"
            } });
          }
          await writeOrderEvent(tx, {
            order,
            status: "pending_admin",
            version: nextVersion
          });
          return { skipped: true, status: "pending_admin" };
        }

        const operator = systemActor();
        const timestamp = db.serverDate();
        for (const row of checks) {
          const inventoryResult = await applyInventoryMutationInTransaction({
            db,
            store: tx,
            stockAlert,
            input: row.input,
            actor: operator,
            context: row.context
          });
          if (inventoryResult.changed !== false) {
            const productResult = await tx.collection("products").doc(row.item.productId).get();
            const product = productResult && productResult.data;
            const totalSales = Number(product && product.totalSales || 0) + row.item.quantity;
            if (!Number.isSafeInteger(totalSales) || totalSales < 0) {
              throw new approval.OrderApprovalError(
                "PRODUCT_SALES_INVALID",
                "商品销量数据异常，暂不能审核"
              );
            }
            await tx.collection("products").doc(row.item.productId).update({ data: {
              totalSales,
              lastSoldAt: timestamp
            } });
          }
        }
        for (const item of items) {
          if (!item._id) continue;
          await tx.collection("order_items").doc(item._id).update({
            data: { stockCheckStatus: "enough" }
          });
        }

        await approval.includeApprovedOrderInTransaction({
          store: tx,
          order,
          actor: operator,
          amount,
          timestamp,
          calendarDate: now(),
          remark: "自动审核通过，计入客户账款"
        });
        await tx.collection("orders").doc(orderId).update({ data: {
          status: "approved_pending_payment",
          paymentStatus: "unpaid",
          paidAmount: 0,
          unpaidAmount: amount,
          accountIncluded: true,
          accountRecalculationPending: true,
          settlementStatus: order.settlementStatus || "normal",
          version: nextVersion,
          approvedAt: timestamp,
          updatedAt: timestamp
        } });
        await writeOrderEvent(tx, {
          order,
          status: "approved_pending_payment",
          version: nextVersion
        });

        return {
          approved: true,
          status: "approved_pending_payment",
          userId: order.userId,
          userOpenid: order.userOpenid
        };
      });

      if (result.approved) {
        try {
          const recalculated = await cloud.callFunction({
            name: "recalculateCustomerAccount",
            data: { userId: result.userId, userOpenid: result.userOpenid }
          });
          if ((recalculated && recalculated.ok === false)
            || (recalculated && recalculated.result && recalculated.result.ok === false)) {
            return ok({
              ...result,
              accountRecalculationPending: true,
              warning: ACCOUNT_RECALCULATION_WARNING
            });
          }
          await db.collection("orders").doc(orderId).update({ data: {
            accountRecalculationPending: false,
            accountRecalculatedAt: db.serverDate(),
            updatedAt: db.serverDate()
          } });
          return ok({ ...result, accountRecalculationPending: false });
        } catch (_) {
          return ok({
            ...result,
            accountRecalculationPending: true,
            warning: ACCOUNT_RECALCULATION_WARNING
          });
        }
      }
      return ok(result);
    } catch (error) {
      return fail(error.message || "自动审核失败");
    }
  };
}

module.exports = {
  ACCOUNT_RECALCULATION_WARNING,
  SYNC_EVENT_TTL_MS,
  createHandler,
  inventoryContext,
  inventoryReasonCode,
  normalizeRiskLevel,
  orderStateBusinessKey,
  orderStateProjection,
  systemActor,
  timestampMillis
};
