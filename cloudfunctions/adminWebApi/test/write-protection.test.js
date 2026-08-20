"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const protection = require("../lib/idempotency");

function clone(value) {
  return structuredClone(value);
}

function createDatabase(initial = {}, options = {}) {
  const collections = new Map();
  for (const [name, rows] of Object.entries(initial)) {
    collections.set(name, new Map(rows.map((row) => [row._id, clone(row)])));
  }

  let transactionTail = Promise.resolve();
  let releaseStaleReaders;
  let staleReaderCount = 0;
  const staleReadersReady = new Promise((resolve) => { releaseStaleReaders = resolve; });

  function rows(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function collection(name, inTransaction = false) {
    const store = rows(name);
    return {
      async add({ data }) {
        if (store.has(data._id)) throw new Error("duplicate key");
        store.set(data._id, clone(data));
        return { _id: data._id };
      },
      doc(id) {
        return {
          async get() {
            if (options.synchronizeOutsideReads === id && !inTransaction) {
              staleReaderCount += 1;
              if (staleReaderCount === 2) releaseStaleReaders();
              await staleReadersReady;
            }
            return { data: store.has(id) ? clone(store.get(id)) : null };
          },
          async set({ data }) {
            store.set(id, { ...clone(data), _id: id });
            return { stats: { created: 1, updated: 0 } };
          },
          async update({ data }) {
            if (!store.has(id)) throw new Error("document not exist");
            store.set(id, { ...store.get(id), ...clone(data), _id: id });
            return { stats: { updated: 1 } };
          }
        };
      }
    };
  }

  const db = {
    async createCollection(name) { rows(name); },
    collection(name) { return collection(name, false); },
    async runTransaction(executor) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await executor({ collection: (name) => collection(name, true) });
      } finally {
        release();
      }
    },
    snapshot(name) {
      return Array.from(rows(name).values()).map(clone);
    }
  };
  return db;
}

function idempotencyOptions(db, overrides = {}) {
  return {
    db,
    actionType: "settings_save",
    operatorIdentity: "admin-private-id",
    operatorType: "admin",
    idempotencyKey: "settings-save-key-0001",
    requestId: "request-0001",
    scope: "settings",
    scopeId: "system_settings",
    payload: { nested: { enabled: true }, value: 2 },
    ...overrides
  };
}

test("payload fingerprints are canonical and reject a changed payload", () => {
  assert.equal(
    protection.fingerprintPayload({ b: 2, a: 1, clientTimestamp: 123 }),
    protection.fingerprintPayload({ a: 1, b: 2, clientTimestamp: 999 })
  );
  assert.notEqual(
    protection.fingerprintPayload({ a: 1, b: 2 }),
    protection.fingerprintPayload({ a: 1, b: 3 })
  );
});

test("first execution is persisted once, replay returns the first result, and changed payload conflicts", async () => {
  const db = createDatabase();
  let writes = 0;
  const execute = async () => {
    writes += 1;
    return { id: "system_settings", affected: 1, version: 3 };
  };

  const first = await protection.runIdempotentAction(idempotencyOptions(db), execute);
  const replay = await protection.runIdempotentAction(idempotencyOptions(db, {
    payload: { value: 2, nested: { enabled: true } }
  }), execute);
  const conflict = await protection.runIdempotentAction(idempotencyOptions(db, {
    payload: { nested: { enabled: false }, value: 2 }
  }), execute);

  assert.equal(writes, 1);
  assert.equal(first.data.duplicate, false);
  assert.deepEqual(replay.data, { ...first.data, duplicate: true });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(conflict.category, "IDEMPOTENCY_CONFLICT");

  const [record] = db.snapshot("idempotency_records");
  assert.equal(record.requestHash, protection.fingerprintPayload({ nested: { enabled: true }, value: 2 }));
  assert.match(record.idempotencyKeyDigest, /^[a-f0-9]{16}$/);
  assert.match(record.operatorIdentityDigest, /^[a-f0-9]{16}$/);
  for (const forbidden of ["idempotencyKey", "operatorIdentity", "openid", "userId", "adminId", "requestPayloadMasked", "executionToken"]) {
    assert.equal(Object.hasOwn(record, forbidden), false, `raw field persisted: ${forbidden}`);
  }
});

