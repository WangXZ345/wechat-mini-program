const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission, hasPermission } = require("./auth");
const {
  sanitizeCustomerForRole,
  sanitizeCustomerAccountForRole,
  sanitizeOrderForRole,
  sanitizeLogsForRole
} = require("./sanitize");

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

async function findUser(userId) {
  try {
    const user = (await db.collection("users").doc(userId).get()).data;
    if (user) return user;
  } catch (err) {
    // Continue with openid lookup.
  }
  const byOpenid = await db.collection("users").where({ openid: userId }).limit(1).get();
  return byOpenid.data[0] || null;
}

async function findAccount(user) {
  const filters = [];
  if (user._id) filters.push({ userId: user._id });
  if (user.openid) filters.push({ userOpenid: user.openid });
  for (const where of filters) {
    const res = await db.collection("customer_accounts").where(where).limit(1).get();
    if (res.data[0]) return res.data[0];
  }
  return null;
}

async function getRecentOrders(user) {
  const filters = [];
  if (user._id) filters.push({ userId: user._id });
  if (user.openid) filters.push({ userOpenid: user.openid });
  const map = {};
  for (const where of filters) {
    const res = await db.collection("orders").where(where).orderBy("createdAt", "desc").limit(20).get();
    res.data.forEach((order) => {
      map[order._id] = order;
    });
  }
  return Object.values(map).sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return tb - ta;
  }).slice(0, 20);
}

async function getLogs(userId) {
  try {
    const logs = await db.collection("note_logs")
      .where({ targetType: "customer", targetId: userId })
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();
    return logs.data;
  } catch (err) {
    return [];
  }
}

async function getPhoneLogs(userId, admin) {
  if (!hasPermission(admin, "customer:view_phone_log")) return [];
  try {
    const logs = await db.collection("phone_bind_logs")
      .where({ userId })
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();
    return logs.data;
  } catch (err) {
    return [];
  }
}

function normalizeRiskLevel(value) {
  if (value === "watch") return "important";
  if (value === "risky") return "risk";
  return value || "normal";
}

exports.main = async (event = {}) => {
  const userId = String(event.userId || "").trim();
  if (!userId) return fail("缂哄皯瀹㈡埛 ID");

  try {
    const admin = await requirePermission("customer:view_basic");
    const user = await findUser(userId);
    if (!user) return fail("客户不存在");

    const account = await findAccount(user);
    const orders = await getRecentOrders(user);
    const noteLogs = await getLogs(user._id);
    const phoneLogs = await getPhoneLogs(user._id, admin);

    return ok({
      user: sanitizeCustomerForRole(user, admin),
      account: account ? sanitizeCustomerAccountForRole({ ...account, riskLevel: normalizeRiskLevel(account.riskLevel) }, admin) : sanitizeCustomerAccountForRole({
        userId: user._id,
        userOpenid: user.openid || "",
        adminNote: "",
        adminTags: [],
        riskLevel: "normal",
        unpaidAmount: 0,
        historyUnpaidAmount: 0,
        todayOrderAmount: 0,
        totalReceivableAmount: 0,
        paidAmount: 0
      }, admin),
      orders: orders.map((order) => sanitizeOrderForRole(order, admin)),
      noteLogs: sanitizeLogsForRole(noteLogs, admin),
      phoneLogs: sanitizeLogsForRole(phoneLogs, admin)
    });
  } catch (err) {
    return fail(err.message || "鑾峰彇瀹㈡埛璇︽儏澶辫触");
  }
};

