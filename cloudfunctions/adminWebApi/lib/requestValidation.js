class RequestValidationError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "RequestValidationError";
    this.code = code;
    this.statusCode = 400;
    this.details = field ? { field } : undefined;
  }
}

function invalidArgument(message, field) {
  throw new RequestValidationError("INVALID_ARGUMENT", message, field);
}

function validationError(message, field) {
  throw new RequestValidationError("VALIDATION_ERROR", message, field);
}

function parseObject(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidArgument(`${options.label || "请求内容"}必须是 JSON 对象`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidArgument(`${options.label || "请求内容"}必须是普通对象`);
  }
  if (Array.isArray(options.allowedKeys)) {
    const allowed = new Set(options.allowedKeys);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) invalidArgument(`请求包含未允许的字段：${unknown}`, unknown);
  }
  return value;
}

function missing(value) {
  return value === undefined || value === null;
}

function parseString(value, options = {}) {
  const field = options.field || "value";
  if (missing(value)) {
    if (options.required === false) return undefined;
    invalidArgument(`缺少字段：${field}`, field);
  }
  if (typeof value !== "string") invalidArgument(`字段 ${field} 必须是字符串`, field);
  const result = options.trim === false ? value : value.trim();
  const minLength = Number.isInteger(options.minLength) ? options.minLength : (options.required === false ? 0 : 1);
  const maxLength = Number.isInteger(options.maxLength) ? options.maxLength : 300;
  if (result.length < minLength || result.length > maxLength) {
    validationError(`字段 ${field} 长度必须在 ${minLength}-${maxLength} 之间`, field);
  }
  if (options.pattern instanceof RegExp) {
    const stablePattern = new RegExp(options.pattern.source, options.pattern.flags.replace(/[gy]/g, ""));
    if (!stablePattern.test(result)) validationError(`字段 ${field} 格式无效`, field);
  }
  return result;
}

function parseInteger(value, options = {}) {
  const field = options.field || "value";
  if (missing(value)) {
    if (options.required === false) return undefined;
    invalidArgument(`缺少字段：${field}`, field);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    invalidArgument(`字段 ${field} 必须是整数`, field);
  }
  if (Number.isFinite(options.min) && value < options.min) validationError(`字段 ${field} 小于允许范围`, field);
  if (Number.isFinite(options.max) && value > options.max) validationError(`字段 ${field} 超出允许范围`, field);
  return value;
}

function parseEnum(value, allowedValues, options = {}) {
  const field = options.field || "value";
  const result = parseString(value, { field, required: options.required, maxLength: options.maxLength || 100 });
  if (result === undefined) return undefined;
  if (!Array.isArray(allowedValues) || !allowedValues.includes(result)) {
    validationError(`字段 ${field} 不在允许范围内`, field);
  }
  return result;
}

function parseBoolean(value, options = {}) {
  const field = options.field || "value";
  if (missing(value)) {
    if (options.required === false) return undefined;
    invalidArgument(`缺少字段：${field}`, field);
  }
  if (typeof value !== "boolean") invalidArgument(`字段 ${field} 必须是布尔值`, field);
  return value;
}

module.exports = {
  RequestValidationError,
  parseObject,
  parseString,
  parseInteger,
  parseEnum,
  parseBoolean
};
