"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// This test intentionally precedes the service implementation (RED evidence).
const { createOrderNoteService } = require("./orderNoteService");

function error(code, statusCode) {
  const value = new Error(code);
  value.code = code;
  value.statusCode = statusCode;
  return value;
}

function fixture({ failOutbox = false } = {}) {
  const records = {
    orders: [{ _id: "order-1", version: 3, adminRemark: "旧备注" }],
    note_logs: [], admin_operation_logs: [], sync_events: [], idempotency_records: []
  };
  const storeFor = (name) => ({
    where(criteria) {
      const rows = records[name].filter((row) => Object.entries(criteria).every(([key, value]) => row[key] === value));
      const query = { orderBy() { return query; }, limit(value) { rows.splice(value); return query; }, async get() { return { data: rows }; } };
      return query;
    },
    doc(id) {
      return {
        async get() { return { data: records[name].find((row) => row._id === id) || null }; },
        async update({ data }) {
          const row = records[name].find((item) => item._id === id);
          if (!row) throw error("NOT_FOUND", 404);
          Object.assign(row, data);
        },
        async set({ data }) { records[name].push({ _id: id, ...data }); }
      };
    },
    async add({ data }) {
      if (failOutbox && name === "sync_events") throw new Error("outbox unavailable");
      records[name].push({ _id: data._id || `${name}-${records[name].length + 1}`, ...data });
      return { _id: records[name][records[name].length - 1]._id };
    }
  });
  const db = {
    collection: storeFor,
    runTransaction: (() => {
      let tail = Promise.resolve();
      return async (work) => {
        const previous = tail;
        let release;
        tail = new Promise((resolve) => { release = resolve; });
        await previous;
        const snapshot = structuredClone(records);
        const transaction = { collection: storeFor };
        try { return await work(transaction); } catch (reason) { Object.keys(records).forEach((key) => { records[key].splice(0, records[key].length, ...snapshot[key]); }); throw reason; } finally { release(); }
      };
    })()
  };
  const idempotency = {
    assertIdempotencyKey(key) { if (!/^note-key-[A-Za-z0-9-]+$/.test(key || "")) throw error("IDEMPOTENCY_KEY_REQUIRED", 400); return key; },
    async runIdempotentAction(_options, execute) { return { ok: true, data: await execute({}) }; }
  };
  return { records, db, idempotency };
}

function actor(overrides = {}) {
  return { id: "admin-1", role: "customer_service", status: "active", isActive: true, permissions: ["order:edit_remark"], ...overrides };
}

function command(overrides = {}) {
  return { actor: actor(), input: { orderId: "order-1", content: "  已联系客户  ", expectedVersion: 3 }, idempotencyKey: "note-key-0001", requestId: "request-note-1", ...overrides };
}

test("appendNote writes one safe append record, compatibility fields and no sensitive audit payload", async () => {
  const state = fixture();
  const service = createOrderNoteService({ db: state.db, idempotency: state.idempotency, now: () => new Date("2026-08-15T00:00:00.000Z"), randomId: () => "note-1" });
  const result = await service.appendNote(command());
  assert.deepEqual(result, {
    note: { id: "note-1", content: "已联系客户", authorId: "admin-1", authorRole: "customer_service", authorName: "", createdAt: "2026-08-15T00:00:00.000Z" },
    version: 4, updatedAt: "2026-08-15T00:00:00.000Z", changed: true, reused: false
  });
  assert.equal(state.records.note_logs.length, 1);
  assert.equal(state.records.orders[0].adminRemark, "已联系客户");
  const safe = JSON.stringify([state.records.admin_operation_logs, state.records.sync_events]);
  for (const secret of ["已联系客户", "note-key-0001"]) assert.equal(safe.includes(secret), false, secret);
});

test("appendNote persists a safe display name and never substitutes an openid", async () => {
  const named = fixture();
  const result = await createOrderNoteService({ db: named.db, idempotency: named.idempotency, randomId: () => "note-named" })
    .appendNote(command({ actor: actor({ name: "  值班客服  ", openid: "private-openid" }) }));
  assert.equal(result.note.authorName, "值班客服");
  assert.equal(named.records.note_logs[0].authorName, "值班客服");
  const unnamed = fixture();
  const empty = await createOrderNoteService({ db: unnamed.db, idempotency: unnamed.idempotency, randomId: () => "note-unnamed" })
    .appendNote(command({ actor: actor({ openid: "private-openid" }) }));
  assert.equal(empty.note.authorName, "");
  assert.equal(unnamed.records.note_logs[0].authorName, "");
});

