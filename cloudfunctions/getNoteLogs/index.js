const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requireAnyPermission } = require("./auth");

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
}

function isCollectionNotExists(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

exports.main = async (event = {}) => {
  const targetType = String(event.targetType || "").trim();
  const targetId = String(event.targetId || "").trim();
  const page = Math.max(1, Number(event.page || 1));
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize || 20)));

  if (!["order", "customer"].includes(targetType)) return fail("澶囨敞绫诲瀷鏃犳晥");
  if (!targetId) return fail("缂哄皯澶囨敞瀵硅薄 ID");

  try {
    await requireAnyPermission(["order:edit_remark", "customer:edit_remark", "admin:view"]);
    const query = db.collection("note_logs").where({ targetType, targetId });
    const total = (await query.count()).total;
    const logs = await query
      .orderBy("createdAt", "desc")
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();

    return ok({ logs: logs.data, total, page, pageSize });
  } catch (err) {
    if (isCollectionNotExists(err)) return ok({ logs: [], total: 0, page, pageSize });
    return fail(err.message || "鑾峰彇澶囨敞鏃ュ織澶辫触");
  }
};

