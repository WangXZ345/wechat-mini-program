"use strict";

const crypto = require("crypto");

const { BATCH_LIMITS } = require("./batchContract");
const { executeBatch: defaultExecuteBatch, fingerprintBatchItem } = require("./batchExecutor");
const defaultIdempotency = require("./idempotency");
const defaultOutbox = require("./operationOutbox");
const {
  buildMappedPreview: defaultBuildMappedPreview,
  mappingHash,
  parseImportFile: defaultParseImportFile
} = require("./importFileParser");

const IMPORT_TYPES = new Set(["quotes", "inventory"]);
const TERMINAL_STATUSES = new Set(["success", "partial", "failed"]);
const PUBLIC_BATCH_STATUSES = new Set(["success", "skipped", "validation", "not_allowed", "conflict", "permission", "business_error"]);
const BATCH_PAYLOAD_BUDGET = 200 * 1024;
const IMPORT_PROCESSING_LEASE_MS = 60 * 1000;
const IMPORT_RECEIPT_CURSOR_VERSION = 1;
const IMPORT_RECEIPT_CURSOR_MAX_LENGTH = 4096;
const IMPORT_RECEIPT_SCAN_LIMIT = 10_000;
const IMPORT_RECEIPT_SCAN_PAGE_SIZE = 1000;

