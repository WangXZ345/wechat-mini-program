"use strict";

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const { executeBatch, fingerprintBatchItem } = require("../lib/batchExecutor");
const { buildMappedPreview, parseImportFile } = require("../lib/importFileParser");
const { createCloudBaseImportRepository, createImportService } = require("../lib/importService");

function payload(name, text) {
  const buffer = Buffer.from(text, "utf8");
  return { name, mimeType: "text/csv", size: buffer.length, contentBase64: buffer.toString("base64") };
}

function memoryRepository(options = {}) {
  const records = new Map();
  const items = new Map();
  let sequence = 0;
  function assertRecordOwner(recordId, executionLeaseToken) {
    const current = records.get(recordId);
    const digest = crypto.createHash("sha256").update(String(executionLeaseToken)).digest("hex");
    if (!current || current.status !== "processing" || current.executionLeaseDigest !== digest) {
      const error = new Error("lease lost");
      error.code = "IMPORT_PROCESSING_LEASE_LOST";
      error.statusCode = 409;
      throw error;
    }
    return current;
  }
  return {
    records,
    items,
    async createPreview(record) {
      const id = `import-${++sequence}`;
      records.set(id, { ...record, id });
      return id;
    },
    async getRecord(id) { return records.get(id) || null; },
    async updateRecord(id, patch) { records.set(id, { ...records.get(id), ...patch }); },
    async beginProcessing(id, action, patch, context = {}) {
      const current = records.get(id);
      const currentLeaseExpiresAt = current && current.leaseExpiresAt ? new Date(current.leaseExpiresAt).getTime() : NaN;
      const requestedAt = context.now ? new Date(context.now).getTime() : Date.now();
      const stale = action === "resume" && current && current.status === "processing"
        && Number.isFinite(currentLeaseExpiresAt) && currentLeaseExpiresAt <= requestedAt;
      const allowed = action === "resume" ? ["partial", "failed"] : ["previewed"];
      if (!current || !allowed.includes(current.status) && !stale) {
        const error = new Error("state conflict");
        error.code = action === "resume" ? "IMPORT_RESUME_NOT_ALLOWED" : "IMPORT_CONFIRM_NOT_ALLOWED";
        error.statusCode = 409;
        throw error;
      }
      records.set(id, { ...current, ...patch });
      return { ...current, ...patch, id };
    },
    async updateOwnedRecord(id, leaseToken, patch) {
      const current = assertRecordOwner(id, leaseToken);
      records.set(id, { ...current, ...patch });
    },
    async findCompletedByDedupeKey(key, exceptId) {
      return Array.from(records.values()).find((record) => record.id !== exceptId && record.dedupeKey === key && record.status === "success") || null;
    },
    async getItemResult(recordId, itemId) { return items.get(`${recordId}:${itemId}`) || null; },
    async beginItemExecution(recordId, item, context = {}) {
      const record = assertRecordOwner(recordId, context.executionLeaseToken);
      const key = `${recordId}:${item.id}`;
      const existing = items.get(key);
      if (existing) {
        if (existing.id !== item.id || existing.key !== item.key || existing.version !== item.version
          || existing.fingerprint !== fingerprintBatchItem(item)) return { disposition: "conflict", result: existing };
        if (existing.status === "success") return { disposition: "reuse", result: existing };
        if (["processing", "ambiguous"].includes(existing.status)) return { disposition: "ambiguous", result: existing };
        if (existing.retryable !== true || existing.executionAttempt >= context.executionAttempt) {
          return { disposition: "reuse", result: existing };
        }
      }
      const revision = Number(record.receiptRevision || 0) + 1;
      records.set(recordId, { ...record, receiptRevision: revision });
      const intent = {
        id: item.id,
        rowId: item.id,
        key: item.key,
        version: item.version,
        fingerprint: fingerprintBatchItem(item),
        status: "processing",
        code: "IMPORT_ITEM_EXECUTION_PENDING",
        retryable: false,
        reused: false,
        executionAttempt: context.executionAttempt,
        itemLeaseTokenHash: crypto.createHash("sha256").update(String(context.itemLeaseToken)).digest("hex"),
        revision,
        documentId: `intent-${item.id}-${context.executionAttempt}-${revision}`,
        isLatestIndex: false,
        createdAt: context.timestamp,
        updatedAt: context.timestamp
      };
      items.set(`${recordId}:event:${revision}`, intent);
      items.set(key, { ...intent, documentId: `latest-${item.id}`, isLatestIndex: true });
      return { disposition: "execute", result: intent };
    },
    async finalizeItemResult(recordId, result, context = {}) {
      assertRecordOwner(recordId, context.executionLeaseToken);
      if (options.failFinalReceiptIds && options.failFinalReceiptIds.has(result.id)) throw new Error("receipt store unavailable");
      const key = `${recordId}:${result.id}`;
      const intent = items.get(key);
      const itemDigest = crypto.createHash("sha256").update(String(context.itemLeaseToken)).digest("hex");
      if (!intent || intent.status !== "processing" || intent.executionAttempt !== context.executionAttempt
        || intent.itemLeaseTokenHash !== itemDigest) {
        const error = new Error("item lease lost");
        error.code = "IMPORT_ITEM_LEASE_LOST";
        error.statusCode = 409;
        throw error;
      }
      const record = records.get(recordId);
      const revision = Number(record.receiptRevision || 0) + 1;
      records.set(recordId, { ...record, receiptRevision: revision });
      const stored = {
        ...intent,
        ...result,
        revision,
        documentId: `final-${result.id}-${context.executionAttempt}-${revision}`,
        isLatestIndex: false,
        createdAt: context.timestamp,
        updatedAt: context.timestamp
      };
      items.set(`${recordId}:event:${revision}`, stored);
      items.set(key, { ...stored, documentId: `latest-${result.id}`, isLatestIndex: true });
      return stored;
    },
    async getItemSnapshot(recordId) {
      const record = records.get(recordId);
      const revision = Number(record && record.receiptRevision || 0);
      if (Number.isSafeInteger(revision) && revision > 0) return { revision };
      const revisions = Array.from(items.entries())
        .filter(([key]) => key.startsWith(`${recordId}:`))
        .map(([, value]) => Number(value.revision || 0))
        .filter((value) => Number.isSafeInteger(value) && value > 0);
      return revisions.length ? { revision: Math.max(...revisions) } : null;
    },
    async saveItemResult(recordId, result) {
      if (options.failReceiptIds && options.failReceiptIds.has(result.id)) throw new Error("receipt store unavailable");
      const key = `${recordId}:${result.id}`;
      const previous = items.get(key);
      items.set(key, {
        ...result,
        documentId: `document-${result.id}`,
        createdAttempt: previous && previous.createdAttempt || result.executionAttempt || result.attempt || 1,
        createdAt: previous && previous.createdAt || new Date("2026-08-09T12:00:00.000Z"),
        updatedAt: new Date("2026-08-09T12:00:00.000Z")
      });
    },
    async listItemResults(recordId, { skip = 0, limit, snapshotRevision = Number.MAX_SAFE_INTEGER, after } = {}) {
      const rows = Array.from(items.entries())
        .filter(([key]) => key.startsWith(`${recordId}:`))
        .map(([, value]) => value)
        .filter((value) => value.isLatestIndex !== true)
        .filter((value) => Number(value.revision || 0) <= snapshotRevision);
      const latest = new Map();
      for (const value of rows) {
        const previous = latest.get(value.id);
        if (!previous || Number(value.revision || 0) > Number(previous.revision || 0)) latest.set(value.id, value);
      }
      const sorted = Array.from(latest.values())
        .sort((left, right) => Number(String(left.id).slice(4)) - Number(String(right.id).slice(4))
          || String(left.documentId).localeCompare(String(right.documentId)));
      const start = after ? sorted.findIndex((row) => row.documentId === after.documentId && Number(String(row.id).slice(4)) === after.row) + 1 : skip;
      return { items: sorted.slice(Math.max(0, start), Math.max(0, start) + limit), total: sorted.length };
    },
    async ensureCollections() {}
  };
}

