const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { hashPayload } = require("./common/idempotency");
const { getAdminByOpenid, hasPermission } = require("./common/auth");

const PAYMENT_TYPES = ["wechat_qr", "alipay_qr", "bank_transfer", "wechat_pay", "custom"];
const OFFLINE_TYPES = ["wechat_qr", "alipay_qr", "bank_transfer", "custom"];
const CONFIG_PERMISSIONS = [
  "system:payment_methods",
  "payment:config",
  "payment:confirm",
  "payment_method:create",
  "payment_method:update",
  "payment_method:disable",
  "payment_method:delete",
  "payment_method:upload_qrcode"
];
const VIEW_PERMISSIONS = ["system:payment_methods", "payment:config", "payment_method:view", "payment:confirm"];
const SENSITIVE_PERMISSIONS = ["payment_method:view_sensitive", "payment:config", "system:payment_methods"];

function getOpenid(event = {}) {
  const wxContext = cloud.getWXContext();
  return wxContext.OPENID || cleanText(event._callerOpenid, 100);
}

function isCollectionExistsError(err) {
  const message = String((err && err.message) || err || "");
  return /already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message);
}

function isMissingCollectionError(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    if (isCollectionExistsError(err)) return;
    if (/createCollection is not a function/i.test(String((err && err.message) || err || ""))) return;
    throw err;
  }
}

async function ensurePaymentCollections() {
  await Promise.all([
    ensureCollection("payment_methods"),
    ensureCollection("payment_method_logs"),
    ensureCollection("payment_records")
  ]);
}

function cleanText(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function cleanOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new Error("金额范围格式错误");
  return Math.round(num);
}

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function maskBankCard(value) {
  const digits = String(value || "").replace(/\s+/g, "");
  if (!digits) return "";
  if (digits.length <= 8) return digits.replace(/.(?=.{4})/g, "*");
  return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
}

function maskMchId(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 6) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function hasAnyPermission(admin, permissions) {
  return permissions.some((permission) => hasPermission(admin, permission));
}

async function getAdmin(event = {}) {
  const openid = getOpenid(event);
  return await getAdminByOpenid(openid);
}

async function requirePaymentAdmin(permissions = CONFIG_PERMISSIONS, event = {}) {
  const admin = await getAdmin(event);
  if (!admin) throw new Error("无管理员权限");
  if (admin.role === "procurement") throw new Error("无权限执行该操作");
  if (admin.role === "finance") return admin;
  if (!hasAnyPermission(admin, permissions)) throw new Error("无权限执行该操作");
  return admin;
}

async function getSystemPaymentSettings() {
  const defaults = {
    enableOfflineQrPayment: true,
    enableBankTransfer: true,
    enableWechatPay: false,
    maxPaymentScreenshotCount: 3,
    allowMultiplePaymentRecords: true,
    requirePaymentProofForOfflinePayment: true
  };
  const res = await db.collection("settings").doc("system_settings").get().catch(() => null);
  const data = res && res.data ? res.data : {};
  return {
    ...defaults,
    ...data,
    maxPaymentScreenshotCount: Math.max(1, Math.min(9, Number(data.maxPaymentScreenshotCount || defaults.maxPaymentScreenshotCount)))
  };
}

function validateType(paymentType) {
  const type = cleanText(paymentType, 40);
  if (!PAYMENT_TYPES.includes(type)) throw new Error("支付类型不支持");
  return type;
}

function requiresQrCode(type) {
  return ["wechat_qr", "alipay_qr", "custom"].includes(type);
}

