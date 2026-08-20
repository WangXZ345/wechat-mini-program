"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSystemSettingsService, normalizeSettingsInput } = require("./systemSettingsService");

function clone(value) {
  return structuredClone(value);
}

function missing(id) {
  const error = new Error(`document not exist: ${id}`);
  error.code = "DOCUMENT_NOT_EXIST";
  return error;
}

function database(initial = {}, options = {}) {
  let state = clone({
    settings: [],
    payment_method_logs: [],
    admin_operation_logs: [],
    sync_events: [],
    ...initial
  });
  let sequence = 0;

  function collection(store, name) {
    const rows = store[name];
    if (!Array.isArray(rows)) throw new Error(`collection not exists: ${name}`);
    return {
      doc(id) {
        return {
          async get() {
            const row = rows.find((item) => item._id === id);
            if (!row) throw missing(id);
            return { data: clone(row) };
          },
          async update({ data }) {
            const index = rows.findIndex((item) => item._id === id);
            if (index < 0) throw missing(id);
            rows[index] = { ...rows[index], ...clone(data) };
          },
          async set({ data }) {
            const index = rows.findIndex((item) => item._id === id);
            const row = { _id: id, ...clone(data) };
            if (index < 0) rows.push(row);
            else rows[index] = row;
          }
        };
      },
      where(condition) {
        const query = {
          limit() { return query; },
          async get() {
            return { data: clone(rows.filter((row) => Object.entries(condition).every(([key, value]) => row[key] === value))) };
          }
        };
        return query;
      },
      async add({ data }) {
        if (options.failAddCollection === name) throw new Error(`simulated ${name} failure`);
        sequence += 1;
        const row = { _id: `${name}-${sequence}`, ...clone(data) };
        rows.push(row);
        return { _id: row._id };
      }
    };
  }

  return {
    collection(name) { return collection(state, name); },
    serverDate() { return new Date("2026-08-15T05:00:00.000Z"); },
    async runTransaction(callback) {
      const working = clone(state);
      const result = await callback({ collection: (name) => collection(working, name) });
      state = working;
      return result;
    },
    snapshot() { return clone(state); }
  };
}

