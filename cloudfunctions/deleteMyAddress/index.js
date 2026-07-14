const cloud = require("wx-server-sdk");
const { maskedAddressSnapshot } = require("./common/address");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function timeValue(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  return new Date(value).getTime() || 0;
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String(err && err.message || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) throw err;
  }
}

async function writeAddressLog({ openid, addressId, beforeData }) {
  await ensureCollection("address_logs");
  await db.collection("address_logs").add({
    data: {
      userId: beforeData.userId || "",
      openid,
      addressId,
      action: "delete",
      beforeDataMasked: maskedAddressSnapshot(beforeData),
      afterDataMasked: null,
      operatorType: "user",
      operatorId: beforeData.userId || "",
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
    await db.collection("customer_addresses").doc(addressId).update({
      data: {
        status: "deleted",
        isDefault: false,
        deletedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await writeAddressLog({ openid, addressId, beforeData: oldAddress });

    if (oldAddress.isDefault) {
      const rest = await db.collection("customer_addresses").where({ openid, status: "active" }).limit(100).get();
      const next = (rest.data || []).sort((a, b) => timeValue(b.updatedAt || b.createdAt) - timeValue(a.updatedAt || a.createdAt))[0];
      if (next) {
        await db.collection("customer_addresses").doc(next._id).update({ data: { isDefault: true, updatedAt: db.serverDate() } });
      }
    }
    return ok({ deleted: true });
  } catch (err) {
    return fail(err.message || "删除收货地址失败");
  }
};
