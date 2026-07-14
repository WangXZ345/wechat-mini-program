const crypto = require("crypto");

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const PAYMENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFUND_TTL_SECONDS = 90 * 24 * 60 * 60;
const PROCESSING_TIMEOUT_SECONDS = 30 * 60;

const IGNORED_PAYLOAD_KEYS = new Set([
  "loading",
  "submitting",
  "timestamp",
  "clientTimestamp",
  "frontendTimestamp",
  "_t",
  "_ts",
  "idempotencyKey"
]);

const SENSITIVE_KEY_PATTERN = /(phone|mobile|address|bank|card|password|secret|token|key|openid|screenshot|fileid|url)/i;

function nowDate() {
  return new Date();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function assertIdempotencyKey(idempotencyKey) {
  const key = String(idempotencyKey || "").trim();
  if (!key) {
    const err = new Error("缺少操作凭证，请刷新后重试");
    err.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw err;
  }
  if (key.length < 8 || key.length > 160) {
    const err = new Error("操作凭证格式无效，请刷新后重试");
    err.code = "IDEMPOTENCY_KEY_INVALID";
    throw err;
  }
  if (!/^[A-Za-z0-9_.*:-]+$/.test(key)) {
    const err = new Error("操作凭证格式无效，请刷新后重试");
    err.code = "IDEMPOTENCY_KEY_INVALID";
    throw err;
  }
  return key;
}

function buildIdempotencyRecordId(actionType, operatorIdentity, idempotencyKey) {
  const raw = `${actionType || ""}:${operatorIdentity || ""}:${idempotencyKey || ""}`;
  return `idem_${sha256(raw).slice(0, 48)}`;
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function normalizePayload(value) {
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (!isPlainObject(value)) return value;
  const out = {};
  Object.keys(value).sort().forEach((key) => {
    if (IGNORED_PAYLOAD_KEYS.has(key)) return;
    const item = value[key];
    if (item === undefined || typeof item === "function") return;
    out[key] = normalizePayload(item);
  });
  return out;
}

function hashPayload(payload) {
  return sha256(JSON.stringify(normalizePayload(payload || {})));
}

function maskText(value, visible = 4) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= visible * 2) return `${text.slice(0, 1)}***${text.slice(-1)}`;
  return `${text.slice(0, visible)}***${text.slice(-visible)}`;
}

function maskPayload(value, keyName = "") {
  if (Array.isArray(value)) return value.map((item) => maskPayload(item, keyName));
  if (isPlainObject(value)) {
    const out = {};
    Object.keys(value).sort().forEach((key) => {
      if (IGNORED_PAYLOAD_KEYS.has(key)) return;
      out[key] = maskPayload(value[key], key);
    });
    return out;
  }
  if (value === undefined || typeof value === "function") return undefined;
  if (SENSITIVE_KEY_PATTERN.test(keyName)) return maskText(value);
  return value;
}

function isDuplicateKeyError(err) {
  const message = String((err && (err.message || err.errMsg)) || err || "");
  return /duplicate|duplicated|already exists|already exist|document exists|E11000|DATABASE_DUPLICATE_KEY/i.test(message);
}

async function ensureCollection(db, name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) return;
    if (/createCollection is not a function/i.test(message)) return;
    throw err;
  }
}

function expiresAtFor(actionType, ttlSeconds) {
  const action = String(actionType || "");
  const seconds = Number(ttlSeconds || (
    /refund/.test(action) ? REFUND_TTL_SECONDS
      : /payment|pay/.test(action) ? PAYMENT_TTL_SECONDS
        : DEFAULT_TTL_SECONDS
  ));
  return new Date(Date.now() + Math.max(60, seconds) * 1000);
}

function processingTimedOut(record, timeoutSeconds) {
  if (!record || record.status !== "processing" || !record.lockedAt) return false;
  const lockedAt = record.lockedAt instanceof Date ? record.lockedAt.getTime() : new Date(record.lockedAt).getTime();
  return Number.isFinite(lockedAt) && Date.now() - lockedAt > Math.max(1, Number(timeoutSeconds || PROCESSING_TIMEOUT_SECONDS)) * 1000;
}

