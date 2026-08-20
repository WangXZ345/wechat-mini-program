"use strict";

const crypto = require("crypto");

const {
  BATCH_ITEM_STATUSES,
  BATCH_LIMITS,
  BatchContractError,
  normalizeBatchRequest
} = require("./batchContract");

const STATUS_SET = new Set(BATCH_ITEM_STATUSES);
const FAILURE_STATUSES = new Set(["validation", "not_allowed", "conflict", "permission", "business_error"]);
const RETRYABLE_CODES = Object.freeze({
  skipped: new Set(["BATCH_DEADLINE_EXCEEDED"]),
  conflict: new Set(["DATA_VERSION_CONFLICT", "VERSION_MISMATCH", "OPTIMISTIC_LOCK_CONFLICT"]),
  business_error: new Set(["DEPENDENCY_BUSY", "UPSTREAM_UNAVAILABLE", "SERVICE_UNAVAILABLE", "RATE_LIMITED", "NETWORK_ERROR"])
});
const PUBLIC_CODES = Object.freeze({
  success: new Set(["OK"]),
  skipped: new Set(["UNCHANGED", "NO_CHANGE", "BATCH_DEADLINE_EXCEEDED"]),
  validation: new Set(["INVALID_ROW", "VALIDATION_ERROR", "INVALID_ARGUMENT"]),
  not_allowed: new Set(["STATE_BLOCKED", "INVALID_STATE", "NOT_ALLOWED"]),
  conflict: new Set(["DATA_VERSION_CONFLICT", "VERSION_MISMATCH", "OPTIMISTIC_LOCK_CONFLICT", "BATCH_ITEM_FINGERPRINT_CONFLICT"]),
  permission: new Set(["FORBIDDEN", "PERMISSION_DENIED"]),
  business_error: new Set(["DEPENDENCY_BUSY", "UPSTREAM_UNAVAILABLE", "SERVICE_UNAVAILABLE", "RATE_LIMITED", "NETWORK_ERROR", "BATCH_ITEM_TIMEOUT", "BATCH_DEADLINE_EXCEEDED", "BATCH_ITEM_FAILED"])
});
const FALLBACK_CODES = Object.freeze({
  success: "OK",
  skipped: "SKIPPED",
  validation: "VALIDATION_ERROR",
  not_allowed: "NOT_ALLOWED",
  conflict: "CONFLICT",
  permission: "FORBIDDEN",
  business_error: "BATCH_ITEM_FAILED"
});

function boundedInteger(value, fallback, min, max, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new BatchContractError("BATCH_EXECUTION_OPTIONS_INVALID", `${name} 配置无效`);
  }
  return resolved;
}

function normalizeOptions(options = {}) {
  return {
    chunkSize: boundedInteger(options.chunkSize, BATCH_LIMITS.defaultChunkSize, 1, BATCH_LIMITS.maxChunkSize, "chunkSize"),
    concurrency: boundedInteger(options.concurrency, BATCH_LIMITS.defaultConcurrency, 1, BATCH_LIMITS.maxConcurrency, "concurrency"),
    itemTimeoutMs: boundedInteger(options.itemTimeoutMs, BATCH_LIMITS.defaultItemTimeoutMs, 1, BATCH_LIMITS.maxItemTimeoutMs, "itemTimeoutMs"),
    batchDeadlineMs: boundedInteger(options.batchDeadlineMs, BATCH_LIMITS.defaultBatchDeadlineMs, 1, BATCH_LIMITS.maxBatchDeadlineMs, "batchDeadlineMs")
  };
}