test("a duplicate while the first request is running receives a recognizable processing result", async () => {
  const db = createDatabase();
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const first = protection.runIdempotentAction(idempotencyOptions(db), async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return { id: "system_settings", affected: 1, version: 3 };
  });
  await startedPromise;

  const duplicate = await protection.runIdempotentAction(idempotencyOptions(db), async () => {
    throw new Error("must not execute");
  });
  assert.deepEqual(
    { ok: duplicate.ok, code: duplicate.code, category: duplicate.category, retryAfterSeconds: duplicate.retryAfterSeconds },
    { ok: false, code: "IDEMPOTENCY_PROCESSING", category: "IDEMPOTENCY_CONFLICT", retryAfterSeconds: 2 }
  );
  release();
  await first;
});

test("non-retryable failures stay failed for the same key", async () => {
  const db = createDatabase();
  let attempts = 0;
  await assert.rejects(
    protection.runIdempotentAction(idempotencyOptions(db), async () => {
      attempts += 1;
      const error = new Error("validation failed");
      error.code = "VALIDATION_ERROR";
      error.statusCode = 422;
      throw error;
    }),
    (error) => error.code === "VALIDATION_ERROR"
  );
  const retry = await protection.runIdempotentAction(idempotencyOptions(db), async () => {
    attempts += 1;
    return { id: "unexpected" };
  });
  assert.equal(attempts, 1);
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "IDEMPOTENCY_NOT_EXECUTABLE");
});

test("idempotency records retain only a safe request id and error code", async () => {
  const db = createDatabase();
  await assert.rejects(
    protection.runIdempotentAction(idempotencyOptions(db, { requestId: "unsafe\nrequest" }), async () => {
      const error = new Error("token=private-value at database collection");
      error.code = "VALIDATION_ERROR";
      error.statusCode = 422;
      throw error;
    }),
    (error) => error.code === "VALIDATION_ERROR"
  );
  const [record] = db.snapshot("idempotency_records");
  assert.equal(record.requestId, "");
  assert.equal(record.errorCode, "VALIDATION_ERROR");
  assert.equal(record.errorMessage, "");
  assert.equal(JSON.stringify(record).includes("private-value"), false);
});

test("two contenders cannot both reclaim one expired idempotency record", async () => {
  const options = idempotencyOptions(null);
  const recordId = protection.buildIdempotencyRecordId(options.actionType, options.operatorIdentity, options.idempotencyKey);
  const expired = {
    _id: recordId,
    requestHash: protection.hashPayload(options.payload),
    status: "expired",
    retryCount: 0,
    lockedAt: new Date("2020-01-01T00:00:00.000Z"),
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2020-01-01T00:00:00.000Z")
  };
  const db = createDatabase({ idempotency_records: [expired] }, { synchronizeOutsideReads: recordId });
  const claimOptions = idempotencyOptions(db);

  const claims = await Promise.all([
    protection.beginIdempotentAction(claimOptions),
    protection.beginIdempotentAction(claimOptions)
  ]);
  assert.equal(claims.filter((claim) => claim.canExecute).length, 1);
  assert.equal(claims.filter((claim) => claim.status === "processing").length, 1);
});

test("a timed-out processing record stays fenced until an external recovery decision", async () => {
  const options = idempotencyOptions(null);
  const recordId = protection.buildIdempotencyRecordId(options.actionType, options.operatorIdentity, options.idempotencyKey);
  const stale = {
    _id: recordId,
    requestHash: protection.hashPayload(options.payload),
    status: "processing",
    retryCount: 0,
    lockedAt: new Date("2020-01-01T00:00:00.000Z"),
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2020-01-01T00:00:00.000Z")
  };
  const db = createDatabase({ idempotency_records: [stale] });
  const claim = await protection.beginIdempotentAction(idempotencyOptions(db));
  assert.equal(claim.canExecute, false);
  assert.equal(claim.status, "processing");
});