function memoryIdempotency() {
  const entries = new Map();
  const inFlight = new Map();
  return {
    async runIdempotentAction(options, executor) {
      const key = `${options.actionType}:${options.operatorIdentity}:${options.idempotencyKey}`;
      const requestHash = crypto.createHash("sha256").update(JSON.stringify(options.payload)).digest("hex");
      const previous = entries.get(key);
      if (previous && previous.requestHash !== requestHash) {
        return { ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", message: "conflict" };
      }
      if (previous) return { ok: true, data: { ...previous.data, duplicate: true, idempotencyStatus: "success" } };
      const pending = inFlight.get(key);
      if (pending && pending.requestHash !== requestHash) return { ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", message: "conflict" };
      if (pending) {
        const data = await pending.promise;
        return { ok: true, data: { ...data, duplicate: true, idempotencyStatus: "success" } };
      }
      const promise = Promise.resolve().then(() => executor({ recordId: `idem:${key}` }));
      inFlight.set(key, { requestHash, promise });
      const data = await promise;
      entries.set(key, { requestHash, data });
      inFlight.delete(key);
      return { ok: true, data: { ...data, duplicate: false, idempotencyStatus: "success" } };
    }
  };
}

function serviceFixture(strategy, overrides = {}) {
  const repository = memoryRepository(overrides.repositoryOptions);
  const audits = [];
  const service = createImportService({
    repository,
    idempotency: memoryIdempotency(),
    executeBatch: overrides.executeBatch || executeBatch,
    parseImportFile,
    buildMappedPreview,
    strategies: { inventory: strategy },
    mappingProfiles: { inventory: { required: ["name", "value"] } },
    audit: async (event) => audits.push(event),
    now: overrides.now || (() => new Date("2026-08-09T12:00:00.000Z")),
    cursorSecret: overrides.cursorSecret || "unit-test-import-cursor-secret-012345"
  });
  return { service, repository, audits };
}

const actor = { id: "admin-1", role: "procurement", permissions: ["inventory:import"], status: "active" };
const mapping = { sku: "sku", name: "name", value: "stock" };

async function preview(service, file, key = "preview-key-0001") {
  return service.preview({ actor, type: "inventory", file, mapping, idempotencyKey: key, requestId: key });
}

async function confirm(service, previewResult, file, key = "confirm-key-0001", action = "confirm") {
  return service[action]({
    actor,
    type: "inventory",
    file,
    mapping,
    previewRecordId: previewResult.importRecordId,
    expectedFileHash: previewResult.fileHash,
    expectedParseHash: previewResult.parseHash,
    idempotencyKey: key,
    requestId: key
  });
}

test("stores hashes, operator and counts without retaining complete file content", async () => {
  const { service, repository } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() { return { status: "success", code: "OK" }; }
  });
  const input = payload("inventory.csv", "sku,name,stock\nA,Safe item,2");
  const result = await preview(service, input);
  const record = repository.records.get(result.importRecordId);

  assert.equal(record.type, "inventory");
  assert.equal(record.operatorId, "admin-1");
  assert.match(record.fileHash, /^[a-f0-9]{64}$/);
  assert.equal(record.status, "previewed");
  assert.deepEqual(record.counts, { total: 1, valid: 1, failed: 0, ready: 1, validation: 0, truncated: false });
  assert.equal(JSON.stringify(record).includes(input.contentBase64), false);
  assert.equal(Object.hasOwn(record, "fileContent"), false);
  assert.equal(Object.hasOwn(record, "rows"), false);
});

