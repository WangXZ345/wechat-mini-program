"use strict";

const BATCH_LIMITS = Object.freeze({
  maxItems: 50,
  maxRequestBytes: 256 * 1024,
  maxPayloadDepth: 20,
  maxPayloadNodes: 10_000,
  maxStringBytes: 64 * 1024,
  defaultChunkSize: 10,
  maxChunkSize: 20,
  defaultConcurrency: 3,
  maxConcurrency: 5,
  defaultItemTimeoutMs: 10_000,
  maxItemTimeoutMs: 30_000,
  defaultBatchDeadlineMs: 45_000,
  maxBatchDeadlineMs: 50_000
});

const BATCH_ITEM_STATUSES = Object.freeze([
  "success",
  "skipped",
  "validation",
  "not_allowed",
  "conflict",
  "permission",
  "business_error"
]);

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UNSAFE_PAYLOAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SENSITIVE_KEYS = new Set([
  "authorization",
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "csrftoken",
  "apikey",
  "actionsecret",
  "credential",
  "credentials"
]);

class BatchContractError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "BatchContractError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new BatchContractError(code, message, statusCode);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedSensitiveKey(key) {
  return String(key).replace(/[-_]/g, "").toLowerCase();
}

function addBytes(budget, bytes) {
  budget.bytes += bytes;
  if (budget.bytes > BATCH_LIMITS.maxRequestBytes) {
    fail("BATCH_PAYLOAD_LIMIT_EXCEEDED", `批量请求不得超过 ${BATCH_LIMITS.maxRequestBytes} 字节`, 413);
  }
}

function countNode(budget, depth) {
  if (depth > BATCH_LIMITS.maxPayloadDepth) fail("BATCH_PAYLOAD_DEPTH_EXCEEDED", "批量项 payload 嵌套过深", 413);
  budget.nodes += 1;
  if (budget.nodes > BATCH_LIMITS.maxPayloadNodes) fail("BATCH_PAYLOAD_NODE_LIMIT_EXCEEDED", "批量项 payload 节点过多", 413);
}

function cloneJsonValue(value, budget, depth = 0, seen = new Set()) {
  countNode(budget, depth);
  if (value === null) {
    addBytes(budget, 4);
    return value;
  }
  if (typeof value === "string") {
    const stringBytes = Buffer.byteLength(value, "utf8");
    addBytes(budget, Buffer.byteLength(JSON.stringify(value), "utf8"));
    if (stringBytes > BATCH_LIMITS.maxStringBytes) fail("BATCH_STRING_LIMIT_EXCEEDED", "批量项字符串过长", 413);
    return value;
  }
  if (typeof value === "boolean") {
    addBytes(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("BATCH_PAYLOAD_INVALID", "批量项 payload 只能包含有限数值");
    addBytes(budget, Buffer.byteLength(String(value), "utf8"));
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("BATCH_PAYLOAD_INVALID", "批量项 payload 不得包含循环引用");
    seen.add(value);
    addBytes(budget, 2 + Math.max(0, value.length - 1));
    const cloned = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        fail("BATCH_SPARSE_ARRAY_FORBIDDEN", "批量项 payload 不得包含稀疏数组");
      }
      cloned[index] = cloneJsonValue(value[index], budget, depth + 1, seen);
    }
    seen.delete(value);
    return cloned;
  }
  if (!isPlainObject(value)) fail("BATCH_PAYLOAD_INVALID", "批量项 payload 必须是 JSON 对象");
  if (seen.has(value)) fail("BATCH_PAYLOAD_INVALID", "批量项 payload 不得包含循环引用");
  seen.add(value);
  const cloned = {};
  const objectKeys = Object.keys(value);
  addBytes(budget, 2 + Math.max(0, objectKeys.length - 1));
  for (const key of objectKeys) {
    if (UNSAFE_PAYLOAD_KEYS.has(key)) fail("BATCH_UNSAFE_PAYLOAD_KEY", "批量项 payload 包含不安全字段");
    if (SENSITIVE_KEYS.has(normalizedSensitiveKey(key))) {
      fail("BATCH_SENSITIVE_FIELD_FORBIDDEN", "批量请求不得包含明文敏感凭据");
    }
    addBytes(budget, Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
    const entry = value[key];
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
      fail("BATCH_PAYLOAD_INVALID", "批量项 payload 包含不支持的值");
    }
    Object.defineProperty(cloned, key, {
      value: cloneJsonValue(entry, budget, depth + 1, seen),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  seen.delete(value);
  return cloned;
}

function assertExactKeys(value, allowed, code, message) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, message);
  }
}

