const crypto = require("crypto");
const cloud = require("wx-server-sdk");
const security = require("./security");
const {
  ApiError,
  cleanString,
  normalizePagination,
  encodeCursor,
  getResourcePolicy,
  resolveResourceDocumentId,
  getMutationPermission,
  assertPermission,
  hasPermission,
  projectResource,
  buildDashboardData,
  publicProfile,
  parseHttpRoute,
  successEnvelope,
  errorEnvelope,
  stockStatus,
  dateValue
} = require("./lib/core");
const { requireAccessSession, assertSessionCsrf } = require("./lib/session");
const { readSyncBatch, ownerKeyFor } = require("./lib/syncEvents");
const inventoryWarningModule = require("./lib/inventoryWarningService");
const inventoryWarningIdempotency = require("./lib/idempotency");
const inventoryWarningStockAlert = require("./lib/stockAlert");
const productAnalyticsModule = require("./lib/productAnalyticsQueryService");
const productPriceModule = require("./lib/productPriceService");
const productStatusModule = require("./lib/productStatusService");
const productTagModule = require("./lib/productTagService");
const productWriteModule = require("./lib/productWriteService");
const inventoryMutationModule = require("./lib/inventoryMutationService");
const orderQueryModule = require("./lib/orderQueryService");
const orderReviewModule = require("./lib/orderReviewService");
const shipmentQueryModule = require("./lib/shipmentQueryService");
const accountQueryModule = require("./lib/accountQueryService");
const paymentQueryModule = require("./lib/paymentQueryService");
const paymentMutationModule = require("./lib/paymentMutationService");
const afterSaleReviewModule = require("./lib/afterSaleReviewService");
const returnInspectionModule = require("./lib/returnInspectionService");
const refundMutationModule = require("./lib/refundMutationService");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;

function createInventoryWarningService() {
  if (typeof inventoryWarningModule.createInventoryWarningService === "function") {
    return inventoryWarningModule.createInventoryWarningService({
      db,
      stockAlert: inventoryWarningStockAlert,
      idempotency: inventoryWarningIdempotency
    });
  }
  if (typeof inventoryWarningModule.setWarningStock === "function") {
    return {
      setWarningStock(options) {
        return inventoryWarningModule.setWarningStock({
          db,
          stockAlert: inventoryWarningStockAlert,
          idempotency: inventoryWarningIdempotency,
          ...options
        });
      }
    };
  }
  throw new Error("inventory warning service export is invalid");
}

function createProductPriceService() {
  if (typeof productPriceModule.createProductPriceService !== "function") {
    throw new Error("product price service export is invalid");
  }
  return productPriceModule.createProductPriceService({
    db,
    idempotency: inventoryWarningIdempotency
  });
}

function createProductStatusService() {
  if (typeof productStatusModule.createProductStatusService !== "function") {
    throw new Error("product status service export is invalid");
  }
  return productStatusModule.createProductStatusService({
    db,
    idempotency: inventoryWarningIdempotency
  });
}

function createProductTagService() {
  if (typeof productTagModule.createProductTagService !== "function") {
    throw new Error("product tag service export is invalid");
  }
  return productTagModule.createProductTagService({
    db,
    idempotency: inventoryWarningIdempotency
  });
}

function createProductWriteService() {
  if (typeof productWriteModule.createProductWriteService !== "function") {
    throw new Error("product write service export is invalid");
  }
  return productWriteModule.createProductWriteService({
    db,
    idempotency: inventoryWarningIdempotency,
    stockAlert: inventoryWarningStockAlert
  });
}

function createInventoryMutationService() {
  if (typeof inventoryMutationModule.createInventoryMutationService !== "function") {
    throw new Error("inventory mutation service export is invalid");
  }
  return inventoryMutationModule.createInventoryMutationService({
    db,
    idempotency: inventoryWarningIdempotency,
    stockAlert: inventoryWarningStockAlert
  });
}

const defaultInventoryWarningService = createInventoryWarningService();
const defaultProductAnalyticsService = productAnalyticsModule.createProductAnalyticsQueryService({
  db,
  command
});
const defaultProductPriceService = createProductPriceService();
const defaultProductStatusService = createProductStatusService();
const defaultProductTagService = createProductTagService();
const defaultProductWriteService = createProductWriteService();
const defaultInventoryMutationService = createInventoryMutationService();
const defaultOrderQueryService = orderQueryModule.createOrderQueryService({ db, command });
const defaultShipmentQueryService = shipmentQueryModule.createShipmentQueryService({ db, command });
const defaultAccountQueryService = accountQueryModule.createAccountQueryService({ db, command });
const defaultPaymentQueryService = paymentQueryModule.createPaymentQueryService({ db, command });
const defaultPaymentMutationService = paymentMutationModule.createPaymentMutationService({
  db,
  idempotency: inventoryWarningIdempotency,
  ownerKeyFor,
  syncOwnerPepper: process.env.SYNC_OWNER_PEPPER,
  recalculateAccount({ userId, userOpenid }) {
    return cloud.callFunction({ name: "recalculateCustomerAccount", data: { userId, userOpenid } });
  }
});
const defaultAfterSaleReviewService = afterSaleReviewModule.createAfterSaleReviewService({
  db,
  idempotency: inventoryWarningIdempotency,
  ownerKeyFor,
  syncOwnerPepper: process.env.SYNC_OWNER_PEPPER
});
const defaultReturnInspectionService = returnInspectionModule.createReturnInspectionService({
  db,
  idempotency: inventoryWarningIdempotency,
  ownerKeyFor,
  syncOwnerPepper: process.env.SYNC_OWNER_PEPPER,
  applyInventoryMutationInTransaction: inventoryMutationModule.applyInventoryMutationInTransaction,
  stockAlert: inventoryWarningStockAlert
});
const defaultRefundMutationService = refundMutationModule.createRefundMutationService({
  db,
  idempotency: inventoryWarningIdempotency,
  ownerKeyFor,
  syncOwnerPepper: process.env.SYNC_OWNER_PEPPER,
  recalculateAccount({ accountId }) {
    return cloud.callFunction({ name: "recalculateCustomerAccount", data: { accountId } });
  }
});
const defaultOrderReviewService = orderReviewModule.createOrderReviewService({
  db,
  command,
  stockAlert: inventoryWarningStockAlert,
  idempotency: inventoryWarningIdempotency,
  ownerKeyFor,
  syncOwnerPepper: process.env.SYNC_OWNER_PEPPER,
  recalculateAccount({ userId, userOpenid }) {
    return cloud.callFunction({ name: "recalculateCustomerAccount", data: { userId, userOpenid } });
  }
});

function orderQueryApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80) || "ORDER_QUERY_FAILED";
  const statusCode = Number(error && error.statusCode) || 500;
  const safeMessages = {
    FORBIDDEN: "无权访问订单",
    INVALID_CURSOR: "订单分页信息已失效，请重新加载",
    INVALID_DATE_FILTER: "订单日期筛选无效",
    INVALID_DATE_RANGE: "订单日期范围无效",
    INVALID_ORDER_STATUS: "订单状态筛选无效",
    ORDER_SEARCH_UNAVAILABLE: "当前环境暂不支持订单搜索",
    ORDER_SEARCH_SCAN_LIMIT_EXCEEDED: "订单搜索范围过大，请增加筛选条件后重试",
    ORDER_COUNT_FAILED: "订单计数失败，请稍后重试",
    ORDER_COUNT_INVALID: "订单计数结果无效",
    ORDER_ITEMS_LIMIT_EXCEEDED: "订单明细过多，请缩小查询范围后重试",
    ORDER_READ_FAILED: "订单数据读取失败，请稍后重试",
    ORDER_ID_REQUIRED: "缺少订单 ID",
    NOT_FOUND: "订单不存在"
  };
  return new ApiError(code, safeMessages[code] || "订单数据读取失败", statusCode);
}

const SHIPMENT_WEB_ROLES = new Set(["customer_service", "finance", "super_admin"]);
const SHIPMENT_QUERY_ERRORS = Object.freeze({
  SHIPMENT_QUERY_INVALID: { statusCode: 400, message: "合并发货单查询参数无效" },
  SHIPMENT_CURSOR_INVALID: { statusCode: 400, message: "合并发货单分页信息已失效，请重新加载" },
  FORBIDDEN: { statusCode: 403, message: "无权查看合并发货单" },
  SHIPMENT_NOT_FOUND: { statusCode: 404, message: "合并发货单不存在" },
  SHIPMENT_RELATED_ROWS_LIMIT_EXCEEDED: { statusCode: 503, message: "合并发货单关联数据过多，请稍后重试" },
  SHIPMENT_READ_FAILED: { statusCode: 503, message: "合并发货单读取失败，请稍后重试" }
});

function assertWebShipmentRead(principal) {
  if (!principal || principal.status !== "active" || principal.isActive === false
    || !SHIPMENT_WEB_ROLES.has(principal.role)) {
    throw new ApiError("FORBIDDEN", SHIPMENT_QUERY_ERRORS.FORBIDDEN.message, 403);
  }
  assertPermission(principal, "shipment:view");
}

function shipmentQueryApiError(error) {
  const code = cleanString(error && error.code, 80);
  const mapped = SHIPMENT_QUERY_ERRORS[code];
  if (mapped) return new ApiError(code, mapped.message, mapped.statusCode);
  return new ApiError("SHIPMENT_READ_FAILED", SHIPMENT_QUERY_ERRORS.SHIPMENT_READ_FAILED.message, 503);
}

async function readWebShipmentList(query, principal, service = defaultShipmentQueryService) {
  assertWebShipmentRead(principal);
  try {
    return await service.listWebShipments({ actor: principal, query: query || {} });
  } catch (error) {
    throw shipmentQueryApiError(error);
  }
}

async function readWebShipmentDetail(id, principal, service = defaultShipmentQueryService) {
  assertWebShipmentRead(principal);
  try {
    return await service.getWebShipment({ actor: principal, id });
  } catch (error) {
    throw shipmentQueryApiError(error);
  }
}

const ACCOUNT_WEB_ROLES = new Set(["finance", "super_admin"]);
const ACCOUNT_QUERY_ERRORS = Object.freeze({
  ACCOUNT_QUERY_INVALID: { statusCode: 400, message: "客户账款查询参数无效" },
  ACCOUNT_CURSOR_INVALID: { statusCode: 400, message: "客户账款分页信息已失效，请重新加载" },
  ACCOUNT_DATA_INVALID: { statusCode: 503, message: "客户账款数据异常，请稍后重试" },
  FORBIDDEN: { statusCode: 403, message: "无权查看客户账款" },
  ACCOUNT_NOT_FOUND: { statusCode: 404, message: "客户账款不存在" },
  ACCOUNT_READ_FAILED: { statusCode: 503, message: "客户账款读取失败，请稍后重试" }
});

function assertWebAccountRead(principal) {
  if (!principal || principal.status !== "active" || principal.isActive === false
    || !ACCOUNT_WEB_ROLES.has(principal.role)) {
    throw new ApiError("FORBIDDEN", ACCOUNT_QUERY_ERRORS.FORBIDDEN.message, 403);
  }
  assertPermission(principal, "customer:view_account");
}

function accountQueryApiError(error) {
  const code = cleanString(error && error.code, 80);
  const mapped = ACCOUNT_QUERY_ERRORS[code];
  if (mapped) return new ApiError(code, mapped.message, mapped.statusCode);
  return new ApiError("ACCOUNT_READ_FAILED", ACCOUNT_QUERY_ERRORS.ACCOUNT_READ_FAILED.message, 503);
}

async function readWebAccountList(query, principal, service = defaultAccountQueryService) {
  assertWebAccountRead(principal);
  try {
    return await service.listWebAccounts({ actor: principal, query: query || {} });
  } catch (error) {
    throw accountQueryApiError(error);
  }
}

async function readWebAccountDetail(id, principal, service = defaultAccountQueryService) {
  assertWebAccountRead(principal);
  try {
    return await service.getWebAccount({ actor: principal, id });
  } catch (error) {
    throw accountQueryApiError(error);
  }
}

const PAYMENT_WEB_ROLES = new Set(["finance", "super_admin"]);
const PAYMENT_QUERY_ERRORS = Object.freeze({
  PAYMENT_QUERY_INVALID: { statusCode: 400, message: "付款记录查询参数无效" },
  PAYMENT_CURSOR_INVALID: { statusCode: 400, message: "付款记录分页信息已失效，请重新加载" },
  PAYMENT_DATA_INVALID: { statusCode: 503, message: "付款记录数据异常，请稍后重试" },
  FORBIDDEN: { statusCode: 403, message: "无权查看付款记录" },
  PAYMENT_NOT_FOUND: { statusCode: 404, message: "付款记录不存在" },
  PAYMENT_READ_FAILED: { statusCode: 503, message: "付款记录读取失败，请稍后重试" }
});

function assertWebPaymentRead(principal) {
  if (!principal || principal.status !== "active" || principal.isActive === false || !PAYMENT_WEB_ROLES.has(principal.role)) {
    throw new ApiError("FORBIDDEN", PAYMENT_QUERY_ERRORS.FORBIDDEN.message, 403);
  }
  assertPermission(principal, "payment:view_screenshot");
}

function paymentQueryApiError(error) {
  const code = cleanString(error && error.code, 80);
  const mapped = PAYMENT_QUERY_ERRORS[code];
  if (mapped) return new ApiError(code, mapped.message, mapped.statusCode);
  return new ApiError("PAYMENT_READ_FAILED", PAYMENT_QUERY_ERRORS.PAYMENT_READ_FAILED.message, 503);
}

async function readWebPaymentList(query, principal, service = defaultPaymentQueryService) {
  assertWebPaymentRead(principal);
  try {
    return await service.listWebPayments({ actor: principal, query: query || {} });
  } catch (error) {
    throw paymentQueryApiError(error);
  }
}

async function readWebPaymentDetail(id, principal, service = defaultPaymentQueryService) {
  assertWebPaymentRead(principal);
  try {
    return await service.getWebPayment({ actor: principal, id });
  } catch (error) {
    throw paymentQueryApiError(error);
  }
}
const PAYMENT_MUTATION_BODY_FIELDS = new Set([
  "paymentId",
  "expectedStatus",
  "expectedVersion",
  "expectedUpdatedAt",
  "reason"
]);
const PAYMENT_MUTATION_INPUT_ERRORS = new Set([
  "UNKNOWN_FIELD",
  "PAYMENT_ID_REQUIRED",
  "PAYMENT_ID_INVALID",
  "DECISION_INVALID",
  "EXPECTED_STATUS_REQUIRED",
  "EXPECTED_STATUS_INVALID",
  "EXPECTED_VERSION_REQUIRED",
  "EXPECTED_VERSION_INVALID",
  "EXPECTED_UPDATED_AT_REQUIRED",
  "EXPECTED_UPDATED_AT_INVALID",
  "REASON_REQUIRED",
  "REASON_INVALID",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_INVALID"
]);
const PAYMENT_MUTATION_CONFLICT_ERRORS = new Set([
  "DATA_VERSION_CONFLICT",
  "DATA_VERSION_INVALID",
  "PAYMENT_STATUS_CONFLICT",
  "PAYMENT_RECORD_STALE",
  "ORDER_STATUS_CONFLICT",
  "ORDER_AMOUNT_INVALID",
  "ORDER_ALREADY_PAID",
  "PAYMENT_OVERPAY",
  "ACCOUNT_DUPLICATE",
  "ACCOUNT_IDENTITY_CONFLICT",
  "ACCOUNT_AMOUNT_INVALID",
  "ACCOUNT_MUTATION_VERSION_INVALID",
  "ACCOUNT_ID_REQUIRED",
  "ACCOUNT_LOG_DUPLICATE",
  "ACCOUNT_LOG_CONFLICT",
  "ACCOUNT_MUTATION_LOG_DUPLICATE",
  "ACCOUNT_MUTATION_LOG_CONFLICT",
  "SYNC_EVENT_DUPLICATE",
  "SYNC_EVENT_CONFLICT",
  "BUSINESS_LOG_DUPLICATE",
  "BUSINESS_LOG_CONFLICT",
  "DELIVERY_LOG_DUPLICATE",
  "DELIVERY_LOG_CONFLICT",
  "PAYMENT_PREFLIGHT_INVALID",
  "IDEMPOTENCY_KEY_CONFLICT",
  "IDEMPOTENCY_PROCESSING",
  "IDEMPOTENCY_NOT_EXECUTABLE"
]);

