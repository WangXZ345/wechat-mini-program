const RESOURCE_POLICIES = Object.freeze({
  dashboard: { permission: "dashboard:view_basic", collection: "" },
  products: { permission: "product:view", collection: "products", sortField: "updatedAt", searchFields: ["name", "productName", "brand", "sku", "productIndex", "skuCode", "searchText"] },
  inventory: { permission: "inventory:view", collection: "products", sortField: "updatedAt", searchFields: ["name", "productName", "sku", "productIndex", "skuCode", "searchText"] },
  "inventory-alerts": { permission: "inventory:view", collection: "products", sortField: "updatedAt", searchFields: ["name", "productName", "sku", "productIndex", "skuCode", "searchText"] },
  orders: { permission: "order:view", collection: "orders", sortField: "createdAt", statusField: "status", searchFields: ["orderNo", "searchText"] },
  payments: { permission: "payment:view_screenshot", collection: "payment_records", sortField: "createdAt", statusField: "paymentStatus", searchFields: ["orderNo", "orderId"] },
  accounts: { permission: "customer:view_account", collection: "customer_accounts", sortField: "updatedAt", statusField: "status", searchFields: ["nickname", "customerName"] },
  shipments: { permission: "shipment:view", collection: "shipment_groups", sortField: "updatedAt", statusField: "shippingStatus", searchFields: ["shipmentNo", "trackingNo"] },
  "after-sales": { permission: "after_sale:view", collection: "after_sales", sortField: "createdAt", statusField: "afterSaleStatus", searchFields: ["afterSaleNo", "orderNo"] },
  refunds: { permission: "refund:view", collection: "refund_records", sortField: "updatedAt", statusField: "refundStatus", searchFields: ["refundNo", "orderNo"] },
  admins: { permission: "admin:view", collection: "admin_users", sortField: "updatedAt", statusField: "status", searchFields: ["name", "username"] },
  audit: { permission: "operation_log:view", collection: "admin_operation_logs", sortField: "createdAt", statusField: "status", searchFields: ["action", "resourceType", "description"] },
  analytics: { permission: "product:analytics:view", collection: "products", sortField: "totalSales", searchFields: ["name", "productName", "brand", "productIndex", "skuCode", "sku", "productCode", "searchText"] },
  imports: { permission: "inventory:import", collection: "import_records", sortField: "createdAt", statusField: "status", searchFields: ["fileName", "importNo"] },
  settings: {
    permission: "system:settings",
    collection: "settings",
    fixedDocumentId: "system_settings",
    publicDocumentId: "system"
  }
});

const MUTATION_POLICIES = Object.freeze({
  products: Object.freeze({
    create: "product:create",
    edit: "product:update",
    "change-price": "product:update_price",
    "toggle-status": "product:update_status",
    "batch-enable": "product:update_status",
    "batch-tags": "product:tag:batch_update",
    "import-confirm": "inventory:import"
  }),
  inventory: Object.freeze({
    adjust: "inventory:update",
    "set-warning": "inventory:set_warning",
    "batch-warning": "inventory:set_warning",
    "import-confirm": "inventory:import"
  }),
  "inventory-alerts": Object.freeze({
    adjust: "inventory:update",
    "set-warning": "inventory:set_warning",
    "batch-warning": "inventory:set_warning"
  }),
  orders: Object.freeze({
    review: "order:review",
    "batch-review": "order:review",
    reject: "order:reject",
    remark: "order:edit_remark"
  }),
  payments: Object.freeze({ confirm: "payment:confirm", reject: "payment:update_status" }),
  accounts: Object.freeze({ export: "customer:export_account" }),
  shipments: Object.freeze({ merge: "shipment:merge", ship: "shipment:ship", edit: "shipment:update" }),
  "after-sales": Object.freeze({
    approve: "after_sale:review",
    reject: "after_sale:review",
    receive: "after_sale:receive_return",
    inspect: "after_sale:inspect"
  }),
  refunds: Object.freeze({ process: "refund:process", reject: "refund:process" }),
  admins: Object.freeze({ create: "admin:create", "change-role": "admin:update_role", disable: "admin:disable" }),
  settings: Object.freeze({ update: "system:settings" })
});
const CANONICAL_REFUND_STATUSES = new Set([
  "pending",
  "processing",
  "refunded",
  "partial_refunded",
  "failed",
  "rejected",
  "cancelled"
]);