test("preview fails closed without a domain strategy and does not create a ready batch or audit", async () => {
  const { service, repository, audits } = serviceFixture(undefined);
  const input = payload("inventory.csv", "sku,name,stock\nA,Safe item,2");

  await assert.rejects(
    preview(service, input),
    (error) => error.code === "IMPORT_STRATEGY_REQUIRED" && error.statusCode === 501
  );
  assert.equal(repository.records.size, 0);
  assert.equal(audits.length, 0);
});

test("strategy preview metadata cannot overwrite canonical row data or inject sensitive fields", async () => {
  const { service } = serviceFixture({
    async validateRow() {
      return {
        status: "ready",
        preview: { row: 999, values: { operatorOpenid: "secret" }, operatorOpenid: "secret", sku: "A", after: 2 }
      };
    },
    async writeRow() { return { status: "success", code: "OK" }; }
  });
  const result = await preview(service, payload("inventory.csv", "sku,name,stock\nA,Safe item,2"));

  assert.equal(result.rows[0].row, 2);
  assert.deepEqual(result.rows[0].values, { sku: "A", name: "Safe item", value: "2" });
  assert.equal(result.rows[0].sku, "A");
  assert.equal(result.rows[0].after, 2);
  assert.equal(Object.hasOwn(result.rows[0], "operatorOpenid"), false);
});

test("unknown headers return mapping_required context without creating a batch", async () => {
  const { service, repository, audits } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() { return { status: "success", code: "OK" }; }
  });
  const input = payload("inventory.csv", "货号,品名,数量\nA,Safe item,2");
  const result = await service.preview({
    actor,
    type: "inventory",
    file: input,
    mapping: {},
    idempotencyKey: "mapping-required-key",
    requestId: "mapping-required-key"
  });

  assert.equal(result.status, "mapping_required");
  assert.deepEqual(result.headers, ["货号", "品名", "数量"]);
  assert.deepEqual(result.requiredFields, ["name", "value"]);
  assert.deepEqual(result.mappingErrors.map((item) => item.field), ["name", "value"]);
  assert.match(result.fileHash, /^[a-f0-9]{64}$/);
  assert.match(result.parseContext.hash, /^[a-f0-9]{64}$/);
  assert.equal(result.parseContext.rowCount, 1);
  assert.equal(repository.records.size, 0);
  assert.equal(audits.length, 0);
});

test("preview idempotency reuses one batch, conflicts on changed input and collapses concurrent duplicates", async () => {
  const { service, repository, audits } = serviceFixture({
    id: "inventory-import",
    version: 1,
    async validateRow() { return { status: "ready" }; },
    async writeRow() { return { status: "success", code: "OK" }; }
  });
  const firstFile = payload("inventory.csv", "sku,name,stock\nA,Safe item,2");
  const changedFile = payload("inventory.csv", "sku,name,stock\nA,Safe item,3");

  const [first, concurrent] = await Promise.all([
    preview(service, firstFile, "preview-shared-key"),
    preview(service, firstFile, "preview-shared-key")
  ]);
  const repeated = await preview(service, firstFile, "preview-shared-key");
  assert.equal(concurrent.importRecordId, first.importRecordId);
  assert.equal(repeated.importRecordId, first.importRecordId);
  assert.deepEqual(repeated.rows, first.rows);
  assert.equal(repository.records.size, 1);
  assert.equal(audits.length, 1);

  await assert.rejects(
    preview(service, changedFile, "preview-shared-key"),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409
  );
  assert.equal(repository.records.size, 1);
});

test("a second confirm cannot enter while the first attempt is processing", async () => {
  let releaseFirst;
  let signalFirstWrite;
  let writes = 0;
  const firstWriteStarted = new Promise((resolve) => { signalFirstWrite = resolve; });
  const firstWriteGate = new Promise((resolve) => { releaseFirst = resolve; });
  const { service } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() {
      writes += 1;
      if (writes === 1) {
        signalFirstWrite();
        await firstWriteGate;
      }
      return { status: "success", code: "OK" };
    }
  });
  const input = payload("inventory.csv", "sku,name,stock\nA,Safe item,2");
  const previewResult = await preview(service, input);
  const first = confirm(service, previewResult, input, "confirm-key-first");
  await firstWriteStarted;

  try {
    await assert.rejects(
      confirm(service, previewResult, input, "confirm-key-second"),
      (error) => error.code === "IMPORT_CONFIRM_NOT_ALLOWED" && error.statusCode === 409
    );
  } finally {
    releaseFirst();
    await first;
  }
  assert.equal(writes, 1);
});

test("confirmation reparses and rejects file, mapping or parse hash differences", async () => {
  const { service } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() { return { status: "success", code: "OK" }; }
  });
  const first = payload("inventory.csv", "sku,name,stock\nA,Safe item,2");
  const changed = payload("inventory.csv", "sku,name,stock\nA,Safe item,3");
  const prepared = await preview(service, first);

  await assert.rejects(
    confirm(service, prepared, changed),
    (error) => error.code === "IMPORT_PREVIEW_MISMATCH" && error.statusCode === 409
  );
  await assert.rejects(
    service.confirm({
      actor,
      type: "inventory",
      file: first,
      mapping: { ...mapping, value: "name" },
      previewRecordId: prepared.importRecordId,
      expectedFileHash: prepared.fileHash,
      expectedParseHash: prepared.parseHash,
      idempotencyKey: "confirm-key-mapping",
      requestId: "confirm-key-mapping"
    }),
    (error) => error.code === "IMPORT_PREVIEW_MISMATCH"
  );
});

