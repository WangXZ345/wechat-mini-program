"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ReturnInspectionError,
  normalizeInspectionActor,
  normalizeInspectionInput,
  nextInspectionStatus,
  createReturnInspectionService
} = require("../returnInspectionService");

function actor(overrides = {}) {
  return {
    id: "admin-1",
    openid: "openid-1",
    role: "customer_service",
    status: "active",
    isActive: true,
    permissions: ["after_sale:receive_return", "after_sale:inspect"],
    ...overrides
  };
}

function clone(value) {
  return structuredClone(value);
}

function fakeDb({ afterSale, inventoryLogs = [], inventoryDataOverride, missingProductIds = [], products = {}, failInventoryRead = false }) {
  const state = {
    afterSale: clone(afterSale),
    products: clone(products),
    inventoryLogs: clone(inventoryLogs),
    updates: [],
    writes: [],
    queries: []
  };
  const collection = (target, name) => ({
    doc(id) {
      return {
        async get() {
          if (name === "products") {
            if (missingProductIds.includes(id)) return { data: undefined };
            if (Object.prototype.hasOwnProperty.call(target.products, id)) return { data: clone(target.products[id]) };
            return {
              data: {
                _id: id,
                stock: 5,
                warningStock: 2,
                stockStatus: "normal",
                isActive: true,
                version: 2
              }
            };
          }
          if (name === "after_sales") return { data: clone(target.afterSale) };
          return { data: undefined };
        },
        async update({ data }) {
          target.updates.push({ collection: name, id, data: clone(data) });
          if (name === "after_sales") Object.assign(target.afterSale, clone(data));
          if (name === "products" && Object.prototype.hasOwnProperty.call(target.products, id)) {
            Object.assign(target.products[id], clone(data));
          }
        }
      };
    },
    async add({ data }) {
      target.writes.push({ collection: name, data: clone(data) });
      return { _id: `${name}-${target.writes.length}` };
    },
    where(query) {
      return {
        limit(limit) {
          return {
            async get() {
              state.queries.push({ collection: name, query: clone(query), limit });
              if (name === "inventory_logs" && failInventoryRead) {
                throw new Error("inventory query unavailable");
              }
              if (name === "inventory_logs" && inventoryDataOverride !== undefined) {
                return { data: clone(inventoryDataOverride) };
              }
              const rows = [
                ...(name === "inventory_logs" ? target.inventoryLogs : []),
                ...target.writes
                  .filter((entry) => entry.collection === name)
                  .map((entry) => entry.data)
              ];
              return {
                data: clone(rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value)))
              };
            }
          };
        }
      };
    }
  });
  const db = {
    async runTransaction(callback) {
      const draft = {
        afterSale: clone(state.afterSale),
        products: clone(state.products),
        inventoryLogs: clone(state.inventoryLogs),
        updates: [],
        writes: []
      };
      const result = await callback({ collection: (name) => collection(draft, name) });
      state.afterSale = draft.afterSale;
      state.products = draft.products;
      state.inventoryLogs = draft.inventoryLogs;
      state.updates.push(...draft.updates);
      state.writes.push(...draft.writes);
      return result;
    },
    collection(name) {
      return collection(state, name);
    }
  };
  db.state = state;
  return { state, db };
}

function idempotency() {
  return {
    assertIdempotencyKey(value) {
      if (!value) throw Object.assign(new Error("missing key"), { code: "IDEMPOTENCY_KEY_REQUIRED" });
      return value;
    },
    async ensureCollection() {},
    async runIdempotentAction(options, executor) {
      const data = await executor();
      return { ok: true, data };
    }
  };
}

