const crypto = require("crypto");

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const PAYMENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFUND_TTL_SECONDS = 90 * 24 * 60 * 60;
const PROCESSING_TIMEOUT_SECONDS = 30 * 60;
const IDEMPOTENCY_PROCESSING_RETRY_SECONDS = 2;

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

function shortDigest(value) {
  return sha256(value).slice(0, 16);
}

function newExecutionToken() {
  return crypto.randomBytes(16).toString("hex");
}

function safeRequestId(value) {
  const requestId = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(requestId) ? requestId : "";
}

class WriteProtectionError extends Error {
  constructor(code, message, statusCode = 409, details) {
    super(message);
    this.name = "WriteProtectionError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
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

function fingerprintPayload(payload) {
  return hashPayload(payload);
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
  if (!record || record.status !== "processing") return false;
  const candidates = [record.lockedAt, record.updatedAt, record.createdAt];
  let startedAt = NaN;
  for (const value of candidates) {
    if (!value) continue;
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (Number.isFinite(time)) {
      startedAt = time;
      break;
    }
  }
  if (!Number.isFinite(startedAt)) return true;
  return Date.now() - startedAt > Math.max(60, Number(timeoutSeconds || PROCESSING_TIMEOUT_SECONDS)) * 1000;
}

function isMissingDocumentError(error) {
  const message = String(error && (error.message || error.errMsg) || error || "");
  return /document.*(?:not|does not).*exist|DATABASE_DOCUMENT_NOT_EXIST|not found/i.test(message);
}

async function getDocumentOrNull(source, collectionName, documentId) {
  try {
    const response = await source.collection(collectionName).doc(documentId).get();
    return response && response.data || null;
  } catch (error) {
    if (isMissingDocumentError(error)) return null;
    throw error;
  }
}

function retryFailedRecord(record, allowRetryOnFailed) {
  if (!record || record.status !== "failed") return false;
  if (typeof allowRetryOnFailed === "boolean") return allowRetryOnFailed;
  if (typeof record.retryable === "boolean") return record.retryable;
  return retryableFailure({ code: record.errorCode, category: record.errorCategory, statusCode: record.errorStatusCode });
}

function retryableFailure(error = {}) {
  if (error.retryable === true) return true;
  const code = String(error.code || error.errCode || "").toUpperCase();
  const category = String(error.category || "").toUpperCase();
  const statusCode = Number(error.statusCode || error.status || 0);
  const message = String(error.errMsg || error.message || "");
  return [
    "NETWORK_ERROR",
    "RATE_LIMITED",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNABORTED",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "DATABASE_REQUEST_FAILED",
    "DATABASE_TRANSACTION_CONFLICT"
  ].includes(code)
    || ["RATE_LIMITED", "NETWORK_ERROR"].includes(category)
    || statusCode === 429
    || /timed?\s*out|timeout|temporar(?:y|ily) unavailable|network error|connection reset/i.test(message);
}

function processingClaim({ existing, now, actionType, ttlSeconds, processingTimeoutSeconds, allowRetryOnFailed, executionToken }) {
  if (existing.status === "success") return { canExecute: false, status: "success" };
  if (existing.status === "processing") {
    return { canExecute: false, status: "processing" };
  }
  if (!retryFailedRecord(existing, allowRetryOnFailed) && existing.status !== "expired") {
    return { canExecute: false, status: existing.status || "failed" };
  }
  const retryCount = Number(existing.retryCount || 0) + 1;
  return {
    canExecute: true,
    previousStatus: existing.status || "",
    staleProcessing: false,
    retryCount,
    update: {
      status: "processing",
      errorCode: "",
      errorMessage: "",
      retryable: false,
      executionLeaseDigest: sha256(executionToken),
      executionAttempt: Number(existing.executionAttempt || 1) + 1,
      lockedAt: now,
      updatedAt: now,
      expiresAt: expiresAtFor(actionType, ttlSeconds),
      retryCount
    }
  };
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
    allowRetryOnFailed,
    processingTimeoutSeconds = PROCESSING_TIMEOUT_SECONDS
  } = options;
  if (!db) throw new Error("缺少数据库实例");
  const idempotencyKey = assertIdempotencyKey(options.idempotencyKey);
  const identity = String(operatorIdentity || openid || adminId || userId || "system");
  const recordId = buildIdempotencyRecordId(actionType, identity, idempotencyKey);
  const requestHash = hashPayload(payload);
  const now = nowDate();
  const executionToken = newExecutionToken();
  const baseRecord = {
    _id: recordId,
    idempotencyKeyDigest: shortDigest(idempotencyKey),
    actionType,
    scope,
    scopeId: scopeId || "",
    operatorIdentityDigest: shortDigest(identity),
    operatorType,
    requestId: safeRequestId(options.requestId),
    requestHash,
    status: "processing",
    resultRef: null,
    resultDataMasked: null,
    errorCode: "",
    errorMessage: "",
    retryable: false,
    executionLeaseDigest: sha256(executionToken),
    executionAttempt: 1,
    lockedAt: now,
    finishedAt: null,
    expiresAt: expiresAtFor(actionType, ttlSeconds),
    retryCount: 0,
    createdAt: now,
    updatedAt: now
  };

  await ensureCollection(db, "idempotency_records");
  if (typeof db.runTransaction === "function") {
    return db.runTransaction(async (transaction) => {
      const existing = await getDocumentOrNull(transaction, "idempotency_records", recordId);
      if (!existing) {
        const { _id, ...data } = baseRecord;
        await transaction.collection("idempotency_records").doc(recordId).set({ data });
        return { canExecute: true, recordId, record: baseRecord, requestHash, executionToken };
      }
      if (existing.requestHash !== requestHash) {
        return { canExecute: false, recordId, status: "conflict", record: existing };
      }
      const claim = processingClaim({ existing, now, actionType, ttlSeconds, processingTimeoutSeconds, allowRetryOnFailed, executionToken });
      if (!claim.canExecute) return { canExecute: false, recordId, status: claim.status, record: existing };
      await transaction.collection("idempotency_records").doc(recordId).update({ data: claim.update });
      return {
        canExecute: true,
        recordId,
        record: { ...existing, ...claim.update },
        previousStatus: claim.previousStatus,
        staleProcessing: claim.staleProcessing,
        requestHash,
        executionToken
      };
    });
  }

  try {
    await db.collection("idempotency_records").add({ data: baseRecord });
    return { canExecute: true, recordId, record: baseRecord, requestHash, executionToken };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  const existing = (await db.collection("idempotency_records").doc(recordId).get()).data;
  if (!existing) {
    await db.collection("idempotency_records").doc(recordId).set({ data: baseRecord });
    return { canExecute: true, recordId, record: baseRecord, requestHash, executionToken };
  }
  if (existing.requestHash !== requestHash) {
    return { canExecute: false, recordId, status: "conflict", record: existing };
  }
  const claim = processingClaim({ existing, now, actionType, ttlSeconds, processingTimeoutSeconds, allowRetryOnFailed, executionToken });
  if (claim.canExecute) {
    await db.collection("idempotency_records").doc(recordId).update({ data: claim.update });
    return {
      canExecute: true,
      recordId,
      record: { ...existing, ...claim.update },
      previousStatus: claim.previousStatus,
      staleProcessing: claim.staleProcessing,
      requestHash,
      executionToken
    };
  }
  return { canExecute: false, recordId, status: claim.status, record: existing };
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

function leaseLostError() {
  return new WriteProtectionError("IDEMPOTENCY_LEASE_LOST", "操作执行权已转移，忽略过期执行结果", 409);
}

async function updateOwnedIdempotencyRecord(db, recordId, executionToken, data) {
  if (!db || !recordId || !executionToken) throw leaseLostError();
  const expectedLeaseDigest = sha256(executionToken);
  const update = async (source) => {
    const current = await getDocumentOrNull(source, "idempotency_records", recordId);
    if (!current || current.status !== "processing" || current.executionLeaseDigest !== expectedLeaseDigest) {
      throw leaseLostError();
    }
    await source.collection("idempotency_records").doc(recordId).update({ data });
  };
  if (typeof db.runTransaction === "function") return db.runTransaction(update);
  return update(db);
}

async function finishRecoveredAction(db, recordId, expectedRecord, result) {
  if (!db || !recordId || !expectedRecord) throw leaseLostError();
  const data = result && result.data ? result.data : result || {};
  const finishData = {
    status: "success",
    resultRef: result.resultRef || resultRefFromData(data),
    resultDataMasked: maskPayload(data),
    errorCode: "",
    errorMessage: "",
    finishedAt: nowDate(),
    updatedAt: nowDate()
  };
  const recover = async (source) => {
    const current = await getDocumentOrNull(source, "idempotency_records", recordId);
    if (!current
      || current.requestHash !== expectedRecord.requestHash
      || current.status !== expectedRecord.status
      || Number(current.executionAttempt || 0) !== Number(expectedRecord.executionAttempt || 0)) {
      throw leaseLostError();
    }
    await source.collection("idempotency_records").doc(recordId).update({ data: finishData });
  };
  if (typeof db.runTransaction === "function") return db.runTransaction(recover);
  return recover(db);
}

async function finishIdempotentAction(dbOrRecordId, recordIdOrResult, maybeResult, executionToken) {
  const db = maybeResult === undefined ? null : dbOrRecordId;
  const recordId = maybeResult === undefined ? dbOrRecordId : recordIdOrResult;
  const result = maybeResult === undefined ? recordIdOrResult : maybeResult;
  if (!db) throw new Error("finishIdempotentAction requires db as first argument in this project");
  const data = result && result.data ? result.data : result || {};
  await updateOwnedIdempotencyRecord(db, recordId, executionToken, {
    status: "success",
    resultRef: result.resultRef || resultRefFromData(data),
    resultDataMasked: maskPayload(data),
    errorCode: "",
    errorMessage: "",
    finishedAt: nowDate(),
    updatedAt: nowDate()
  });
}

async function failIdempotentAction(db, recordId, error = {}, executionToken) {
  if (!db || !recordId) return;
  await updateOwnedIdempotencyRecord(db, recordId, executionToken, {
    status: "failed",
    errorCode: error.code || error.errCode || "",
    errorMessage: "",
    retryable: retryableFailure(error),
    finishedAt: nowDate(),
    updatedAt: nowDate()
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
  if (!beginResult || beginResult.canExecute) return null;
  const status = beginResult && (beginResult.status || beginResult.record && beginResult.record.status);
  if (status === "success") return { ok: true, data: duplicateSuccessData(beginResult.record) };
  if (status === "conflict") {
    return {
      ok: false,
      code: "IDEMPOTENCY_KEY_CONFLICT",
      category: "IDEMPOTENCY_CONFLICT",
      message: "请求已被用于其他操作，请刷新后重试",
      data: { duplicate: true, idempotencyStatus: "conflict" }
    };
  }
  if (status === "processing") {
    return {
      ok: false,
      code: "IDEMPOTENCY_PROCESSING",
      category: "IDEMPOTENCY_CONFLICT",
      message: "操作正在处理中，请稍候",
      retryAfterSeconds: IDEMPOTENCY_PROCESSING_RETRY_SECONDS,
      data: { duplicate: true, idempotencyStatus: "processing" }
    };
  }
  return {
    ok: false,
    code: "IDEMPOTENCY_NOT_EXECUTABLE",
    category: "IDEMPOTENCY_CONFLICT",
    message: "IDEMPOTENCY_NOT_EXECUTABLE",
    data: { duplicate: true, idempotencyStatus: status || "failed" }
  };
}

function idempotencyErrorResponse(error) {
  if (!error || !/^IDEMPOTENCY_/.test(error.code || "")) return null;
  return {
    ok: false,
    code: error.code,
    category: "IDEMPOTENCY_CONFLICT",
    message: error.message || "幂等处理失败",
    data: {
      duplicate: error.code !== "IDEMPOTENCY_KEY_REQUIRED",
      idempotencyStatus: error.code === "IDEMPOTENCY_KEY_CONFLICT" ? "conflict" : "failed"
    }
  };
}

async function recoverProcessingEarlyReturn(options = {}, beginResult) {
  const status = beginResult && (beginResult.status || beginResult.record && beginResult.record.status);
  const previousStatus = beginResult && (beginResult.previousStatus || beginResult.record && beginResult.record.previousStatus) || "";
  if (typeof options.recoverProcessingResult !== "function") return null;
  if (beginResult && beginResult.canExecute && !beginResult.staleProcessing && previousStatus !== "failed") return null;
  if (status !== "processing" && status !== "failed" && previousStatus !== "failed") return null;
  let recovered = null;
  try {
    recovered = await options.recoverProcessingResult(beginResult.record, beginResult);
  } catch (err) {
    if (process && process.env && process.env.IDEMPOTENCY_DEBUG === "1") {
      console.warn("[idempotency] recovery rejected", err && (err.code || err.name) || "UNKNOWN");
    }
    if (beginResult && beginResult.canExecute === false && err && err.code) throw err;
    recovered = null;
  }
  if (!recovered) return null;
  const data = {
    ...recovered,
    duplicate: true,
    idempotencyStatus: "success"
  };
  if (beginResult.executionToken) {
    await finishIdempotentAction(options.db, beginResult.recordId, { data }, beginResult.executionToken).catch(() => null);
  } else {
    await finishRecoveredAction(options.db, beginResult.recordId, beginResult.record, { data }).catch(() => null);
  }
  return { ok: true, data };
}

async function runIdempotentAction(options, executor) {
  let begin = null;
  try {
    begin = await beginIdempotentAction(options);
    const recovered = await recoverProcessingEarlyReturn(options, begin);
    if (recovered) return recovered;
    const early = idempotencyEarlyReturn(begin);
    if (early) return early;
    const data = await executor(begin);
    const successData = firstSuccessData(data || {});
    try {
      await finishIdempotentAction(options.db, begin.recordId, { data: successData }, begin.executionToken);
    } catch (finishErr) {
      console.warn("[idempotency] finish failed", {
        actionType: options && options.actionType || "",
        keyDigest: shortDigest(options && options.idempotencyKey),
        requestId: safeRequestId(options && options.requestId),
        resourceId: String(options && options.scopeId || "").slice(0, 128),
        errorCode: finishErr && (finishErr.code || finishErr.errCode) || ""
      });
      if (options && options.failClosedOnFinalize === true) {
        return {
          ok: false,
          code: "IDEMPOTENCY_FINALIZE_FAILED",
          category: "IDEMPOTENCY_CONFLICT",
          message: "操作结果未能安全确认，请稍后重试",
          retryAfterSeconds: IDEMPOTENCY_PROCESSING_RETRY_SECONDS,
          data: { duplicate: false, idempotencyStatus: "processing" }
        };
      }
    }
    return { ok: true, data: successData };
  } catch (err) {
    if (begin && begin.recordId) await failIdempotentAction(options.db, begin.recordId, err, begin.executionToken);
    const idempotencyError = idempotencyErrorResponse(err);
    if (idempotencyError) return idempotencyError;
    throw err;
  }
}

function assertVersion(value, code, message) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WriteProtectionError(code, message, 400);
  }
  return value;
}

function currentVersionOf(document, versionField = "version") {
  const raw = document && document[versionField];
  const value = raw === undefined || raw === null || raw === "" ? 0 : raw;
  return assertVersion(value, "DATA_VERSION_INVALID", "记录版本数据异常，请刷新后重试");
}

async function runVersionedTransaction(options = {}, executor) {
  const {
    db,
    collectionName,
    documentId,
    versionField = "version",
    createNotFoundError,
    createConflictError,
    validateCurrent
  } = options;
  if (!db || typeof db.runTransaction !== "function") throw new Error("runVersionedTransaction requires db.runTransaction");
  if (!collectionName || !documentId) throw new Error("runVersionedTransaction requires a collection and document id");
  if (typeof executor !== "function") throw new Error("runVersionedTransaction requires an executor");
  const expectedVersion = assertVersion(options.expectedVersion, "EXPECTED_VERSION_INVALID", "记录版本无效，请刷新后重试");

  return db.runTransaction(async (transaction) => {
    const current = await getDocumentOrNull(transaction, collectionName, documentId);
    if (!current) {
      if (typeof createNotFoundError === "function") throw createNotFoundError();
      throw new WriteProtectionError("NOT_FOUND", "记录不存在", 404);
    }
    const currentVersion = currentVersionOf(current, versionField);
    if (currentVersion !== expectedVersion) {
      const details = { currentVersion, refreshRequired: true };
      if (typeof createConflictError === "function") {
        const error = createConflictError(currentVersion);
        if (error && error.details === undefined) error.details = details;
        throw error;
      }
      throw new WriteProtectionError("DATA_VERSION_CONFLICT", "记录已变化，请刷新后重新确认", 409, details);
    }
    if (typeof validateCurrent === "function") await validateCurrent(current, currentVersion, transaction);
    return executor({
      transaction,
      current,
      currentVersion,
      nextVersion: currentVersion + 1
    });
  });
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  PAYMENT_TTL_SECONDS,
  REFUND_TTL_SECONDS,
  PROCESSING_TIMEOUT_SECONDS,
  IDEMPOTENCY_PROCESSING_RETRY_SECONDS,
  WriteProtectionError,
  assertIdempotencyKey,
  buildIdempotencyRecordId,
  hashPayload,
  fingerprintPayload,
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
  currentVersionOf,
  runVersionedTransaction,
  ensureCollection
};
