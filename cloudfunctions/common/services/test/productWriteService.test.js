const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createProductWriteService,
  normalizeCreateInput,
  normalizeMetadataUpdateInput
} = require("../productWriteService");

function clone(value) { return structuredClone(value); }
function missingDocument(id) { const error = new Error(`document not exist: ${id}`); error.code = "DOCUMENT_NOT_EXIST"; return error; }
function matches(row, condition) { return Object.entries(condition || {}).every(([key, value]) => row[key] === value); }

function database(initial = {}, options = {}) {
  let state = clone({
    products: [], system_counters: [], inventory_logs: [], price_logs: [], product_tag_logs: [], stock_alert_records: [],
    admin_operation_logs: [], sync_events: [], ...initial
  });
  let sequence = 0;
  function collection(store, name) {
    if (!Array.isArray(store[name])) throw new Error(`collection not exists: ${name}`);
    const rows = store[name];
    return {
      doc(id) {
        return {
          async get() { const row = rows.find((item) => item._id === id); if (!row) throw missingDocument(id); return { data: clone(row) }; },
          async update({ data }) { const index = rows.findIndex((item) => item._id === id); if (index < 0) throw missingDocument(id); rows[index] = { ...rows[index], ...clone(data) }; },
          async set({ data }) { const index = rows.findIndex((item) => item._id === id); const row = { _id: id, ...clone(data) }; if (index < 0) rows.push(row); else rows[index] = row; }
        };
      },
      where(condition) {
        let max = Infinity;
        const query = { limit(value) { max = value; return query; }, async get() { return { data: clone(rows.filter((row) => matches(row, condition)).slice(0, max)) }; } };
        return query;
      },
      async add({ data }) {
        if (options.failAddCollection === name) throw new Error(`simulated ${name} failure`);
        sequence += 1;
        const row = { _id: `${name}-${sequence}`, ...clone(data) };
        rows.push(row);
        return { _id: row._id };
      }
    };
  }
  return {
    collection(name) { return collection(state, name); },
    serverDate() { return new Date("2026-07-12T08:00:00.000Z"); },
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
      if (options.recoverOnly) {
        const recovered = await config.recoverProcessingResult({ status: "processing" }, { status: "processing" });
        return recovered ? { ok: true, data: { ...recovered, duplicate: true } } : { ok: false, code: "IDEMPOTENCY_PROCESSING" };
      }
      const key = `${config.actionType}:${config.operatorIdentity}:${config.idempotencyKey}`;
      const hash = JSON.stringify(config.payload);
      const prior = records.get(key);
      if (prior && prior.hash !== hash) return { ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", message: "请求已被用于其他操作" };
      if (prior && !options.alwaysExecute) return { ok: true, data: { ...clone(prior.data), duplicate: true } };
      const data = await executor();
      records.set(key, { hash, data: clone(data) });
      return { ok: true, data: { ...data, duplicate: false } };
    }
  };
}

const stockAlert = {
  buildStockStatusUpdate(product, overrides) {
    const stock = overrides.stock;
    const warningStock = overrides.warningStock;
    return {
      stock,
      warningStock,
      stockStatus: stock <= 0 ? "out_of_stock" : stock <= warningStock ? "warning" : "normal",
      autoHideWhenOutOfStock: product.autoHideWhenOutOfStock === true,
      lastStockCheckAt: overrides.now,
      updatedAt: overrides.now,
      ...(stock <= 0 && product.autoHideWhenOutOfStock === true ? { isActive: false } : {})
    };
  },
  async syncStockAlertRecord({ store }, productId, product, status) {
    if (!["warning", "out_of_stock"].includes(status)) return;
    await store.collection("stock_alert_records").add({ data: { productId, stock: product.stock, warningStock: product.warningStock, alertType: status, status: "active" } });
  }
};

function actor(overrides = {}) {
  return { id: "admin-1", openid: "openid-1", role: "procurement", permissions: ["product:create", "product:update"], status: "active", isActive: true, sourceClient: "admin_web", ...overrides };
}

function metadata(overrides = {}) {
  return { name: "测试商品", baseName: "", imageUrl: "", specification: "50ml", productionDate: "2026-07", description: "说明", productIndex: "", skuCode: "SKU-1", keywords: ["精华"], ...overrides };
}