class ApiError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 300) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function finiteInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const page = finiteInteger(parsed.page, 0);
    return page > 0 ? { page } : null;
  } catch (err) {
    throw new ApiError("INVALID_CURSOR", "分页游标无效", 400);
  }
}

function encodeCursor(page) {
  return Buffer.from(JSON.stringify({ page }), "utf8").toString("base64url");
}

function normalizePagination(query = {}) {
  const cursor = decodeCursor(query.cursor);
  const page = cursor ? cursor.page : Math.max(1, finiteInteger(query.page, 1));
  const pageSize = Math.max(1, Math.min(100, finiteInteger(query.pageSize || query.limit, 20)));
  return { page, pageSize, skip: Math.min((page - 1) * pageSize, 10000) };
}

function normalizeResource(value) {
  return cleanString(value, 80).toLowerCase();
}

function getResourcePolicy(resource) {
  const key = normalizeResource(resource);
  const policy = RESOURCE_POLICIES[key];
  if (!policy) throw new ApiError("RESOURCE_NOT_FOUND", "资源不存在", 404);
  return { key, ...policy };
}

function resolveResourceDocumentId(resource, id) {
  const policy = getResourcePolicy(resource);
  const publicId = cleanString(id, 128);
  if (!publicId) throw new ApiError("RESOURCE_ID_REQUIRED", "缺少资源 ID", 400);
  if (!policy.fixedDocumentId) return publicId;
  if (publicId !== policy.publicDocumentId) throw new ApiError("NOT_FOUND", "记录不存在", 404);
  return policy.fixedDocumentId;
}

function getMutationPermission(resource, action) {
  const resourceKey = normalizeResource(resource);
  const actionKey = cleanString(action, 100).toLowerCase();
  const permission = MUTATION_POLICIES[resourceKey] && MUTATION_POLICIES[resourceKey][actionKey];
  if (!permission) throw new ApiError("MUTATION_NOT_SUPPORTED", "写操作不存在", 404);
  return permission;
}

function boundedPermissions(principal, permissionModel) {
  if (!principal) return [];
  if (principal.role === "super_admin") return ["*"];
  return permissionModel.filterPermissionsForRole(principal.role, principal.permissions || []);
}

function hasPermission(principal, permission) {
  if (!principal || principal.status !== "active") return false;
  return principal.role === "super_admin"
    || (Array.isArray(principal.permissions) && (principal.permissions.includes("*") || principal.permissions.includes(permission)));
}

function assertPermission(principal, permission) {
  if (!hasPermission(principal, permission)) throw new ApiError("FORBIDDEN", "无权访问该资源", 403);
}

function decimalDigitToAscii(character) {
  const code = character.codePointAt(0);
  if (code >= 0x30 && code <= 0x39) return String(code - 0x30);
  if (code >= 0xff10 && code <= 0xff19) return String(code - 0xff10);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  return "";
}

function extractPhoneDigits(value, max = 100) {
  return Array.from(cleanString(value, max), decimalDigitToAscii).join("");
}

function maskPhone(value) {
  const digits = extractPhoneDigits(value, 40);
  if (digits.length >= 11) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return digits ? `${digits.slice(0, 2)}***${digits.slice(-1)}` : "";
}

function customerPhoneDigits(value) {
  const digits = extractPhoneDigits(value, 100);
  return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
}

function maskCustomerPhone(value) {
  const digits = customerPhoneDigits(value);
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return maskPhone(digits);
}

function maskPhoneSequences(value, max = 240) {
  const digit = "0-9\\uFF10-\\uFF19\\u0660-\\u0669\\u06F0-\\u06F9";
  const one = "1\\uFF11\\u0661\\u06F1";
  const threeToNine = "3-9\\uFF13-\\uFF19\\u0663-\\u0669\\u06F3-\\u06F9";
  const eight = "8\\uFF18\\u0668\\u06F8";
  const six = "6\\uFF16\\u0666\\u06F6";
  const separator = "[\\s.,:_|\\-()/\\\\\\u00b7\\u2010-\\u2015\\u3002\\u200B-\\u200D\\u2060\\uFEFF]*";
  const mobile = `[${one}]${separator}[${threeToNine}](?:${separator}[${digit}]){9}`;
  const country = `(?:[+\\uFF0B]${separator})?[${eight}]${separator}[${six}]${separator}`;
  const candidate = new RegExp(`(?<![${digit}])(?:${country})?${mobile}(?![${digit}])`, "gu");
  return cleanString(value, max).replace(candidate, (phone) => maskCustomerPhone(phone));
}