function paymentMutationRoute(route = {}) {
  return route.resource === "payments" && ["confirm", "reject"].includes(route.mutationAction);
}

function assertWebPaymentMutation(principal, action) {
  const permission = action === "reject" ? "payment:update_status" : "payment:confirm";
  if (!principal
    || principal.status !== "active"
    || principal.isActive === false
    || !PAYMENT_WEB_ROLES.has(principal.role)
    || !Array.isArray(principal.permissions)
    || (!principal.permissions.includes("*") && !principal.permissions.includes(permission))) {
    throw new ApiError("FORBIDDEN", "无权执行付款审核操作", 403);
  }
}

function normalizePaymentMutation(request = {}) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST_BODY", "付款审核请求无效", 400);
  }
  if (Object.keys(body).some((key) => !PAYMENT_MUTATION_BODY_FIELDS.has(key))) {
    throw new ApiError("INVALID_REQUEST_BODY", "付款审核请求包含不允许的字段", 400);
  }
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(
      request.headers && (request.headers["idempotency-key"] || request.headers["Idempotency-Key"])
    );
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", "付款审核操作凭证无效", 400);
  }
  if (typeof body.paymentId !== "string" || !body.paymentId.trim()) {
    throw new ApiError("PAYMENT_ID_REQUIRED", "缺少付款记录 ID", 400);
  }
  if (body.paymentId.trim().length > 128) {
    throw new ApiError("PAYMENT_ID_INVALID", "付款记录 ID 格式无效", 400);
  }
  if (body.expectedStatus === undefined || body.expectedStatus === null || body.expectedStatus === "") {
    throw new ApiError("EXPECTED_STATUS_REQUIRED", "缺少付款当前状态，请刷新后重试", 400);
  }
  if (body.expectedStatus !== "pending_confirm") {
    throw new ApiError("EXPECTED_STATUS_INVALID", "付款当前状态无效，请刷新后重试", 400);
  }
  if (body.expectedVersion === undefined || body.expectedVersion === null || body.expectedVersion === "") {
    throw new ApiError("EXPECTED_VERSION_REQUIRED", "缺少付款记录版本，请刷新后重试", 400);
  }
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new ApiError("EXPECTED_VERSION_INVALID", "付款记录版本无效，请刷新后重试", 400);
  }
  if (body.expectedUpdatedAt === undefined || body.expectedUpdatedAt === null || body.expectedUpdatedAt === "") {
    throw new ApiError("EXPECTED_UPDATED_AT_REQUIRED", "缺少付款记录更新时间，请刷新后重试", 400);
  }
  if (typeof body.expectedUpdatedAt !== "string") {
    throw new ApiError("EXPECTED_UPDATED_AT_INVALID", "付款记录更新时间无效，请刷新后重试", 400);
  }
  const parsedUpdatedAt = new Date(body.expectedUpdatedAt);
  if (Number.isNaN(parsedUpdatedAt.getTime()) || parsedUpdatedAt.toISOString() !== body.expectedUpdatedAt) {
    throw new ApiError("EXPECTED_UPDATED_AT_INVALID", "付款记录更新时间无效，请刷新后重试", 400);
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim().length > 300)) {
    throw new ApiError("REASON_INVALID", "付款审核原因格式无效", 400);
  }
  const reason = body.reason === undefined ? "" : body.reason.trim();
  const decision = request.route && request.route.mutationAction === "reject" ? "reject" : "confirm";
  if (decision === "reject" && !reason) {
    throw new ApiError("REASON_REQUIRED", "请填写驳回原因", 400);
  }
  return {
    idempotencyKey,
    input: {
      paymentId: body.paymentId.trim(),
      decision,
      expectedStatus: "pending_confirm",
      expectedVersion: body.expectedVersion,
      expectedUpdatedAt: body.expectedUpdatedAt,
      reason
    }
  };
}

function paymentMutationActor(auth = {}) {
  return inventoryWarningActor(auth);
}

function paymentMutationApiError(error) {
  const code = cleanString(error && error.code, 80);
  if (PAYMENT_MUTATION_INPUT_ERRORS.has(code)) {
    const message = code === "REASON_REQUIRED" ? "请填写驳回原因" : "付款审核请求无效";
    return new ApiError(code, message, 400);
  }
  if (code === "FORBIDDEN" || code === "INVALID_ACTOR") {
    return new ApiError(code, "无权执行付款审核操作", 403);
  }
  if (code === "PAYMENT_NOT_FOUND" || code === "ORDER_NOT_FOUND") {
    return new ApiError(code, "付款记录或关联订单不存在", 404);
  }
  if (PAYMENT_MUTATION_CONFLICT_ERRORS.has(code)) {
    return new ApiError(code, "付款记录或订单状态已变化，请刷新后重试", 409);
  }
  if (code === "SYNC_OWNER_CONFIG_REQUIRED" || code === "CLOCK_INVALID") {
    return new ApiError(code, "付款审核服务暂时不可用，请稍后重试", 503);
  }
  return new ApiError("PAYMENT_MUTATION_FAILED", "付款审核服务暂时不可用，请稍后重试", 503);
}

function paymentMutationResult(result = {}, requestId = "") {
  const paymentId = cleanString(result.paymentId, 128);
  const decision = result.decision === "reject" ? "reject" : result.decision === "confirm" ? "confirm" : "";
  const status = cleanString(result.status, 60);
  const updatedAt = dateValue(result.updatedAt);
  if (!paymentId
    || !decision
    || !status
    || !updatedAt
    || typeof result.version !== "number"
    || !Number.isSafeInteger(result.version)
    || result.version < 0) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "付款审核结果无效", 502);
  }
  return {
    item: {
      id: paymentId,
      orderNo: cleanString(result.orderNo, 100),
      status,
      version: result.version,
      updatedAt
    },
    affected: result.affected === 1 ? 1 : 0,
    reused: result.reused === true,
    decision,
    accountRecalculationPending: result.accountRecalculationPending === true,
    message: decision === "reject" ? "付款凭证已驳回" : "付款已确认",
    requestId
  };
}

const REFUND_MUTATION_ROLES = new Set(["finance", "super_admin"]);
const REFUND_PROCESSABLE_STATUSES = new Set(["pending", "processing", "failed"]);
const REFUND_MUTATION_BODY_FIELDS = Object.freeze({
  process: new Set([
    "refundRecordId",
    "refundAmountCents",
    "expectedRefundStatus",
    "expectedRefundVersion",
    "expectedRefundUpdatedAt",
    "financeRemark",
    "refundProofFileIds"
  ]),
  reject: new Set([
    "refundRecordId",
    "expectedRefundStatus",
    "expectedRefundVersion",
    "expectedRefundUpdatedAt",
    "rejectReason"
  ])
});
const REFUND_MUTATION_INPUT_ERRORS = new Set([
  "INVALID_REQUEST_BODY",
  "UNKNOWN_FIELD",
  "REFUND_INPUT_INVALID",
  "REFUND_RECORD_ID_REQUIRED",
  "INVALID_REFUND_AMOUNT",
  "EXPECTED_REFUND_STATUS_REQUIRED",
  "EXPECTED_REFUND_STATUS_INVALID",
  "EXPECTED_REFUND_VERSION_REQUIRED",
  "EXPECTED_REFUND_VERSION_INVALID",
  "EXPECTED_REFUND_UPDATED_AT_REQUIRED",
  "EXPECTED_REFUND_UPDATED_AT_INVALID",
  "FINANCE_REMARK_INVALID",
  "FINANCEREMARK_INVALID",
  "REJECT_REASON_REQUIRED",
  "REJECT_REASON_INVALID",
  "REJECTREASON_REQUIRED",
  "REJECTREASON_INVALID",
  "REFUND_PROOF_INVALID",
  "REFUND_PROOF_LIMIT_EXCEEDED",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_INVALID"
]);
const REFUND_MUTATION_NOT_FOUND_ERRORS = new Set([
  "REFUND_NOT_FOUND",
  "AFTER_SALE_NOT_FOUND",
  "ORDER_NOT_FOUND",
  "ACCOUNT_NOT_FOUND",
  "ORDER_ITEM_NOT_FOUND"
]);
const REFUND_MUTATION_CONFLICT_ERRORS = new Set([
  "DATA_VERSION_CONFLICT",
  "DATA_VERSION_INVALID",
  "DATA_REFUND_AMOUNT_INVALID",
  "REFUND_STATUS_CONFLICT",
  "REFUND_RELATION_CONFLICT",
  "REFUND_APPROVAL_LIMIT_EXCEEDED",
  "REFUND_PAID_LIMIT_EXCEEDED",
  "REFUND_RECORD_AMOUNT_EXCEEDED",
  "REFUND_HISTORY_LIMIT_EXCEEDED",
  "RETURN_INSPECTION_REQUIRED",
  "REFUND_ITEM_QUANTITY_RECONCILIATION_REQUIRED",
  "ACCOUNT_DUPLICATE",
  "ACCOUNT_IDENTITY_CONFLICT",
  "AFTER_SALE_NOT_APPROVED",
  "IMMUTABLE_EVIDENCE_MISSING",
  "IMMUTABLE_EVIDENCE_DUPLICATE",
  "IMMUTABLE_EVIDENCE_CONFLICT",
  "IDEMPOTENCY_KEY_CONFLICT",
  "IDEMPOTENCY_PROCESSING",
  "IDEMPOTENCY_NOT_EXECUTABLE"
]);

function refundMutationRoute(route = {}) {
  return route.resource === "refunds" && ["process", "reject"].includes(route.mutationAction);
}

function assertWebRefundMutation(principal) {
  if (!principal
    || principal.status !== "active"
    || principal.isActive === false
    || !REFUND_MUTATION_ROLES.has(principal.role)
    || !Array.isArray(principal.permissions)
    || (!principal.permissions.includes("*") && !principal.permissions.includes("refund:process"))) {
    throw new ApiError("FORBIDDEN", "无权执行退款操作", 403);
  }
}

function refundMutationIdempotencyKey(request = {}) {
  try {
    return inventoryWarningIdempotency.assertIdempotencyKey(
      request.headers && (request.headers["idempotency-key"] || request.headers["Idempotency-Key"])
    );
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", "退款操作凭证无效", 400);
  }
}

function refundExpectedSnapshots(body) {
  if (body.expectedRefundStatus === undefined || body.expectedRefundStatus === null || body.expectedRefundStatus === "") {
    throw new ApiError("EXPECTED_REFUND_STATUS_REQUIRED", "缺少退款当前状态，请刷新后重试", 400);
  }
  if (typeof body.expectedRefundStatus !== "string"
    || !REFUND_PROCESSABLE_STATUSES.has(body.expectedRefundStatus)) {
    throw new ApiError("EXPECTED_REFUND_STATUS_INVALID", "退款当前状态无效，请刷新后重试", 400);
  }
  if (body.expectedRefundVersion === undefined || body.expectedRefundVersion === null || body.expectedRefundVersion === "") {
    throw new ApiError("EXPECTED_REFUND_VERSION_REQUIRED", "缺少退款记录版本，请刷新后重试", 400);
  }
  if (!Number.isSafeInteger(body.expectedRefundVersion) || body.expectedRefundVersion < 0) {
    throw new ApiError("EXPECTED_REFUND_VERSION_INVALID", "退款记录版本无效，请刷新后重试", 400);
  }
  if (body.expectedRefundUpdatedAt === undefined || body.expectedRefundUpdatedAt === null || body.expectedRefundUpdatedAt === "") {
    throw new ApiError("EXPECTED_REFUND_UPDATED_AT_REQUIRED", "缺少退款记录更新时间，请刷新后重试", 400);
  }
  if (typeof body.expectedRefundUpdatedAt !== "string") {
    throw new ApiError("EXPECTED_REFUND_UPDATED_AT_INVALID", "退款记录更新时间无效，请刷新后重试", 400);
  }
  const parsedUpdatedAt = new Date(body.expectedRefundUpdatedAt);
  if (Number.isNaN(parsedUpdatedAt.getTime()) || parsedUpdatedAt.toISOString() !== body.expectedRefundUpdatedAt) {
    throw new ApiError("EXPECTED_REFUND_UPDATED_AT_INVALID", "退款记录更新时间无效，请刷新后重试", 400);
  }
  return {
    expectedRefundStatus: body.expectedRefundStatus,
    expectedRefundVersion: body.expectedRefundVersion,
    expectedRefundUpdatedAt: body.expectedRefundUpdatedAt
  };
}

function normalizeRefundProofFileIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError("REFUND_PROOF_INVALID", "退款凭证格式无效", 400);
  }
  if (value.length > 6) {
    throw new ApiError("REFUND_PROOF_LIMIT_EXCEEDED", "退款凭证最多 6 个", 400);
  }
  const proofs = value.map((item) => {
    if (typeof item !== "string") {
      throw new ApiError("REFUND_PROOF_INVALID", "退款凭证格式无效", 400);
    }
    const proof = item.trim();
    if (!/^cloud:\/\/\S{1,492}$/.test(proof) || proof.length > 500) {
      throw new ApiError("REFUND_PROOF_INVALID", "退款凭证格式无效", 400);
    }
    return proof;
  });
  if (new Set(proofs).size !== proofs.length) {
    throw new ApiError("REFUND_PROOF_INVALID", "退款凭证不能重复", 400);
  }
  return proofs;
}

function normalizeRefundMutation(request = {}, action = request.route && request.route.mutationAction) {
  const fields = REFUND_MUTATION_BODY_FIELDS[action];
  const body = request.body;
  if (!fields) {
    throw new ApiError("MUTATION_NOT_SUPPORTED", "退款操作不存在", 404);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST_BODY", "退款请求无效", 400);
  }
  if (Object.keys(body).some((key) => !fields.has(key))) {
    throw new ApiError("INVALID_REQUEST_BODY", "退款请求包含不允许的字段", 400);
  }
  if (typeof body.refundRecordId !== "string"
    || !body.refundRecordId.trim()
    || body.refundRecordId.trim().length > 128) {
    throw new ApiError("REFUND_RECORD_ID_REQUIRED", "缺少退款记录", 400);
  }
  const input = {
    refundRecordId: body.refundRecordId.trim(),
    ...refundExpectedSnapshots(body)
  };
  if (action === "process") {
    if (!Number.isSafeInteger(body.refundAmountCents) || body.refundAmountCents <= 0) {
      throw new ApiError("INVALID_REFUND_AMOUNT", "退款金额必须是大于 0 的整数分", 400);
    }
    input.refundAmountCents = body.refundAmountCents;
    if (Object.hasOwn(body, "financeRemark")) {
      if (typeof body.financeRemark !== "string" || body.financeRemark.trim().length > 300) {
        throw new ApiError("FINANCE_REMARK_INVALID", "退款备注格式无效", 400);
      }
      input.financeRemark = body.financeRemark.trim();
    }
    if (Object.hasOwn(body, "refundProofFileIds")) {
      input.refundProofFileIds = normalizeRefundProofFileIds(body.refundProofFileIds);
    }
  } else {
    if (typeof body.rejectReason !== "string" || !body.rejectReason.trim()) {
      throw new ApiError("REJECT_REASON_REQUIRED", "请填写退款拒绝原因", 400);
    }
    if (body.rejectReason.trim().length > 300) {
      throw new ApiError("REJECT_REASON_INVALID", "退款拒绝原因格式无效", 400);
    }
    input.rejectReason = body.rejectReason.trim();
  }
  return {
    idempotencyKey: refundMutationIdempotencyKey(request),
    input
  };
}

function refundMutationActor(auth = {}) {
  const principal = auth.principal || {};
  const rawAdmin = auth.rawAdmin || {};
  return {
    id: cleanString(principal.id, 128),
    openid: cleanString(rawAdmin.openid, 128),
    role: cleanString(principal.role, 50),
    status: principal.status,
    isActive: principal.status === "active" && principal.isActive !== false,
    sourceClient: "admin_web"
  };
}

function refundMutationApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80);
  if (REFUND_MUTATION_INPUT_ERRORS.has(code)) {
    return new ApiError(code, "退款请求无效", 400);
  }
  if (code === "FORBIDDEN" || code === "INVALID_ACTOR") {
    return new ApiError(code, "无权执行退款操作", 403);
  }
  if (REFUND_MUTATION_NOT_FOUND_ERRORS.has(code)) {
    return new ApiError(code, "退款记录或关联业务记录不存在", 404);
  }
  if (REFUND_MUTATION_CONFLICT_ERRORS.has(code)) {
    return new ApiError(code, "退款记录或关联业务状态已变化，请刷新后重试", 409);
  }
  if (code === "SYNC_OWNER_CONFIG_REQUIRED" || code === "CLOCK_INVALID") {
    return new ApiError(code, "退款服务暂时不可用，请稍后重试", 503);
  }
  return new ApiError("REFUND_MUTATION_FAILED", "退款服务暂时不可用，请稍后重试", 503);
}