function normalizePaymentInput(input = {}, existing = {}) {
  const paymentType = input.paymentType === undefined ? existing.paymentType : validateType(input.paymentType);
  const bankCardNo = input.bankCardNo === undefined
    ? String(existing.bankCardNo || "")
    : String(input.bankCardNo || "").replace(/\s+/g, "");
  const data = {
    paymentName: cleanText(input.paymentName === undefined ? existing.paymentName : input.paymentName, 60),
    paymentType,
    description: cleanText(input.description === undefined ? existing.description : input.description, 300),
    qrCodeFileID: cleanText(input.qrCodeFileID === undefined ? existing.qrCodeFileID : input.qrCodeFileID, 300),
    qrCodeUrl: cleanText(input.qrCodeUrl === undefined ? existing.qrCodeUrl : input.qrCodeUrl, 500),
    qrCodeCloudPath: cleanText(input.qrCodeCloudPath === undefined ? existing.qrCodeCloudPath : input.qrCodeCloudPath, 300),
    bankAccountName: cleanText(input.bankAccountName === undefined ? existing.bankAccountName : input.bankAccountName, 80),
    bankName: cleanText(input.bankName === undefined ? existing.bankName : input.bankName, 80),
    bankBranchName: cleanText(input.bankBranchName === undefined ? existing.bankBranchName : input.bankBranchName, 120),
    bankCardNo,
    bankCardNoMasked: maskBankCard(bankCardNo),
    transferRemark: cleanText(input.transferRemark === undefined ? existing.transferRemark : input.transferRemark, 200),
    enabled: normalizeBool(input.enabled, existing.enabled === undefined ? false : existing.enabled),
    isDefault: normalizeBool(input.isDefault, existing.isDefault === undefined ? false : existing.isDefault),
    sortIndex: Number(input.sortIndex === undefined ? existing.sortIndex || 0 : input.sortIndex || 0),
    minAmount: cleanOptionalNumber(input.minAmount === undefined ? existing.minAmount : input.minAmount),
    maxAmount: cleanOptionalNumber(input.maxAmount === undefined ? existing.maxAmount : input.maxAmount),
    extraTips: cleanText(input.extraTips === undefined ? existing.extraTips : input.extraTips, 300),
    wechatPayConfigStatus: cleanText(input.wechatPayConfigStatus === undefined ? existing.wechatPayConfigStatus || "not_configured" : input.wechatPayConfigStatus, 40),
    status: cleanText(input.status === undefined ? existing.status || "active" : input.status, 40)
  };

  if (!data.paymentName) throw new Error("请填写支付方式名称");
  if (data.paymentType === "bank_transfer") {
    if (!data.bankAccountName || !data.bankName || !data.bankCardNo) {
      throw new Error("银行卡转账必须填写户名、银行和银行卡号");
    }
  }
  if (data.maxAmount !== null && data.minAmount !== null && data.maxAmount < data.minAmount) {
    throw new Error("最高可用金额不能小于最低可用金额");
  }
  return data;
}

function isMethodComplete(method, settings) {
  if (!method || method.status === "deleted") return false;
  if (method.paymentType === "bank_transfer") {
    return Boolean(method.bankAccountName && method.bankName && method.bankCardNo);
  }
  if (requiresQrCode(method.paymentType)) {
    return Boolean(method.qrCodeFileID || method.qrCodeUrl);
  }
  if (method.paymentType === "wechat_pay") {
    return settings.enableWechatPay === true && method.wechatPayConfigStatus === "configured";
  }
  return true;
}

function maskPaymentForLog(method = {}) {
  return {
    paymentName: method.paymentName || "",
    paymentType: method.paymentType || "",
    description: method.description || "",
    qrCodeFileID: method.qrCodeFileID ? "[configured]" : "",
    qrCodeUrl: method.qrCodeUrl ? "[configured]" : "",
    bankAccountName: method.bankAccountName || "",
    bankName: method.bankName || "",
    bankBranchName: method.bankBranchName || "",
    bankCardNoMasked: method.bankCardNoMasked || maskBankCard(method.bankCardNo),
    transferRemark: method.transferRemark || "",
    enabled: method.enabled === true,
    isDefault: method.isDefault === true,
    sortIndex: Number(method.sortIndex || 0),
    minAmount: method.minAmount === undefined ? null : method.minAmount,
    maxAmount: method.maxAmount === undefined ? null : method.maxAmount,
    extraTips: method.extraTips || "",
    wechatPayConfigStatus: method.wechatPayConfigStatus || "not_configured",
    status: method.status || "active"
  };
}