function maskName(value) {
  const text = cleanString(value, 80);
  if (!text) return "客户";
  if (text.length === 1) return `${text}*`;
  return `${text.slice(0, 1)}${"*".repeat(Math.min(3, text.length - 1))}`;
}

function maskTracking(value) {
  const text = cleanString(value, 100);
  if (text.length <= 6) return text ? "******" : "";
  return `${text.slice(0, 3)}******${text.slice(-3)}`;
}

function dateValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function firstValidCents(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  }
  return undefined;
}

function assignCents(target, key, ...values) {
  const value = firstValidCents(...values);
  if (value !== undefined) target[key] = value;
  return target;
}

function rowId(row) {
  return cleanString(row && (row._id || row.id), 128);
}

function customerMasked(row) {
  const supplied = cleanString(row.customerMasked, 100);
  if (supplied) {
    const digits = customerPhoneDigits(supplied);
    if (digits.length >= 7) return maskCustomerPhone(digits);
    return maskName(supplied);
  }
  const name = cleanString(row.customerName || row.nickname || row.userName, 80);
  if (name) return maskName(name);
  return maskCustomerPhone(row.phone || row.userPhone) || "客户";
}

function shippingAddressMasked(value) {
  return cleanString(value, 240) ? "地址已脱敏" : "";
}

function canViewOrderAmount(principal) {
  return hasPermission(principal, "dashboard:view_sales");
}

function canViewAfterSaleAmount(principal) {
  return hasPermission(principal, "refund:view");
}

function canViewAfterSaleRequestAmount(principal) {
  return principal && principal.role === "customer_service"
    && hasPermission(principal, "after_sale:review");
}

function productStatus(row) {
  if (row.isActive === false) return "inactive";
  if (row.status === "draft") return "draft";
  return "active";
}

function publicProductTags(row = {}) {
  const definitions = [
    ["新货", "isNew"],
    ["瑕疵", "isDefective"],
    ["热销", "isHot"]
  ];
  const stored = new Set(Array.isArray(row.tags)
    ? row.tags.map((value) => cleanString(value, 50)).filter(Boolean)
    : []);
  return definitions
    .filter(([tag, flag]) => stored.has(tag) || row[flag] === true)
    .map(([tag]) => tag);
}

function stockStatus(row) {
  const stock = Number(row.stock || 0);
  const warning = Number(row.warningStock ?? row.warningThreshold ?? 0);
  if (stock <= 0 || row.stockStatus === "out_of_stock") return "out";
  if (row.stockStatus === "warning" || (warning > 0 && stock <= warning)) return "low";
  return "normal";
}