function recoverableIdempotency({ leaveFirstResultProcessing = false, partitionByOperator = true } = {}) {
  const records = new Map();
  let shouldLeaveProcessing = leaveFirstResultProcessing;
  return {
    records,
    assertIdempotencyKey(value) {
      if (!value) throw Object.assign(new Error("missing key"), { code: "IDEMPOTENCY_KEY_REQUIRED" });
      return value;
    },
    async ensureCollection() {},
    async runIdempotentAction(options, executor) {
      const operatorPartition = partitionByOperator ? `:${options.operatorIdentity}` : "";
      const recordKey = `${options.actionType}${operatorPartition}:${options.idempotencyKey}`;
      const payload = JSON.stringify(options.payload);
      const existing = records.get(recordKey);
      if (existing && existing.payload !== payload) {
        return {
          ok: false,
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "请求已被用于其他操作"
        };
      }
      if (existing && existing.status === "success") {
        return { ok: true, data: { ...existing.data, duplicate: true } };
      }
      if (existing && existing.status === "processing") {
        const recovered = await options.recoverProcessingResult(existing);
        if (!recovered) {
          return {
            ok: false,
            code: "IDEMPOTENCY_PROCESSING",
            message: "操作正在处理中"
          };
        }
        existing.status = "success";
        existing.data = clone(recovered);
        return { ok: true, data: { ...recovered, duplicate: true } };
      }
      const record = { payload, status: "processing", data: null };
      records.set(recordKey, record);
      const data = await executor();
      if (shouldLeaveProcessing) {
        shouldLeaveProcessing = false;
        return { ok: true, data };
      }
      record.status = "success";
      record.data = clone(data);
      return { ok: true, data };
    }
  };
}

function inventoryResult(productId, quantity, overrides = {}) {
  return {
    productId,
    beforeStock: 5,
    stock: 5 + quantity,
    warningStock: 2,
    stockStatus: "normal",
    isActive: true,
    version: 3,
    updatedAt: new Date("2026-07-16T08:01:00.000Z"),
    changed: true,
    reused: false,
    ...overrides
  };
}

function committedInventoryLog(overrides = {}) {
  return {
    businessKey: "after_sale_restock:as-1:product-1",
    productId: "product-1",
    sourceType: "after_sale",
    sourceId: "as-1",
    relatedOrderId: "order-1",
    relatedAfterSaleId: "as-1",
    changeAmount: 1,
    beforeStock: 5,
    afterStock: 6,
    warningStock: 2,
    stockStatusAfter: "normal",
    isActiveAfter: true,
    versionBefore: 2,
    versionAfter: 3,
    ...overrides
  };
}

function inspectCommand(idempotencyKey, inputOverrides = {}, actorOverrides = {}) {
  return {
    actor: actor(actorOverrides),
    idempotencyKey,
    strict: true,
    input: {
      action: "inspect",
      afterSaleId: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      itemCondition: "sellable",
      canRestock: true,
      restockQuantity: 1,
      inspectionRemark: "商品可售",
      ...inputOverrides
    }
  };
}

function receiveCommand(idempotencyKey, inputOverrides = {}, actorOverrides = {}) {
  return {
    actor: actor(actorOverrides),
    idempotencyKey,
    strict: true,
    input: {
      action: "receive",
      afterSaleId: "as-1",
      expectedStatus: "waiting_return",
      expectedVersion: 4,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      remark: "物流已核对",
      ...inputOverrides
    }
  };
}

function serviceFor(db, overrides = {}) {
  return createReturnInspectionService({
    db,
    idempotency: idempotency(),
    now: () => new Date("2026-07-16T08:01:00.000Z"),
    ownerKeyFor: () => "owner-key",
    syncOwnerPepper: "p".repeat(32),
    getAfterSaleById: async (store, id) => store.collection("after_sales").doc(id).get().then((result) => result.data),
    writeAfterSaleLog: async (store, data) => store.collection("after_sale_logs").add({
      data: {
        afterSaleId: data.afterSale._id,
        orderId: data.afterSale.orderId,
        action: data.action,
        beforeData: data.beforeData,
        afterData: data.afterData,
        operatorId: data.operator.id,
        operatorRole: data.operator.role,
        businessKey: data.businessKey,
        remark: data.remark,
        resultData: data.resultData
      }
    }),
    writeAdminOperation: async (store, data) => store.collection("admin_operation_logs").add({ data }),
    incrementInventory: async ({ tx, afterSale, productId, quantity, businessKey }) => {
      await tx.collection("inventory_logs").add({
        data: { afterSaleId: afterSale._id, productId, quantity, businessKey }
      });
    },
    ...overrides
  });
}

