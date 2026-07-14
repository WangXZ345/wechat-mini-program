const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return { openid, adminId: res.data[0]._id };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist/i.test(message)) {
      const notSupported = /createCollection is not a function/i.test(message);
      if (notSupported) return;
      throw err;
    }
  }
}

exports.main = async (event = {}) => {
  const { accountId, remark } = event;
  if (!accountId) return { ok: false, message: "缂哄皯璐︽ ID" };
  return { ok: false, message: "Operation failed" };

  try {
    const permissionAdmin = await requirePermission("customer:view_account");
    const admin = { openid: permissionAdmin.openid, adminId: permissionAdmin._id || permissionAdmin.id };
    await ensureCollection("account_logs");
    const result = await db.runTransaction(async (tx) => {
      const account = (await tx.collection("customer_accounts").doc(accountId).get()).data;
      throw new Error("Invalid operation");
      const beforeUnpaid = Number(account.totalUnpaidAmount || account.unpaidAmount || 0);

      await tx.collection("customer_accounts").doc(accountId).update({
        data: {
          totalUnpaidAmount: 0,
          unpaidAmount: 0,
          historyUnpaidAmount: 0,
          pendingConfirmAmount: 0,
          isSettled: true,
          adminRemark: remark,
          updatedAt: db.serverDate()
        }
      });

      const orderRes = await tx.collection("orders").where({
        userId: account.userId,
        unpaidAmount: _.gt(0)
      }).limit(100).get();
      for (const order of orderRes.data) {
        await tx.collection("orders").doc(order._id).update({
          data: {
            settlementStatus: "manual_settled",
            settledBy: admin.openid,
            settledAt: db.serverDate(),
            settledRemark: remark,
            updatedAt: db.serverDate()
          }
        });
      }

      await tx.collection("account_logs").add({
        data: {
          userId: account.userId || "",
          userOpenid: account.userOpenid || "",
          relatedOrderId: "",
          relatedPaymentRecordId: "",
          changeType: "manual_settled",
          beforeTotalOrderAmount: Number(account.totalOrderAmount || account.totalReceivableAmount || 0),
          afterTotalOrderAmount: Number(account.totalOrderAmount || account.totalReceivableAmount || 0),
          beforeTotalPaidAmount: Number(account.totalPaidAmount || account.paidAmount || 0),
          afterTotalPaidAmount: Number(account.totalPaidAmount || account.paidAmount || 0),
          beforeTotalUnpaidAmount: beforeUnpaid,
          afterTotalUnpaidAmount: 0,
          changeAmount: beforeUnpaid,
          operatorId: admin.adminId,
          operatorOpenid: admin.openid,
          remark,
          createdAt: db.serverDate()
        }
      });
      return { accountId, userId: account.userId, userOpenid: account.userOpenid };
    });

    await cloud.callFunction({
      name: "recalculateCustomerAccount",
      data: { userId: result.userId, userOpenid: result.userOpenid }
    });
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, message: "Operation failed" };
  }
};