class ImportFrameworkError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "ImportFrameworkError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function fail(code, message, statusCode, details) {
  throw new ImportFrameworkError(code, message, statusCode, details);
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function receiptCursorKey(secret) {
  const value = String(secret || "");
  if (value.length < 32) fail("IMPORT_ITEMS_CURSOR_CONFIG_REQUIRED", "导入明细分页安全配置不完整", 503);
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function encodeReceiptCursor(state, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", receiptCursorKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return `v${IMPORT_RECEIPT_CURSOR_VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

function decodeReceiptCursor(value, secret) {
  try {
    const cursor = cleanString(value, IMPORT_RECEIPT_CURSOR_MAX_LENGTH);
    if (!cursor || cursor !== value) throw new Error("invalid cursor");
    const parts = cursor.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid cursor");
    const [prefix, encoded] = parts;
    if (prefix !== `v${IMPORT_RECEIPT_CURSOR_VERSION}`) throw new Error("invalid cursor");
    const packed = Buffer.from(encoded, "base64url");
    if (packed.length < 29) throw new Error("invalid cursor");
    const decipher = crypto.createDecipheriv("aes-256-gcm", receiptCursorKey(secret), packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    const parsed = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"));
    if (!parsed || parsed.v !== IMPORT_RECEIPT_CURSOR_VERSION || typeof parsed.r !== "string"
      || !Number.isSafeInteger(parsed.p) || parsed.p < 1 || !Number.isSafeInteger(parsed.s) || parsed.s < 1 || parsed.s > 100
      || !Number.isSafeInteger(parsed.vr) || parsed.vr < 1 || !Number.isSafeInteger(parsed.t) || parsed.t < 0
      || !Array.isArray(parsed.after) || parsed.after.length !== 2 || !Number.isSafeInteger(parsed.after[0]) || parsed.after[0] < 1
      || typeof parsed.after[1] !== "string" || !parsed.after[1] || parsed.after[1].length > 128) throw new Error("invalid cursor");
    return parsed;
  } catch (error) {
    if (error && error.code === "IMPORT_ITEMS_CURSOR_CONFIG_REQUIRED") throw error;
    fail("IMPORT_ITEMS_CURSOR_INVALID", "导入明细分页游标无效", 400);
  }
}

function timestampMillis(value) {
  const candidate = value && typeof value.toDate === "function" ? value.toDate() : value;
  const milliseconds = candidate instanceof Date ? candidate.getTime() : new Date(candidate).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : NaN;
}

function leaseDeadline(value) {
  const milliseconds = timestampMillis(value);
  if (!Number.isFinite(milliseconds)) fail("IMPORT_PROCESSING_LEASE_INVALID", "导入执行租约无效", 503);
  return new Date(milliseconds + IMPORT_PROCESSING_LEASE_MS);
}

function processingLeaseExpired(record, value) {
  const requestedAt = timestampMillis(value);
  const explicitExpiry = timestampMillis(record && record.leaseExpiresAt);
  if (!Number.isFinite(requestedAt)) return false;
  if (Number.isFinite(explicitExpiry)) return explicitExpiry <= requestedAt;
  const lastActivity = timestampMillis(record && (record.updatedAt || record.createdAt));
  return Number.isFinite(lastActivity) && lastActivity + IMPORT_PROCESSING_LEASE_MS <= requestedAt;
}

function safeType(value) {
  const type = cleanString(value, 40).toLowerCase();
  if (!IMPORT_TYPES.has(type)) fail("IMPORT_TYPE_INVALID", "导入类型无效");
  return type;
}

function safeActor(value) {
  if (!value || typeof value !== "object") fail("UNAUTHORIZED", "管理员身份无效", 401);
  const actor = {
    id: cleanString(value.id || value._id, 128),
    openid: cleanString(value.openid, 128),
    role: cleanString(value.role, 50),
    permissions: Array.isArray(value.permissions) ? value.permissions.map((item) => cleanString(item, 100)).filter(Boolean) : [],
    status: cleanString(value.status, 30),
    sourceClient: "admin_web"
  };
  if (!actor.id || !actor.role || actor.status !== "active") fail("UNAUTHORIZED", "管理员身份无效", 401);
  return actor;
}

function idempotencyFailure(result) {
  const code = cleanString(result && result.code, 80) || "IDEMPOTENCY_FAILED";
  const statusCode = code === "IDEMPOTENCY_KEY_CONFLICT" ? 409
    : code === "IDEMPOTENCY_PROCESSING" ? 409
      : code === "IDEMPOTENCY_KEY_REQUIRED" || code === "IDEMPOTENCY_KEY_INVALID" ? 400
        : 503;
  return new ImportFrameworkError(code, "导入请求幂等校验失败", statusCode);
}

function publicCode(value, fallback = "BATCH_ITEM_FAILED") {
  const code = cleanString(value, 80);
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : fallback;
}

function errorSummary(items) {
  const counts = new Map();
  for (const item of items || []) {
    if (item.status === "success" || item.status === "skipped" && item.code === "UNCHANGED") continue;
    const code = publicCode(item.code);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([code, count]) => ({ code, count }));
}

function previewCounts(rows, truncated = false) {
  const valid = rows.filter((row) => row.status === "ready").length;
  const failed = rows.filter((row) => row.status === "validation").length;
  return {
    total: rows.length,
    valid,
    failed,
    ready: valid,
    validation: failed,
    truncated: truncated === true
  };
}

function executionCounts(items) {
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
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
    if (!["success", "skipped"].includes(item.status)) counts.failed += 1;
    if (item.status !== "success" && item.retryable === true) counts.retryable += 1;
  }
  return counts;
}

function overallStatus(counts) {
  if (counts.success === counts.total) return "success";
  if (counts.success > 0 || counts.skipped > 0) return "partial";
  return "failed";
}

function itemDocumentId(recordId, itemId) {
  return `import_item_${sha256(`${recordId}:${itemId}`).slice(0, 48)}`;
}

function itemEventDocumentId(recordId, itemId, revision) {
  return `import_event_${sha256(`${recordId}:${itemId}:${revision}`).slice(0, 48)}`;
}

function missingDocument(error) {
  return /not exists|not found|does not exist|DOCUMENT_NOT_FOUND|DATABASE_COLLECTION_NOT_EXIST/i.test(String(error && (error.message || error.errMsg) || error || ""));
}

function createCloudBaseImportRepository(db, idempotency = defaultIdempotency) {
  if (!db || typeof db.collection !== "function") throw new Error("import repository requires db");
  return {
    db,
    async ensureCollections() {
      for (const name of ["import_records", "import_record_items", "admin_operation_logs", "sync_events"]) {
        await idempotency.ensureCollection(db, name);
      }
    },
    async createPreview(record) {
      const result = await db.collection("import_records").add({ data: record });
      return cleanString(result && (result._id || result.id), 128);
    },
    async getRecord(id) {
      try {
        const result = await db.collection("import_records").doc(id).get();
        return result && result.data ? { ...result.data, id: result.data._id || id } : null;
      } catch (error) {
        if (missingDocument(error)) return null;
        throw error;
      }
    },
    async updateRecord(id, patch) {
      await db.collection("import_records").doc(id).update({ data: patch });
    },
    async beginProcessing(id, action, patch, context = {}) {
      const allowed = action === "resume" ? new Set(["partial", "failed"]) : new Set(["previewed"]);
      const transition = async (source) => {
        const response = await source.collection("import_records").doc(id).get();
        const current = response && response.data;
        if (!current) fail("IMPORT_PREVIEW_NOT_FOUND", "服务端预览批次不存在", 404);
        const staleProcessing = action === "resume"
          && current.status === "processing"
          && processingLeaseExpired(current, context.now);
        if (!allowed.has(current.status) && !staleProcessing) {
          fail(action === "resume" ? "IMPORT_RESUME_NOT_ALLOWED" : "IMPORT_CONFIRM_NOT_ALLOWED", "当前导入批次状态不允许执行", 409);
        }
        await source.collection("import_records").doc(id).update({ data: patch });
        return { ...current, ...patch, id: current._id || id };
      };
      if (typeof db.runTransaction === "function") return db.runTransaction(transition);
      fail("IMPORT_PROCESSING_CAS_UNAVAILABLE", "导入执行保护暂不可用", 503);
    },
    async updateOwnedRecord(id, leaseToken, patch) {
      if (!leaseToken) fail("IMPORT_PROCESSING_LEASE_LOST", "导入执行权已转移", 409);
      const expectedDigest = sha256(leaseToken);
      const update = async (source) => {
        const response = await source.collection("import_records").doc(id).get();
        const current = response && response.data;
        if (!current || current.status !== "processing" || current.executionLeaseDigest !== expectedDigest) {
          fail("IMPORT_PROCESSING_LEASE_LOST", "导入执行权已转移", 409);
        }
        await source.collection("import_records").doc(id).update({ data: patch });
      };
      if (typeof db.runTransaction === "function") return db.runTransaction(update);
      fail("IMPORT_PROCESSING_CAS_UNAVAILABLE", "导入执行保护暂不可用", 503);
    },
    async findCompletedByDedupeKey(dedupeKey, exceptId) {
      const result = await db.collection("import_records").where({ dedupeKey, status: "success" }).limit(2).get();
      return (result.data || []).map((row) => ({ ...row, id: row._id })).find((row) => row.id !== exceptId) || null;
    },
    async getItemResult(recordId, itemId) {
      try {
        const result = await db.collection("import_record_items").doc(itemDocumentId(recordId, itemId)).get();
        return result && result.data || null;
      } catch (error) {
        if (missingDocument(error)) return null;
        throw error;
      }
    },
    async beginItemExecution(recordId, item, context = {}) {
      const latestId = itemDocumentId(recordId, item.id);
      const expectedLeaseDigest = sha256(context.executionLeaseToken);
      const itemLeaseTokenHash = sha256(context.itemLeaseToken);
      return db.runTransaction(async (tx) => {
        const recordResponse = await tx.collection("import_records").doc(recordId).get();
        const record = recordResponse && recordResponse.data;
        if (!record || record.status !== "processing" || record.executionLeaseDigest !== expectedLeaseDigest) {
          fail("IMPORT_PROCESSING_LEASE_LOST", "导入执行权已转移", 409);
        }
        let existing = null;
        try {
          const response = await tx.collection("import_record_items").doc(latestId).get();
          existing = response && response.data || null;
        } catch (error) {
          if (!missingDocument(error)) throw error;
        }
        if (existing) {
          const conflicts = cleanString(existing.id || existing.rowId, 128) !== item.id
            || existing.key !== item.key || existing.version !== item.version
            || existing.fingerprint !== fingerprintBatchItem(item);
          if (conflicts) return { disposition: "conflict", result: existing };
          if (existing.status === "success") return { disposition: "reuse", result: existing };
          if (["processing", "ambiguous"].includes(existing.status)) return { disposition: "ambiguous", result: existing };
          if (existing.retryable !== true || existing.executionAttempt >= context.executionAttempt) {
            return { disposition: "reuse", result: existing };
          }
        }
        const currentRevision = Number(record.receiptRevision || 0);
        if (!Number.isSafeInteger(currentRevision) || currentRevision < 0 || currentRevision >= Number.MAX_SAFE_INTEGER) {
          fail("IMPORT_RECEIPT_REVISION_INVALID", "导入明细序列异常", 503);
        }
        const revision = currentRevision + 1;
        const eventId = itemEventDocumentId(recordId, item.id, revision);
        const rowMatch = item.id.match(/^row-([1-9][0-9]*)$/);
        const timestamp = db.serverDate();
        const intent = {
          importRecordId: recordId,
          id: item.id,
          rowId: item.id,
          row: rowMatch ? Number(rowMatch[1]) : 0,
          key: item.key,
          version: item.version,
          fingerprint: fingerprintBatchItem(item),
          status: "processing",
          code: "IMPORT_ITEM_EXECUTION_PENDING",
          retryable: false,
          reused: false,
          executionAttempt: context.executionAttempt,
          itemLeaseTokenHash,
          revision,
          eventType: "intent",
          documentId: eventId,
          isLatestIndex: false,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        await tx.collection("import_records").doc(recordId).update({ data: { receiptRevision: revision } });
        await tx.collection("import_record_items").doc(eventId).set({ data: intent });
        await tx.collection("import_record_items").doc(latestId).set({ data: { ...intent, documentId: latestId, isLatestIndex: true } });
        return { disposition: "execute", result: intent };
      });
    },
    async finalizeItemResult(recordId, result, context = {}) {
      const latestId = itemDocumentId(recordId, result.id);
      const expectedLeaseDigest = sha256(context.executionLeaseToken);
      const itemLeaseTokenHash = sha256(context.itemLeaseToken);
      return db.runTransaction(async (tx) => {
        const recordResponse = await tx.collection("import_records").doc(recordId).get();
        const record = recordResponse && recordResponse.data;
        if (!record || record.status !== "processing" || record.executionLeaseDigest !== expectedLeaseDigest) {
          fail("IMPORT_PROCESSING_LEASE_LOST", "导入执行权已转移", 409);
        }
        const latestResponse = await tx.collection("import_record_items").doc(latestId).get();
        const latest = latestResponse && latestResponse.data;
        if (!latest || latest.status !== "processing" || latest.executionAttempt !== context.executionAttempt
          || latest.itemLeaseTokenHash !== itemLeaseTokenHash) {
          fail("IMPORT_ITEM_LEASE_LOST", "导入项执行权已转移", 409);
        }
        const currentRevision = Number(record.receiptRevision || 0);
        if (!Number.isSafeInteger(currentRevision) || currentRevision < 0 || currentRevision >= Number.MAX_SAFE_INTEGER) {
          fail("IMPORT_RECEIPT_REVISION_INVALID", "导入明细序列异常", 503);
        }
        const revision = currentRevision + 1;
        const eventId = itemEventDocumentId(recordId, result.id, revision);
        const timestamp = db.serverDate();
        const final = {
          ...latest,
          status: result.status,
          code: publicCode(result.code),
          retryable: result.status !== "success" && result.retryable === true,
          reused: result.reused === true,
          revision,
          eventType: "final",
          documentId: eventId,
          isLatestIndex: false,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        await tx.collection("import_records").doc(recordId).update({ data: { receiptRevision: revision } });
        await tx.collection("import_record_items").doc(eventId).set({ data: final });
        await tx.collection("import_record_items").doc(latestId).set({ data: { ...final, documentId: latestId, isLatestIndex: true } });
        return final;
      });
    },
    async getItemSnapshot(recordId) {
      const record = await this.getRecord(recordId);
      const revision = Number(record && record.receiptRevision || 0);
      return Number.isSafeInteger(revision) && revision > 0 ? { revision } : null;
    },
    async listItemResults(recordId, { limit, snapshotRevision, after } = {}) {
      const collection = db.collection("import_record_items");
      const command = db.command;
      if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 1 || !command
        || typeof command.lte !== "function" || typeof command.gt !== "function" || typeof command.and !== "function") {
        fail("IMPORT_ITEMS_UNAVAILABLE", "导入明细暂不可用", 503);
      }
      const events = [];
      let afterRevision = 0;
      while (true) {
        const conditions = [
          { importRecordId: recordId },
          { revision: command.lte(snapshotRevision) },
          { isLatestIndex: false }
        ];
        if (afterRevision > 0) conditions.push({ revision: command.gt(afterRevision) });
        const requestLimit = Math.min(IMPORT_RECEIPT_SCAN_PAGE_SIZE, IMPORT_RECEIPT_SCAN_LIMIT + 1 - events.length);
        const result = await collection.where(command.and(conditions))
          .orderBy("revision", "asc")
          .limit(requestLimit)
          .get();
        const page = result && Array.isArray(result.data) ? result.data : [];
        events.push(...page);
        if (events.length > IMPORT_RECEIPT_SCAN_LIMIT) {
          fail("IMPORT_ITEMS_UNAVAILABLE", "导入明细数量超出安全读取范围", 503);
        }
        if (page.length < requestLimit) break;
        const nextRevision = Number(page[page.length - 1] && page[page.length - 1].revision);
        if (!Number.isSafeInteger(nextRevision) || nextRevision <= afterRevision) {
          fail("IMPORT_ITEMS_UNAVAILABLE", "导入明细暂不可用", 503);
        }
        afterRevision = nextRevision;
      }
      const latest = new Map();
      for (const event of events) {
        if (!Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > snapshotRevision) continue;
        const id = cleanString(event.id || event.rowId, 128);
        const rowMatch = id.match(/^row-([1-9][0-9]*)$/);
        const documentId = cleanString(event.documentId || event._id, 128);
        if (!rowMatch || !documentId) continue;
        const previous = latest.get(id);
        if (!previous || event.revision > previous.revision
          || event.revision === previous.revision && documentId.localeCompare(previous.documentId) > 0) {
          latest.set(id, { ...event, id, row: Number(rowMatch[1]), documentId });
        }
      }
      const rows = Array.from(latest.values()).sort((left, right) => left.row - right.row || left.documentId.localeCompare(right.documentId));
      const filtered = after ? rows.filter((row) => row.row > after.row || row.row === after.row && row.documentId.localeCompare(after.documentId) > 0) : rows;
      return { items: filtered.slice(0, limit), total: rows.length };
    }
  };
}

function defaultAuditWriter(db, outbox = defaultOutbox) {
  if (!db) return async () => {};
  return async (event) => {
    const timestamp = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
    await outbox.writeOperationBundle(db, {
      operation: {
        operator: event.actor,
        action: event.action,
        resourceType: "import",
        resourceId: event.importRecordId,
        requestId: event.requestId,
        batchId: event.importRecordId,
        businessKey: event.dedupeKey,
        idempotencyKey: event.idempotencyKey,
        changedFields: ["status"],
        before: { status: event.beforeStatus || "" },
        after: { status: event.status },
        result: { status: event.status, affected: event.affected || 0, reused: event.reused === true },
        sourceClient: "admin_web",
        timestamp
      },
      events: [{
        eventType: "import.updated",
        entityType: "import",
        entityId: event.importRecordId,
        action: event.action,
        version: event.version,
        changedFields: ["status"]
      }]
    });
  };
}

function chunkItems(items) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (itemBytes > BATCH_PAYLOAD_BUDGET) fail("IMPORT_ROW_TOO_LARGE", "单行导入数据过大", 413);
    if (current.length && (current.length >= BATCH_LIMITS.maxItems || bytes + itemBytes > BATCH_PAYLOAD_BUDGET)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += itemBytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function normalizeValidation(raw, row) {
  if (!raw || typeof raw !== "object" || raw.status === "ready") return row;
  if (raw.status !== "validation") return row;
  return {
    ...row,
    status: "validation",
    code: publicCode(raw.code, "VALIDATION_ERROR"),
    message: "数据校验失败",
    ...(Number.isSafeInteger(raw.version) && raw.version >= 0 ? { version: raw.version } : {})
  };
}

function projectStrategyPreview(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const projected = {};
  if (typeof raw.sku === "string" && raw.sku.length <= 256) projected.sku = raw.sku;
  if (typeof raw.name === "string" && raw.name.length <= 256) projected.name = raw.name;
  if (Number.isSafeInteger(raw.before)) projected.before = raw.before;
  if (Number.isSafeInteger(raw.after)) projected.after = raw.after;
  return projected;
}

async function validatePreviewRows(rows, strategy, context) {
  if (!strategy || typeof strategy.validateRow !== "function") return rows;
  const validated = [];
  for (const row of rows) {
    if (row.status !== "ready") {
      validated.push(row);
      continue;
    }
    const result = await strategy.validateRow(row, context);
    validated.push(normalizeValidation(result, {
      ...row,
      ...projectStrategyPreview(result && result.preview),
      ...(Number.isSafeInteger(result && result.version) && result.version >= 0 ? { version: result.version } : {})
    }));
  }
  return validated;
}

function resultFromRecord(record, overrides = {}) {
  return {
    importRecordId: record.id || record._id,
    status: record.status,
    counts: record.counts || {},
    errorSummary: record.errorSummary || [],
    reused: overrides.reused === true,
    duplicate: overrides.reused === true,
    ...overrides
  };
}

function batchIdentity(item) {
  return { id: item.id, key: item.key, version: item.version };
}

function syntheticResult(item, status, code, retryable = false, reused = false) {
  return {
    ...batchIdentity(item),
    status,
    code,
    message: status === "success" ? "处理成功" : "导入项未完成",
    retryable: retryable === true,
    reused: reused === true
  };
}

function receiptResult(stored, item) {
  if (!stored || typeof stored !== "object") return null;
  const storedId = cleanString(stored.id || stored.rowId, 128);
  const expectedFingerprint = fingerprintBatchItem(item);
  if (storedId !== item.id || stored.key !== item.key || stored.version !== item.version || stored.fingerprint !== expectedFingerprint) {
    return syntheticResult(item, "conflict", "BATCH_ITEM_FINGERPRINT_CONFLICT", false, true);
  }
  if (!PUBLIC_BATCH_STATUSES.has(stored.status)) {
    return syntheticResult(item, "business_error", "IMPORT_RECEIPT_INVALID", false, true);
  }
  return {
    ...batchIdentity(item),
    status: stored.status,
    code: publicCode(stored.code),
    message: stored.status === "success" ? "处理成功" : "导入项未完成",
    retryable: stored.status !== "success" && stored.retryable === true,
    reused: true
  };
}

function checkpointCounts(items, total) {
  const counts = executionCounts(items);
  counts.total = total;
  counts.pending = Math.max(0, total - items.length);
  return counts;
}

function createImportService(dependencies = {}) {
  const db = dependencies.db;
  const idempotency = dependencies.idempotency || defaultIdempotency;
  const repository = dependencies.repository || createCloudBaseImportRepository(db, idempotency);
  const parseImportFile = dependencies.parseImportFile || defaultParseImportFile;
  const buildMappedPreview = dependencies.buildMappedPreview || defaultBuildMappedPreview;
  const executeBatch = dependencies.executeBatch || defaultExecuteBatch;
  const strategies = dependencies.strategies || {};
  const mappingProfiles = dependencies.mappingProfiles || {};
  const audit = dependencies.audit || defaultAuditWriter(db, dependencies.outbox || defaultOutbox);
  const now = dependencies.now || (() => new Date());
  const receiptCursorSecret = dependencies.cursorSecret || process.env.IMPORT_RECEIPT_CURSOR_SECRET || process.env.SYNC_CURSOR_SECRET || process.env.ADMIN_WEB_TOKEN_PEPPER;

  async function parseAndMap(command, strategy) {
    const parsed = await parseImportFile(command.file, dependencies.parserDependencies || {});
    let mapped;
    try {
      mapped = buildMappedPreview(parsed, command.mapping, mappingProfiles[command.type] || {});
    } catch (error) {
      if (error && error.code === "IMPORT_MAPPING_REQUIRED" && error.details) {
        return { parsed, mappingRequired: error.details };
      }
      throw error;
    }
    const allRows = await validatePreviewRows(mapped.allRows, strategy, {
      actor: command.actor,
      type: command.type,
      phase: "preview"
    });
    const counts = previewCounts(allRows, mapped.previewTruncated);
    return {
      parsed,
      mapped: {
        ...mapped,
        allRows,
        rows: allRows.slice(0, mapped.rows.length),
        counts
      }
    };
  }

  async function preview(rawCommand = {}) {
    const actor = safeActor(rawCommand.actor);
    const type = safeType(rawCommand.type);
    const strategy = strategies[type];
    const command = { ...rawCommand, actor, type };
    const { parsed, mapped, mappingRequired } = await parseAndMap(command, strategy);
    if (mappingRequired) {
      return {
        status: "mapping_required",
        headers: mappingRequired.headers,
        suggestedMapping: mappingRequired.suggestedMapping,
        requiredFields: mappingRequired.requiredFields,
        mappingErrors: mappingRequired.mappingErrors,
        fileHash: mappingRequired.fileHash,
        parseContext: mappingRequired.parseContext
      };
    }
    if (!strategy || typeof strategy.validateRow !== "function" || typeof strategy.writeRow !== "function") {
      fail("IMPORT_STRATEGY_REQUIRED", "该导入类型尚未接入业务校验与写入服务", 501);
    }
    await repository.ensureCollections();
    const dedupeKey = sha256(`${actor.id}:${type}:${parsed.fileHash}:${mapped.mappingHash}`);
    const status = mapped.counts.validation ? "validation_failed" : "previewed";
    const strategyId = cleanString(strategy.id || strategy.name || type, 80) || type;
    const strategyVersion = Number.isSafeInteger(strategy.version) && strategy.version >= 0 ? strategy.version : 1;
    const idemResult = await idempotency.runIdempotentAction({
      db: db || repository.db,
      actionType: "admin_import_preview",
      operatorIdentity: actor.id,
      operatorType: "admin",
      adminId: actor.id,
      idempotencyKey: rawCommand.idempotencyKey,
      payload: {
        type,
        fileHash: parsed.fileHash,
        parseHash: mapped.parseHash,
        mappingHash: mapped.mappingHash,
        strategyId,
        strategyVersion
      },
      scope: "import_preview",
      scopeId: dedupeKey,
      requestId: rawCommand.requestId
    }, async () => {
      const timestamp = now();
      const record = {
        type,
        fileName: parsed.name,
        fileType: parsed.fileType,
        mimeType: parsed.mimeType,
        fileSize: parsed.size,
        fileHash: parsed.fileHash,
        parseHash: mapped.parseHash,
        mappingHash: mapped.mappingHash,
        mapping: mapped.mapping,
        strategyId,
        strategyVersion,
        operatorId: actor.id,
        operatorRole: actor.role,
        status,
        counts: mapped.counts,
        errorSummary: errorSummary(mapped.allRows),
        dedupeKey,
        executionCursor: 0,
        executionAttempt: 0,
        receiptRevision: 0,
        ambiguousItemIds: [],
        retryableItemIds: [],
        idempotencySummary: {
          digest: defaultOutbox.idempotencyDigest(rawCommand.idempotencyKey),
          status: "preview"
        },
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const importRecordId = await repository.createPreview(record);
      if (!importRecordId) fail("IMPORT_RECORD_CREATE_FAILED", "导入批次创建失败", 500);
      await audit({
        actor,
        action: "import_preview",
        importRecordId,
        requestId: rawCommand.requestId,
        dedupeKey,
        idempotencyKey: rawCommand.idempotencyKey,
        beforeStatus: "",
        status,
        affected: 0,
        version: 1,
        timestamp
      });
      return { importRecordId, status };
    });
    if (!idemResult || idemResult.ok !== true) throw idempotencyFailure(idemResult);
    const importRecordId = cleanString(idemResult.data && idemResult.data.importRecordId, 128);
    if (!importRecordId) fail("IMPORT_RECORD_CREATE_FAILED", "导入批次创建失败", 500);
    return {
      importRecordId,
      status,
      fileHash: parsed.fileHash,
      parseHash: mapped.parseHash,
      fileType: parsed.fileType,
      headers: parsed.headers,
      mapping: mapped.mapping,
      rows: mapped.rows,
      counts: mapped.counts,
      previewTruncated: mapped.previewTruncated,
      duplicate: idemResult.data && idemResult.data.duplicate === true
    };
  }

  async function revalidate(rawCommand, action) {
    const actor = safeActor(rawCommand.actor);
    const type = safeType(rawCommand.type);
    const previewRecordId = cleanString(rawCommand.previewRecordId, 128);
    if (!previewRecordId) fail("IMPORT_PREVIEW_REQUIRED", "缺少服务端预览批次");
    const record = await repository.getRecord(previewRecordId);
    if (!record) fail("IMPORT_PREVIEW_NOT_FOUND", "服务端预览批次不存在", 404);
    if (record.operatorId !== actor.id || record.type !== type) fail("IMPORT_PREVIEW_MISMATCH", "预览批次与当前请求不一致", 409);
    if (record.status === "validation_failed") fail("IMPORT_PREVIEW_HAS_ERRORS", "预览仍包含错误行", 422);
    if (action === "resume" && !["partial", "failed", "processing"].includes(record.status)) {
      fail("IMPORT_RESUME_NOT_ALLOWED", "当前导入批次无需恢复", 409);
    }
    if (action === "resume" && record.status === "processing" && !processingLeaseExpired(record, now())) {
      fail("IMPORT_RESUME_NOT_ALLOWED", "当前导入批次仍在执行", 409);
    }
    const expectedFileHash = cleanString(rawCommand.expectedFileHash, 64);
    const expectedParseHash = cleanString(rawCommand.expectedParseHash, 64);
    const suppliedMappingHash = mappingHash(rawCommand.mapping);
    if (expectedFileHash !== record.fileHash || expectedParseHash !== record.parseHash || suppliedMappingHash !== record.mappingHash) {
      fail("IMPORT_PREVIEW_MISMATCH", "文件或表头映射已变化，请重新预览", 409);
    }
    const parsed = await parseImportFile(rawCommand.file, dependencies.parserDependencies || {});
    const mapped = buildMappedPreview(parsed, rawCommand.mapping, mappingProfiles[type] || {});
    if (parsed.fileHash !== record.fileHash || mapped.parseHash !== record.parseHash || mapped.mappingHash !== record.mappingHash) {
      fail("IMPORT_PREVIEW_MISMATCH", "服务端复验结果与预览不一致", 409);
    }
    return { actor, type, record: { ...record, id: record.id || previewRecordId }, parsed, mapped };
  }

  async function executeImport(rawCommand, action) {
    await repository.ensureCollections();
    const verified = await revalidate(rawCommand, action);
    const strategy = strategies[verified.type];
    if (!strategy || typeof strategy.validateRow !== "function" || typeof strategy.writeRow !== "function") {
      fail("IMPORT_STRATEGY_REQUIRED", "该导入类型尚未接入业务校验与写入服务", 501);
    }
    const fingerprint = {
      type: verified.type,
      previewRecordId: verified.record.id,
      fileHash: verified.parsed.fileHash,
      parseHash: verified.mapped.parseHash,
      mappingHash: verified.mapped.mappingHash
    };
    const idemResult = await idempotency.runIdempotentAction({
      db: db || repository.db,
      actionType: `admin_import_${action}`,
      operatorIdentity: verified.actor.id,
      operatorType: "admin",
      adminId: verified.actor.id,
      idempotencyKey: rawCommand.idempotencyKey,
      payload: fingerprint,
      scope: "import",
      scopeId: verified.record.id,
      requestId: rawCommand.requestId,
      recoverProcessingResult: async () => {
        const current = await repository.getRecord(verified.record.id);
        return current && TERMINAL_STATUSES.has(current.status) ? resultFromRecord(current) : null;
      }
    }, async () => {
      const executionAttempt = Math.max(0, Number(verified.record.executionAttempt || 0)) + 1;
      const businessIdempotencyKey = `import-dedupe-${sha256(`${verified.record.dedupeKey}:${action}:${executionAttempt}`).slice(0, 48)}`;
      const businessResult = await idempotency.runIdempotentAction({
        db: db || repository.db,
        actionType: `admin_import_execute_${action}`,
        operatorIdentity: verified.actor.id,
        operatorType: "admin",
        adminId: verified.actor.id,
        idempotencyKey: businessIdempotencyKey,
        payload: { dedupeKey: verified.record.dedupeKey, action, executionAttempt },
        scope: "import_dedupe",
        scopeId: verified.record.dedupeKey,
        requestId: rawCommand.requestId
      }, async () => {
        const completed = await repository.findCompletedByDedupeKey(verified.record.dedupeKey, verified.record.id);
        if (completed) return resultFromRecord(completed, { reused: true });

        const batchItems = verified.mapped.allRows.map((row) => ({
          id: `row-${row.row}`,
          key: `import-${verified.parsed.fileHash.slice(0, 20)}-${row.row}`,
          version: Number.isSafeInteger(row.version) && row.version >= 0 ? row.version : 0,
          payload: { row: row.row, values: row.values }
        }));
        const initialCursor = action === "resume"
          ? Math.min(batchItems.length, Math.max(0, Number(verified.record.executionCursor || 0)))
          : 0;
        const processingTimestamp = now();
        const processingVersion = Number.isSafeInteger(verified.record.version) ? verified.record.version + 1 : 2;
        const executionLeaseToken = crypto.randomBytes(32).toString("base64url");
        const processingPatch = {
          status: "processing",
          counts: checkpointCounts([], batchItems.length),
          errorSummary: [],
          executionCursor: initialCursor,
          executionAttempt,
          executionLeaseDigest: sha256(executionLeaseToken),
          leaseExpiresAt: leaseDeadline(processingTimestamp),
          recovery: null,
          version: processingVersion,
          updatedAt: processingTimestamp,
          finishedAt: null
        };
        if (typeof repository.beginProcessing === "function") {
          await repository.beginProcessing(verified.record.id, action, processingPatch, {
            now: processingTimestamp,
            leaseToken: executionLeaseToken
          });
        } else {
          fail("IMPORT_PROCESSING_CAS_UNAVAILABLE", "导入执行保护暂不可用", 503);
        }
        if (typeof repository.updateOwnedRecord !== "function") {
          fail("IMPORT_PROCESSING_CAS_UNAVAILABLE", "导入执行保护暂不可用", 503);
        }
        if (typeof repository.beginItemExecution !== "function" || typeof repository.finalizeItemResult !== "function") {
          fail("IMPORT_ITEM_FENCING_UNAVAILABLE", "导入项执行保护暂不可用", 503);
        }

        const ambiguousItemIds = new Set(Array.isArray(verified.record.ambiguousItemIds) ? verified.record.ambiguousItemIds : []);
        const retryableItemIds = new Set(Array.isArray(verified.record.retryableItemIds) ? verified.record.retryableItemIds : []);
        const allResults = [];
        const durableReceiptIds = new Set();
        const chunks = chunkItems(batchItems);
        let chunkStart = 0;
        let interrupted = false;

        async function storedResult(item) {
          const stored = await repository.getItemResult(verified.record.id, item.id);
          const result = receiptResult(stored, item);
          if (result && PUBLIC_BATCH_STATUSES.has(stored && stored.status)) durableReceiptIds.add(item.id);
          return { stored, result };
        }

        function recoveryResult(cursor) {
          const counts = checkpointCounts(allResults, batchItems.length);
          const status = counts.success > 0 || counts.skipped > 0 ? "partial" : "failed";
          const summary = [
            { code: "IMPORT_CHECKPOINT_PERSIST_FAILED", count: 1 },
            ...errorSummary(allResults).filter((item) => item.code !== "IMPORT_CHECKPOINT_PERSIST_FAILED")
          ].slice(0, 10);
          const timestamp = now();
          const recovery = {
            required: true,
            code: "IMPORT_CHECKPOINT_PERSIST_FAILED",
            executionAttempt,
            durableReceiptCount: durableReceiptIds.size
          };
          return {
            patch: {
              status,
              counts,
              errorSummary: summary,
              executionCursor: cursor,
              executionAttempt,
              ambiguousItemIds: Array.from(ambiguousItemIds).sort(),
              retryableItemIds: Array.from(retryableItemIds).sort(),
              recovery,
              version: processingVersion + 1,
              updatedAt: timestamp,
              finishedAt: timestamp
            },
            data: {
              importRecordId: verified.record.id,
              status,
              counts,
              errorSummary: summary,
              items: allResults.slice(0, 200),
              itemsTruncated: allResults.length > 200,
              reused: false
            }
          };
        }

        async function persistOwned(patch, recoveryCursor) {
          try {
            await repository.updateOwnedRecord(verified.record.id, executionLeaseToken, patch);
            return null;
          } catch (_) {
            const fallback = recoveryResult(recoveryCursor);
            try {
              await repository.updateOwnedRecord(verified.record.id, executionLeaseToken, fallback.patch);
              return fallback.data;
            } catch (_) {
              fail("IMPORT_RECOVERY_REQUIRED", "导入执行状态暂未持久化，请稍后重试", 503);
            }
          }
        }

        async function checkpoint(cursor) {
          const timestamp = now();
          return persistOwned({
            status: "processing",
            counts: checkpointCounts(allResults, batchItems.length),
            errorSummary: errorSummary(allResults),
            executionCursor: cursor,
            executionAttempt,
            ambiguousItemIds: Array.from(ambiguousItemIds).sort(),
            retryableItemIds: Array.from(retryableItemIds).sort(),
            version: processingVersion,
            leaseExpiresAt: leaseDeadline(timestamp),
            updatedAt: timestamp
          }, cursor);
        }

        for (const chunk of chunks) {
          const chunkEnd = chunkStart + chunk.length;
          const resolved = new Map();
          const toExecute = [];
          const itemLeaseTokens = new Map();
          const retryablePriorItemIds = new Set();
          for (let index = 0; index < chunk.length; index += 1) {
            const item = chunk[index];
            const absoluteIndex = chunkStart + index;
            const durable = await storedResult(item);
            if (durable.stored) {
              if (durable.result && durable.stored.status === "success") {
                resolved.set(item.id, durable.result);
                retryableItemIds.delete(item.id);
                ambiguousItemIds.delete(item.id);
                continue;
              }
              if (["processing", "ambiguous"].includes(durable.stored.status)) {
                ambiguousItemIds.add(item.id);
                retryableItemIds.delete(item.id);
                resolved.set(item.id, syntheticResult(item, "business_error", "IMPORT_ITEM_AMBIGUOUS", false, true));
                continue;
              }
              if (durable.result && durable.stored.retryable !== true) {
                resolved.set(item.id, durable.result);
                retryableItemIds.delete(item.id);
                ambiguousItemIds.delete(item.id);
                continue;
              }
              if (!durable.result || durable.stored.retryable !== true
                || !Number.isSafeInteger(durable.stored.executionAttempt)
                || durable.stored.executionAttempt >= executionAttempt) {
                ambiguousItemIds.add(item.id);
                retryableItemIds.delete(item.id);
                resolved.set(item.id, syntheticResult(item, "business_error", "IMPORT_ITEM_AMBIGUOUS", false, true));
                continue;
              }
              retryablePriorItemIds.add(item.id);
            } else if (absoluteIndex < initialCursor && ambiguousItemIds.has(item.id)) {
              resolved.set(item.id, syntheticResult(item, "business_error", "IMPORT_ITEM_AMBIGUOUS", false, true));
              continue;
            }
            toExecute.push(item);
          }

          const attempted = new Set();
          let batch = null;
          let chunkError = null;
          let chunkMadeProgress = false;
          if (toExecute.length) {
            try {
              batch = await executeBatch({
                requestId: cleanString(rawCommand.requestId, 100) || `import-${verified.record.id}`,
                batchId: verified.record.id,
                items: toExecute
              }, {
                async getCompletedResult(context) {
                  return null;
                },
                async saveItemResult(result) {
                  await repository.finalizeItemResult(verified.record.id, { ...result, executionAttempt }, {
                    executionAttempt,
                    executionLeaseToken,
                    itemLeaseToken: itemLeaseTokens.get(result.id)
                  });
                },
                async handleItem(item, context) {
                  const row = item.payload;
                  const validation = await strategy.validateRow(row, {
                    ...context,
                    actor: verified.actor,
                    type: verified.type,
                    phase: "confirm"
                  });
                  const itemLeaseToken = crypto.randomBytes(32).toString("base64url");
                  const intent = await repository.beginItemExecution(verified.record.id, item, {
                    executionAttempt,
                    executionLeaseToken,
                    itemLeaseToken,
                    timestamp: now()
                  });
                  if (!intent || intent.disposition === "ambiguous") {
                    ambiguousItemIds.add(item.id);
                    retryableItemIds.delete(item.id);
                    return { status: "business_error", code: "IMPORT_ITEM_AMBIGUOUS", retryable: false };
                  }
                  if (intent.disposition === "conflict") {
                    return { status: "conflict", code: "BATCH_ITEM_FINGERPRINT_CONFLICT", retryable: false };
                  }
                  if (intent.disposition === "reuse") {
                    return receiptResult(intent.result, item)
                      || { status: "business_error", code: "IMPORT_RECEIPT_INVALID", retryable: false };
                  }
                  if (intent.disposition !== "execute") fail("IMPORT_ITEM_FENCING_INVALID", "导入项执行保护结果无效", 503);
                  itemLeaseTokens.set(item.id, itemLeaseToken);
                  attempted.add(item.id);
                  if (validation && validation.status === "validation") {
                    return {
                      status: "validation",
                      code: publicCode(validation.code, "VALIDATION_ERROR"),
                      retryable: false
                    };
                  }
                  const result = await strategy.writeRow(row, {
                    ...context,
                    actor: verified.actor,
                    type: verified.type,
                    phase: action,
                    importRecordId: verified.record.id,
                    validation
                  });
                  if (!result || !PUBLIC_BATCH_STATUSES.has(result.status)) {
                    return { status: "business_error", code: "BATCH_HANDLER_RESULT_INVALID", retryable: false };
                  }
                  return result;
                }
              });
            } catch (error) {
              chunkError = error;
            }
          }

          for (const item of toExecute) {
            const durable = await storedResult(item);
            if (durable.result && PUBLIC_BATCH_STATUSES.has(durable.stored && durable.stored.status)) {
              chunkMadeProgress = true;
              const returned = batch && batch.items.find((result) => result.id === item.id);
              resolved.set(item.id, returned && returned.status === durable.result.status && returned.code === durable.result.code
                ? returned
                : durable.result);
              retryableItemIds.delete(item.id);
              ambiguousItemIds.delete(item.id);
              continue;
            }
            if (durable.stored && ["processing", "ambiguous"].includes(durable.stored.status)) {
              ambiguousItemIds.add(item.id);
              retryableItemIds.delete(item.id);
              resolved.set(item.id, syntheticResult(item, "business_error", "IMPORT_ITEM_AMBIGUOUS", false, false));
              continue;
            }
            if (!attempted.has(item.id) && retryablePriorItemIds.has(item.id)) {
              retryableItemIds.add(item.id);
              resolved.set(item.id, syntheticResult(item, "skipped", "IMPORT_CHUNK_INTERRUPTED", true, false));
              continue;
            }
            if (attempted.has(item.id)) {
              ambiguousItemIds.add(item.id);
              retryableItemIds.delete(item.id);
              resolved.set(item.id, syntheticResult(item, "business_error", "IMPORT_ITEM_AMBIGUOUS", false, false));
            } else {
              retryableItemIds.add(item.id);
              resolved.set(item.id, syntheticResult(item, "skipped", "IMPORT_CHUNK_INTERRUPTED", true, false));
            }
          }

          allResults.push(...chunk.map((item) => resolved.get(item.id)
            || syntheticResult(item, "skipped", "IMPORT_CHUNK_INTERRUPTED", true, false)));
          const checkpointCursor = chunkError && !chunkMadeProgress && attempted.size === 0 ? chunkStart : chunkEnd;
          const checkpointRecovery = await checkpoint(checkpointCursor);
          chunkStart = checkpointCursor;

          if (checkpointRecovery) return checkpointRecovery;

          if (chunkError || chunk.some((item) => ambiguousItemIds.has(item.id))) {
            interrupted = true;
            for (const remaining of batchItems.slice(chunkEnd)) {
              allResults.push(syntheticResult(remaining, "skipped", "IMPORT_CHUNK_INTERRUPTED", true, false));
            }
            break;
          }
        }

        if (!interrupted && allResults.length < batchItems.length) {
          for (const remaining of batchItems.slice(allResults.length)) {
            allResults.push(syntheticResult(remaining, "skipped", "IMPORT_CHUNK_INTERRUPTED", true, false));
          }
        }
        const counts = executionCounts(allResults);
        const status = ambiguousItemIds.size > 0 ? "partial" : overallStatus(counts);
        const summary = errorSummary(allResults);
        const timestamp = now();
        const finalVersion = processingVersion + 1;
        const finalRecovery = await persistOwned({
          status,
          counts,
          errorSummary: summary,
          executionCursor: Math.min(batchItems.length, Math.max(initialCursor, chunkStart)),
          executionAttempt,
          ambiguousItemIds: Array.from(ambiguousItemIds).sort(),
          retryableItemIds: Array.from(retryableItemIds).sort(),
          idempotencySummary: {
            digest: defaultOutbox.idempotencyDigest(rawCommand.idempotencyKey),
            status
          },
          version: finalVersion,
          updatedAt: timestamp,
          finishedAt: timestamp
        }, Math.min(batchItems.length, Math.max(initialCursor, chunkStart)));
        if (finalRecovery) return finalRecovery;
        await audit({
          actor: verified.actor,
          action: action === "resume" ? "import_resume" : "import_confirm",
          importRecordId: verified.record.id,
          requestId: rawCommand.requestId,
          dedupeKey: verified.record.dedupeKey,
          idempotencyKey: rawCommand.idempotencyKey,
          beforeStatus: verified.record.status,
          status,
          affected: counts.success,
          version: finalVersion,
          timestamp
        });
        return {
          importRecordId: verified.record.id,
          status,
          counts,
          errorSummary: summary,
          items: allResults.slice(0, 200),
          itemsTruncated: allResults.length > 200,
          reused: false
        };
      });
      if (!businessResult || businessResult.ok !== true) throw idempotencyFailure(businessResult);
      const businessData = businessResult.data || {};
      return {
        ...businessData,
        reused: businessData.reused === true || businessData.duplicate === true
      };
    });
    if (!idemResult || idemResult.ok !== true) throw idempotencyFailure(idemResult);
    const data = idemResult.data || {};
    return {
      ...data,
      duplicate: data.reused === true || data.duplicate === true
    };
  }

  function readActor(rawActor) {
    const actor = safeActor(rawActor);
    if (actor.role !== "super_admin" && !actor.permissions.includes("inventory:import")) {
      fail("FORBIDDEN", "无权读取导入批次", 403);
    }
    return actor;
  }

  function importRecordId(value) {
    const id = cleanString(value, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) fail("IMPORT_RECORD_ID_INVALID", "导入批次 ID 无效", 400);
    return id;
  }

  function publicTimestamp(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : typeof value.toDate === "function" ? value.toDate() : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function publicCounts(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = {};
    for (const field of ["total", "valid", "failed", "ready", "validation", "success", "skipped", "not_allowed", "conflict", "permission", "business_error", "retryable", "pending"]) {
      const count = source[field];
      if (Number.isSafeInteger(count) && count >= 0) result[field] = count;
    }
    if (typeof source.truncated === "boolean") result.truncated = source.truncated;
    return result;
  }

  async function getDetail(command = {}) {
    readActor(command.actor);
    const id = importRecordId(command.importRecordId);
    const record = await repository.getRecord(id);
    if (!record) fail("IMPORT_PREVIEW_NOT_FOUND", "服务端预览批次不存在", 404);
    return {
      importRecordId: id,
      type: cleanString(record.type, 40),
      fileName: cleanString(record.fileName, 180),
      fileType: cleanString(record.fileType, 20),
      fileSize: Number.isSafeInteger(record.fileSize) && record.fileSize >= 0 ? record.fileSize : 0,
      status: cleanString(record.status, 40),
      counts: publicCounts(record.counts),
      errorSummary: Array.isArray(record.errorSummary) ? record.errorSummary.slice(0, 10).map((item) => ({
        code: publicCode(item && item.code),
        count: Number.isSafeInteger(item && item.count) && item.count >= 0 ? item.count : 0
      })) : [],
      executionCursor: Number.isSafeInteger(record.executionCursor) && record.executionCursor >= 0 ? record.executionCursor : 0,
      executionAttempt: Number.isSafeInteger(record.executionAttempt) && record.executionAttempt >= 0 ? record.executionAttempt : 0,
      version: Number.isSafeInteger(record.version) && record.version >= 0 ? record.version : 0,
      createdAt: publicTimestamp(record.createdAt),
      updatedAt: publicTimestamp(record.updatedAt),
      finishedAt: publicTimestamp(record.finishedAt)
    };
  }

  async function listItems(command = {}) {
    readActor(command.actor);
    const id = importRecordId(command.importRecordId);
    const query = command.query === undefined ? {} : command.query;
    if (!query || typeof query !== "object" || Array.isArray(query)
      || Object.keys(query).some((key) => !["page", "pageSize", "cursor"].includes(key))) {
      fail("IMPORT_ITEMS_QUERY_INVALID", "导入明细分页参数无效", 400);
    }
    const parseInteger = (value, fallback, maximum) => {
      if (value === undefined || value === "") return fallback;
      if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
        fail("IMPORT_ITEMS_QUERY_INVALID", "导入明细分页参数无效", 400);
      }
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1 || number > maximum) fail("IMPORT_ITEMS_QUERY_INVALID", "导入明细分页参数无效", 400);
      return number;
    };
    const page = parseInteger(query.page, 1, 100000);
    const pageSize = parseInteger(query.pageSize, 20, 100);
    const rawCursor = query.cursor === undefined ? "" : query.cursor;
    if (rawCursor !== "" && (typeof rawCursor !== "string" || rawCursor.length > IMPORT_RECEIPT_CURSOR_MAX_LENGTH)) {
      fail("IMPORT_ITEMS_CURSOR_INVALID", "导入明细分页游标无效", 400);
    }
    if (page === 1 && rawCursor) fail("IMPORT_ITEMS_CURSOR_INVALID", "导入明细分页游标无效", 400);
    if (page > 1 && !rawCursor) fail("IMPORT_ITEMS_CURSOR_REQUIRED", "请从导入明细第一页开始按顺序翻页", 400);
    if (typeof repository.listItemResults !== "function") fail("IMPORT_ITEMS_UNAVAILABLE", "导入明细暂不可用", 503);
    const cursor = rawCursor ? decodeReceiptCursor(rawCursor, receiptCursorSecret) : null;
    if (cursor && (cursor.r !== id || cursor.p !== page || cursor.s !== pageSize)) {
      fail("IMPORT_ITEMS_CURSOR_INVALID", "导入明细分页游标无效", 400);
    }
    const record = cursor ? null : await repository.getRecord(id);
    if (!cursor && !record) fail("IMPORT_PREVIEW_NOT_FOUND", "服务端预览批次不存在", 404);
    const snapshot = cursor ? { revision: cursor.vr } : await repository.getItemSnapshot(id);
    const snapshotRevision = Number(snapshot && snapshot.revision);
    if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 1) {
      return { items: [], total: 0, page, pageSize, nextCursor: null };
    }
    const result = await repository.listItemResults(id, {
      limit: pageSize + 1,
      snapshotRevision,
      after: cursor ? { row: cursor.after[0], documentId: cursor.after[1] } : null
    });
    const sourceRows = Array.isArray(result && result.items) ? result.items : [];
    const hasMore = sourceRows.length > pageSize;
    const rows = sourceRows.slice(0, pageSize);
    const total = cursor ? cursor.t : Number.isSafeInteger(result && result.total) && result.total >= 0 ? result.total : 0;
    const items = rows.map((row) => {
      const rowId = cleanString(row && (row.id || row.rowId), 128);
      const match = rowId.match(/^row-([1-9][0-9]*)$/);
      return {
        id: rowId,
        row: match ? Number(match[1]) : 0,
        status: PUBLIC_BATCH_STATUSES.has(row && row.status) ? row.status : "business_error",
        code: publicCode(row && row.code, "IMPORT_RECEIPT_INVALID"),
        retryable: row && row.status !== "success" && row.retryable === true,
        reused: row && row.reused === true,
        updatedAt: publicTimestamp(row && row.updatedAt)
      };
    });
    return {
      items,
      total,
      page,
      pageSize,
      nextCursor: hasMore && items.length ? encodeReceiptCursor({
        v: IMPORT_RECEIPT_CURSOR_VERSION,
        r: id,
        p: page + 1,
        s: pageSize,
        vr: snapshotRevision,
        t: total,
        after: [items[items.length - 1].row, cleanString(rows[rows.length - 1].documentId || rows[rows.length - 1]._id, 128)]
      }, receiptCursorSecret) : null
    };
  }

  return {
    preview,
    confirm(command) { return executeImport(command, "confirm"); },
    resume(command) { return executeImport(command, "resume"); },
    getDetail,
    listItems
  };
}

module.exports = {
  IMPORT_TYPES,
  ImportFrameworkError,
  chunkItems,
  createCloudBaseImportRepository,
  createImportService,
  errorSummary,
  executionCounts
};
