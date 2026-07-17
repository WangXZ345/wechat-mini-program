const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const { assertSessionCsrf } = require("../lib/session");
const { dispatch } = require("../index")._test;

const config = security.loadSecurityConfig({ ADMIN_WEB_ENV: "unit-test" });

function mutationRequest(csrfToken = "") {
  return {
    http: true,
    headers: csrfToken ? { "x-admin-csrf": csrfToken } : {},
    body: {},
    route: { action: "mutate", resource: "payments", mutationAction: "confirm" },
    query: {}
  };
}

function authContext(permissions, csrfToken = "current-csrf-token") {
  return {
    principal: { role: "finance", status: "active", permissions },
    session: { csrfTokenHash: security.tokenHash(csrfToken, config.tokenPepper) },
    rawAdmin: {}
  };
}

test("HTTP and trusted Action CSRF sources are handled explicitly", () => {
  const csrfToken = "current-csrf-token";
  const auth = authContext(["payment:confirm"], csrfToken);
  assert.doesNotThrow(() => assertSessionCsrf({
    session: auth.session,
    request: mutationRequest(csrfToken),
    config
  }));
  assert.throws(() => assertSessionCsrf({
    session: auth.session,
    request: { http: true, headers: {}, body: { csrfToken } },
    config
  }), (err) => err.code === "CSRF_VALIDATION_FAILED" && err.statusCode === 403);
  assert.doesNotThrow(() => assertSessionCsrf({
    session: auth.session,
    request: { http: false, headers: {}, body: { csrfToken } },
    config
  }));
});

test("mutation checks permission, then CSRF, before the service boundary", async () => {
  const csrfToken = "current-csrf-token";
  await assert.rejects(
    () => dispatch(mutationRequest(), authContext([]), config),
    (err) => err.code === "FORBIDDEN" && err.statusCode === 403
  );
  await assert.rejects(
    () => dispatch(mutationRequest(), authContext(["payment:confirm"], csrfToken), config),
    (err) => err.code === "CSRF_VALIDATION_FAILED" && err.statusCode === 403
  );
  await assert.rejects(
    () => dispatch(mutationRequest(csrfToken), authContext(["payment:confirm"], csrfToken), config),
    (err) => err.code === "IDEMPOTENCY_KEY_REQUIRED" && err.statusCode === 400
  );
});

test("settings update remains behind permission and CSRF with no migrated write service", async () => {
  const csrfToken = "current-csrf-token";
  const request = {
    ...mutationRequest(csrfToken),
    route: { action: "mutate", resource: "settings", mutationAction: "update" }
  };
  await assert.rejects(
    () => dispatch(request, authContext([], csrfToken), config),
    (err) => err.code === "FORBIDDEN" && err.statusCode === 403
  );
  await assert.rejects(
    () => dispatch({ ...request, headers: {} }, authContext(["system:settings"], csrfToken), config),
    (err) => err.code === "CSRF_VALIDATION_FAILED" && err.statusCode === 403
  );
  await assert.rejects(
    () => dispatch(request, authContext(["system:settings"], csrfToken), config),
    (err) => err.code === "SERVICE_NOT_MIGRATED" && err.statusCode === 501
  );
});