test("same key with another file conflicts while a completed identical file is deterministically reused", async () => {
  let writes = 0;
  const { service } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() { writes += 1; return { status: "success", code: "OK" }; }
  });
  const firstFile = payload("one.csv", "sku,name,stock\nA,Safe item,2");
  const secondFile = payload("two.csv", "sku,name,stock\nB,Other item,4");
  const first = await preview(service, firstFile, "preview-key-one");
  const second = await preview(service, secondFile, "preview-key-two");
  const completed = await confirm(service, first, firstFile, "shared-confirm-key");
  assert.equal(completed.status, "success");
  assert.equal(writes, 1);

  await assert.rejects(
    confirm(service, second, secondFile, "shared-confirm-key"),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409
  );

  const repeatedPreview = await preview(service, firstFile, "preview-key-repeat");
  const repeated = await confirm(service, repeatedPreview, firstFile, "another-confirm-key");
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.importRecordId, completed.importRecordId);
  assert.equal(writes, 1);
});

test("executes more than 50 rows in controlled batches and resumes only failed rows", async () => {
  const attempts = new Map();
  const { service, repository } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow(row) {
      const rowNo = row.row;
      attempts.set(rowNo, (attempts.get(rowNo) || 0) + 1);
      if (rowNo === 56 && attempts.get(rowNo) === 1) {
        return { status: "business_error", code: "SERVICE_UNAVAILABLE", retryable: true };
      }
      return { status: "success", code: "OK" };
    }
  });
  const lines = ["sku,name,stock"];
  for (let index = 1; index <= 60; index += 1) lines.push(`SKU-${index},Item ${index},${index}`);
  const input = payload("large.csv", lines.join("\n"));
  const prepared = await preview(service, input, "preview-large-key");
  const partial = await confirm(service, prepared, input, "confirm-large-key");

  assert.equal(partial.status, "partial");
  assert.equal(partial.counts.total, 60);
  assert.equal(partial.counts.success, 59);
  assert.equal(partial.counts.failed, 1);
  assert.equal(repository.records.get(prepared.importRecordId).status, "partial");

  const resumed = await confirm(service, prepared, input, "resume-large-key", "resume");
  assert.equal(resumed.status, "success");
  assert.equal(resumed.counts.success, 60);
  assert.equal(attempts.get(56), 2);
  assert.equal(attempts.get(2), 1);
  assert.equal(Array.from(attempts.values()).reduce((sum, value) => sum + value, 0), 61);
});

test("checkpoints the first chunk when the second chunk aborts and resume never rewrites it", async () => {
  let batchCalls = 0;
  const attempts = new Map();
  const faultingBatch = async (...args) => {
    batchCalls += 1;
    if (batchCalls === 2) throw Object.assign(new Error("injected second chunk failure"), { code: "DATABASE_REQUEST_FAILED", retryable: true });
    return executeBatch(...args);
  };
  const { service, repository } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow(row) {
      attempts.set(row.row, (attempts.get(row.row) || 0) + 1);
      return { status: "success", code: "OK" };
    }
  }, { executeBatch: faultingBatch });
  const lines = ["sku,name,stock"];
  for (let index = 1; index <= 60; index += 1) lines.push(`SKU-${index},Item ${index},${index}`);
  const input = payload("interrupted.csv", lines.join("\n"));
  const prepared = await preview(service, input, "preview-interrupted-key");

  const partial = await confirm(service, prepared, input, "confirm-interrupted-key");
  const checkpoint = repository.records.get(prepared.importRecordId);
  assert.equal(partial.status, "partial");
  assert.equal(checkpoint.status, "partial");
  assert.equal(checkpoint.executionCursor, 50);
  assert.equal(checkpoint.executionAttempt, 1);
  assert.equal(checkpoint.counts.success, 50);

  const resumed = await confirm(service, prepared, input, "resume-interrupted-key", "resume");
  assert.equal(resumed.status, "success");
  assert.equal(attempts.get(2), 1);
  assert.equal(attempts.get(52), 1);
  assert.equal(Array.from(attempts.values()).reduce((sum, value) => sum + value, 0), 60);
});

test("a missing durable receipt cannot be reported as success or retried ambiguously", async () => {
  let writes = 0;
  const { service, repository } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() { writes += 1; return { status: "success", code: "OK" }; }
  }, { repositoryOptions: { failFinalReceiptIds: new Set(["row-2"]) } });
  const input = payload("receipt-failure.csv", "sku,name,stock\nA,Safe item,2\nB,Other item,3");
  const prepared = await preview(service, input, "preview-receipt-key");

  const partial = await confirm(service, prepared, input, "confirm-receipt-key");
  assert.equal(partial.status, "partial");
  assert.equal(partial.counts.success, 1);
  assert.equal(partial.counts.failed, 1);
  assert.deepEqual(repository.records.get(prepared.importRecordId).ambiguousItemIds, ["row-2"]);
  assert.equal(writes, 2);

  const resumed = await confirm(service, prepared, input, "resume-receipt-key", "resume");
  assert.equal(resumed.status, "partial");
  assert.equal(writes, 2);
});