function normalizeBatchItem(raw, ids, keys, budget, index) {
  if (!isPlainObject(raw)) fail("BATCH_ITEM_INVALID", "批量项必须是对象");
  assertExactKeys(raw, new Set(["id", "key", "version", "payload"]), "BATCH_ITEM_INVALID", "批量项包含不允许的字段");
  if (typeof raw.id !== "string" || !SAFE_IDENTIFIER.test(raw.id)) {
    fail("BATCH_ITEM_ID_INVALID", "批量项 id 无效");
  }
  if (typeof raw.key !== "string" || !SAFE_IDENTIFIER.test(raw.key)) {
    fail("BATCH_ITEM_KEY_INVALID", "批量项 key 无效");
  }
  if (!Number.isSafeInteger(raw.version) || raw.version < 0) {
    fail("BATCH_ITEM_VERSION_INVALID", "批量项 version 必须是非负安全整数");
  }
  if (ids.has(raw.id)) fail("BATCH_DUPLICATE_ITEM_ID", "批量请求包含重复 item id");
  if (keys.has(raw.key)) fail("BATCH_DUPLICATE_ITEM_KEY", "批量请求包含重复 item key");
  ids.add(raw.id);
  keys.add(raw.key);
  const fixedItemBytes = Buffer.byteLength(JSON.stringify({ id: raw.id, key: raw.key, version: raw.version, payload: null }), "utf8") - 4;
  addBytes(budget, fixedItemBytes + (index > 0 ? 1 : 0));
  return {
    id: raw.id,
    key: raw.key,
    version: raw.version,
    payload: cloneJsonValue(raw.payload, budget)
  };
}

function normalizeBatchRequest(raw) {
  if (!isPlainObject(raw)) fail("BATCH_REQUEST_INVALID", "批量请求必须是对象");
  assertExactKeys(raw, new Set(["requestId", "batchId", "items"]), "BATCH_REQUEST_INVALID", "批量请求包含不允许的字段");
  if (typeof raw.requestId !== "string" || !SAFE_IDENTIFIER.test(raw.requestId)) {
    fail("BATCH_REQUEST_ID_INVALID", "requestId 无效");
  }
  if (typeof raw.batchId !== "string" || !SAFE_IDENTIFIER.test(raw.batchId)) {
    fail("BATCH_ID_INVALID", "batchId 无效");
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    fail("BATCH_ITEMS_REQUIRED", "批量请求至少需要一个 item");
  }
  if (raw.items.length > BATCH_LIMITS.maxItems) {
    fail("BATCH_ITEM_LIMIT_EXCEEDED", `单次批量最多 ${BATCH_LIMITS.maxItems} 项`, 413);
  }
  const ids = new Set();
  const keys = new Set();
  const budget = {
    bytes: Buffer.byteLength(JSON.stringify({ requestId: raw.requestId, batchId: raw.batchId, items: [] }), "utf8") - 2,
    nodes: 0
  };
  const normalizedItems = new Array(raw.items.length);
  for (let index = 0; index < raw.items.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw.items, index)) {
      fail("BATCH_SPARSE_ARRAY_FORBIDDEN", "批量请求 items 不得包含稀疏项");
    }
    normalizedItems[index] = normalizeBatchItem(raw.items[index], ids, keys, budget, index);
  }
  const normalized = {
    requestId: raw.requestId,
    batchId: raw.batchId,
    items: normalizedItems
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > BATCH_LIMITS.maxRequestBytes) {
    fail("BATCH_PAYLOAD_LIMIT_EXCEEDED", `批量请求不得超过 ${BATCH_LIMITS.maxRequestBytes} 字节`, 413);
  }
  return normalized;
}

module.exports = {
  BATCH_ITEM_STATUSES,
  BATCH_LIMITS,
  BatchContractError,
  normalizeBatchRequest
};
