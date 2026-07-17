const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const APPROVED_ORDER_STATUSES = [
  "approved_pending_payment",
  "pending_payment_confirm",
  "paid",
  "unpaid",
  "partial_paid",
  "partial",
  "abnormal"
];

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function isActiveAdmin(openid) {
  if (!openid) return false;
  try {
    const res = await db.collection("admin_users").where({
      openid,
      isActive: _.neq(false),
      status: _.neq("disabled")
    }).limit(1).get();
    return res.data.length > 0;
  } catch (err) {
    return false;
  }
}

function cents(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.round(num));
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value.$date) return new Date(value.$date);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function localDateKey(value) {
  const date = toDate(value) || new Date();
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isApprovedOrder(order) {
  return APPROVED_ORDER_STATUSES.includes(order.status) || order.accountIncluded === true;
}

function orderPaidAmount(order) {
  if (order.netPaidAmount !== undefined && order.netPaidAmount !== null) return cents(order.netPaidAmount);
  const refund = cents(order.totalRefundAmount || 0);
  if (order.paidAmount !== undefined && order.paidAmount !== null) return cents(order.paidAmount);
  if (order.paymentStatus === "paid" || order.status === "paid") return Math.max(cents(order.totalAmount) - refund, 0);
  if (refund > 0) return Math.max(cents(order.paidAmount || 0) - refund, 0);
  return 0;
}

function orderUnpaidAmount(order) {
  if (order.settlementStatus === "manual_settled") return 0;
  if (order.unpaidAmount !== undefined && order.unpaidAmount !== null) return cents(order.unpaidAmount);
  return Math.max(cents(order.totalAmount) - orderPaidAmount(order), 0);
}

async function findUser(event) {
  if (event.userId) {
    try {
      const user = (await db.collection("users").doc(event.userId).get()).data;
      if (user) return user;
    } catch (err) {
      return { _id: event.userId, openid: event.userOpenid || "" };
    }
  }
  const openid = event.userOpenid || event.openid;
  if (!openid) return null;
  const res = await db.collection("users").where({ openid }).limit(1).get();
  return res.data[0] || { _id: event.userId || "", openid };
}

async function getAllOrders(user) {
  const filters = [];
  if (user._id) filters.push({ userId: user._id });
  if (user.openid) filters.push({ userOpenid: user.openid });
  const map = {};
  for (const where of filters) {
    const res = await db.collection("orders").where(where).orderBy("createdAt", "desc").limit(1000).get();
    res.data.forEach((order) => {
      map[order._id] = order;
    });
  }
  return Object.values(map);
}

async function getExistingAccount(user) {
  const filters = [];
  if (user._id) filters.push({ userId: user._id });
  if (user.openid) filters.push({ userOpenid: user.openid });
  for (const where of filters) {
    const res = await db.collection("customer_accounts").where(where).limit(1).get();
    if (res.data[0]) return res.data[0];
  }
  return null;
}

async function getAccountById(accountId) {
  if (!accountId) return null;
  try {
    return (await db.collection("customer_accounts").doc(accountId).get()).data || null;
  } catch (err) {
    return null;
  }
}

function userFromAccount(account) {
  if (!account) return null;
  const userId = String(account.userId || "").trim();
  const userOpenid = String(account.userOpenid || "").trim();
  if (!userId && !userOpenid) return null;
  return {
    _id: userId,
    openid: userOpenid,
    nickname: account.nickname || "",
    phone: account.phone || ""
  };
}

function buildSummary(user, orders, existing) {
  const today = localDateKey(new Date());
  const approved = orders.filter(isApprovedOrder);
  let totalOrderAmount = 0;
  let totalPaidAmount = 0;
  let totalUnpaidAmount = 0;
  let todayOrderAmount = 0;
  let historyUnpaidAmount = 0;
  let pendingConfirmAmount = 0;
  let abnormalAmount = 0;
  let abnormalCount = 0;
  let paidOrderCount = 0;
  let unpaidOrderCount = 0;
  let partialPaidOrderCount = 0;
  let lastOrderAt = null;
  let lastPaymentAt = null;

  approved.forEach((order) => {
    const total = cents(order.totalAmount);
    const paid = orderPaidAmount(order);
    const unpaid = orderUnpaidAmount(order);
    const approvedAt = order.approvedAt || order.createdAt;
    const paymentAt = order.paymentConfirmedAt || order.paidMarkedAt;

    totalOrderAmount += total;
    totalPaidAmount += Math.min(paid, total);
    totalUnpaidAmount += unpaid;

    if (localDateKey(approvedAt) === today) todayOrderAmount += total;
    else historyUnpaidAmount += unpaid;

    if (order.paymentStatus === "pending_confirm") pendingConfirmAmount += unpaid || total;
    if (order.paymentStatus === "abnormal" || order.status === "abnormal") {
      abnormalCount += 1;
      abnormalAmount += unpaid || total;
    }
    if (order.paymentStatus === "paid" || order.status === "paid") paidOrderCount += 1;
    if (order.paymentStatus === "partial_paid" || order.paymentStatus === "partial" || order.status === "partial_paid") partialPaidOrderCount += 1;
    if (unpaid > 0 && order.paymentStatus !== "partial_paid" && order.paymentStatus !== "partial") unpaidOrderCount += 1;

    const orderDate = toDate(approvedAt);
    if (orderDate && (!lastOrderAt || orderDate.getTime() > lastOrderAt.getTime())) lastOrderAt = orderDate;
    const payDate = toDate(paymentAt);
    if (payDate && (!lastPaymentAt || payDate.getTime() > lastPaymentAt.getTime())) lastPaymentAt = payDate;
  });

  const isSettled = totalUnpaidAmount <= 0 || Boolean(existing && existing.isSettled && totalUnpaidAmount === 0);
  return {
    userId: user._id || "",
    userOpenid: user.openid || "",
    nickname: user.nickname || "",
    phone: user.phone || "",
    totalOrderAmount,
    totalPaidAmount,
    totalUnpaidAmount,
    todayOrderAmount,
    historyUnpaidAmount,
    pendingConfirmAmount,
    abnormalAmount,
    abnormalCount,
    orderCount: approved.length,
    paidOrderCount,
    unpaidOrderCount,
    partialPaidOrderCount,
    lastOrderAt,
    lastPaymentAt,
    riskLevel: existing && existing.riskLevel ? existing.riskLevel : "normal",
    isSettled,
    adminRemark: existing && existing.adminRemark ? existing.adminRemark : "",
    adminNote: existing && existing.adminNote ? existing.adminNote : "",
    adminTags: existing && Array.isArray(existing.adminTags) ? existing.adminTags : [],
    adminNoteUpdatedAt: existing && existing.adminNoteUpdatedAt ? existing.adminNoteUpdatedAt : null,
    adminNoteUpdatedBy: existing && existing.adminNoteUpdatedBy ? existing.adminNoteUpdatedBy : "",
    adminNoteUpdatedByOpenid: existing && existing.adminNoteUpdatedByOpenid ? existing.adminNoteUpdatedByOpenid : "",
    todayDate: today,
    totalReceivableAmount: totalOrderAmount,
    paidAmount: totalPaidAmount,
    unpaidAmount: totalUnpaidAmount,
    updatedAt: db.serverDate()
  };
}

function publicAccount(account) {
  if (!account) {
    return {
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
  try {
    const callerOpenid = cloud.getWXContext().OPENID;
    const admin = await isActiveAdmin(callerOpenid);
    let existing = null;
    let user = null;
    if (admin && event.accountId) {
      existing = await getAccountById(String(event.accountId).trim());
      if (!existing) return fail("客户账款不存在");
      user = userFromAccount(existing);
    } else {
      const safeEvent = admin ? event : { userOpenid: callerOpenid };
      user = await findUser(safeEvent);
      if (user) existing = await getExistingAccount(user);
    }
    if (!user) return fail("缺少客户标识");
    if (!admin && user.openid !== callerOpenid) return fail("无权限访问该客户账款");
    const orders = await getAllOrders(user);
    const summary = buildSummary(user, orders, existing);

    let accountId = existing && existing._id;
    if (existing) {
      await db.collection("customer_accounts").doc(existing._id).update({ data: summary });
    } else {
      const created = await db.collection("customer_accounts").add({
        data: { ...summary, createdAt: db.serverDate() }
      });
      accountId = created._id;
    }

    const account = { _id: accountId, ...summary };
    return ok({ accountId, account: admin ? account : publicAccount(account) });
  } catch (err) {
    return fail(err.message || "重新计算账款失败");
  }
};