function projectResource(resource, row, principal, detail = false) {
  const id = rowId(row);
  switch (normalizeResource(resource)) {
    case "products": {
      if (detail) {
        const keywordValues = Array.isArray(row.keywords)
          ? row.keywords.slice(0, 20).map((value) => cleanString(value, 40)).filter(Boolean)
          : cleanString(row.keywords, 800).split(/[,，、\s]+/).map((value) => cleanString(value, 40)).filter(Boolean).slice(0, 20);
        const keywords = Array.from(new Set(keywordValues)).slice(0, 20);
        return {
          id,
          version: finiteInteger(row.version ?? row.dataVersion, 0),
          metadata: {
            name: cleanString(row.name || row.productName, 160),
            baseName: cleanString(row.baseName || row.name || row.productName, 160),
            imageUrl: cleanString(row.imageUrl, 500),
            specification: cleanString(row.specification, 120),
            productionDate: cleanString(row.productionDate, 40),
            description: cleanString(row.description, 1000),
            productIndex: cleanString(row.productIndex, 80),
            skuCode: cleanString(row.skuCode, 80),
            keywords
          },
          initial: {
            salePriceCents: Math.max(0, finiteInteger(row.price, 0)),
            stock: Math.max(0, finiteInteger(row.stock, 0)),
            warningThreshold: Math.max(0, finiteInteger(row.warningStock ?? row.warningThreshold, 0)),
            isActive: row.isActive !== false,
            tags: publicProductTags(row)
          },
          updatedAt: dateValue(row.updatedAt)
        };
      }
      const projected = { id, sku: cleanString(row.productIndex || row.skuCode || row.sku || row.productCode, 80), name: cleanString(row.name || row.productName, 160), brand: cleanString(row.brand, 100), status: productStatus(row), isActive: row.isActive !== false, tags: publicProductTags(row), updatedAt: dateValue(row.updatedAt), version: finiteInteger(row.version ?? row.dataVersion, 0) };
      return assignCents(projected, "salePriceCents", row.price);
    }
    case "inventory":
    case "inventory-alerts":
      return { id, sku: cleanString(row.productIndex || row.skuCode || row.sku || row.productCode, 80), name: cleanString(row.name || row.productName, 160), stock: finiteInteger(row.stock, 0), warningThreshold: finiteInteger(row.warningStock ?? row.warningThreshold, 0), status: stockStatus(row), isActive: row.isActive !== false, lastChange: cleanString(row.lastStockChangeReason, 120), suggestion: stockStatus(row) === "out" ? "尽快补货" : stockStatus(row) === "low" ? "关注库存" : "", updatedAt: dateValue(row.updatedAt), version: finiteInteger(row.version ?? row.dataVersion, 0) };
    case "orders": {
      const projected = { id, orderNo: cleanString(row.orderNo, 100), customerMasked: customerMasked(row), itemSummary: maskPhoneSequences(row.itemSummary || row.productName || row.productSummary, 200), status: cleanString(row.status, 60), paymentStatus: cleanString(row.paymentStatus, 60), deliveryStatus: cleanString(row.deliveryStatus || row.shippingStatus, 60), createdAt: dateValue(row.createdAt), updatedAt: dateValue(row.updatedAt), version: finiteInteger(row.version ?? row.dataVersion, 0) };
      if (canViewOrderAmount(principal)) assignCents(projected, "totalAmountCents", row.totalAmount);
      if (detail) projected.shippingAddressMasked = shippingAddressMasked(row.shippingAddressMasked);
      if (detail && hasPermission(principal, "order:edit_remark")) projected.adminRemark = maskPhoneSequences(row.adminRemark || row.adminNote, 300);
      return projected;
    }
    case "payments": {
      const projected = { id, orderNo: cleanString(row.orderNo, 100), customerMasked: customerMasked(row), proofLabel: (row.paymentScreenshotUrl || (Array.isArray(row.screenshotUrls) && row.screenshotUrls.length)) ? "已提交凭证" : "无凭证", proofCount: Array.isArray(row.screenshotUrls) ? row.screenshotUrls.length : row.paymentScreenshotUrl ? 1 : 0, status: cleanString(row.paymentStatus || row.status, 60), submittedAt: dateValue(row.submittedAt || row.createdAt), updatedAt: dateValue(row.updatedAt) };
      return assignCents(projected, "amountCents", row.paidAmount, row.amount);
    }
    case "accounts": {
      const projected = { id, customerMasked: customerMasked(row), totalOrders: finiteInteger(row.orderCount, 0), status: cleanString(row.status || (row.isSettled ? "normal" : "warning"), 60), updatedAt: dateValue(row.updatedAt) };
      assignCents(projected, "receivableCents", row.totalReceivableAmount, row.totalOrderAmount);
      assignCents(projected, "receivedCents", row.paidAmount, row.totalPaidAmount);
      return assignCents(projected, "unpaidAmountCents", row.unpaidAmount, row.totalUnpaidAmount);
    }
    case "shipments":
      return { id, shipmentNo: cleanString(row.shipmentNo, 100), ordersCount: Array.isArray(row.orderIds) ? row.orderIds.length : finiteInteger(row.orderCount, 0), customerMasked: customerMasked(row), carrier: cleanString(row.shippingCompany || row.expressCompany, 100), trackingMasked: maskTracking(row.trackingNo || row.expressNo), status: cleanString(row.shippingStatus || row.status, 60), updatedAt: dateValue(row.updatedAt), version: finiteInteger(row.version ?? row.dataVersion, 0) };
    case "after-sales": {
      const projected = { id, caseNo: cleanString(row.afterSaleNo || row.caseNo, 100), orderNo: cleanString(row.orderNo, 100), customerMasked: customerMasked(row), type: cleanString(row.afterSaleType || row.type, 60), status: cleanString(row.afterSaleStatus || row.status, 60), createdAt: dateValue(row.createdAt), updatedAt: dateValue(row.updatedAt), version: finiteInteger(row.version ?? row.dataVersion, 0) };
      if (canViewAfterSaleAmount(principal)) {
        assignCents(projected, "amountCents", row.requestedRefundAmount, row.refundAmount, row.approvedRefundAmount);
      } else if (canViewAfterSaleRequestAmount(principal)) {
        assignCents(projected, "amountCents", row.requestedRefundAmount);
      }
      return projected;
    }
    case "refunds": {
      const suppliedStatus = cleanString(row.refundStatus || row.status, 60);
      const projected = {
        id,
        refundNo: cleanString(row.refundNo, 100),
        orderNo: cleanString(row.orderNo, 100),
        customerMasked: customerMasked(row),
        method: cleanString(row.refundMethod, 60),
        status: CANONICAL_REFUND_STATUSES.has(suppliedStatus) ? suppliedStatus : "",
        version: finiteInteger(row.version ?? row.dataVersion, 0),
        updatedAt: dateValue(row.updatedAt)
      };
      return assignCents(projected, "amountCents", row.refundAmount);
    }
    case "admins":
      return { id, name: cleanString(row.name || row.nickname, 100), username: cleanString(row.username || row.loginIdMasked, 100), role: cleanString(row.role, 50), permissionSummary: Array.isArray(row.permissions) ? row.permissions.slice(0, 5).join("、") : "", status: row.status === "disabled" || row.isActive === false ? "disabled" : "enabled", lastLoginAt: dateValue(row.lastWebLoginAt || row.lastLoginAt) };
    case "audit":
      return { id, operator: cleanString(row.operatorName || row.operatorRole || "管理员", 100), action: cleanString(row.action, 100), targetType: cleanString(row.resourceType || row.targetType, 80), summary: cleanString(row.publicSummary || row.safeSummary || `${row.resourceType || row.targetType || "业务记录"}操作已记录`, 240), status: cleanString(row.status || "success", 40), createdAt: dateValue(row.createdAt) };
    case "analytics": {
      const projected = { id, sku: cleanString(row.productIndex || row.skuCode || row.sku || row.productCode, 80), name: cleanString(row.name || row.productName, 160), brand: cleanString(row.brand, 100), totalSales: finiteInteger(row.totalSales, 0), stockChangeCount: finiteInteger(row.stockChangeCount, 0), updatedAt: dateValue(row.updatedAt) };
      return assignCents(projected, "salePriceCents", row.price);
    }
    case "imports":
      return { id, importNo: cleanString(row.importNo || row.batchNo, 100), fileName: cleanString(row.fileName || row.originalFileName, 180), importType: cleanString(row.importType || row.type, 60), status: cleanString(row.status, 60), totalRows: finiteInteger(row.totalRows ?? row.totalCount, 0), successRows: finiteInteger(row.successRows ?? row.successCount, 0), failedRows: finiteInteger(row.failedRows ?? row.failedCount, 0), createdAt: dateValue(row.createdAt), updatedAt: dateValue(row.updatedAt) };
    case "settings":
      return {
        id: "system",
        version: finiteInteger(row.version ?? row.dataVersion, 0),
        enableOfflineQrPayment: row.enableOfflineQrPayment !== false,
        enableBankTransfer: row.enableBankTransfer !== false,
        enableWechatPay: Boolean(row.enableWechatPay),
        requirePaymentProofForOfflinePayment: row.requirePaymentProofForOfflinePayment !== false,
        allowMultiplePaymentRecords: row.allowMultiplePaymentRecords !== false,
        maxPaymentScreenshotCount: Math.max(1, finiteInteger(row.maxPaymentScreenshotCount, 3)),
        lowStockDefaultThreshold: Math.max(0, finiteInteger(row.lowStockDefaultThreshold, 50)),
        updatedAt: dateValue(row.updatedAt)
      };
    default:
      throw new ApiError("RESOURCE_NOT_FOUND", "资源不存在", 404);
  }
}