test("reads a strict persisted batch detail and paged receipt projection", async () => {
  const { service } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() { return { status: "success", code: "OK" }; }
  });
  const input = payload("detail.csv", "sku,name,stock\nA,Safe item,2\nB,Other item,3");
  const prepared = await preview(service, input, "preview-detail-key");
  await confirm(service, prepared, input, "confirm-detail-key");

  const detail = await service.getDetail({ actor, importRecordId: prepared.importRecordId });
  assert.equal(detail.status, "success");
  assert.equal(detail.counts.total, 2);
  assert.equal(detail.counts.success, 2);
  assert.equal(detail.counts.failed, 0);
  for (const forbidden of ["operatorId", "operatorRole", "mapping", "dedupeKey", "idempotencySummary", "contentBase64", "fileContent"]) {
    assert.equal(Object.hasOwn(detail, forbidden), false, forbidden);
  }

  const page = await service.listItems({ actor, importRecordId: prepared.importRecordId, query: { page: 1, pageSize: 1 } });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ["code", "id", "retryable", "reused", "row", "status", "updatedAt"]);
  assert.equal(JSON.stringify(page).includes("fingerprint"), false);
  assert.equal(JSON.stringify(page).includes("import-" + prepared.fileHash.slice(0, 20)), false);
  await assert.rejects(
    service.listItems({ actor, importRecordId: prepared.importRecordId, query: { page: 1, pageSize: 1, search: "secret" } }),
    (error) => error.code === "IMPORT_ITEMS_QUERY_INVALID"
  );
  await assert.rejects(
    service.getDetail({ actor: { ...actor, permissions: [] }, importRecordId: prepared.importRecordId }),
    (error) => error.code === "FORBIDDEN"
  );
});

test("persists fenced append-only receipt revisions and paginates them in numeric row order", async () => {
  const executionLeaseToken = "record-owner-token";
  const records = new Map([["import-1", {
    _id: "import-1",
    status: "processing",
    executionLeaseDigest: crypto.createHash("sha256").update(executionLeaseToken).digest("hex"),
    receiptRevision: 0
  }]]);
  const receiptDocuments = new Map();
  const fixedTimestamp = new Date("2026-08-09T12:00:00.000Z");
  const db = {
    serverDate() { return fixedTimestamp; },
    command: {
      lte(value) { return { $lte: value }; },
      gt(value) { return { $gt: value }; },
      and(conditions) { return { conditions }; }
    },
    async runTransaction(executor) { return executor(db); },
    collection(name) {
      if (name === "import_records") {
        return {
          doc(id) {
            return {
              async get() { return { data: records.get(id) }; },
              async update(input) { records.set(id, { ...records.get(id), ...input.data }); }
            };
          }
        };
      }
      assert.equal(name, "import_record_items");
      return {
        doc(id) {
          return {
            async get() { return { data: receiptDocuments.get(id) }; },
            async set(input) { receiptDocuments.set(id, { ...input.data, _id: id }); }
          };
        },
        where(filter) {
          const recordCondition = filter.conditions.find((condition) => Object.hasOwn(condition, "importRecordId"));
          const revisionConditions = filter.conditions.filter((condition) => Object.hasOwn(condition, "revision"));
          const indexCondition = filter.conditions.find((condition) => Object.hasOwn(condition, "isLatestIndex"));
          assert.deepEqual(indexCondition, { isLatestIndex: false });
          let rows = Array.from(receiptDocuments.values())
            .filter((document) => document.importRecordId === recordCondition.importRecordId)
            .filter((document) => document.isLatestIndex === false);
          for (const condition of revisionConditions) {
            if (Object.hasOwn(condition.revision, "$lte")) rows = rows.filter((document) => document.revision <= condition.revision.$lte);
            if (Object.hasOwn(condition.revision, "$gt")) rows = rows.filter((document) => document.revision > condition.revision.$gt);
          }
          const query = {
            orderBy(field, direction) {
              assert.deepEqual([field, direction], ["revision", "asc"]);
              rows.sort((left, right) => left.revision - right.revision);
              return query;
            },
            limit(value) {
              assert.ok(value <= 1000, `CloudBase limit maximum is 1000, received ${value}`);
              return query;
            },
            async get() { return { data: rows }; }
          };
          return query;
        }
      };
    }
  };
  const repository = createCloudBaseImportRepository(db);

  async function executeRow(row) {
    const item = {
      id: `row-${row}`,
      key: `row-key-${row}`,
      version: 0,
      payload: { row, values: { sku: `SKU-${row}` } }
    };
    const itemLeaseToken = `item-owner-${row}`;
    const begun = await repository.beginItemExecution("import-1", item, {
      executionAttempt: 1,
      executionLeaseToken,
      itemLeaseToken
    });
    assert.equal(begun.disposition, "execute");
    await assert.rejects(
      repository.finalizeItemResult("import-1", { id: item.id, status: "success", code: "OK", retryable: false }, {
        executionAttempt: 1,
        executionLeaseToken,
        itemLeaseToken: "stale-item-owner"
      }),
      (error) => error.code === "IMPORT_ITEM_LEASE_LOST"
    );
    await repository.finalizeItemResult("import-1", {
      id: item.id, status: "success", code: "OK", retryable: false, reused: false
    }, { executionAttempt: 1, executionLeaseToken, itemLeaseToken });
  }

  await executeRow(10);
  await executeRow(2);
  const result = await repository.listItemResults("import-1", { limit: 20, snapshotRevision: 4 });
  const immutableEvents = Array.from(receiptDocuments.values()).filter((document) => document.isLatestIndex === false);

  assert.equal(records.get("import-1").receiptRevision, 4);
  assert.deepEqual(immutableEvents.map((event) => event.revision), [1, 2, 3, 4]);
  assert.deepEqual(immutableEvents.filter((event) => event.id === "row-10").map((event) => event.status), ["processing", "success"]);
  assert.deepEqual(result.items.map((item) => item.id), ["row-2", "row-10"]);
  assert.equal(result.total, 2);
});

