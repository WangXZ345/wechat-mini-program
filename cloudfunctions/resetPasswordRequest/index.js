const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const MAX_REQUESTS = 3;
const WINDOW_MS = 10 * 60 * 1000;
const requests = {};

function normalizePhone(phone) {
  const value = String(phone || "").trim().replace(/[\s-]/g, "").replace(/^(\+?86|0086)/, "");
  if (!/^1[3-9]\d{9}$/.test(value)) throw new Error("INVALID_PHONE");
  return value;
}

function maskPhone(phone) {
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}

function rateLimited(phone) {
  const now = Date.now();
  const record = requests[phone];
  if (!record || now - record.firstAt > WINDOW_MS) {
    requests[phone] = { firstAt: now, count: 1 };
    return false;
  }
  record.count += 1;
  return record.count > MAX_REQUESTS;
}

async function findUser(phone) {
  let res = await db.collection("users").where({ phone }).limit(1).get();
  if (res.data && res.data[0]) return res.data[0];
  res = await db.collection("users").where({ phoneNumber: phone }).limit(1).get();
  return res.data && res.data[0] || null;
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String(err && err.message || err || "");
    if (/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|exist/i.test(message)) return;
    if (/createCollection is not a function/i.test(message)) return;
    throw err;
  }
}

exports.main = async (event = {}) => {
  let phone = "";
  try {
    phone = normalizePhone(event.phone);
  } catch (err) {
    return { ok: false, code: "INVALID_PHONE", message: "手机号格式不正确" };
  }

  if (rateLimited(phone)) {
    return { ok: false, code: "TOO_MANY_REQUESTS", message: "操作过于频繁，请稍后再试" };
  }

  try {
    const wxContext = cloud.getWXContext();
    const user = await findUser(phone);
    await ensureCollection("password_reset_requests");
    await db.collection("password_reset_requests").add({
      data: {
        phone,
        phoneMasked: maskPhone(phone),
        userId: user && user._id || "",
        openid: wxContext.OPENID || "",
        status: "pending",
        source: "mini_program",
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  } catch (err) {
    console.error("resetPasswordRequest error:", err && err.message || err);
  }

  return {
    ok: true,
    data: {
      message: "已提交重置申请，请联系客户确认处理进度"
    }
  };
};
