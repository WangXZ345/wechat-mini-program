const cloud = require("wx-server-sdk");
const { sanitizeAddressForRole } = require("./common/address");

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

exports.main = async () => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail("Missing user identity");

  try {
    const res = await db.collection("customer_addresses")
      .where({ openid, status: "active" })
      .limit(100)
      .get();
    const addresses = (res.data || []).sort((a, b) => {
      if (Boolean(a.isDefault) !== Boolean(b.isDefault)) return a.isDefault ? -1 : 1;
      return timeValue(b.updatedAt || b.createdAt) - timeValue(a.updatedAt || a.createdAt);
    });
    return ok({ address: addresses[0] ? sanitizeAddressForRole(addresses[0], { role: "super_admin" }) : null });
  } catch (err) {
    if (isMissingCollection(err)) return ok({ address: null });
    return fail(err.message || "获取默认地址失败");
  }
};
