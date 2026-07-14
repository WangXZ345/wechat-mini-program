const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const { requirePermission, ensureCollection } = require("./auth");

exports.main = async (event = {}) => {
  try {
    await requirePermission("admin:view");
    await ensureCollection("admin_operation_logs");
    await ensureCollection("permission_logs");
    const limit = Math.min(Math.max(Number(event.limit || 100), 1), 200);
    const logs = await db.collection("admin_operation_logs").orderBy("createdAt", "desc").limit(limit).get();
    const permissionLogs = await db.collection("permission_logs").orderBy("createdAt", "desc").limit(limit).get();
    return { ok: true, data: { logs: logs.data, permissionLogs: permissionLogs.data } };
  } catch (err) {
    return { ok: false, message: "Operation failed" };
  }
};

