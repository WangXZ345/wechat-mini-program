const cloud = require("wx-server-sdk");
const { requireAnyPermission } = require("./auth");
const { sanitizeAddressForRole } = require("./address");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function isMissingCollection(err) {
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(String(err && err.message || err || ""));
}

function timeValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime() || 0;
}

exports.main = async (event = {}) => {
  try {
    const admin = await requireAnyPermission(["customer:view_address_masked", "customer:view_address_full"]);
    const userId = String(event.userId || "").trim();
    const openid = String(event.openid || event.userOpenid || "").trim();
    if (!userId && !openid) throw new Error("缺少客户标识");

    const where = { status: "active" };
    if (userId) where.userId = userId;
    if (openid) where.openid = openid;

    const res = await db.collection("customer_addresses").where(where).limit(100).get();
    const addresses = (res.data || [])
      .sort((a, b) => {
        if (Boolean(a.isDefault) !== Boolean(b.isDefault)) return a.isDefault ? -1 : 1;
        return timeValue(b.updatedAt || b.createdAt) - timeValue(a.updatedAt || a.createdAt);
      })
      .map((address) => sanitizeAddressForRole(address, admin));
    return ok({ addresses, canViewFullAddress: admin.role === "super_admin" || (admin.permissions || []).includes("customer:view_address_full") });
  } catch (err) {
    if (isMissingCollection(err)) return ok({ addresses: [], canViewFullAddress: false });
    return fail(err.message || "获取客户收货地址失败");
  }
};