function refundMutationResult(result = {}, requestId = "", expectedAction = "") {
  const item = result.item && typeof result.item === "object" && !Array.isArray(result.item)
    ? result.item
    : {};
  const id = cleanString(item.id, 128);
  const refundNo = cleanString(item.refundNo, 100);
  const status = cleanString(item.status, 40);
  const updatedAt = dateValue(item.updatedAt);
  const action = result.action === "process" || result.action === "reject" ? result.action : "";
  const expectedStatus = action === "process" ? "refunded" : action === "reject" ? "rejected" : "";
  if (!id
    || !refundNo
    || !expectedStatus
    || action !== expectedAction
    || status !== expectedStatus
    || !Number.isSafeInteger(item.version)
    || item.version < 0
    || !updatedAt
    || !Number.isSafeInteger(item.amountCents)
    || item.amountCents < 0
    || (result.affected !== 0 && result.affected !== 1)
    || typeof result.reused !== "boolean"
    || typeof result.accountRecalculationPending !== "boolean") {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "退款结果无效", 502);
  }
  return {
    item: {
      id,
      refundNo,
      status,
      version: item.version,
      updatedAt,
      amountCents: item.amountCents
    },
    affected: result.affected,
    reused: result.reused,
    action,
    accountRecalculationPending: result.accountRecalculationPending,
    message: action === "reject" ? "退款已拒绝" : "退款已确认",
    requestId
  };
}

const AFTER_SALE_REVIEW_BODY_FIELDS = new Set([
  "afterSaleId",
  "expectedStatus",
  "expectedVersion",
  "expectedUpdatedAt",
  "approvedRefundAmount",
  "returnRequired",
  "reason"
]);
const AFTER_SALE_REVIEW_ROLES = new Set(["customer_service", "super_admin"]);
const RETURN_INSPECTION_ROLES = new Set(["customer_service", "super_admin"]);
const RETURN_INSPECTION_BODY_FIELDS = Object.freeze({
  receive: new Set(["afterSaleId", "expectedStatus", "expectedVersion", "expectedUpdatedAt", "remark"]),
  inspect: new Set(["afterSaleId", "expectedStatus", "expectedVersion", "expectedUpdatedAt", "itemCondition", "canRestock", "restockQuantity", "inspectionRemark"])
});
const RETURN_INSPECTION_INPUT_ERRORS = new Set([
  "UNKNOWN_FIELD",
  "ACTION_INVALID",
  "AFTER_SALE_ID_REQUIRED",
  "EXPECTED_STATUS_REQUIRED",
  "EXPECTED_STATUS_INVALID",
  "EXPECTED_VERSION_REQUIRED",
  "EXPECTED_VERSION_INVALID",
  "EXPECTED_UPDATED_AT_REQUIRED",
  "EXPECTED_UPDATED_AT_INVALID",
  "ITEM_CONDITION_REQUIRED",
  "ITEM_CONDITION_INVALID",
  "RESTOCK_FLAG_INVALID",
  "RESTOCK_QUANTITY_INVALID",
  "RESTOCK_CONDITION_INVALID",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_INVALID"
]);
const RETURN_INSPECTION_CONFLICT_ERRORS = new Set([
  "DATA_VERSION_CONFLICT",
  "DATA_VERSION_INVALID",
  "AFTER_SALE_STATUS_INVALID",
  "DATA_REFUND_AMOUNT_INVALID",
  "RETURN_ITEM_DATA_INVALID",
  "RESTOCK_QUANTITY_EXCEEDED",
  "INVENTORY_LOG_DUPLICATE",
  "INVENTORY_LOG_CONFLICT",
  "PRODUCT_NOT_FOUND",
  "IDEMPOTENCY_KEY_CONFLICT",
  "IDEMPOTENCY_PROCESSING",
  "IDEMPOTENCY_NOT_EXECUTABLE"
]);
const AFTER_SALE_REVIEW_INPUT_ERRORS = new Set([
  "UNKNOWN_FIELD",
  "AFTER_SALE_ID_REQUIRED",
  "DECISION_INVALID",
  "EXPECTED_STATUS_REQUIRED",
  "EXPECTED_STATUS_INVALID",
  "EXPECTED_VERSION_REQUIRED",
  "EXPECTED_VERSION_INVALID",
  "EXPECTED_UPDATED_AT_REQUIRED",
  "EXPECTED_UPDATED_AT_INVALID",
  "REFUND_AMOUNT_INVALID",
  "RETURN_REQUIRED_INVALID",
  "REASON_REQUIRED",
  "REASON_INVALID",
  "REJECT_FIELDS_INVALID",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_INVALID"
]);
const AFTER_SALE_REVIEW_CONFLICT_ERRORS = new Set([
  "DATA_VERSION_CONFLICT",
  "DATA_VERSION_INVALID",
  "AFTER_SALE_STATUS_INVALID",
  "REFUND_AMOUNT_EXCEEDED",
  "IDEMPOTENCY_KEY_CONFLICT",
  "IDEMPOTENCY_PROCESSING",
  "IDEMPOTENCY_NOT_EXECUTABLE",
  "SYNC_EVENT_DUPLICATE",
  "SYNC_EVENT_CONFLICT"
]);

function afterSaleReviewRoute(route = {}) {
  return route.resource === "after-sales" && ["approve", "reject"].includes(route.mutationAction);
}

function returnInspectionRoute(route = {}) {
  return route.resource === "after-sales" && ["receive", "inspect"].includes(route.mutationAction);
}

function assertWebReturnInspection(principal, action) {
  const permission = action === "inspect" ? "after_sale:inspect" : "after_sale:receive_return";
  if (!principal
    || principal.status !== "active"
    || principal.isActive === false
    || !RETURN_INSPECTION_ROLES.has(principal.role)
    || !Array.isArray(principal.permissions)
    || (!principal.permissions.includes("*") && !principal.permissions.includes(permission))) {
    throw new ApiError("FORBIDDEN", "无权执行退货验收操作", 403);
  }
}

function normalizeReturnInspectionMutation(request = {}) {
  const action = request.route && request.route.mutationAction;
  const body = request.body;
  if (!RETURN_INSPECTION_BODY_FIELDS[action]) {
    throw new ApiError("MUTATION_NOT_SUPPORTED", "退货验收操作不存在", 404);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST_BODY", "退货验收请求无效", 400);
  }
  if (Object.keys(body).some((key) => !RETURN_INSPECTION_BODY_FIELDS[action].has(key))) {
    throw new ApiError("INVALID_REQUEST_BODY", "退货验收请求包含不允许的字段", 400);
  }
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(
      request.headers && (request.headers["idempotency-key"] || request.headers["Idempotency-Key"])
    );
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", "退货验收操作凭证无效", 400);
  }
  try {
    return {
      idempotencyKey,
      input: returnInspectionModule.normalizeInspectionInput({ action, ...body }, { strict: true })
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const code = cleanString(error && error.code, 80) || "INVALID_REQUEST_BODY";
    throw new ApiError(code, "退货验收请求无效", 400);
  }
}

function returnInspectionActor(auth = {}) {
  return { ...inventoryWarningActor(auth), sourceClient: "admin_web" };
}

function returnInspectionApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80);
  if (RETURN_INSPECTION_INPUT_ERRORS.has(code)) {
    return new ApiError(code, "退货验收请求无效", 400);
  }
  if (code === "FORBIDDEN" || code === "INVALID_ACTOR") {
    return new ApiError(code, "无权执行退货验收操作", 403);
  }
  if (code === "AFTER_SALE_NOT_FOUND") {
    return new ApiError(code, "售后单不存在", 404);
  }
  if (RETURN_INSPECTION_CONFLICT_ERRORS.has(code)) {
    return new ApiError(code, "售后单或库存已变化，请刷新后重试", 409);
  }
  if (["CLOCK_INVALID", "SYNC_OWNER_CONFIG_REQUIRED", "INVENTORY_LOG_READ_FAILED"].includes(code)) {
    return new ApiError(code, "退货验收服务暂时不可用", 503);
  }
  return new ApiError("RETURN_INSPECTION_FAILED", "退货验收服务暂时不可用", 503);
}

function returnInspectionMutationResult(result = {}, requestId = "", action = "") {
  const id = cleanString(result.afterSaleId, 128);
  const status = cleanString(result.afterSaleStatus, 60);
  const updatedAt = dateValue(result.updatedAt);
  const restoredQuantity = result.restoredQuantity;
  if (!id
    || !updatedAt
    || !Number.isSafeInteger(result.version)
    || result.version < 0
    || !["received", "approved", "refund_pending"].includes(status)
    || !Number.isSafeInteger(restoredQuantity)
    || restoredQuantity < 0
    || (result.affected !== 0 && result.affected !== 1)) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "退货验收结果无效", 502);
  }
  return {
    item: { id, status, version: result.version, updatedAt },
    afterSaleId: id,
    afterSaleStatus: status,
    restoredQuantity,
    affected: result.affected,
    reused: result.reused === true,
    message: action === "receive" ? "已确认收到退货" : "退货验货已完成",
    requestId
  };
}

function assertWebAfterSaleReview(principal) {
  if (!principal
    || principal.status !== "active"
    || principal.isActive === false
    || !AFTER_SALE_REVIEW_ROLES.has(principal.role)
    || !Array.isArray(principal.permissions)
    || (!principal.permissions.includes("*") && !principal.permissions.includes("after_sale:review"))) {
    throw new ApiError("FORBIDDEN", "无权执行售后审核操作", 403);
  }
}

function normalizeAfterSaleReview(request = {}) {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST_BODY", "售后审核请求无效", 400);
  }
  if (Object.keys(body).some((key) => !AFTER_SALE_REVIEW_BODY_FIELDS.has(key))) {
    throw new ApiError("INVALID_REQUEST_BODY", "售后审核请求包含不允许的字段", 400);
  }
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(
      request.headers && (request.headers["idempotency-key"] || request.headers["Idempotency-Key"])
    );
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", "售后审核操作凭证无效", 400);
  }
  if (typeof body.afterSaleId !== "string" || !body.afterSaleId.trim()) {
    throw new ApiError("AFTER_SALE_ID_REQUIRED", "缺少售后单号 ID", 400);
  }
  if (body.afterSaleId.trim().length > 128) {
    throw new ApiError("AFTER_SALE_ID_REQUIRED", "售后单号 ID 格式无效", 400);
  }
  if (body.expectedStatus !== "pending_review") {
    throw new ApiError(
      body.expectedStatus === undefined || body.expectedStatus === null || body.expectedStatus === ""
        ? "EXPECTED_STATUS_REQUIRED"
        : "EXPECTED_STATUS_INVALID",
      "售后单当前状态无效，请刷新后重试",
      400
    );
  }
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new ApiError(
      body.expectedVersion === undefined ? "EXPECTED_VERSION_REQUIRED" : "EXPECTED_VERSION_INVALID",
      "售后单版本无效，请刷新后重试",
      400
    );
  }
  if (typeof body.expectedUpdatedAt !== "string") {
    throw new ApiError(
      body.expectedUpdatedAt === undefined ? "EXPECTED_UPDATED_AT_REQUIRED" : "EXPECTED_UPDATED_AT_INVALID",
      "售后单更新时间无效，请刷新后重试",
      400
    );
  }
  const parsedUpdatedAt = new Date(body.expectedUpdatedAt);
  if (Number.isNaN(parsedUpdatedAt.getTime()) || parsedUpdatedAt.toISOString() !== body.expectedUpdatedAt) {
    throw new ApiError("EXPECTED_UPDATED_AT_INVALID", "售后单更新时间无效，请刷新后重试", 400);
  }
  if (body.approvedRefundAmount !== undefined
    && (typeof body.approvedRefundAmount !== "number"
      || !Number.isSafeInteger(body.approvedRefundAmount)
      || body.approvedRefundAmount < 0)) {
    throw new ApiError("REFUND_AMOUNT_INVALID", "审批退款金额无效，必须是整数分", 400);
  }
  if (body.returnRequired !== undefined && typeof body.returnRequired !== "boolean") {
    throw new ApiError("RETURN_REQUIRED_INVALID", "returnRequired must be boolean", 400);
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim().length > 300)) {
    throw new ApiError("REASON_INVALID", "审核说明格式无效", 400);
  }
  const reason = body.reason === undefined ? "" : body.reason.trim();
  const decision = request.route && request.route.mutationAction === "reject" ? "reject" : "approve";
  if (decision === "reject" && !reason) {
    throw new ApiError("REASON_REQUIRED", "rejection reason is required", 400);
  }
  return {
    idempotencyKey,
    input: {
      id: body.afterSaleId.trim(),
      decision,
      expectedStatus: "pending_review",
      expectedVersion: body.expectedVersion,
      expectedUpdatedAt: body.expectedUpdatedAt,
      approvedRefundAmount: body.approvedRefundAmount,
      returnRequired: body.returnRequired,
      reason
    }
  };
}

function afterSaleReviewActor(auth = {}) {
  return inventoryWarningActor(auth);
}

function afterSaleReviewApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80);
  if (AFTER_SALE_REVIEW_INPUT_ERRORS.has(code)) {
    return new ApiError(code, code === "REASON_REQUIRED" ? "rejection reason is required" : "after-sale review request is invalid", 400);
  }
  if (code === "FORBIDDEN" || code === "INVALID_ACTOR") {
    return new ApiError(code, "forbidden after-sale review operation", 403);
  }
  if (code === "AFTER_SALE_NOT_FOUND") {
    return new ApiError(code, "after-sale record not found", 404);
  }
  if (AFTER_SALE_REVIEW_CONFLICT_ERRORS.has(code)) {
    return new ApiError(code, "售后单状态或版本已变化，请刷新后重试", 409);
  }
  if (code === "CLOCK_INVALID" || code === "SYNC_OWNER_CONFIG_REQUIRED") {
    return new ApiError(code, "after-sale review service is temporarily unavailable", 503);
  }
  return new ApiError("AFTER_SALE_REVIEW_FAILED", "after-sale review service is temporarily unavailable", 503);
}

function afterSaleReviewMutationResult(result = {}, requestId = "") {
  const item = result.item && typeof result.item === "object" ? result.item : {};
  const id = cleanString(item.id || result.afterSaleId, 128);
  const caseNo = cleanString(item.caseNo, 100);
  const status = cleanString(item.status || result.afterSaleStatus, 60);
  const decision = result.decision === "reject" ? "reject" : result.decision === "approve" ? "approve" : "";
  const updatedAt = dateValue(item.updatedAt);
  if (!id || !status || !decision || !updatedAt
    || !Number.isSafeInteger(item.version) || item.version < 0
    || !["approved", "waiting_return", "refund_pending", "rejected"].includes(status)
    || (decision === "reject" && status !== "rejected")
    || (decision === "approve" && !["approved", "waiting_return", "refund_pending"].includes(status))) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "售后审核结果无效", 502);
  }
  const approvedRefundAmount = result.approvedRefundAmount === undefined ? 0 : result.approvedRefundAmount;
  if (!Number.isSafeInteger(approvedRefundAmount) || approvedRefundAmount < 0) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "售后审核结果无效", 502);
  }
  return {
    item: { id, caseNo, status, version: item.version, updatedAt },
    afterSaleId: id,
    afterSaleStatus: status,
    refundStatus: cleanString(result.refundStatus, 40) || "none",
    approvedRefundAmount,
    affected: result.affected === 1 ? 1 : 0,
    reused: result.reused === true,
    decision,
    message: decision === "reject" ? "after-sale request rejected" : "after-sale request approved",
    requestId
  };
}
const INVENTORY_WARNING_BODY_FIELDS = new Set([
  "id",
  "warningThreshold",
  "expectedWarningThreshold",
  "reason",
  "expectedVersion"
]);
const PRODUCT_PRICE_BODY_FIELDS = new Set([
  "id",
  "newPriceCents",
  "expectedPriceCents",
  "expectedVersion",
  "reason"
]);
const PRODUCT_STATUS_BODY_FIELDS = new Set([
  "id",
  "isActive",
  "expectedIsActive",
  "expectedVersion",
  "reason"
]);
const PRODUCT_BATCH_ENABLE_BODY_FIELDS = new Set([
  "isActive",
  "items",
  "reason"
]);
const PRODUCT_BATCH_ENABLE_ITEM_FIELDS = new Set([
  "id",
  "expectedIsActive",
  "expectedVersion"
]);
const PRODUCT_BATCH_TAG_BODY_FIELDS = new Set([
  "scope",
  "tag",
  "present",
  "items",
  "reason"
]);
const PRODUCT_BATCH_TAG_ITEM_FIELDS = new Set([
  "id",
  "expectedVersion",
  "expectedPresent"
]);
const PRODUCT_BATCH_TAGS = new Set(["新货", "瑕疵", "热销"]);
const PRODUCT_TAG_FAILURE_CODES = new Set([
  "PRODUCT_NOT_FOUND",
  "DATA_VERSION_CONFLICT",
  "DATA_VERSION_INVALID",
  "DATA_INTERNAL_TAGS_INVALID"
]);
const PRODUCT_CREATE_BODY_FIELDS = new Set(["metadata", "initial", "reason"]);
const PRODUCT_EDIT_BODY_FIELDS = new Set(["id", "expectedVersion", "metadata", "reason"]);
const PRODUCT_METADATA_FIELDS = new Set([
  "name", "baseName", "imageUrl", "specification", "productionDate", "description", "productIndex", "skuCode", "keywords"
]);
const PRODUCT_INITIAL_FIELDS = new Set(["salePriceCents", "stock", "warningThreshold", "isActive", "tags"]);
const PRODUCT_PUBLIC_TAGS = new Set(["新货", "瑕疵", "热销"]);
const INVENTORY_ADJUST_BODY_FIELDS = new Set([
  "id", "mode", "delta", "expectedStock", "expectedVersion", "reason"
]);