async function writePaymentMethodLog({ paymentMethodId, action, beforeData, afterData, admin }) {
  await ensureCollection("payment_method_logs");
  await db.collection("payment_method_logs").add({
    data: {
      paymentMethodId: paymentMethodId || "",
      action,
      beforeDataMasked: beforeData ? maskPaymentForLog(beforeData) : null,
      afterDataMasked: afterData ? maskPaymentForLog(afterData) : null,
      operatorId: admin && (admin._id || admin.id) || "",
      operatorOpenid: admin && admin.openid || getOpenid(),
      operatorRole: admin && admin.role || "",
      createdAt: db.serverDate()
    }
  });
}

async function writeAdminOperation({ admin, action, resourceId, beforeData, afterData, description }) {
  await ensureCollection("admin_operation_logs");
  await db.collection("admin_operation_logs").add({
    data: {
      operatorId: admin && (admin._id || admin.id) || "",
      operatorOpenid: admin && admin.openid || getOpenid(),
      operatorRole: admin && admin.role || "",
      action,
      resourceType: "payment_method",
      resourceId: resourceId || "",
      beforeData: beforeData ? maskPaymentForLog(beforeData) : null,
      afterData: afterData ? maskPaymentForLog(afterData) : null,
      description: description || "",
      createdAt: db.serverDate()
    }
  });
}

function publicPaymentMethod(method, options = {}) {
  const base = {
    paymentMethodId: method._id,
    paymentName: method.paymentName || "",
    paymentType: method.paymentType || "",
    description: method.description || "",
    qrCodeUrl: method.qrCodeUrl || method.qrCodeFileID || "",
    bankAccountName: method.bankAccountName || "",
    bankName: method.bankName || "",
    bankBranchName: method.bankBranchName || "",
    bankCardNoMasked: method.bankCardNoMasked || maskBankCard(method.bankCardNo),
    transferRemark: method.transferRemark || "",
    extraTips: method.extraTips || "",
    isDefault: method.isDefault === true,
    enabled: method.enabled === true && method.status === "active"
  };
  if (options.includeBankCard && method.paymentType === "bank_transfer") {
    base.bankCardNo = method.bankCardNo || "";
  }
  return base;
}

function adminPaymentMethod(method, includeSensitive = false) {
  return {
    ...publicPaymentMethod(method, { includeBankCard: includeSensitive }),
    _id: method._id,
    qrCodeFileID: method.qrCodeFileID || "",
    qrCodeCloudPath: method.qrCodeCloudPath || "",
    bankCardNo: includeSensitive ? method.bankCardNo || "" : "",
    bankCardNoMasked: method.bankCardNoMasked || maskBankCard(method.bankCardNo),
    sortIndex: Number(method.sortIndex || 0),
    minAmount: method.minAmount === undefined ? null : method.minAmount,
    maxAmount: method.maxAmount === undefined ? null : method.maxAmount,
    wechatPayConfigStatus: method.wechatPayConfigStatus || "not_configured",
    status: method.status || "active",
    createdAt: method.createdAt || null,
    updatedAt: method.updatedAt || null,
    createdBy: method.createdBy || "",
    updatedBy: method.updatedBy || ""
  };
}

async function getMethod(id) {
  if (!id) throw new Error("缺少支付方式 ID");
  const method = (await db.collection("payment_methods").doc(id).get()).data;
  if (!method || method.status === "deleted") throw new Error("支付方式不存在或已删除");
  return method;
}

function payableAmount(order) {
  if (!order) return 0;
  if (order.unpaidAmount !== undefined && order.unpaidAmount !== null) return Math.max(0, Number(order.unpaidAmount || 0));
  return Math.max(0, Number(order.totalAmount || 0) - Number(order.paidAmount || 0));
}

function canPayOrder(order) {
  if (!order) return false;
  if (["paid", "cancelled", "rejected", "pending_admin", "auto_reviewing"].includes(order.status)) return false;
  if (["paid", "pending_confirm"].includes(order.paymentStatus)) return false;
  return ["approved_pending_payment", "unpaid", "partial_paid"].includes(order.status)
    || ["unpaid", "partial_paid", "partial"].includes(order.paymentStatus || "unpaid");
}

