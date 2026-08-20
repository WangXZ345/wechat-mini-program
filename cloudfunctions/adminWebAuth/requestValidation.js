class RequestValidationError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "RequestValidationError";
    this.code = code;
    this.statusCode = 400;
    this.details = field ? { field } : undefined;
  }
}

function parseObject(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError("INVALID_ARGUMENT", `${options.label || "请求内容"}必须是 JSON 对象`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RequestValidationError("INVALID_ARGUMENT", `${options.label || "请求内容"}必须是普通对象`);
  }
  return value;
}

module.exports = { RequestValidationError, parseObject };
