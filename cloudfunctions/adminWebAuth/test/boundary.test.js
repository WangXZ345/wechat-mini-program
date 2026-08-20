const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSecurityConfig, tokenHash } = require("../security");
const authModule = require("../index");
const { classifyError } = require("../errorModel");
const {
  assertRequestBoundary,
  assertRevokeSessionCsrf,
  assertBootstrapAllowed,
  responseHeaders
} = authModule._test;

function actionRequest(secret = "", body = {}) {
  return {
    http: false,
    headers: secret ? { "x-admin-action-secret": secret } : {},
    body,
    origin: ""
  };
}

function httpRequest(secret = "", origin = "http://localhost:5173") {
  return {
    http: true,
    headers: secret ? { "x-admin-action-secret": secret } : {},
    body: {},
    origin
  };
}

test("authentication detailed errors use the frozen public category map", () => {
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
    assert.equal(classifyError(code, statusCode), expected, code);
  }
});

test("internal-gateway transport is denied locally unless the explicit bypass is enabled", () => {
  const denied = loadSecurityConfig({ ADMIN_WEB_ENV: "unit-test" });
  assert.throws(() => assertRequestBoundary(actionRequest(), denied), (err) => err.code === "ACTION_SECURITY_CONFIG_REQUIRED");
  assert.throws(() => assertRequestBoundary(httpRequest(), denied), (err) => err.code === "ACTION_SECURITY_CONFIG_REQUIRED");

  const allowed = loadSecurityConfig({
    ADMIN_WEB_ENV: "unit-test",
    ADMIN_WEB_ALLOW_TEST_ACTION_TRANSPORT: "true"
  });
  assert.doesNotThrow(() => assertRequestBoundary(actionRequest(), allowed));
  assert.doesNotThrow(() => assertRequestBoundary(httpRequest(), allowed));
});

test("remote HTTP and Action transports require only the configured header secret", () => {
  const secret = "a".repeat(32);
  const config = loadSecurityConfig({
    ADMIN_WEB_ENV: "test",
    ADMIN_WEB_TOKEN_PEPPER: "t".repeat(32),
    ADMIN_WEB_PASSWORD_PEPPER: "p".repeat(32),
    ADMIN_WEB_ACTION_SECRET: secret,
    ADMIN_WEB_ALLOWED_ORIGINS: "https://admin.test.example"
  });
  assert.throws(() => assertRequestBoundary(actionRequest("wrong"), config), (err) => err.code === "ACTION_CALL_FORBIDDEN");
  assert.throws(
    () => assertRequestBoundary(actionRequest("", { actionSecret: secret }), config),
    (err) => err.code === "ACTION_CALL_FORBIDDEN"
  );
  assert.doesNotThrow(() => assertRequestBoundary(actionRequest(secret), config));
  assert.throws(() => assertRequestBoundary(httpRequest("", "https://admin.test.example"), config), (err) => err.code === "ACTION_CALL_FORBIDDEN");
  assert.doesNotThrow(() => assertRequestBoundary(httpRequest(secret, "https://admin.test.example"), config));
  assert.throws(() => assertRequestBoundary(httpRequest(secret, ""), config), (err) => err.code === "ORIGIN_NOT_ALLOWED");
  assert.throws(
    () => assertRequestBoundary(httpRequest(secret, "https://admin.test.example.evil.test"), config),
    (err) => err.code === "ORIGIN_NOT_ALLOWED"
  );
});

