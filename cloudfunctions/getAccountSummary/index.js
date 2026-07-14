const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { publicPhoneProfile } = require("./common/phone");

async function isAdmin(openid) {
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  return res.data.length > 0;
}

async function getUser(openid) {
  const res = await db.collection("users").where({ openid }).limit(1).get();
  return res.data[0] || null;
}

async function findAccount(user) {
  if (!user) return null;
  let res = await db.collection("customer_accounts").where({ userId: user._id }).limit(1).get();
  if (res.data[0]) return res.data[0];
  res = await db.collection("customer_accounts").where({ userOpenid: user.openid }).limit(1).get();
  return res.data[0] || null;
}

function publicAccount(account, user) {
  const phone = publicPhoneProfile(user || {});
  if (!account) {
    return {
      ...phone,
      totalOrderAmount: 0,
      totalPaidAmount: 0,
      totalUnpaidAmount: 0,
      todayOrderAmount: 0,
      historyUnpaidAmount: 0,
      pendingConfirmAmount: 0,
      payableAmount: 0
    };
  }
  const todayOrderAmount = Number(account.todayOrderAmount || 0);
  const historyUnpaidAmount = Number(account.historyUnpaidAmount || 0);
  return {
    ...phone,
    userId: account.userId || "",
    totalOrderAmount: Number(account.totalOrderAmount || account.totalReceivableAmount || 0),
    totalPaidAmount: Number(account.totalPaidAmount || account.paidAmount || 0),
    totalUnpaidAmount: Number(account.totalUnpaidAmount || account.unpaidAmount || 0),
    todayOrderAmount,
    historyUnpaidAmount,
    pendingConfirmAmount: Number(account.pendingConfirmAmount || 0),
    payableAmount: todayOrderAmount + historyUnpaidAmount
  };
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;

  try {
    const admin = await isAdmin(openid);
    if (event.admin === true) {
      if (!admin) return { ok: false, message: "无管理员权限" };
      const result = await cloud.callFunction({
        name: "adminListCustomerAccounts",
        data: event
      });
      return result.result;
    }

    const user = await getUser(openid);
    if (!user) return { ok: true, data: { account: publicAccount(null, null) } };
    const recalculated = await cloud.callFunction({
      name: "recalculateCustomerAccount",
      data: { userId: user._id, userOpenid: openid }
    }).catch(() => null);
    const account = recalculated && recalculated.result && recalculated.result.ok
      ? recalculated.result.data.account
      : await findAccount(user);

    return { ok: true, data: { account: publicAccount(account, user) } };
  } catch (err) {
    return { ok: false, message: err.message || "获取账款汇总失败" };
  }
};