function stableSerialize(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new BatchContractError("BATCH_PAYLOAD_INVALID", "批量项 payload 包含不支持的值");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const entries = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new BatchContractError("BATCH_SPARSE_ARRAY_FORBIDDEN", "批量项 payload 不得包含稀疏数组");
      }
      entries.push(stableSerialize(value[index]));
    }
    return `[${entries.join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

function fingerprintBatchItem(item) {
  return crypto.createHash("sha256").update(stableSerialize({
    id: item.id,
    key: item.key,
    version: item.version,
    payload: item.payload
  }), "utf8").digest("hex");
}

function immutableClone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableClone));
  const cloned = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(cloned, key, {
      value: immutableClone(value[key]),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return Object.freeze(cloned);
}

function handlerCorrelationContext(batch, item, signal) {
  const correlation = Object.freeze({
    requestId: batch.requestId,
    batchId: batch.batchId,
    itemKey: item.key
  });
  return Object.freeze({
    requestId: batch.requestId,
    batchId: batch.batchId,
    itemId: item.id,
    itemKey: item.key,
    expectedVersion: item.version,
    operationLogContext: Object.freeze({ ...correlation }),
    syncEventContext: Object.freeze({ ...correlation }),
    signal
  });
}

function receiptCorrelationContext(handlerContext, itemFingerprint) {
  return Object.freeze({
    ...handlerContext,
    itemFingerprint
  });
}

function publicCode(status, value) {
  return typeof value === "string" && PUBLIC_CODES[status] instanceof Set && PUBLIC_CODES[status].has(value)
    ? value
    : FALLBACK_CODES[status] || "BATCH_ITEM_FAILED";
}

function publicMessage(status, code) {
  if (status === "success") return "处理成功";
  if (status === "skipped") return code === "BATCH_DEADLINE_EXCEEDED" ? "批次截止，尚未开始该项" : "无需处理";
  if (status === "validation") return "数据校验失败";
  if (status === "not_allowed") return "当前状态不允许处理";
  if (status === "permission") return "无权处理该项";
  if (status === "conflict") {
    return code === "BATCH_ITEM_FINGERPRINT_CONFLICT" ? "批量项与已完成请求不一致" : "数据已更新，请刷新后重试";
  }
  if (["DEPENDENCY_BUSY", "UPSTREAM_UNAVAILABLE", "SERVICE_UNAVAILABLE", "RATE_LIMITED", "NETWORK_ERROR"].includes(code)) {
    return "服务暂时不可用";
  }
  if (code === "BATCH_ITEM_TIMEOUT") return "批量项处理超时";
  if (code === "BATCH_DEADLINE_EXCEEDED") return "批量项因批次截止时间中止";
  return "批量项处理失败";
}

function allowedRetry(status, code, requested) {
  return requested === true && RETRYABLE_CODES[status] instanceof Set && RETRYABLE_CODES[status].has(code);
}

function normalizeHandlerResult(raw, item) {
  if (!raw || typeof raw !== "object" || !STATUS_SET.has(raw.status)) {
    return itemFailure(item, "business_error", "BATCH_HANDLER_RESULT_INVALID", "批量项处理结果无效", false);
  }
  const status = raw.status;
  const code = publicCode(status, raw.code);
  const retryable = allowedRetry(status, code, raw.retryable);
  return {
    id: item.id,
    key: item.key,
    version: item.version,
    status,
    code,
    message: publicMessage(status, code),
    retryable,
    reused: false
  };
}

function itemFailure(item, status, code, message, retryable) {
  return {
    id: item.id,
    key: item.key,
    version: item.version,
    status,
    code,
    message,
    retryable,
    reused: false
  };
}

function classifyError(error, item) {
  const code = error && typeof error.code === "string" ? error.code : "BATCH_ITEM_FAILED";
  const category = error && typeof error.batchStatus === "string" ? error.batchStatus : "";
  let status = STATUS_SET.has(category) && category !== "success" ? category : "business_error";
  if (!category) {
    if (/VALIDATION|INVALID_ARGUMENT|INVALID_REQUEST/.test(code)) status = "validation";
    else if (/NOT_ALLOWED|INVALID_STATE/.test(code)) status = "not_allowed";
    else if (/CONFLICT|VERSION_MISMATCH/.test(code)) status = "conflict";
    else if (/FORBIDDEN|PERMISSION|UNAUTHORIZED/.test(code)) status = "permission";
  }
  const exposedCode = publicCode(status, code);
  return itemFailure(
    item,
    status,
    exposedCode,
    status === "validation" ? "数据校验失败"
      : status === "not_allowed" ? "当前状态不允许处理"
        : status === "conflict" ? "数据已更新，请刷新后重试"
          : status === "permission" ? "无权处理该项"
            : "批量项处理失败",
    allowedRetry(status, exposedCode, error && error.retryable)
  );
}

async function withTimeout(operation, context, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code === "BATCH_DEADLINE_EXCEEDED" ? "batch deadline exceeded" : "batch item timeout");
      error.code = code;
      error.retryable = true;
      reject(error);
      context.signalController.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function reusableSuccess(stored, item, itemFingerprint) {
  if (!stored || stored.status !== "success") return null;
  if (stored.id !== item.id || stored.key !== item.key || stored.fingerprint !== itemFingerprint) return "conflict";
  const normalized = normalizeHandlerResult(stored, item);
  return { ...normalized, reused: true };
}

function deadlineResult(item, started) {
  return itemFailure(
    item,
    started ? "business_error" : "skipped",
    "BATCH_DEADLINE_EXCEEDED",
    started ? "批量项因批次截止时间中止" : "批次截止，尚未开始该项",
    started === false
  );
}

async function executeOne(batch, item, dependencies, options, deadline) {
  const identity = Object.freeze({ id: item.id, key: item.key, version: item.version });
  const handlerInput = immutableClone(item);
  if (deadline.remaining() <= 0) return deadlineResult(identity, false);
  const signalController = new AbortController();
  const itemFingerprint = fingerprintBatchItem(item);
  const handlerContext = handlerCorrelationContext(batch, identity, signalController.signal);
  const receiptContext = receiptCorrelationContext(handlerContext, itemFingerprint);
  const context = { signalController };
  if (typeof dependencies.getCompletedResult === "function") {
    try {
      const storedReceipt = await withTimeout(
        () => dependencies.getCompletedResult(receiptContext),
        context,
        deadline.remaining(),
        "BATCH_DEADLINE_EXCEEDED"
      );
      const stored = reusableSuccess(storedReceipt, identity, itemFingerprint);
      if (stored === "conflict") {
        return itemFailure(identity, "conflict", "BATCH_ITEM_FINGERPRINT_CONFLICT", "批量项与已完成请求不一致", false);
      }
      if (stored) return stored;
    } catch (error) {
      if (error && error.code === "BATCH_DEADLINE_EXCEEDED") return deadlineResult(identity, true);
      return classifyError(error, identity);
    }
  }
  let result;
  try {
    const remaining = deadline.remaining();
    if (remaining <= 0) return deadlineResult(identity, false);
    const timeoutMs = Math.min(options.itemTimeoutMs, remaining);
    const timeoutCode = remaining <= options.itemTimeoutMs ? "BATCH_DEADLINE_EXCEEDED" : "BATCH_ITEM_TIMEOUT";
    const raw = await withTimeout(
      () => dependencies.handleItem(handlerInput, handlerContext),
      context,
      timeoutMs,
      timeoutCode
    );
    result = normalizeHandlerResult(raw, identity);
  } catch (error) {
    result = error && error.code === "BATCH_DEADLINE_EXCEEDED"
      ? deadlineResult(identity, true)
      : error && error.code === "BATCH_ITEM_TIMEOUT"
      ? itemFailure(identity, "business_error", "BATCH_ITEM_TIMEOUT", "批量项处理超时", false)
      : classifyError(error, identity);
  }
  if (typeof dependencies.saveItemResult === "function") {
    const remaining = deadline.remaining();
    if (remaining > 0) {
      try {
        await withTimeout(
          () => dependencies.saveItemResult({ ...result, fingerprint: itemFingerprint }, receiptContext),
          context,
          remaining,
          "BATCH_DEADLINE_EXCEEDED"
        );
      } catch (_) { /* canonical handler remains the idempotency boundary */ }
    }
  }
  return result;
}

async function executeChunk(batch, chunk, dependencies, options, deadline) {
  const results = new Array(chunk.length);
  let cursor = 0;
  async function worker() {
    while (cursor < chunk.length) {
      if (deadline.remaining() <= 0) return;
      const index = cursor;
      cursor += 1;
      results[index] = await executeOne(batch, chunk[index], dependencies, options, deadline);
    }
  }
  const workerCount = Math.min(options.concurrency, chunk.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return Array.from(results, (result, index) => result || deadlineResult(chunk[index], false));
}

function summarize(items) {
  const counts = {
    total: items.length,
    success: 0,
    skipped: 0,
    validation: 0,
    not_allowed: 0,
    conflict: 0,
    permission: 0,
    business_error: 0,
    failed: 0,
    retryable: 0
  };
  for (const item of items) {
    counts[item.status] += 1;
    if (FAILURE_STATUSES.has(item.status)) counts.failed += 1;
    if (item.status !== "success" && item.retryable) counts.retryable += 1;
  }
  const overallStatus = counts.success === counts.total
    ? "success"
    : counts.success === 0 && counts.skipped === 0
      ? "failed"
      : "partial";
  return { counts, overallStatus };
}

async function executeBatch(rawRequest, dependencies, rawOptions = {}) {
  if (!dependencies || typeof dependencies.handleItem !== "function") {
    throw new BatchContractError("BATCH_HANDLER_REQUIRED", "批量执行器必须注入 canonical per-item handler", 500);
  }
  if (dependencies.now !== undefined && typeof dependencies.now !== "function") {
    throw new BatchContractError("BATCH_CLOCK_INVALID", "批量执行器内部时钟无效", 500);
  }
  const batch = normalizeBatchRequest(rawRequest);
  const options = normalizeOptions(rawOptions);
  const now = dependencies.now === undefined ? Date.now : dependencies.now;
  const expiresAt = now() + options.batchDeadlineMs;
  const deadline = { remaining: () => Math.max(0, expiresAt - now()) };
  const items = [];
  for (let start = 0; start < batch.items.length; start += options.chunkSize) {
    const chunk = batch.items.slice(start, start + options.chunkSize);
    items.push(...await executeChunk(batch, chunk, dependencies, options, deadline));
  }
  const summary = summarize(items);
  return {
    requestId: batch.requestId,
    batchId: batch.batchId,
    overallStatus: summary.overallStatus,
    counts: summary.counts,
    items
  };
}

module.exports = {
  executeBatch,
  fingerprintBatchItem
};