function createCommand(overrides = {}) {
  return { actor: actor(), input: { ...metadata(), priceCents: 6900, stock: 8, warningStock: 10, isActive: true, publicTags: ["新货"], reason: "新增" }, idempotencyKey: "product-create-key-1", ...overrides };
}

function setup(initial, options = {}) {
  const db = database(initial, options.database);
  return { db, service: createProductWriteService({ db, idempotency: options.idempotency || idempotency(), stockAlert, now: () => new Date("2026-07-12T08:00:00.000Z"), randomId: () => "legacy-random" }) };
}

test("create normalization preserves empty baseName fallback and strict integer fields", () => {
  const input = normalizeCreateInput(createCommand().input, false);
  assert.equal(input.baseName, "测试商品");
  assert.equal(input.price, 6900);
  assert.throws(() => normalizeCreateInput({ ...createCommand().input, priceCents: "6900" }, false), (error) => error.code === "PRICE_INVALID");
});

test("metadata normalization is presence based and never fills omitted fields", () => {
  assert.deepEqual(normalizeMetadataUpdateInput({ productId: "p-1", name: "新名称", expectedVersion: 3 }, true), {
    productId: "p-1", name: "新名称", expectedVersion: 3, reason: ""
  });
});

test("create commits product, counter, logs, alert, audit and sync atomically", async () => {
  const current = setup();
  const result = await current.service.createProduct(createCommand());
  const state = current.db.snapshot();
  assert.equal(result.version, 1);
  assert.equal(result.productIndex, "P000001");
  assert.equal(state.products[0].baseName, "测试商品");
  assert.equal(state.products[0].isActive, true);
  assert.equal(state.system_counters[0].value, 1);
  assert.equal(state.inventory_logs.length, 1);
  assert.equal(state.price_logs.length, 1);
  assert.equal(state.product_tag_logs.length, 1);
  assert.deepEqual(state.product_tag_logs[0].beforeTags, []);
  assert.deepEqual(state.product_tag_logs[0].afterTags, ["新货"]);
  assert.equal(state.stock_alert_records.length, 1);
  assert.equal(state.admin_operation_logs.length, 1);
  assert.equal(state.sync_events[0].eventType, "product.created");
});

test("strict metadata patch preserves every omitted operational and metadata field", async () => {
  const product = {
    _id: "p-1", ...metadata({ productIndex: "P000007", baseName: "旧基础名", description: "旧说明" }),
    price: 6900, stock: 8, warningStock: 10, stockStatus: "warning", isActive: true, tags: ["热销"],
    internalTags: ["内部"], defectDescription: "压痕", isFrequent: false, version: 3
  };
  const current = setup({ products: [product] });
  const result = await current.service.updateProductMetadata({
    actor: actor(), input: { productId: "p-1", name: "新名称", expectedVersion: 3 }, idempotencyKey: "product-edit-key-1", requireExpectedVersion: true
  });
  const after = current.db.snapshot().products[0];
  assert.equal(result.version, 4);
  assert.equal(after.name, "新名称");
  for (const field of ["baseName", "description", "price", "stock", "warningStock", "stockStatus", "isActive", "tags", "internalTags", "defectDescription"]) {
    assert.deepEqual(after[field], product[field], field);
  }
  assert.equal(current.db.snapshot().admin_operation_logs.length, 1);
  assert.equal(current.db.snapshot().sync_events.length, 1);
});

test("metadata no-op is zero-write and stale versions conflict", async () => {
  const product = { _id: "p-1", ...metadata({ productIndex: "P000001" }), price: 1, stock: 1, warningStock: 0, version: 3 };
  const current = setup({ products: [product] });
  const noOp = await current.service.updateProductMetadata({ actor: actor(), input: { productId: "p-1", name: product.name, expectedVersion: 3 }, idempotencyKey: "product-edit-noop" });
  assert.equal(noOp.changed, false);
  assert.equal(current.db.snapshot().admin_operation_logs.length, 0);
  assert.equal(current.db.snapshot().sync_events.length, 0);
  assert.equal(current.db.snapshot().product_tag_logs.length, 0);
  await assert.rejects(current.service.updateProductMetadata({ actor: actor(), input: { productId: "p-1", name: "变化", expectedVersion: 2 }, idempotencyKey: "product-edit-stale" }), (error) => error.code === "DATA_VERSION_CONFLICT");
});

