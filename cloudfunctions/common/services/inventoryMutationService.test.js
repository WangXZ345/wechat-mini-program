"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { applyInventoryMutationInTransaction, createInventoryMutationService } = require("./inventoryMutationService");

function storeWith(logs) {
  const queries = [];
  const store = {
    collection(name) {
      assert.equal(name, "inventory_logs");
      const query = {
        where(where) { queries.push({ where }); return query; },
        limit(limit) { queries.at(-1).limit = limit; return query; },
        async get() { return { data: logs.map((row) => ({ ...row })) }; }
      };
      return query;
    }
  };
  return { store, queries };
}

function validLog(overrides = {}) {
  return {
    businessKey: "order_deduct:o-1:p-1",
    sourceType: "order",
    sourceId: "o-1",
    relatedOrderId: "o-1",
    productId: "p-1",
    beforeStock: 5,
    afterStock: 3,
    changeAmount: -2,
    warningStock: 1,
    stockStatusAfter: "normal",
    isActiveAfter: true,
    versionAfter: 2,
    ...overrides
  };
}

function invoke(logs) {
  const current = storeWith(logs);
  return {
    current,
    promise: applyInventoryMutationInTransaction({
      db: { serverDate: () => new Date() },
      store: current.store,
      stockAlert: { buildStockStatusUpdate() {}, async syncStockAlertRecord() {} },
      input: { productId: "p-1", mode: "delta", delta: -2, reason: "订单审核" },
      actor: { id: "admin-1", role: "customer_service" },
      context: { businessKey: "order_deduct:o-1:p-1", sourceType: "order", sourceId: "o-1", relatedOrderId: "o-1" }
    })
  };
}

test("inventory business-key lookup uses limit(2) and fails closed on duplicates", async () => {
  const { current, promise } = invoke([validLog(), validLog({ _id: "duplicate" })]);
  await assert.rejects(() => promise, (error) => error.code === "INVENTORY_LOG_DUPLICATE");
  assert.equal(current.queries[0].limit, 2);
});

test("inventory replay validates source identity, related order, and signed change", async () => {
  for (const conflict of [
    { sourceType: "manual" },
    { sourceId: "o-other" },
    { relatedOrderId: "o-other" },
    { changeAmount: -1 }
  ]) {
    await assert.rejects(() => invoke([validLog(conflict)]).promise, (error) => error.code === "INVENTORY_LOG_CONFLICT");
  }
  const { current, promise } = invoke([validLog()]);
  const result = await promise;
  assert.equal(result.reused, true);
  assert.equal(current.queries[0].limit, 2);
});

test("a structurally valid legacy order deduction log can be reused without canonical result-only fields", async () => {
  const legacy = validLog();
  for (const field of ["warningStock", "stockStatusAfter", "isActiveAfter", "versionAfter"]) delete legacy[field];
  const result = await invoke([legacy]).promise;
  assert.deepEqual({ productId: result.productId, beforeStock: result.beforeStock, stock: result.stock, changed: result.changed, reused: result.reused }, {
    productId: "p-1", beforeStock: 5, stock: 3, changed: false, reused: true
  });
});

test("primitive rejects an overflowing product version before any product or business-log write", async () => {
  let productUpdates = 0;
  let inventoryAdds = 0;
  const store = {
    collection(name) {
      if (name === "inventory_logs") {
        return {
          where() {
            const query = {
              limit() { return query; },
              async get() { return { data: [] }; }
            };
            return query;
          },
          async add() {
            inventoryAdds += 1;
          }
        };
      }
      if (name === "products") {
        return {
          doc() {
            return {
              async get() {
                return {
                  data: {
                    _id: "p-1",
                    stock: 5,
                    warningStock: 1,
                    stockStatus: "normal",
                    isActive: true,
                    version: Number.MAX_SAFE_INTEGER
                  }
                };
              },
              async update() {
                productUpdates += 1;
              }
            };
          }
        };
      }
      throw new Error(`unexpected collection ${name}`);
    }
  };

  await assert.rejects(
    () => applyInventoryMutationInTransaction({
      db: { serverDate: () => new Date("2026-07-23T08:00:00.000Z") },
      store,
      stockAlert: {
        buildStockStatusUpdate(product, { stock, now }) {
          return {
            stock,
            warningStock: product.warningStock,
            stockStatus: "normal",
            isActive: true,
            lastStockCheckAt: now,
            updatedAt: now
          };
        },
        async syncStockAlertRecord() {}
      },
      input: { productId: "p-1", mode: "delta", delta: -1, reason: "订单审核" },
      actor: { id: "system", role: "system" },
      context: {
        businessKey: "order_deduct:o-1:p-1",
        sourceType: "order",
        sourceId: "o-1",
        relatedOrderId: "o-1",
        writeAudit: false,
        writeSync: false
      }
    }),
    (error) => error.code === "DATA_VERSION_INVALID"
  );
  assert.equal(productUpdates, 0);
  assert.equal(inventoryAdds, 0);
});

test("idempotency recovery also fails closed on duplicate or conflicting inventory logs", async () => {
  for (const logs of [[validLog(), validLog({ _id: "duplicate" })], [validLog({ sourceId: "wrong-operation" })]]) {
    let observedLimit;
    const db = {
      async createCollection() {},
      collection(name) {
        assert.equal(name, "inventory_logs");
        const query = {
          where() { return query; },
          limit(value) { observedLimit = value; return query; },
          async get() { return { data: logs }; }
        };
        return query;
      },
      async runTransaction() { throw new Error("execute must not run during recovery"); }
    };
    const service = createInventoryMutationService({
      db,
      stockAlert: { buildStockStatusUpdate() {}, async syncStockAlertRecord() {} },
      idempotency: {
        async ensureCollection() {},
        assertIdempotencyKey(key) { return key; },
        async runIdempotentAction(options) { return { ok: true, data: await options.recoverProcessingResult() }; }
      }
    });
    await assert.rejects(
      () => service.adjustInventory({ actor: { id: "proc-1", role: "procurement", status: "active", isActive: true, permissions: ["inventory:update"] }, input: { productId: "p-1", mode: "delta", delta: -2, expectedStock: 5, expectedVersion: 1, reason: "test" }, idempotencyKey: "o-1" }),
      (error) => ["INVENTORY_LOG_DUPLICATE", "INVENTORY_LOG_CONFLICT"].includes(error.code)
    );
    assert.equal(observedLimit, 2);
  }
});
