const CANONICAL_ERROR_CATEGORIES = Object.freeze([
  "INVALID_ARGUMENT",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF",
  "RATE_LIMITED",
  "NOT_FOUND",
  "INVALID_STATE",
  "DATA_VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "FILE_PARSE_ERROR",
  "VALIDATION_ERROR",
  "INSUFFICIENT_STOCK",
  "AMOUNT_LIMIT",
  "PARTIAL_SUCCESS",
  "INTERNAL_ERROR"
]);

const CATEGORY_SET = new Set(CANONICAL_ERROR_CATEGORIES);
const BATCH_INPUT_LIMIT_CODES = new Set([
  "BATCH_ITEM_LIMIT_EXCEEDED",
  "BATCH_PAYLOAD_LIMIT_EXCEEDED",
  "BATCH_PAYLOAD_DEPTH_EXCEEDED",
  "BATCH_PAYLOAD_NODE_LIMIT_EXCEEDED",
  "BATCH_STRING_LIMIT_EXCEEDED"
]);
const DEFAULT_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: "请求参数无效",
  UNAUTHENTICATED: "登录状态无效，请重新登录",
  FORBIDDEN: "无权执行此操作",
  CSRF: "请求校验失败，请刷新后重试",
  RATE_LIMITED: "操作过于频繁，请稍后重试",
  NOT_FOUND: "记录不存在",
  INVALID_STATE: "当前状态不允许此操作",
  DATA_VERSION_CONFLICT: "记录已变化，请刷新后重新确认",
  IDEMPOTENCY_CONFLICT: "操作冲突，请确认结果后重试",
  FILE_PARSE_ERROR: "文件解析失败，请检查文件后重试",
  VALIDATION_ERROR: "提交内容未通过校验",
  INSUFFICIENT_STOCK: "库存不足，无法完成操作",
  AMOUNT_LIMIT: "金额超出允许范围",
  PARTIAL_SUCCESS: "部分项目处理失败，请查看结果",
  INTERNAL_ERROR: "服务暂时不可用"
});

function cleanCode(value, fallback = "INTERNAL_ERROR") {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : fallback;
}

function cleanStatus(value, fallback = 500) {
  const statusCode = Number(value);
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : fallback;
}

function classifyError(value, statusValue) {
  const code = cleanCode(value);
  const statusCode = cleanStatus(statusValue);
  if (CATEGORY_SET.has(code)) return code;
  if (code.includes("CSRF")) return "CSRF";
  if (code === "RATE_LIMITED" || code.includes("RATE_LIMIT")) return "RATE_LIMITED";
  if (code.includes("DATA_VERSION") || code === "EXPECTED_VERSION_MISMATCH") return "DATA_VERSION_CONFLICT";
  if (code.includes("IDEMPOTENCY") && (code.includes("CONFLICT") || code.includes("PROCESSING") || code.includes("REUSED"))) return "IDEMPOTENCY_CONFLICT";
  if (code.includes("FILE") && (code.includes("PARSE") || code.includes("FORMAT"))) return "FILE_PARSE_ERROR";
  if (code === "INSUFFICIENT_STOCK" || code.includes("STOCK_INSUFFICIENT")) return "INSUFFICIENT_STOCK";
  if (code.includes("AMOUNT") && (code.includes("LIMIT") || code.includes("EXCEED") || code.includes("OUT_OF_RANGE"))) return "AMOUNT_LIMIT";
  if (code.includes("PARTIAL") && (code.includes("SUCCESS") || code.includes("FAILURE"))) return "PARTIAL_SUCCESS";
  if (code.includes("VALIDATION") || code.endsWith("_DATA_INVALID")) return "VALIDATION_ERROR";
  if (statusCode >= 500) return "INTERNAL_ERROR";
  if (statusCode === 413 && BATCH_INPUT_LIMIT_CODES.has(code)) return "INVALID_ARGUMENT";
  if (code.includes("FORBIDDEN") || code === "PERMISSION_DENIED" || code === "ORIGIN_NOT_ALLOWED") return "FORBIDDEN";
  if (statusCode === 404 || code === "NOT_FOUND" || code.endsWith("_NOT_FOUND") || code === "ROUTE_NOT_FOUND" || code === "RESOURCE_NOT_FOUND") return "NOT_FOUND";
  if (statusCode === 405) return "INVALID_ARGUMENT";
  if (statusCode === 400 && (code.startsWith("INVALID_") || code === "INVALID_JSON" || code === "INVALID_REQUEST_BODY" || code.endsWith("_REQUIRED") || code.includes("_INVALID"))) return "INVALID_ARGUMENT";
  if (statusCode === 401 || /^(AUTH_|UNAUTHENTICATED$)|SESSION_|TOKEN_|ACCOUNT_UNAVAILABLE|REFRESH_TOKEN/.test(code)) return "UNAUTHENTICATED";
  if (code.includes("STATE") || code.includes("STATUS") || code.includes("ALREADY_")) return "INVALID_STATE";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 409) return "INVALID_STATE";
  if (statusCode === 429) return "RATE_LIMITED";
  if (statusCode === 400) return "INVALID_ARGUMENT";
  return "INTERNAL_ERROR";
}

function normalizeRequestId(value, createFallback = () => "") {
  const candidate = typeof value === "string" ? value : "";
  if (/^[A-Za-z0-9._:-]{1,100}$/.test(candidate)) return candidate;
  const fallback = String(createFallback() || "");
  return /^[A-Za-z0-9._:-]{1,100}$/.test(fallback) ? fallback : "";
}

function safeMessage(value) {
  const message = String(value || "").trim();
  if (!message || message.length > 240 || /[\r\n\u0000-\u001f\u007f]/.test(message)) return "";
  if (/(?:\bat\s+\S+\s*\(|node_modules|Mongo(?:Server)?Error|CloudBase|database|collection|SQLSTATE|stack\s*trace)/i.test(message)) return "";
  return message;
}

function toPublicError(error, options = {}) {
  const trusted = options.trusted === true;
  if (!trusted) {
    const code = cleanCode(options.fallbackCode || "INTERNAL_ERROR");
    return {
      code,
      category: "INTERNAL_ERROR",
      message: safeMessage(options.fallbackMessage) || DEFAULT_MESSAGES.INTERNAL_ERROR,
      statusCode: 500
    };
  }
  const code = cleanCode(error && error.code);
  const statusCode = cleanStatus(error && error.statusCode, 500);
  const category = classifyError(code, statusCode);
  return {
    code,
    category,
    message: safeMessage(error && error.message) || DEFAULT_MESSAGES[category],
    statusCode
  };
}

module.exports = {
  CANONICAL_ERROR_CATEGORIES,
  classifyError,
  normalizeRequestId,
  toPublicError
};
