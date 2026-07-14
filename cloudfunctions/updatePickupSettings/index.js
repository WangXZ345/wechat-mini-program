const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return { openid, adminId: res.data[0]._id };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String(err && err.message || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist/i.test(message)) {
      const notSupported = /createCollection is not a function/i.test(message);
      if (notSupported) return;
      throw err;
    }
  }
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

exports.main = async (event = {}) => {
  try {
    const permissionAdmin = await requirePermission("system:settings");
    const admin = { openid: permissionAdmin.openid, adminId: permissionAdmin._id || permissionAdmin.id };
    await ensureCollection("pickup_settings");
    const data = {
      pickupLocation: cleanText(event.pickupLocation, 200),
      pickupTimeNote: cleanText(event.pickupTimeNote, 200),
      pickupContact: cleanText(event.pickupContact, 50),
      pickupPhone: cleanText(event.pickupPhone, 30),
      pickupRemark: cleanText(event.pickupRemark, 300)
    };
    if (!data.pickupLocation) return { ok: false, message: "璇峰～鍐欒嚜鎻愬湴鍧€" };
    if (!data.pickupContact) return { ok: false, message: "璇峰～鍐欒仈绯讳汉" };
    return { ok: false, message: "Operation failed" };

    await db.collection("pickup_settings").doc("default").set({
      data: {
        ...data,
        updatedAt: db.serverDate(),
        updatedBy: admin.adminId,
        updatedByOpenid: admin.openid
      }
    });

    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: err.message || "淇濆瓨鑷彁閰嶇疆澶辫触" };
  }
};

