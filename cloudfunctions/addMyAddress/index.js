const cloud = require("wx-server-sdk");
const {
  DEFAULT_MAX_ADDRESS_COUNT,
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

async function getOrCreateUser(openid) {
  const now = db.serverDate();
  const res = await db.collection("users").where({ openid }).limit(1).get();
  if (res.data[0]) return res.data[0];
  const created = await db.collection("users").add({ data: { openid, nickname: "", phone: "", createdAt: now, updatedAt: now } });
  return { _id: created._id, openid };
}

async function getMaxAddressCount() {
  try {
    const res = await db.collection("settings").doc("system_settings").get();
    const value = Number(res.data && res.data.maxAddressCountPerUser);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ADDRESS_COUNT;
  } catch (err) {
    return DEFAULT_MAX_ADDRESS_COUNT;
  }
}

async function writeAddressLog({ user, openid, addressId, action, beforeData, afterData }) {
  await ensureCollection("address_logs");
  await db.collection("address_logs").add({
    data: {
      userId: user._id || "",
      openid,
      addressId,
      action,
      beforeDataMasked: beforeData ? maskedAddressSnapshot(beforeData) : null,
      afterDataMasked: afterData ? maskedAddressSnapshot(afterData) : null,
      operatorType: "user",
      operatorId: user._id || "",
      operatorOpenid: openid,
      createdAt: db.serverDate()
    }
  });
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail("Missing user identity");

  try {
    await ensureCollection("customer_addresses");
    const user = await getOrCreateUser(openid);
    const payload = validateAddressPayload(event);
    const countRes = await db.collection("customer_addresses").where({ openid, status: "active" }).count();
    const currentCount = Number(countRes.total || 0);
    const maxCount = await getMaxAddressCount();
    if (currentCount >= maxCount) throw new Error(`最多保存 ${maxCount} 个收货地址`);

    const isDefault = currentCount === 0 || payload.isDefault;
    if (isDefault) {
      await db.collection("customer_addresses").where({ openid, status: "active" }).update({ data: { isDefault: false, updatedAt: db.serverDate() } });
    }

    const data = {
      ...payload,
      userId: user._id || "",
      openid,
      isDefault,
      status: "active",
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      deletedAt: null
    };
    const created = await db.collection("customer_addresses").add({ data });
    const address = { ...data, _id: created._id };
    await writeAddressLog({ user, openid, addressId: created._id, action: "create", afterData: address });
    return ok({ address: sanitizeAddressForRole(address, { role: "super_admin" }) });
  } catch (err) {
    return fail(err.message || "新增收货地址失败");
  }
};
