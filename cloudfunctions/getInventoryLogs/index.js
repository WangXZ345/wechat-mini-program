const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("无管理员权限");
}

exports.main = async () => {
  try {
    await requirePermission("inventory:view_log");
    const logs = await db.collection("inventory_logs").orderBy("createdAt", "desc").limit(100).get();
    return { ok: true, data: { logs: logs.data } };
  } catch (err) {
    return { ok: false, message: err.message || "获取库存日志失败" };
  }
};