function buildDashboardData(summary = {}, principal, updatedAt = new Date()) {
  const metrics = [];
  const tasks = [];
  const addMetric = (permission, key, label, value, unit, tone, route) => {
    if (!hasPermission(principal, permission)) return;
    metrics.push({ key, label, value: Math.max(0, finiteInteger(value, 0)), kind: "number", unit, tone, route });
  };
  const addTask = (permission, id, title, detail, value, tone, route) => {
    if (!hasPermission(principal, permission)) return;
    const count = Math.max(0, finiteInteger(value, 0));
    if (!count) return;
    tasks.push({ id, title, detail, count, route, tone });
  };

  addMetric("product:view", "products", "在售商品", summary.productCount, "个", "neutral", "/products");
  addMetric("inventory:view", "inventory-alerts", "库存预警", summary.inventoryAlertCount, "项", "warning", "/inventory/alerts");
  addMetric("inventory:import", "imports", "待确认导入", summary.pendingImportCount, "批", "info", "/imports/inventory");
  addMetric("order:view", "orders", "待审核订单", summary.pendingOrderCount, "单", "warning", "/orders");
  addMetric("payment:view_screenshot", "payments", "待确认付款", summary.pendingPaymentCount, "笔", "warning", "/payments");
  addMetric("shipment:view", "shipments", "待发货", summary.pendingShipmentCount, "单", "info", "/shipments");
  addMetric("after_sale:view", "after-sales", "待处理售后", summary.pendingAfterSaleCount, "单", "danger", "/after-sales");
  addMetric("refund:view", "refunds", "待处理退款", summary.pendingRefundCount, "笔", "danger", "/refunds");
  addMetric("customer:view_account", "accounts", "客户账款", summary.accountCount, "户", "info", "/accounts");

  addTask("inventory:view", "inventory-alerts", "处理库存预警", "低库存和缺货商品", summary.inventoryAlertCount, "warning", "/inventory/alerts");
  addTask("inventory:import", "imports", "确认导入批次", "待确认的库存或报价文件", summary.pendingImportCount, "info", "/imports/inventory");
  addTask("order:view", "orders", "审核新订单", "等待后台审核的订单", summary.pendingOrderCount, "warning", "/orders");
  addTask("payment:view_screenshot", "payments", "核对付款", "等待财务确认的付款记录", summary.pendingPaymentCount, "warning", "/payments");
  addTask("shipment:view", "shipments", "安排发货", "等待填写物流的订单", summary.pendingShipmentCount, "info", "/shipments");
  addTask("after_sale:view", "after-sales", "处理售后", "等待审核的售后申请", summary.pendingAfterSaleCount, "danger", "/after-sales");
  addTask("refund:view", "refunds", "处理退款", "等待财务处理的退款记录", summary.pendingRefundCount, "danger", "/refunds");

  const topProducts = hasPermission(principal, "product:view") && Array.isArray(summary.topProducts)
    ? summary.topProducts.slice(0, 8).map((row) => ({
      name: cleanString(row.name, 160),
      sku: cleanString(row.sku, 80),
      value: Math.max(0, finiteInteger(row.value, 0)),
      change: Number.isFinite(Number(row.change)) ? Number(row.change) : 0
    })).filter((row) => row.name && row.sku)
    : [];

  return {
    metrics,
    tasks,
    trend: [],
    topProducts,
    updatedAt: dateValue(updatedAt) || new Date().toISOString()
  };
}

