const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requireAnyPermission, requirePermission, logAdminOperation } = require("./auth");

const PAID_STATUSES = ["paid"];
const SHIPPABLE_PAYMENT_STATUSES = ["paid", "partial_paid"];
const ACTION_PERMISSION = {
  confirm_shipping: ["shipment:ship", "order:ship"],
  mark_picked_up: ["shipment:ship", "order:ship"],
  complete: ["shipment:complete"],
  after_sales: ["shipment:update"]
};

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) return;
    if (/createCollection is not a function/i.test(message)) return;
    throw err;
  }
}

async function ensureDeliveryCollections() {
  await Promise.all([
    ensureCollection("delivery_logs"),
    ensureCollection("shipment_logs"),
    ensureCollection("admin_operation_logs")
  ]);
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeAction(action) {
  const value = cleanText(action, 40);
  if (ACTION_PERMISSION[value]) return value;
  throw new Error("Invalid operation");
}

function paymentStatusOf(order) {
  return order.paymentStatus || order.status || "";
}

function requirePaid(order) {
  const paymentStatus = paymentStatusOf(order);
  if (!PAID_STATUSES.includes(paymentStatus) && !SHIPPABLE_PAYMENT_STATUSES.includes(paymentStatus)) {
    throw new Error("订单未完成付款确认，不能执行发货操作");
  }
}

function currentDeliveryStatus(order) {
  return order.deliveryStatus || (order.deliveryType === "self_pickup" ? "waiting_pickup" : "waiting_shipping");
}

function buildPatch(action, event, order) {
  const beforeStatus = currentDeliveryStatus(order);
  const remark = cleanText(event.remark || event.deliveryRemark, 300);
  const imageUrl = cleanText(event.imageUrl || event.deliveryImageUrl, 500);
  const base = {
    updatedAt: db.serverDate()
  };

  if (action === "confirm_shipping") {
    requirePaid(order);
    if (order.deliveryType !== "shipping") throw new Error("当前订单不是快递配送订单");
    if (["shipped", "completed"].includes(beforeStatus)) {
      return {
        reused: true,
        afterStatus: beforeStatus,
        patch: null,
        log: null
      };
    }
    if (beforeStatus === "after_sales") throw new Error("售后中的订单不能确认发货");
    const expressCompany = cleanText(event.expressCompany, 80);
    const expressNo = cleanText(event.expressNo, 80);
    if (!expressCompany) throw new Error("请填写快递公司");
    if (!expressNo) throw new Error("请填写快递单号");
    return {
      afterStatus: "shipped",
      patch: {
        ...base,
        deliveryStatus: "shipped",
        shippingStatus: "shipped",
        expressCompany,
        expressNo,
        shippingCompany: expressCompany,
        trackingNo: expressNo,
        trackingNoList: [expressNo],
        deliveryRemark: remark,
        deliveryImageUrl: imageUrl,
        shippedAt: order.shippedAt || db.serverDate()
      },
      log: {
        beforeStatus,
        afterStatus: "shipped",
        expressCompany,
        expressNo,
        remark,
        imageUrl
      }
    };
  }

  if (action === "mark_picked_up") {
    requirePaid(order);
    if (order.deliveryType !== "self_pickup") throw new Error("当前订单不是自提订单");
    if (["picked_up", "completed"].includes(beforeStatus)) {
      return {
        reused: true,
        afterStatus: beforeStatus,
        patch: null,
        log: null
      };
    }
    if (beforeStatus === "after_sales") throw new Error("售后中的订单不能标记自提");
    return {
      afterStatus: "picked_up",
      patch: {
        ...base,
        deliveryStatus: "picked_up",
        shippingStatus: "picked_up",
        deliveryRemark: remark,
        deliveryImageUrl: imageUrl,
        pickedUpAt: order.pickedUpAt || db.serverDate()
      },
      log: {
        beforeStatus,
        afterStatus: "picked_up",
        expressCompany: "",
        expressNo: "",
        remark,
        imageUrl
      }
    };
  }

  if (action === "complete") {
    requirePaid(order);
    if (beforeStatus === "completed") {
      return {
        reused: true,
        afterStatus: "completed",
        patch: null,
        log: null
      };
    }
    if (!["shipped", "picked_up"].includes(beforeStatus)) {
      throw new Error("只有已发货或已自提订单可以标记完成");
    }
    return {
      afterStatus: "completed",
      patch: {
        ...base,
        deliveryStatus: "completed",
        shippingStatus: "completed",
        deliveryRemark: remark || order.deliveryRemark || "",
        completedAt: order.completedAt || db.serverDate()
      },
      log: {
        beforeStatus,
        afterStatus: "completed",
        expressCompany: order.expressCompany || order.shippingCompany || "",
        expressNo: order.expressNo || order.trackingNo || "",
        remark: remark || order.deliveryRemark || "",
        imageUrl
      }
    };
  }

  if (beforeStatus === "after_sales") {
    return {
      reused: true,
      afterStatus: "after_sales",
      patch: null,
      log: null
    };
  }
  return {
    afterStatus: "after_sales",
    patch: {
      ...base,
      deliveryStatus: "after_sales",
      shippingStatus: "abnormal",
      deliveryRemark: remark || order.deliveryRemark || ""
    },
    log: {
      beforeStatus,
      afterStatus: "after_sales",
      expressCompany: order.expressCompany || order.shippingCompany || "",
      expressNo: order.expressNo || order.trackingNo || "",
      remark: remark || order.deliveryRemark || "",
      imageUrl
    }
  };
}

async function writeDeliveryLog(tx, { orderId, order, action, log, admin, idempotencyKey }) {
  const businessKey = `single_delivery:${action}:${orderId}:${log.afterStatus}`;
  const existing = await tx.collection("delivery_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
  if (existing.data && existing.data[0]) return false;
  await tx.collection("delivery_logs").add({
    data: {
      businessKey,
      idempotencyKey: idempotencyKey || "",
      orderId,
      orderNo: order.orderNo || "",
      deliveryType: order.deliveryType || "",
      beforeStatus: log.beforeStatus,
      afterStatus: log.afterStatus,
      expressCompany: log.expressCompany || "",
      expressNo: log.expressNo || "",
      remark: log.remark || "",
      imageUrl: log.imageUrl || "",
      operatorId: admin._id || admin.id || "",
      operatorOpenid: admin.openid || cloud.getWXContext().OPENID,
      operatorRole: admin.role || "",
      action,
      createdAt: db.serverDate()
    }
  });
  return true;
}

async function writeShipmentLog(tx, { orderId, order, action, log, admin, idempotencyKey }) {
  const businessKey = `single_delivery:${action}:${orderId}:${log.afterStatus}`;
  const existing = await tx.collection("shipment_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
  if (existing.data && existing.data[0]) return false;
  await tx.collection("shipment_logs").add({
    data: {
      businessKey,
      sourceType: "single_order",
      sourceId: orderId,
      idempotencyKey: idempotencyKey || "",
      shipmentGroupId: "",
      shipmentNo: "",
      orderIds: [orderId],
      action,
      beforeData: {
        orderNo: order.orderNo || "",
        deliveryStatus: log.beforeStatus,
        expressCompany: order.expressCompany || order.shippingCompany || "",
        expressNo: order.expressNo || order.trackingNo || ""
      },
      afterData: {
        orderNo: order.orderNo || "",
        deliveryStatus: log.afterStatus,
        expressCompany: log.expressCompany || "",
        expressNo: log.expressNo || ""
      },
      operatorId: admin._id || admin.id || "",
      operatorOpenid: admin.openid || cloud.getWXContext().OPENID,
      operatorRole: admin.role || "",
      remark: log.remark || "",
      createdAt: db.serverDate()
    }
  });
  return true;
}

exports.main = async (event = {}) => {
  const orderId = cleanText(event.orderId, 80);
  if (!orderId) return { ok: false, message: "缺少订单 ID" };

  try {
    const action = normalizeAction(event.action);
    let admin = null;
    if (action === "after_sales") {
      admin = await requirePermission("shipment:update");
    } else {
      admin = await requireAnyPermission(ACTION_PERMISSION[action]);
    }
    await ensureDeliveryCollections();

    const result = await db.runTransaction(async (tx) => {
      const order = (await tx.collection("orders").doc(orderId).get()).data;
      if (!order) throw new Error("订单不存在");
      if (order.mergeShipmentId && order.mergeShipmentStatus !== "cancelled") {
        throw new Error("该订单已进入合并发货流程，请在合并发货中处理");
      }
      if (["cancelled", "rejected"].includes(order.status)) throw new Error("当前订单状态不能执行发货操作");
      const next = buildPatch(action, event, order);
      if (next.reused || !next.patch) {
        return {
          orderId,
          orderNo: order.orderNo || "",
          deliveryStatus: next.afterStatus,
          reused: true
        };
      }

      await tx.collection("orders").doc(orderId).update({ data: next.patch });
      await writeDeliveryLog(tx, { orderId, order, action, log: next.log, admin, idempotencyKey: event.idempotencyKey });
      await writeShipmentLog(tx, { orderId, order, action, log: next.log, admin, idempotencyKey: event.idempotencyKey });
      return {
        orderId,
        orderNo: order.orderNo || "",
        deliveryStatus: next.afterStatus,
        reused: false
      };
    });

    await logAdminOperation({
      operator: admin,
      action: `delivery:${action}`,
      resourceType: "order",
      resourceId: orderId,
      beforeData: null,
      afterData: result,
      description: "Update single order delivery status"
    }).catch(() => null);

    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, code: err.code || "", message: err.message || "发货操作失败" };
  }
};