function isPendingPaymentConfirmOrder(order) {
  return order && (order.paymentStatus === "pending_confirm" || order.status === "pending_payment_confirm");
}

async function getOwnedOrder(orderId, openid = getOpenid()) {
  if (!orderId) throw new Error("缺少订单 ID");
  const order = (await db.collection("orders").doc(orderId).get()).data;
  if (!order || order.userOpenid !== openid) throw new Error("订单不存在");
  if (!canPayOrder(order)) throw new Error("当前订单状态不能支付");
  if (payableAmount(order) <= 0) throw new Error("订单金额为 0，不能支付");
  return order;
}

function assertOwnedPayableOrder(order, openid = getOpenid()) {
  if (!order || order.userOpenid !== openid) throw new Error("订单不存在");
  if (!canPayOrder(order)) throw new Error("当前订单状态不能支付");
  if (payableAmount(order) <= 0) throw new Error("订单金额为 0，不能支付");
}

function snapshotForOrder(method) {
  return {
    paymentName: method.paymentName || "",
    paymentType: method.paymentType || "",
    bankAccountName: method.bankAccountName || "",
    bankName: method.bankName || "",
    bankBranchName: method.bankBranchName || "",
    bankCardNoMasked: method.bankCardNoMasked || maskBankCard(method.bankCardNo),
    transferRemark: method.transferRemark || "",
    qrCodeUrl: method.qrCodeUrl || method.qrCodeFileID || "",
    description: method.description || "",
    extraTips: method.extraTips || ""
  };
}

function isMethodAvailableForAmount(method, amount, settings) {
  if (!method || method.enabled !== true || method.status !== "active") return false;
  if (method.paymentType === "wechat_pay" && (settings.enableWechatPay !== true || method.wechatPayConfigStatus !== "configured")) return false;
  if (["wechat_qr", "alipay_qr", "custom"].includes(method.paymentType) && settings.enableOfflineQrPayment === false) return false;
  if (method.paymentType === "bank_transfer" && settings.enableBankTransfer === false) return false;
  if (method.minAmount !== null && method.minAmount !== undefined && amount < Number(method.minAmount)) return false;
  if (method.maxAmount !== null && method.maxAmount !== undefined && amount > Number(method.maxAmount)) return false;
  return isMethodComplete(method, settings);
}

async function getEnabledPaymentMethods(event = {}) {
  let amount = cleanOptionalNumber(event.amount === undefined ? event.orderAmount : event.amount) || 0;
  let includeBankCard = false;
  if (event.orderId) {
    const order = await getOwnedOrder(event.orderId, getOpenid(event));
    amount = payableAmount(order);
    includeBankCard = true;
  }
  const settings = await getSystemPaymentSettings();
  let res;
  try {
    res = await db.collection("payment_methods")
      .where({ enabled: true, status: "active" })
      .orderBy("sortIndex", "asc")
      .limit(100)
      .get();
  } catch (err) {
    if (!isMissingCollectionError(err)) throw err;
    res = { data: [] };
  }
  const methods = (res.data || [])
    .filter((method) => isMethodAvailableForAmount(method, amount, settings))
    .map((method) => publicPaymentMethod(method, { includeBankCard }));
  return { paymentMethods: methods, systemSettings: settings };
}

async function getAdminPaymentMethods(event = {}) {
  const admin = await requirePaymentAdmin(VIEW_PERMISSIONS, event);
  const includeSensitive = event.includeSensitive === true && (admin.role === "finance" || hasAnyPermission(admin, SENSITIVE_PERMISSIONS));
  let res;
  try {
    res = await db.collection("payment_methods").where({ status: _.neq("deleted") }).orderBy("sortIndex", "asc").limit(200).get();
  } catch (err) {
    if (!isMissingCollectionError(err)) throw err;
    res = { data: [] };
  }
  const wechatPaySettings = await getWechatPayDisplaySettings();
  return {
    paymentMethods: (res.data || []).map((method) => adminPaymentMethod(method, includeSensitive)),
    wechatPaySettings,
    canViewSensitive: includeSensitive || admin.role === "finance" || hasAnyPermission(admin, SENSITIVE_PERMISSIONS)
  };
}