function productWriteRoute(route = {}) {
  return route.resource === "products" && ["create", "edit"].includes(route.mutationAction);
}

function assertPlainObject(value, message = "请求内容无效") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST_BODY", message, 400);
}

function assertOnlyFields(value, allowed, message = "请求包含不允许的字段") {
  const rejected = Object.keys(value).find((key) => !allowed.has(key));
  if (rejected) throw new ApiError("INVALID_REQUEST_BODY", message, 400);
}

function normalizeProductMetadataBody(value) {
  assertPlainObject(value, "商品资料无效");
  assertOnlyFields(value, PRODUCT_METADATA_FIELDS, "商品资料包含不允许的字段");
  const missing = Array.from(PRODUCT_METADATA_FIELDS).find((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing) throw new ApiError("INVALID_REQUEST_BODY", "商品资料字段不完整", 400);
  for (const field of PRODUCT_METADATA_FIELDS) {
    if (field === "keywords") continue;
    if (typeof value[field] !== "string") throw new ApiError("INVALID_REQUEST_BODY", "商品资料格式无效", 400);
  }
  if (!value.name.trim()) throw new ApiError("PRODUCT_NAME_REQUIRED", "商品名称不能为空", 400);
  const limits = { name: 160, baseName: 160, imageUrl: 500, specification: 120, productionDate: 40, description: 1000, productIndex: 80, skuCode: 80 };
  if (Object.entries(limits).some(([field, max]) => value[field].trim().length > max)) {
    throw new ApiError("FIELD_TOO_LONG", "商品资料长度超出限制", 400);
  }
  if (!Array.isArray(value.keywords) || value.keywords.length > 20
    || value.keywords.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 40)
    || new Set(value.keywords.map((item) => item.trim())).size !== value.keywords.length) {
    throw new ApiError("KEYWORDS_INVALID", "关键词格式无效", 400);
  }
  return {
    name: value.name,
    baseName: value.baseName,
    imageUrl: value.imageUrl,
    specification: value.specification,
    productionDate: value.productionDate,
    description: value.description,
    productIndex: value.productIndex,
    skuCode: value.skuCode,
    keywords: value.keywords.slice()
  };
}

function normalizeProductWriteMutation(request = {}) {
  const body = request.body;
  assertPlainObject(body);
  const action = request.route && request.route.mutationAction;
  assertOnlyFields(body, action === "create" ? PRODUCT_CREATE_BODY_FIELDS : PRODUCT_EDIT_BODY_FIELDS);
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(request.headers && request.headers["idempotency-key"]);
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
  }
  const metadata = normalizeProductMetadataBody(body.metadata);
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim().length > 120)) {
    throw new ApiError("INVALID_REQUEST_BODY", "操作说明格式无效", 400);
  }
  if (action === "edit") {
    if (typeof body.id !== "string" || !body.id.trim() || body.id.trim().length > 128) throw new ApiError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
    if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
      throw new ApiError(body.expectedVersion === undefined ? "EXPECTED_VERSION_REQUIRED" : "EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
    }
    return { idempotencyKey, action, input: { productId: body.id.trim(), ...metadata, expectedVersion: body.expectedVersion, reason: (body.reason || "").trim() } };
  }
  assertPlainObject(body.initial, "商品初始数据无效");
  assertOnlyFields(body.initial, PRODUCT_INITIAL_FIELDS, "商品初始数据包含不允许的字段");
  const missing = Array.from(PRODUCT_INITIAL_FIELDS).find((field) => !Object.prototype.hasOwnProperty.call(body.initial, field));
  if (missing) throw new ApiError("INVALID_REQUEST_BODY", "商品初始数据字段不完整", 400);
  const initial = body.initial;
  for (const [field, max] of [["salePriceCents", Number.MAX_SAFE_INTEGER], ["stock", 9999999], ["warningThreshold", 99999]]) {
    if (typeof initial[field] !== "number" || !Number.isSafeInteger(initial[field]) || initial[field] < 0 || initial[field] > max) {
      throw new ApiError("INVALID_REQUEST_BODY", "商品初始数据格式无效", 400);
    }
  }
  if (typeof initial.isActive !== "boolean") throw new ApiError("INVALID_REQUEST_BODY", "商品初始状态无效", 400);
  if (!Array.isArray(initial.tags) || initial.tags.some((tag) => typeof tag !== "string" || !PRODUCT_PUBLIC_TAGS.has(tag))) {
    throw new ApiError("PUBLIC_TAGS_INVALID", "公开标签格式无效", 400);
  }
  if (new Set(initial.tags).size !== initial.tags.length) throw new ApiError("PUBLIC_TAGS_INVALID", "公开标签不能重复", 400);
  return {
    idempotencyKey,
    action,
    input: {
      ...metadata,
      priceCents: initial.salePriceCents,
      stock: initial.stock,
      warningStock: initial.warningThreshold,
      isActive: initial.isActive,
      publicTags: initial.tags.slice(),
      reason: (body.reason || "").trim()
    }
  };
}

function productWriteApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80);
  const allowed = new Set([
    "FORBIDDEN", "INVALID_ACTOR", "PRODUCT_NOT_FOUND", "PRODUCT_ID_REQUIRED", "PRODUCT_NAME_REQUIRED",
    "FIELD_TYPE_INVALID", "FIELD_TOO_LONG", "KEYWORDS_INVALID", "PUBLIC_TAGS_INVALID", "INTERNAL_TAGS_INVALID",
    "PRICE_INVALID", "STOCK_INVALID", "WARNING_STOCK_INVALID", "EXPECTED_VERSION_REQUIRED", "EXPECTED_VERSION_INVALID",
    "DATA_VERSION_INVALID", "DATA_VERSION_CONFLICT", "PRODUCT_INDEX_REQUIRED", "PRODUCT_INDEX_DUPLICATE", "PRODUCT_INDEX_EXHAUSTED"
  ]);
  if (!allowed.has(code) && !/^IDEMPOTENCY_/.test(code)) return new ApiError("PRODUCT_WRITE_SERVICE_UNAVAILABLE", "商品资料服务暂时不可用", 502);
  const statusCode = Number(error.statusCode) || (["FORBIDDEN", "INVALID_ACTOR"].includes(code) ? 403
    : code === "PRODUCT_NOT_FOUND" ? 404
      : ["DATA_VERSION_INVALID", "DATA_VERSION_CONFLICT", "PRODUCT_INDEX_DUPLICATE", "IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400);
  const details = ["DATA_VERSION_INVALID"].includes(code) ? undefined : error.details;
  return new ApiError(code, cleanString(error.message, 240) || "商品资料操作失败", statusCode, details);
}

function productWriteMutationResult(result = {}, requestId = "", principal = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || typeof result.productId !== "string" || !result.productId.trim()
    || typeof result.version !== "number" || !Number.isSafeInteger(result.version) || result.version < 0
    || typeof result.changed !== "boolean") {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "商品资料操作结果无效", 502);
  }
  const metadata = result.metadata && typeof result.metadata === "object" ? result.metadata : {};
  const item = projectResource("products", {
    _id: result.productId,
    ...metadata,
    price: result.price,
    stock: result.stock,
    warningStock: result.warningStock,
    stockStatus: result.stockStatus,
    isActive: result.isActive,
    tags: result.tags,
    version: result.version,
    updatedAt: result.updatedAt
  }, principal, false);
  return {
    item,
    affected: result.changed === false ? 0 : 1,
    message: result.changed === false ? "商品资料未发生变化" : "商品资料已保存",
    requestId
  };
}

function inventoryWarningRoute(route = {}) {
  return ["inventory", "inventory-alerts"].includes(route.resource)
    && route.mutationAction === "set-warning";
}

function inventoryAdjustmentRoute(route = {}) {
  return ["inventory", "inventory-alerts"].includes(route.resource)
    && route.mutationAction === "adjust";
}

function normalizeInventoryAdjustmentMutation(request = {}) {
  const body = request.body;
  assertPlainObject(body);
  assertOnlyFields(body, INVENTORY_ADJUST_BODY_FIELDS);
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(
      request.headers && request.headers["idempotency-key"]
    );
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
  }
  if (typeof body.id !== "string" || !body.id.trim() || body.id.trim().length > 128) {
    throw new ApiError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  }
  if (body.mode !== "delta") throw new ApiError("INVENTORY_MODE_INVALID", "网页版仅支持按增减量调整库存", 400);
  if (typeof body.delta !== "number" || !Number.isSafeInteger(body.delta) || body.delta === 0
    || body.delta < -9999999 || body.delta > 9999999) {
    throw new ApiError("DELTA_INVALID", "库存变化量必须是非零整数", 400);
  }
  if (typeof body.expectedStock !== "number" || !Number.isSafeInteger(body.expectedStock)
    || body.expectedStock < 0 || body.expectedStock > 9999999) {
    throw new ApiError(body.expectedStock === undefined ? "EXPECTED_STOCK_REQUIRED" : "EXPECTED_STOCK_INVALID", "当前库存无效，请刷新后重试", 400);
  }
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new ApiError(body.expectedVersion === undefined ? "EXPECTED_VERSION_REQUIRED" : "EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
  }
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 120) {
    throw new ApiError("REASON_INVALID", "请填写 1 到 120 个字符的调整原因", 400);
  }
  return {
    idempotencyKey,
    input: {
      productId: body.id.trim(),
      mode: "delta",
      delta: body.delta,
      expectedStock: body.expectedStock,
      expectedVersion: body.expectedVersion,
      reason: body.reason.trim()
    }
  };
}

function inventoryAdjustmentApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80);
  const allowed = new Set([
    "FORBIDDEN", "INVALID_ACTOR", "PRODUCT_NOT_FOUND", "PRODUCT_ID_REQUIRED", "INVENTORY_MODE_INVALID",
    "DELTA_INVALID", "REASON_INVALID", "REASON_REQUIRED", "EXPECTED_STOCK_REQUIRED", "EXPECTED_STOCK_INVALID",
    "EXPECTED_VERSION_REQUIRED", "EXPECTED_VERSION_INVALID", "DATA_STOCK_INVALID", "DATA_VERSION_INVALID",
    "DATA_WARNING_STOCK_INVALID", "DATA_VERSION_CONFLICT", "AFTER_STOCK_INVALID", "INVENTORY_LOG_INVALID"
  ]);
  if (!allowed.has(code) && !/^IDEMPOTENCY_/.test(code)) {
    return new ApiError("INVENTORY_SERVICE_UNAVAILABLE", "库存调整服务暂时不可用", 502);
  }
  const statusCode = Number(error && error.statusCode)
    || (["FORBIDDEN", "INVALID_ACTOR"].includes(code) ? 403
      : code === "PRODUCT_NOT_FOUND" ? 404
        : ["DATA_STOCK_INVALID", "DATA_VERSION_INVALID", "DATA_WARNING_STOCK_INVALID", "DATA_VERSION_CONFLICT", "AFTER_STOCK_INVALID", "INVENTORY_LOG_INVALID", "IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400);
  return new ApiError(code, cleanString(error && error.message, 240) || "库存调整失败", statusCode, error && error.details);
}

function inventoryAdjustmentMutationResult(result = {}, requestId = "") {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || typeof result.productId !== "string" || !result.productId
    || !Number.isSafeInteger(result.stock) || result.stock < 0
    || !Number.isSafeInteger(result.warningStock) || result.warningStock < 0
    || !Number.isSafeInteger(result.version) || result.version < 0
    || typeof result.isActive !== "boolean") {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "库存调整结果无效", 502);
  }
  const statuses = { normal: "normal", warning: "low", out_of_stock: "out" };
  const status = statuses[result.stockStatus];
  if (!status) throw new ApiError("INVALID_SERVICE_RESPONSE", "库存调整结果无效", 502);
  return {
    item: {
      id: result.productId,
      stock: result.stock,
      warningThreshold: result.warningStock,
      status,
      isActive: result.isActive,
      version: result.version,
      updatedAt: dateValue(result.updatedAt)
    },
    affected: result.changed === false ? 0 : 1,
    message: result.changed === false ? "库存未发生变化" : `库存已从 ${result.beforeStock} 调整为 ${result.stock}`,
    requestId
  };
}

function assertInventoryWarningBodyFields(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST_BODY", "请求内容无效", 400);
  }
  const rejected = Object.keys(body).find((key) => !INVENTORY_WARNING_BODY_FIELDS.has(key));
  if (rejected) throw new ApiError("INVALID_REQUEST_BODY", "请求包含不允许的字段", 400);
}

function normalizeInventoryWarningMutation(request = {}) {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  assertInventoryWarningBodyFields(body);
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(request.headers && request.headers["idempotency-key"]);
  } catch (err) {
    throw new ApiError(err.code || "IDEMPOTENCY_KEY_INVALID", err.message || "操作凭证无效", 400);
  }
  if (typeof body.id !== "string" || !body.id.trim() || body.id.trim().length > 128) {
    throw new ApiError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  }
  const productId = body.id.trim();
  if (typeof body.warningThreshold !== "number"
    || !Number.isSafeInteger(body.warningThreshold)
    || body.warningThreshold < 0
    || body.warningThreshold > 99999) {
    throw new ApiError("WARNING_THRESHOLD_INVALID", "预警库存必须是 0 到 99999 的整数", 400);
  }
  if (body.expectedWarningThreshold === undefined) {
    throw new ApiError("EXPECTED_WARNING_THRESHOLD_REQUIRED", "缺少当前预警值，请刷新后重试", 400);
  }
  if (typeof body.expectedWarningThreshold !== "number"
    || !Number.isSafeInteger(body.expectedWarningThreshold)
    || body.expectedWarningThreshold < 0
    || body.expectedWarningThreshold > 99999) {
    throw new ApiError("EXPECTED_WARNING_THRESHOLD_INVALID", "当前预警值无效，请刷新后重试", 400);
  }
  if (body.expectedVersion === undefined) {
    throw new ApiError("EXPECTED_VERSION_REQUIRED", "缺少数据版本，请刷新后重试", 400);
  }
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new ApiError("EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim().length > 120)) {
    throw new ApiError("INVALID_REQUEST_BODY", "操作说明格式无效", 400);
  }
  return {
    idempotencyKey,
    input: {
      productId,
      warningThreshold: body.warningThreshold,
      expectedWarningThreshold: body.expectedWarningThreshold,
      expectedVersion: body.expectedVersion,
      reason: body.reason === undefined ? "" : body.reason.trim()
    }
  };
}

