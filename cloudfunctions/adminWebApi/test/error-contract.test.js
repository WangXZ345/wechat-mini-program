const test = require("node:test");
const assert = require("node:assert/strict");

let errorModel;
let requestValidation;
try {
  errorModel = require("../lib/errorModel");
  requestValidation = require("../lib/requestValidation");
} catch (error) {
  // Keep module discovery inside the assertion path so RED is an assertion
  // failure instead of a test-runner bootstrap error.
}

test("public error model distinguishes every frozen write error category", () => {
  assert.equal(typeof errorModel?.classifyError, "function");
  const cases = [
    ["INVALID_JSON", 400, "INVALID_ARGUMENT"],
    ["AUTH_REQUIRED", 401, "UNAUTHENTICATED"],
    ["FORBIDDEN", 403, "FORBIDDEN"],
    ["CSRF_VALIDATION_FAILED", 403, "CSRF"],
    ["RATE_LIMITED", 429, "RATE_LIMITED"],
    ["ORDER_NOT_FOUND", 404, "NOT_FOUND"],
    ["ORDER_STATUS_INVALID", 409, "INVALID_STATE"],
    ["DATA_VERSION_CONFLICT", 409, "DATA_VERSION_CONFLICT"],
    ["IDEMPOTENCY_KEY_CONFLICT", 409, "IDEMPOTENCY_CONFLICT"],
    ["FILE_PARSE_FAILED", 422, "FILE_PARSE_ERROR"],
    ["VALIDATION_ERROR", 422, "VALIDATION_ERROR"],
    ["INSUFFICIENT_STOCK", 409, "INSUFFICIENT_STOCK"],
    ["REFUND_AMOUNT_LIMIT_EXCEEDED", 409, "AMOUNT_LIMIT"],
    ["PARTIAL_SUCCESS", 207, "PARTIAL_SUCCESS"],
    ["DATABASE_DRIVER_FAILED", 500, "INTERNAL_ERROR"]
  ];
  for (const [code, statusCode, expected] of cases) {
    assert.equal(errorModel.classifyError(code, statusCode), expected, code);
  }
});

test("existing detailed error codes keep the same public category across legacy envelopes", () => {
  const cases = [
    ["SECURITY_CONFIG_REQUIRED", 503, "INTERNAL_ERROR"],
    ["AUTH_STORAGE_NOT_READY", 503, "INTERNAL_ERROR"],
    ["SESSION_WRITE_NOT_CONFIRMED", 503, "INTERNAL_ERROR"],
    ["SESSION_ID_REQUIRED", 400, "INVALID_ARGUMENT"],
    ["SESSION_NOT_FOUND", 404, "NOT_FOUND"],
    ["EXPECTED_STATUS_INVALID", 400, "INVALID_ARGUMENT"],
    ["INVALID_ORDER_STATUS", 400, "INVALID_ARGUMENT"],
    ["METHOD_NOT_ALLOWED", 405, "INVALID_ARGUMENT"],
    ["IDEMPOTENCY_KEY_REUSED", 409, "IDEMPOTENCY_CONFLICT"],
    ["FILE_FORMAT_INVALID", 422, "FILE_PARSE_ERROR"],
    ["REFUND_AMOUNT_OUT_OF_RANGE", 409, "AMOUNT_LIMIT"]
  ];
  for (const [code, statusCode, expected] of cases) {
    assert.equal(errorModel.classifyError(code, statusCode), expected, code);
  }
});

test("public error descriptor preserves trusted business text and redacts unknown internals", () => {
  const trusted = errorModel.toPublicError({
    code: "DATA_VERSION_CONFLICT",
    message: "记录已变化，请刷新后重新确认",
    statusCode: 409
  }, { trusted: true });
  assert.deepEqual(trusted, {
    code: "DATA_VERSION_CONFLICT",
    category: "DATA_VERSION_CONFLICT",
    message: "记录已变化，请刷新后重新确认",
    statusCode: 409
  });

  const internal = errorModel.toPublicError(new Error("MongoServerError at node_modules/driver.js:42"));
  assert.deepEqual(internal, {
    code: "INTERNAL_ERROR",
    category: "INTERNAL_ERROR",
    message: "服务暂时不可用",
    statusCode: 500
  });
  assert.equal(JSON.stringify(internal).includes("Mongo"), false);
  assert.equal(JSON.stringify(internal).includes("stack"), false);
});

test("request validation is strict about object shape, types, ranges, enums and unknown fields", () => {
  assert.equal(typeof requestValidation?.parseObject, "function");
  const input = requestValidation.parseObject({
    note: "  已核验  ",
    expectedVersion: 3,
    decision: "approve",
    enabled: true
  }, { allowedKeys: ["note", "expectedVersion", "decision", "enabled"] });
  assert.equal(requestValidation.parseString(input.note, { field: "note", maxLength: 20 }), "已核验");
  assert.equal(requestValidation.parseInteger(input.expectedVersion, { field: "expectedVersion", min: 0, max: 99 }), 3);
  assert.equal(requestValidation.parseEnum(input.decision, ["approve", "reject"], { field: "decision" }), "approve");
  assert.equal(requestValidation.parseBoolean(input.enabled, { field: "enabled" }), true);

  assert.throws(() => requestValidation.parseObject([]), (error) => error.code === "INVALID_ARGUMENT");
  assert.throws(
    () => requestValidation.parseObject({ actor: "forged" }, { allowedKeys: [] }),
    (error) => error.code === "INVALID_ARGUMENT" && error.details?.field === "actor"
  );
  assert.throws(
    () => requestValidation.parseInteger("3", { field: "expectedVersion" }),
    (error) => error.code === "INVALID_ARGUMENT"
  );
  assert.throws(
    () => requestValidation.parseInteger(100, { field: "expectedVersion", max: 99 }),
    (error) => error.code === "VALIDATION_ERROR"
  );
  assert.throws(
    () => requestValidation.parseEnum("paid", ["approve", "reject"], { field: "decision" }),
    (error) => error.code === "VALIDATION_ERROR"
  );

  const statefulPattern = /^ok$/g;
  assert.equal(requestValidation.parseString("ok", { field: "stateful", pattern: statefulPattern }), "ok");
  assert.equal(requestValidation.parseString("ok", { field: "stateful", pattern: statefulPattern }), "ok");
});

test("request ids accept a narrow safe charset and regenerate unsafe input", () => {
  assert.equal(errorModel.normalizeRequestId("request-1:api.v1", () => "fallback"), "request-1:api.v1");
  assert.equal(errorModel.normalizeRequestId("bad\r\nx-injected: yes", () => "fallback"), "fallback");
  assert.equal(errorModel.normalizeRequestId(" spaced ", () => "fallback"), "fallback");
  assert.equal(errorModel.normalizeRequestId("x".repeat(101), () => "fallback"), "fallback");
});