async function beginIdempotentAction(options = {}) {
  const {
    db,
    actionType,
    operatorIdentity,
    operatorType = "user",
    scope = "",
    scopeId = "",
    payload = {},
    ttlSeconds,
    openid = "",
    userId = "",
    adminId = "",
    allowRetryOnFailed = true,
    allowPayloadMismatchForSameScope = false,
    processingTimeoutSeconds = PROCESSING_TIMEOUT_SECONDS
  } = options;
  if (!db) throw new Error("缺少数据库实例");
  const idempotencyKey = assertIdempotencyKey(options.idempotencyKey);
  const identity = String(operatorIdentity || openid || adminId || userId || "system");
  const recordId = buildIdempotencyRecordId(actionType, identity, idempotencyKey);
  const requestHash = hashPayload(payload);
  const now = nowDate();
  const baseRecord = {
    _id: recordId,
    idempotencyKey,
    actionType,
    scope,
    scopeId: scopeId || "",
    operatorIdentity: identity,
    openid: openid || "",
    userId: userId || "",
    adminId: adminId || "",
    operatorType,
    requestHash,
    requestPayloadMasked: maskPayload(payload),
    status: "processing",
    resultRef: null,
    resultDataMasked: null,
    errorCode: "",
    errorMessage: "",
    lockedAt: now,
    finishedAt: null,
    expiresAt: expiresAtFor(actionType, ttlSeconds),
    retryCount: 0,
    createdAt: now,
    updatedAt: now
  };

  await ensureCollection(db, "idempotency_records");
  try {
    await db.collection("idempotency_records").add({ data: baseRecord });
    return { canExecute: true, recordId, record: baseRecord, requestHash, idempotencyKey };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  const existing = (await db.collection("idempotency_records").doc(recordId).get()).data;
  if (!existing) {
    await db.collection("idempotency_records").doc(recordId).set({ data: baseRecord });
    return { canExecute: true, recordId, record: baseRecord, requestHash, idempotencyKey };
  }
  const sameScope = existing.actionType === actionType
    && String(existing.operatorIdentity || "") === identity
    && String(existing.scope || "") === String(scope || "")
    && String(existing.scopeId || "") === String(scopeId || "");
  const canIgnorePayloadMismatch = allowPayloadMismatchForSameScope && sameScope;
  if (existing.requestHash !== requestHash && !canIgnorePayloadMismatch) {
    await db.collection("idempotency_records").doc(recordId).update({
      data: {
        status: "conflict",
        errorCode: "IDEMPOTENCY_KEY_CONFLICT",
        errorMessage: "请求已被用于其他操作，请刷新后重试",
        updatedAt: now
      }
    }).catch(() => null);
    return { canExecute: false, recordId, status: "conflict", record: existing };
  }
  if (existing.status === "success") {
    return { canExecute: false, recordId, status: "success", record: existing };
  }
  if (existing.status === "processing" && !processingTimedOut(existing, processingTimeoutSeconds)) {
    return { canExecute: false, recordId, status: "processing", record: existing };
  }
  const canRetryConflict = existing.status === "conflict" && canIgnorePayloadMismatch && allowRetryOnFailed;
  if ((existing.status === "failed" && allowRetryOnFailed) || canRetryConflict || processingTimedOut(existing, processingTimeoutSeconds) || existing.status === "expired") {
    await db.collection("idempotency_records").doc(recordId).update({
      data: {
        status: "processing",
        requestHash,
        requestPayloadMasked: maskPayload(payload),
        errorCode: "",
        errorMessage: "",
        lockedAt: now,
        updatedAt: now,
        expiresAt: expiresAtFor(actionType, ttlSeconds),
        retryCount: Number(existing.retryCount || 0) + 1
      }
    });
    return {
      canExecute: true,
      recordId,
      record: { ...existing, status: "processing", retryCount: Number(existing.retryCount || 0) + 1 },
      requestHash,
      idempotencyKey
    };
  }
  return { canExecute: false, recordId, status: existing.status || "failed", record: existing };
}

function resultRefFromData(data = {}) {
  return {
    type: data.type || "",
    id: data.id || data.orderId || data.paymentRecordId || data.refundRecordId || data.importRecordId || data.shipmentGroupId || data.afterSaleId || "",
    orderId: data.orderId || "",
    orderNo: data.orderNo || "",
    paymentRecordId: data.paymentRecordId || "",
    refundRecordId: data.refundRecordId || "",
    importRecordId: data.importRecordId || "",
    shipmentGroupId: data.shipmentGroupId || "",
    afterSaleId: data.afterSaleId || ""
  };
}

async function finishIdempotentAction(dbOrRecordId, recordIdOrResult, maybeResult) {
  const db = maybeResult === undefined ? null : dbOrRecordId;
  const recordId = maybeResult === undefined ? dbOrRecordId : recordIdOrResult;
  const result = maybeResult === undefined ? recordIdOrResult : maybeResult;
  if (!db) throw new Error("finishIdempotentAction requires db as first argument in this project");
  const data = result && result.data ? result.data : result || {};
  await db.collection("idempotency_records").doc(recordId).update({
    data: {
      status: "success",
      resultRef: result.resultRef || resultRefFromData(data),
      resultDataMasked: maskPayload(data),
      errorCode: "",
      errorMessage: "",
      finishedAt: nowDate(),
      updatedAt: nowDate()
    }
  });
}

async function failIdempotentAction(db, recordId, error = {}) {
  if (!db || !recordId) return;
  await db.collection("idempotency_records").doc(recordId).update({
    data: {
      status: "failed",
      errorCode: error.code || error.errCode || "",
      errorMessage: String(error.message || error || "操作失败").slice(0, 300),
      finishedAt: nowDate(),
      updatedAt: nowDate()
    }
  }).catch(() => null);
}

function isDuplicateSuccess(record) {
  return record && record.status === "success";
}

function duplicateSuccessData(record) {
  return {
    ...(record && record.resultDataMasked || {}),
    duplicate: true,
    idempotencyStatus: "success"
  };
}

function firstSuccessData(data = {}) {
  return {
    ...data,
    duplicate: false,
    idempotencyStatus: "success"
  };
}

function idempotencyEarlyReturn(beginResult) {
  const status = beginResult && (beginResult.status || beginResult.record && beginResult.record.status);
  if (status === "success") return { ok: true, data: duplicateSuccessData(beginResult.record) };
  if (status === "conflict") {
    return {
      ok: false,
      code: "IDEMPOTENCY_KEY_CONFLICT",
      message: "请求已被用于其他操作，请刷新后重试",
      data: { duplicate: true, idempotencyStatus: "conflict" }
    };
  }
  if (status === "processing") {
    return {
      ok: false,
      code: "IDEMPOTENCY_PROCESSING",
      message: "操作正在处理中，请稍候",
      data: { duplicate: true, idempotencyStatus: "processing" }
    };
  }
  return null;
}

function idempotencyErrorResponse(error) {
  if (!error || !/^IDEMPOTENCY_/.test(error.code || "")) return null;
  return {
    ok: false,
    code: error.code,
    message: error.message || "幂等处理失败",
    data: {
      duplicate: error.code !== "IDEMPOTENCY_KEY_REQUIRED",
      idempotencyStatus: error.code === "IDEMPOTENCY_KEY_CONFLICT" ? "conflict" : "failed"
    }
  };
}

async function runIdempotentAction(options, executor) {
  let begin = null;
  try {
    begin = await beginIdempotentAction(options);
    const early = idempotencyEarlyReturn(begin);
    if (early) return early;
    const data = await executor(begin);
    const successData = firstSuccessData(data || {});
    await finishIdempotentAction(options.db, begin.recordId, { data: successData });
    return { ok: true, data: successData };
  } catch (err) {
    if (begin && begin.recordId) await failIdempotentAction(options.db, begin.recordId, err);
    const idempotencyError = idempotencyErrorResponse(err);
    if (idempotencyError) return idempotencyError;
    throw err;
  }
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  PAYMENT_TTL_SECONDS,
  REFUND_TTL_SECONDS,
  PROCESSING_TIMEOUT_SECONDS,
  assertIdempotencyKey,
  buildIdempotencyRecordId,
  hashPayload,
  maskPayload,
  beginIdempotentAction,
  finishIdempotentAction,
  failIdempotentAction,
  isDuplicateSuccess,
  duplicateSuccessData,
  firstSuccessData,
  idempotencyEarlyReturn,
  idempotencyErrorResponse,
  runIdempotentAction,
  ensureCollection
};