test("appendNote fails closed for unauthorized, invalid input, missing/stale order and outbox failure", async () => {
  const invalidInputs = [
    { content: "" }, { content: 1 }, { content: "x".repeat(501) }, { content: "ok", expectedVersion: undefined }
  ];
  for (const input of invalidInputs) {
    const state = fixture();
    const service = createOrderNoteService({ db: state.db, idempotency: state.idempotency });
    await assert.rejects(() => service.appendNote(command({ input: { ...command().input, ...input } })), (reason) => /^NOTE_CONTENT|EXPECTED_VERSION/.test(reason.code));
  }
  {
    const state = fixture(); const service = createOrderNoteService({ db: state.db, idempotency: state.idempotency });
    await assert.rejects(() => service.appendNote(command({ actor: actor({ permissions: [] }) })), (reason) => reason.code === "FORBIDDEN");
    await assert.rejects(() => service.appendNote(command({ input: { ...command().input, orderId: "missing" } })), (reason) => reason.code === "ORDER_NOT_FOUND");
    await assert.rejects(() => service.appendNote(command({ input: { ...command().input, expectedVersion: 2 } })), (reason) => reason.code === "DATA_VERSION_CONFLICT");
  }
  {
    const state = fixture({ failOutbox: true }); const service = createOrderNoteService({ db: state.db, idempotency: state.idempotency });
    await assert.rejects(() => service.appendNote(command()), /outbox unavailable/);
    assert.equal(state.records.note_logs.length, 0);
    assert.equal(state.records.orders[0].version, 3);
  }
});

test("uses validated legacy version, rejects overflow, and honors super_admin or wildcard permission", async () => {
  const legacy = fixture();
  delete legacy.records.orders[0].version;
  const legacyService = createOrderNoteService({ db: legacy.db, idempotency: legacy.idempotency });
  const result = await legacyService.appendNote(command({ input: { ...command().input, expectedVersion: 0 } }));
  assert.equal(result.version, 1);
  assert.equal(legacy.records.orders[0].version, 1);
  const overflow = fixture();
  overflow.records.orders[0].version = Number.MAX_SAFE_INTEGER;
  await assert.rejects(() => createOrderNoteService({ db: overflow.db, idempotency: overflow.idempotency }).appendNote(command({ input: { ...command().input, expectedVersion: Number.MAX_SAFE_INTEGER } })), (reason) => reason.code === "DATA_VERSION_INVALID");
  for (const privileged of [actor({ role: "super_admin", permissions: [] }), actor({ permissions: ["*"] })]) {
    const state = fixture();
    await createOrderNoteService({ db: state.db, idempotency: state.idempotency }).appendNote(command({ actor: privileged }));
  }
});

test("supplies recoverProcessingResult that returns the previously committed note without re-executing", async () => {
  const state = fixture();
  const digest = require("node:crypto").createHash("sha256").update("note-key-0001").digest("hex");
  state.records.note_logs.push({ _id: "note-recovered", targetType: "order", targetId: "order-1", content: "已联系客户", authorId: "admin-1", authorRole: "customer_service", authorName: "客服", versionBefore: 3, versionAfter: 4, businessKey: `order:order-1:remark:admin-1:${digest}`, idempotencyDigest: digest, createdAt: new Date("2026-08-15T00:00:00.000Z") });
  let executed = 0;
  state.idempotency.runIdempotentAction = async (options, execute) => {
    const recovered = await options.recoverProcessingResult({ status: "processing" }, { status: "processing", canExecute: false });
    if (recovered) return { ok: true, data: recovered };
    executed += 1;
    return { ok: true, data: await execute({}) };
  };
  const result = await createOrderNoteService({ db: state.db, idempotency: state.idempotency }).appendNote(command());
  assert.equal(executed, 0);
  assert.equal(result.reused, true);
  assert.equal(result.note.id, "note-recovered");
  assert.equal(state.records.note_logs.length, 1);
});

test("processing recovery rejects an exact business key when only authorId belongs to another actor", async () => {
  const state = fixture();
  const input = command().input;
  const digest = require("node:crypto").createHash("sha256").update("note-key-0001").digest("hex");
  state.records.note_logs.push({
    _id: "note-wrong-author", targetType: "order", targetId: input.orderId,
    businessKey: `order:${input.orderId}:remark:admin-1:${digest}`,
    content: input.content.trim(), authorId: "admin-other", authorRole: "customer_service", authorName: "其他客服",
    versionBefore: input.expectedVersion, versionAfter: input.expectedVersion + 1, createdAt: new Date("2026-08-15T00:00:00.000Z")
  });
  let executed = 0;
  state.idempotency.runIdempotentAction = async (options, execute) => {
    const recovered = await options.recoverProcessingResult({ status: "processing" }, { status: "processing", canExecute: false });
    if (recovered) return { ok: true, data: recovered };
    executed += 1;
    return { ok: true, data: await execute({}) };
  };
  const result = await createOrderNoteService({ db: state.db, idempotency: state.idempotency, randomId: () => "note-current-author" }).appendNote(command());
  assert.equal(executed, 1);
  assert.equal(result.reused, false);
  assert.equal(result.note.authorId, "admin-1");
  assert.equal(result.note.content, input.content.trim());
});

