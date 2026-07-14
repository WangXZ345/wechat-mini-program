const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const api = require("../index");
const { assertBoundary, buildRequest, responseHeaders } = api._test;

const actionSecret = "a".repeat(32);
const allowedOrigin = "https://admin.staging.example";
const remoteConfig = security.loadSecurityConfig({
  ADMIN_WEB_ENV: "staging",
  ADMIN_WEB_TOKEN_PEPPER: "t".repeat(32),
  ADMIN_WEB_PASSWORD_PEPPER: "p".repeat(32),
  ADMIN_WEB_ACTION_SECRET: actionSecret,
  ADMIN_WEB_ALLOWED_ORIGINS: allowedOrigin
});

function actionRequest(extra = {}) {
  return buildRequest({
    headers: {},
    data: { action: "list", resource: "orders" },
    ...extra
  });
}

function httpRequest(extra = {}) {
  return buildRequest({
    httpMethod: "GET",
    rawPath: "/api/admin/v1/orders",
    headers: { origin: allowedOrigin },
    ...extra
  });
}

const securityEnvKeys = [
  "ADMIN_WEB_ENV",
  "ADMIN_WEB_TOKEN_PEPPER",
  "ADMIN_WEB_PASSWORD_PEPPER",
  "ADMIN_WEB_ACTION_SECRET",
  "ADMIN_WEB_ALLOWED_ORIGINS",
  "ADMIN_WEB_ALLOW_BOOTSTRAP",
  "ADMIN_WEB_BOOTSTRAP_SECRET",
  "ADMIN_WEB_ALLOW_TEST_ACTION_TRANSPORT"
];