function normalizeAnalyticsRange(value) {
  return ["7d", "30d", "90d"].includes(value) ? value : "30d";
}

function emptyProductAnalyticsData(range, updatedAt = new Date()) {
  return {
    range: normalizeAnalyticsRange(range),
    status: "unavailable",
    message: "分析数据暂不可用",
    summary: [],
    series: [],
    ranking: [],
    updatedAt: dateValue(updatedAt) || new Date().toISOString()
  };
}

function publicProfile(principal, rawAdmin, session) {
  return {
    id: principal.id,
    username: cleanString(rawAdmin.username || rawAdmin.loginIdMasked || rawAdmin.account, 100),
    displayName: cleanString(rawAdmin.name || rawAdmin.nickname || "管理员", 100),
    role: principal.role,
    roleName: principal.roleName,
    permissions: principal.permissions.slice(),
    isActive: true,
    sessionExpiresAt: dateValue(session.accessExpiresAt)
  };
}

function allowedSyncEntityTypes(principal) {
  if (principal && principal.role === "super_admin") return null;
  const allowed = new Set(["system"]);
  if (hasPermission(principal, "product:view")) allowed.add("product");
  if (hasPermission(principal, "inventory:view")) allowed.add("inventory");
  if (hasPermission(principal, "order:view")) allowed.add("order");
  if (hasPermission(principal, "payment:view_screenshot")) allowed.add("payment");
  if (hasPermission(principal, "customer:view_account")) allowed.add("account");
  if (hasPermission(principal, "shipment:view")) allowed.add("shipment");
  if (hasPermission(principal, "after_sale:view")) allowed.add("after_sale");
  if (hasPermission(principal, "refund:view")) allowed.add("refund");
  return Array.from(allowed).sort();
}