test("an obsolete execution lease cannot overwrite a newer claimant", async () => {
  const db = createDatabase();
  const first = await protection.beginIdempotentAction(idempotencyOptions(db));
  assert.match(first.executionToken, /^[a-f0-9]{32}$/);
  await db.collection("idempotency_records").doc(first.recordId).update({ data: { status: "expired" } });
  const second = await protection.beginIdempotentAction(idempotencyOptions(db));
  assert.notEqual(second.executionToken, first.executionToken);

  await assert.rejects(
    protection.finishIdempotentAction(db, first.recordId, { data: { winner: "first" } }, first.executionToken),
    (error) => error.code === "IDEMPOTENCY_LEASE_LOST"
  );
  await protection.finishIdempotentAction(db, second.recordId, { data: { winner: "second" } }, second.executionToken);
  assert.equal(db.snapshot("idempotency_records")[0].resultDataMasked.winner, "second");
});

test("legacy transient failures and timeout errors remain retryable", async () => {
  const options = idempotencyOptions(null);
  const recordId = protection.buildIdempotencyRecordId(options.actionType, options.operatorIdentity, options.idempotencyKey);
  const legacy = {
    _id: recordId,
    requestHash: protection.hashPayload(options.payload),
    status: "failed",
    errorCode: "NETWORK_ERROR",
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2020-01-01T00:00:00.000Z")
  };
  const legacyDb = createDatabase({ idempotency_records: [legacy] });
  assert.equal((await protection.beginIdempotentAction(idempotencyOptions(legacyDb))).canExecute, true);

  const timeoutDb = createDatabase();
  await assert.rejects(
    protection.runIdempotentAction(idempotencyOptions(timeoutDb), async () => {
      const error = new Error("request timed out");
      error.code = "ETIMEDOUT";
      error.statusCode = 503;
      throw error;
    }),
    (error) => error.code === "ETIMEDOUT"
  );
  let attempts = 0;
  const retry = await protection.runIdempotentAction(idempotencyOptions(timeoutDb), async () => {
    attempts += 1;
    return { id: "system_settings", version: 4 };
  });
  assert.equal(attempts, 1);
  assert.equal(retry.ok, true);
});

test("versioned transaction reads and compares inside one transaction and exposes only safe conflict guidance", async () => {
  const db = createDatabase({ resources: [{ _id: "resource-1", version: 2, value: "before", secret: "hidden" }] });
  const updated = await protection.runVersionedTransaction({
    db,
    collectionName: "resources",
    documentId: "resource-1",
    expectedVersion: 2
  }, async ({ transaction, current, nextVersion }) => {
    await transaction.collection("resources").doc("resource-1").update({ data: { value: "after", version: nextVersion } });
    return { id: current._id, version: nextVersion };
  });
  assert.deepEqual(updated, { id: "resource-1", version: 3 });

  await assert.rejects(
    protection.runVersionedTransaction({
      db,
      collectionName: "resources",
      documentId: "resource-1",
      expectedVersion: 2
    }, async () => ({ unreachable: true })),
    (error) => {
      assert.equal(error.code, "DATA_VERSION_CONFLICT");
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, { currentVersion: 3, refreshRequired: true });
      assert.equal(JSON.stringify(error).includes("hidden"), false);
      return true;
    }
  );
});

test("version comparison wins over state validation for a stale client snapshot", async () => {
  const db = createDatabase({ resources: [{ _id: "resource-1", version: 3, status: "closed" }] });
  await assert.rejects(
    protection.runVersionedTransaction({
      db,
      collectionName: "resources",
      documentId: "resource-1",
      expectedVersion: 2,
      validateCurrent: () => {
        throw new protection.WriteProtectionError("STATUS_CONFLICT", "状态已变化", 409);
      }
    }, async () => ({ unreachable: true })),
    (error) => error.code === "DATA_VERSION_CONFLICT"
      && error.details.currentVersion === 3
      && error.details.refreshRequired === true
  );
});

test("concurrent compare-and-swap contenders with one expected version commit only once", async () => {
  const db = createDatabase({ resources: [{ _id: "resource-1", version: 0, value: "before" }] });
  const mutate = (value) => protection.runVersionedTransaction({
    db,
    collectionName: "resources",
    documentId: "resource-1",
    expectedVersion: 0
  }, async ({ transaction, nextVersion }) => {
    await transaction.collection("resources").doc("resource-1").update({ data: { value, version: nextVersion } });
    return { value, version: nextVersion };
  });

  const settled = await Promise.allSettled([mutate("first"), mutate("second")]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = settled.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "DATA_VERSION_CONFLICT");
  assert.equal(db.snapshot("resources")[0].version, 1);
});
