const cloud = require("wx-server-sdk");
const xlsx = require("xlsx");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const {
  runIdempotentAction,
  beginIdempotentAction,
  finishIdempotentAction,
  failIdempotentAction,
  idempotencyEarlyReturn,
  idempotencyErrorResponse,
  firstSuccessData
} = require("./idempotency");
const {
  sanitizeAfterSaleForRole,
  sanitizeRefundForRole,
  sanitizeLogsForRole
} = require("./sanitize");
const { createAfterSaleReviewService } = require("./common/services/afterSaleReviewService");
const { assertAfterSaleSnapshot, canCompleteAfterSale } = require("./common/services/returnSnapshot");
const commonIdempotency = require("./common/idempotency");
const { ownerKeyFor } = require("./common/syncEvents");
const {
  applyInventoryMutationInTransaction
} = require("./common/services/inventoryMutationService");
const stockAlert = require("./_utils/stockAlert");
const { createReturnInspectionService } = require("./common/services/returnInspectionService");
const { createRefundMutationService } = require("./common/services/refundMutationService");

const refundMutationService = createRefundMutationService({
  db,
  idempotency: commonIdempotency,
  ownerKeyFor,
  syncOwnerPepper: process.env.SYNC_OWNER_PEPPER || "",
  recalculateAccount({ accountId }) {
    return cloud.callFunction({
      name: "recalculateCustomerAccount",
      data: { accountId }
    });
  }
});

const AFTER_SALE_TYPES = ["refund_only", "return_refund", "exchange", "resend", "price_adjustment_refund"];
const AFTER_SALE_REASONS = [
  "customer_cancel",
  "out_of_stock",
  "wrong_item",
  "missing_item",
  "damaged",
  "defective",
  "quality_issue",
  "price_error",
  "overpaid",
  "duplicate_payment",
  "address_issue",
  "shipping_issue",
  "other"
];
const ACTIVE_AFTER_SALE_STATUSES = [
  "pending_review",
  "approved",
  "waiting_return",
  "returned",
  "received",
  "inspecting",
  "refund_pending",
  "refunded",
  "exchanged",
  "resent",
  "abnormal"
];
const REFUND_ALLOWED_STATUSES = ["approved", "refund_pending", "received", "inspecting"];
const RETURN_TYPES = ["return_refund", "exchange"];
const REFUND_TYPES = ["refund_only", "return_refund", "price_adjustment_refund"];
const NON_REFUND_RECORD_STATUSES = ["pending", "processing", "refunded", "partial_refunded"];
const SETTINGS_DEFAULTS = {
  enableAfterSale: true,
  requireManualAfterSaleReview: true,
  requireDetailedAfterSaleReason: true,
  minAfterSaleReasonLength: 5,
  maxAfterSaleReasonLength: 300,
  afterSaleDaysAfterShipment: 15,
  afterSaleDaysAfterCompleted: 7,
  allowAfterSaleBeforeShipment: true,
  allowRefundWithoutReturn: true,
  maxAfterSaleImages: 6,
  requireFinanceConfirmRefund: true,
  allowRefundToBalance: true,
  enableWechatPayRefund: false,
  requireInspectionBeforeRestock: true
};
const BAD_REASON_TEXTS = new Set(["refund", "return", "no reason", "111", "xxx"]);
const NEED_IMAGE_REASONS = ["damaged", "defective", "quality_issue", "wrong_item", "missing_item"];
const ROLE_PERMISSION_FALLBACKS = {
  customer_service: [
    "after_sale:view",
    "after_sale:review",
    "after_sale:receive_return",
    "after_sale:inspect",
    "after_sale:update",
    "after_sale:complete",
    "refund:view"
  ],
  finance: [
    "after_sale:view",
    "refund:view",
    "refund:create",
    "refund:process",
    "refund:export",
    "refund:view_sensitive",
    "refund:wechat_pay"
  ]
};

function ok(data) {
  return { ok: true, data };
}

function fail(message, code = "") {
  return { ok: false, code, message };
}

function getOpenid(event = {}) {
  const wxContext = cloud.getWXContext();
  return wxContext.OPENID || event._callerOpenid || "";
}

