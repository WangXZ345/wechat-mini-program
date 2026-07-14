const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requireAnyPermission, requirePermission, logAdminOperation } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("无管理员权限");
  return { openid, adminId: res.data[0]._id };
}

function cents(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) throw new Error("实收金额格式错误");
  return Math.round(num);
}

function parsePaidAmount(event, fallback) {
  if (event.paidAmountCents !== undefined && event.paidAmountCents !== null) return cents(event.paidAmountCents);
  if (event.paidAmount === undefined || event.paidAmount === null || event.paidAmount === "") return fallback;
  const raw = String(event.paidAmount).trim();
  if (raw.includes(".")) return cents(Number(raw) * 100);
  return cents(raw);
}

async function findAccount(tx, order) {
  if (order.userId) {
    const res = await tx.collection("customer_accounts").where({ userId: order.userId }).limit(1).get();
    if (res.data[0]) return res.data[0];
  }
  if (order.userOpenid) {
    const res = await tx.collection("customer_accounts").where({ userOpenid: order.userOpenid }).limit(1).get();
    if (res.data[0]) return res.data[0];
  }
  return {};
}

function accountValue(account, primary, legacy) {
  return Number(account[primary] !== undefined ? account[primary] : account[legacy] || 0);
}

async function writePaymentRecord(tx, orderId, order, next, admin, remark, idempotencyKey, businessKey) {
  // 检查是否已存在相同 businessKey 的付款记录，防止重复
  if (businessKey) {
    const existing = await tx.collection("payment_records").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
    if (existing.data && existing.data[0]) return existing.data[0]._id;
  }
  const created = await tx.collection("payment_records").add({
    data: {
      orderId,
      userId: order.userId || "",
      userOpenid: order.userOpenid || "",
      orderAmount: Number(order.totalAmount || 0),
      paidAmount: next.changeAmount,
      unpaidAmount: next.unpaidAmount,
      paymentMethod: next.paymentMethod,
      paymentMethodId: order.paymentMethodId || "",
      paymentMethodType: order.paymentMethodType || "",
      paymentMethodName: order.paymentMethodName || next.paymentMethod || "",
      paymentBatchId: order.paymentBatchId || "",
      paymentBatchOrderIds: order.paymentBatchOrderIds || [],
      paymentBatchAmount: Number(order.paymentBatchAmount || 0),
      paymentBatchCount: Number(order.paymentBatchCount || 0),
      paymentScreenshotUrl: order.paymentScreenshotUrl || "",
      screenshotUrls: order.paymentScreenshotUrls || (order.paymentScreenshotUrl ? [order.paymentScreenshotUrl] : []),
      wechatPayTransactionId: order.wechatPayTransactionId || "",
      wechatPayOutTradeNo: order.wechatPayOutTradeNo || "",
      idempotencyKey: idempotencyKey || "",
      businessKey: businessKey || "",
      status: next.paymentStatus,
      paymentStatus: next.paymentStatus,
      confirmStatus: next.confirmStatus,
      confirmedBy: admin.openid,
      confirmedAt: db.serverDate(),
      remark: remark || "",
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  return created._id;
}

async function writeAccountLog(tx, orderId, order, paymentRecordId, account, next, admin, remark, idempotencyKey, businessKey) {
  if (businessKey) {
    const existing = await tx.collection("account_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
    if (existing.data && existing.data[0]) return false;
  }
  const beforeOrder = accountValue(account, "totalOrderAmount", "totalReceivableAmount");
  const beforePaid = accountValue(account, "totalPaidAmount", "paidAmount");
  const beforeUnpaid = accountValue(account, "totalUnpaidAmount", "unpaidAmount");
  const afterPaid = beforePaid + next.changeAmount;
  const afterUnpaid = Math.max(beforeUnpaid - next.changeAmount, 0);
  await tx.collection("account_logs").add({
    data: {
      userId: order.userId || "",
      userOpenid: order.userOpenid || "",
      relatedOrderId: orderId,
      relatedPaymentRecordId: paymentRecordId,
      paymentBatchId: order.paymentBatchId || "",
      businessKey: businessKey || "",
      sourceType: "payment",
      sourceId: paymentRecordId || orderId,
      idempotencyKey: idempotencyKey || "",
      changeType: next.changeType,
      beforeTotalOrderAmount: beforeOrder,
      afterTotalOrderAmount: beforeOrder,
      beforeTotalPaidAmount: beforePaid,
      afterTotalPaidAmount: afterPaid,
      beforeTotalUnpaidAmount: beforeUnpaid,
      afterTotalUnpaidAmount: afterUnpaid,
      changeAmount: next.changeAmount,
      operatorId: admin.adminId,
      operatorOpenid: admin.openid,
      remark: remark || "",
      createdAt: db.serverDate()
    }
  });
  return true;
}

function buildNextState(event, order) {
  const requested = event.paymentStatus === "partial" ? "partial_paid" : event.paymentStatus;
  const paidBefore = Number(order.paidAmount || 0);
  const total = Number(order.totalAmount || 0);
  const unpaidBefore = Number(order.unpaidAmount !== undefined ? order.unpaidAmount : Math.max(total - paidBefore, 0));
  if (unpaidBefore <= 0 && requested !== "abnormal" && requested !== "unpaid") throw new Error("订单已结清，不能重复确认付款");

  if (requested === "paid") {
    return {
      changeAmount: unpaidBefore,
      paidAmount: paidBefore + unpaidBefore,
      unpaidAmount: 0,
      paymentStatus: "paid",
      orderStatus: "paid",
      confirmStatus: "confirmed",
      changeType: "payment_confirmed",
      paymentMethod: event.paymentMethod || order.paymentMethod || ""
    };
  }

  if (requested === "partial_paid") {
    const amount = parsePaidAmount(event, 0);
    if (amount <= 0) throw new Error("部分付款的实收金额必须大于 0");
    if (amount > unpaidBefore) throw new Error("实收金额不能大于订单未付金额");
    const nextPaid = paidBefore + amount;
    const nextUnpaid = Math.max(total - nextPaid, 0);
    return {
      changeAmount: amount,
      paidAmount: nextPaid,
      unpaidAmount: nextUnpaid,
      paymentStatus: nextUnpaid === 0 ? "paid" : "partial_paid",
      orderStatus: nextUnpaid === 0 ? "paid" : "partial_paid",
      confirmStatus: "confirmed",
      changeType: nextUnpaid === 0 ? "payment_confirmed" : "partial_payment_confirmed",
      paymentMethod: event.paymentMethod || order.paymentMethod || ""
    };
  }

  if (requested === "abnormal") {
    return {
      changeAmount: 0,
      paidAmount: paidBefore,
      unpaidAmount: unpaidBefore,
      paymentStatus: "abnormal",
      orderStatus: "abnormal",
      confirmStatus: "abnormal",
      changeType: "payment_abnormal",
      paymentMethod: event.paymentMethod || order.paymentMethod || ""
    };
  }

  if (requested === "unpaid") {
    return {
      changeAmount: 0,
      paidAmount: paidBefore,
      unpaidAmount: unpaidBefore,
      paymentStatus: "unpaid",
      orderStatus: "approved_pending_payment",
      confirmStatus: "rejected",
      changeType: "manual_adjustment",
      paymentMethod: event.paymentMethod || order.paymentMethod || ""
    };
  }

  throw new Error("Invalid operation");
}

function deliveryStatusAfterPayment(next, order) {
  if (next.paymentStatus !== "paid") return order.deliveryStatus || "pending";
  if (order.deliveryType === "self_pickup") return "waiting_pickup";
  if (order.deliveryType === "shipping") return "waiting_shipping";
  return order.deliveryStatus || "pending";
}

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function batchSupportedStatus(status) {
  const requested = status === "partial" ? "partial_paid" : status;
  return ["paid", "abnormal", "unpaid"].includes(requested);
}

function canBatchUpdate(order) {
  if (!order) return false;
  if (order.paymentStatus !== "pending_confirm") return false;
  return order.status === "pending_payment_confirm";
}

async function getTargetOrders(tx, order, event) {
  if (!order.paymentBatchId || event.applyBatch === false || !batchSupportedStatus(event.paymentStatus)) {
    return [order];
  }
  const res = await tx.collection("orders").where({ paymentBatchId: order.paymentBatchId }).limit(100).get();
  const map = {};
  (res.data || []).forEach((row) => {
    if (canBatchUpdate(row)) map[row._id] = row;
  });
  if (canBatchUpdate(order)) map[order._id] = order;
  const rows = Object.values(map).sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
  return rows.length ? rows : [order];
}

exports.main = async (event = {}) => {
  const { orderId } = event;
  if (!orderId) return { ok: false, message: "缺少订单 ID" };

  try {
    const requestedStatus = event.paymentStatus === "partial" ? "partial_paid" : (event.paymentStatus || (event.isPartial ? "partial_paid" : "paid"));
    // 所有付款状态变更都需要 payment:confirm 权限（包括 abnormal）
    const admin = await requirePermission("payment:confirm");
    admin.adminId = admin._id || admin.id || "";
    const result = await db.runTransaction(async (tx) => {
      const order = (await tx.collection("orders").doc(orderId).get()).data;
      if (!order) throw new Error("订单不存在");
      const targetOrders = await getTargetOrders(tx, order, event);
      const remark = event.remark || event.paymentRemark || "";
      const updated = [];

      for (const target of targetOrders) {
        if (requestedStatus === "paid" && (target.paymentStatus === "paid" || target.status === "paid")) {
          updated.push({ orderId: target._id, paymentStatus: "paid", reused: true });
          continue;
        }
        if (requestedStatus === "unpaid" && target.paymentStatus === "unpaid" && target.status === "approved_pending_payment") {
          updated.push({ orderId: target._id, paymentStatus: "unpaid", reused: true });
          continue;
        }
        const next = buildNextState(event, target);
        const account = await findAccount(tx, target);
        const businessKey = `payment_confirm:${target.latestPaymentRecordId || target._id}:${next.paymentStatus}:${next.changeAmount}`;
        const existingAccountLog = await tx.collection("account_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
        if (existingAccountLog.data && existingAccountLog.data[0]) {
          updated.push({ orderId: target._id, paymentStatus: target.paymentStatus || next.paymentStatus, reused: true });
          continue;
        }
        const paymentRecordId = await writePaymentRecord(tx, target._id, target, next, admin, remark, event.idempotencyKey, businessKey);
        await writeAccountLog(tx, target._id, target, paymentRecordId, account, next, admin, remark, event.idempotencyKey, businessKey);

        const nextDeliveryStatus = deliveryStatusAfterPayment(next, target);
        await tx.collection("orders").doc(target._id).update({
          data: {
            paymentStatus: next.paymentStatus,
            status: next.orderStatus,
            deliveryStatus: nextDeliveryStatus,
            paidAmount: next.paidAmount,
            unpaidAmount: next.unpaidAmount,
            paymentMethod: next.paymentMethod,
            paymentConfirmedAt: next.confirmStatus === "confirmed" ? db.serverDate() : target.paymentConfirmedAt || null,
            paymentConfirmedBy: next.confirmStatus === "confirmed" ? admin.openid : target.paymentConfirmedBy || "",
            paymentRemark: remark,
            paidMarkedAt: next.confirmStatus === "confirmed" ? db.serverDate() : target.paidMarkedAt || null,
            updatedAt: db.serverDate()
          }
        });
        if ((target.deliveryStatus || "pending") !== nextDeliveryStatus) {
          await tx.collection("delivery_logs").add({
            data: {
              orderId: target._id,
              orderNo: target.orderNo || "",
              deliveryType: target.deliveryType || "",
              beforeStatus: target.deliveryStatus || "pending",
              afterStatus: nextDeliveryStatus,
              expressCompany: "",
              expressNo: "",
              remark: "Enter delivery flow after payment confirmation",
              imageUrl: "",
              operatorId: admin.adminId,
              operatorOpenid: admin.openid,
              action: "payment_confirmed",
              createdAt: db.serverDate()
            }
          });
        }
        updated.push({ orderId: target._id, paymentStatus: next.paymentStatus });
      }

      return {
        orderId,
        orderIds: updated.map((item) => item.orderId),
        updatedCount: updated.length,
        paymentBatchId: order.paymentBatchId || "",
        userId: order.userId,
        userOpenid: order.userOpenid,
        paymentStatus: updated[0] ? updated[0].paymentStatus : event.paymentStatus
      };
      });

    await cloud.callFunction({
      name: "recalculateCustomerAccount",
      data: { userId: result.userId, userOpenid: result.userOpenid }
    }).catch(() => null);

    let purchaseStatsResult = null;
    if (result.paymentStatus === "paid" || (result.orderIds || []).length) {
      try {
        const statsRes = await cloud.callFunction({
          name: "updateUserPurchaseStats",
          data: { orderIds: result.orderIds || [orderId] }
        });
        purchaseStatsResult = statsRes.result && statsRes.result.data || null;
      } catch (err) {
        purchaseStatsResult = {
          success: false,
          warning: err.message || "updateUserPurchaseStats failed"
        };
      }
    }

    await logAdminOperation({
      operator: admin,
      action: result.paymentStatus === "paid" ? "payment:confirm" : "payment:update_status",
      resourceType: result.paymentBatchId ? "payment_batch" : "order",
      resourceId: result.paymentBatchId || orderId,
      beforeData: null,
      afterData: result,
      description: result.updatedCount > 1 ? `Update payment status for ${result.updatedCount} linked orders` : "Update payment status"
    });

    return { ok: true, data: { ...result, purchaseStatsResult } };
  } catch (err) {
    return { ok: false, message: err.message || "更新付款状态失败" };
  }
};