test("receive actor requires an active customer service or super admin permission", () => {
  assert.equal(normalizeInspectionActor(actor(), "receive").role, "customer_service");
  assert.equal(normalizeInspectionActor(actor({ role: "super_admin", permissions: [] }), "inspect").role, "super_admin");
  assert.throws(
    () => normalizeInspectionActor(actor({ role: "finance" }), "receive"),
    (error) => error instanceof ReturnInspectionError && error.code === "FORBIDDEN"
  );
  assert.throws(
    () => normalizeInspectionActor(actor({ permissions: [] }), "inspect"),
    (error) => error instanceof ReturnInspectionError && error.code === "FORBIDDEN"
  );
});

test("strict receive input accepts only the optimistic snapshot contract", () => {
  assert.deepEqual(normalizeInspectionInput({
    action: "receive",
    afterSaleId: "as-1",
    expectedStatus: "waiting_return",
    expectedVersion: 4,
    expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
    remark: "已核对物流"
  }, { strict: true }), {
    action: "receive",
    afterSaleId: "as-1",
    expectedStatus: "waiting_return",
    expectedVersion: 4,
    expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
    remark: "已核对物流"
  });
  assert.throws(
    () => normalizeInspectionInput({
      action: "receive",
      afterSaleId: "as-1",
      expectedStatus: "waiting_return",
      expectedVersion: 4,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      orderId: "forged"
    }, { strict: true }),
    (error) => error instanceof ReturnInspectionError && error.code === "UNKNOWN_FIELD"
  );
});

test("strict inspect input rejects non-sellable restock and invalid snapshots", () => {
  assert.throws(
    () => normalizeInspectionInput({
      action: "inspect",
      afterSaleId: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      itemCondition: "damaged",
      canRestock: true,
      restockQuantity: 1
    }, { strict: true }),
    (error) => error instanceof ReturnInspectionError && error.code === "RESTOCK_CONDITION_INVALID"
  );
  assert.throws(
    () => normalizeInspectionInput({
      action: "inspect",
      afterSaleId: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt: "not-a-date",
      itemCondition: "sellable",
      canRestock: false,
      restockQuantity: 0
    }, { strict: true }),
    (error) => error instanceof ReturnInspectionError && error.code === "EXPECTED_UPDATED_AT_INVALID"
  );
  assert.throws(
    () => normalizeInspectionInput({
      action: "inspect",
      afterSaleId: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      canRestock: false,
      restockQuantity: 1
    }, { strict: true }),
    (error) => error instanceof ReturnInspectionError && error.code === "ITEM_CONDITION_REQUIRED"
  );
  assert.throws(
    () => normalizeInspectionInput({
      action: "inspect",
      afterSaleId: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      itemCondition: "sellable",
      canRestock: false,
      restockQuantity: 1
    }, { strict: true }),
    (error) => error instanceof ReturnInspectionError && error.code === "RESTOCK_QUANTITY_INVALID"
  );
  assert.equal(normalizeInspectionInput({
    action: "inspect",
    afterSaleId: "as-1",
    itemCondition: "opened",
    canRestock: false,
    restockQuantity: 0
  }, { strict: false }).itemCondition, "opened");
});

test("inspection status follows the approved refund state without completing refund_pending", () => {
  assert.equal(nextInspectionStatus({ approvedRefundAmount: 0 }), "approved");
  assert.equal(nextInspectionStatus({ approvedRefundAmount: 1200 }), "refund_pending");
});

test("receive mutation updates the after-sale version and emits a safe owner event", async () => {
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      openid: "owner-openid",
      afterSaleStatus: "waiting_return",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z"
    }
  });
  const result = await serviceFor(db).confirmReturnReceived({
    actor: actor(),
    idempotencyKey: "return-receive-001",
    strict: true,
    input: {
      action: "receive",
      afterSaleId: "as-1",
      expectedStatus: "waiting_return",
      expectedVersion: 4,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      remark: "物流已核对"
    }
  });
  assert.equal(result.afterSaleStatus, "received");
  assert.equal(result.version, 5);
  assert.equal(state.afterSale.version, 5);
  const sync = state.writes.find((entry) => entry.collection === "sync_events");
  assert.equal(sync.data.ownerKey, "owner-key");
  assert.equal("openid" in sync.data, false);
  assert.equal("orderId" in sync.data, false);
});