function requireUserOpenid(event = {}) {
  const openid = getOpenid(event);
  if (!openid) {
    const err = new Error("登录状态已失效，请重新进入小程序后再试");
    err.code = "LOGIN_REQUIRED";
    throw err;
  }
  return openid;
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

async function ensureCollections() {
  await Promise.all([
    ensureCollection("after_sales"),
    ensureCollection("after_sale_logs"),
    ensureCollection("refund_records"),
    ensureCollection("refund_logs"),
    ensureCollection("admin_operation_logs"),
    ensureCollection("account_logs"),
    ensureCollection("inventory_logs")
  ]);
}

function cleanText(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function cents(value) {
  if (value === undefined || value === null || value === "") return 0;
  const raw = typeof value === "string" ? value.trim() : value;
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new Error("金额格式错误");
  return Math.max(0, Math.round(num));
}

function money(centsValue) {
  return (Number(centsValue || 0) / 100).toFixed(2);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value.$date) return new Date(value.$date);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
  const date = toDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function nowNo(prefix) {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
  return `${prefix}${stamp}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
}

function maskPhone(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 7) return text.replace(/.(?=.{2})/g, "*");
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

function maskAccount(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 6) return text.replace(/.(?=.{2})/g, "*");
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/[,，、。;；:：/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getSystemSettings() {
  const res = await db.collection("settings").doc("system_settings").get().catch(() => null);
  const system = res && res.data ? res.data : {};
  return {
    ...SETTINGS_DEFAULTS,
    ...system,
    minAfterSaleReasonLength: SETTINGS_DEFAULTS.minAfterSaleReasonLength,
    maxAfterSaleReasonLength: Math.max(20, Number(system.maxAfterSaleReasonLength || SETTINGS_DEFAULTS.maxAfterSaleReasonLength)),
    maxAfterSaleImages: Math.max(0, Math.min(9, Number(system.maxAfterSaleImages || SETTINGS_DEFAULTS.maxAfterSaleImages)))
  };
}

function hasPermission(admin, permission) {
  if (!admin || admin.isActive === false || admin.status === "disabled") return false;
  if (admin.role === "super_admin") return true;
  return Array.isArray(admin.permissions) && (admin.permissions.includes("*") || admin.permissions.includes(permission));
}

function hasAnyPermission(admin, permissions) {
  return permissions.some((permission) => hasPermission(admin, permission));
}

function permissionsForAdmin(row = {}) {
  const role = row.role || "";
  if (role === "super_admin") return ["*"];
  const assignedPermissions = Array.isArray(row.permissions) && row.permissions.length ? row.permissions : [];
  const fallbackPermissions = ROLE_PERMISSION_FALLBACKS[role] || [];
  if (role === "customer_service") {
    return Array.from(new Set(assignedPermissions.concat(fallbackPermissions)));
  }
  return assignedPermissions.length ? assignedPermissions : fallbackPermissions;
}

async function getAdmin(event = {}) {
  const openid = getOpenid(event);
  if (!openid) return null;
  try {
    const res = await db.collection("admin_users").where({
      openid,
      isActive: _.neq(false),
      status: _.neq("disabled")
    }).limit(1).get();
    const row = res.data && res.data[0];
    if (!row) return null;
    const role = row.role || "";
    if (!role || (role !== "super_admin" && !ROLE_PERMISSION_FALLBACKS[role])) return null;
    return {
      ...row,
      _id: row._id || row.id || "",
      id: row._id || row.id || "",
      openid,
      role,
      permissions: permissionsForAdmin(row)
    };
  } catch (err) {
    if (isMissingCollectionError(err)) return null;
    throw err;
  }
}

async function requireAnyPermission(permissions, event = {}) {
  const admin = await getAdmin(event);
  if (!admin) throw new Error("无管理员权限");
  if (!hasAnyPermission(admin, permissions)) throw new Error("无权限执行该操作");
  return admin;
}

async function requireReviewAdmin(event = {}) {
  const admin = await requireAnyPermission(["after_sale:review"], event);
  // 财务角色完全禁止审核售后，无论是否被授予权限
  if (admin.role === "finance") {
    throw new Error("财务角色不能审核售后，仅能处理已审核通过的退款");
  }
  // 采购角色也不能审核涉及客户退款的售后
  if (admin.role === "procurement") {
    throw new Error("采购角色不能审核售后");
  }
  return admin;
}

async function requireRefundAdmin(permission = "refund:process", event = {}) {
  // 退款处理必须具备明确的退款权限（refund:process 或 refund:wechat_pay）
  const requiredPermission = permission || "refund:process";
  const admin = await requireAnyPermission([requiredPermission], event);

  // 采购角色一律不能处理退款，即使数据库被塞入退款权限也无效
  if (admin.role === "procurement") {
    throw new Error("采购角色不能处理退款");
  }

  // 客服默认不能最终确认退款，除非额外授予 refund:process
  if (admin.role === "customer_service" && !hasPermission(admin, "refund:process")) {
    throw new Error("客服默认不能最终确认退款");
  }

  // 退款处理仅限财务或被明确授权的角色（super_admin 通过 hasPermission 返回 true）
  if (!hasPermission(admin, "refund:process") && !hasPermission(admin, requiredPermission)) {
    throw new Error("无权限处理退款");
  }

  return admin;
}

function afterSaleLogSnapshot(row = {}) {
  return {
    afterSaleNo: row.afterSaleNo || "",
    orderId: row.orderId || "",
    orderNo: row.orderNo || "",
    afterSaleType: row.afterSaleType || "",
    afterSaleReason: row.afterSaleReason || "",
    afterSaleStatus: row.afterSaleStatus || "",
    refundStatus: row.refundStatus || "",
    requestedRefundAmount: Number(row.requestedRefundAmount || 0),
    approvedRefundAmount: Number(row.approvedRefundAmount || 0),
    actualRefundAmount: Number(row.actualRefundAmount || 0),
    returnRequired: row.returnRequired === true,
    returnItemCount: Array.isArray(row.returnItems) ? row.returnItems.length : 0,
    reviewedByRole: row.reviewedByRole || "",
    reviewedAt: row.reviewedAt || null,
    refundedAt: row.refundedAt || null,
    completedAt: row.completedAt || null
  };
}

function refundLogSnapshot(row = {}) {
  return {
    refundNo: row.refundNo || "",
    afterSaleId: row.afterSaleId || "",
    afterSaleNo: row.afterSaleNo || "",
    orderId: row.orderId || "",
    orderNo: row.orderNo || "",
    refundMethod: row.refundMethod || "",
    refundAmount: Number(row.refundAmount || 0),
    refundStatus: row.refundStatus || "",
    refundChannel: row.refundChannel || "",
    processedAt: row.processedAt || null,
    confirmedAt: row.confirmedAt || null
  };
}

async function writeAfterSaleLog(store, {
  afterSale,
  action,
  beforeData,
  afterData,
  operatorType = "admin",
  operator,
  remark,
  businessKey,
  resultData = {}
}) {
  const resultEvidence = resultData.afterSaleId ? {
    afterSaleId: resultData.afterSaleId,
    action: resultData.action,
    businessKey: resultData.businessKey,
    operatorId: resultData.operatorId,
    afterSaleStatus: resultData.afterSaleStatus,
    version: resultData.version,
    updatedAt: resultData.updatedAt,
    restoredQuantity: resultData.restoredQuantity
  } : null;
  await store.collection("after_sale_logs").add({
    data: {
      afterSaleId: afterSale._id || afterSale.afterSaleId || "",
      afterSaleNo: afterSale.afterSaleNo || "",
      orderId: afterSale.orderId || "",
      orderNo: afterSale.orderNo || "",
      action,
      beforeData: beforeData ? afterSaleLogSnapshot(beforeData) : null,
      afterData: afterData ? afterSaleLogSnapshot(afterData) : null,
      operatorType,
      operatorId: operator && (operator._id || operator.id) || "",
      operatorOpenid: operator && operator.openid || (operatorType === "user" ? getOpenid() : ""),
      operatorRole: operator && operator.role || "",
      businessKey: cleanText(businessKey, 180),
      remark: cleanText(remark, 300),
      ...(resultEvidence ? { resultData: resultEvidence } : {}),
      createdAt: db.serverDate()
    }
  });
}

async function writeRefundLog(store, { refundRecord, action, beforeData, afterData, operator, remark }) {
  await store.collection("refund_logs").add({
    data: {
      refundRecordId: refundRecord._id || refundRecord.refundRecordId || "",
      refundNo: refundRecord.refundNo || "",
      afterSaleId: refundRecord.afterSaleId || "",
      orderId: refundRecord.orderId || "",
      action,
      beforeData: beforeData ? refundLogSnapshot(beforeData) : null,
      afterData: afterData ? refundLogSnapshot(afterData) : null,
      operatorId: operator && (operator._id || operator.id) || "",
      operatorOpenid: operator && operator.openid || "",
      operatorRole: operator && operator.role || "",
      remark: cleanText(remark, 300),
      createdAt: db.serverDate()
    }
  });
}

async function writeAdminOperation(store, { admin, action, resourceType, resourceId, beforeData, afterData, description, businessKey }) {
  await store.collection("admin_operation_logs").add({
    data: {
      operatorId: admin && (admin._id || admin.id) || "",
      operatorOpenid: admin && admin.openid || "",
      operatorRole: admin && admin.role || "",
      action,
      resourceType,
      resourceId: resourceId || "",
      businessKey: cleanText(businessKey, 180),
      beforeData: beforeData || null,
      afterData: afterData || null,
      description: cleanText(description, 300),
      createdAt: db.serverDate()
    }
  });
}

function validateReasonDetail(detail, reason, settings) {
  const text = cleanText(detail, settings.maxAfterSaleReasonLength);
  if (!text) {
    const err = new Error("请填写详细的售后原因，方便客服审核");
    err.code = "REASON_DETAIL_REQUIRED";
    throw err;
  }
  if (String(detail || "").trim().length > settings.maxAfterSaleReasonLength) {
    const err = new Error(`售后原因最多 ${settings.maxAfterSaleReasonLength} 个字`);
    err.code = "REASON_DETAIL_TOO_LONG";
    throw err;
  }
  const compact = text.replace(/\s+/g, "");
  if (compact.length < settings.minAfterSaleReasonLength) {
    const err = new Error(`详细原因至少填写 ${settings.minAfterSaleReasonLength} 个字`);
    err.code = "REASON_DETAIL_TOO_SHORT";
    throw err;
  }
  if (BAD_REASON_TEXTS.has(compact.toLowerCase()) || !/[A-Za-z\u4e00-\u9fa5]/.test(compact) || /^[xX]+$/.test(compact)) {
    const err = new Error(`请补充具体原因，至少 ${settings.minAfterSaleReasonLength} 个字`);
    err.code = "REASON_DETAIL_LOW_QUALITY";
    throw err;
  }
  return text;
}

function orderPaidAmount(order) {
  if (order.paidAmount !== undefined && order.paidAmount !== null) return cents(order.paidAmount);
  if (order.paymentStatus === "paid" || order.status === "paid") return cents(order.totalAmount);
  return 0;
}

function orderTotalRefundAmount(order) {
  return cents(order.totalRefundAmount || 0);
}

function orderRefundableAmount(order) {
  return Math.max(orderPaidAmount(order) - orderTotalRefundAmount(order), 0);
}

function orderAllowsAfterSale(order, settings) {
  if (!order) return false;
  if (["pending_review", "pending_admin", "auto_reviewing", "rejected", "cancelled"].includes(order.status)) return false;
  if (order.paymentStatus === "unpaid" && orderPaidAmount(order) <= 0) return false;
  const paidOrDelivering = order.paymentStatus === "paid"
    || order.status === "paid"
    || order.paymentStatus === "partial_paid"
    || ["waiting_shipping", "pending_shipment", "shipped", "completed", "waiting_pickup", "picked_up"].includes(order.deliveryStatus || order.shippingStatus || "");
  if (!paidOrDelivering && !(settings.allowAfterSaleBeforeShipment && order.status === "approved_pending_payment")) return false;
  const completedAt = toDate(order.completedAt);
  const shippedAt = toDate(order.shippedAt || order.paymentConfirmedAt || order.paidMarkedAt);
  const now = Date.now();
  if (completedAt && settings.afterSaleDaysAfterCompleted >= 0) {
    return now - completedAt.getTime() <= Number(settings.afterSaleDaysAfterCompleted) * 86400000;
  }
  if (shippedAt && ["shipped", "completed"].includes(order.deliveryStatus || order.shippingStatus || "")) {
    return now - shippedAt.getTime() <= Number(settings.afterSaleDaysAfterShipment) * 86400000;
  }
  return true;
}

async function loadOrderItems(store, orderId, order) {
  let items = [];
  try {
    const res = await store.collection("order_items").where({ orderId }).limit(100).get();
    items = res.data || [];
  } catch (err) {
    if (!isMissingCollectionError(err)) throw err;
  }
  if (!items.length && (order.productId || order.productName)) {
    items = [{
      _id: "",
      orderId,
      productId: order.productId || "",
      productName: order.productName || "",
      brand: order.brand || "",
      category: order.category || "",
      specification: order.specification || "",
      productionDate: order.productionDate || "",
      quantity: Number(order.quantity || 0),
      unitPrice: Number(order.unitPrice || 0),
      totalAmount: Number(order.totalAmount || 0)
    }];
  }
  return items;
}

function availableItemQuantity(item) {
  const used = Number(item.afterSaleQuantity || 0)
    + Number(item.refundedQuantity || 0)
    + Number(item.returnedQuantity || 0)
    + Number(item.exchangedQuantity || 0)
    + Number(item.resentQuantity || 0);
  return Math.max(Number(item.quantity || item.orderedQuantity || 0) - used, 0);
}

function normalizeRequestedItems(inputItems, orderItems, refundCap) {
  const source = Array.isArray(inputItems) ? inputItems : [];
  const itemMap = {};
  orderItems.forEach((item) => {
    if (item._id) itemMap[item._id] = item;
    if (item.productId) itemMap[item.productId] = item;
  });
  const output = [];
  let itemRefundTotal = 0;
  source.forEach((row) => {
    const key = row.orderItemId || row.itemId || row.productId;
    const item = itemMap[key];
    if (!item) throw new Error("售后商品不存在");
    const maxQuantity = availableItemQuantity(item);
    const quantity = Math.round(Number(row.returnQuantity || row.quantity || row.applyQuantity || 0));
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("请选择售后商品数量");
    if (quantity > maxQuantity) throw new Error("申请商品数量超过可申请数量");
    const unitPrice = cents(item.unitPrice || 0);
    const defaultAmount = Math.min(unitPrice * quantity, refundCap);
    const refundableAmount = row.refundableAmount === undefined || row.refundableAmount === ""
      ? defaultAmount
      : cents(row.refundableAmount);
    if (refundableAmount > unitPrice * quantity) throw new Error("商品退款金额超过可退金额");
    itemRefundTotal += refundableAmount;
    output.push({
      orderItemId: item._id || "",
      productId: item.productId || "",
      productName: item.productName || "",
      brand: item.brand || "",
      category: item.category || "",
      specification: item.specification || "",
      productionDate: item.productionDate || "",
      unitPrice,
      orderedQuantity: Number(item.quantity || item.orderedQuantity || 0),
      availableQuantity: maxQuantity,
      returnQuantity: quantity,
      refundableAmount,
      itemReason: cleanText(row.itemReason, 200),
      itemCondition: "",
      canRestock: false,
      restockQuantity: 0,
      imageUrl: cleanText(row.imageUrl, 500)
    });
  });
  return { returnItems: output, itemRefundTotal };
}

async function getOrderById(store, orderId) {
  if (!orderId) throw new Error("缺少订单 ID");
  const order = (await store.collection("orders").doc(orderId).get()).data;
  if (!order) throw new Error("订单不存在");
  return order;
}

async function getAfterSaleById(store, afterSaleId) {
  if (!afterSaleId) throw new Error("缺少售后单 ID");
  const afterSale = (await store.collection("after_sales").doc(afterSaleId).get()).data;
  if (!afterSale) throw new Error("售后单不存在");
  return afterSale;
}

async function getRefundRecordById(store, refundRecordId) {
  if (!refundRecordId) throw new Error("缺少退款记录 ID");
  const record = (await store.collection("refund_records").doc(refundRecordId).get()).data;
  if (!record) throw new Error("退款记录不存在");
  return record;
}

async function existingActiveAfterSales(store, orderId) {
  const res = await store.collection("after_sales")
    .where({ orderId, afterSaleStatus: _.in(ACTIVE_AFTER_SALE_STATUSES) })
    .limit(20)
    .get();
  return res.data || [];
}

function publicAfterSale(row) {
  const clean = { ...row };
  delete clean.openid;
  delete clean.reviewedBy;
  delete clean.refundedBy;
  delete clean.createdBy;
  delete clean.refundAccountInfo;
  delete clean.adminInternalRemark;
  delete clean.customerPhoneSnapshot;
  return clean;
}

function adminAfterSale(row) {
  return {
    ...row,
    customerPhoneMasked: row.customerPhoneMasked || maskPhone(row.customerPhoneSnapshot || "")
  };
}

function refundSensitivePatch(event = {}) {
  const account = event.offlineRefundAccount || event.refundAccountInfo || {};
  return {
    accountName: cleanText(account.accountName, 80),
    bankName: cleanText(account.bankName, 80),
    bankCardNoMasked: maskAccount(account.bankCardNo || account.bankCardNoMasked),
    alipayAccountMasked: maskAccount(account.alipayAccount || account.alipayAccountMasked),
    wechatAccountMasked: maskAccount(account.wechatAccount || account.wechatAccountMasked)
  };
}

function refundMethodFromEvent(event = {}, fallback = "") {
  return cleanText(event.refundMethod || fallback || "offline", 40);
}

function afterSaleTypeText(type) {
  const map = {
    refund_only: "仅退款",
    return_refund: "退货退款",
    exchange: "换货",
    resend: "补发",
    price_adjustment_refund: "差价退款"
  };
  return map[type] || type;
}

function afterSaleStatusText(status) {
  const map = {
    pending_review: "待人工审核",
    approved: "审核通过",
    rejected: "审核拒绝",
    waiting_return: "待客户退货",
    returned: "客户已退回",
    received: "商家已收货",
    inspecting: "验货中",
    refund_pending: "待退款",
    refunded: "已退款",
    exchanged: "已换货",
    resent: "已补发",
    completed: "已完成",
    cancelled: "已取消",
    abnormal: "异常"
  };
  return map[status] || status;
}

function refundStatusText(status) {
  const map = {
    none: "无退款",
    pending: "待退款",
    processing: "处理中",
    refunded: "已退款",
    partial_refunded: "部分退款",
    failed: "退款失败",
    rejected: "退款拒绝",
    cancelled: "退款取消"
  };
  return map[status] || status;
}

async function createAfterSaleRequest(event = {}) {
  await ensureCollections();
  const settings = await getSystemSettings();
  if (settings.enableAfterSale === false) throw new Error("售后功能暂未启用");
  const openid = requireUserOpenid(event);
  const afterSaleType = cleanText(event.afterSaleType, 40);
  const afterSaleReason = cleanText(event.afterSaleReason, 40);
  if (!AFTER_SALE_TYPES.includes(afterSaleType)) throw new Error("售后类型不支持");
  if (!AFTER_SALE_REASONS.includes(afterSaleReason)) throw new Error("售后原因不支持");
  const customerReasonDetail = validateReasonDetail(event.customerReasonDetail, afterSaleReason, settings);
  const evidenceImages = Array.isArray(event.evidenceImages)
    ? event.evidenceImages.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, settings.maxAfterSaleImages + 1)
    : [];
  if (evidenceImages.length > settings.maxAfterSaleImages) throw new Error(`图片凭证最多上传 ${settings.maxAfterSaleImages} 张`);

  return runIdempotentAction({
    db,
    actionType: "create_after_sale",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: openid,
    operatorType: "user",
    scope: "after_sale",
    scopeId: event.orderId,
    openid,
    payload: {
      orderId: event.orderId,
      afterSaleType,
      afterSaleReason,
      customerReasonDetail,
      requestedRefundAmount: event.requestedRefundAmount,
      returnItems: event.returnItems || event.items || [],
      evidenceImages
    }
  }, async () => db.runTransaction(async (tx) => {
    const order = await getOrderById(tx, event.orderId);
    if (order.userOpenid !== openid && order.openid !== openid) throw new Error("订单不属于当前用户");
    if (!orderAllowsAfterSale(order, settings)) throw new Error("当前订单状态不允许申请售后");
    const active = await existingActiveAfterSales(tx, order._id);
    if (active.length) throw new Error("该订单已有售后处理中，请勿重复提交");
    const paidAmount = orderPaidAmount(order);
    const maxRefundableAmount = orderRefundableAmount(order);
    const requestedRefundAmount = cents(event.requestedRefundAmount);
    if (REFUND_TYPES.includes(afterSaleType) && paidAmount <= 0 && requestedRefundAmount > 0) {
      throw new Error("未付款订单不能申请现金退款");
    }
    if (requestedRefundAmount > maxRefundableAmount) throw new Error("申请退款金额超过可退金额");
    const orderItems = await loadOrderItems(tx, order._id, order);
    const normalized = normalizeRequestedItems(event.returnItems || event.items, orderItems, maxRefundableAmount);
    if (!normalized.returnItems.length) throw new Error("请选择售后商品");
    if (normalized.itemRefundTotal > maxRefundableAmount) throw new Error("商品退款金额超过可退金额");
    const finalRequestedRefundAmount = requestedRefundAmount || normalized.itemRefundTotal;
    if (finalRequestedRefundAmount > maxRefundableAmount) throw new Error("申请退款金额超过可退金额");

    const afterSaleNo = nowNo("AS");
    const now = db.serverDate();
    const doc = {
      afterSaleNo,
      orderId: order._id,
      orderNo: order.orderNo || "",
      userId: order.userId || "",
      openid,
      customerName: event.customerName || order.customerName || order.nickname || "",
      customerPhoneMasked: order.customerPhoneMasked || maskPhone(order.customerPhoneSnapshot || ""),
      afterSaleType,
      afterSaleReason,
      customerReasonDetail,
      customerRemark: cleanText(event.customerRemark, 300),
      afterSaleStatus: "pending_review",
      refundStatus: "none",
      orderAmount: cents(order.totalAmount),
      paidAmount,
      maxRefundableAmount,
      requestedRefundAmount: finalRequestedRefundAmount,
      approvedRefundAmount: 0,
      actualRefundAmount: 0,
      returnRequired: RETURN_TYPES.includes(afterSaleType),
      returnItems: normalized.returnItems,
      exchangeItems: Array.isArray(event.exchangeItems) ? event.exchangeItems : [],
      resendItems: Array.isArray(event.resendItems) ? event.resendItems : [],
      evidenceImages,
      evidenceSuggestion: NEED_IMAGE_REASONS.includes(afterSaleReason) && !evidenceImages.length ? "建议补充图片凭证" : "",
      adminReviewRemark: "",
      rejectReason: "",
      returnLogistics: {
        shippingCompany: "",
        trackingNo: "",
        shippedAt: null,
        receivedAt: null
      },
      inspectionResult: {
        received: false,
        itemCondition: "unknown",
        canRestock: false,
        restockQuantity: 0,
        inspectionRemark: "",
        inspectedBy: "",
        inspectedAt: null
      },
      refundMethod: cleanText(event.refundMethod, 40),
      refundAccountInfo: refundSensitivePatch(event),
      refundRecordIds: [],
      relatedShipmentGroupId: order.mergeShipmentId || "",
      relatedShipmentNo: order.mergeShipmentNo || "",
      createdByType: "user",
      createdBy: openid,
      reviewedBy: "",
      reviewedByRole: "",
      reviewedAt: null,
      refundedBy: "",
      refundedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now
    };
    const created = await tx.collection("after_sales").add({ data: doc });
    const afterSaleId = created._id;
    const afterSale = { ...doc, _id: afterSaleId };
    const nextAfterSaleIds = Array.from(new Set([...(Array.isArray(order.afterSaleIds) ? order.afterSaleIds : []), afterSaleId]));
    await tx.collection("orders").doc(order._id).update({
      data: {
        hasAfterSale: true,
        afterSaleIds: nextAfterSaleIds,
        afterSaleStatus: "pending_review",
        refundStatus: order.refundStatus || "none",
        refundableAmount: maxRefundableAmount,
        netPaidAmount: Math.max(paidAmount - orderTotalRefundAmount(order), 0),
        lastAfterSaleAt: now,
        updatedAt: now
      }
    });
    await writeAfterSaleLog(tx, {
      afterSale,
      action: "user_submit",
      beforeData: null,
      afterData: afterSale,
      operatorType: "user",
      operator: { openid },
      remark: "客户提交售后申请，等待人工审核"
    });
    return { afterSaleId, afterSaleNo, afterSaleStatus: "pending_review", refundStatus: "none" };
  })).then((res) => {
    if (!res.ok) {
      const err = new Error(res.message || "提交售后申请失败");
      err.code = res.code;
      throw err;
    }
    return res.data;
  });
}

async function getMyAfterSales(event = {}) {
  await ensureCollections();
  const openid = requireUserOpenid(event);
  const limit = Math.max(1, Math.min(100, Number(event.pageSize || event.limit || 50)));
  const res = await db.collection("after_sales")
    .where({ openid })
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return {
    afterSales: (res.data || []).map(publicAfterSale),
    total: (res.data || []).length
  };
}

async function getMyAfterSaleDetail(event = {}) {
  await ensureCollections();
  const openid = requireUserOpenid(event);
  const afterSale = await getAfterSaleById(db, event.afterSaleId);
  if (afterSale.openid !== openid) throw new Error("售后单不存在");
  const logs = await db.collection("after_sale_logs")
    .where({ afterSaleId: afterSale._id })
    .orderBy("createdAt", "asc")
    .limit(100)
    .get()
    .then((res) => res.data || [])
    .catch(() => []);
  return { afterSale: publicAfterSale(afterSale), logs: logs.map((log) => ({ action: log.action, remark: log.remark, createdAt: log.createdAt })) };
}

async function submitReturnLogistics(event = {}) {
  await ensureCollections();
  const openid = requireUserOpenid(event);
  const shippingCompany = cleanText(event.shippingCompany, 80);
  const trackingNo = cleanText(event.trackingNo, 80);
  if (!shippingCompany || !trackingNo) throw new Error("请填写快递公司和快递单号");
  return db.runTransaction(async (tx) => {
    const afterSale = await getAfterSaleById(tx, event.afterSaleId);
    if (afterSale.openid !== openid) throw new Error("售后单不存在");
    if (afterSale.afterSaleStatus !== "waiting_return") throw new Error("当前售后状态不能填写退货物流");
    const next = {
      ...afterSale,
      afterSaleStatus: "returned",
      returnLogistics: {
        ...(afterSale.returnLogistics || {}),
        shippingCompany,
        trackingNo,
        shippedAt: db.serverDate()
      },
      updatedAt: db.serverDate()
    };
    await tx.collection("after_sales").doc(afterSale._id).update({
      data: {
        afterSaleStatus: "returned",
        returnLogistics: next.returnLogistics,
        updatedAt: db.serverDate()
      }
    });
    await tx.collection("orders").doc(afterSale.orderId).update({
      data: { afterSaleStatus: "returned", updatedAt: db.serverDate() }
    });
    await writeAfterSaleLog(tx, {
      afterSale,
      action: "submit_return_logistics",
      beforeData: afterSale,
      afterData: next,
      operatorType: "user",
      operator: { openid },
      remark: "客户填写退货物流"
    });
    return { afterSaleId: afterSale._id, afterSaleStatus: "returned" };
  });
}

async function getAdminAfterSales(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["after_sale:view"], event);
  const status = cleanText(event.status || event.afterSaleStatus || "all", 40);
  const limit = Math.max(1, Math.min(200, Number(event.pageSize || event.limit || 100)));
  const where = {};
  if (status && status !== "all") where.afterSaleStatus = status;
  const res = await db.collection("after_sales").where(where).orderBy("createdAt", "desc").limit(limit).get();
  const keyword = normalizeSearchText(event.keyword || event.searchKeyword);
  let rows = (res.data || []).map(adminAfterSale);
  if (keyword) {
    rows = rows.filter((row) => normalizeSearchText([
      row.afterSaleNo,
      row.orderNo,
      row.customerName,
      row.customerPhoneMasked,
      row.afterSaleReason,
      row.customerReasonDetail
    ].filter(Boolean).join(" ")).includes(keyword));
  }
  return { afterSales: rows.map((row) => sanitizeAfterSaleForRole(row, admin)), total: rows.length, adminRole: admin.role };
}

async function getAdminAfterSaleDetail(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["after_sale:view"], event);
  const afterSale = await getAfterSaleById(db, event.afterSaleId);
  const refundRecords = await db.collection("refund_records")
    .where({ afterSaleId: afterSale._id })
    .orderBy("createdAt", "desc")
    .limit(100)
    .get()
    .then((res) => res.data || [])
    .catch(() => []);
  const logs = await db.collection("after_sale_logs")
    .where({ afterSaleId: afterSale._id })
    .orderBy("createdAt", "asc")
    .limit(100)
    .get()
    .then((res) => res.data || [])
    .catch(() => []);
  const refundLogs = await db.collection("refund_logs")
    .where({ afterSaleId: afterSale._id })
    .orderBy("createdAt", "asc")
    .limit(100)
    .get()
    .then((res) => res.data || [])
    .catch(() => []);
  return {
    afterSale: sanitizeAfterSaleForRole(adminAfterSale(afterSale), admin),
    refundRecords: refundRecords.map((row) => sanitizeRefundForRole(row, admin)),
    logs: sanitizeLogsForRole(logs, admin),
    refundLogs: sanitizeLogsForRole(refundLogs, admin)
  };
}

async function reviewAfterSale(event = {}) {
  await ensureCollections();
  const admin = await requireReviewAdmin(event);
  const action = cleanText(event.reviewAction || event.action, 20);
  if (!["approve", "reject"].includes(action)) throw new Error("审核操作无效");
  return runIdempotentAction({
    db,
    actionType: "review_after_sale",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "after_sale",
    scopeId: event.afterSaleId,
    openid: admin.openid,
    adminId: admin._id || admin.id || "",
    payload: {
      afterSaleId: event.afterSaleId,
      action,
      approvedRefundAmount: event.approvedRefundAmount,
      returnRequired: event.returnRequired,
      rejectReason: event.rejectReason || "",
      adminReviewRemark: event.adminReviewRemark || ""
    }
  }, async () => db.runTransaction(async (tx) => {
    const afterSale = await getAfterSaleById(tx, event.afterSaleId);
    if (afterSale.afterSaleStatus !== "pending_review") {
      if (action === "approve" && ["approved", "waiting_return", "refund_pending"].includes(afterSale.afterSaleStatus)) {
        return {
          afterSaleId: afterSale._id,
          afterSaleStatus: afterSale.afterSaleStatus,
          refundStatus: afterSale.refundStatus || "none",
          approvedRefundAmount: Number(afterSale.approvedRefundAmount || 0),
          reused: true
        };
      }
      if (action === "reject" && afterSale.afterSaleStatus === "rejected") {
        return {
          afterSaleId: afterSale._id,
          afterSaleStatus: "rejected",
          refundStatus: afterSale.refundStatus || "rejected",
          approvedRefundAmount: Number(afterSale.approvedRefundAmount || 0),
          reused: true
        };
      }
      throw new Error("售后单不是待审核状态");
    }
    let nextStatus = "";
    let refundStatus = "none";
    let approvedRefundAmount = 0;
    const data = {
      reviewedBy: admin._id || admin.id || "",
      reviewedByRole: admin.role || "",
      reviewedAt: db.serverDate(),
      updatedAt: db.serverDate()
    };
    if (action === "reject") {
      const rejectReason = cleanText(event.rejectReason, 300);
      if (!rejectReason) throw new Error("请填写拒绝原因");
      nextStatus = "rejected";
      refundStatus = "rejected";
      Object.assign(data, {
        afterSaleStatus: nextStatus,
        refundStatus,
        rejectReason,
        adminReviewRemark: cleanText(event.adminReviewRemark, 300)
      });
    } else {
      const adminReviewRemark = cleanText(event.adminReviewRemark, 300);
      approvedRefundAmount = cents(event.approvedRefundAmount === undefined ? afterSale.requestedRefundAmount : event.approvedRefundAmount);
      if (approvedRefundAmount > Number(afterSale.maxRefundableAmount || 0)) throw new Error("审批退款金额不能超过可退金额");
      const returnRequired = event.returnRequired === undefined ? afterSale.returnRequired === true : event.returnRequired === true;
      if (returnRequired) nextStatus = "waiting_return";
      else if (approvedRefundAmount > 0 && REFUND_TYPES.includes(afterSale.afterSaleType)) nextStatus = "refund_pending";
      else nextStatus = "approved";
      refundStatus = approvedRefundAmount > 0 ? "pending" : "none";
      Object.assign(data, {
        afterSaleStatus: nextStatus,
        refundStatus,
        approvedRefundAmount,
        returnRequired,
        adminReviewRemark,
        rejectReason: ""
      });
    }
    const next = { ...afterSale, ...data };
    await tx.collection("after_sales").doc(afterSale._id).update({ data });
    await tx.collection("orders").doc(afterSale.orderId).update({
      data: {
        afterSaleStatus: nextStatus,
        refundStatus,
        lastAfterSaleAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await writeAfterSaleLog(tx, {
      afterSale,
      action: action === "reject" ? "review_reject" : "review_approve",
      beforeData: afterSale,
      afterData: next,
      operatorType: "admin",
      operator: admin,
      remark: action === "reject" ? "人工审核拒绝售后" : "人工审核通过售后"
    });
    await writeAdminOperation(tx, {
      admin,
      action: action === "reject" ? "after_sale:reject" : "after_sale:review",
      resourceType: "after_sale",
      resourceId: afterSale._id,
      beforeData: afterSaleLogSnapshot(afterSale),
      afterData: afterSaleLogSnapshot(next),
      description: action === "reject" ? "拒绝售后申请" : "审核通过售后申请"
    });
    return { afterSaleId: afterSale._id, afterSaleStatus: nextStatus, refundStatus, approvedRefundAmount };
  })).then((res) => {
    if (!res.ok) {
      const err = new Error(res.message || "审核售后失败");
      err.code = res.code;
      throw err;
    }
    return res.data;
  });
}

async function reviewAfterSaleCanonical(event = {}) {
  await ensureCollections();
  const admin = await requireReviewAdmin(event);
  const service = createAfterSaleReviewService({
    db,
    idempotency: commonIdempotency,
    refundTypes: REFUND_TYPES,
    getAfterSaleById,
    writeAfterSaleLog,
    writeAdminOperation,
    afterSaleLogSnapshot
  });
  const result = await service.reviewAfterSale({
    actor: admin,
    strict: false,
    idempotencyKey: event.idempotencyKey,
    input: {
      id: event.afterSaleId,
      decision: cleanText(event.reviewAction || event.action, 20),
      approvedRefundAmount: event.approvedRefundAmount,
      returnRequired: event.returnRequired,
      reason: event.rejectReason || event.adminReviewRemark || ""
    }
  });
  return {
    afterSaleId: result.afterSaleId,
    afterSaleStatus: result.afterSaleStatus,
    refundStatus: result.refundStatus,
    approvedRefundAmount: result.approvedRefundAmount,
    duplicate: result.reused === true
  };
}

async function legacyConfirmReturnReceived(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["after_sale:receive_return"], event);
  const begin = await beginIdempotentAction({
    db,
    actionType: "confirm_return_received",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "after_sale",
    scopeId: event.afterSaleId,
    openid: admin.openid || "",
    adminId: admin._id || admin.id || "",
    payload: { afterSaleId: event.afterSaleId, expectedVersion: event.expectedVersion, expectedUpdatedAt: event.expectedUpdatedAt }
  });
  const early = idempotencyEarlyReturn(begin);
  if (early) {
    if (early.ok) return early.data;
    const err = new Error(early.message);
    err.code = early.code;
    throw err;
  }
  try {
    const result = await db.runTransaction(async (tx) => {
    const afterSale = await getAfterSaleById(tx, event.afterSaleId);
    const version = assertAfterSaleSnapshot(afterSale, event, ["waiting_return", "returned"]);
    if (!["waiting_return", "returned"].includes(afterSale.afterSaleStatus)) throw new Error("当前售后状态不能确认收货");
    const next = {
      ...afterSale,
      afterSaleStatus: "received",
      version: version + 1,
      returnLogistics: {
        ...(afterSale.returnLogistics || {}),
        receivedAt: db.serverDate()
      },
      updatedAt: db.serverDate()
    };
    await tx.collection("after_sales").doc(afterSale._id).update({
      data: {
        afterSaleStatus: "received",
        version: version + 1,
        returnLogistics: next.returnLogistics,
        updatedAt: db.serverDate()
      }
    });
    await tx.collection("orders").doc(afterSale.orderId).update({ data: { afterSaleStatus: "received", updatedAt: db.serverDate() } });
    await writeAfterSaleLog(tx, {
      afterSale,
      action: "confirm_return_received",
      beforeData: afterSale,
      afterData: next,
      operatorType: "admin",
      operator: admin,
      remark: cleanText(event.remark, 300) || "后台确认收到退货"
    });
    await writeAdminOperation(tx, {
      admin,
      action: "after_sale:receive_return",
      resourceType: "after_sale",
      resourceId: afterSale._id,
      beforeData: afterSaleLogSnapshot(afterSale),
      afterData: afterSaleLogSnapshot(next),
      description: "确认收到退货"
    });
    return { afterSaleId: afterSale._id, afterSaleStatus: "received" };
    });
    const finalResult = firstSuccessData(result);
    await finishIdempotentAction(db, begin.recordId, { data: finalResult });
    return finalResult;
  } catch (err) {
    await failIdempotentAction(db, begin.recordId, err);
    throw err;
  }
}

async function legacyInspectReturnItems(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["after_sale:inspect"], event);
  const itemCondition = cleanText(event.itemCondition || event.inspectionResult && event.inspectionResult.itemCondition || "unknown", 40);
  const canRestock = event.canRestock === true || event.inspectionResult && event.inspectionResult.canRestock === true;
  const restockQuantity = Math.max(0, Math.round(Number(event.restockQuantity || event.inspectionResult && event.inspectionResult.restockQuantity || 0)));
  if (canRestock && itemCondition !== "sellable") throw new Error("验货不可售时不能恢复普通库存");
  return runIdempotentAction({
    db,
    actionType: "after_sale_restock",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "after_sale",
    scopeId: event.afterSaleId,
    openid: admin.openid,
    adminId: admin._id || admin.id || "",
    payload: {
      afterSaleId: event.afterSaleId,
      itemCondition,
      canRestock,
      restockQuantity,
      expectedStatus: event.expectedStatus,
      expectedVersion: event.expectedVersion,
      expectedUpdatedAt: event.expectedUpdatedAt
    }
  }, async () => db.runTransaction(async (tx) => {
    const afterSale = await getAfterSaleById(tx, event.afterSaleId);
    const version = assertAfterSaleSnapshot(afterSale, event, ["received", "inspecting"]);
    if (!["received", "inspecting"].includes(afterSale.afterSaleStatus)) throw new Error("退货未收货，不能验货");
    let restored = 0;
    if (canRestock && restockQuantity > 0) {
      let remain = restockQuantity;
      for (const item of afterSale.returnItems || []) {
        if (remain <= 0) break;
        const qty = Math.min(Number(item.returnQuantity || 0), remain);
        if (!item.productId || qty <= 0) continue;
        const businessKey = `after_sale_restock:${afterSale._id}:${item.productId}`;
        const existingLog = await tx.collection("inventory_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
        if (existingLog.data && existingLog.data[0]) continue;
        const product = (await tx.collection("products").doc(item.productId).get()).data;
        const beforeStock = Number(product && product.stock || 0);
        await tx.collection("products").doc(item.productId).update({
          data: { stock: _.inc(qty), updatedAt: db.serverDate() }
        });
        await tx.collection("inventory_logs").add({
          data: {
            businessKey,
            sourceType: "after_sale",
            sourceId: afterSale._id,
            idempotencyKey: event.idempotencyKey || "",
            productId: item.productId,
            beforeStock,
            afterStock: beforeStock + qty,
            changeAmount: qty,
            reason: "after_sale_return_restock",
            relatedOrderId: afterSale.orderId,
            relatedAfterSaleId: afterSale._id,
            operatorId: admin._id || admin.id || "",
            operatorOpenid: admin.openid,
            createdAt: db.serverDate()
          }
        });
        restored += qty;
        remain -= qty;
      }
    }
    const nextStatus = Number(afterSale.approvedRefundAmount || 0) > 0 ? "refund_pending" : "approved";
    const inspectionResult = {
      received: true,
      itemCondition,
      canRestock,
      restockQuantity: restored,
      inspectionRemark: cleanText(event.inspectionRemark || event.remark, 300),
      inspectedBy: admin._id || admin.id || "",
      inspectedAt: db.serverDate()
    };
    const next = {
      ...afterSale,
      afterSaleStatus: nextStatus,
      version: version + 1,
      inspectionResult,
      updatedAt: db.serverDate()
    };
    await tx.collection("after_sales").doc(afterSale._id).update({
      data: {
        afterSaleStatus: nextStatus,
        version: version + 1,
        inspectionResult,
        updatedAt: db.serverDate()
      }
    });
    await tx.collection("orders").doc(afterSale.orderId).update({ data: { afterSaleStatus: nextStatus, updatedAt: db.serverDate() } });
    await writeAfterSaleLog(tx, {
      afterSale,
      action: "inspect_return_items",
      beforeData: afterSale,
      afterData: next,
      operatorType: "admin",
      operator: admin,
      remark: canRestock ? `验货完成，恢复库存 ${restored} 件` : "验货完成，未恢复普通库存"
    });
    await writeAdminOperation(tx, {
      admin,
      action: "after_sale:inspect",
      resourceType: "after_sale",
      resourceId: afterSale._id,
      beforeData: afterSaleLogSnapshot(afterSale),
      afterData: afterSaleLogSnapshot(next),
      description: "验货售后商品"
    });
    return { afterSaleId: afterSale._id, afterSaleStatus: nextStatus, restoredQuantity: restored };
  })).then((res) => {
    if (!res.ok) {
      const err = new Error(res.message || "验货失败");
      err.code = res.code;
      throw err;
    }
    return res.data;
  });
}

function createReturnInspectionCanonicalService() {
  return createReturnInspectionService({
    db,
    idempotency: commonIdempotency,
    getAfterSaleById,
    writeAfterSaleLog,
    writeAdminOperation,
    snapshot: afterSaleLogSnapshot,
    ownerKeyFor: process.env.SYNC_OWNER_PEPPER ? ownerKeyFor : undefined,
    syncOwnerPepper: process.env.SYNC_OWNER_PEPPER || "",
    applyInventoryMutationInTransaction,
    stockAlert
  });
}

async function confirmReturnReceived(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["after_sale:receive_return"], event);
  return createReturnInspectionCanonicalService().confirmReturnReceived({
    actor: { ...admin, sourceClient: "miniprogram" },
    strict: false,
    idempotencyKey: event.idempotencyKey || `legacy_confirm_return:${cleanText(event.afterSaleId, 128)}`,
    input: {
      action: "receive",
      afterSaleId: event.afterSaleId,
      expectedStatus: event.expectedStatus,
      expectedVersion: event.expectedVersion,
      expectedUpdatedAt: event.expectedUpdatedAt,
      remark: event.remark
    }
  });
}

async function inspectReturnItems(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["after_sale:inspect"], event);
  const itemCondition = cleanText(
    event.itemCondition || event.inspectionResult && event.inspectionResult.itemCondition || "unknown",
    40
  );
  const canRestock = event.canRestock === true || event.inspectionResult && event.inspectionResult.canRestock === true;
  const restockQuantity = Math.max(0, Math.round(Number(
    event.restockQuantity || event.inspectionResult && event.inspectionResult.restockQuantity || 0
  )));
  return createReturnInspectionCanonicalService().inspectReturnItems({
    actor: { ...admin, sourceClient: "miniprogram" },
    strict: false,
    idempotencyKey: event.idempotencyKey
      || `legacy_inspect_return:${cleanText(event.afterSaleId, 96)}:${itemCondition}:${restockQuantity}`,
    input: {
      action: "inspect",
      afterSaleId: event.afterSaleId,
      expectedStatus: event.expectedStatus,
      expectedVersion: event.expectedVersion,
      expectedUpdatedAt: event.expectedUpdatedAt,
      itemCondition,
      canRestock,
      restockQuantity,
      inspectionRemark: event.inspectionRemark || event.remark
    }
  });
}

async function sumRefundedAmount(store, afterSaleId) {
  const res = await store.collection("refund_records")
    .where({ afterSaleId, refundStatus: _.in(NON_REFUND_RECORD_STATUSES) })
    .limit(100)
    .get();
  return (res.data || []).reduce((sum, row) => sum + cents(row.refundAmount), 0);
}

function validateRefundableAfterSale(afterSale) {
  if (afterSale.refundStatus === "refunded" || afterSale.afterSaleStatus === "refunded" || afterSale.afterSaleStatus === "completed") {
    throw new Error("该售后已退款或已完成，不能重复退款");
  }
  if (!REFUND_ALLOWED_STATUSES.includes(afterSale.afterSaleStatus)) {
    const err = new Error("售后申请尚未审核通过，不能退款");
    err.code = "AFTER_SALE_NOT_APPROVED";
    throw err;
  }
  if (["pending_review", "rejected", "cancelled"].includes(afterSale.afterSaleStatus)) {
    const err = new Error("售后申请尚未审核通过，不能退款");
    err.code = "AFTER_SALE_NOT_APPROVED";
    throw err;
  }
  if (Number(afterSale.approvedRefundAmount || 0) <= 0) throw new Error("审批退款金额必须大于 0");
}

async function createRefundRecord(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["refund:create", "refund:process"], event);
  return runIdempotentAction({
    db,
    actionType: "create_refund",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "refund",
    scopeId: event.afterSaleId,
    openid: admin.openid,
    adminId: admin._id || admin.id || "",
    payload: {
      afterSaleId: event.afterSaleId,
      refundAmount: event.refundAmount,
      refundMethod: event.refundMethod,
      refundChannel: event.refundChannel || "offline"
    }
  }, async () => db.runTransaction(async (tx) => {
    const afterSale = await getAfterSaleById(tx, event.afterSaleId);
    validateRefundableAfterSale(afterSale);
    const existingAmount = await sumRefundedAmount(tx, afterSale._id);
    const refundAmount = cents(event.refundAmount === undefined ? Number(afterSale.approvedRefundAmount || 0) - existingAmount : event.refundAmount);
    if (refundAmount <= 0) throw new Error("退款金额必须大于 0");
    if (existingAmount + refundAmount > Number(afterSale.approvedRefundAmount || 0)) throw new Error("退款金额不能超过审批退款金额");
    const order = await getOrderById(tx, afterSale.orderId);
    const refundNo = nowNo("RF");
    const now = db.serverDate();
    const record = {
      refundNo,
      afterSaleId: afterSale._id,
      afterSaleNo: afterSale.afterSaleNo || "",
      orderId: afterSale.orderId,
      orderNo: afterSale.orderNo || "",
      userId: afterSale.userId || "",
      openid: afterSale.openid || "",
      customerName: afterSale.customerName || "",
      refundMethod: refundMethodFromEvent(event, afterSale.refundMethod),
      refundAmount,
      refundStatus: "pending",
      refundChannel: cleanText(event.refundChannel || "offline", 40),
      originalPaymentMethodId: order.paymentMethodId || "",
      originalPaymentMethodType: order.paymentMethodType || order.paymentMethod || "",
      originalPaymentRecordId: order.latestPaymentRecordId || "",
      wechatPayTransactionId: order.wechatPayTransactionId || "",
      wechatPayOutTradeNo: order.wechatPayOutTradeNo || "",
      wechatPayRefundId: "",
      idempotencyKey: event.idempotencyKey || "",
      requestHash: `${afterSale._id}:${refundAmount}:${refundMethodFromEvent(event, afterSale.refundMethod)}`,
      offlineRefundAccount: refundSensitivePatch(event),
      refundProofImages: [],
      financeRemark: cleanText(event.financeRemark || event.remark, 300),
      failedReason: "",
      requestedAt: now,
      processedAt: null,
      confirmedAt: null,
      createdBy: admin._id || admin.id || "",
      processedBy: "",
      confirmedBy: "",
      createdAt: now,
      updatedAt: now
    };
    const created = await tx.collection("refund_records").add({ data: record });
    const refundRecord = { ...record, _id: created._id };
    const nextRefundIds = Array.from(new Set([...(Array.isArray(afterSale.refundRecordIds) ? afterSale.refundRecordIds : []), created._id]));
    const nextAfterSale = { ...afterSale, refundRecordIds: nextRefundIds, refundStatus: "pending", afterSaleStatus: "refund_pending" };
    await tx.collection("after_sales").doc(afterSale._id).update({
      data: {
        refundRecordIds: nextRefundIds,
        refundStatus: "pending",
        afterSaleStatus: "refund_pending",
        updatedAt: now
      }
    });
    await tx.collection("orders").doc(afterSale.orderId).update({
      data: {
        refundStatus: "pending",
        afterSaleStatus: "refund_pending",
        updatedAt: now
      }
    });
    await writeRefundLog(tx, {
      refundRecord,
      action: "create_refund_record",
      beforeData: null,
      afterData: refundRecord,
      operator: admin,
      remark: "财务创建退款记录"
    });
    await writeAfterSaleLog(tx, {
      afterSale,
      action: "create_refund_record",
      beforeData: afterSale,
      afterData: nextAfterSale,
      operatorType: "admin",
      operator: admin,
      remark: "创建退款记录，等待财务确认退款"
    });
    await writeAdminOperation(tx, {
      admin,
      action: "refund:create",
      resourceType: "refund_record",
      resourceId: created._id,
      beforeData: null,
      afterData: refundLogSnapshot(refundRecord),
      description: "创建售后退款记录"
    });
    return { refundRecordId: created._id, refundNo, refundStatus: "pending", refundAmount };
  })).then((res) => {
    if (!res.ok) {
      const err = new Error(res.message || "创建退款记录失败");
      err.code = res.code;
      throw err;
    }
    return res.data;
  });
}

async function incrementOrderItemRefunds(tx, afterSale, amount) {
  const items = afterSale.returnItems || [];
  const totalItemAmount = items.reduce((sum, item) => sum + cents(item.refundableAmount), 0) || amount;
  for (const item of items) {
    if (!item.orderItemId) continue;
    const ratio = totalItemAmount > 0 ? cents(item.refundableAmount) / totalItemAmount : 0;
    const itemRefundAmount = Math.round(amount * ratio);
    const patch = {
      afterSaleQuantity: _.inc(Number(item.returnQuantity || 0)),
      refundedQuantity: _.inc(Number(item.returnQuantity || 0)),
      itemRefundAmount: _.inc(itemRefundAmount),
      itemAfterSaleStatus: "refunded",
      updatedAt: db.serverDate()
    };
    if (afterSale.returnRequired) patch.returnedQuantity = _.inc(Number(item.returnQuantity || 0));
    await tx.collection("order_items").doc(item.orderItemId).update({ data: patch });
  }
}

async function writeRefundAccountLog(tx, order, refundRecord, admin, account) {
  const amount = cents(refundRecord.refundAmount);
  const businessKey = `refund_confirm:${refundRecord._id || refundRecord.refundRecordId}`;
  const existing = await tx.collection("account_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
  if (existing.data && existing.data[0]) return false;
  await tx.collection("account_logs").add({
    data: {
      businessKey,
      sourceType: "refund",
      sourceId: refundRecord._id || refundRecord.refundRecordId || "",
      idempotencyKey: refundRecord.idempotencyKey || "",
      userId: order.userId || refundRecord.userId || "",
      userOpenid: order.userOpenid || refundRecord.openid || "",
      relatedOrderId: order._id,
      relatedPaymentRecordId: refundRecord.originalPaymentRecordId || "",
      relatedRefundRecordId: refundRecord._id || "",
      relatedAfterSaleId: refundRecord.afterSaleId || "",
      changeType: refundRecord.refundMethod === "balance_offset" ? "refund_offset" : "refund",
      beforeTotalOrderAmount: Number(account && (account.totalOrderAmount || account.totalReceivableAmount) || 0),
      afterTotalOrderAmount: Number(account && (account.totalOrderAmount || account.totalReceivableAmount) || 0),
      beforeTotalPaidAmount: Number(account && (account.totalPaidAmount || account.paidAmount) || 0),
      afterTotalPaidAmount: Math.max(Number(account && (account.totalPaidAmount || account.paidAmount) || 0) - amount, 0),
      beforeTotalUnpaidAmount: Number(account && (account.totalUnpaidAmount || account.unpaidAmount) || 0),
      afterTotalUnpaidAmount: Number(account && (account.totalUnpaidAmount || account.unpaidAmount) || 0),
      changeAmount: -amount,
      operatorId: admin._id || admin.id || "",
      operatorOpenid: admin.openid || "",
      remark: cleanText(refundRecord.financeRemark || "售后退款", 300),
      createdAt: db.serverDate()
    }
  });
  return true;
}

async function findAccount(tx, order) {
  if (order.userId) {
    const res = await tx.collection("customer_accounts").where({ userId: order.userId }).limit(1).get();
    if (res.data[0]) return res.data[0];
  }
  if (order.userOpenid) {
    const res = await tx.collection("customer_accounts").where({ userOpenid: order.userOpenid }).limit(1).get();
    if (res.data[0]) return res.data[0];
  }
  return null;
}

async function processOfflineRefund(event = {}) {
  await ensureCollections();
  const admin = await requireRefundAdmin("refund:process", event);
  let begin = await beginIdempotentAction({
    db,
    actionType: "confirm_refund",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "refund",
    scopeId: event.refundRecordId,
    openid: admin.openid,
    adminId: admin._id || admin.id || "",
    payload: {
      refundRecordId: event.refundRecordId,
      refundAmount: event.refundAmount,
      refundProofImages: event.refundProofImages || [],
      financeRemark: event.financeRemark || event.remark || ""
    }
  });
  const early = idempotencyEarlyReturn(begin);
  if (early) {
    if (early.ok) return early.data;
    const err = new Error(early.message);
    err.code = early.code;
    throw err;
  }
  try {
  const result = await db.runTransaction(async (tx) => {
    const refundRecord = await getRefundRecordById(tx, event.refundRecordId);
    if (refundRecord.refundStatus === "refunded") {
      return { idempotent: true, refundRecordId: refundRecord._id, refundStatus: "refunded", refundAmount: cents(refundRecord.refundAmount), reused: true };
    }
    if (!["pending", "processing", "failed"].includes(refundRecord.refundStatus)) throw new Error("当前退款状态不能确认退款");
    const afterSale = await getAfterSaleById(tx, refundRecord.afterSaleId);
    validateRefundableAfterSale(afterSale);
    const refundAmount = cents(event.refundAmount === undefined ? refundRecord.refundAmount : event.refundAmount);
    if (refundAmount <= 0) throw new Error("退款金额必须大于 0");
    if (refundAmount > Number(afterSale.approvedRefundAmount || 0)) throw new Error("退款金额不能超过审批退款金额");
    const order = await getOrderById(tx, afterSale.orderId);
    const beforeOrderRefund = orderTotalRefundAmount(order);
    const paidAmount = orderPaidAmount(order);
    if (beforeOrderRefund + refundAmount > paidAmount) {
      throw new Error("订单累计退款不能超过已付金额");
    }
    const actualRefundAmount = cents(afterSale.actualRefundAmount || 0) + refundAmount;
    if (actualRefundAmount > Number(afterSale.approvedRefundAmount || 0)) throw new Error("退款金额不能超过审批退款金额");
    const refundStatus = actualRefundAmount >= Number(afterSale.approvedRefundAmount || 0) ? "refunded" : "partial_refunded";
    const afterSaleStatus = refundStatus === "refunded" ? "refunded" : "refund_pending";
    const newOrderRefund = beforeOrderRefund + refundAmount;
    const nextRefundRecord = {
      ...refundRecord,
      refundAmount,
      refundStatus: "refunded",
      refundProofImages: Array.isArray(event.refundProofImages) ? event.refundProofImages.map((item) => cleanText(item, 500)).filter(Boolean) : (refundRecord.refundProofImages || []),
      financeRemark: cleanText(event.financeRemark || event.remark || refundRecord.financeRemark, 300),
      failedReason: "",
      processedAt: db.serverDate(),
      confirmedAt: db.serverDate(),
      processedBy: admin._id || admin.id || "",
      confirmedBy: admin._id || admin.id || "",
      updatedAt: db.serverDate()
    };
    const nextAfterSale = {
      ...afterSale,
      refundStatus,
      afterSaleStatus,
      actualRefundAmount,
      refundedBy: admin._id || admin.id || "",
      refundedAt: db.serverDate(),
      updatedAt: db.serverDate()
    };
    const orderRefundStatus = newOrderRefund >= paidAmount ? "refunded" : "partial_refunded";
    await tx.collection("refund_records").doc(refundRecord._id).update({
      data: {
        refundAmount,
        refundStatus: "refunded",
        idempotencyKey: event.idempotencyKey || refundRecord.idempotencyKey || "",
        refundProofImages: nextRefundRecord.refundProofImages,
        financeRemark: nextRefundRecord.financeRemark,
        failedReason: "",
        processedAt: db.serverDate(),
        confirmedAt: db.serverDate(),
        processedBy: admin._id || admin.id || "",
        confirmedBy: admin._id || admin.id || "",
        updatedAt: db.serverDate()
      }
    });
    await tx.collection("after_sales").doc(afterSale._id).update({
      data: {
        refundStatus,
        afterSaleStatus,
        actualRefundAmount,
        refundedBy: admin._id || admin.id || "",
        refundedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await tx.collection("orders").doc(order._id).update({
      data: {
        refundStatus: orderRefundStatus,
        afterSaleStatus,
        totalRefundAmount: newOrderRefund,
        refundableAmount: Math.max(paidAmount - newOrderRefund, 0),
        netPaidAmount: Math.max(paidAmount - newOrderRefund, 0),
        lastRefundAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await incrementOrderItemRefunds(tx, afterSale, refundAmount);
    const account = await findAccount(tx, order);
    await writeRefundAccountLog(tx, order, { ...refundRecord, ...nextRefundRecord }, admin, account);
    await writeRefundLog(tx, {
      refundRecord,
      action: "process_offline_refund",
      beforeData: refundRecord,
      afterData: nextRefundRecord,
      operator: admin,
      remark: "财务确认线下退款"
    });
    await writeAfterSaleLog(tx, {
      afterSale,
      action: "refund_confirmed",
      beforeData: afterSale,
      afterData: nextAfterSale,
      operatorType: "admin",
      operator: admin,
      remark: "财务确认退款完成"
    });
    await writeAdminOperation(tx, {
      admin,
      action: "refund:process",
      resourceType: "refund_record",
      resourceId: refundRecord._id,
      beforeData: refundLogSnapshot(refundRecord),
      afterData: refundLogSnapshot(nextRefundRecord),
      description: "确认线下退款"
    });
    return {
      refundRecordId: refundRecord._id,
      afterSaleId: afterSale._id,
      orderId: order._id,
      userId: order.userId,
      userOpenid: order.userOpenid,
      refundStatus,
      afterSaleStatus,
      refundAmount,
      totalRefundAmount: newOrderRefund,
      netPaidAmount: Math.max(paidAmount - newOrderRefund, 0)
    };
  });
  if (!result.idempotent) {
    await cloud.callFunction({
      name: "recalculateCustomerAccount",
      data: { userId: result.userId, userOpenid: result.userOpenid }
    }).catch(() => null);
  }
  const finalResult = firstSuccessData(result);
  await finishIdempotentAction(db, begin.recordId, { data: finalResult });
  return finalResult;
  } catch (err) {
    await failIdempotentAction(db, begin.recordId, err);
    throw err;
  }
}

async function rejectRefund(event = {}) {
  await ensureCollections();
  const admin = await requireRefundAdmin("refund:process", event);
  const failedReason = cleanText(event.failedReason || event.rejectReason, 300);
  if (!failedReason) throw new Error("请填写退款拒绝原因");
  return db.runTransaction(async (tx) => {
    const refundRecord = await getRefundRecordById(tx, event.refundRecordId);
    if (!["pending", "processing", "failed"].includes(refundRecord.refundStatus)) throw new Error("当前退款状态不能拒绝");
    const afterSale = await getAfterSaleById(tx, refundRecord.afterSaleId);
    const nextRefund = {
      ...refundRecord,
      refundStatus: "rejected",
      failedReason,
      processedBy: admin._id || admin.id || "",
      processedAt: db.serverDate(),
      updatedAt: db.serverDate()
    };
    await tx.collection("refund_records").doc(refundRecord._id).update({
      data: {
        refundStatus: "rejected",
        failedReason,
        processedBy: admin._id || admin.id || "",
        processedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await tx.collection("after_sales").doc(afterSale._id).update({
      data: { refundStatus: "pending", updatedAt: db.serverDate() }
    });
    await writeRefundLog(tx, {
      refundRecord,
      action: "reject_refund",
      beforeData: refundRecord,
      afterData: nextRefund,
      operator: admin,
      remark: "财务拒绝退款记录"
    });
    await writeAdminOperation(tx, {
      admin,
      action: "refund:reject",
      resourceType: "refund_record",
      resourceId: refundRecord._id,
      beforeData: refundLogSnapshot(refundRecord),
      afterData: refundLogSnapshot(nextRefund),
      description: "拒绝退款记录"
    });
    return { refundRecordId: refundRecord._id, refundStatus: "rejected" };
  });
}

async function createWechatPayRefund(event = {}) {
  await requireRefundAdmin("refund:wechat_pay", event);
  const settings = await getSystemSettings();
  if (settings.enableWechatPayRefund !== true) {
    return { code: "WECHAT_REFUND_NOT_CONFIGURED", message: "微信支付退款暂未配置" };
  }
  const refundRecord = await getRefundRecordById(db, event.refundRecordId);
  const afterSale = await getAfterSaleById(db, refundRecord.afterSaleId);
  validateRefundableAfterSale(afterSale);
  if (refundRecord.originalPaymentMethodType !== "wechat_pay") throw new Error("原支付方式不是微信支付");
  return { code: "WECHAT_REFUND_NOT_CONFIGURED", message: "微信支付退款商户接口尚未完成安全配置，未发起真实退款" };
}

async function handleWechatRefundNotify() {
  return { code: "WECHAT_REFUND_NOTIFY_NOT_IMPLEMENTED", message: "微信支付退款回调验签尚未接入，未更新退款状态" };
}

async function completeAfterSale(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["after_sale:complete"], event);
  const begin = await beginIdempotentAction({
    db,
    actionType: "complete_after_sale",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "after_sale",
    scopeId: event.afterSaleId,
    openid: admin.openid || "",
    adminId: admin._id || admin.id || "",
    payload: {
      afterSaleId: event.afterSaleId,
      remark: cleanText(event.remark, 300)
    }
  });
  const early = idempotencyEarlyReturn(begin);
  if (early) {
    if (early.ok) return early.data;
    const err = new Error(early.message);
    err.code = early.code;
    throw err;
  }

  try {
    const result = await db.runTransaction(async (tx) => {
      const afterSale = await getAfterSaleById(tx, event.afterSaleId);
      if (afterSale.afterSaleStatus === "completed") {
        return { afterSaleId: afterSale._id, afterSaleStatus: "completed", reused: true };
      }
      if (!canCompleteAfterSale(afterSale.afterSaleStatus)) {
        if (["rejected", "cancelled"].includes(afterSale.afterSaleStatus)) {
          throw new Error("已拒绝或已取消的售后不能标记完成");
        }
        throw new Error("当前售后流程尚未完成，不能标记完成");
      }
      const next = { ...afterSale, afterSaleStatus: "completed", completedAt: db.serverDate(), updatedAt: db.serverDate() };
      await tx.collection("after_sales").doc(afterSale._id).update({
        data: { afterSaleStatus: "completed", completedAt: db.serverDate(), updatedAt: db.serverDate() }
      });
      await tx.collection("orders").doc(afterSale.orderId).update({
        data: { afterSaleStatus: "completed", updatedAt: db.serverDate() }
      });
      await writeAfterSaleLog(tx, {
        afterSale,
        action: "complete_after_sale",
        beforeData: afterSale,
        afterData: next,
        operatorType: "admin",
        operator: admin,
        remark: cleanText(event.remark, 300) || "售后已完成"
      });
      await writeAdminOperation(tx, {
        admin,
        action: "after_sale:complete",
        resourceType: "after_sale",
        resourceId: afterSale._id,
        beforeData: afterSaleLogSnapshot(afterSale),
        afterData: afterSaleLogSnapshot(next),
        description: "标记售后完成"
      });
      return { afterSaleId: afterSale._id, afterSaleStatus: "completed" };
    });
    const finalResult = firstSuccessData(result);
    await finishIdempotentAction(db, begin.recordId, { data: finalResult });
    return finalResult;
  } catch (err) {
    await failIdempotentAction(db, begin.recordId, err);
    throw err;
  }
}
async function getAdminRefunds(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["refund:view"], event);
  const status = cleanText(event.status || event.refundStatus || "all", 40);
  const where = {};
  if (status && status !== "all") where.refundStatus = status;
  const res = await db.collection("refund_records").where(where).orderBy("createdAt", "desc").limit(200).get();
  const keyword = normalizeSearchText(event.keyword || event.searchKeyword);
  let rows = res.data || [];
  if (keyword) {
    rows = rows.filter((row) => normalizeSearchText([
      row.refundNo,
      row.afterSaleNo,
      row.orderNo,
      row.customerName,
      row.refundMethod,
      row.refundStatus
    ].filter(Boolean).join(" ")).includes(keyword));
  }
  return { refunds: rows.map((row) => sanitizeRefundForRole(row, admin)), total: rows.length };
}

async function getAdminRefundDetail(event = {}) {
  await ensureCollections();
  const admin = await requireAnyPermission(["refund:view"], event);
  const refundRecord = await getRefundRecordById(db, event.refundRecordId);
  const afterSale = await getAfterSaleById(db, refundRecord.afterSaleId);
  const logs = await db.collection("refund_logs")
    .where({ refundRecordId: refundRecord._id })
    .orderBy("createdAt", "asc")
    .limit(100)
    .get()
    .then((res) => res.data || [])
    .catch(() => []);
  return {
    refund: sanitizeRefundForRole(refundRecord, admin),
    afterSale: sanitizeAfterSaleForRole(adminAfterSale(afterSale), admin),
    logs: sanitizeLogsForRole(logs, admin)
  };
}

function sheetFromRows(rows, columns, sheetName) {
  const aoa = [columns.map((column) => column.title)];
  rows.forEach((row) => aoa.push(columns.map((column) => cleanText(column.value(row), 1000))));
  const worksheet = xlsx.utils.aoa_to_sheet(aoa);
  worksheet["!cols"] = columns.map((column) => ({ wch: column.width || 18 }));
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
  return workbook;
}

async function uploadWorkbook(workbook, type) {
  const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
  const stamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const fileName = `${type}_${stamp}.xlsx`;
  const uploaded = await cloud.uploadFile({
    cloudPath: `exports/after-sales/${fileName}`,
    fileContent: buffer
  });
  const urls = await cloud.getTempFileURL({ fileList: [uploaded.fileID] });
  const fileUrl = urls.fileList && urls.fileList[0] && urls.fileList[0].tempFileURL || "";
  return { fileID: uploaded.fileID, fileUrl, fileName };
}

async function exportAfterSalesExcel(event = {}) {
  await ensureCollections();
  const exportType = event.exportType === "refunds" ? "refunds" : "after_sales";
  const admin = await requireAnyPermission(exportType === "refunds" ? ["refund:export"] : ["after_sale:view", "refund:export"], event);
  const rows = exportType === "refunds"
    ? (await db.collection("refund_records").orderBy("createdAt", "desc").limit(1000).get()).data || []
    : (await db.collection("after_sales").orderBy("createdAt", "desc").limit(1000).get()).data || [];
  const workbook = exportType === "refunds"
    ? sheetFromRows(rows, [
      { title: "退款单号", value: (row) => row.refundNo, width: 22 },
      { title: "售后单号", value: (row) => row.afterSaleNo, width: 22 },
      { title: "订单号", value: (row) => row.orderNo, width: 22 },
      { title: "客户", value: (row) => row.customerName },
      { title: "退款方式", value: (row) => row.refundMethod },
      { title: "退款状态", value: (row) => refundStatusText(row.refundStatus) },
      { title: "退款金额", value: (row) => money(row.refundAmount) },
      { title: "创建时间", value: (row) => formatDate(row.createdAt), width: 20 },
      { title: "确认时间", value: (row) => formatDate(row.confirmedAt), width: 20 },
      { title: "财务备注", value: (row) => row.financeRemark, width: 30 }
    ], "退款记录")
    : sheetFromRows(rows, [
      { title: "售后单号", value: (row) => row.afterSaleNo, width: 22 },
      { title: "订单号", value: (row) => row.orderNo, width: 22 },
      { title: "客户", value: (row) => row.customerName },
      { title: "售后类型", value: (row) => afterSaleTypeText(row.afterSaleType) },
      { title: "售后状态", value: (row) => afterSaleStatusText(row.afterSaleStatus) },
      { title: "退款状态", value: (row) => refundStatusText(row.refundStatus) },
      { title: "申请金额", value: (row) => money(row.requestedRefundAmount) },
      { title: "审批金额", value: (row) => money(row.approvedRefundAmount) },
      { title: "实退金额", value: (row) => money(row.actualRefundAmount) },
      { title: "详细原因", value: (row) => row.customerReasonDetail, width: 40 },
      { title: "创建时间", value: (row) => formatDate(row.createdAt), width: 20 },
      { title: "审核时间", value: (row) => formatDate(row.reviewedAt), width: 20 }
    ], "售后记录");
  const file = await uploadWorkbook(workbook, exportType);
  await ensureCollection("export_records");
  await db.collection("export_records").add({
    data: {
      exportType,
      fileName: file.fileName,
      fileID: file.fileID,
      fileUrl: file.fileUrl,
      filters: event.filters || {},
      totalRows: rows.length,
      operatorId: admin._id || admin.id || "",
      operatorOpenid: admin.openid || "",
      status: "success",
      errorMessage: "",
      createdAt: db.serverDate()
    }
  });
  return { ...file, totalRows: rows.length };
}

function legacyRefundMutationResult(result) {
  const item = result && result.item || {};
  return {
    refundRecordId: item.id || "",
    refundNo: item.refundNo || "",
    refundStatus: item.status || "",
    refundAmount: Number(item.amountCents || 0),
    version: item.version,
    updatedAt: item.updatedAt,
    affected: Number(result && result.affected || 0),
    reused: result && result.reused === true,
    accountRecalculationPending: result && result.accountRecalculationPending === true
  };
}

async function createRefundRecordCanonical(event = {}) {
  const admin = await requireAnyPermission(["refund:create", "refund:process"], event);
  const result = await refundMutationService.createRefundRecord({
    actor: admin,
    input: {
      afterSaleId: event.afterSaleId,
      refundAmountCents: event.refundAmountCents,
      refundAmount: event.refundAmount,
      refundMethod: event.refundMethod,
      refundChannel: event.refundChannel || "offline",
      financeRemark: event.financeRemark || event.remark || "",
      offlineRefundAccount: refundSensitivePatch(event)
    },
    idempotencyKey: event.idempotencyKey,
    strict: false
  });
  return legacyRefundMutationResult(result);
}

async function processOfflineRefundCanonical(event = {}) {
  const admin = await requireRefundAdmin("refund:process", event);
  const remarkInput = event.financeRemark !== undefined || event.remark !== undefined
    ? { financeRemark: event.financeRemark || event.remark || "" }
    : {};
  const result = await refundMutationService.processOfflineRefund({
    actor: admin,
    input: {
      refundRecordId: event.refundRecordId || event.id,
      refundAmountCents: event.refundAmountCents,
      refundAmount: event.refundAmount,
      expectedRefundStatus: event.expectedRefundStatus,
      expectedRefundVersion: event.expectedRefundVersion,
      expectedRefundUpdatedAt: event.expectedRefundUpdatedAt,
      refundProofFileIds: event.refundProofFileIds,
      refundProofImages: event.refundProofImages,
      ...remarkInput
    },
    idempotencyKey: event.idempotencyKey,
    strict: false
  });
  return legacyRefundMutationResult(result);
}

async function rejectRefundCanonical(event = {}) {
  const admin = await requireRefundAdmin("refund:process", event);
  const rejectReason = event.rejectReason || event.failedReason || event.reason || "";
  const idempotencyKey = event.idempotencyKey || `legacy_refund_reject_${commonIdempotency.hashPayload({
    refundRecordId: event.refundRecordId || event.id || "",
    rejectReason: cleanText(rejectReason, 300)
  }).slice(0, 40)}`;
  const result = await refundMutationService.rejectRefund({
    actor: admin,
    input: {
      refundRecordId: event.refundRecordId || event.id,
      expectedRefundStatus: event.expectedRefundStatus,
      expectedRefundVersion: event.expectedRefundVersion,
      expectedRefundUpdatedAt: event.expectedRefundUpdatedAt,
      rejectReason
    },
    idempotencyKey,
    strict: false
  });
  return legacyRefundMutationResult(result);
}

const handlers = {
  createAfterSaleRequest,
  getMyAfterSales,
  getMyAfterSaleDetail,
  submitReturnLogistics,
  getAdminAfterSales,
  getAdminAfterSaleDetail,
  reviewAfterSale: reviewAfterSaleCanonical,
  confirmReturnReceived,
  inspectReturnItems,
  createRefundRecord: createRefundRecordCanonical,
  processOfflineRefund: processOfflineRefundCanonical,
  createWechatPayRefund,
  handleWechatRefundNotify,
  rejectRefund: rejectRefundCanonical,
  completeAfterSale,
  getAdminRefunds,
  getAdminRefundDetail,
  exportAfterSalesExcel
};

exports.main = async (event = {}) => {
  const action = event.action || event._action || "";
  const handler = handlers[action];
  if (!handler) return fail("未知售后操作");
  try {
    const data = await handler(event);
    if (data && data.ok === false) return data;
    if (data && data.ok === true && Object.prototype.hasOwnProperty.call(data, "data")) return ok(data.data);
    if (data && data.code) return fail(data.message, data.code);
    return ok(data);
  } catch (err) {
    const idempotencyError = idempotencyErrorResponse(err);
    if (idempotencyError) return idempotencyError;
    return fail(err.message || "售后操作失败", err.code || "");
  }
};
