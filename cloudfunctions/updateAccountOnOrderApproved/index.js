const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function cents(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num < 0) throw new Error("订单金额无效");
  return Math.round(num);
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) {
      const notSupported = /createCollection is not a function/i.test(message);
      if (notSupported) return;
      throw err;
    }
  }
}

async function writeLog(tx, order, before, operatorOpenid) {
  await tx.collection("account_logs").add({
    data: {
      userId: order.userId || "",
      userOpenid: order.userOpenid || "",
      relatedOrderId: order._id,
      relatedPaymentRecordId: "",
      changeType: "order_approved",
      beforeTotalOrderAmount: Number(before && before.totalOrderAmount || before && before.totalReceivableAmount || 0),
      afterTotalOrderAmount: Number(before && before.totalOrderAmount || before && before.totalReceivableAmount || 0) + cents(order.totalAmount),
      beforeTotalPaidAmount: Number(before && before.totalPaidAmount || before && before.paidAmount || 0),
      afterTotalPaidAmount: Number(before && before.totalPaidAmount || before && before.paidAmount || 0),
      beforeTotalUnpaidAmount: Number(before && before.totalUnpaidAmount || before && before.unpaidAmount || 0),
      afterTotalUnpaidAmount: Number(before && before.totalUnpaidAmount || before && before.unpaidAmount || 0) + cents(order.totalAmount),
      changeAmount: cents(order.totalAmount),
      operatorId: operatorOpenid || "system",
      operatorOpenid: operatorOpenid || "system",
      remark: "订单批准计入客户账款",
      createdAt: db.serverDate()
    }
  });
}

async function getAccount(tx, order) {
  let account = null;
  if (order.userId) {
    const res = await tx.collection("customer_accounts").where({ userId: order.userId }).limit(1).get();
    account = res.data[0] || null;
  }
  if (!account && order.userOpenid) {
    const res = await tx.collection("customer_accounts").where({ userOpenid: order.userOpenid }).limit(1).get();
    account = res.data[0] || null;
  }
  return account;
}

exports.main = async (event = {}) => {
  const { orderId } = event;
  if (!orderId) return fail("缺少订单 ID");

  try {
    await ensureCollection("account_logs");
    const result = await db.runTransaction(async (tx) => {
      const order = (await tx.collection("orders").doc(orderId).get()).data;
      if (!order) throw new Error("订单不存在");
      if (order.accountIncluded === true) return { skipped: true, orderId };
      if (order.status !== "approved_pending_payment") throw new Error("订单未批准，不能计入账款");

      const amount = cents(order.totalAmount);
      const account = await getAccount(tx, order);
      await tx.collection("orders").doc(orderId).update({
        data: {
          paidAmount: 0,
          unpaidAmount: amount,
          paymentStatus: "unpaid",
          accountIncluded: true,
          settlementStatus: order.settlementStatus || "normal",
          updatedAt: db.serverDate()
        }
      });
      await writeLog(tx, { ...order, _id: orderId, totalAmount: amount }, account, event.operatorOpenid || "system");
      return { orderId, userId: order.userId, userOpenid: order.userOpenid };
    });

    if (!result.skipped) {
      await cloud.callFunction({
        name: "recalculateCustomerAccount",
        data: { userId: result.userId, userOpenid: result.userOpenid }
      });
    }
    return ok(result);
  } catch (err) {
    return fail(err.message || "订单计入账款失败");
  }
};