test("inspect mutation fails closed when inventory-log deduplication cannot be read", async () => {
  const { db } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      openid: "owner-openid",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [{ productId: "product-1", returnQuantity: 2 }]
    },
    failInventoryRead: true
  });
  await assert.rejects(
    () => serviceFor(db).inspectReturnItems({
      actor: actor(),
      idempotencyKey: "return-inspect-001",
      strict: true,
      input: {
        action: "inspect",
        afterSaleId: "as-1",
        expectedStatus: "received",
        expectedVersion: 4,
        expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
        itemCondition: "sellable",
        canRestock: true,
        restockQuantity: 2,
        inspectionRemark: "商品可售"
      }
    }),
    (error) => error.code === "INVENTORY_LOG_READ_FAILED"
  );
});

test("inspect mutation rejects a requested restock larger than returned quantities", async () => {
  const { db } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      openid: "owner-openid",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [{ productId: "product-1", returnQuantity: 1 }]
    }
  });
  await assert.rejects(
    () => serviceFor(db).inspectReturnItems({
      actor: actor(),
      idempotencyKey: "return-inspect-002",
      strict: true,
      input: {
        action: "inspect",
        afterSaleId: "as-1",
        expectedStatus: "received",
        expectedVersion: 4,
        expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
        itemCondition: "sellable",
        canRestock: true,
        restockQuantity: 2
      }
    }),
    (error) => error.code === "RESTOCK_QUANTITY_EXCEEDED"
  );
});

test("inspect recovery counts an existing inventory log before allocating remaining quantity", async () => {
  const calls = [];
  const { db } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [
        { productId: "product-1", returnQuantity: 1 },
        { productId: "product-2", returnQuantity: 1 }
      ]
    },
    inventoryLogs: [{
      businessKey: "after_sale_restock:as-1:product-1",
      productId: "product-1",
      sourceType: "after_sale",
      sourceId: "as-1",
      relatedOrderId: "order-1",
      relatedAfterSaleId: "as-1",
      changeAmount: 1,
      beforeStock: 2,
      afterStock: 3,
      warningStock: 1,
      stockStatusAfter: "normal",
      isActiveAfter: true,
      versionBefore: 1,
      versionAfter: 2
    }]
  });
  const result = await serviceFor(db, {
    applyInventoryMutationInTransaction: async ({ input }) => {
      calls.push(input.productId);
      return inventoryResult(input.productId, input.delta);
    }
  }).inspectReturnItems({
    actor: actor(),
    idempotencyKey: "return-inspect-recovery-001",
    strict: true,
    input: {
      action: "inspect",
      afterSaleId: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      itemCondition: "sellable",
      canRestock: true,
      restockQuantity: 2,
      inspectionRemark: "recovered"
    }
  });

  assert.equal(result.restoredQuantity, 2);
  assert.deepEqual(calls, ["product-2"]);
});

test("inspect fails closed when the inventory-log query returns malformed data", async () => {
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [{ productId: "product-1", returnQuantity: 1 }]
    },
    inventoryDataOverride: { corrupted: true }
  });

  await assert.rejects(
    () => serviceFor(db).inspectReturnItems({
      actor: actor(),
      idempotencyKey: "return-inspect-corrupt-001",
      strict: true,
      input: {
        action: "inspect",
        afterSaleId: "as-1",
        expectedStatus: "received",
        expectedVersion: 4,
        expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
        itemCondition: "sellable",
        canRestock: true,
        restockQuantity: 1
      }
    }),
    (error) => error.code === "INVENTORY_LOG_DATA_INVALID"
  );
  assert.equal(state.updates.length, 0);
  assert.equal(state.writes.length, 0);
});

test("inspect rejects a returned-item quantity sum that exceeds safe integer range", async () => {
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [
        { productId: "product-1", returnQuantity: Number.MAX_SAFE_INTEGER },
        { productId: "product-2", returnQuantity: 1 }
      ]
    }
  });

  await assert.rejects(
    () => serviceFor(db).inspectReturnItems({
      actor: actor(),
      idempotencyKey: "return-inspect-overflow-001",
      strict: true,
      input: {
        action: "inspect",
        afterSaleId: "as-1",
        expectedStatus: "received",
        expectedVersion: 4,
        expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
        itemCondition: "sellable",
        canRestock: true,
        restockQuantity: 1
      }
    }),
    (error) => error.code === "RETURN_ITEM_DATA_INVALID"
  );
  assert.equal(state.updates.length, 0);
  assert.equal(state.writes.length, 0);
});