test("idempotency replay, conflicting payload and processing recovery stay single-write", async () => {
  const current = setup();
  const first = await current.service.createProduct(createCommand());
  const replay = await current.service.createProduct(createCommand());
  assert.equal(replay.duplicate, true);
  assert.equal(current.db.snapshot().products.length, 1);
  await assert.rejects(current.service.createProduct(createCommand({ input: { ...createCommand().input, name: "另一个商品" } })), (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT");

  const recoveryService = createProductWriteService({ db: current.db, idempotency: idempotency({ recoverOnly: true }), stockAlert });
  const recovered = await recoveryService.createProduct(createCommand());
  assert.equal(recovered.reused, true);
  assert.equal(recovered.changed, false);
  assert.equal(recovered.productId, first.productId);
  assert.equal(current.db.snapshot().products.length, 1);
});

test("processing recovery reconstructs committed strict edit and keyed legacy update", async () => {
  const original = {
    _id: "p-1", ...metadata({ productIndex: "P000001", baseName: "测试商品" }), price: 100, stock: 2,
    warningStock: 10, stockStatus: "warning", autoHideWhenOutOfStock: false, isActive: true,
    tags: [], internalTags: [], isNew: false, isDefective: false, isHot: false, isFrequent: false,
    defectDescription: "", version: 1
  };
  const strict = setup({ products: [original] });
  const editCommand = { actor: actor(), input: { productId: "p-1", name: "已编辑", expectedVersion: 1 }, idempotencyKey: "recover-edit-key-1" };
  await strict.service.updateProductMetadata(editCommand);
  const strictRecovery = createProductWriteService({ db: strict.db, idempotency: idempotency({ recoverOnly: true }), stockAlert });
  const recoveredEdit = await strictRecovery.updateProductMetadata(editCommand);
  assert.equal(recoveredEdit.reused, true);
  assert.equal(recoveredEdit.changed, false);
  assert.equal(recoveredEdit.metadata.name, "已编辑");
  assert.equal(strict.db.snapshot().sync_events.length, 1);

  const legacy = setup({ products: [original] });
  const legacyProduct = { ...metadata({ productIndex: "P000001", baseName: "测试商品", name: "旧端编辑" }), price: 100, stock: 2, warningStock: 10, isActive: true, tags: [], internalTags: [] };
  const legacyCommand = { actor: actor({ sourceClient: "miniprogram" }), input: { productId: "p-1", product: legacyProduct }, idempotencyKey: "recover-legacy-key-1", allowMissingIdempotencyKey: true };
  await legacy.service.updateLegacyFull(legacyCommand);
  const legacyRecovery = createProductWriteService({ db: legacy.db, idempotency: idempotency({ recoverOnly: true }), stockAlert });
  const recoveredLegacy = await legacyRecovery.updateLegacyFull(legacyCommand);
  assert.equal(recoveredLegacy.reused, true);
  assert.equal(recoveredLegacy.changed, false);
  assert.equal(recoveredLegacy.metadata.name, "旧端编辑");
  assert.equal(legacy.db.snapshot().sync_events.length, 1);
});

test("legacy full update remains compatible, increments version and logs price and inventory once", async () => {
  const before = { _id: "p-1", ...metadata({ productIndex: "P000001" }), price: 100, stock: 2, warningStock: 10, stockStatus: "warning", isActive: true, tags: [], internalTags: ["旧"], version: 0 };
  const current = setup({ products: [before] });
  const product = { ...metadata({ productIndex: "P000001", name: "新商品" }), price: 200, stock: 5, warningStock: 2, isActive: true, tags: ["热销"], internalTags: ["新"], defectDescription: "" };
  const result = await current.service.updateLegacyFull({ actor: actor({ sourceClient: "miniprogram" }), input: { productId: "p-1", product, expectedStock: 2 }, allowMissingIdempotencyKey: true });
  assert.equal(result.version, 1);
  assert.equal(current.db.snapshot().price_logs.length, 1);
  assert.equal(current.db.snapshot().inventory_logs.length, 1);
  assert.equal(current.db.snapshot().product_tag_logs.length, 1);
  assert.deepEqual(current.db.snapshot().product_tag_logs[0].beforeInternalTags, ["旧"]);
  assert.deepEqual(current.db.snapshot().product_tag_logs[0].afterInternalTags, ["新"]);
  assert.equal(current.db.snapshot().sync_events.length, 1);
});

test("legacy update requires a stock snapshot only when the submitted stock would change", async () => {
  const before = { _id: "p-1", ...metadata({ productIndex: "P000001" }), price: 100, stock: 2, warningStock: 10, stockStatus: "warning", isActive: true, tags: [], internalTags: [], version: 4 };
  const changed = { ...metadata({ productIndex: "P000001", name: "新商品" }), price: 100, stock: 5, warningStock: 10, isActive: true, tags: [], internalTags: [] };
  const stale = setup({ products: [before] });
  await assert.rejects(
    stale.service.updateLegacyFull({ actor: actor({ sourceClient: "miniprogram" }), input: { productId: "p-1", product: changed, expectedVersion: 4 }, allowMissingIdempotencyKey: true }),
    (error) => error.code === "EXPECTED_STOCK_REQUIRED"
  );
  assert.equal(stale.db.snapshot().products[0].stock, 2);

  const metadataOnly = setup({ products: [before] });
  const result = await metadataOnly.service.updateLegacyFull({
    actor: actor({ sourceClient: "miniprogram" }),
    input: { productId: "p-1", product: { ...changed, stock: 2 }, expectedVersion: 4 },
    allowMissingIdempotencyKey: true
  });
  assert.equal(result.version, 5);
  assert.equal(metadataOnly.db.snapshot().products[0].stock, 2);
  assert.equal(metadataOnly.db.snapshot().inventory_logs.length, 0);
});

test("legacy expectedStock blocks stale inventory even when version did not change", async () => {
  const before = { _id: "p-1", ...metadata({ productIndex: "P000001" }), price: 100, stock: 1, warningStock: 10, stockStatus: "warning", isActive: true, tags: [], internalTags: [], version: 4 };
  const current = setup({ products: [before] });
  const submitted = { ...metadata({ productIndex: "P000001" }), price: 100, stock: 5, warningStock: 10, isActive: true, tags: [], internalTags: [] };
  await assert.rejects(
    current.service.updateLegacyFull({ actor: actor({ sourceClient: "miniprogram" }), input: { productId: "p-1", product: submitted, expectedVersion: 4, expectedStock: 5 }, allowMissingIdempotencyKey: true }),
    (error) => error.code === "DATA_VERSION_CONFLICT" && error.details.conflictFields.includes("stock")
  );
  assert.equal(current.db.snapshot().products[0].stock, 1);
});

test("internal-only legacy tag changes emit an admin event without internal field names", async () => {
  const before = {
    _id: "p-1", ...metadata({ productIndex: "P000001", baseName: "测试商品" }), price: 100, stock: 2, warningStock: 10,
    stockStatus: "warning", autoHideWhenOutOfStock: false, isActive: true, tags: ["热销"],
    isNew: false, isDefective: false, isHot: true, internalTags: ["旧"], defectDescription: "", isFrequent: false, version: 2
  };
  const current = setup({ products: [before] });
  const product = {
    ...metadata({ productIndex: "P000001", baseName: "测试商品" }), price: 100, stock: 2, warningStock: 10, isActive: true,
    tags: ["热销"], isHot: true, internalTags: ["新"], defectDescription: "仅后台", isFrequent: false
  };
  await current.service.updateLegacyFull({ actor: actor({ sourceClient: "miniprogram" }), input: { productId: "p-1", product }, allowMissingIdempotencyKey: true });
  const event = current.db.snapshot().sync_events[0];
  assert.equal(event.audience, "admin");
  assert.equal(event.isPublic, false);
  assert.deepEqual(event.changedFields, ["updatedAt", "version"]);
  assert.equal(JSON.stringify(event).includes("internalTags"), false);
  assert.equal(JSON.stringify(event).includes("defectDescription"), false);
});

test("transaction failure rolls back product and all side effects", async () => {
  const current = setup({}, { database: { failAddCollection: "sync_events" } });
  await assert.rejects(current.service.createProduct(createCommand()));
  const state = current.db.snapshot();
  assert.equal(state.products.length, 0);
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.admin_operation_logs.length, 0);
  assert.equal(state.product_tag_logs.length, 0);
});

test("finance, customer service and inactive actors are denied", async () => {
  for (const override of [{ role: "finance" }, { role: "customer_service" }, { isActive: false }]) {
    const current = setup();
    await assert.rejects(current.service.createProduct(createCommand({ actor: actor(override) })), (error) => error.code === "FORBIDDEN");
  }
});