function receiptRevisionScanFixture(eventCount) {
  const events = Array.from({ length: eventCount }, (_, offset) => {
    const revision = offset + 1;
    const row = Math.ceil(revision / 2);
    const finalized = revision % 2 === 0;
    return {
      _id: `event-${revision}`,
      documentId: `event-${revision}`,
      importRecordId: "import-large-receipt",
      id: `row-${row}`,
      rowId: `row-${row}`,
      revision,
      isLatestIndex: false,
      status: finalized ? "success" : "processing",
      code: finalized ? "OK" : "PROCESSING",
      retryable: false,
      reused: false,
      updatedAt: new Date("2026-08-09T12:00:00.000Z")
    };
  });
  const observedLimits = [];
  const db = {
    command: {
      lte(value) { return { $lte: value }; },
      gt(value) { return { $gt: value }; },
      and(conditions) { return { conditions }; }
    },
    collection(name) {
      assert.equal(name, "import_record_items");
      return {
        where(filter) {
          const recordCondition = filter.conditions.find((condition) => Object.hasOwn(condition, "importRecordId"));
          const indexCondition = filter.conditions.find((condition) => Object.hasOwn(condition, "isLatestIndex"));
          const revisionConditions = filter.conditions.filter((condition) => Object.hasOwn(condition, "revision"));
          let rows = events
            .filter((event) => event.importRecordId === recordCondition.importRecordId)
            .filter((event) => event.isLatestIndex === indexCondition.isLatestIndex);
          for (const condition of revisionConditions) {
            if (Object.hasOwn(condition.revision, "$lte")) rows = rows.filter((event) => event.revision <= condition.revision.$lte);
            if (Object.hasOwn(condition.revision, "$gt")) rows = rows.filter((event) => event.revision > condition.revision.$gt);
          }
          const query = {
            orderBy(field, direction) {
              assert.deepEqual([field, direction], ["revision", "asc"]);
              rows.sort((left, right) => left.revision - right.revision);
              return query;
            },
            limit(value) {
              if (value > 1000) throw new Error(`CloudBase limit maximum is 1000, received ${value}`);
              observedLimits.push(value);
              rows = rows.slice(0, value);
              return query;
            },
            async get() { return { data: rows }; }
          };
          return query;
        }
      };
    }
  };
  return { db, observedLimits };
}

test("scans ten thousand receipt revisions in CloudBase-sized keyset pages", async () => {
  const { db, observedLimits } = receiptRevisionScanFixture(10_000);
  const repository = createCloudBaseImportRepository(db);

  const result = await repository.listItemResults("import-large-receipt", {
    limit: 20,
    snapshotRevision: 10_000
  });

  assert.equal(result.total, 5_000);
  assert.deepEqual(result.items.map((item) => [item.id, item.status]), [
    ["row-1", "success"],
    ["row-2", "success"],
    ["row-3", "success"],
    ["row-4", "success"],
    ["row-5", "success"],
    ["row-6", "success"],
    ["row-7", "success"],
    ["row-8", "success"],
    ["row-9", "success"],
    ["row-10", "success"],
    ["row-11", "success"],
    ["row-12", "success"],
    ["row-13", "success"],
    ["row-14", "success"],
    ["row-15", "success"],
    ["row-16", "success"],
    ["row-17", "success"],
    ["row-18", "success"],
    ["row-19", "success"],
    ["row-20", "success"]
  ]);
  assert.ok(observedLimits.length > 1);
  assert.ok(observedLimits.every((value) => value <= 1000));
});

test("fails closed when a receipt snapshot exceeds ten thousand revisions", async () => {
  const { db, observedLimits } = receiptRevisionScanFixture(10_001);
  const repository = createCloudBaseImportRepository(db);

  await assert.rejects(
    repository.listItemResults("import-large-receipt", { limit: 20, snapshotRevision: 10_001 }),
    (error) => error.code === "IMPORT_ITEMS_UNAVAILABLE" && error.statusCode === 503
  );
  assert.ok(observedLimits.every((value) => value <= 1000));
});