test("forged HTTP and Action events cannot bypass the internal gateway end to end", async () => {
  const keys = [
    "ADMIN_WEB_ENV",
    "ADMIN_WEB_TOKEN_PEPPER",
    "ADMIN_WEB_PASSWORD_PEPPER",
    "ADMIN_WEB_ACTION_SECRET",
    "ADMIN_WEB_ALLOWED_ORIGINS",
    "ADMIN_WEB_ALLOW_BOOTSTRAP"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const secret = "g".repeat(32);
  Object.assign(process.env, {
    ADMIN_WEB_ENV: "test",
    ADMIN_WEB_TOKEN_PEPPER: "t".repeat(32),
    ADMIN_WEB_PASSWORD_PEPPER: "p".repeat(32),
    ADMIN_WEB_ACTION_SECRET: secret,
    ADMIN_WEB_ALLOWED_ORIGINS: "https://admin.test.example",
    ADMIN_WEB_ALLOW_BOOTSTRAP: "false"
  });

  try {
    const forgedHttp = await authModule.main({
      httpMethod: "POST",
      rawPath: "/profile",
      headers: { origin: "https://admin.test.example" },
      body: JSON.stringify({ action: "profile", actionSecret: secret })
    });
    assert.equal(forgedHttp.statusCode, 403);
    assert.equal(JSON.parse(forgedHttp.body).code, "ACTION_CALL_FORBIDDEN");

    const forgedAction = await authModule.main({
      data: { action: "profile", actionSecret: secret }
    });
    assert.equal(forgedAction.statusCode, 403);
    assert.equal(forgedAction.code, "ACTION_CALL_FORBIDDEN");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("HTTP failures use the shared safe envelope and canonical category", async () => {
  const keys = [
    "ADMIN_WEB_ENV",
    "ADMIN_WEB_TOKEN_PEPPER",
    "ADMIN_WEB_PASSWORD_PEPPER",
    "ADMIN_WEB_ACTION_SECRET",
    "ADMIN_WEB_ALLOWED_ORIGINS"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ADMIN_WEB_ENV: "test",
    ADMIN_WEB_TOKEN_PEPPER: "t".repeat(32),
    ADMIN_WEB_PASSWORD_PEPPER: "p".repeat(32),
    ADMIN_WEB_ACTION_SECRET: "g".repeat(32),
    ADMIN_WEB_ALLOWED_ORIGINS: "https://admin.test.example"
  });

  try {
    const response = await authModule.main({
      httpMethod: "POST",
      rawPath: "/login",
      headers: {
        origin: "https://admin.test.example",
        "x-admin-action-secret": "g".repeat(32),
        "x-request-id": "auth-request-1"
      },
      body: "{invalid"
    });
    const payload = JSON.parse(response.body);
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["x-request-id"], "auth-request-1");
    assert.equal(payload.code, "INVALID_JSON");
    assert.equal(payload.category, "INVALID_ARGUMENT");
    assert.equal(payload.error.code, "INVALID_JSON");
    assert.equal(payload.error.category, "INVALID_ARGUMENT");
    assert.equal(payload.meta.requestId, "auth-request-1");
    assert.equal(Object.hasOwn(payload, "stack"), false);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("HTTP authentication bodies reject arrays, null and scalar JSON values", () => {
  const bodies = [[], null, 0, false, "[]", "null", "0", "false"];
  for (const body of bodies) {
    assert.throws(() => authModule._test.buildRequest({
      httpMethod: "POST",
      rawPath: "/login",
      headers: {},
      body
    }), (error) => error.code === "INVALID_ARGUMENT" && error.statusCode === 400, JSON.stringify(body));
  }
});

test("authentication responses never reflect unsafe request ids", async () => {
  const response = await authModule.main({
    httpMethod: "POST",
    rawPath: "/login",
    headers: { "x-request-id": "bad\r\nx-injected: yes" },
    body: "{invalid"
  });
  assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$/i);
  assert.equal(response.headers["x-request-id"].includes("\r"), false);
});

test("remote bootstrap accepts only the server-injected header and CORS does not expose it", () => {
  const bootstrapSecret = "b".repeat(32);
  const config = loadSecurityConfig({
    ADMIN_WEB_ENV: "test",
    ADMIN_WEB_TOKEN_PEPPER: "t".repeat(32),
    ADMIN_WEB_PASSWORD_PEPPER: "p".repeat(32),
    ADMIN_WEB_ACTION_SECRET: "a".repeat(32),
    ADMIN_WEB_ALLOWED_ORIGINS: "https://admin.test.example",
    ADMIN_WEB_ALLOW_BOOTSTRAP: "true",
    ADMIN_WEB_BOOTSTRAP_SECRET: bootstrapSecret
  });
  const bodyOnly = {
    http: true,
    headers: {},
    body: { bootstrapSecret }
  };
  assert.throws(() => assertBootstrapAllowed(bodyOnly, config), (err) => err.code === "BOOTSTRAP_FORBIDDEN");
  assert.doesNotThrow(() => assertBootstrapAllowed({
    ...bodyOnly,
    headers: { "x-admin-bootstrap-secret": bootstrapSecret }
  }, config));

  const headers = responseHeaders({ http: true, origin: "https://admin.test.example" }, config);
  assert.equal(headers["access-control-allow-headers"].includes("x-admin-bootstrap-secret"), false);
  assert.equal(headers["access-control-allow-headers"].includes("x-admin-action-secret"), false);
});

test("session revoke CSRF guard accepts only the current session token", () => {
  const config = loadSecurityConfig({ ADMIN_WEB_ENV: "unit-test" });
  const token = "csrf-token";
  const session = { csrfTokenHash: tokenHash(token, config.tokenPepper) };
  const request = { http: true, headers: { "x-admin-csrf": token }, body: {} };
  assert.doesNotThrow(() => assertRevokeSessionCsrf(session, request, config));
  assert.throws(
    () => assertRevokeSessionCsrf(session, { ...request, headers: { "x-admin-csrf": "wrong" } }, config),
    (err) => err.code === "CSRF_VALIDATION_FAILED" && err.statusCode === 403
  );
});