function syncQuerySpec(principal, cursor) {
  return {
    cursorAfter: cleanString(cursor, 128),
    entityTypes: allowedSyncEntityTypes(principal)
  };
}

function nextSyncCursor(events, fallback = "") {
  if (!Array.isArray(events) || !events.length) return cleanString(fallback, 128);
  return cleanString(events[events.length - 1].cursor, 128) || cleanString(fallback, 128);
}

function parseHttpRoute(path, method = "GET") {
  const cleanPath = cleanString(path, 500).split("?")[0];
  const marker = "/api/admin/v1";
  const markerIndex = cleanPath.indexOf(marker);
  const relative = markerIndex >= 0 ? cleanPath.slice(markerIndex + marker.length) : cleanPath;
  const parts = relative.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const verb = cleanString(method, 20).toUpperCase();
  if (parts[0] === "auth" && parts[1] === "profile" && parts.length === 2 && verb === "GET") return { action: "profile" };
  if (parts[0] === "sync" && parts[1] === "events" && parts.length === 2 && verb === "GET") return { action: "sync" };
  if (parts[0] === "dashboard" && parts.length === 1 && verb === "GET") return { action: "dashboard" };
  if (parts[0] === "analytics" && parts[1] === "products" && parts.length === 2 && verb === "GET") return { action: "productAnalytics" };
  if (parts[0] === "shipments" && parts.length === 1 && verb === "GET") return { action: "shipmentList" };
  if (parts[0] === "shipments" && parts.length === 2 && verb === "GET") {
    return { action: "shipmentDetail", id: cleanString(parts[1], 128) };
  }
  if (parts[0] === "accounts" && parts.length === 1 && verb === "GET") return { action: "accountList" };
  if (parts[0] === "accounts" && parts.length === 2 && verb === "GET") {
    return { action: "accountDetail", id: cleanString(parts[1], 128) };
  }
  if (parts[0] === "payments" && parts.length === 1 && verb === "GET") return { action: "paymentList" };
  if (parts[0] === "payments" && parts.length === 2 && verb === "GET") {
    return { action: "paymentDetail", id: cleanString(parts[1], 128) };
  }
  if (["auth", "sync", "dashboard", "analytics"].includes(parts[0])) throw new ApiError("ROUTE_NOT_FOUND", "接口不存在", 404);
  const resource = normalizeResource(parts[0]);
  if (!RESOURCE_POLICIES[resource]) throw new ApiError("ROUTE_NOT_FOUND", "接口不存在", 404);
  if (parts.length === 1 && verb === "GET") return { action: "list", resource };
  if (parts.length === 2 && verb === "GET") return { action: "get", resource, id: cleanString(parts[1], 128) };
  if (parts.length === 2 && verb === "POST") return { action: "mutate", resource, mutationAction: cleanString(parts[1], 100) };
  throw new ApiError("ROUTE_NOT_FOUND", "接口不存在", 404);
}

function successEnvelope(data, requestId) {
  const serverTime = new Date().toISOString();
  return { ok: true, data, requestId, serverTime, meta: { requestId, serverTime } };
}

function errorEnvelope(error, requestId) {
  const err = error instanceof ApiError ? error : new ApiError("INTERNAL_ERROR", "服务暂时不可用", 500);
  const serverTime = new Date().toISOString();
  return { statusCode: err.statusCode, payload: { ok: false, code: err.code, message: err.message, requestId, serverTime, error: { code: err.code, message: err.message, requestId }, meta: { requestId, serverTime } } };
}

module.exports = {
  ApiError,
  RESOURCE_POLICIES,
  MUTATION_POLICIES,
  cleanString,
  normalizePagination,
  encodeCursor,
  normalizeResource,
  getResourcePolicy,
  resolveResourceDocumentId,
  getMutationPermission,
  boundedPermissions,
  hasPermission,
  assertPermission,
  projectResource,
  buildDashboardData,
  normalizeAnalyticsRange,
  emptyProductAnalyticsData,
  publicProfile,
  allowedSyncEntityTypes,
  syncQuerySpec,
  nextSyncCursor,
  parseHttpRoute,
  successEnvelope,
  errorEnvelope,
  stockStatus,
  dateValue
};
