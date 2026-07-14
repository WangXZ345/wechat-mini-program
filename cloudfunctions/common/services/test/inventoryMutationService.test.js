const test = require("node:test");
const assert = require("node:assert/strict");
const stockAlert = require("../../../_utils/stockAlert");
const {
  InventoryMutationError,
  applyInventoryMutationInTransaction,
  createInventoryMutationService,
  normalizeInput
} = require("../inventoryMutationService");

function clone(value) { return structuredClone(value); }
function matches(row, condition) { return Object.entries(condition || {}).every(([key, value]) => row[key] === value); }
function missing(id) { const error = new Error(`document not exist: ${id}`); error.code = "DOCUMENT_NOT_EXIST"; return error; }

function database(initial = {}, options = {}) {
  let state = clone({
    products: [], inventory_logs: [], stock_alert_records: [], admin_operation_logs: [], sync_events: [], ...initial
  });
  let sequence = 0;
  function collection(store, name) {
    const rows = store[name];
    if (!Array.isArray(rows)) throw new Error(`collection not exists: ${name}`);
    return {
      doc(id) {
        return {
          async get() { const row = rows.find((item) => item._id === id); if (!row) throw missing(id); return { data: clone(row) }; },
          async update({ data }) { const index = rows.findIndex((item) => item._id === id); if (index < 0) throw missing(id); rows[index] = { ...rows[index], ...clone(data) }; }
        };
      },
      where(condition) {
        let max = Infinity;
        const query = { limit(value) { max = value; return query; }, async get() { return { data: clone(rows.filter((row) => matches(row, condition)).slice(0, max)) }; } };
        return query;
      },
      async add({ data }) {
        if (options.failAddCollection === name) throw new Error(`simulated ${name} failure`);
        const row = { _id: `${name}-${++sequence}`, ...clone(data) };
        rows.push(row);
        return { _id: row._id };
      }
    };
  }
  return {
    collection(name) { return collection(state, name); },
    serverDate() { return new Date("2026-07-12T12:00:00.000Z"); },
    async createCollection(name) { if (Array.isArray(state[name])) throw new Error("collection already exists"); state[name] = []; },
    async runTransaction(callback) { const working = clone(state); const result = await callback({ collection: (name) => collection(working, name) }); state = working; return result; },
    snapshot() { return clone(state); }
  };
}

