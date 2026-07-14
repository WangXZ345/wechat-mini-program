const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

const RISK_LEVELS = ["normal", "important", "slow_pay", "risk", "blocked"];

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

function normalizeRiskLevel(value) {
  if (value === "watch") return "important";
  if (value === "risky") return "risk";
  return value;
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
  const riskLevel = normalizeRiskLevel(String(event.riskLevel || "").trim());
  if (!accountId) return { ok: false, message: "缂哄皯璐︽ ID" };
  if (!RISK_LEVELS.includes(riskLevel)) return { ok: false, message: "椋庨櫓绛夌骇鏃犳晥" };

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
    const beforeRiskLevel = normalizeRiskLevel(account.riskLevel || "normal");
    if (beforeRiskLevel === riskLevel) return { ok: true, data: { accountId, riskLevel, unchanged: true } };

    await db.collection("customer_accounts").doc(accountId).update({
      data: {
        riskLevel,
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
        beforeNote: account.adminNote || account.adminRemark || "",
        afterNote: account.adminNote || account.adminRemark || "",
        beforeTags: account.adminTags || [],
        afterTags: account.adminTags || [],
        beforeRiskLevel,
        afterRiskLevel: riskLevel,
        operatorId: operator.operatorId,
        operatorOpenid: operator.operatorOpenid,
        operatorName: operator.operatorName,
        createdAt: db.serverDate()
      }
    });
    return { ok: true, data: { accountId, riskLevel } };
  } catch (err) {
    return { ok: false, message: err.message || "淇敼椋庨櫓绛夌骇澶辫触" };
  }
};

