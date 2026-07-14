const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSecurityConfig, tokenHash } = require("../security");
const authModule = require("../index");
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