test("processing recovery rejects an exact record when only versionBefore differs", async () => {
  const state = fixture();
  const input = command().input;
  const digest = require("node:crypto").createHash("sha256").update("note-key-0001").digest("hex");
  state.records.note_logs.push({
    _id: "note-wrong-version-before", targetType: "order", targetId: input.orderId,
    businessKey: `order:${input.orderId}:remark:admin-1:${digest}`,
    content: input.content.trim(), authorId: "admin-1", authorRole: "customer_service", authorName: "当前客服",
    versionBefore: input.expectedVersion - 1, versionAfter: input.expectedVersion + 1, createdAt: new Date("2026-08-15T00:00:00.000Z")
  });
  let executed = 0;
  state.idempotency.runIdempotentAction = async (options, execute) => {
    const recovered = await options.recoverProcessingResult({ status: "processing" }, { status: "processing", canExecute: false });
    if (recovered) return { ok: true, data: recovered };
    executed += 1;
    return { ok: true, data: await execute({}) };
  };
  const result = await createOrderNoteService({ db: state.db, idempotency: state.idempotency, randomId: () => "note-current-version" }).appendNote(command());
  assert.equal(executed, 1);
  assert.equal(result.reused, false);
  assert.equal(result.note.authorId, "admin-1");
  assert.equal(result.note.content, input.content.trim());
});

test("processing recovery never returns another actor or an inconsistent matching row", async () => {
  const digest = require("node:crypto").createHash("sha256").update("note-key-0001").digest("hex");
  const cases = [
    { label: "another actor", stored: { authorId: "admin-a", content: "admin-a private note", versionBefore: 3, versionAfter: 4, businessKey: `order:order-1:remark:admin-a:${digest}` }, next: command({ actor: actor({ id: "admin-b" }) }) },
    { label: "different content", stored: { authorId: "admin-1", content: "old body", versionBefore: 3, versionAfter: 4, businessKey: `order:order-1:remark:admin-1:${digest}` }, next: command({ input: { ...command().input, content: "new body" } }) },
    { label: "different version", stored: { authorId: "admin-1", content: "same body", versionBefore: 3, versionAfter: 4, businessKey: `order:order-1:remark:admin-1:${digest}` }, next: command({ input: { ...command().input, content: "same body", expectedVersion: 2 } }), orderVersion: 2 },
    { label: "multiple matches", stored: { authorId: "admin-1", content: "same body", versionBefore: 3, versionAfter: 4, businessKey: `order:order-1:remark:admin-1:${digest}` }, duplicate: true, next: command({ input: { ...command().input, content: "same body" } }) }
  ];
  for (const scenario of cases) {
    const state = fixture();
    if (scenario.orderVersion !== undefined) state.records.orders[0].version = scenario.orderVersion;
    const row = { _id: `recovered-${scenario.label}`, targetType: "order", targetId: "order-1", idempotencyDigest: digest, createdAt: new Date("2026-08-15T00:00:00.000Z"), ...scenario.stored };
    state.records.note_logs.push(row);
    if (scenario.duplicate) state.records.note_logs.push({ ...row, _id: "recovered-duplicate" });
    let executed = 0;
    state.idempotency.runIdempotentAction = async (options, execute) => {
      const recovered = await options.recoverProcessingResult({ status: "processing" }, { status: "processing", canExecute: false });
      if (recovered) return { ok: true, data: recovered };
      executed += 1;
      return { ok: true, data: await execute({}) };
    };
    const result = await createOrderNoteService({ db: state.db, idempotency: state.idempotency, randomId: () => `new-${scenario.label}` }).appendNote(scenario.next);
    assert.equal(executed, 1, scenario.label);
    assert.equal(result.reused, false, scenario.label);
    assert.equal(result.note.authorId, scenario.next.actor.id, scenario.label);
    assert.equal(result.note.content, scenario.next.input.content.trim(), scenario.label);
  }
});

test("replays a completed idempotency key without a second write and rejects one concurrent stale version", async () => {
  const state = fixture();
  const completed = new Map();
  state.idempotency.runIdempotentAction = async (options, execute) => {
    if (completed.has(options.idempotencyKey)) return { ok: true, data: { ...completed.get(options.idempotencyKey), duplicate: true } };
    const data = await execute({});
    completed.set(options.idempotencyKey, data);
    return { ok: true, data };
  };
  const service = createOrderNoteService({ db: state.db, idempotency: state.idempotency, randomId: () => `note-${state.records.note_logs.length + 1}` });
  const first = await service.appendNote(command());
  const replay = await service.appendNote(command());
  assert.equal(first.reused, false);
  assert.equal(replay.reused, true);
  assert.equal(state.records.note_logs.length, 1);

  const concurrent = await Promise.allSettled([
    service.appendNote(command({ idempotencyKey: "note-key-concurrent-a", input: { ...command().input, expectedVersion: 4 } })),
    service.appendNote(command({ idempotencyKey: "note-key-concurrent-b", input: { ...command().input, expectedVersion: 4 } }))
  ]);
  assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = concurrent.find((item) => item.status === "rejected");
  assert.equal(rejected && rejected.reason.code, "DATA_VERSION_CONFLICT");
  assert.equal(state.records.orders[0].version, 5);
  assert.equal(state.records.note_logs.length, 2);
});
