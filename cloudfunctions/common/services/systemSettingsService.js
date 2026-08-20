"use strict";

const crypto = require("crypto");
const { buildSyncEvent, writeOperationBundle } = require("./operationOutbox");

const DOCUMENT_ID = "system_settings";
const ACTION_TYPE = "settings_update";
const FIELDS = Object.freeze([
  "enableOfflineQrPayment",
  "enableBankTransfer",
  "enableWechatPay",
  "requirePaymentProofForOfflinePayment",
  "allowMultiplePaymentRecords",
  "maxPaymentScreenshotCount",
  "lowStockDefaultThreshold",
  "sessionIdleMinutes"
]);
const PAYMENT_FIELDS = new Set([
  "enableOfflineQrPayment",
  "enableBankTransfer",
  "enableWechatPay",
  "requirePaymentProofForOfflinePayment",
  "allowMultiplePaymentRecords",
  "maxPaymentScreenshotCount"
]);

class SystemSettingsError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "SystemSettingsError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function missingDocument(error) {
  return /document not exist|document_not_exist|not found/i.test(String(error && error.message || error || ""));
}

function safeVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) return 0;
  return version;
}

function defaults(row = {}) {
  return {
    enableOfflineQrPayment: row.enableOfflineQrPayment !== false,
    enableBankTransfer: row.enableBankTransfer !== false,
    enableWechatPay: row.enableWechatPay === true,
    requirePaymentProofForOfflinePayment: row.requirePaymentProofForOfflinePayment !== false,
    allowMultiplePaymentRecords: row.allowMultiplePaymentRecords !== false,
    maxPaymentScreenshotCount: Math.max(1, Math.min(9, Number.isSafeInteger(row.maxPaymentScreenshotCount) ? row.maxPaymentScreenshotCount : 3)),
    lowStockDefaultThreshold: Math.max(0, Math.min(99999, Number.isSafeInteger(row.lowStockDefaultThreshold) ? row.lowStockDefaultThreshold : 50)),
    sessionIdleMinutes: Math.max(5, Math.min(240, Number.isSafeInteger(row.sessionIdleMinutes) ? row.sessionIdleMinutes : 30))
  };
}

function publicRecord(row = {}) {
  return {
    id: "system",
    version: safeVersion(row.version ?? row.dataVersion),
    ...defaults(row),
    updatedAt: row.updatedAt || null
  };
}

function invalid(message) {
  throw new SystemSettingsError("SETTINGS_INPUT_INVALID", message, 400);
}

function normalizeSettingsInput(input = {}, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("系统设置必须是对象");
  const strict = options.strict !== false;
  const unknown = Object.keys(input).find((key) => !FIELDS.includes(key));
  if (unknown) invalid("系统设置包含不允许的字段");
  const result = {};
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      if (strict) invalid("系统设置字段不完整");
      continue;
    }
    const value = input[field];
    if (["enableOfflineQrPayment", "enableBankTransfer", "enableWechatPay", "requirePaymentProofForOfflinePayment", "allowMultiplePaymentRecords"].includes(field)) {
      if (typeof value !== "boolean") invalid("系统设置布尔值无效");
      result[field] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid("系统设置整数无效");
    const [min, max] = field === "maxPaymentScreenshotCount" ? [1, 9]
      : field === "lowStockDefaultThreshold" ? [0, 99999] : [5, 240];
    if (value < min || value > max) invalid("系统设置整数超出允许范围");
    result[field] = value;
  }
  if (result.enableWechatPay === true) {
    throw new SystemSettingsError("WECHAT_PAY_NOT_CONFIGURED", "微信支付尚未完成安全配置，不能通过系统设置启用", 409);
  }
  return result;
}

function assertActor(actor = {}) {
  if (actor.role !== "super_admin" || actor.status !== "active" || actor.isActive === false
    || (!Array.isArray(actor.permissions) || (!actor.permissions.includes("*") && !actor.permissions.includes("system:settings")))) {
    throw new SystemSettingsError("FORBIDDEN", "无权保存系统设置", 403);
  }
  const id = cleanString(actor.id || actor._id, 128);
  if (!id) throw new SystemSettingsError("FORBIDDEN", "管理员身份无效", 403);
  return { id, role: "super_admin", sourceClient: "admin_web" };
}

function digest(value) {
  return crypto.createHash("sha256").update(cleanString(value, 1024)).digest("hex").slice(0, 40);
}

function paymentSnapshot(record = {}) {
  const output = {};
  for (const field of PAYMENT_FIELDS) output[field] = record[field];
  return output;
}

function changedFields(before, after, fields) {
  return fields.filter((field) => before[field] !== after[field]);
}

function errorFromOutcome(outcome) {
  if (outcome && outcome.ok === true) return null;
  return new SystemSettingsError(
    cleanString(outcome && outcome.code, 80) || "IDEMPOTENCY_FAILED",
    cleanString(outcome && outcome.message, 240) || "设置保存幂等校验失败",
    outcome && outcome.code === "IDEMPOTENCY_KEY_CONFLICT" ? 409 : 400
  );
}

