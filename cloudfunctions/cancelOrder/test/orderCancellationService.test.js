const test = require("node:test");
const assert = require("node:assert/strict");
const { createOrderCancellationService } = require("../orderCancellationService");
const { applyInventoryMutationInTransaction } = require("../inventoryMutationService");
const realStockAlert = require("../stockAlert");

function clone(value) {
  return structuredClone(value);
}

function matches(row, where) {
  return Object.entries(where || {}).every(([key, value]) => row[key] === value);
}

function fakeDb(initial = {}, options = {}) {
  let state = clone({
    orders: [],
    order_items: [],
    products: [],
    inventory_logs: [],
    stock_alert_records: [],
    payment_records: [],
    sync_events: [],
    ...initial
  });
  let sequence = 0;

  function collection(target, name) {
    if (!target[name]) target[name] = [];
    return {
      where(where) {
        let limit = 100;
        return {
          limit(value) {
            limit = value;
            return this;
          },
          async get() {
            return { data: target[name].filter((row) => matches(row, where)).slice(0, limit).map(clone) };
          }
        };
      },
      doc(id) {
        return {
          async get() {
            const row = target[name].find((item) => item._id === id);
            if (!row) throw new Error("DOCUMENT_NOT_EXIST");
            return { data: clone(row) };
          },
          async update({ data }) {
            if (options.failUpdateCollection === name) throw new Error(`simulated ${name} update failure`);
            const index = target[name].findIndex((item) => item._id === id);
            if (index < 0) throw new Error("DOCUMENT_NOT_EXIST");
            target[name][index] = { ...target[name][index], ...clone(data) };
            return { stats: { updated: 1 } };
          }
        };
      },
      async add({ data }) {
        if (options.failAddCollection === name) throw new Error(`simulated ${name} add failure`);
        const row = { _id: data._id || `${name}-${++sequence}`, ...clone(data) };
        target[name].push(row);
        return { _id: row._id };
      }
    };
  }

  return {
    serverDate: () => new Date("2026-07-12T12:00:00.000Z"),
    collection(name) { return collection(state, name); },
    async runTransaction(callback) {
      const working = clone(state);
      const tx = { collection: (name) => collection(working, name) };
      const result = await callback(tx);
      state = working;
      return result;
    },
    snapshot() { return clone(state); }
  };
}

function fakeStockAlert(options = {}) {
  return {
    buildStockStatusUpdate(product, overrides) {
      const stock = overrides.stock;
      const warningStock = Number(product.warningStock || 0);
      return {
        stock,
        warningStock,
        stockStatus: stock <= 0 ? "out_of_stock" : stock <= warningStock ? "warning" : "normal",
        autoHideWhenOutOfStock: product.autoHideWhenOutOfStock === true,
        lastStockCheckAt: overrides.now,
        updatedAt: overrides.now
      };
    },
    async syncStockAlertRecord({ store }, productId, product, stockStatus, operatorId) {
      if (options.fail) throw new Error("simulated alert failure");
      const active = await store.collection("stock_alert_records").where({ productId, status: "active" }).limit(20).get();
      if (["warning", "out_of_stock"].includes(stockStatus)) {
        if (active.data[0]) {
          await store.collection("stock_alert_records").doc(active.data[0]._id).update({
            data: { stockStatus, status: "active", stock: product.stock }
          });
        } else {
          await store.collection("stock_alert_records").add({
            data: { productId, stockStatus, status: "active", stock: product.stock }
          });
        }
      } else {
        for (const row of active.data) {
          await store.collection("stock_alert_records").doc(row._id).update({
            data: { status: "resolved", resolvedBy: operatorId }
          });
        }
      }
    }
  };
}

const admin = {
  id: "admin-1",
  openid: "openid-admin-secret",
  kind: "admin",
  role: "super_admin",
  sourceClient: "miniprogram"
};
const user = {
  id: "user-openid",
  openid: "user-openid",
  kind: "user",
  role: "user",
  sourceClient: "miniprogram"
};

function approvedState(overrides = {}) {
  return {
    orders: [{
      _id: "order-1",
      status: "approved_pending_payment",
      paymentStatus: "unpaid",
      paidAmount: 0,
      deliveryStatus: "pending",
      shippingStatus: "",
      userId: "user-1",
      userOpenid: "user-openid",
      accountIncluded: true,
      version: 4,
      ...overrides.order
    }],
    order_items: [{ _id: "item-1", orderId: "order-1", productId: "product-1", quantity: 999 }],
    products: [{
      _id: "product-1",
      name: "商品一",
      stock: 8,
      warningStock: 5,
      stockStatus: "normal",
      isActive: true,
      totalSales: 2,
      version: 3,
      ...overrides.product
    }],
    inventory_logs: [{
      _id: "deduct-1",
      businessKey: "order_deduct:order-1:product-1",
      relatedOrderId: "order-1",
      productId: "product-1",
      beforeStock: 10,
      afterStock: 8,
      changeAmount: -2
    }, ...(overrides.inventory_logs || [])],
    payment_records: overrides.payment_records || [],
    stock_alert_records: overrides.stock_alert_records || [],
    sync_events: []
  };
}