function inventoryWarningActor(auth = {}) {
  const principal = auth.principal || {};
  const rawAdmin = auth.rawAdmin || {};
  return {
    id: cleanString(principal.id, 128),
    openid: cleanString(rawAdmin.openid, 128),
    role: cleanString(principal.role, 50),
    permissions: Array.isArray(principal.permissions) ? principal.permissions.slice() : [],
    status: principal.status,
    isActive: principal.status === "active",
    sourceClient: "admin_web"
  };
}

function inventoryWarningApiError(err) {
  if (err instanceof ApiError) return err;
  const code = cleanString(err && err.code, 80);
  const allowed = code === "FORBIDDEN"
    || code === "INVALID_ACTOR"
    || code === "PRODUCT_NOT_FOUND"
    || code === "PRODUCT_ID_REQUIRED"
    || code === "WARNING_THRESHOLD_INVALID"
    || code === "EXPECTED_VERSION_REQUIRED"
    || code === "EXPECTED_VERSION_INVALID"
    || code === "EXPECTED_WARNING_THRESHOLD_REQUIRED"
    || code === "EXPECTED_WARNING_THRESHOLD_INVALID"
    || code === "DATA_VERSION_CONFLICT"
    || code === "DATA_VERSION_INVALID"
    || code === "DATA_WARNING_THRESHOLD_INVALID"
    || code === "DATA_STOCK_INVALID"
    || code === "REASON_INVALID"
    || /^IDEMPOTENCY_/.test(code);
  if (!allowed) return err;
  const statusCode = Number(err.statusCode) || (
    code === "FORBIDDEN" || code === "INVALID_ACTOR" ? 403
      : code === "PRODUCT_NOT_FOUND" ? 404
        : ["DATA_VERSION_CONFLICT", "DATA_VERSION_INVALID", "DATA_WARNING_THRESHOLD_INVALID", "DATA_STOCK_INVALID", "IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409
          : 400
  );
  const safeMessage = code === "DATA_STOCK_INVALID"
    ? "商品库存数据异常，暂不能修改"
    : cleanString(err.message, 240) || "库存预警操作失败";
  const details = code === "DATA_STOCK_INVALID" ? undefined : err.details;
  return new ApiError(code, safeMessage, statusCode, details);
}

function inventoryWarningMutationResult(result = {}, requestId = "") {
  const stockStatusValue = cleanString(result.stockStatus, 40);
  const status = stockStatusValue === "out_of_stock" ? "out" : stockStatusValue === "warning" ? "low" : "normal";
  const version = Number(result.version);
  return {
    item: {
      id: cleanString(result.productId, 128),
      stock: Number(result.stock || 0),
      warningThreshold: Number(result.warningStock || 0),
      status,
      version: Number.isSafeInteger(version) && version >= 0 ? version : 0
    },
    affected: result.changed === false ? 0 : 1,
    message: result.changed === false ? "库存预警值未重复写入" : "库存预警值已更新",
    requestId
  };
}

function productPriceRoute(route = {}) {
  return route.resource === "products" && route.mutationAction === "change-price";
}

function assertProductPriceBodyFields(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST_BODY", "请求内容无效", 400);
  }
  const rejected = Object.keys(body).find((key) => !PRODUCT_PRICE_BODY_FIELDS.has(key));
  if (rejected) throw new ApiError("INVALID_REQUEST_BODY", "请求包含不允许的字段", 400);
}

function normalizeProductPriceMutation(request = {}) {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  assertProductPriceBodyFields(body);
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(request.headers && request.headers["idempotency-key"]);
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
  }
  if (typeof body.id !== "string" || !body.id.trim() || body.id.trim().length > 128) {
    throw new ApiError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  }
  if (typeof body.newPriceCents !== "number" || !Number.isSafeInteger(body.newPriceCents) || body.newPriceCents < 0) {
    throw new ApiError("PRICE_INVALID", "售价必须是非负整数分", 400);
  }
  if (body.expectedPriceCents === undefined) {
    throw new ApiError("EXPECTED_PRICE_REQUIRED", "缺少当前售价，请刷新后重试", 400);
  }
  if (typeof body.expectedPriceCents !== "number"
    || !Number.isSafeInteger(body.expectedPriceCents)
    || body.expectedPriceCents < 0) {
    throw new ApiError("EXPECTED_PRICE_INVALID", "当前售价无效，请刷新后重试", 400);
  }
  if (body.expectedVersion === undefined) {
    throw new ApiError("EXPECTED_VERSION_REQUIRED", "缺少数据版本，请刷新后重试", 400);
  }
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new ApiError("EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim().length > 120)) {
    throw new ApiError("INVALID_REQUEST_BODY", "操作说明格式无效", 400);
  }
  return {
    idempotencyKey,
    input: {
      productId: body.id.trim(),
      newPriceCents: body.newPriceCents,
      expectedPriceCents: body.expectedPriceCents,
      expectedVersion: body.expectedVersion,
      reason: body.reason === undefined ? "" : body.reason.trim()
    }
  };
}

function productPriceActor(auth = {}) {
  return inventoryWarningActor(auth);
}

function productPriceApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80);
  const allowed = code === "FORBIDDEN"
    || code === "INVALID_ACTOR"
    || code === "PRODUCT_NOT_FOUND"
    || code === "PRODUCT_ID_REQUIRED"
    || code === "PRICE_INVALID"
    || code === "EXPECTED_PRICE_REQUIRED"
    || code === "EXPECTED_PRICE_INVALID"
    || code === "EXPECTED_VERSION_REQUIRED"
    || code === "EXPECTED_VERSION_INVALID"
    || code === "DATA_PRICE_INVALID"
    || code === "DATA_VERSION_INVALID"
    || code === "DATA_VERSION_CONFLICT"
    || code === "REASON_INVALID"
    || /^IDEMPOTENCY_/.test(code);
  if (!allowed) return error;
  const statusCode = Number(error.statusCode) || (
    code === "FORBIDDEN" || code === "INVALID_ACTOR" ? 403
      : code === "PRODUCT_NOT_FOUND" ? 404
        : ["DATA_PRICE_INVALID", "DATA_VERSION_INVALID", "DATA_VERSION_CONFLICT", "IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409
          : 400
  );
  const corruptData = code === "DATA_PRICE_INVALID" || code === "DATA_VERSION_INVALID";
  const safeMessage = code === "DATA_PRICE_INVALID"
    ? "商品售价数据异常，暂不能修改"
    : code === "DATA_VERSION_INVALID"
      ? "商品数据版本异常，暂不能修改"
      : cleanString(error.message, 240) || "商品改价失败";
  return new ApiError(code, safeMessage, statusCode, corruptData ? undefined : error.details);
}

function productPriceMutationResult(result = {}, requestId = "") {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "商品改价结果无效", 502);
  }
  const id = typeof result.productId === "string" ? result.productId.trim() : "";
  const version = result.version;
  const afterPrice = result.afterPrice;
  if (!id
    || id.length > 128
    || typeof afterPrice !== "number"
    || !Number.isSafeInteger(afterPrice)
    || afterPrice < 0
    || typeof version !== "number"
    || !Number.isSafeInteger(version)
    || version < 0
    || typeof result.changed !== "boolean"
    || typeof result.isActive !== "boolean") {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "商品改价结果无效", 502);
  }
  const status = result.status === "draft"
    ? "draft"
    : result.isActive === false || result.status === "inactive" ? "inactive" : "active";
  return {
    item: {
      id,
      salePriceCents: afterPrice,
      status,
      version,
      updatedAt: dateValue(result.updatedAt)
    },
    affected: result.changed === false ? 0 : 1,
    message: result.changed === false ? "商品售价未重复写入" : "商品售价已更新",
    requestId
  };
}

function productStatusRoute(route = {}) {
  return route.resource === "products" && route.mutationAction === "toggle-status";
}

function orderReviewRoute(route = {}) {
  return route.resource === "orders" && (route.mutationAction === "review" || route.mutationAction === "reject");
}

function normalizeOrderReviewMutation(request = {}) {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  const allowed = new Set(["id", "expectedVersion", "expectedStatus", "reason"]);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) throw new ApiError("INVALID_REQUEST_BODY", "订单审核请求包含不允许的字段", 400);
  const id = cleanString(body.id, 128);
  if (!id) throw new ApiError("ORDER_ID_REQUIRED", "缺少订单 ID", 400);
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new ApiError("EXPECTED_VERSION_REQUIRED", "缺少订单版本，请刷新后重试", 400);
  }
  const expectedStatus = cleanString(body.expectedStatus, 60);
  if (!["pending_admin", "auto_reviewing"].includes(expectedStatus)) throw new ApiError("EXPECTED_STATUS_INVALID", "订单当前状态无效", 400);
  const reason = body.reason === undefined ? "" : cleanString(body.reason, 300);
  if (body.reason !== undefined && typeof body.reason !== "string") throw new ApiError("REASON_INVALID", "审核原因格式无效", 400);
  if (request.route.mutationAction === "reject" && !reason) throw new ApiError("REASON_REQUIRED", "请填写驳回原因", 400);
  return {
    idempotencyKey: request.headers && (request.headers["idempotency-key"] || request.headers["Idempotency-Key"]),
    input: { id, decision: request.route.mutationAction === "reject" ? "reject" : "approve", expectedVersion: body.expectedVersion, expectedStatus, reason }
  };
}

function orderReviewActor(auth = {}) {
  return inventoryWarningActor(auth);
}

function orderReviewApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80) || "ORDER_REVIEW_FAILED";
  const allowed = new Set(["FORBIDDEN", "INVALID_ACTOR", "ORDER_NOT_FOUND", "ORDER_ID_REQUIRED", "DECISION_INVALID", "EXPECTED_VERSION_REQUIRED", "EXPECTED_VERSION_INVALID", "EXPECTED_STATUS_REQUIRED", "EXPECTED_STATUS_INVALID", "DATA_VERSION_CONFLICT", "DATA_VERSION_INVALID", "ORDER_ITEMS_REQUIRED", "ORDER_ITEMS_LIMIT_EXCEEDED", "ORDER_ITEM_INVALID", "ORDER_ITEM_QUANTITY_INVALID", "ORDER_AMOUNT_INVALID", "ACCOUNT_AMOUNT_INVALID", "PRODUCT_NOT_FOUND", "PRODUCT_INACTIVE", "PRODUCT_SALES_INVALID", "INSUFFICIENT_STOCK", "INVENTORY_LOG_CONFLICT", "INVENTORY_LOG_DUPLICATE", "ACCOUNT_LOG_CONFLICT", "ACCOUNT_LOG_DUPLICATE", "ORDER_ACCOUNT_STATE_CONFLICT", "ORDER_STATUS_INVALID", "ORDER_ALREADY_APPROVED", "SYNC_OWNER_CONFIG_REQUIRED", "REASON_REQUIRED", "REASON_INVALID", "IDEMPOTENCY_KEY_REQUIRED", "IDEMPOTENCY_KEY_INVALID", "IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"]);
  if (!allowed.has(code) && !/^IDEMPOTENCY_/.test(code)) return new ApiError("ORDER_REVIEW_FAILED", "订单审核失败", 500);
  const status = Number(error && error.statusCode) || (code === "FORBIDDEN" || code === "INVALID_ACTOR" ? 403 : code === "ORDER_NOT_FOUND" ? 404 : code === "SYNC_OWNER_CONFIG_REQUIRED" ? 503 : ["DATA_VERSION_CONFLICT", "ORDER_STATUS_INVALID", "ORDER_ALREADY_APPROVED", "INSUFFICIENT_STOCK", "INVENTORY_LOG_CONFLICT", "INVENTORY_LOG_DUPLICATE", "ACCOUNT_LOG_CONFLICT", "ACCOUNT_LOG_DUPLICATE", "ORDER_ACCOUNT_STATE_CONFLICT", "ACCOUNT_AMOUNT_INVALID", "PRODUCT_SALES_INVALID", "IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400);
  const safeMessages = {
    ACCOUNT_LOG_DUPLICATE: "订单账款流水重复，暂不能审核",
    ACCOUNT_LOG_CONFLICT: "订单账款流水不一致，暂不能审核",
    ORDER_ACCOUNT_STATE_CONFLICT: "订单审核与账款状态不一致，请刷新后处理",
    INVENTORY_LOG_DUPLICATE: "订单库存流水重复，暂不能审核",
    SYNC_OWNER_CONFIG_REQUIRED: "订单同步安全配置不完整"
  };
  return new ApiError(code, safeMessages[code] || cleanString(error && error.message, 240) || "订单审核失败", status);
}

function orderReviewMutationResult(result = {}, requestId = "") {
  const item = result && result.item;
  if (result.accountRecalculationPending === true) {
    const safeResult = orderReviewMutationResult({ ...result, accountRecalculationPending: false, warning: undefined }, requestId);
    return { ...safeResult, accountRecalculationPending: true, warning: "订单已审核，客户账款汇总将在稍后更新" };
  }
  if (!item || typeof item.id !== "string" || !item.id || typeof item.status !== "string" || typeof item.version !== "number" || !Number.isSafeInteger(item.version)) throw new ApiError("INVALID_SERVICE_RESPONSE", "订单审核结果无效", 502);
  return { item: { id: item.id, orderNo: cleanString(item.orderNo, 100), status: item.status, reviewType: cleanString(item.reviewType, 40), paymentStatus: cleanString(item.paymentStatus, 60), version: item.version, updatedAt: dateValue(item.updatedAt) }, affected: result.affected === 1 ? 1 : 0, reused: result.reused === true, decision: result.decision === "reject" ? "reject" : "approve", message: result.decision === "reject" ? "订单已驳回" : "订单已审核通过", requestId };
}

function productBatchEnableRoute(route = {}) {
  return route.resource === "products" && route.mutationAction === "batch-enable";
}

function productBatchTagsRoute(route = {}) {
  return route.resource === "products" && route.mutationAction === "batch-tags";
}

function assertProductBatchTagsBodyFields(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST_BODY", "请求内容无效", 400);
  }
  const rejected = Object.keys(body).find((key) => !PRODUCT_BATCH_TAG_BODY_FIELDS.has(key));
  if (rejected) throw new ApiError("INVALID_REQUEST_BODY", "请求包含不允许的字段", 400);
}

function normalizeProductBatchTagsMutation(request = {}) {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  assertProductBatchTagsBodyFields(body);
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(request.headers && request.headers["idempotency-key"]);
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
  }
  if (body.scope !== "public") {
    throw new ApiError("TAG_SCOPE_INVALID", "仅支持修改公开商品标签", 400);
  }
  if (typeof body.tag !== "string" || !PRODUCT_BATCH_TAGS.has(body.tag.trim())) {
    throw new ApiError("PUBLIC_TAG_INVALID", "公开商品标签无效", 400);
  }
  if (typeof body.present !== "boolean") {
    throw new ApiError("TAG_PRESENT_INVALID", "标签目标状态必须是布尔值", 400);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new ApiError("BATCH_ITEMS_REQUIRED", "请至少选择一个商品", 400);
  }
  if (body.items.length > 100) {
    throw new ApiError("BATCH_SIZE_EXCEEDED", "单次最多修改 100 个商品", 400);
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim().length > 120)) {
    throw new ApiError("INVALID_REQUEST_BODY", "操作说明格式无效", 400);
  }

  const itemsById = new Map();
  for (const rawItem of body.items) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw new ApiError("BATCH_ITEM_INVALID", "批量商品快照无效，请刷新后重试", 400);
    }
    const rejected = Object.keys(rawItem).find((key) => !PRODUCT_BATCH_TAG_ITEM_FIELDS.has(key));
    if (rejected) throw new ApiError("BATCH_ITEM_INVALID", "批量商品快照包含不允许的字段", 400);
    if (typeof rawItem.id !== "string" || !rawItem.id.trim() || rawItem.id.trim().length > 128) {
      throw new ApiError("PRODUCT_ID_REQUIRED", "批量商品缺少有效 ID", 400);
    }
    if (typeof rawItem.expectedVersion !== "number"
      || !Number.isSafeInteger(rawItem.expectedVersion)
      || rawItem.expectedVersion < 0) {
      throw new ApiError("EXPECTED_VERSION_INVALID", "批量商品数据版本无效，请刷新后重试", 400);
    }
    if (typeof rawItem.expectedPresent !== "boolean") {
      throw new ApiError("EXPECTED_PRESENT_INVALID", "批量商品当前标签状态无效，请刷新后重试", 400);
    }
    const item = {
      id: rawItem.id.trim(),
      expectedVersion: rawItem.expectedVersion,
      expectedPresent: rawItem.expectedPresent
    };
    const existing = itemsById.get(item.id);
    if (existing
      && (existing.expectedVersion !== item.expectedVersion
        || existing.expectedPresent !== item.expectedPresent)) {
      throw new ApiError("DUPLICATE_ITEM_CONFLICT", "同一商品存在冲突快照，请刷新后重试", 400);
    }
    if (!existing) itemsById.set(item.id, item);
  }
  return {
    idempotencyKey,
    input: {
      scope: "public",
      tag: body.tag.trim(),
      present: body.present,
      items: Array.from(itemsById.values()),
      reason: body.reason === undefined ? "" : body.reason.trim()
    }
  };
}