function createSystemSettingsService({ db, idempotency, now = () => new Date() } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("system settings service requires db.runTransaction");
  if (!idempotency || typeof idempotency.assertIdempotencyKey !== "function" || typeof idempotency.runIdempotentAction !== "function") {
    throw new Error("system settings service requires idempotency helpers");
  }

  async function readCurrent(store) {
    try {
      const result = await store.collection("settings").doc(DOCUMENT_ID).get();
      return result && result.data ? result.data : null;
    } catch (error) {
      if (missingDocument(error)) return null;
      throw error;
    }
  }

  async function execute(command, actor, normalized, idempotencyKey) {
    return db.runTransaction(async (transaction) => {
      const current = await readCurrent(transaction);
      const currentPublic = publicRecord(current || {});
      const expectedVersion = command.expectedVersion;
      if (expectedVersion !== undefined && expectedVersion !== currentPublic.version) {
        throw new SystemSettingsError("DATA_VERSION_CONFLICT", "设置已被其他管理员更新，请重新加载", 409, {
          currentVersion: currentPublic.version,
          refreshRequired: true
        });
      }
      const next = { ...currentPublic, ...normalized };
      const fields = Object.keys(normalized);
      const changes = changedFields(currentPublic, next, fields);
      if (!changes.length) {
        return { ...currentPublic, changed: false, duplicate: false, changedFields: [] };
      }
      const timestamp = db.serverDate();
      const nextVersion = currentPublic.version + 1;
      const update = {
        ...normalized,
        version: nextVersion,
        updatedAt: timestamp,
        updatedBy: actor.id,
        updatedByRole: actor.role
      };
      if (current) await transaction.collection("settings").doc(DOCUMENT_ID).update({ data: update });
      else await transaction.collection("settings").doc(DOCUMENT_ID).set({ data: update });

      const beforePayment = paymentSnapshot(currentPublic);
      const afterPayment = paymentSnapshot(next);
      if (changes.some((field) => PAYMENT_FIELDS.has(field))) {
        await transaction.collection("payment_method_logs").add({
          data: {
            paymentMethodId: "",
            action: "update_system_settings",
            beforeDataMasked: beforePayment,
            afterDataMasked: afterPayment,
            operatorId: actor.id,
            operatorRole: actor.role,
            createdAt: timestamp
          }
        });
      }

      const businessKey = `settings:${digest(`${actor.id}:${idempotencyKey || command.requestId || nextVersion}`)}`;
      const operation = {
        operator: actor,
        action: "update_settings",
        resourceType: "settings",
        resourceId: DOCUMENT_ID,
        requestId: cleanString(command.requestId, 128),
        businessKey,
        idempotencyKey,
        sourceClient: actor.sourceClient,
        changedFields: ["updatedAt", "version"],
        before: { version: currentPublic.version },
        after: { version: nextVersion },
        result: { status: "success", affected: 1, changed: true },
        timestamp: now()
      };
      const event = buildSyncEvent({
        ...operation,
        eventType: "settings.updated",
        entityType: "settings",
        entityId: DOCUMENT_ID,
        version: nextVersion,
        updatedAt: now(),
        audienceRoles: ["super_admin"]
      });
      await writeOperationBundle(transaction, { operation, events: [event] });
      return {
        ...next,
        version: nextVersion,
        updatedAt: timestamp,
        changed: true,
        duplicate: false,
        changedFields: changes
      };
    });
  }

  async function saveSettings(command = {}) {
    const actor = assertActor(command.actor);
    const strict = command.strict !== false;
    const normalized = normalizeSettingsInput(command.input, { strict });
    if (strict && (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0)) {
      throw new SystemSettingsError(command.expectedVersion === undefined ? "EXPECTED_VERSION_REQUIRED" : "EXPECTED_VERSION_INVALID", "缺少有效版本，请重新加载", 400);
    }
    if (!strict && command.expectedVersion !== undefined && (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0)) {
      throw new SystemSettingsError("EXPECTED_VERSION_INVALID", "设置版本无效", 400);
    }
    let idempotencyKey = "";
    if (strict || command.idempotencyKey) {
      try {
        idempotencyKey = idempotency.assertIdempotencyKey(command.idempotencyKey);
      } catch (error) {
        throw new SystemSettingsError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
      }
    }
    const run = () => execute(command, actor, normalized, idempotencyKey);
    if (!idempotencyKey) return run();
    const outcome = await idempotency.runIdempotentAction({
      db,
      actionType: ACTION_TYPE,
      idempotencyKey,
      operatorIdentity: actor.id,
      operatorType: "admin",
      scope: "settings",
      scopeId: DOCUMENT_ID,
      requestId: cleanString(command.requestId, 128),
      payload: { input: normalized, expectedVersion: command.expectedVersion }
    }, run);
    const failure = errorFromOutcome(outcome);
    if (failure) throw failure;
    return outcome.data;
  }

  return { readSettings: async () => publicRecord((await readCurrent(db)) || {}), saveSettings };
}

module.exports = {
  ACTION_TYPE,
  DOCUMENT_ID,
  FIELDS,
  PAYMENT_FIELDS,
  SystemSettingsError,
  createSystemSettingsService,
  defaults,
  normalizeSettingsInput,
  publicRecord
};