function service(initial, options = {}) {
  const db = fakeDb(initial, options.database);
  const instance = createOrderCancellationService({
    db,
    stockAlert: options.stockAlert && options.stockAlert.fail ? fakeStockAlert(options.stockAlert) : realStockAlert,
    applyInventoryMutationInTransaction,
    now: () => new Date("2026-07-12T12:00:00.000Z")
  });
  return { db, service: instance };
}

test("pending order cancels without touching inventory", async () => {
  const current = service({
    orders: [{ _id: "order-1", status: "pending_admin", userOpenid: "user-openid", paidAmount: 0, paymentStatus: "none", deliveryStatus: "pending" }]
  });
  const result = await current.service.cancel({ actor: user, orderId: "order-1" });
  const state = current.db.snapshot();
  assert.equal(result.status, "cancelled");
  assert.equal(state.orders[0].inventoryRestored, false);
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.sync_events.length, 1);
});

test("approved order restores from deduction log rather than mutable item quantity", async () => {
  const current = service(approvedState());
  const result = await current.service.cancel({ actor: admin, orderId: "order-1", idempotencyKey: "cancel-key" });
  const state = current.db.snapshot();
  assert.equal(result.restoredProducts[0].quantity, 2);
  assert.equal(state.products[0].stock, 10);
  assert.equal(state.products[0].totalSales, 2);
  assert.equal(state.products[0].version, 4);
  assert.equal(state.orders[0].status, "cancelled");
  assert.equal(state.orders[0].inventoryRestored, true);
  assert.equal(state.orders[0].stockDeducted, false);
  assert.equal(state.orders[0].accountIncluded, false);
  assert.equal(state.orders[0].version, 5);
  assert.equal(state.inventory_logs[1].businessKey, "order_restore:order-1:product-1");
  assert.equal(state.inventory_logs[1].changeAmount, 2);
});

test("approved order cannot cancel while the latest payment proof is pending confirmation", async () => {
  const current = service(approvedState({
    order: { latestPaymentRecordId: "payment-pending" },
    payment_records: [{
      _id: "payment-pending",
      orderId: "order-1",
      status: "pending_confirm",
      createdAt: "2026-07-12T10:00:00.000Z"
    }]
  }));
  await assert.rejects(
    () => current.service.cancel({ actor: admin, orderId: "order-1" }),
    (error) => error.code === "ORDER_PAYMENT_PENDING_CONFIRM"
  );
  assert.equal(current.db.snapshot().orders[0].status, "approved_pending_payment");
});

test("a newer rejected payment review permits cancellation but any confirmed payment permanently blocks it", async () => {
  const rejected = approvedState({
    payment_records: [
      { _id: "proof", orderId: "order-1", status: "pending_confirm", createdAt: "2026-07-12T09:00:00.000Z" },
      { _id: "review", orderId: "order-1", status: "unpaid", confirmStatus: "rejected", createdAt: "2026-07-12T10:00:00.000Z" }
    ]
  });
  const allowed = service(rejected);
  await allowed.service.cancel({ actor: admin, orderId: "order-1" });
  assert.equal(allowed.db.snapshot().orders[0].status, "cancelled");

  const paid = service(approvedState({
    payment_records: [
      { _id: "confirmed", orderId: "order-1", status: "paid", confirmStatus: "confirmed", createdAt: "2026-07-12T08:00:00.000Z" },
      { _id: "later", orderId: "order-1", status: "unpaid", confirmStatus: "rejected", createdAt: "2026-07-12T10:00:00.000Z" }
    ]
  }));
  await assert.rejects(
    () => paid.service.cancel({ actor: admin, orderId: "order-1" }),
    (error) => error.code === "ORDER_ALREADY_PAID"
  );
});

test("auto-review deduction evidence uses the same business key contract", async () => {
  const current = service(approvedState({
    inventory_logs: [],
    order: { reviewType: "auto" }
  }));
  await current.service.cancel({ actor: admin, orderId: "order-1" });
  assert.equal(current.db.snapshot().products[0].stock, 10);
});

test("multi-product cancellation restores every product atomically", async () => {
  const initial = approvedState();
  initial.order_items.push({ _id: "item-2", orderId: "order-1", productId: "product-2", quantity: 1 });
  initial.products.push({ _id: "product-2", stock: 4, warningStock: 1, stockStatus: "normal", isActive: true, totalSales: 1, version: 7 });
  initial.inventory_logs.push({
    _id: "deduct-2", businessKey: "order_deduct:order-1:product-2", relatedOrderId: "order-1",
    productId: "product-2", beforeStock: 5, afterStock: 4, changeAmount: -1
  });
  const current = service(initial);
  await current.service.cancel({ actor: admin, orderId: "order-1" });
  const state = current.db.snapshot();
  assert.deepEqual(state.products.map((row) => row.stock), [10, 5]);
  assert.equal(state.inventory_logs.filter((row) => row.reason === "order_cancel_restore").length, 2);
});