function productTagActor(auth = {}) {
  return inventoryWarningActor(auth);
}

function productTagApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80);
  const allowed = code === "FORBIDDEN"
    || code === "INVALID_ACTOR"
    || code === "PRODUCT_NOT_FOUND"
    || code === "PRODUCT_ID_REQUIRED"
    || code === "TAG_SCOPE_INVALID"
    || code === "TAG_INVALID"
    || code === "PUBLIC_TAG_INVALID"
    || code === "TAG_PRESENT_INVALID"
    || code === "BATCH_ITEMS_REQUIRED"
    || code === "BATCH_ITEM_INVALID"
    || code === "BATCH_SIZE_EXCEEDED"
    || code === "BATCH_LIMIT_EXCEEDED"
    || code === "BATCH_ITEM_CONFLICT"
    || code === "DUPLICATE_ITEM_CONFLICT"
    || code === "EXPECTED_VERSION_REQUIRED"
    || code === "EXPECTED_VERSION_INVALID"
    || code === "EXPECTED_PRESENT_REQUIRED"
    || code === "EXPECTED_PRESENT_INVALID"
    || code === "DATA_VERSION_CONFLICT"
    || code === "DATA_VERSION_INVALID"
    || code === "DATA_INTERNAL_TAGS_INVALID"
    || code === "REASON_INVALID"
    || /^IDEMPOTENCY_/.test(code);
  if (!allowed) {
    return new ApiError("PRODUCT_TAG_SERVICE_UNAVAILABLE", "商品标签服务暂时不可用", 502);
  }
  const statusCode = code === "FORBIDDEN" || code === "INVALID_ACTOR" ? 403
    : code === "PRODUCT_NOT_FOUND" ? 404
      : [
        "DATA_VERSION_CONFLICT",
        "DATA_VERSION_INVALID",
        "DATA_INTERNAL_TAGS_INVALID",
        "IDEMPOTENCY_KEY_CONFLICT",
        "IDEMPOTENCY_PROCESSING"
      ].includes(code) ? 409 : 400;
  const safeMessages = {
    DATA_VERSION_CONFLICT: "记录已变化，请刷新后重新确认",
    DATA_VERSION_INVALID: "商品数据版本异常，暂不能修改",
    DATA_INTERNAL_TAGS_INVALID: "商品内部标签数据异常，暂不能修改",
    BATCH_LIMIT_EXCEEDED: "单次最多修改 100 个商品",
    BATCH_ITEM_CONFLICT: "同一商品存在冲突快照，请刷新后重试"
  };
  return new ApiError(code, safeMessages[code] || cleanString(error.message, 240) || "批量修改商品标签失败", statusCode);
}

function productBatchTagsMutationResult(result = {}, requestId = "", expectedItems = []) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "批量商品标签结果无效", 502);
  }
  const countFields = ["changedCount", "unchangedCount", "failedCount", "warningCount"];
  if (countFields.some((field) => typeof result[field] !== "number"
    || !Number.isSafeInteger(result[field])
    || result[field] < 0)) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "批量商品标签结果无效", 502);
  }
  if (!Array.isArray(result.failures) || result.failures.length !== result.failedCount) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "批量商品标签结果无效", 502);
  }
  const expectedIds = new Set(Array.isArray(expectedItems) ? expectedItems.map((item) => item && item.id) : []);
  const totalCount = result.changedCount + result.unchangedCount + result.failedCount;
  if (expectedIds.size < 1
    || expectedIds.size > 100
    || totalCount !== expectedIds.size
    || result.warningCount > result.changedCount + result.unchangedCount) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "批量商品标签结果无效", 502);
  }
  const failureIds = new Set();
  const failures = result.failures.map((failure) => {
    const id = failure && typeof failure.id === "string" ? failure.id.trim() : "";
    const code = failure && typeof failure.code === "string" ? failure.code.trim() : "";
    if (!id
      || id.length > 128
      || !expectedIds.has(id)
      || !PRODUCT_TAG_FAILURE_CODES.has(code)
      || failureIds.has(id)) {
      throw new ApiError("INVALID_SERVICE_RESPONSE", "批量商品标签结果无效", 502);
    }
    failureIds.add(id);
    return { id, code };
  });
  const message = result.failedCount > 0
    ? `已更新 ${result.changedCount} 个商品，${result.failedCount} 个未处理`
    : result.changedCount > 0
      ? `已更新 ${result.changedCount} 个商品`
      : "所选商品标签状态未变化";
  return {
    affected: result.changedCount,
    changedCount: result.changedCount,
    unchangedCount: result.unchangedCount,
    failedCount: result.failedCount,
    failures,
    message,
    requestId
  };
}

function assertProductBatchEnableBodyFields(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST_BODY", "请求内容无效", 400);
  }
  const rejected = Object.keys(body).find((key) => !PRODUCT_BATCH_ENABLE_BODY_FIELDS.has(key));
  if (rejected) throw new ApiError("INVALID_REQUEST_BODY", "请求包含不允许的字段", 400);
}

function normalizeProductBatchEnableMutation(request = {}) {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  assertProductBatchEnableBodyFields(body);
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(request.headers && request.headers["idempotency-key"]);
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
  }
  if (body.isActive !== true) {
    throw new ApiError("BATCH_TARGET_INVALID", "批量上架目标状态必须为 true", 400);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new ApiError("BATCH_ITEMS_REQUIRED", "请至少选择一个商品", 400);
  }
  if (body.items.length > 100) {
    throw new ApiError("BATCH_SIZE_EXCEEDED", "单次最多上架 100 个商品", 400);
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim().length > 120)) {
    throw new ApiError("INVALID_REQUEST_BODY", "操作说明格式无效", 400);
  }

  const deduplicated = new Map();
  for (const rawItem of body.items) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      throw new ApiError("BATCH_ITEM_INVALID", "批量商品快照无效，请刷新后重试", 400);
    }
    const rejected = Object.keys(rawItem).find((key) => !PRODUCT_BATCH_ENABLE_ITEM_FIELDS.has(key));
    if (rejected) throw new ApiError("BATCH_ITEM_INVALID", "批量商品快照包含不允许的字段", 400);
    if (typeof rawItem.id !== "string" || !rawItem.id.trim() || rawItem.id.trim().length > 128) {
      throw new ApiError("PRODUCT_ID_REQUIRED", "批量商品缺少有效 ID", 400);
    }
    if (typeof rawItem.expectedIsActive !== "boolean") {
      throw new ApiError("EXPECTED_STATUS_INVALID", "批量商品当前状态无效，请刷新后重试", 400);
    }
    if (typeof rawItem.expectedVersion !== "number"
      || !Number.isSafeInteger(rawItem.expectedVersion)
      || rawItem.expectedVersion < 0) {
      throw new ApiError("EXPECTED_VERSION_INVALID", "批量商品数据版本无效，请刷新后重试", 400);
    }
    const item = {
      id: rawItem.id.trim(),
      expectedIsActive: rawItem.expectedIsActive,
      expectedVersion: rawItem.expectedVersion
    };
    const existing = deduplicated.get(item.id);
    if (existing
      && (existing.expectedIsActive !== item.expectedIsActive
        || existing.expectedVersion !== item.expectedVersion)) {
      throw new ApiError("DUPLICATE_ITEM_CONFLICT", "同一商品存在冲突快照，请刷新后重试", 400);
    }
    if (!existing) deduplicated.set(item.id, item);
  }
  const items = Array.from(deduplicated.values());
  if (items.length > 100) {
    throw new ApiError("BATCH_SIZE_EXCEEDED", "单次最多上架 100 个商品", 400);
  }
  return {
    idempotencyKey,
    input: {
      isActive: true,
      items,
      reason: body.reason === undefined ? "" : body.reason.trim()
    }
  };
}

function assertProductStatusBodyFields(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST_BODY", "请求内容无效", 400);
  }
  const rejected = Object.keys(body).find((key) => !PRODUCT_STATUS_BODY_FIELDS.has(key));
  if (rejected) throw new ApiError("INVALID_REQUEST_BODY", "请求包含不允许的字段", 400);
}

function normalizeProductStatusMutation(request = {}) {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  assertProductStatusBodyFields(body);
  let idempotencyKey;
  try {
    idempotencyKey = inventoryWarningIdempotency.assertIdempotencyKey(request.headers && request.headers["idempotency-key"]);
  } catch (error) {
    throw new ApiError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
  }
  if (typeof body.id !== "string" || !body.id.trim() || body.id.trim().length > 128) {
    throw new ApiError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  }
  if (typeof body.isActive !== "boolean") {
    throw new ApiError("STATUS_INVALID", "上下架状态必须是布尔值", 400);
  }
  if (body.expectedIsActive === undefined) {
    throw new ApiError("EXPECTED_STATUS_REQUIRED", "缺少当前上下架状态，请刷新后重试", 400);
  }
  if (typeof body.expectedIsActive !== "boolean") {
    throw new ApiError("EXPECTED_STATUS_INVALID", "当前上下架状态无效，请刷新后重试", 400);
  }
  if (body.expectedVersion === undefined) {
    throw new ApiError("EXPECTED_VERSION_REQUIRED", "缺少数据版本，请刷新后重试", 400);
  }
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw new ApiError("EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim().length > 120)) {
    throw new ApiError("INVALID_REQUEST_BODY", "操作说明格式无效", 400);
  }
  return {
    idempotencyKey,
    input: {
      productId: body.id.trim(),
      isActive: body.isActive,
      expectedIsActive: body.expectedIsActive,
      expectedVersion: body.expectedVersion,
      reason: body.reason === undefined ? "" : body.reason.trim()
    }
  };
}

function productStatusActor(auth = {}) {
  return inventoryWarningActor(auth);
}

function productStatusApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80);
  const allowed = code === "FORBIDDEN"
    || code === "INVALID_ACTOR"
    || code === "PRODUCT_NOT_FOUND"
    || code === "PRODUCT_ID_REQUIRED"
    || code === "STATUS_INVALID"
    || code === "EXPECTED_STATUS_REQUIRED"
    || code === "EXPECTED_STATUS_INVALID"
    || code === "EXPECTED_VERSION_REQUIRED"
    || code === "EXPECTED_VERSION_INVALID"
    || code === "DATA_STATUS_INVALID"
    || code === "DATA_VERSION_INVALID"
    || code === "DATA_VERSION_CONFLICT"
    || code === "REASON_INVALID"
    || /^IDEMPOTENCY_/.test(code);
  if (!allowed) return error;
  const statusCode = Number(error.statusCode) || (
    code === "FORBIDDEN" || code === "INVALID_ACTOR" ? 403
      : code === "PRODUCT_NOT_FOUND" ? 404
        : ["DATA_STATUS_INVALID", "DATA_VERSION_INVALID", "DATA_VERSION_CONFLICT", "IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409
          : 400
  );
  const corruptData = code === "DATA_STATUS_INVALID" || code === "DATA_VERSION_INVALID";
  const safeMessage = code === "DATA_STATUS_INVALID"
    ? "商品上下架状态异常，暂不能修改"
    : code === "DATA_VERSION_INVALID"
      ? "商品数据版本异常，暂不能修改"
      : cleanString(error.message, 240) || "商品上下架操作失败";
  return new ApiError(code, safeMessage, statusCode, corruptData ? undefined : error.details);
}

function productStatusMutationResult(result = {}, requestId = "") {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "商品上下架结果无效", 502);
  }
  const id = typeof result.productId === "string" ? result.productId.trim() : "";
  const version = result.version;
  if (!id
    || id.length > 128
    || typeof result.isActive !== "boolean"
    || typeof version !== "number"
    || !Number.isSafeInteger(version)
    || version < 0
    || typeof result.changed !== "boolean") {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "商品上下架结果无效", 502);
  }
  const status = result.isActive === false ? "inactive" : result.status === "draft" ? "draft" : "active";
  return {
    item: {
      id,
      status,
      isActive: result.isActive,
      version,
      updatedAt: dateValue(result.updatedAt)
    },
    affected: result.changed === false ? 0 : 1,
    message: result.changed === false
      ? "商品上下架状态未重复写入"
      : result.isActive ? "商品已上架" : "商品已下架",
    requestId
  };
}

function productBatchEnableApiError(error) {
  if (error instanceof ApiError) return error;
  const code = cleanString(error && error.code, 80);
  const allowed = code === "FORBIDDEN"
    || code === "INVALID_ACTOR"
    || code === "STATUS_INVALID"
    || code === "BATCH_TARGET_INVALID"
    || code === "BATCH_ITEMS_REQUIRED"
    || code === "BATCH_ITEM_INVALID"
    || code === "BATCH_SIZE_EXCEEDED"
    || code === "BATCH_LIMIT_EXCEEDED"
    || code === "BATCH_ITEM_CONFLICT"
    || code === "DUPLICATE_ITEM_CONFLICT"
    || code === "PRODUCT_ID_REQUIRED"
    || code === "EXPECTED_STATUS_INVALID"
    || code === "EXPECTED_VERSION_INVALID"
    || code === "REASON_INVALID"
    || /^IDEMPOTENCY_/.test(code);
  if (!allowed) return error;
  const statusCode = Number(error.statusCode) || (
    code === "FORBIDDEN" || code === "INVALID_ACTOR" ? 403
      : ["IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409
        : 400
  );
  const safeMessages = {
    STATUS_INVALID: "批量上架目标状态无效",
    BATCH_TARGET_INVALID: "批量上架目标状态无效",
    BATCH_ITEMS_REQUIRED: "请至少选择一个商品",
    BATCH_ITEM_INVALID: "批量商品快照无效，请刷新后重试",
    BATCH_SIZE_EXCEEDED: "单次最多上架 100 个商品",
    BATCH_LIMIT_EXCEEDED: "单次最多上架 100 个商品",
    BATCH_ITEM_CONFLICT: "同一商品存在冲突快照，请刷新后重试",
    DUPLICATE_ITEM_CONFLICT: "同一商品存在冲突快照，请刷新后重试"
  };
  return new ApiError(code, safeMessages[code] || cleanString(error.message, 240) || "批量上架失败", statusCode);
}

function productBatchEnableMutationResult(result = {}, requestId = "", expectedItems = []) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "批量上架结果无效", 502);
  }
  const countFields = ["changedCount", "unchangedCount", "failedCount"];
  if (countFields.some((field) => typeof result[field] !== "number"
    || !Number.isSafeInteger(result[field])
    || result[field] < 0)) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "批量上架结果无效", 502);
  }
  if (!Array.isArray(result.failures) || result.failures.length !== result.failedCount) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "批量上架结果无效", 502);
  }
  const expectedIds = new Set(Array.isArray(expectedItems) ? expectedItems.map((item) => item && item.id) : []);
  const totalCount = result.changedCount + result.unchangedCount + result.failedCount;
  if (expectedIds.size < 1 || expectedIds.size > 100 || totalCount !== expectedIds.size) {
    throw new ApiError("INVALID_SERVICE_RESPONSE", "批量上架结果无效", 502);
  }
  const failureIds = new Set();
  const failures = result.failures.map((failure) => {
    const id = failure && typeof failure.id === "string" ? failure.id.trim() : "";
    const code = failure && typeof failure.code === "string" ? failure.code.trim() : "";
    if (!id
      || id.length > 128
      || !expectedIds.has(id)
      || !/^[A-Z][A-Z0-9_]{1,79}$/.test(code)
      || failureIds.has(id)) {
      throw new ApiError("INVALID_SERVICE_RESPONSE", "批量上架结果无效", 502);
    }
    failureIds.add(id);
    return { id, code };
  });
  const message = result.failedCount > 0
    ? `已上架 ${result.changedCount} 个商品，${result.failedCount} 个未处理`
    : result.changedCount > 0
      ? `已上架 ${result.changedCount} 个商品`
      : "所选商品已处于上架状态";
  return {
    affected: result.changedCount,
    changedCount: result.changedCount,
    unchangedCount: result.unchangedCount,
    failedCount: result.failedCount,
    failures,
    message,
    requestId
  };
}

