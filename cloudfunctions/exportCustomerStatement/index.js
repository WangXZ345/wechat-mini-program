const cloud = require("wx-server-sdk");
const xlsx = require("xlsx");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");
const { canViewFullPhone, maskPhone } = require("./phone");

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
    if (!/exist|already|collection exists/i.test(err.message || "")) throw err;
  }
}

function money(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function formatDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inRange(row, start, end) {
  const date = toDate(row.createdAt || row.approvedAt || row.confirmedAt);
  if (!date) return true;
  if (start && date.getTime() < start.getTime()) return false;
  if (end && date.getTime() > end.getTime()) return false;
  return true;
}

async function getAccount(event) {
  if (event.accountId) return (await db.collection("customer_accounts").doc(event.accountId).get()).data;
  if (event.userId) {
    const res = await db.collection("customer_accounts").where({ userId: event.userId }).limit(1).get();
    return res.data[0] || null;
  }
  if (event.userOpenid) {
    const res = await db.collection("customer_accounts").where({ userOpenid: event.userOpenid }).limit(1).get();
    return res.data[0] || null;
  }
  return null;
}

async function rows(collection, account) {
  const filters = [];
  if (account.userId) filters.push({ userId: account.userId });
  if (account.userOpenid) filters.push({ userOpenid: account.userOpenid });
  const map = {};
  for (const where of filters) {
    const res = await db.collection(collection).where(where).orderBy("createdAt", "desc").limit(1000).get();
    res.data.forEach((row) => {
      map[row._id] = row;
    });
  }
  return Object.values(map);
}

function sheetFromJson(rows, columns) {
  return xlsx.utils.json_to_sheet(rows.map((row) => {
    const output = {};
    columns.forEach((column) => {
      output[column.title] = column.value(row);
    });
    return output;
  }));
}

async function attachAccountPhone(account, admin) {
  let user = null;
  if (account.userId) {
    try {
      user = (await db.collection("users").doc(account.userId).get()).data;
    } catch (err) {
      user = null;
    }
  }
  if (!user && account.userOpenid) {
    const res = await db.collection("users").where({ openid: account.userOpenid }).limit(1).get();
    user = res.data[0] || null;
  }
  const full = user && (user.phoneNumber || user.phone) || account.phoneNumber || account.phone || "";
  const masked = user && user.phoneMasked || account.phoneMasked || maskPhone(full);
  return {
    ...account,
    phoneDisplay: canViewFullPhone(admin) ? (full || masked) : masked
  };
}

function buildWorkbook(account, orders, payments, event) {
  const workbook = xlsx.utils.book_new();
  const summary = [
    { item: "nickname", value: account.nickname || "" },
    { item: "phone", value: account.phoneDisplay || "" },
    { item: "openid", value: account.userOpenid || "" },
    { item: "startDate", value: event.startDate || "all" },
    { item: "endDate", value: event.endDate || "all" },
    { item: "totalOrderAmount", value: money(account.totalOrderAmount || account.totalReceivableAmount) },
    { item: "totalPaidAmount", value: money(account.totalPaidAmount || account.paidAmount) },
    { item: "totalUnpaidAmount", value: money(account.totalUnpaidAmount || account.unpaidAmount) },
    { item: "adminRemark", value: account.adminRemark || "" }
  ];
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(summary), "Summary");
  xlsx.utils.book_append_sheet(workbook, sheetFromJson(orders, [
    { title: "orderNo", value: (row) => row.orderNo || row._id },
    { title: "createdAt", value: (row) => formatDate(row.createdAt) },
    { title: "totalAmount", value: (row) => money(row.totalAmount) },
    { title: "paidAmount", value: (row) => money(row.paidAmount) },
    { title: "unpaidAmount", value: (row) => money(row.unpaidAmount) },
    { title: "paymentStatus", value: (row) => row.paymentStatus || "" },
    { title: "status", value: (row) => row.status || "" }
  ]), "Orders");
  xlsx.utils.book_append_sheet(workbook, sheetFromJson(payments, [
    { title: "confirmedAt", value: (row) => formatDate(row.confirmedAt || row.createdAt) },
    { title: "orderId", value: (row) => row.orderId || "" },
    { title: "orderAmount", value: (row) => money(row.orderAmount) },
    { title: "paidAmount", value: (row) => money(row.paidAmount) },
    { title: "paymentMethod", value: (row) => row.paymentMethod || "" },
    { title: "confirmedBy", value: (row) => row.confirmedBy || "" },
    { title: "confirmStatus", value: (row) => row.confirmStatus || "" },
    { title: "remark", value: (row) => row.remark || "" }
  ]), "Payments");
  return workbook;
}

exports.main = async (event = {}) => {
  try {
    const permissionAdmin = await requirePermission("customer:export_account");
    const admin = { openid: permissionAdmin.openid, adminId: permissionAdmin._id || permissionAdmin.id };
    const rawAccount = await getAccount(event);
    const account = rawAccount ? await attachAccountPhone(rawAccount, permissionAdmin) : null;
    if (!account) return { ok: false, message: "Account not found" };
    const start = toDate(event.startDate);
    const end = toDate(event.endDate);
    const allOrders = (await rows("orders", account)).filter((row) => inRange(row, start, end));
    const allPayments = (await rows("payment_records", account)).filter((row) => inRange(row, start, end));
    const workbook = buildWorkbook(account, allOrders, allPayments, event);
    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
    const stamp = Date.now();
    const fileName = `瀹㈡埛瀵硅处鍗昣${account.nickname || account.userOpenid || account.userId}_${stamp}.xlsx`;
    const uploaded = await cloud.uploadFile({
      cloudPath: `exports/customer-statements/${fileName}`,
      fileContent: buffer
    });
    const urls = await cloud.getTempFileURL({ fileList: [uploaded.fileID] });
    const fileUrl = urls.fileList && urls.fileList[0] && urls.fileList[0].tempFileURL;
    await ensureCollection("export_records");
    await db.collection("export_records").add({
      data: {
        exportType: "customer_statement",
        fileName,
        fileID: uploaded.fileID,
        fileUrl: fileUrl || "",
        filters: { startDate: event.startDate || "", endDate: event.endDate || "", userId: account.userId || "", userOpenid: account.userOpenid || "" },
        totalOrders: allOrders.length,
        totalRows: allOrders.length + allPayments.length,
        operatorId: admin.adminId,
        operatorOpenid: admin.openid,
        status: "success",
        errorMessage: "",
        createdAt: db.serverDate()
      }
    });
    return { ok: true, data: { fileID: uploaded.fileID, fileUrl, fileName, totalOrders: allOrders.length, totalPayments: allPayments.length } };
  } catch (err) {
    return { ok: false, message: err.message || "Export customer statement failed" };
  }
};

