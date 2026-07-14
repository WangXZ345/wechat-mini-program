const cloud = require("wx-server-sdk");
const {
  validateAddressPayload,
  sanitizeAddressForRole,
  maskedAddressSnapshot
} = require("./common/address");

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

async function writeAddressLog({ openid, addressId, action, beforeData, afterData }) {
  await ensureCollection("address_logs");
  await db.collection("address_logs").add({
    data: {
      userId: beforeData.userId || afterData.userId || "",
      openid,
      addressId,
      action,
      beforeDataMasked: beforeData ? maskedAddressSnapshot(beforeData) : null,
      afterDataMasked: afterData ? maskedAddressSnapshot(afterData) : null,
      operatorType: "user",
      operatorId: beforeData.userId || afterData.userId || "",
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
    const oldAddress = (await db.collection("customer_addresses").doc(addressId).get()).data;
    if (!oldAddress || oldAddress.openid !== openid || oldAddress.status !== "active") throw new Error("收货地址不存在");
    const payload = validateAddressPayload(event);
    const isDefault = Boolean(payload.isDefault || oldAddress.isDefault);
    if (payload.isDefault) {
      await db.collection("customer_addresses").where({ openid, status: "active" }).update({ data: { isDefault: false, updatedAt: db.serverDate() } });
    }
    const data = {
      ...payload,
      isDefault,
      updatedAt: db.serverDate()
    };
    await db.collection("customer_addresses").doc(addressId).update({ data });
    const address = { ...oldAddress, ...data, _id: addressId };
    await writeAddressLog({ openid, addressId, action: "update", beforeData: oldAddress, afterData: address });
    return ok({ address: sanitizeAddressForRole(address, { role: "super_admin" }) });
  } catch (err) {
    return fail(err.message || "更新收货地址失败");
  }
};