function isHttpEvent(event = {}) {
  return Boolean(event.httpMethod || event.rawPath || event.requestContext && event.requestContext.http);
}

function parseBody(event, http) {
  if (!http) {
    if (event.data && typeof event.data === "object") return event.data;
    if (event.payload && typeof event.payload === "object") return event.payload;
    return event;
  }
  if (!event.body) return {};
  if (typeof event.body === "object") return event.body;
  try {
    const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    return JSON.parse(text);
  } catch (err) {
    throw new ApiError("INVALID_JSON", "请求内容不是有效 JSON", 400);
  }
}

function actionRoute(body = {}, event = {}) {
  const action = cleanString(body.action || event.action || "", 80);
  if (["profile", "getCurrentProfile"].includes(action)) return { action: "profile" };
  if (["dashboard", "getDashboard"].includes(action)) return { action: "dashboard" };
  if (["productAnalytics", "getProductAnalytics"].includes(action)) return { action: "productAnalytics" };
  if (["list", "readList"].includes(action)) return { action: "list", resource: cleanString(body.resource || event.resource, 80).toLowerCase() };
  if (["get", "read"].includes(action)) {
    const id = cleanString(body.id || event.id, 128);
    return { action: id ? "get" : "list", resource: cleanString(body.resource || event.resource, 80).toLowerCase(), id };
  }
  if (["sync", "catchUp"].includes(action)) return { action: "sync" };
  if (["mutate", "write"].includes(action)) {
    return {
      action: "mutate",
      resource: cleanString(body.resource || event.resource, 80).toLowerCase(),
      mutationAction: cleanString(body.mutationAction || body.operation || event.mutationAction || event.operation, 100)
    };
  }
  if (action === "login") return { action: "login" };
  throw new ApiError("ROUTE_NOT_FOUND", "接口不存在", 404);
}

function buildRequest(event = {}) {
  const http = isHttpEvent(event);
  const headers = security.normalizeHeaders(event.headers || {});
  const body = parseBody(event, http);
  const method = cleanString(event.httpMethod || event.requestContext && event.requestContext.http && event.requestContext.http.method || (http ? "GET" : "ACTION"), 20).toUpperCase();
  const path = cleanString(event.rawPath || event.path || event.requestContext && event.requestContext.http && event.requestContext.http.path, 500);
  const adminApiPath = /(?:^|\/)api\/admin\/v1(?:\/|$)/.test(path.split("?")[0]);
  const route = http && method === "OPTIONS" && adminApiPath
    ? { action: "preflight" }
    : http ? parseHttpRoute(path, method) : actionRoute(body, event);
  const authorization = cleanString(headers.authorization || body.authorization, 4096);
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  const query = http
    ? { ...(event.queryStringParameters || {}) }
    : { ...(body.query && typeof body.query === "object" ? body.query : {}), ...(event.query && typeof event.query === "object" ? event.query : {}) };
  const requestId = cleanString(headers["x-request-id"], 100) || crypto.randomUUID();
  return {
    http,
    headers,
    body,
    method,
    path,
    route,
    query,
    requestId,
    origin: cleanString(headers.origin, 300),
    accessToken: bearer ? bearer[1].trim() : ""
  };
}

function assertBoundary(request, config) {
  const allowTestBypass = !config.actionSecret && config.allowInsecureActionTransport;
  if (!config.actionSecret && !allowTestBypass) {
    throw new ApiError("ACTION_SECURITY_CONFIG_REQUIRED", "Action 调用安全配置不完整", 503);
  }
  if (!allowTestBypass && config.actionSecret.length < 32) {
    throw new ApiError("ACTION_SECURITY_CONFIG_REQUIRED", "Action 调用安全配置不完整", 503);
  }
  const supplied = request.headers["x-admin-action-secret"] || "";
  if (!allowTestBypass && !security.safeSecretEqual(supplied, config.actionSecret)) {
    throw new ApiError("ACTION_CALL_FORBIDDEN", "Action 调用未授权", 403);
  }
  if (request.http && !security.isOriginAllowed(request.origin, config.allowedOrigins)) {
    throw new ApiError("ORIGIN_NOT_ALLOWED", "请求来源不受信任", 403);
  }
}

function responseHeaders(request, config) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-request-id": request.requestId
  };
  if (request.http && security.isOriginAllowed(request.origin, config.allowedOrigins)) {
    headers["access-control-allow-origin"] = request.origin;
    headers["access-control-allow-credentials"] = "true";
    headers["access-control-allow-methods"] = "GET,POST,OPTIONS";
    headers["access-control-allow-headers"] = "authorization,content-type,idempotency-key,x-admin-csrf,x-request-id";
    headers.vary = "Origin";
  }
  return headers;
}

function formatResponse(request, config, payload, statusCode = 200) {
  const headers = responseHeaders(request, config);
  if (request.http) return { statusCode, headers, body: statusCode === 204 ? "" : JSON.stringify(payload) };
  return { ...payload, statusCode, headers };
}

function normalizeMainError(err) {
  if (err instanceof ApiError) return err;
  if (err && err.statusCode === 503 && ["SECURITY_CONFIG_REQUIRED", "ACTION_SECURITY_CONFIG_REQUIRED"].includes(err.code)) {
    return new ApiError("SECURITY_CONFIG_REQUIRED", "管理员接口安全配置不完整", 503);
  }
  return err;
}

function isMissingCollection(err) {
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(String(err && err.message || err || ""));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statusCondition(resource, status) {
  if (!status) return null;
  if (resource === "products") {
    if (status === "active") return { isActive: command.neq(false) };
    if (status === "inactive") return { isActive: false };
  }
  if (["inventory", "inventory-alerts"].includes(resource)) {
    if (status === "out") return { stockStatus: "out_of_stock" };
    if (status === "low") return { stockStatus: "warning" };
    if (status === "normal") return { stockStatus: "normal" };
  }
  const policy = getResourcePolicy(resource);
  return policy.statusField ? { [policy.statusField]: status } : null;
}

function buildWhere(resource, policy, query) {
  const conditions = [];
  const status = cleanString(query.status, 60);
  const statusWhere = statusCondition(resource, status);
  if (statusWhere) conditions.push(statusWhere);
  if (resource === "inventory-alerts" && !status) {
    conditions.push({ stockStatus: command.in(["warning", "out_of_stock"]) });
  }
  const search = cleanString(query.search, 100);
  if (search && policy.searchFields && policy.searchFields.length) {
    const regex = db.RegExp({ regexp: escapeRegExp(search), options: "i" });
    conditions.push(command.or(policy.searchFields.map((field) => ({ [field]: regex }))));
  }
  if (!conditions.length) return null;
  return conditions.length === 1 ? conditions[0] : command.and(conditions);
}

async function listCollection(resource, policy, query, principal) {
  const pagination = normalizePagination(query);
  const where = buildWhere(resource, policy, query);
  let collection = db.collection(policy.collection);
  let countQuery = collection;
  if (where) {
    collection = collection.where(where);
    countQuery = countQuery.where(where);
  }
  const totalResult = await countQuery.count().catch(() => ({ total: 0 }));
  let request = collection;
  if (policy.sortField) request = request.orderBy(policy.sortField, query.sort === "asc" ? "asc" : "desc");
  const result = await request.skip(pagination.skip).limit(pagination.pageSize + 1).get();
  const hasMore = result.data.length > pagination.pageSize;
  const rows = result.data.slice(0, pagination.pageSize).map((row) => projectResource(resource, row, principal, false));
  return {
    items: rows,
    total: Number(totalResult.total || 0),
    page: pagination.page,
    pageSize: pagination.pageSize,
    nextCursor: hasMore ? encodeCursor(pagination.page + 1) : null
  };
}

async function safeCount(collectionName, where) {
  try {
    let query = db.collection(collectionName);
    if (where) query = query.where(where);
    const result = await query.count();
    return Number(result.total || 0);
  } catch (err) {
    if (isMissingCollection(err)) return 0;
    throw err;
  }
}

async function readDashboard(principal) {
  const summary = {};
  const tasks = [];
  if (hasPermission(principal, "dashboard:view_product") || hasPermission(principal, "product:view")) {
    tasks.push(safeCount("products", { isActive: command.neq(false) }).then((value) => { summary.productCount = value; }));
  }
  if (hasPermission(principal, "dashboard:view_inventory") || hasPermission(principal, "inventory:view")) {
    tasks.push(safeCount("products", { stockStatus: command.in(["warning", "out_of_stock"]) }).then((value) => { summary.inventoryAlertCount = value; }));
  }
  if (hasPermission(principal, "inventory:import")) {
    tasks.push(safeCount("import_records", { status: command.in(["pending", "pending_confirm", "validated", "ready"]) }).then((value) => { summary.pendingImportCount = value; }));
  }
  if (hasPermission(principal, "order:view")) {
    tasks.push(safeCount("orders", { status: command.in(["pending_admin", "auto_reviewing"]) }).then((value) => { summary.pendingOrderCount = value; }));
  }
  if (hasPermission(principal, "payment:view_screenshot")) {
    tasks.push(safeCount("payment_records", { paymentStatus: "pending_confirm" }).then((value) => { summary.pendingPaymentCount = value; }));
  }
  if (hasPermission(principal, "shipment:view")) {
    tasks.push(safeCount("shipment_groups", { shippingStatus: command.in(["pending", "pending_shipment", "ready"]) }).then((value) => { summary.pendingShipmentCount = value; }));
  }
  if (hasPermission(principal, "after_sale:view")) {
    tasks.push(safeCount("after_sales", { afterSaleStatus: "pending_review" }).then((value) => { summary.pendingAfterSaleCount = value; }));
  }
  if (hasPermission(principal, "refund:view")) {
    tasks.push(safeCount("refund_records", { refundStatus: command.in(["pending", "processing"]) }).then((value) => { summary.pendingRefundCount = value; }));
  }
  if (hasPermission(principal, "customer:view_account")) {
    tasks.push(safeCount("customer_accounts").then((value) => { summary.accountCount = value; }));
  }
  if (hasPermission(principal, "product:view")) {
    tasks.push(db.collection("products").orderBy("totalSales", "desc").limit(8).get()
      .then((result) => {
        summary.topProducts = (result.data || []).map((row) => ({
          name: cleanString(row.name || row.productName, 160),
          sku: cleanString(row.sku || row.productCode, 80),
          value: Math.max(0, Number(row.totalSales || 0)),
          change: 0
        })).filter((row) => row.name && row.sku && row.value > 0);
      })
      .catch((err) => {
        if (isMissingCollection(err)) summary.topProducts = [];
        else throw err;
      }));
  }
  await Promise.all(tasks);
  return buildDashboardData(summary, principal);
}

function analyticsApiError(err) {
  if (err instanceof ApiError) return err;
  const code = cleanString(err && err.code, 80);
  if (code === "ANALYTICS_RANGE_INVALID") {
    return new ApiError(code, "分析范围仅支持 7d、30d 或 90d", 400);
  }
  if (code === "ANALYTICS_DATA_INVALID") {
    return new ApiError(code, "商品分析源数据异常，暂不能生成统计", 422);
  }
  if (code === "ANALYTICS_SOURCE_UNAVAILABLE") {
    return new ApiError(code, "商品分析数据源暂不可用", 503);
  }
  return err;
}

function analyticsInteger(value, options = {}) {
  if (value === null || value === undefined) {
    if (options.nullable) return null;
    throw new ApiError("ANALYTICS_SOURCE_UNAVAILABLE", "商品分析返回结构无效", 503);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ApiError("ANALYTICS_SOURCE_UNAVAILABLE", "商品分析返回结构无效", 503);
  }
  if (options.nonNegative && value < 0) {
    throw new ApiError("ANALYTICS_SOURCE_UNAVAILABLE", "商品分析返回结构无效", 503);
  }
  return value;
}

function analyticsChange(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError("ANALYTICS_SOURCE_UNAVAILABLE", "商品分析返回结构无效", 503);
  }
  return value;
}

function analyticsArray(value, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new ApiError("ANALYTICS_SOURCE_UNAVAILABLE", "商品分析返回结构无效", 503);
  }
  return value;
}

function analyticsUpdatedAt(value) {
  const updatedAt = dateValue(value);
  if (!updatedAt) {
    throw new ApiError("ANALYTICS_SOURCE_UNAVAILABLE", "商品分析返回结构无效", 503);
  }
  return updatedAt;
}

function projectProductAnalytics(raw = {}, principal = {}) {
  const status = raw.status === "available" ? "available" : raw.status === "empty" ? "empty" : null;
  if (!status) throw new ApiError("ANALYTICS_SOURCE_UNAVAILABLE", "商品分析返回结构无效", 503);
  const summary = raw.summary && typeof raw.summary === "object" ? raw.summary : {};
  const changes = summary.changes && typeof summary.changes === "object" ? summary.changes : {};
  const metrics = [
    {
      key: "salesCount",
      label: "销量",
      value: analyticsInteger(summary.salesCount, { nonNegative: true }),
      kind: "number",
      change: analyticsChange(changes.salesCount)
    },
    {
      key: "orderCount",
      label: "订单数",
      value: analyticsInteger(summary.orderCount, { nonNegative: true }),
      kind: "number",
      change: analyticsChange(changes.orderCount)
    },
    {
      key: "averagePriceCents",
      label: "加权成交均价",
      value: analyticsInteger(summary.averagePriceCents, { nullable: true, nonNegative: true }),
      kind: "money",
      change: analyticsChange(changes.averagePriceCents)
    }
  ];
  if (principal.role === "super_admin") {
    metrics.splice(1, 0, {
      key: "salesAmountCents",
      label: "销售额",
      value: analyticsInteger(summary.salesAmountCents, { nonNegative: true }),
      kind: "money",
      change: analyticsChange(changes.salesAmountCents)
    });
  }
  const canViewInventory = hasPermission(principal, "inventory:view");
  const series = analyticsArray(raw.series, 90).map((row) => ({
    date: cleanString(row && row.date, 10),
    salesCount: analyticsInteger(row && row.salesCount, { nonNegative: true }),
    averagePriceCents: analyticsInteger(row && row.averagePriceCents, { nullable: true, nonNegative: true }),
    quotePriceCents: analyticsInteger(row && row.quotePriceCents, { nullable: true, nonNegative: true }),
    inventoryChange: canViewInventory
      ? analyticsInteger(row && row.inventoryChange)
      : null
  }));
  const ranking = analyticsArray(raw.ranking, 20).map((row) => ({
    id: cleanString(row && row.id, 128),
    name: cleanString(row && row.name, 160),
    sku: cleanString(row && row.sku, 80),
    salesCount: analyticsInteger(row && row.salesCount, { nonNegative: true }),
    averagePriceCents: analyticsInteger(row && row.averagePriceCents, { nullable: true, nonNegative: true }),
    currentPriceCents: analyticsInteger(row && row.currentPriceCents, { nullable: true, nonNegative: true }),
    change: analyticsChange(row && row.change)
  }));
  return {
    range: cleanString(raw.range, 10),
    status,
    message: cleanString(raw.message, 400),
    summary: metrics,
    series: status === "empty" ? [] : series,
    ranking: status === "empty" ? [] : ranking,
    updatedAt: analyticsUpdatedAt(raw.updatedAt)
  };
}

async function readProductAnalytics(query, principal, service = defaultProductAnalyticsService) {
  if (!principal || !["procurement", "super_admin"].includes(principal.role)) {
    throw new ApiError("FORBIDDEN", "无权访问商品分析", 403);
  }
  assertPermission(principal, "product:analytics:view");
  try {
    const raw = await service.getOverview({
      ...(query && Object.hasOwn(query, "range") ? { range: query.range } : {})
    });
    return projectProductAnalytics(raw, principal);
  } catch (err) {
    throw analyticsApiError(err);
  }
}