test("repeated cancellation is a no-write success", async () => {
  const current = service(approvedState());
  await current.service.cancel({ actor: admin, orderId: "order-1", idempotencyKey: "first" });
  const before = current.db.snapshot();
  const duplicate = await current.service.cancel({ actor: admin, orderId: "order-1", idempotencyKey: "second" });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.accountRecalculationRequired, true);
  assert.equal(duplicate.userId, "user-1");
  assert.deepEqual(current.db.snapshot(), before);
});

test("missing or duplicate deduction evidence fails closed", async () => {
  const missing = approvedState();
  missing.inventory_logs = [];
  const missingCurrent = service(missing);
  await assert.rejects(
    missingCurrent.service.cancel({ actor: admin, orderId: "order-1" }),
    (err) => err.code === "INVENTORY_DEDUCTION_EVIDENCE_MISSING"
  );
  assert.equal(missingCurrent.db.snapshot().orders[0].status, "approved_pending_payment");

  const duplicate = approvedState();
  duplicate.inventory_logs.push({ ...duplicate.inventory_logs[0], _id: "deduct-copy" });
  const duplicateCurrent = service(duplicate);
  await assert.rejects(
    duplicateCurrent.service.cancel({ actor: admin, orderId: "order-1" }),
    (err) => err.code === "INVENTORY_LOG_CONFLICT"
  );
});

test("conflicting prior restore log fails closed", async () => {
  const current = service(approvedState({ inventory_logs: [{
    _id: "restore-bad",
    businessKey: "order_restore:order-1:product-1",
    relatedOrderId: "order-1",
    productId: "product-1",
    beforeStock: 8,
    afterStock: 9,
    changeAmount: 1
  }] }));
  await assert.rejects(
    current.service.cancel({ actor: admin, orderId: "order-1" }),
    (err) => err.code === "INVENTORY_RESTORE_LOG_INVALID"
  );
  assert.equal(current.db.snapshot().orders[0].status, "approved_pending_payment");
});

test("alert or outbox failure rolls back products, logs and order", async () => {
  const alertFailure = service(approvedState(), { stockAlert: { fail: true } });
  await assert.rejects(alertFailure.service.cancel({ actor: admin, orderId: "order-1" }), /simulated alert failure/);
  assert.deepEqual(alertFailure.db.snapshot(), approvedState());

  const outboxFailure = service(approvedState(), { database: { failAddCollection: "sync_events" } });
  await assert.rejects(outboxFailure.service.cancel({ actor: admin, orderId: "order-1" }), /simulated sync_events add failure/);
  assert.deepEqual(outboxFailure.db.snapshot(), approvedState());

  const orderWriteFailure = service(approvedState(), { database: { failUpdateCollection: "orders" } });
  await assert.rejects(orderWriteFailure.service.cancel({ actor: admin, orderId: "order-1" }), /simulated orders update failure/);
  assert.deepEqual(orderWriteFailure.db.snapshot(), approvedState());
});

test("paid and shipped orders remain non-cancelable", async () => {
  for (const order of [
    { paidAmount: 1 },
    { paymentStatus: "paid" },
    { paymentStatus: "partial_paid" },
    { deliveryStatus: "shipped" },
    { shippingStatus: "completed" },
    { shippingStatus: "picked_up" }
  ]) {
    const current = service(approvedState({ order }));
    await assert.rejects(
      current.service.cancel({ actor: admin, orderId: "order-1" }),
      (err) => ["ORDER_ALREADY_PAID", "ORDER_ALREADY_SHIPPED"].includes(err.code)
    );
    assert.equal(current.db.snapshot().orders[0].status, "approved_pending_payment");
  }
});

test("restock recalculates alerts without reactivating product", async () => {
  const current = service(approvedState({
    product: { stock: 0, warningStock: 1, stockStatus: "out_of_stock", isActive: false },
    inventory_logs: [],
    stock_alert_records: [{ _id: "alert-1", productId: "product-1", status: "active", stockStatus: "out_of_stock" }]
  }));
  current.db.snapshot();
  const stateBefore = current.db.snapshot();
  stateBefore.inventory_logs[0].beforeStock = 2;
  stateBefore.inventory_logs[0].afterStock = 0;
  // Recreate because snapshots are intentionally immutable copies.
  const corrected = service(stateBefore);
  await corrected.service.cancel({ actor: admin, orderId: "order-1" });
  const state = corrected.db.snapshot();
  assert.equal(state.products[0].stock, 2);
  assert.equal(state.products[0].stockStatus, "normal");
  assert.equal(state.products[0].isActive, false);
  assert.equal(state.stock_alert_records[0].status, "resolved");
});

test("outbox contains no stock quantity or PII and account marker is cleared", async () => {
  const current = service(approvedState());
  const result = await current.service.cancel({ actor: admin, orderId: "order-1" });
  const state = current.db.snapshot();
  const serialized = JSON.stringify(state.sync_events);
  assert.equal(serialized.includes("openid-admin-secret"), false);
  assert.equal(serialized.includes("user-openid"), false);
  assert.equal(Object.hasOwn(state.sync_events[0], "stock"), false);
  assert.equal(result.accountRecalculationRequired, true);
  assert.equal(state.orders[0].accountIncluded, false);
  assert.equal(state.orders[0].accountRecalculationPending, true);
});