async function withSecurityEnv(values, callback) {
  const previous = Object.fromEntries(securityEnvKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of securityEnvKeys) {
      if (Object.hasOwn(values, key) && values[key] !== undefined) process.env[key] = values[key];
      else delete process.env[key];
    }
    return await callback();
  } finally {
    for (const key of securityEnvKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function validRemoteEnv() {
  return {
    ADMIN_WEB_ENV: "staging",
    ADMIN_WEB_TOKEN_PEPPER: "t".repeat(32),
    ADMIN_WEB_PASSWORD_PEPPER: "p".repeat(32),
    ADMIN_WEB_ACTION_SECRET: actionSecret,
    ADMIN_WEB_ALLOWED_ORIGINS: allowedOrigin
  };
}

function responsePayload(response) {
  return response && typeof response.body === "string" && response.body
    ? JSON.parse(response.body)
    : response;
}

test("remote Action accepts only the internal secret header", () => {
  assert.throws(
    () => assertBoundary(actionRequest(), remoteConfig),
    (err) => err.code === "ACTION_CALL_FORBIDDEN" && err.statusCode === 403
  );
  assert.throws(
    () => assertBoundary(actionRequest({ data: { action: "list", resource: "orders", actionSecret } }), remoteConfig),
    (err) => err.code === "ACTION_CALL_FORBIDDEN" && err.statusCode === 403
  );
  assert.doesNotThrow(() => assertBoundary(actionRequest({
    headers: { "x-admin-action-secret": actionSecret }
  }), remoteConfig));
});

test("an Action event cannot spoof HTTP fields to bypass the internal secret", () => {
  const spoofed = httpRequest();
  assert.equal(spoofed.http, true);
  assert.throws(
    () => assertBoundary(spoofed, remoteConfig),
    (err) => err.code === "ACTION_CALL_FORBIDDEN" && err.statusCode === 403
  );
  assert.doesNotThrow(() => assertBoundary(httpRequest({
    headers: { origin: allowedOrigin, "x-admin-action-secret": actionSecret }
  }), remoteConfig));
});

test("trusted HTTP requests still require an allowed Origin, including GET", () => {
  assert.throws(
    () => assertBoundary(httpRequest({ headers: { "x-admin-action-secret": actionSecret } }), remoteConfig),
    (err) => err.code === "ORIGIN_NOT_ALLOWED" && err.statusCode === 403
  );
  assert.throws(
    () => assertBoundary(httpRequest({
      headers: { origin: "https://evil.example", "x-admin-action-secret": actionSecret }
    }), remoteConfig),
    (err) => err.code === "ORIGIN_NOT_ALLOWED" && err.statusCode === 403
  );
});

test("CORS never advertises the internal gateway secret to browsers", () => {
  const headers = responseHeaders(httpRequest({
    headers: { origin: allowedOrigin, "x-admin-action-secret": actionSecret }
  }), remoteConfig);
  assert.equal(headers["access-control-allow-origin"], allowedOrigin);
  assert.equal(headers["access-control-allow-headers"].includes("x-admin-action-secret"), false);
});

test("the explicit local test bypass never disables HTTP Origin validation", () => {
  const localConfig = security.loadSecurityConfig({
    ADMIN_WEB_ENV: "unit-test",
    ADMIN_WEB_ALLOW_TEST_ACTION_TRANSPORT: "true"
  });
  assert.doesNotThrow(() => assertBoundary(actionRequest(), localConfig));
  assert.doesNotThrow(() => assertBoundary(httpRequest({
    headers: { origin: "http://127.0.0.1:5173" }
  }), localConfig));
  assert.throws(
    () => assertBoundary(httpRequest({ headers: {} }), localConfig),
    (err) => err.code === "ORIGIN_NOT_ALLOWED" && err.statusCode === 403
  );
});

test("main rejects forged HTTP and Action events before authentication", async () => {
  await withSecurityEnv(validRemoteEnv(), async () => {
    const forgedHttp = await api.main({
      httpMethod: "GET",
      rawPath: "/api/admin/v1/orders",
      headers: { origin: allowedOrigin }
    });
    assert.equal(forgedHttp.statusCode, 403);
    assert.equal(responsePayload(forgedHttp).error.code, "ACTION_CALL_FORBIDDEN");

    const actionWithBodySecret = await api.main({
      data: { action: "list", resource: "orders", actionSecret }
    });
    assert.equal(actionWithBodySecret.statusCode, 403);
    assert.equal(actionWithBodySecret.error.code, "ACTION_CALL_FORBIDDEN");
  });
});

test("main handles OPTIONS before route parsing but keeps both boundary checks", async () => {
  await withSecurityEnv(validRemoteEnv(), async () => {
    const denied = await api.main({
      httpMethod: "OPTIONS",
      rawPath: "/api/admin/v1/orders",
      headers: { origin: allowedOrigin }
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(responsePayload(denied).error.code, "ACTION_CALL_FORBIDDEN");

    const invalidOrigin = await api.main({
      httpMethod: "OPTIONS",
      rawPath: "/api/admin/v1/orders",
      headers: { origin: "https://evil.example", "x-admin-action-secret": actionSecret }
    });
    assert.equal(invalidOrigin.statusCode, 403);
    assert.equal(responsePayload(invalidOrigin).error.code, "ORIGIN_NOT_ALLOWED");

    const allowed = await api.main({
      httpMethod: "OPTIONS",
      rawPath: "/api/admin/v1/unknown/extra",
      headers: { origin: allowedOrigin, "x-admin-action-secret": actionSecret }
    });
    assert.equal(allowed.statusCode, 204);
    assert.equal(allowed.body, "");

    const outsidePrefix = await api.main({
      httpMethod: "OPTIONS",
      rawPath: "/not-admin-api",
      headers: { origin: allowedOrigin, "x-admin-action-secret": actionSecret }
    });
    assert.equal(outsidePrefix.statusCode, 404);
    assert.equal(responsePayload(outsidePrefix).error.code, "ROUTE_NOT_FOUND");
  });
});

test("main maps authentication security configuration errors to a safe 503", async () => {
  await withSecurityEnv({ ADMIN_WEB_ENV: "staging" }, async () => {
    const response = await api.main({
      httpMethod: "GET",
      rawPath: "/api/admin/v1/orders",
      headers: { origin: allowedOrigin }
    });
    const payload = responsePayload(response);
    assert.equal(response.statusCode, 503);
    assert.equal(payload.error.code, "SECURITY_CONFIG_REQUIRED");
    assert.equal(payload.error.message, "管理员接口安全配置不完整");
    assert.equal(JSON.stringify(payload).includes("TOKEN_PEPPER"), false);
  });
});