async function listResource(resource, query, principal) {
  const policy = getResourcePolicy(resource);
  assertPermission(principal, policy.permission);
  if (resource === "dashboard") {
    const item = await readDashboard(principal);
    return { items: [item], total: 1, page: 1, pageSize: 20, nextCursor: null };
  }
  if (resource === "orders") {
    try {
      return await defaultOrderQueryService.listWebOrders({ principal, query });
    } catch (error) {
      throw orderQueryApiError(error);
    }
  }
  if (resource === "shipments") return readWebShipmentList(query, principal);
  if (resource === "accounts") return readWebAccountList(query, principal);
  if (resource === "payments") return readWebPaymentList(query, principal);
  if (policy.fixedDocumentId) {
    throw new ApiError("RESOURCE_ID_REQUIRED", "请使用固定资源 ID 读取该资源", 400);
  }
  try {
    return await listCollection(resource, policy, query, principal);
  } catch (err) {
    if (isMissingCollection(err)) return { items: [], total: 0, page: 1, pageSize: normalizePagination(query).pageSize, nextCursor: null };
    throw err;
  }
}

async function getResource(resource, id, principal) {
  const policy = getResourcePolicy(resource);
  assertPermission(principal, policy.permission);
  if (resource === "dashboard") return readDashboard(principal);
  if (resource === "orders") {
    try {
      return await defaultOrderQueryService.getWebOrder({ principal, id });
    } catch (error) {
      throw orderQueryApiError(error);
    }
  }
  if (resource === "shipments") return readWebShipmentDetail(id, principal);
  if (resource === "accounts") return readWebAccountDetail(id, principal);
  if (resource === "payments") return readWebPaymentDetail(id, principal);
  if (!id) throw new ApiError("RESOURCE_ID_REQUIRED", "缺少资源 ID", 400);
  const documentId = resolveResourceDocumentId(resource, id);
  try {
    const result = await db.collection(policy.collection).doc(documentId).get();
    if (!result.data) throw new ApiError("NOT_FOUND", "记录不存在", 404);
    if (resource === "inventory-alerts" && stockStatus(result.data) === "normal") throw new ApiError("NOT_FOUND", "库存预警不存在", 404);
    return projectResource(resource, result.data, principal, true);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (isMissingCollection(err)) throw new ApiError("NOT_FOUND", "记录不存在", 404);
    throw err;
  }
}

async function readSyncEvents(query, principal) {
  try {
    return await readSyncBatch({
      db,
      command,
      principal: { ...principal, kind: "admin" },
      cursor: cleanString(query.cursor, 8192),
      topics: query.topics || query.entityTypes || "",
      limit: query.limit,
      cursorSecret: process.env.SYNC_CURSOR_SECRET || process.env.ADMIN_WEB_TOKEN_PEPPER,
      fallbackClient: "admin_web"
    });
  } catch (err) {
    if (err && err.code === "INVALID_SYNC_CURSOR") {
      throw new ApiError("INVALID_SYNC_CURSOR", "同步游标无效", 400);
    }
    if (err && err.code === "SYNC_CURSOR_CONFIG_REQUIRED") {
      throw new ApiError("SYNC_CURSOR_CONFIG_REQUIRED", "同步安全配置不完整", 503);
    }
    throw err;
  }
}

async function dispatch(request, auth, config, dependencies = {}) {
  const { route } = request;
  if (route.action === "profile") return publicProfile(auth.principal, auth.rawAdmin, auth.session);
  if (route.action === "dashboard") return readDashboard(auth.principal);
  if (route.action === "productAnalytics") {
    return readProductAnalytics(
      request.query,
      auth.principal,
      dependencies.productAnalyticsService || defaultProductAnalyticsService
    );
  }
  if (route.action === "shipmentList") {
    return readWebShipmentList(
      request.query,
      auth.principal,
      dependencies.shipmentQueryService || defaultShipmentQueryService
    );
  }
  if (route.action === "shipmentDetail") {
    return readWebShipmentDetail(
      route.id,
      auth.principal,
      dependencies.shipmentQueryService || defaultShipmentQueryService
    );
  }
  if (route.action === "accountList") {
    return readWebAccountList(
      request.query,
      auth.principal,
      dependencies.accountQueryService || defaultAccountQueryService
    );
  }
  if (route.action === "accountDetail") {
    return readWebAccountDetail(
      route.id,
      auth.principal,
      dependencies.accountQueryService || defaultAccountQueryService
    );
  }
  if (route.action === "paymentList") {
    return readWebPaymentList(
      request.query,
      auth.principal,
      dependencies.paymentQueryService || defaultPaymentQueryService
    );
  }
  if (route.action === "paymentDetail") {
    return readWebPaymentDetail(
      route.id,
      auth.principal,
      dependencies.paymentQueryService || defaultPaymentQueryService
    );
  }
  if (route.action === "list") return listResource(route.resource, request.query, auth.principal);
  if (route.action === "get") return getResource(route.resource, route.id, auth.principal);
  if (route.action === "sync") return readSyncEvents(request.query, auth.principal);
  if (route.action === "mutate") {
    const permission = getMutationPermission(route.resource, route.mutationAction);
    assertPermission(auth.principal, permission);
    assertSessionCsrf({ session: auth.session, request, config });
    if (paymentMutationRoute(route)) {
      assertWebPaymentMutation(auth.principal, route.mutationAction);
      const normalized = normalizePaymentMutation(request);
      const service = dependencies.paymentMutationService || defaultPaymentMutationService;
      let result;
      try {
        result = await service.reviewWebPayment({
          actor: paymentMutationActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey
        });
      } catch (error) {
        throw paymentMutationApiError(error);
      }
      return paymentMutationResult(result, request.requestId);
    }
    if (refundMutationRoute(route)) {
      assertWebRefundMutation(auth.principal);
      const normalized = normalizeRefundMutation(request, route.mutationAction);
      const service = dependencies.refundMutationService || defaultRefundMutationService;
      let result;
      try {
        const command = {
          actor: refundMutationActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey,
          strict: true
        };
        result = route.mutationAction === "process"
          ? await service.processOfflineRefund(command)
          : await service.rejectRefund(command);
      } catch (error) {
        throw refundMutationApiError(error);
      }
      return refundMutationResult(result, request.requestId, route.mutationAction);
    }
    if (returnInspectionRoute(route)) {
      assertWebReturnInspection(auth.principal, route.mutationAction);
      const normalized = normalizeReturnInspectionMutation(request);
      const service = dependencies.returnInspectionService || defaultReturnInspectionService;
      let result;
      try {
        const command = {
          actor: returnInspectionActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey,
          strict: true
        };
        result = route.mutationAction === "receive"
          ? await service.confirmReturnReceived(command)
          : await service.inspectReturnItems(command);
      } catch (error) {
        throw returnInspectionApiError(error);
      }
      return returnInspectionMutationResult(result, request.requestId, route.mutationAction);
    }
    if (afterSaleReviewRoute(route)) {
      assertWebAfterSaleReview(auth.principal);
      const normalized = normalizeAfterSaleReview(request);
      const service = dependencies.afterSaleReviewService || defaultAfterSaleReviewService;
      let result;
      try {
        result = await service.reviewAfterSale({
          actor: afterSaleReviewActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey,
          strict: true
        });
      } catch (error) {
        throw afterSaleReviewApiError(error);
      }
      return afterSaleReviewMutationResult(result, request.requestId);
    }
    if (orderReviewRoute(route)) {
      const normalized = normalizeOrderReviewMutation(request);
      const service = dependencies.orderReviewService || defaultOrderReviewService;
      let result;
      try {
        result = await service.reviewOrder({ actor: orderReviewActor(auth), input: normalized.input, idempotencyKey: normalized.idempotencyKey, strict: true });
      } catch (error) {
        throw orderReviewApiError(error);
      }
      return orderReviewMutationResult(result, request.requestId);
    }
    if (productWriteRoute(route)) {
      const normalized = normalizeProductWriteMutation(request);
      const service = dependencies.productWriteService || defaultProductWriteService;
      let result;
      try {
        const command = {
          actor: inventoryWarningActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey
        };
        result = normalized.action === "create"
          ? await service.createProduct(command)
          : await service.updateProductMetadata({ ...command, requireExpectedVersion: true });
      } catch (error) {
        throw productWriteApiError(error);
      }
      if (result && result.ok === false) {
        throw productWriteApiError(Object.assign(new Error(result.message || "商品资料操作失败"), result));
      }
      const data = result && result.ok === true && result.data ? result.data : result;
      return productWriteMutationResult(data, request.requestId, auth.principal);
    }
    if (inventoryAdjustmentRoute(route)) {
      const normalized = normalizeInventoryAdjustmentMutation(request);
      const service = dependencies.inventoryMutationService || defaultInventoryMutationService;
      let result;
      try {
        result = await service.adjustInventory({
          actor: inventoryWarningActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey,
          requireExpectedSnapshots: true,
          requireReason: true
        });
      } catch (error) {
        throw inventoryAdjustmentApiError(error);
      }
      if (result && result.ok === false) {
        throw inventoryAdjustmentApiError(Object.assign(new Error(result.message || "库存调整失败"), result));
      }
      const data = result && result.ok === true && result.data ? result.data : result;
      return inventoryAdjustmentMutationResult(data, request.requestId);
    }
    if (inventoryWarningRoute(route)) {
      const normalized = normalizeInventoryWarningMutation(request);
      const service = dependencies.inventoryWarningService || defaultInventoryWarningService;
      let result;
      try {
        result = await service.setWarningStock({
          actor: inventoryWarningActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey,
          requireExpectedVersion: true
        });
      } catch (err) {
        throw inventoryWarningApiError(err);
      }
      if (result && result.ok === false) {
        throw inventoryWarningApiError(Object.assign(new Error(result.message || "库存预警操作失败"), result));
      }
      const data = result && result.ok === true && result.data ? result.data : result;
      return inventoryWarningMutationResult(data, request.requestId);
    }
    if (productPriceRoute(route)) {
      const normalized = normalizeProductPriceMutation(request);
      const service = dependencies.productPriceService || defaultProductPriceService;
      let result;
      try {
        result = await service.setPrice({
          actor: productPriceActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey,
          requireExpectedVersion: true
        });
      } catch (error) {
        throw productPriceApiError(error);
      }
      if (result && result.ok === false) {
        throw productPriceApiError(Object.assign(new Error(result.message || "商品改价失败"), result));
      }
      const data = result && result.ok === true && result.data ? result.data : result;
      return productPriceMutationResult(data, request.requestId);
    }
    if (productBatchEnableRoute(route)) {
      const normalized = normalizeProductBatchEnableMutation(request);
      const service = dependencies.productStatusService || defaultProductStatusService;
      let result;
      try {
        result = await service.setManyStatuses({
          actor: productStatusActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey,
          requireExpectedVersion: true
        });
      } catch (error) {
        throw productBatchEnableApiError(error);
      }
      if (result && result.ok === false) {
        throw productBatchEnableApiError(Object.assign(new Error(result.message || "批量上架失败"), result));
      }
      const data = result && result.ok === true && result.data ? result.data : result;
      return productBatchEnableMutationResult(data, request.requestId, normalized.input.items);
    }
    if (productBatchTagsRoute(route)) {
      const normalized = normalizeProductBatchTagsMutation(request);
      const service = dependencies.productTagService || defaultProductTagService;
      let result;
      try {
        result = await service.setManyPublicTags({
          actor: productTagActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey
        });
      } catch (error) {
        throw productTagApiError(error);
      }
      if (result && result.ok === false) {
        throw productTagApiError(Object.assign(new Error(result.message || "批量修改商品标签失败"), result));
      }
      const data = result && result.ok === true && result.data ? result.data : result;
      return productBatchTagsMutationResult(data, request.requestId, normalized.input.items);
    }
    if (productStatusRoute(route)) {
      const normalized = normalizeProductStatusMutation(request);
      const service = dependencies.productStatusService || defaultProductStatusService;
      let result;
      try {
        result = await service.setStatus({
          actor: productStatusActor(auth),
          input: normalized.input,
          idempotencyKey: normalized.idempotencyKey,
          requireExpectedVersion: true
        });
      } catch (error) {
        throw productStatusApiError(error);
      }
      if (result && result.ok === false) {
        throw productStatusApiError(Object.assign(new Error(result.message || "商品上下架操作失败"), result));
      }
      const data = result && result.ok === true && result.data ? result.data : result;
      return productStatusMutationResult(data, request.requestId);
    }
    throw new ApiError("SERVICE_NOT_MIGRATED", "该写操作尚未迁移到共享业务服务", 501);
  }
  throw new ApiError("ROUTE_NOT_FOUND", "接口不存在", 404);
}

exports.main = async (event = {}) => {
  let request = { http: isHttpEvent(event), requestId: crypto.randomUUID(), origin: "", headers: {} };
  let config;
  try {
    config = security.loadSecurityConfig(process.env);
    request = buildRequest(event);
    if (request.http && request.method === "OPTIONS") {
      assertBoundary(request, config);
      return formatResponse(request, config, {}, 204);
    }
    assertBoundary(request, config);
    if (request.route.action === "login") throw new ApiError("AUTH_ENDPOINT_SEPARATE", "登录由 adminWebAuth 提供", 404);
    const auth = await requireAccessSession({ db, accessToken: request.accessToken, config });
    const data = await dispatch(request, auth, config);
    return formatResponse(request, config, successEnvelope(data, request.requestId), 200);
  } catch (err) {
    config = config || { allowedOrigins: [] };
    const normalizedError = normalizeMainError(err);
    const failure = errorEnvelope(normalizedError, request.requestId);
    if (!(normalizedError instanceof ApiError)) console.error("adminWebApi failed", cleanString(err && err.message, 160));
    return formatResponse(request, config, failure.payload, failure.statusCode);
  }
};

exports._test = {
  buildRequest,
  actionRoute,
  buildWhere,
  listResource,
  getResource,
  readDashboard,
  assertBoundary,
  responseHeaders,
  normalizeMainError,
  dispatch,
  inventoryWarningRoute,
  normalizeInventoryWarningMutation,
  inventoryWarningActor,
  inventoryWarningApiError,
  inventoryWarningMutationResult,
  defaultInventoryWarningService,
  productPriceRoute,
  normalizeProductPriceMutation,
  productPriceActor,
  productPriceApiError,
  productPriceMutationResult,
  defaultProductPriceService,
  productStatusRoute,
  normalizeProductStatusMutation,
  productStatusActor,
  productStatusApiError,
  productStatusMutationResult,
  defaultProductStatusService,
  productBatchEnableRoute,
  normalizeProductBatchEnableMutation,
  productBatchEnableApiError,
  productBatchEnableMutationResult,
  productBatchTagsRoute,
  normalizeProductBatchTagsMutation,
  productTagActor,
  productTagApiError,
  productBatchTagsMutationResult,
  defaultProductTagService,
  productWriteRoute,
  normalizeProductWriteMutation,
  productWriteApiError,
  productWriteMutationResult,
  inventoryAdjustmentRoute,
  normalizeInventoryAdjustmentMutation,
  inventoryAdjustmentMutationResult,
  inventoryAdjustmentApiError,
  defaultInventoryMutationService,
  defaultOrderQueryService,
  assertWebShipmentRead,
  shipmentQueryApiError,
  readWebShipmentList,
  readWebShipmentDetail,
  defaultShipmentQueryService,
  accountQueryApiError,
  assertWebAccountRead,
  readWebAccountList,
  readWebAccountDetail,
  defaultAccountQueryService,
  paymentQueryApiError,
  assertWebPaymentRead,
  readWebPaymentList,
  readWebPaymentDetail,
  defaultPaymentQueryService,
  paymentMutationRoute,
  assertWebPaymentMutation,
  normalizePaymentMutation,
  paymentMutationActor,
  paymentMutationApiError,
  paymentMutationResult,
  defaultPaymentMutationService,
  refundMutationRoute,
  assertWebRefundMutation,
  normalizeRefundMutation,
  refundMutationActor,
  refundMutationApiError,
  refundMutationResult,
  defaultRefundMutationService,
  afterSaleReviewRoute,
  assertWebAfterSaleReview,
  normalizeAfterSaleReview,
  afterSaleReviewActor,
  afterSaleReviewApiError,
  afterSaleReviewMutationResult,
  defaultAfterSaleReviewService,
  returnInspectionRoute,
  assertWebReturnInspection,
  normalizeReturnInspectionMutation,
  returnInspectionActor,
  returnInspectionApiError,
  returnInspectionMutationResult,
  defaultReturnInspectionService,
  orderReviewRoute,
  normalizeOrderReviewMutation,
  orderReviewActor,
  orderReviewApiError,
  orderReviewMutationResult,
  defaultOrderReviewService,
  orderQueryApiError,
  defaultProductWriteService,
  analyticsApiError,
  projectProductAnalytics,
  readProductAnalytics,
  defaultProductAnalyticsService
};
