const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const api = require("../index");
const { parseHttpRoute } = require("../lib/core");

const tokenPepper = "s".repeat(32);
const csrfToken = "csrf-token-for-settings-save";
const config = { tokenPepper };
const SETTINGS = Object.freeze({
  enableOfflineQrPayment: true,
  enableBankTransfer: false,
  enableWechatPay: false,
  requirePaymentProofForOfflinePayment: true,
  allowMultiplePaymentRecords: false,
  maxPaymentScreenshotCount: 4,
  lowStockDefaultThreshold: 60,
  sessionIdleMinutes: 45
});

function auth(overrides = {}) {
  return {
    principal: {
      id: "admin-session-id",
      role: "super_admin",
      status: "active",
      isActive: true,
      permissions: ["*"],
      ...overrides.principal
    },
    rawAdmin: { _id: "admin-session-id", openid: "private-openid" },
    session: {
      csrfTokenHash: security.tokenHash(csrfToken, tokenPepper),
      ...overrides.session
    }
  };
}

function request(overrides = {}) {
  return {
    http: true,
    route: { action: "mutate", resource: "settings", mutationAction: "update" },
    body: { ...SETTINGS, expectedVersion: 2 },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": "settings-save-key-0001" },
    requestId: "request-settings-1",
    ...overrides
  };
}

test("settings update has an explicit strict route and HTTP path", () => {
  const { settingsMutationRoute, normalizeSettingsMutation } = api._test;
  assert.equal(settingsMutationRoute({ resource: "settings", mutationAction: "update" }), true);
  assert.equal(settingsMutationRoute({ resource: "settings", mutationAction: "create" }), false);
  assert.deepEqual(parseHttpRoute("/api/admin/v1/settings/update", "POST"), {
    action: "mutate", resource: "settings", mutationAction: "update"
  });
  assert.deepEqual(normalizeSettingsMutation(request()), {
    idempotencyKey: "settings-save-key-0001",
    expectedVersion: 2,
    input: SETTINGS
  });
});

test("settings route rejects aliases, partial data and client identity fields", () => {
  const { normalizeSettingsMutation } = api._test;
  for (const body of [
    { ...SETTINGS, expectedVersion: "2" },
    { ...SETTINGS, expectedVersion: 2, lowStockDefaultThreshold: "60" },
    { ...SETTINGS, expectedVersion: 2, actor: { role: "super_admin" } },
    { ...SETTINGS, expectedVersion: 2, bankCardNoMasked: "**** 1234" },
    { ...SETTINGS, expectedVersion: 2, unknown: true },
    { enableOfflineQrPayment: true, expectedVersion: 2 }
  ]) {
    assert.throws(() => normalizeSettingsMutation(request({ body })), (error) => error.statusCode === 400);
  }
});

test("settings route derives only the active super-admin session and projects a safe MutationResult", async () => {
  const { dispatch } = api._test;
  let command;
  const result = await dispatch(request(), auth(), config, {
    systemSettingsService: {
      async saveSettings(value) {
        command = value;
        return { id: "system", version: 3, ...SETTINGS, updatedAt: new Date("2026-08-15T05:00:00.000Z"), changed: true, changedFields: ["enableBankTransfer"] };
      }
    }
  });
  assert.deepEqual(command, {
    actor: {
      id: "admin-session-id",
      openid: "private-openid",
      role: "super_admin",
      status: "active",
      isActive: true,
      permissions: ["*"],
      sourceClient: "admin_web"
    },
    input: SETTINGS,
    expectedVersion: 2,
    idempotencyKey: "settings-save-key-0001",
    requestId: "request-settings-1",
    strict: true
  });
  assert.deepEqual(result, {
    item: {
      id: "system", version: 3, ...SETTINGS, updatedAt: "2026-08-15T05:00:00.000Z"
    },
    affected: 1,
    message: "系统设置已保存",
    requestId: "request-settings-1"
  });
  assert.equal(JSON.stringify(result).includes("private-openid"), false);
});

test("permission and CSRF reject before settings body parsing or service execution", async () => {
  const { dispatch } = api._test;
  let calls = 0;
  const dependencies = { systemSettingsService: { async saveSettings() { calls += 1; } } };
  await assert.rejects(dispatch(request(), auth({ principal: { role: "finance", permissions: [] } }), config, dependencies), (error) => error.code === "FORBIDDEN");
  await assert.rejects(dispatch(request({ headers: {} }), auth(), config, dependencies), (error) => error.code === "CSRF_VALIDATION_FAILED");
  assert.equal(calls, 0);
});

test("settings service errors are mapped without leaking storage details", async () => {
  const { dispatch } = api._test;
  await assert.rejects(
    dispatch(request(), auth(), config, {
      systemSettingsService: {
        async saveSettings() {
          const error = new Error("settings/system_settings contains private-openid");
          error.code = "DATA_VERSION_CONFLICT";
          error.statusCode = 409;
          error.details = { currentVersion: 3, storage: "settings/system_settings" };
          throw error;
        }
      }
    }),
    (error) => error.code === "DATA_VERSION_CONFLICT" && error.statusCode === 409 && error.details.currentVersion === 3 && !JSON.stringify(error).includes("private-openid")
  );
});
