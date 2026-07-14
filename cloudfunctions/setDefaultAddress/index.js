const cloud = require("wx-server-sdk");
const { sanitizeAddressForRole, maskedAddressSnapshot } = require("./common/address");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String(err && err.message || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) throw err;
  }
}

async function writeAddressLog({ openid, address }) {
  await ensureCollection("address_logs");
  await db.collection("address_logs").add({
    data: {
      userId: address.userId || "",
      openid,
      addressId: address._id,
      action: "set_default",
      beforeDataMasked: null,
      afterDataMasked: maskedAddressSnapshot(address),
      operatorType: "user",
      operatorId: address.userId || "",
      operatorOpenid: openid,
      createdAt: db.serverDate()
    }
  });
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail("Missing user identity");
  const addressId = String(event.addressId || "").trim();
  if (!addressId) return fail("缺少地址 ID");

  try {
    const address = (await db.collection("customer_addresses").doc(addressId).get()).data;
    if (!address || address.openid !== openid || address.status !== "active") throw new Error("收货地址不存在");
    await db.collection("customer_addresses").where({ openid, status: "active" }).update({ data: { isDefault: false, updatedAt: db.serverDate() } });
    await db.collection("customer_addresses").doc(addressId).update({ data: { isDefault: true, updatedAt: db.serverDate() } });
    const next = { ...address, isDefault: true };
    await writeAddressLog({ openid, address: next });
    return ok({ address: sanitizeAddressForRole(next, { role: "super_admin" }) });
  } catch (err) {
    return fail(err.message || "设置默认地址失败");
  }
};
