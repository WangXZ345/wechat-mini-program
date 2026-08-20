"use strict";

const crypto = require("crypto");

const SCHEMA_VERSION = 1;
const DEFAULT_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_CHANGE_FIELDS = new Set([
  "status", "paymentStatus", "confirmStatus", "deliveryStatus", "refundStatus",
  "isActive", "price", "warningStock", "stockStatus", "tags",
  "updatedAt", "version"
]);
const SAFE_SUMMARY_FIELDS = new Set([
  "status", "paymentStatus", "confirmStatus", "deliveryStatus", "refundStatus",
  "isActive", "price", "warningStock", "stockStatus", "version"
]);
const SAFE_RESULT_FIELDS = new Set(["status", "affected", "changed", "reused"]);

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function idempotencyDigest(value) {
  const normalized = cleanString(value, 512);
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

function stableId(prefix, value) {
  const digest = crypto.createHash("sha256").update(cleanString(value, 4096), "utf8").digest("hex").slice(0, 40);
  return `${cleanString(prefix, 40) || "operation"}:${digest}`;
}

function safeChangedFields(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((field) => cleanString(field, 80))
    .filter((field) => SAFE_CHANGE_FIELDS.has(field))))
    .slice(0, 20);
}

function safeSummary(value, allowed = SAFE_SUMMARY_FIELDS) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) return;
    const item = value[key];
    if (typeof item === "boolean" || typeof item === "string" || (typeof item === "number" && Number.isSafeInteger(item))) {
      result[key] = typeof item === "string" ? cleanString(item, 80) : item;
    }
  });
  return result;
}

function timestampOf(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("operation timestamp is invalid");
  return parsed;
}

function correlationOf(input = {}) {
  const requestId = cleanString(input.requestId, 128);
  const batchId = cleanString(input.batchId, 128);
  const businessKey = cleanString(input.businessKey, 512);
  const seed = [businessKey, requestId, batchId, input.resourceType, input.resourceId, input.action].map((item) => cleanString(item, 512)).join(":");
  return {
    operationId: cleanString(input.operationId, 128) || stableId("operation", seed),
    requestId,
    batchId,
    businessKey
  };
}

function buildOperationLog(input = {}) {
  const operator = input.operator || {};
  const operatorId = cleanString(operator.id || operator._id, 128);
  const operatorRole = cleanString(operator.role, 50);
  const action = cleanString(input.action, 80);
  const resourceType = cleanString(input.resourceType, 60);
  const resourceId = cleanString(input.resourceId, 128);
  if (!operatorId || !operatorRole || !action || !resourceType || !resourceId) {
    throw new Error("operation audit metadata is incomplete");
  }
  const correlation = correlationOf(input);
  const changedFields = safeChangedFields(input.changedFields);
  return {
    schemaVersion: SCHEMA_VERSION,
    ...correlation,
    operatorId,
    operatorRole,
    action,
    resourceType,
    resourceId,
    sourceClient: input.sourceClient === "miniprogram" ? "miniprogram" : "admin_web",
    idempotencyDigest: idempotencyDigest(input.idempotencyKey),
    changeSummary: {
      changedFields,
      before: safeSummary(input.before),
      after: safeSummary(input.after)
    },
    result: safeSummary(input.result, SAFE_RESULT_FIELDS),
    status: cleanString(input.status || (input.result && input.result.status) || "success", 30) || "success",
    createdAt: timestampOf(input.timestamp)
  };
}

function buildSyncEvent(input = {}) {
  const eventType = cleanString(input.eventType, 100);
  const entityType = cleanString(input.entityType || input.resourceType, 60);
  const entityId = cleanString(input.entityId || input.resourceId, 128);
  const action = cleanString(input.action, 80);
  if (!eventType || !entityType || !entityId || !action) throw new Error("sync event metadata is incomplete");
  const correlation = correlationOf(input);
  const timestamp = timestampOf(input.timestamp);
  const eventSeed = [correlation.operationId, eventType, entityType, entityId, safeInteger(input.version)].join(":");
  const event = {
    schemaVersion: SCHEMA_VERSION,
    eventId: cleanString(input.eventId, 128) || stableId("sync_event", eventSeed),
    operationId: correlation.operationId,
    requestId: correlation.requestId,
    batchId: correlation.batchId,
    eventType,
    entityType,
    entityId,
    action,
    version: safeInteger(input.version),
    updatedAt: input.updatedAt ? timestampOf(input.updatedAt) : timestamp,
    changedFields: safeChangedFields(input.changedFields),
    actorType: cleanString(input.actorType || "admin", 30),
    actorRole: cleanString(input.operator && input.operator.role || input.actorRole, 50),
    sourceClient: input.sourceClient === "miniprogram" ? "miniprogram" : "admin_web",
    createdAt: timestamp,
    expiresAt: new Date(timestamp.getTime() + safeInteger(input.ttlMs, DEFAULT_EVENT_TTL_MS))
  };
  for (const key of ["audience", "ownerKey"]) {
    const value = cleanString(input[key], 128);
    if (value) event[key] = value;
  }
  if (input.isPublic === true) event.isPublic = true;
  if (Array.isArray(input.audienceRoles)) {
    event.audienceRoles = Array.from(new Set(input.audienceRoles.map((role) => cleanString(role, 50)).filter(Boolean))).slice(0, 10);
  }
  return event;
}

async function writeOperationBundle(store, { operation, events = [] } = {}) {
  if (!store || typeof store.collection !== "function") throw new Error("transaction store is required");
  const log = buildOperationLog(operation);
  const eventIds = [];
  await store.collection("admin_operation_logs").add({ data: log });
  for (const value of events) {
    const event = value && value.schemaVersion === SCHEMA_VERSION && value.eventId
      ? value
      : buildSyncEvent({ ...operation, ...value });
    await store.collection("sync_events").add({ data: event });
    eventIds.push(event.eventId);
  }
  return { operationId: log.operationId, eventIds };
}

module.exports = {
  DEFAULT_EVENT_TTL_MS,
  SCHEMA_VERSION,
  buildOperationLog,
  buildSyncEvent,
  idempotencyDigest,
  safeChangedFields,
  writeOperationBundle
};