test("inspect aggregates duplicate product rows before applying multi-product restock", async () => {
  const calls = [];
  const { db } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [
        { productId: "product-1", returnQuantity: 1 },
        { productId: "product-1", returnQuantity: 2 },
        { productId: "product-2", returnQuantity: 1 }
      ]
    }
  });
  const result = await serviceFor(db, {
    applyInventoryMutationInTransaction: async ({ input }) => {
      calls.push({ productId: input.productId, delta: input.delta });
      return inventoryResult(input.productId, input.delta);
    }
  }).inspectReturnItems({
    actor: actor(),
    idempotencyKey: "return-inspect-multi-001",
    strict: true,
    input: {
      action: "inspect",
      afterSaleId: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      itemCondition: "sellable",
      canRestock: true,
      restockQuantity: 4
    }
  });

  assert.equal(result.restoredQuantity, 4);
  assert.deepEqual(calls, [
    { productId: "product-1", delta: 3 },
    { productId: "product-2", delta: 1 }
  ]);
});

test("inspect rejects a missing returned product before applying inventory changes", async () => {
  const calls = [];
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [{ productId: "missing-product", returnQuantity: 1 }]
    },
    missingProductIds: ["missing-product"]
  });

  await assert.rejects(
    () => serviceFor(db, {
      applyInventoryMutationInTransaction: async ({ input }) => {
        calls.push(input.productId);
      }
    }).inspectReturnItems({
      actor: actor(),
      idempotencyKey: "return-inspect-missing-001",
      strict: true,
      input: {
        action: "inspect",
        afterSaleId: "as-1",
        expectedStatus: "received",
        expectedVersion: 4,
        expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
        itemCondition: "sellable",
        canRestock: true,
        restockQuantity: 1
      }
    }),
    (error) => error.code === "PRODUCT_NOT_FOUND"
  );
  assert.deepEqual(calls, []);
  assert.equal(state.updates.length, 0);
});

test("inspect transaction rolls back every visible inventory write when a later adapter write fails", async () => {
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [
        { productId: "product-1", returnQuantity: 1 },
        { productId: "product-2", returnQuantity: 1 }
      ]
    },
    products: {
      "product-1": { _id: "product-1", stock: 5, version: 2 },
      "product-2": { _id: "product-2", stock: 8, version: 7 }
    }
  });

  await assert.rejects(
    () => serviceFor(db, {
      applyInventoryMutationInTransaction: async ({ store, input, context }) => {
        const beforeStock = input.productId === "product-1" ? 5 : 8;
        await store.collection("products").doc(input.productId).update({
          data: { stock: beforeStock + input.delta, version: input.expectedVersion + 1 }
        });
        await store.collection("inventory_logs").add({
          data: {
            businessKey: context.businessKey,
            productId: input.productId,
            sourceType: context.sourceType,
            sourceId: context.sourceId,
            relatedOrderId: context.relatedOrderId,
            relatedAfterSaleId: context.relatedAfterSaleId,
            changeAmount: input.delta
          }
        });
        if (input.productId === "product-2") throw new Error("inventory log write failed");
        return inventoryResult(input.productId, input.delta, {
          beforeStock,
          stock: beforeStock + input.delta,
          version: input.expectedVersion + 1
        });
      }
    }).inspectReturnItems(inspectCommand("return-inspect-rollback-001", {
      restockQuantity: 2
    })),
    /inventory log write failed/
  );

  assert.equal(state.afterSale.afterSaleStatus, "received");
  assert.equal(state.afterSale.version, 4);
  assert.equal(state.products["product-1"].stock, 5);
  assert.equal(state.products["product-2"].stock, 8);
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.writes, []);
});

test("inspect validates the unique existing inventory log identity after a limit-two query", async () => {
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [{ productId: "product-1", returnQuantity: 1 }]
    },
    inventoryDataOverride: [{
      businessKey: "after_sale_restock:as-other:product-1",
      productId: "product-1",
      sourceType: "after_sale",
      sourceId: "as-1",
      relatedOrderId: "order-1",
      relatedAfterSaleId: "as-1",
      changeAmount: 1,
      beforeStock: 5,
      afterStock: 6,
      warningStock: 2,
      stockStatusAfter: "normal",
      isActiveAfter: true,
      versionAfter: 3
    }]
  });

  await assert.rejects(
    () => serviceFor(db).inspectReturnItems(inspectCommand("return-inspect-log-conflict-001")),
    (error) => error.code === "INVENTORY_LOG_CONFLICT"
  );

  assert.deepEqual(state.queries[0], {
    collection: "inventory_logs",
    query: { businessKey: "after_sale_restock:as-1:product-1" },
    limit: 2
  });
  assert.equal(state.afterSale.afterSaleStatus, "received");
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.writes, []);
});

