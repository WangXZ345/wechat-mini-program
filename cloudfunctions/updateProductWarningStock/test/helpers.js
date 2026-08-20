const assert = require("node:assert/strict");

function clone(value) {
  return structuredClone(value);
}

function missingCollection(name) {
  const error = new Error(`collection not exists: ${name}`);
  error.code = "COLLECTION_NOT_EXIST";
  return error;
}

function missingDocument(id) {
  const error = new Error(`document not exist: ${id}`);
  error.code = "DOCUMENT_NOT_EXIST";
  return error;
}

function matches(row, condition = {}) {
  return Object.entries(condition).every(([key, value]) => row[key] === value);
}

function createDatabase(initialState, options = {}) {
  let state = clone(initialState);
  let sequence = 0;
  const timestamp = options.timestamp || "2026-07-11T08:00:00.000Z";

  function collection(store, name) {
    const rows = store[name];
    if (!Array.isArray(rows)) throw missingCollection(name);

    return {
      doc(id) {
        return {
          async get() {
            const row = rows.find((item) => item._id === id);
            if (!row) throw missingDocument(id);
            return { data: clone(row) };
          },
          async update({ data }) {
            const index = rows.findIndex((item) => item._id === id);
            if (index < 0) throw missingDocument(id);
            rows[index] = { ...rows[index], ...clone(data) };
            return { stats: { updated: 1 } };
          }
        };
      },
      where(condition) {
        let limit = Infinity;
        const query = {
          limit(value) {
            limit = value;
            return query;
          },
          async get() {
            return { data: clone(rows.filter((row) => matches(row, condition)).slice(0, limit)) };
          }
        };
        return query;
      },
      async add({ data }) {
        if (options.failAddCollection === name) throw new Error(`simulated ${name} write failure`);
        sequence += 1;
        const row = { _id: `${name}-${sequence}`, ...clone(data) };
        rows.push(row);
        return { _id: row._id };
      }
    };
  }

  const db = {
    serverDate() {
      return new Date(timestamp);
    },
    async runTransaction(callback) {
      const working = clone(state);
      const tx = { collection: (name) => collection(working, name) };
      const result = await callback(tx);
      state = working;
      return result;
    },
    snapshot() {
      return clone(state);
    }
  };

  return db;
}

function stablePayload(payload) {
  return JSON.stringify(payload, Object.keys(payload || {}).sort());
}

function createIdempotency(options = {}) {
  const records = new Map();
  return {
    assertIdempotencyKey(value) {
      const key = String(value || "").trim();
      if (!/^[A-Za-z0-9_.*:-]{8,160}$/.test(key)) {
        const error = new Error(key ? "操作凭证格式无效" : "缺少操作凭证");
        error.code = key ? "IDEMPOTENCY_KEY_INVALID" : "IDEMPOTENCY_KEY_REQUIRED";
        throw error;
      }
      return key;
    },
    async runIdempotentAction(config, executor) {
      const recordKey = `${config.actionType}:${config.operatorIdentity}:${config.idempotencyKey}`;
      const requestHash = stablePayload(config.payload);
      const existing = records.get(recordKey);
      if (existing && existing.requestHash !== requestHash) {
        return {
          ok: false,
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "请求已被用于其他操作",
          data: { duplicate: true, idempotencyStatus: "conflict" }
        };
      }
      if (existing && options.alwaysExecute !== true) {
        return {
          ok: true,
          data: { ...clone(existing.data), duplicate: true, idempotencyStatus: "success" }
        };
      }
      const data = await executor();
      records.set(recordKey, { requestHash, data: clone(data) });
      return {
        ok: true,
        data: { ...data, duplicate: false, idempotencyStatus: "success" }
      };
    }
  };
}

function baseState(overrides = {}) {
  return {
    products: [{
      _id: "product-1",
      name: "测试商品",
      specification: "30ml",
      stock: 5,
      warningStock: 2,
      stockStatus: "normal",
      autoHideWhenOutOfStock: false,
      isActive: true,
      version: 3
    }],
    inventory_logs: [],
    admin_operation_logs: [],
    stock_alert_records: [],
    sync_events: [],
    ...clone(overrides)
  };
}

function assertDomainStateUnchanged(actual, expected) {
  assert.deepEqual(actual.products, expected.products);
  assert.deepEqual(actual.inventory_logs, expected.inventory_logs);
  assert.deepEqual(actual.admin_operation_logs, expected.admin_operation_logs);
  assert.deepEqual(actual.stock_alert_records, expected.stock_alert_records);
  assert.deepEqual(actual.sync_events, expected.sync_events);
}

module.exports = {
  assertDomainStateUnchanged,
  baseState,
  createDatabase,
  createIdempotency
};