async function createPaymentMethod(event = {}) {
  await ensurePaymentCollections();
  const admin = await requirePaymentAdmin(["system:payment_methods", "payment:config", "payment:confirm", "payment_method:create"], event);
  const data = normalizePaymentInput(event, {});
  data.status = data.status === "disabled" ? "disabled" : "active";
  if (data.enabled && !isMethodComplete(data, await getSystemPaymentSettings())) {
    throw new Error("支付方式信息不完整，不能启用");
  }
  const now = db.serverDate();
  const created = await db.collection("payment_methods").add({
    data: {
      ...data,
      createdAt: now,
      updatedAt: now,
      createdBy: admin._id || admin.id || "",
      updatedBy: admin._id || admin.id || ""
    }
  });
  const saved = { ...data, _id: created._id };
  await writePaymentMethodLog({ paymentMethodId: created._id, action: "create", afterData: saved, admin });
  await writeAdminOperation({ admin, action: "payment_method:create", resourceId: created._id, afterData: saved, description: "Create payment method" });
  return { paymentMethodId: created._id };
}

async function updatePaymentMethod(event = {}) {
  await ensurePaymentCollections();
  const admin = await requirePaymentAdmin(["system:payment_methods", "payment:config", "payment:confirm", "payment_method:update"], event);
  const method = await getMethod(event.paymentMethodId || event.id);
  const next = normalizePaymentInput(event, method);
  const settings = await getSystemPaymentSettings();
  if (next.enabled && !isMethodComplete(next, settings)) throw new Error("支付方式信息不完整，不能启用");
  const changedBank = String(method.bankCardNo || "") !== String(next.bankCardNo || "");
  const changedQr = String(method.qrCodeFileID || method.qrCodeUrl || "") !== String(next.qrCodeFileID || next.qrCodeUrl || "");
  await db.collection("payment_methods").doc(method._id).update({
    data: {
      ...next,
      updatedAt: db.serverDate(),
      updatedBy: admin._id || admin.id || ""
    }
  });
  const action = changedBank ? "update_bank_info" : changedQr ? "upload_qrcode" : "update";
  await writePaymentMethodLog({ paymentMethodId: method._id, action, beforeData: method, afterData: next, admin });
  await writeAdminOperation({ admin, action: `payment_method:${action}`, resourceId: method._id, beforeData: method, afterData: next, description: "Update payment method" });
  return { paymentMethodId: method._id };
}

async function uploadPaymentQrCode(event = {}) {
  await ensurePaymentCollections();
  const admin = await requirePaymentAdmin(["system:payment_methods", "payment:config", "payment:confirm", "payment_method:upload_qrcode"], event);
  const method = await getMethod(event.paymentMethodId);
  const fileID = cleanText(event.fileID || event.qrCodeFileID, 300);
  const url = cleanText(event.url || event.qrCodeUrl || fileID, 500);
  const cloudPath = cleanText(event.cloudPath || event.qrCodeCloudPath, 300);
  const fileName = cleanText(event.fileName || cloudPath || fileID, 300).toLowerCase();
  const size = Number(event.size || event.fileSize || 0);
  if (!fileID && !url) throw new Error("请先上传二维码图片");
  if (fileName && !/\.(jpg|jpeg|png|webp)(\?|$)/i.test(fileName) && !/^cloud:\/\//i.test(fileName)) {
    throw new Error("二维码图片仅支持 jpg、jpeg、png、webp");
  }
  if (size && size > 5 * 1024 * 1024) throw new Error("二维码图片不能超过 5MB");
  const afterData = {
    ...method,
    qrCodeFileID: fileID,
    qrCodeUrl: url,
    qrCodeCloudPath: cloudPath,
    updatedAt: db.serverDate(),
    updatedBy: admin._id || admin.id || ""
  };
  await db.collection("payment_methods").doc(method._id).update({
    data: {
      qrCodeFileID: fileID,
      qrCodeUrl: url,
      qrCodeCloudPath: cloudPath,
      updatedAt: db.serverDate(),
      updatedBy: admin._id || admin.id || ""
    }
  });
  await writePaymentMethodLog({ paymentMethodId: method._id, action: "upload_qrcode", beforeData: method, afterData, admin });
  await writeAdminOperation({ admin, action: "payment_method:upload_qrcode", resourceId: method._id, beforeData: method, afterData, description: "Upload payment QR code" });
  return { paymentMethodId: method._id, qrCodeFileID: fileID, qrCodeUrl: url };
}