test("inspect fails closed when the inventory business key has duplicate committed logs", async () => {
  const log = {
    businessKey: "after_sale_restock:as-1:product-1",
    productId: "product-1",
    sourceType: "after_sale",
    sourceId: "as-1",
    relatedOrderId: "order-1",
    relatedAfterSaleId: "as-1",
    changeAmount: 1,
    beforeStock: 5,
    afterStock: 6,
    warningStock: 2,
    stockStatusAfter: "normal",
    isActiveAfter: true,
    versionAfter: 3
  };
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [{ productId: "product-1", returnQuantity: 1 }]
    },
    inventoryDataOverride: [log, { ...log }]
  });

  await assert.rejects(
    () => serviceFor(db).inspectReturnItems(inspectCommand("return-inspect-log-duplicate-001")),
    (error) => error.code === "INVENTORY_LOG_DUPLICATE"
  );
  assert.equal(state.afterSale.afterSaleStatus, "received");
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.writes, []);
});

test("inspect rejects unsafe or malformed canonical inventory adapter results", async (t) => {
  const cases = [
    ["overflowed stock", { stock: Number.MAX_SAFE_INTEGER + 1 }],
    ["overflowed version", { version: Number.MAX_SAFE_INTEGER + 1 }],
    ["non-boolean active state", { isActive: "true" }]
  ];

  for (const [name, invalidResult] of cases) {
    await t.test(name, async () => {
      const { db, state } = fakeDb({
        afterSale: {
          _id: "as-1",
          orderId: "order-1",
          afterSaleStatus: "received",
          version: 4,
          updatedAt: "2026-07-16T08:00:00.000Z",
          approvedRefundAmount: 0,
          returnItems: [{ productId: "product-1", returnQuantity: 1 }]
        }
      });

      await assert.rejects(
        () => serviceFor(db, {
          applyInventoryMutationInTransaction: async ({ input }) => inventoryResult(
            input.productId,
            input.delta,
            invalidResult
          )
        }).inspectReturnItems(inspectCommand(`return-inspect-result-${name}`)),
        (error) => error.code === "INVENTORY_MUTATION_RESULT_INVALID"
      );
      assert.equal(state.afterSale.afterSaleStatus, "received");
      assert.deepEqual(state.updates, []);
      assert.deepEqual(state.writes, []);
    });
  }
});

test("same idempotency key with changed payload preserves the original processing record and original retry recovers", async () => {
  const idem = recoverableIdempotency({ leaveFirstResultProcessing: true });
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [{ productId: "product-1", returnQuantity: 1 }]
    }
  });
  const service = serviceFor(db, {
    idempotency: idem,
    applyInventoryMutationInTransaction: async ({ store, input, context }) => {
      const result = inventoryResult(input.productId, input.delta);
      await store.collection("inventory_logs").add({
        data: {
          businessKey: context.businessKey,
          productId: input.productId,
          sourceType: context.sourceType,
          sourceId: context.sourceId,
          relatedOrderId: context.relatedOrderId,
          relatedAfterSaleId: context.relatedAfterSaleId,
          changeAmount: input.delta,
          beforeStock: result.beforeStock,
          afterStock: result.stock,
          warningStock: result.warningStock,
          stockStatusAfter: result.stockStatus,
          isActiveAfter: result.isActive,
          versionAfter: result.version
        }
      });
      return result;
    }
  });
  const command = inspectCommand("return-inspect-processing-001");
  const first = await service.inspectReturnItems(command);
  assert.equal(first.affected, 1);

  const beforeConflict = {
    updates: state.updates.length,
    writes: state.writes.length
  };
  const [record] = idem.records.values();
  const originalPayload = record.payload;
  await assert.rejects(
    () => service.inspectReturnItems(inspectCommand("return-inspect-processing-001", {
      inspectionRemark: "不同载荷"
    })),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT"
  );
  assert.equal(record.payload, originalPayload);
  assert.equal(record.status, "processing");
  assert.equal(state.updates.length, beforeConflict.updates);
  assert.equal(state.writes.length, beforeConflict.writes);

  const recovered = await service.inspectReturnItems(command);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.affected, 0);
  assert.equal(recovered.restoredQuantity, 1);
  assert.equal(record.status, "success");
  assert.equal(state.updates.length, beforeConflict.updates);
  assert.equal(state.writes.length, beforeConflict.writes);
});