function idempotency() {
  const records = new Map();
  return {
    assertIdempotencyKey(value) {
      const key = String(value || "").trim();
      if (key.length < 8) {
        const error = new Error(key ? "操作凭证格式无效" : "缺少操作凭证");
        error.code = key ? "IDEMPOTENCY_KEY_INVALID" : "IDEMPOTENCY_KEY_REQUIRED";
        throw error;
      }
      return key;
    },
    async runIdempotentAction(config, executor) {
      const identity = `${config.actionType}:${config.operatorIdentity}:${config.idempotencyKey}`;
      const fingerprint = JSON.stringify(config.payload);
      const prior = records.get(identity);
      if (prior && prior.fingerprint !== fingerprint) {
        return { ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", message: "请求已被用于其他操作" };
      }
      if (prior) return { ok: true, data: { ...clone(prior.data), duplicate: true } };
      const data = await executor();
      records.set(identity, { fingerprint, data: clone(data) });
      return { ok: true, data: { ...clone(data), duplicate: false } };
    }
  };
}

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

function actor(overrides = {}) {
  return {
    id: "admin-1",
    openid: "private-openid",
    role: "super_admin",
    permissions: ["system:settings"],
    status: "active",
    isActive: true,
    sourceClient: "admin_web",
    ...overrides
  };
}

function setup(rows, options = {}) {
  const db = database({ settings: rows ? [rows] : [] }, options.database);
  return {
    db,
    service: createSystemSettingsService({
      db,
      idempotency: idempotency(),
      now: () => new Date("2026-08-15T05:00:00.000Z")
    })
  };
}

function command(overrides = {}) {
  return {
    actor: actor(),
    input: SETTINGS,
    expectedVersion: 2,
    idempotencyKey: "settings-save-key-0001",
    requestId: "request-settings-1",
    strict: true,
    ...overrides
  };
}

test("strict field table rejects coercion, unknown or masked fields, bad ranges, and enabling WeChat Pay", () => {
  assert.deepEqual(normalizeSettingsInput(SETTINGS), SETTINGS);
  for (const invalid of [
    { ...SETTINGS, enableBankTransfer: 1 },
    { ...SETTINGS, maxPaymentScreenshotCount: 10 },
    { ...SETTINGS, lowStockDefaultThreshold: -1 },
    { ...SETTINGS, sessionIdleMinutes: 4 },
    { ...SETTINGS, bankCardNoMasked: "**** 1234" },
    { ...SETTINGS, merchantKey: "masked-secret" }
  ]) {
    assert.throws(() => normalizeSettingsInput(invalid), (error) => error.code === "SETTINGS_INPUT_INVALID");
  }
  assert.throws(
    () => normalizeSettingsInput({ ...SETTINGS, enableWechatPay: true }),
    (error) => error.code === "WECHAT_PAY_NOT_CONFIGURED"
  );
});

test("save uses CAS and commits settings, safe payment log, operation log, and sync event atomically", async () => {
  const current = setup({ _id: "system_settings", ...SETTINGS, enableBankTransfer: true, version: 2, preserved: "keep" });
  const result = await current.service.saveSettings(command());
  const state = current.db.snapshot();

  assert.equal(result.version, 3);
  assert.equal(result.changed, true);
  assert.deepEqual(result.changedFields, ["enableBankTransfer"]);
  assert.equal(state.settings[0].enableBankTransfer, false);
  assert.equal(state.settings[0].preserved, "keep");
  assert.equal(state.payment_method_logs.length, 1);
  assert.equal(state.admin_operation_logs.length, 1);
  assert.equal(state.sync_events.length, 1);
  assert.equal(state.sync_events[0].eventType, "settings.updated");
  const serialized = JSON.stringify({ payment: state.payment_method_logs[0], operation: state.admin_operation_logs[0], event: state.sync_events[0] });
  for (const forbidden of ["private-openid", "settings-save-key-0001", "merchantKey", "bankCardNo", "qrCodeFileID", "paymentProofUrl"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("no-op is zero-write, replay is single-write, changed payload conflicts, and stale version fails", async () => {
  const current = setup({ _id: "system_settings", ...SETTINGS, version: 2 });
  const noOp = await current.service.saveSettings(command());
  assert.equal(noOp.changed, false);
  assert.equal(noOp.version, 2);
  assert.equal(current.db.snapshot().admin_operation_logs.length, 0);

  const changed = command({ input: { ...SETTINGS, lowStockDefaultThreshold: 61 }, idempotencyKey: "settings-change-key-0001" });
  const first = await current.service.saveSettings(changed);
  const replay = await current.service.saveSettings(changed);
  assert.equal(first.version, 3);
  assert.equal(replay.duplicate, true);
  assert.equal(current.db.snapshot().admin_operation_logs.length, 1);

  await assert.rejects(
    current.service.saveSettings({ ...changed, input: { ...changed.input, lowStockDefaultThreshold: 62 } }),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT"
  );
  await assert.rejects(
    current.service.saveSettings(command({ expectedVersion: 1, idempotencyKey: "settings-stale-key-0001" })),
    (error) => error.code === "DATA_VERSION_CONFLICT" && error.details.currentVersion === 3
  );
});

test("only active super admins can save and a sync failure rolls back every business write", async () => {
  for (const denied of [
    actor({ role: "finance" }),
    actor({ permissions: [] }),
    actor({ status: "disabled", isActive: false })
  ]) {
    const current = setup({ _id: "system_settings", ...SETTINGS, version: 2 });
    await assert.rejects(current.service.saveSettings(command({ actor: denied })), (error) => error.code === "FORBIDDEN");
  }

  const failing = setup(
    { _id: "system_settings", ...SETTINGS, enableBankTransfer: true, version: 2 },
    { database: { failAddCollection: "sync_events" } }
  );
  await assert.rejects(failing.service.saveSettings(command()), /simulated sync_events failure/);
  const state = failing.db.snapshot();
  assert.equal(state.settings[0].enableBankTransfer, true);
  assert.equal(state.settings[0].version, 2);
  assert.equal(state.payment_method_logs.length, 0);
  assert.equal(state.admin_operation_logs.length, 0);
});