async function setPaymentMethodEnabled(event = {}, enabled) {
  await ensurePaymentCollections();
  const admin = await requirePaymentAdmin(["system:payment_methods", "payment:config", "payment:confirm", "payment_method:disable", "payment_method:update"], event);
  const method = await getMethod(event.paymentMethodId);
  const settings = await getSystemPaymentSettings();
  if (enabled && !isMethodComplete(method, settings)) throw new Error("支付方式信息不完整，不能启用");
  const status = enabled ? "active" : "disabled";
  await db.collection("payment_methods").doc(method._id).update({
    data: { enabled, status, updatedAt: db.serverDate(), updatedBy: admin._id || admin.id || "" }
  });
  const afterData = { ...method, enabled, status };
  await writePaymentMethodLog({ paymentMethodId: method._id, action: enabled ? "enable" : "disable", beforeData: method, afterData, admin });
  await writeAdminOperation({ admin, action: enabled ? "payment_method:enable" : "payment_method:disable", resourceId: method._id, beforeData: method, afterData, description: enabled ? "Enable payment method" : "Disable payment method" });
  return { paymentMethodId: method._id, enabled, status };
}

async function deletePaymentMethod(event = {}) {
  await ensurePaymentCollections();
  const admin = await requirePaymentAdmin(["system:payment_methods", "payment:config", "payment:confirm", "payment_method:delete"], event);
  const method = await getMethod(event.paymentMethodId);
  await db.collection("payment_methods").doc(method._id).update({
    data: { enabled: false, status: "deleted", updatedAt: db.serverDate(), updatedBy: admin._id || admin.id || "" }
  });
  const afterData = { ...method, enabled: false, status: "deleted" };
  await writePaymentMethodLog({ paymentMethodId: method._id, action: "delete", beforeData: method, afterData, admin });
  await writeAdminOperation({ admin, action: "payment_method:delete", resourceId: method._id, beforeData: method, afterData, description: "Soft delete payment method" });
  return { paymentMethodId: method._id, status: "deleted" };
}

async function selectOrderPaymentMethod(event = {}) {
  await ensurePaymentCollections();
  const order = await getOwnedOrder(event.orderId, getOpenid(event));
  const method = await getMethod(event.paymentMethodId);
  const settings = await getSystemPaymentSettings();
  if (!isMethodAvailableForAmount(method, payableAmount(order), settings)) throw new Error("支付方式不可用");
  const snapshot = snapshotForOrder(method);
  await db.collection("orders").doc(order._id).update({
    data: {
      paymentMethodId: method._id,
      paymentMethodType: method.paymentType,
      paymentMethodName: method.paymentName,
      paymentMethodSnapshot: snapshot,
      updatedAt: db.serverDate()
    }
  });
  return {
    orderId: order._id,
    paymentMethod: publicPaymentMethod(method, { includeBankCard: true }),
    paymentMethodSnapshot: snapshot
  };
}