test("processing recovery fails closed when the committed log belongs to another after-sale record", async () => {
  const idem = recoverableIdempotency({ leaveFirstResultProcessing: true });
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [{ productId: "product-1", returnQuantity: 1 }]
    }
  });
  const service = serviceFor(db, {
    idempotency: idem,
    applyInventoryMutationInTransaction: async ({ input }) => inventoryResult(input.productId, input.delta)
  });
  const command = inspectCommand("return-inspect-processing-corrupt-001");
  await service.inspectReturnItems(command);
  const committedLog = state.writes.find((entry) => entry.collection === "after_sale_logs");
  committedLog.data.afterSaleId = "as-other";

  await assert.rejects(
    () => service.inspectReturnItems(command),
    (error) => error.code === "IDEMPOTENCY_PROCESSING"
  );
  const [record] = idem.records.values();
  assert.equal(record.status, "processing");
});

test("inspect processing recovery uses immutable minimal log evidence instead of current after-sale state", async () => {
  const idem = recoverableIdempotency({ leaveFirstResultProcessing: true });
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "received",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 0,
      returnItems: [{ productId: "product-1", returnQuantity: 1 }]
    }
  });
  const service = serviceFor(db, {
    idempotency: idem,
    applyInventoryMutationInTransaction: async ({ input }) => inventoryResult(input.productId, input.delta)
  });
  const command = inspectCommand("return-inspect-evidence-001");
  const first = await service.inspectReturnItems(command);
  const committedLog = state.writes.find((entry) => entry.collection === "after_sale_logs");

  assert.deepEqual(committedLog.data.resultData, {
    afterSaleId: "as-1",
    action: "inspect_return_items",
    businessKey: "return-inspect-evidence-001",
    operatorId: "admin-1",
    afterSaleStatus: "approved",
    version: 5,
    updatedAt: "2026-07-16T08:01:00.000Z",
    restoredQuantity: 1
  });

  state.afterSale.afterSaleStatus = "refunded";
  state.afterSale.version = 99;
  state.afterSale.updatedAt = "2026-07-17T09:30:00.000Z";
  state.afterSale.inspectionResult = { restockQuantity: 99, inspectedBy: "another-admin" };
  const beforeRecovery = { updates: state.updates.length, writes: state.writes.length };
  const recovered = await service.inspectReturnItems(command);

  assert.deepEqual(recovered, {
    afterSaleId: first.afterSaleId,
    afterSaleStatus: first.afterSaleStatus,
    version: first.version,
    updatedAt: first.updatedAt,
    restoredQuantity: first.restoredQuantity,
    affected: 0,
    reused: true,
    duplicate: true
  });
  assert.equal(state.updates.length, beforeRecovery.updates);
  assert.equal(state.writes.length, beforeRecovery.writes);
});

test("receive processing recovery uses immutable minimal log evidence instead of current after-sale state", async () => {
  const idem = recoverableIdempotency({ leaveFirstResultProcessing: true });
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "waiting_return",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z"
    }
  });
  const service = serviceFor(db, { idempotency: idem });
  const command = receiveCommand("return-receive-evidence-001");
  const first = await service.confirmReturnReceived(command);
  const committedLog = state.writes.find((entry) => entry.collection === "after_sale_logs");

  assert.deepEqual(committedLog.data.resultData, {
    afterSaleId: "as-1",
    action: "confirm_return_received",
    businessKey: "return-receive-evidence-001",
    operatorId: "admin-1",
    afterSaleStatus: "received",
    version: 5,
    updatedAt: "2026-07-16T08:01:00.000Z",
    restoredQuantity: 0
  });

  state.afterSale.afterSaleStatus = "completed";
  state.afterSale.version = 101;
  state.afterSale.updatedAt = "2026-07-17T09:30:00.000Z";
  const recovered = await service.confirmReturnReceived(command);
  assert.deepEqual(recovered, {
    afterSaleId: first.afterSaleId,
    afterSaleStatus: first.afterSaleStatus,
    version: first.version,
    updatedAt: first.updatedAt,
    restoredQuantity: first.restoredQuantity,
    affected: 0,
    reused: true,
    duplicate: true
  });
});