function idempotency(options = {}) {
  const records = new Map();
  return {
    async ensureCollection(db, name) { try { await db.createCollection(name); } catch (error) { if (!/already exists/.test(error.message)) throw error; } },
    assertIdempotencyKey(value) { const key = String(value || "").trim(); if (key.length < 8) { const error = new Error(key ? "操作凭证格式无效" : "缺少操作凭证"); error.code = key ? "IDEMPOTENCY_KEY_INVALID" : "IDEMPOTENCY_KEY_REQUIRED"; throw error; } return key; },
    async runIdempotentAction(config, executor) {
      if (options.processing) {
        const recovered = await config.recoverProcessingResult();
        return recovered ? { ok: true, data: { ...recovered, duplicate: true } } : { ok: false, code: "IDEMPOTENCY_PROCESSING", message: "处理中" };
      }
      const key = `${config.actionType}:${config.operatorIdentity}:${config.idempotencyKey}`;
      const hash = JSON.stringify(config.payload);
      const existing = records.get(key);
      if (existing && existing.hash !== hash) return { ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", message: "请求已被用于其他操作" };
      if (existing && !options.alwaysExecute) return { ok: true, data: { ...clone(existing.data), duplicate: true } };
      const data = await executor();
      records.set(key, { hash, data: clone(data) });
      return { ok: true, data: { ...data, duplicate: false } };
    }
  };
}

function product(overrides = {}) {
  return { _id: "p-1", name: "商品", productIndex: "P000001", stock: 8, warningStock: 3, stockStatus: "normal", autoHideWhenOutOfStock: false, isActive: true, version: 4, ...overrides };
}
function actor(overrides = {}) {
  return { id: "admin-1", openid: "openid-1", role: "procurement", permissions: ["inventory:update"], status: "active", isActive: true, sourceClient: "admin_web", ...overrides };
}
function command(overrides = {}) {
  return {
    actor: actor(),
    input: { productId: "p-1", mode: "delta", delta: -6, expectedStock: 8, expectedVersion: 4, reason: "盘点修正" },
    idempotencyKey: "inventory-adjust-0001",
    ...overrides
  };
}
function service(db, idem = idempotency()) {
  return createInventoryMutationService({ db, stockAlert, idempotency: idem, now: () => new Date("2026-07-12T12:00:00.000Z") });
}

test("strict normalization accepts set and delta while rejecting ambiguous or unsafe values", () => {
  assert.equal(normalizeInput({ productId: "p", mode: "set", targetStock: 0, expectedStock: 1, expectedVersion: 2, reason: "盘点" }).targetStock, 0);
  assert.equal(normalizeInput({ productId: "p", mode: "delta", delta: -1, expectedStock: 1, expectedVersion: 2, reason: "盘点" }).delta, -1);
  for (const input of [
    { productId: "p", mode: "delta", delta: 0, expectedStock: 1, expectedVersion: 2, reason: "盘点" },
    { productId: "p", mode: "delta", delta: 1, targetStock: 2, expectedStock: 1, expectedVersion: 2, reason: "盘点" },
    { productId: "p", mode: "set", targetStock: "2", expectedStock: 1, expectedVersion: 2, reason: "盘点" },
    { productId: "p", mode: "delta", delta: 1, expectedStock: 1, expectedVersion: 2, reason: "" }
  ]) assert.throws(() => normalizeInput(input), InventoryMutationError);
});

test("delta is computed server-side and commits product, alert, logs, version and value-free outbox atomically", async () => {
  const db = database({ products: [product()] });
  const result = await service(db).adjustInventory(command());
  const state = db.snapshot();
  assert.equal(result.stock, 2);
  assert.equal(result.version, 5);
  assert.equal(state.products[0].stockStatus, "warning");
  assert.equal(state.stock_alert_records.length, 1);
  assert.equal(state.inventory_logs[0].beforeStock, 8);
  assert.equal(state.inventory_logs[0].afterStock, 2);
  assert.equal(state.inventory_logs[0].changeAmount, -6);
  assert.equal(state.inventory_logs[0].versionAfter, 5);
  assert.equal(state.admin_operation_logs.length, 1);
  assert.equal(state.sync_events.length, 1);
  assert.equal(state.sync_events[0].eventType, "inventory.stock_adjusted");
  for (const field of ["stock", "beforeStock", "afterStock", "openid", "operatorOpenid"]) assert.equal(Object.hasOwn(state.sync_events[0], field), false);
});

test("auto-hide only deactivates at zero and replenishment never reactivates", async () => {
  const zeroDb = database({ products: [product({ stock: 1, warningStock: 0, autoHideWhenOutOfStock: true })] });
  const zero = await service(zeroDb).adjustInventory(command({ input: { productId: "p-1", mode: "delta", delta: -1, expectedStock: 1, expectedVersion: 4, reason: "报损" } }));
  assert.equal(zero.isActive, false);
  assert.equal(zeroDb.snapshot().sync_events.length, 2);
  assert.deepEqual(zeroDb.snapshot().sync_events[1].changedFields, ["isActive", "updatedAt", "version"]);

  const replenishDb = database({ products: [product({ stock: 0, stockStatus: "out_of_stock", autoHideWhenOutOfStock: true, isActive: false })] });
  const replenish = await service(replenishDb).adjustInventory(command({ input: { productId: "p-1", mode: "delta", delta: 5, expectedStock: 0, expectedVersion: 4, reason: "补货" } }));
  assert.equal(replenish.stock, 5);
  assert.equal(replenish.isActive, false);
  assert.equal(replenishDb.snapshot().sync_events.length, 1);
});

test("snapshot conflicts and after-stock bounds fail without writes", async () => {
  for (const input of [
    { productId: "p-1", mode: "delta", delta: 1, expectedStock: 7, expectedVersion: 4, reason: "stale stock" },
    { productId: "p-1", mode: "delta", delta: 1, expectedStock: 8, expectedVersion: 3, reason: "stale version" },
    { productId: "p-1", mode: "delta", delta: -9, expectedStock: 8, expectedVersion: 4, reason: "below zero" }
  ]) {
    const db = database({ products: [product()] });
    await assert.rejects(service(db).adjustInventory(command({ input })), (error) => ["DATA_VERSION_CONFLICT", "AFTER_STOCK_INVALID"].includes(error.code));
    assert.equal(db.snapshot().products[0].stock, 8);
    assert.equal(db.snapshot().inventory_logs.length, 0);
  }
});

test("set no-op is zero business writes", async () => {
  const db = database({ products: [product()] });
  const result = await service(db).adjustInventory(command({ input: { productId: "p-1", mode: "set", targetStock: 8, expectedStock: 8, expectedVersion: 4, reason: "盘点无差异" } }));
  assert.equal(result.changed, false);
  assert.equal(db.snapshot().products[0].version, 4);
  for (const name of ["inventory_logs", "stock_alert_records", "admin_operation_logs", "sync_events"]) assert.equal(db.snapshot()[name].length, 0);
});

test("idempotency replay, conflict and processing recovery converge to one inventory write", async () => {
  const db = database({ products: [product()] });
  const canonical = service(db);
  await canonical.adjustInventory(command());
  const replay = await canonical.adjustInventory(command());
  assert.equal(replay.duplicate, true);
  await assert.rejects(canonical.adjustInventory(command({ input: { ...command().input, delta: -5 } })), (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT");
  const recovered = await service(db, idempotency({ processing: true })).adjustInventory(command());
  assert.equal(recovered.reused, true);
  assert.equal(db.snapshot().inventory_logs.length, 1);
});

test("processing recovery returns the original committed snapshot after later inventory changes", async () => {
  const db = database({ products: [product()] });
  await service(db).adjustInventory(command());
  await service(db).adjustInventory(command({
    input: { productId: "p-1", mode: "delta", delta: 4, expectedStock: 2, expectedVersion: 5, reason: "后续补货" },
    idempotencyKey: "inventory-adjust-0002"
  }));
  assert.equal(db.snapshot().products[0].stock, 6);
  const recovered = await service(db, idempotency({ processing: true })).adjustInventory(command());
  assert.equal(recovered.stock, 2);
  assert.equal(recovered.version, 5);
  assert.equal(recovered.reused, true);
  assert.equal(db.snapshot().inventory_logs.length, 2);
});

test("processing recovery recognizes a strict set no-op without a business log", async () => {
  const db = database({ products: [product()] });
  const noOp = command({
    input: { productId: "p-1", mode: "set", targetStock: 8, expectedStock: 8, expectedVersion: 4, reason: "复核无差异" },
    idempotencyKey: "inventory-noop-0001"
  });
  const recovered = await service(db, idempotency({ processing: true })).adjustInventory(noOp);
  assert.equal(recovered.changed, false);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.stock, 8);
  assert.equal(db.snapshot().inventory_logs.length, 0);
});

test("transaction failure rolls back product, alert and every log", async () => {
  const db = database({ products: [product()] }, { failAddCollection: "sync_events" });
  await assert.rejects(service(db).adjustInventory(command()), /simulated sync_events failure/);
  const state = db.snapshot();
  assert.equal(state.products[0].stock, 8);
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.stock_alert_records.length, 0);
  assert.equal(state.admin_operation_logs.length, 0);
});

test("primitive supports an existing domain transaction and caller-owned business key", async () => {
  const db = database({ products: [product()] });
  const run = () => db.runTransaction((tx) => applyInventoryMutationInTransaction({
    db, store: tx, stockAlert,
    input: { productId: "p-1", mode: "delta", delta: 2, reason: "订单恢复" },
    actor: { id: "system", role: "system", sourceClient: "system" },
    context: { businessKey: "order_restore:o-1:p-1", sourceType: "order_restore", sourceId: "o-1", relatedOrderId: "o-1", writeAudit: false, now: new Date("2026-07-12T12:00:00.000Z") }
  }));
  const first = await run();
  const second = await run();
  assert.equal(first.stock, 10);
  assert.equal(second.reused, true);
  assert.equal(db.snapshot().products[0].stock, 10);
  assert.equal(db.snapshot().inventory_logs.length, 1);
  assert.equal(db.snapshot().admin_operation_logs.length, 0);
});