async function submitOfflinePaymentProof(event = {}) {
  const orderId = cleanText(event.orderId, 100);
  const screenshotUrls = Array.isArray(event.screenshotUrls)
    ? event.screenshotUrls.map((item) => cleanText(item, 500)).filter(Boolean)
    : [cleanText(event.screenshotUrl || event.paymentScreenshotUrl, 500)].filter(Boolean);
  const openid = getOpenid(event);
  const requestPayload = {
    orderId,
    paymentMethodId: event.paymentMethodId || "",
    screenshotCount: screenshotUrls.length,
    remark: cleanText(event.remark, 300),
    openid
  };
  if (!orderId) throw new Error("订单不存在");

  const settings = await getSystemPaymentSettings();
  if (settings.requirePaymentProofForOfflinePayment && !screenshotUrls.length) throw new Error("请先上传付款截图");
  if (screenshotUrls.length > settings.maxPaymentScreenshotCount) throw new Error(`付款截图最多上传 ${settings.maxPaymentScreenshotCount} 张`);

  const result = await db.runTransaction(async (tx) => {
    const order = (await tx.collection("orders").doc(orderId).get()).data;
    if (!order || order.userOpenid !== openid) throw new Error("订单不存在");
    if (isPendingPaymentConfirmOrder(order)) {
      return {
        orderId: order._id,
        paymentRecordId: order.latestPaymentRecordId || "",
        paymentStatus: "pending_confirm",
        reused: true,
        userId: order.userId || "",
        userOpenid: order.userOpenid || openid
      };
    }

    assertOwnedPayableOrder(order, openid);
    const methodId = event.paymentMethodId || order.paymentMethodId;
    const method = (await tx.collection("payment_methods").doc(methodId).get()).data;
    if (!method || method.status === "deleted") throw new Error("支付方式不存在或已删除");
    const amount = payableAmount(order);
    if (!OFFLINE_TYPES.includes(method.paymentType)) throw new Error("该支付方式不支持上传付款截图");
    if (!isMethodAvailableForAmount(method, amount, settings)) throw new Error("支付方式不可用");

    const snapshot = snapshotForOrder(method);
    const requestHash = hashPayload({ ...requestPayload, amount });
    const businessKey = `submit_payment_proof:${order._id}:${event.idempotencyKey || ""}`;
    let existingRecord = await tx.collection("payment_records").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
    if (!(existingRecord.data && existingRecord.data[0]) && event.idempotencyKey) {
      existingRecord = await tx.collection("payment_records").where({
        orderId: order._id,
        idempotencyKey: event.idempotencyKey,
        status: "pending_confirm"
      }).limit(1).get().catch(() => ({ data: [] }));
    }
    const record = existingRecord.data && existingRecord.data[0]
      ? existingRecord.data[0]
      : {
        _id: (await tx.collection("payment_records").add({
          data: {
            orderId: order._id,
            orderNo: order.orderNo || "",
            userId: order.userId || "",
            userOpenid: openid,
            paymentMethodId: method._id,
            paymentMethodType: method.paymentType,
            paymentMethodName: method.paymentName,
            amount,
            status: "pending_confirm",
            screenshotUrls,
            screenshotUrl: screenshotUrls[0] || "",
            paymentScreenshotUrl: screenshotUrls[0] || "",
            idempotencyKey: event.idempotencyKey || "",
            businessKey,
            requestHash,
            wechatPayTransactionId: "",
            wechatPayOutTradeNo: "",
            submittedAt: db.serverDate(),
            confirmedAt: null,
            confirmedBy: "",
            remark: cleanText(event.remark, 300),
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        }))._id
      };

    await tx.collection("orders").doc(order._id).update({
      data: {
        paymentMethodId: method._id,
        paymentMethodType: method.paymentType,
        paymentMethodName: method.paymentName,
        paymentMethodSnapshot: snapshot,
        paymentStatus: "pending_confirm",
        status: "pending_payment_confirm",
        paymentSubmittedAt: db.serverDate(),
        paymentScreenshotUrls: screenshotUrls,
        paymentScreenshotUrl: screenshotUrls[0] || "",
        latestPaymentRecordId: record._id,
        updatedAt: db.serverDate()
      }
    });

    return {
      orderId: order._id,
      paymentRecordId: record._id,
      paymentStatus: "pending_confirm",
      reused: Boolean(existingRecord.data && existingRecord.data[0]),
      userId: order.userId || "",
      userOpenid: order.userOpenid || openid
    };
  });

  if (!result.reused) {
    await db.collection("admin_notifications").add({
      data: {
        type: "payment_confirm",
        orderId: result.orderId,
        paymentRecordId: result.paymentRecordId,
        paymentMethodId: event.paymentMethodId || "",
        userOpenid: openid,
        isRead: false,
        createdAt: db.serverDate()
      }
    }).catch(() => null);
  }

  return result;
}

async function getWechatPayDisplaySettings() {
  const settings = await getSystemPaymentSettings();
  const res = await db.collection("settings").doc("wechat_pay_settings").get().catch(() => null);
  const data = res && res.data ? res.data : {};
  const envConfigured = Boolean(process.env.WECHAT_PAY_MCH_ID && process.env.WECHAT_PAY_API_V3_KEY && process.env.WECHAT_PAY_PRIVATE_KEY && process.env.WECHAT_PAY_SERIAL_NO && process.env.WECHAT_PAY_NOTIFY_URL);
  const configStatus = settings.enableWechatPay === true && (data.configStatus === "configured" || envConfigured) ? "configured" : data.configStatus || "not_configured";
  return {
    enabled: settings.enableWechatPay === true,
    mchIdMasked: data.mchIdMasked || maskMchId(process.env.WECHAT_PAY_MCH_ID || ""),
    appId: data.appId || process.env.WECHAT_PAY_APP_ID || "",
    notifyUrl: data.notifyUrl || process.env.WECHAT_PAY_NOTIFY_URL || "",
    configStatus,
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || ""
  };
}

async function createWechatPayOrder(event = {}) {
  await ensurePaymentCollections();
  const settings = await getSystemPaymentSettings();
  if (settings.enableWechatPay !== true) {
    return { code: "WECHAT_PAY_DISABLED", message: "微信支付暂未启用" };
  }
  const order = await getOwnedOrder(event.orderId, getOpenid(event));
  const method = await getMethod(event.paymentMethodId || order.paymentMethodId);
  if (method.paymentType !== "wechat_pay") throw new Error("支付方式不是微信支付");
  const wechatSettings = await getWechatPayDisplaySettings();
  if (wechatSettings.configStatus !== "configured") {
    return { code: "WECHAT_PAY_NOT_CONFIGURED", message: "微信支付暂未启用" };
  }
  return {
    code: "WECHAT_PAY_NOT_CONFIGURED",
    message: "微信支付商户接口尚未完成安全配置，请选择收款码或银行卡转账"
  };
}

async function handleWechatPayNotify() {
  const settings = await getWechatPayDisplaySettings();
  if (settings.configStatus !== "configured") {
    return { code: "WECHAT_PAY_NOT_CONFIGURED", message: "微信支付暂未启用" };
  }
  return { code: "WECHAT_PAY_NOTIFY_NOT_IMPLEMENTED", message: "微信支付回调验签模块尚未完成，未更新订单状态" };
}

async function queryWechatPayOrder(event = {}) {
  await ensurePaymentCollections();
  const settings = await getSystemPaymentSettings();
  if (settings.enableWechatPay !== true) {
    return { code: "WECHAT_PAY_DISABLED", message: "微信支付暂未启用" };
  }
  await getOwnedOrder(event.orderId, getOpenid(event));
  const wechatSettings = await getWechatPayDisplaySettings();
  if (wechatSettings.configStatus !== "configured") {
    return { code: "WECHAT_PAY_NOT_CONFIGURED", message: "微信支付暂未启用" };
  }
  return { code: "WECHAT_PAY_QUERY_NOT_IMPLEMENTED", message: "微信支付查询模块尚未完成，订单状态未改变" };
}

const handlers = {
  getEnabledPaymentMethods,
  getAdminPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  uploadPaymentQrCode,
  enablePaymentMethod: (event) => setPaymentMethodEnabled(event, true),
  disablePaymentMethod: (event) => setPaymentMethodEnabled(event, false),
  deletePaymentMethod,
  selectOrderPaymentMethod,
  submitOfflinePaymentProof,
  createWechatPayOrder,
  handleWechatPayNotify,
  queryWechatPayOrder
};

exports.main = async (event = {}) => {
  const action = event.action || event._action || "";
  const handler = handlers[action];
  if (!handler) return { ok: false, message: "未知支付操作" };
  try {
    const data = await handler(event);
    if (data && data.code) {
      return { ok: false, code: data.code, message: data.message, data };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: err.message || "支付操作失败" };
  }
};