test("receive and inspect processing recovery reject a log committed by another operator", async (t) => {
  for (const action of ["receive", "inspect"]) {
    await t.test(action, async () => {
      const idem = recoverableIdempotency({
        leaveFirstResultProcessing: true,
        partitionByOperator: false
      });
      const { db } = fakeDb({
        afterSale: action === "receive"
          ? {
            _id: "as-1",
            orderId: "order-1",
            afterSaleStatus: "waiting_return",
            version: 4,
            updatedAt: "2026-07-16T08:00:00.000Z"
          }
          : {
            _id: "as-1",
            orderId: "order-1",
            afterSaleStatus: "received",
            version: 4,
            updatedAt: "2026-07-16T08:00:00.000Z",
            approvedRefundAmount: 0,
            returnItems: [{ productId: "product-1", returnQuantity: 1 }]
          }
      });
      const service = serviceFor(db, {
        idempotency: idem,
        applyInventoryMutationInTransaction: async ({ input }) => inventoryResult(input.productId, input.delta)
      });
      const key = `return-${action}-cross-operator-001`;
      const firstCommand = action === "receive" ? receiveCommand(key) : inspectCommand(key);
      const secondCommand = action === "receive"
        ? receiveCommand(key, {}, { id: "admin-2", openid: "openid-2" })
        : inspectCommand(key, {}, { id: "admin-2", openid: "openid-2" });
      await (action === "receive"
        ? service.confirmReturnReceived(firstCommand)
        : service.inspectReturnItems(firstCommand));

      await assert.rejects(
        () => action === "receive"
          ? service.confirmReturnReceived(secondCommand)
          : service.inspectReturnItems(secondCommand),
        (error) => error.code === "IDEMPOTENCY_PROCESSING"
      );
      const [record] = idem.records.values();
      assert.equal(record.status, "processing");
    });
  }
});

test("processing recovery rejects a committed result evidence version of zero", async () => {
  const idem = recoverableIdempotency({ leaveFirstResultProcessing: true });
  const { db, state } = fakeDb({
    afterSale: {
      _id: "as-1",
      orderId: "order-1",
      afterSaleStatus: "waiting_return",
      version: 4,
      updatedAt: "2026-07-16T08:00:00.000Z"
    }
  });
  const service = serviceFor(db, { idempotency: idem });
  const command = receiveCommand("return-receive-zero-version-001");
  await service.confirmReturnReceived(command);
  const committedLog = state.writes.find((entry) => entry.collection === "after_sale_logs");
  committedLog.data.resultData.version = 0;

  await assert.rejects(
    () => service.confirmReturnReceived(command),
    (error) => error.code === "IDEMPOTENCY_PROCESSING"
  );
  const [record] = idem.records.values();
  assert.equal(record.status, "processing");
});

test("existing inventory recovery requires a present and consecutive version transition", async (t) => {
  const cases = [
    ["missing versionBefore", { versionBefore: undefined }],
    ["backward version", { versionBefore: 3, versionAfter: 2 }],
    ["skipped version", { versionBefore: 1, versionAfter: 3 }]
  ];

  for (const [name, versionFields] of cases) {
    await t.test(name, async () => {
      const { db, state } = fakeDb({
        afterSale: {
          _id: "as-1",
          orderId: "order-1",
          afterSaleStatus: "received",
          version: 4,
          updatedAt: "2026-07-16T08:00:00.000Z",
          approvedRefundAmount: 0,
          returnItems: [{ productId: "product-1", returnQuantity: 1 }]
        },
        inventoryDataOverride: [committedInventoryLog(versionFields)]
      });

      await assert.rejects(
        () => serviceFor(db).inspectReturnItems(inspectCommand(`return-inspect-version-${name}`)),
        (error) => error.code === "INVENTORY_LOG_DATA_INVALID"
      );
      assert.equal(state.afterSale.afterSaleStatus, "received");
      assert.deepEqual(state.updates, []);
      assert.deepEqual(state.writes, []);
    });
  }
});
