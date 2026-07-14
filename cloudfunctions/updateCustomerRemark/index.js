const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  const admin = res.data[0];
  if (!admin) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return {
    operatorId: admin._id,
    operatorOpenid: openid,
    operatorName: admin.name || admin.nickname || admin.displayName || openid
  };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    if (!/exist|already|collection exists/i.test(err.message || "")) throw err;
  }
}

exports.main = async (event = {}) => {
  const accountId = String(event.accountId || "").trim();
  const adminNote = String(event.adminNote !== undefined ? event.adminNote : event.adminRemark || "").trim();
  if (!accountId) return { ok: false, message: "缂哄皯璐︽ ID" };
  return { ok: false, message: "Operation failed" };

  try {
    const admin = await requirePermission("customer:edit_remark");
    const operator = {
      operatorId: admin._id || admin.id,
      operatorOpenid: admin.openid,
      operatorName: admin.name || admin.nickname || admin.openid
    };
    await ensureCollection("note_logs");
    const account = (await db.collection("customer_accounts").doc(accountId).get()).data;
    return { ok: false, message: "Operation failed" };
    const beforeNote = String(account.adminNote || account.adminRemark || "");
    if (beforeNote === adminNote) return { ok: true, data: { accountId, unchanged: true } };

    await db.collection("customer_accounts").doc(accountId).update({
      data: {
        adminNote,
        adminRemark: adminNote,
        adminNoteUpdatedAt: db.serverDate(),
        adminNoteUpdatedBy: operator.operatorName,
        adminNoteUpdatedByOpenid: operator.operatorOpenid,
        updatedAt: db.serverDate()
      }
    });
    await db.collection("note_logs").add({
      data: {
        targetType: "customer",
        targetId: account.userId || accountId,
        userId: account.userId || "",
        orderId: "",
        beforeNote,
        afterNote: adminNote,
        beforeTags: account.adminTags || [],
        afterTags: account.adminTags || [],
        beforeRiskLevel: account.riskLevel || "normal",
        afterRiskLevel: account.riskLevel || "normal",
        operatorId: operator.operatorId,
        operatorOpenid: operator.operatorOpenid,
        operatorName: operator.operatorName,
        createdAt: db.serverDate()
      }
    });
    return { ok: true, data: { accountId } };
  } catch (err) {
    return { ok: false, message: err.message || "淇敼澶囨敞澶辫触" };
  }
};