test("freezes immutable receipt revisions despite later rows, clock rollback, and a newer attempt", async () => {
  const { service, repository } = serviceFixture({
    async validateRow() { return null; },
    async writeRow() { return { status: "success", code: "OK", retryable: false }; }
  });
  repository.records.set("import-snapshot", {
    id: "import-snapshot", status: "partial", executionAttempt: 1
  });
  for (const [row, revision] of [[2, 1], [10, 2], [30, 3]]) {
    const event = {
      id: `row-${row}`, documentId: `document-row-${row}`, status: "success", code: "OK",
      retryable: false, reused: false, executionAttempt: 1, createdAttempt: 1, revision, isLatestIndex: false,
      createdAt: new Date("2026-08-09T12:00:00.000Z"), updatedAt: new Date("2026-08-09T12:00:00.000Z")
    };
    repository.items.set(`import-snapshot:event:${revision}`, event);
    repository.items.set(`import-snapshot:row-${row}`, { ...event, documentId: `latest-row-${row}`, isLatestIndex: true });
  }
  repository.records.set("import-snapshot", {
    ...repository.records.get("import-snapshot"), receiptRevision: 3
  });

  const first = await service.listItems({
    actor, importRecordId: "import-snapshot", query: { page: 1, pageSize: 2 }
  });
  assert.deepEqual(first.items.map((item) => item.row), [2, 10]);
  assert.equal(typeof first.nextCursor, "string");
  assert.equal(first.nextCursor === "2", false);

  for (const [row, revision, timestamp] of [
    [1, 4, "2026-08-09T12:00:00.000Z"],
    [40, 5, "2026-08-09T11:59:59.000Z"]
  ]) {
    const event = {
      id: `row-${row}`, documentId: `document-row-${row}-later`, status: "success", code: "OK",
      retryable: false, reused: false, executionAttempt: 2, createdAttempt: 2, revision, isLatestIndex: false,
      createdAt: new Date(timestamp), updatedAt: new Date(timestamp)
    };
    repository.items.set(`import-snapshot:event:${revision}`, event);
    repository.items.set(`import-snapshot:row-${row}`, { ...event, documentId: `latest-row-${row}`, isLatestIndex: true });
  }
  const overwritten = {
    id: "row-30", documentId: "document-row-30-attempt-2", status: "business_error", code: "SERVICE_UNAVAILABLE",
    retryable: true, reused: false, executionAttempt: 2, createdAttempt: 1, revision: 6, isLatestIndex: false,
    createdAt: new Date("2026-08-09T11:59:58.000Z"), updatedAt: new Date("2026-08-09T11:59:58.000Z")
  };
  repository.items.set("import-snapshot:event:6", overwritten);
  repository.items.set("import-snapshot:row-30", { ...overwritten, documentId: "latest-row-30", isLatestIndex: true });
  repository.records.set("import-snapshot", {
    ...repository.records.get("import-snapshot"), executionAttempt: 2, receiptRevision: 6
  });
  const second = await service.listItems({
    actor, importRecordId: "import-snapshot", query: { page: 2, pageSize: 2, cursor: first.nextCursor }
  });
  assert.deepEqual(second.items.map((item) => [item.row, item.status, item.code]), [[30, "success", "OK"]]);
  assert.equal(second.total, 3);
  assert.equal(second.nextCursor, null);
});

test("rejects receipt cursor tampering, cross-batch reuse, overlong values, and a missing second-page cursor", async () => {
  const { service, repository } = serviceFixture({
    async validateRow() { return null; },
    async writeRow() { return { status: "success", code: "OK", retryable: false }; }
  });
  for (const id of ["import-cursor-a", "import-cursor-b"]) {
    repository.records.set(id, { id, status: "partial", executionAttempt: 1 });
    repository.items.set(`${id}:row-2`, {
      id: "row-2", documentId: `document-${id}`, status: "success", code: "OK",
      retryable: false, reused: false, createdAttempt: 1, updatedAt: new Date("2026-08-09T12:00:00.000Z")
    });
    repository.items.set(`${id}:row-4`, {
      id: "row-4", documentId: `document-${id}-4`, status: "success", code: "OK",
      retryable: false, reused: false, createdAttempt: 1, updatedAt: new Date("2026-08-09T12:00:00.000Z")
    });
  }
  const first = await service.listItems({ actor, importRecordId: "import-cursor-a", query: { page: 1, pageSize: 1 } });
  for (const command of [
    { importRecordId: "import-cursor-a", query: { page: 2, pageSize: 1 } },
    { importRecordId: "import-cursor-a", query: { page: 2, pageSize: 1, cursor: `${first.nextCursor}x` } },
    { importRecordId: "import-cursor-a", query: { page: 2, pageSize: 1, cursor: `${first.nextCursor}.garbage` } },
    { importRecordId: "import-cursor-b", query: { page: 2, pageSize: 1, cursor: first.nextCursor } },
    { importRecordId: "import-cursor-a", query: { page: 2, pageSize: 1, cursor: "a".repeat(4097) } }
  ]) {
    await assert.rejects(
      service.listItems({ actor, ...command }),
      (error) => ["IMPORT_ITEMS_CURSOR_REQUIRED", "IMPORT_ITEMS_CURSOR_INVALID"].includes(error.code)
    );
  }
});

test("a one-shot checkpoint failure lands recoverable state and resume reuses the durable receipt", async () => {
  let writes = 0;
  let checkpointFailed = false;
  const { service, repository } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() { writes += 1; return { status: "success", code: "OK" }; }
  });
  const updateOwnedRecord = repository.updateOwnedRecord.bind(repository);
  repository.updateOwnedRecord = async (id, leaseToken, patch) => {
    if (!checkpointFailed && patch.status === "processing" && patch.executionCursor === 1) {
      checkpointFailed = true;
      throw new Error("private checkpoint database detail");
    }
    return updateOwnedRecord(id, leaseToken, patch);
  };
  const input = payload("checkpoint.csv", "sku,name,stock\nA,Safe item,2");
  const prepared = await preview(service, input, "preview-checkpoint-key");

  const partial = await confirm(service, prepared, input, "confirm-checkpoint-key");
  const record = repository.records.get(prepared.importRecordId);
  assert.equal(partial.status, "partial");
  assert.equal(record.status, "partial");
  assert.deepEqual(record.errorSummary, [{ code: "IMPORT_CHECKPOINT_PERSIST_FAILED", count: 1 }]);
  assert.deepEqual(record.recovery, {
    required: true,
    code: "IMPORT_CHECKPOINT_PERSIST_FAILED",
    executionAttempt: 1,
    durableReceiptCount: 1
  });

  const resumed = await confirm(service, prepared, input, "resume-checkpoint-key", "resume");
  assert.equal(resumed.status, "success");
  assert.equal(writes, 1);
  assert.equal(JSON.stringify(partial).includes("private checkpoint"), false);
});

test("resume rejects an active processing lease", async () => {
  const { service, repository } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() { return { status: "success", code: "OK" }; }
  });
  const input = payload("active.csv", "sku,name,stock\nA,Safe item,2");
  const prepared = await preview(service, input, "preview-active-key");
  repository.records.set(prepared.importRecordId, {
    ...repository.records.get(prepared.importRecordId),
    status: "processing",
    executionAttempt: 1,
    executionLeaseDigest: "active-lease",
    leaseExpiresAt: new Date("2026-08-09T12:01:00.000Z")
  });

  await assert.rejects(
    confirm(service, prepared, input, "resume-active-key", "resume"),
    (error) => error.code === "IMPORT_RESUME_NOT_ALLOWED" && error.statusCode === 409
  );
});

test("persistent checkpoint failure is safely recoverable after lease expiry without replaying durable rows", async () => {
  let clock = new Date("2026-08-09T12:00:00.000Z");
  let writes = 0;
  let failCheckpointWrites = true;
  const { service, repository } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() { writes += 1; return { status: "success", code: "OK" }; }
  }, { now: () => clock });
  const updateOwnedRecord = repository.updateOwnedRecord.bind(repository);
  repository.updateOwnedRecord = async (id, leaseToken, patch) => {
    if (failCheckpointWrites && (patch.status !== "processing" || patch.executionCursor === 1)) {
      throw new Error("private persistent database outage");
    }
    return updateOwnedRecord(id, leaseToken, patch);
  };
  const input = payload("persistent.csv", "sku,name,stock\nA,Safe item,2");
  const prepared = await preview(service, input, "preview-persistent-key");

  await assert.rejects(
    confirm(service, prepared, input, "confirm-persistent-key"),
    (error) => error.code === "IMPORT_RECOVERY_REQUIRED"
      && error.statusCode === 503
      && !error.message.includes("private persistent")
  );
  assert.equal(repository.records.get(prepared.importRecordId).status, "processing");
  assert.equal(writes, 1);

  await assert.rejects(
    confirm(service, prepared, input, "resume-before-expiry-key", "resume"),
    (error) => error.code === "IMPORT_RESUME_NOT_ALLOWED" && error.statusCode === 409
  );

  clock = new Date("2026-08-09T12:02:00.000Z");
  failCheckpointWrites = false;
  const recovered = await confirm(service, prepared, input, "resume-after-expiry-key", "resume");
  assert.equal(recovered.status, "success");
  assert.equal(writes, 1);
  assert.equal(repository.records.get(prepared.importRecordId).executionAttempt, 2);
});

test("stale takeover keeps a completed handler ambiguous when final receipt and old-owner checkpoints cannot persist", async () => {
  let clock = new Date("2026-08-09T12:00:00.000Z");
  let writes = 0;
  let failRecordWrites = true;
  let oldItemContext;
  const { service, repository } = serviceFixture({
    async validateRow() { return { status: "ready" }; },
    async writeRow() {
      writes += 1;
      return { status: "success", code: "OK" };
    }
  }, {
    now: () => clock,
    repositoryOptions: {
      failFinalReceiptIds: new Set(["row-2"])
    }
  });
  const beginItemExecution = repository.beginItemExecution.bind(repository);
  repository.beginItemExecution = async (recordId, item, context) => {
    if (!oldItemContext) oldItemContext = { ...context };
    return beginItemExecution(recordId, item, context);
  };
  const updateOwnedRecord = repository.updateOwnedRecord.bind(repository);
  repository.updateOwnedRecord = async (...args) => {
    if (failRecordWrites) throw new Error("private persistent database outage");
    return updateOwnedRecord(...args);
  };
  const input = payload("ambiguous.csv", "sku,name,stock\nA,Safe item,2");
  const prepared = await preview(service, input, "preview-ambiguous-key");

  await assert.rejects(
    confirm(service, prepared, input, "confirm-ambiguous-key"),
    (error) => error.code === "IMPORT_RECOVERY_REQUIRED" && error.statusCode === 503
  );
  assert.equal(writes, 1);
  assert.equal(repository.records.get(prepared.importRecordId).status, "processing");

  clock = new Date("2026-08-09T12:02:00.000Z");
  failRecordWrites = false;
  const recovered = await confirm(service, prepared, input, "resume-ambiguous-key", "resume");
  const intent = await repository.getItemResult(prepared.importRecordId, "row-2");

  assert.equal(writes, 1);
  assert.equal(recovered.status, "partial");
  assert.equal(recovered.items[0].code, "IMPORT_ITEM_AMBIGUOUS");
  assert.equal(recovered.items[0].retryable, false);
  assert.deepEqual(repository.records.get(prepared.importRecordId).ambiguousItemIds, ["row-2"]);
  assert.ok(["processing", "ambiguous"].includes(intent.status));
  assert.equal(intent.executionAttempt, 1);
  assert.ok(oldItemContext);
  await assert.rejects(
    repository.finalizeItemResult(prepared.importRecordId, {
      id: "row-2", key: intent.key, version: intent.version, fingerprint: intent.fingerprint,
      status: "success", code: "OK", retryable: false, reused: false, executionAttempt: 1
    }, oldItemContext),
    (error) => ["IMPORT_PROCESSING_LEASE_LOST", "IMPORT_ITEM_LEASE_LOST"].includes(error.code)
  );
});
