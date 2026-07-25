"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("./handler");
const {
  applyInventoryMutationInTransaction,
  validateInventoryReplay
} = require("./inventoryMutationService");
const approval = require("./orderApprovalService");
const stockAlert = require("./stockAlert");
const {
  ownerKeyFor,
  stableEventId
} = require("../common/syncEvents");

const TEST_SYNC_OWNER_PEPPER = "test-sync-owner-pepper-with-at-least-32-characters";

function clone(value) {
  return structuredClone(value);
}

function database(initial = {}, options = {}) {
  let state = clone({
    orders: [],
    order_items: [],
    products: [],
    customer_accounts: [],
    inventory_logs: [],
    account_logs: [],
    stock_alert_records: [],
    sync_events: [],
    admin_notifications: [],
    ...initial
  });
  let sequence = 0;

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }

  function collection(store, name) {
    if (!Array.isArray(store[name])) throw new Error(`collection not exists: ${name}`);
    const rows = store[name];
    const queryState = { where: {}, limit: Infinity };
    const query = {
      where(where) {
        queryState.where = where || {};
        return query;
      },
      limit(limit) {
        queryState.limit = limit;
        return query;
      },
      async get() {
        return {
          data: clone(rows.filter((row) => matches(row, queryState.where)).slice(0, queryState.limit))
        };
      },
      async add({ data }) {
        if (options.failOn && options.failOn({
          operation: "add",
          collection: name,
          data
        })) {
          throw new Error(`forced ${name}.add failure`);
        }
        const row = { _id: `${name}-${++sequence}`, ...clone(data) };
        rows.push(row);
        return { _id: row._id };
      },
      doc(id) {
        return {
          async get() {
            const row = rows.find((item) => item._id === id);
            return { data: row ? clone(row) : null };
          },
          async update({ data }) {
            if (options.failOn && options.failOn({
              operation: "update",
              collection: name,
              id,
              data
            })) {
              throw new Error(`forced ${name}.update failure`);
            }
            const row = rows.find((item) => item._id === id);
            if (!row) throw new Error(`document not exist: ${id}`);
            Object.assign(row, clone(data));
            return { stats: { updated: 1 } };
          }
        };
      }
    };
    return query;
  }

  const db = {
    serverDate: () => options.serverDateValue === undefined
      ? new Date("2026-07-23T08:00:00.000Z")
      : clone(options.serverDateValue),
    collection(name) {
      return collection(state, name);
    },
    async createCollection(name) {
      if (Array.isArray(state[name])) throw new Error("collection already exists");
      state[name] = [];
    },
    async runTransaction(callback) {
      const draft = clone(state);
      const result = await callback({
        collection: (name) => collection(draft, name)
      });
      state = draft;
      return result;
    },
    snapshot() {
      return clone(state);
    }
  };
  return db;
}

function handler(db, calls = [], options = {}) {
  return createHandler({
    db,
    cloud: {
      async callFunction(request) {
        calls.push(clone(request));
        if (typeof options.callFunction === "function") {
          return options.callFunction(request);
        }
        return { result: { ok: true } };
      }
    },
    stockAlert,
    applyInventoryMutationInTransaction,
    validateInventoryReplay,
    approval,
    ownerKeyFor: options.ownerKeyFor || ownerKeyFor,
    stableEventId,
    syncOwnerPepper: Object.hasOwn(options, "syncOwnerPepper")
      ? options.syncOwnerPepper
      : TEST_SYNC_OWNER_PEPPER,
    now: options.now || (() => new Date("2026-07-23T08:00:00.000Z"))
  });
}

function orderEvent(state) {
  return state.sync_events.find((event) => event.eventType === "order.status_changed");
}

function assertSafeOrderEvent(event, {
  orderId,
  status,
  version,
  action,
  changedFields,
  ownerSubject
}) {
  const businessKey = `auto_order_state:${orderId}:${status}:${version}`;
  assert.ok(event);
  assert.equal(event.eventId, stableEventId("auto_order_state", businessKey, 0));
  assert.equal(event.eventType, "order.status_changed");
  assert.equal(event.entityType, "order");
  assert.equal(event.entityId, orderId);
  assert.equal(event.action, action);
  assert.equal(event.version, version);
  assert.deepEqual(event.changedFields, changedFields);
  assert.equal(event.actorType, "system");
  assert.equal(event.actorRole, "system");
  assert.equal(event.sourceClient, "system");
  assert.equal(event.businessKey, businessKey);
  assert.equal(event.audience, "owner");
  assert.equal(event.ownerKey, ownerKeyFor(ownerSubject, TEST_SYNC_OWNER_PEPPER));
  assert.equal(event.ownerKey.includes(ownerSubject), false);
  assert.deepEqual(event.expiresAt, new Date("2026-07-30T08:00:00.000Z"));
}

function storedOrderEvent({
  orderId,
  status,
  version,
  ownerSubject,
  overrides = {}
}) {
  const businessKey = `auto_order_state:${orderId}:${status}:${version}`;
  const approved = status === "approved_pending_payment";
  return {
    _id: `sync-${orderId}-${version}`,
    eventId: stableEventId("auto_order_state", businessKey, 0),
    eventType: "order.status_changed",
    entityType: "order",
    entityId: orderId,
    action: approved ? "auto_approve" : "manual_review_required",
    version,
    changedFields: approved
      ? ["status", "paymentStatus", "updatedAt", "version"]
      : ["status", "updatedAt", "version"],
    actorType: "system",
    actorRole: "system",
    sourceClient: "system",
    businessKey,
    audience: "owner",
    ownerKey: ownerKeyFor(ownerSubject, TEST_SYNC_OWNER_PEPPER),
    createdAt: new Date("2026-07-23T08:00:00.000Z"),
    expiresAt: new Date("2026-07-30T08:00:00.000Z"),
    ...overrides
  };
}

function validInventoryLog({ orderId, productId, quantity, beforeStock = 5 } = {}) {
  return {
    _id: `inventory-${orderId}-${productId}`,
    businessKey: `order_deduct:${orderId}:${productId}`,
    sourceType: "order",
    sourceId: orderId,
    relatedOrderId: orderId,
    productId,
    beforeStock,
    afterStock: beforeStock - quantity,
    changeAmount: -quantity
  };
}

function validAccountLog(order, overrides = {}) {
  return {
    _id: `account-${order._id}`,
    businessKey: `order_debt:${order._id}`,
    sourceType: "order",
    sourceId: order._id,
    userId: order.userId || "",
    userOpenid: order.userOpenid || "",
    relatedOrderId: order._id,
    relatedPaymentRecordId: "",
    changeType: "order_approved",
    changeAmount: order.totalAmount,
    ...overrides
  };
}

test("risk orders move to pending_admin with a safe legacy-version increment and no business writes", async () => {
  const db = database({
    orders: [{
      _id: "o-risk",
      userId: "u-risk",
      userOpenid: "openid-risk",
      status: "auto_reviewing",
      riskLevelSnapshot: "risky",
      phone: "13800000000",
      address: "private-risk-address",
      paymentScreenshotUrl: "cloud://private-risk-proof",
      totalAmount: 500
    }],
    products: [{ _id: "p-risk", stock: 10, isActive: true }]
  });

  const result = await handler(db)({ orderId: "o-risk" });
  const state = db.snapshot();

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    skipped: true,
    status: "pending_admin",
    reason: "risk_customer"
  });
  assert.equal(state.orders[0].status, "pending_admin");
  assert.equal(state.orders[0].reviewType, "manual");
  assert.equal(state.orders[0].version, 1);
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.account_logs.length, 0);
  assert.equal(state.admin_notifications.length, 1);
  assert.equal(state.sync_events.length, 1);
  assertSafeOrderEvent(orderEvent(state), {
    orderId: "o-risk",
    status: "pending_admin",
    version: 1,
    action: "manual_review_required",
    changedFields: ["status", "updatedAt", "version"],
    ownerSubject: "openid-risk"
  });
  const serialized = JSON.stringify(orderEvent(state));
  for (const forbidden of [
    "13800000000",
    "private-risk-address",
    "cloud://private-risk-proof",
    "openid-risk",
    "riskLevelSnapshot",
    "beforeStock",
    "afterStock",
    "\"stock\""
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("cart stock checks aggregate duplicate products and route insufficiency to manual review before writes", async () => {
  const db = database({
    orders: [{
      _id: "o-short",
      userId: "u-short",
      userOpenid: "openid-short",
      status: "auto_reviewing",
      orderType: "cart",
      totalAmount: 900,
      version: 2
    }],
    order_items: [
      { _id: "i-short-1", orderId: "o-short", productId: "p-short", quantity: 2 },
      { _id: "i-short-2", orderId: "o-short", productId: "p-short", quantity: 3 }
    ],
    products: [{ _id: "p-short", stock: 4, isActive: true, version: 7 }]
  });

  const result = await handler(db)({ orderId: "o-short" });
  const state = db.snapshot();

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "pending_admin");
  assert.equal(state.orders[0].version, 3);
  assert.equal(state.products[0].stock, 4);
  assert.equal(state.products[0].version, 7);
  assert.deepEqual(state.order_items.map((item) => item.stockCheckStatus), ["insufficient", "insufficient"]);
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.account_logs.length, 0);
  assert.equal(state.customer_accounts.length, 0);
  assertSafeOrderEvent(orderEvent(state), {
    orderId: "o-short",
    status: "pending_admin",
    version: 3,
    action: "manual_review_required",
    changedFields: ["status", "updatedAt", "version"],
    ownerSubject: "openid-short"
  });
});

test("legacy single-item approval uses canonical inventory/account metadata and increments missing versions from zero", async () => {
  const calls = [];
  const db = database({
    orders: [{
      _id: "o-legacy",
      userId: "u-legacy",
      userOpenid: "openid-legacy",
      status: "auto_reviewing",
      productId: "p-legacy",
      quantity: 2,
      totalAmount: 1200
    }],
    products: [{
      _id: "p-legacy",
      name: "Legacy",
      stock: 5,
      totalSales: 4,
      warningStock: 3,
      stockStatus: "normal",
      isActive: true
    }]
  });

  const result = await handler(db, calls)({ orderId: "o-legacy" });
  const state = db.snapshot();
  const inventoryLog = state.inventory_logs[0];
  const accountLog = state.account_logs[0];

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "approved_pending_payment");
  assert.equal(state.orders[0].version, 1);
  assert.equal(state.orders[0].accountIncluded, true);
  assert.equal(state.orders[0].accountRecalculationPending, false);
  assert.ok(state.orders[0].accountRecalculatedAt instanceof Date);
  assert.equal(state.products[0].stock, 3);
  assert.equal(state.products[0].version, 1);
  assert.equal(state.products[0].totalSales, 6);
  assert.equal(state.stock_alert_records.length, 1);
  assert.deepEqual({
    businessKey: inventoryLog.businessKey,
    sourceType: inventoryLog.sourceType,
    sourceId: inventoryLog.sourceId,
    relatedOrderId: inventoryLog.relatedOrderId,
    reason: inventoryLog.reason,
    operatorId: inventoryLog.operatorId,
    operatorRole: inventoryLog.operatorRole,
    sourceClient: inventoryLog.sourceClient,
    versionBefore: inventoryLog.versionBefore,
    versionAfter: inventoryLog.versionAfter
  }, {
    businessKey: "order_deduct:o-legacy:p-legacy",
    sourceType: "order",
    sourceId: "o-legacy",
    relatedOrderId: "o-legacy",
    reason: "auto_order_approved",
    operatorId: "system",
    operatorRole: "system",
    sourceClient: "system",
    versionBefore: 0,
    versionAfter: 1
  });
  assert.deepEqual({
    businessKey: accountLog.businessKey,
    sourceType: accountLog.sourceType,
    sourceId: accountLog.sourceId,
    relatedOrderId: accountLog.relatedOrderId,
    changeAmount: accountLog.changeAmount,
    operatorId: accountLog.operatorId,
    operatorRole: accountLog.operatorRole
  }, {
    businessKey: "order_debt:o-legacy",
    sourceType: "order",
    sourceId: "o-legacy",
    relatedOrderId: "o-legacy",
    changeAmount: 1200,
    operatorId: "system",
    operatorRole: "system"
  });
  assert.equal(state.customer_accounts[0].totalOrderAmount, 1200);
  assert.equal(state.customer_accounts[0].unpaidAmount, 1200);
  assert.equal(state.sync_events.filter((event) => event.eventType === "inventory.stock_adjusted").length, 1);
  assertSafeOrderEvent(orderEvent(state), {
    orderId: "o-legacy",
    status: "approved_pending_payment",
    version: 1,
    action: "auto_approve",
    changedFields: ["status", "paymentStatus", "updatedAt", "version"],
    ownerSubject: "openid-legacy"
  });
  assert.deepEqual(calls, [{
    name: "recalculateCustomerAccount",
    data: { userId: "u-legacy", userOpenid: "openid-legacy" }
  }]);
});

test("cart approval aggregates duplicate products into one deduction and one debt", async () => {
  const db = database({
    orders: [{
      _id: "o-cart",
      userId: "u-cart",
      userOpenid: "openid-cart",
      status: "auto_reviewing",
      orderType: "cart",
      totalAmount: 2500,
      version: 4
    }],
    order_items: [
      { _id: "i-cart-1", orderId: "o-cart", productId: "p-cart", quantity: 2 },
      { _id: "i-cart-2", orderId: "o-cart", productId: "p-cart", quantity: 3 }
    ],
    products: [{
      _id: "p-cart",
      name: "Cart",
      stock: 10,
      totalSales: 1,
      warningStock: 2,
      stockStatus: "normal",
      isActive: true,
      version: 6
    }]
  });

  const result = await handler(db)({ orderId: "o-cart" });
  const state = db.snapshot();

  assert.equal(result.ok, true);
  assert.equal(state.products[0].stock, 5);
  assert.equal(state.products[0].totalSales, 6);
  assert.equal(state.inventory_logs.length, 1);
  assert.equal(state.inventory_logs[0].changeAmount, -5);
  assert.equal(state.inventory_logs[0].reason, "auto_cart_order_approved");
  assert.equal(state.account_logs.length, 1);
  assert.deepEqual(state.order_items.map((item) => item.stockCheckStatus), ["enough", "enough"]);
  assert.equal(state.orders[0].version, 5);
});

test("valid inventory and debt business-key replays approve without duplicate stock, sales, or account writes", async () => {
  const order = {
    _id: "o-replay",
    userId: "u-replay",
    userOpenid: "openid-replay",
    status: "auto_reviewing",
    productId: "p-replay",
    quantity: 2,
    totalAmount: 800,
    version: 3
  };
  const db = database({
    orders: [order],
    products: [{
      _id: "p-replay",
      stock: 0,
      totalSales: 7,
      warningStock: 1,
      stockStatus: "out_of_stock",
      isActive: false,
      version: 9
    }],
    customer_accounts: [{
      _id: "a-replay",
      userId: "u-replay",
      userOpenid: "openid-replay",
      totalOrderAmount: 800,
      totalReceivableAmount: 800,
      totalUnpaidAmount: 800,
      unpaidAmount: 800,
      orderCount: 1,
      unpaidOrderCount: 1
    }],
    inventory_logs: [validInventoryLog({
      orderId: "o-replay",
      productId: "p-replay",
      quantity: 2,
      beforeStock: 2
    })],
    account_logs: [validAccountLog(order)]
  });

  const result = await handler(db)({ orderId: "o-replay" });
  const state = db.snapshot();

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "approved_pending_payment");
  assert.equal(state.products[0].stock, 0);
  assert.equal(state.products[0].totalSales, 7);
  assert.equal(state.inventory_logs.length, 1);
  assert.equal(state.account_logs.length, 1);
  assert.equal(state.customer_accounts[0].totalOrderAmount, 800);
  assert.equal(state.orders[0].version, 4);
});

test("duplicate inventory business keys fail closed and roll back automatic approval", async () => {
  const order = {
    _id: "o-duplicate",
    userId: "u-duplicate",
    userOpenid: "openid-duplicate",
    status: "auto_reviewing",
    productId: "p-duplicate",
    quantity: 1,
    totalAmount: 300,
    version: 1
  };
  const replay = validInventoryLog({
    orderId: order._id,
    productId: order.productId,
    quantity: order.quantity,
    beforeStock: 2
  });
  const db = database({
    orders: [order],
    products: [{ _id: "p-duplicate", stock: 1, isActive: true, version: 2 }],
    inventory_logs: [replay, { ...replay, _id: "inventory-duplicate-2" }]
  });

  const result = await handler(db)({ orderId: order._id });
  const state = db.snapshot();

  assert.equal(result.ok, false);
  assert.match(result.message, /重复/);
  assert.equal(state.orders[0].status, "auto_reviewing");
  assert.equal(state.products[0].stock, 1);
  assert.equal(state.inventory_logs.length, 2);
  assert.equal(state.account_logs.length, 0);
});

test("non-auto-reviewing orders remain a zero-write skip", async () => {
  const calls = [];
  const db = database({
    orders: [{
      _id: "o-skip",
      userId: "u-skip",
      status: "pending_admin",
      productId: "p-skip",
      quantity: 1,
      totalAmount: 100,
      version: 5
    }],
    products: [{ _id: "p-skip", stock: 3, isActive: true, version: 2 }]
  });

  const result = await handler(db, calls)({ orderId: "o-skip" });
  const state = db.snapshot();

  assert.deepEqual(result, {
    ok: true,
    data: { skipped: true, status: "pending_admin" }
  });
  assert.equal(state.orders[0].version, 5);
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.account_logs.length, 0);
  assert.deepEqual(calls, []);
});

test("automatic approval accepts a non-Date ServerDate placeholder and derives todayDate from injected now", async () => {
  const serverDateValue = { __serverDate: true };
  const db = database({
    orders: [{
      _id: "o-server-date",
      userId: "u-server-date",
      userOpenid: "openid-server-date",
      status: "auto_reviewing",
      productId: "p-server-date",
      quantity: 1,
      totalAmount: 500,
      version: 1
    }],
    products: [{
      _id: "p-server-date",
      stock: 3,
      isActive: true,
      warningStock: 1,
      version: 1
    }]
  }, { serverDateValue });

  const result = await handler(db, [], {
    now: () => new Date("2026-07-24T08:00:00.000Z")
  })({ orderId: "o-server-date" });
  const state = db.snapshot();

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "approved_pending_payment");
  assert.equal(state.customer_accounts[0].todayDate, "2026-07-24");
  assert.deepEqual(state.customer_accounts[0].lastOrderAt, serverDateValue);
  assert.deepEqual(state.account_logs[0].createdAt, serverDateValue);
  assert.deepEqual(state.orders[0].approvedAt, serverDateValue);
});

test("automatic approval combines a valid replay with one new product deduction", async () => {
  const order = {
    _id: "o-partial-replay",
    userId: "u-partial-replay",
    userOpenid: "openid-partial-replay",
    status: "auto_reviewing",
    orderType: "cart",
    totalAmount: 1400,
    version: 2
  };
  const db = database({
    orders: [order],
    order_items: [
      { _id: "i-partial-replay-1", orderId: order._id, productId: "p-replayed", quantity: 2 },
      { _id: "i-partial-replay-2", orderId: order._id, productId: "p-new", quantity: 3 }
    ],
    products: [
      { _id: "p-replayed", stock: 0, totalSales: 8, isActive: false, warningStock: 1, version: 4 },
      { _id: "p-new", stock: 5, totalSales: 1, isActive: true, warningStock: 1, version: 2 }
    ],
    inventory_logs: [validInventoryLog({
      orderId: order._id,
      productId: "p-replayed",
      quantity: 2,
      beforeStock: 2
    })]
  });

  const result = await handler(db)({ orderId: order._id });
  const state = db.snapshot();

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "approved_pending_payment");
  assert.equal(state.products[0].stock, 0);
  assert.equal(state.products[0].totalSales, 8);
  assert.equal(state.products[1].stock, 2);
  assert.equal(state.products[1].totalSales, 4);
  assert.equal(state.inventory_logs.length, 2);
  assert.ok(state.inventory_logs.some((log) => log.businessKey === "order_deduct:o-partial-replay:p-new"));
  assert.equal(state.account_logs.length, 1);
  assert.equal(state.customer_accounts[0].totalOrderAmount, 1400);
});

test("sparse inventory evidence fails closed before automatic approval", async () => {
  const order = {
    _id: "o-sparse-inventory",
    userId: "u-sparse-inventory",
    userOpenid: "openid-sparse-inventory",
    status: "auto_reviewing",
    productId: "p-sparse-inventory",
    quantity: 1,
    totalAmount: 300,
    version: 1
  };
  const db = database({
    orders: [order],
    products: [{ _id: order.productId, stock: 2, totalSales: 4, isActive: true, version: 1 }],
    inventory_logs: [{
      _id: "inventory-sparse",
      businessKey: `order_deduct:${order._id}:${order.productId}`,
      productId: order.productId,
      beforeStock: 3,
      afterStock: 2,
      changeAmount: -1
    }]
  });

  const result = await handler(db)({ orderId: order._id });
  const state = db.snapshot();

  assert.equal(result.ok, false);
  assert.match(result.message, /流水|不一致/);
  assert.equal(state.orders[0].status, "auto_reviewing");
  assert.equal(state.products[0].stock, 2);
  assert.equal(state.products[0].totalSales, 4);
  assert.equal(state.inventory_logs.length, 1);
  assert.equal(state.account_logs.length, 0);
});

test("sparse legacy account evidence after inventory mutation rolls the entire automatic transaction back", async () => {
  const order = {
    _id: "o-sparse-account",
    userId: "u-sparse-account",
    userOpenid: "openid-sparse-account",
    status: "auto_reviewing",
    productId: "p-sparse-account",
    quantity: 2,
    totalAmount: 700,
    version: 1
  };
  const db = database({
    orders: [order],
    products: [{
      _id: order.productId,
      stock: 5,
      totalSales: 3,
      isActive: true,
      warningStock: 1,
      version: 1
    }],
    customer_accounts: [{
      _id: "a-sparse-account",
      userId: order.userId,
      totalOrderAmount: 100,
      totalUnpaidAmount: 100,
      orderCount: 1,
      unpaidOrderCount: 1
    }],
    account_logs: [{
      _id: "l-sparse-account",
      relatedOrderId: order._id,
      changeType: "order_approved",
      changeAmount: order.totalAmount
    }]
  });

  const result = await handler(db)({ orderId: order._id });
  const state = db.snapshot();

  assert.equal(result.ok, false);
  assert.match(result.message, /历史账款流水/);
  assert.equal(state.orders[0].status, "auto_reviewing");
  assert.equal(state.products[0].stock, 5);
  assert.equal(state.products[0].totalSales, 3);
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.customer_accounts[0].totalOrderAmount, 100);
  assert.equal(state.account_logs.length, 1);
});

test("mixed canonical and sparse account evidence rolls back inventory and the whole automatic approval", async () => {
  const order = {
    _id: "o-mixed-account",
    userId: "u-mixed-account",
    userOpenid: "openid-mixed-account",
    status: "auto_reviewing",
    accountIncluded: true,
    productId: "p-mixed-account",
    quantity: 2,
    totalAmount: 800,
    version: 1
  };
  const db = database({
    orders: [order],
    products: [{
      _id: order.productId,
      stock: 5,
      totalSales: 3,
      isActive: true,
      warningStock: 1,
      version: 1
    }],
    customer_accounts: [{
      _id: "a-mixed-account",
      userId: order.userId,
      totalOrderAmount: 800,
      totalUnpaidAmount: 800,
      orderCount: 1,
      unpaidOrderCount: 1
    }],
    account_logs: [{
      _id: "l-mixed-account-canonical",
      businessKey: `order_debt:${order._id}`,
      sourceType: "order",
      sourceId: order._id,
      userId: order.userId,
      userOpenid: "",
      relatedOrderId: order._id,
      relatedPaymentRecordId: "",
      changeType: "order_approved",
      changeAmount: order.totalAmount
    }, {
      _id: "l-mixed-account-sparse",
      relatedOrderId: order._id,
      changeType: "order_approved",
      changeAmount: order.totalAmount
    }]
  });

  const result = await handler(db)({ orderId: order._id });
  const state = db.snapshot();

  assert.equal(result.ok, false);
  assert.match(result.message, /重复|冲突/);
  assert.equal(state.orders[0].status, "auto_reviewing");
  assert.equal(state.orders[0].version, 1);
  assert.equal(state.products[0].stock, 5);
  assert.equal(state.products[0].totalSales, 3);
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.customer_accounts[0].totalOrderAmount, 800);
  assert.equal(state.account_logs.length, 2);
});

test("automatic approval keeps success and a pending marker for all recalculation failure shapes", async () => {
  const failures = [
    async () => { throw new Error("private recalculation exception"); },
    async () => ({ ok: false, message: "private direct failure" }),
    async () => ({ result: { ok: false, message: "private nested failure" } })
  ];

  for (let index = 0; index < failures.length; index += 1) {
    const orderId = `o-recalc-failure-${index}`;
    const productId = `p-recalc-failure-${index}`;
    const db = database({
      orders: [{
        _id: orderId,
        userId: `u-recalc-failure-${index}`,
        userOpenid: `openid-recalc-failure-${index}`,
        status: "auto_reviewing",
        productId,
        quantity: 1,
        totalAmount: 400,
        version: 1
      }],
      products: [{
        _id: productId,
        stock: 3,
        isActive: true,
        warningStock: 1,
        version: 1
      }]
    });

    const result = await handler(db, [], {
      callFunction: failures[index]
    })({ orderId });
    const state = db.snapshot();

    assert.equal(result.ok, true);
    assert.equal(result.data.status, "approved_pending_payment");
    assert.equal(result.data.accountRecalculationPending, true);
    assert.equal(result.data.warning, "订单已审核，客户账款汇总将在稍后更新");
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(state.orders[0].status, "approved_pending_payment");
    assert.equal(state.orders[0].accountRecalculationPending, true);
    assert.equal(state.products[0].stock, 2);
    assert.equal(state.inventory_logs.length, 1);
    assert.equal(state.account_logs.length, 1);
  }
});

test("automatic approval leaves the pending marker when clearing it after recalculation fails", async () => {
  const db = database({
    orders: [{
      _id: "o-recalc-clear",
      userId: "u-recalc-clear",
      userOpenid: "openid-recalc-clear",
      status: "auto_reviewing",
      productId: "p-recalc-clear",
      quantity: 1,
      totalAmount: 400,
      version: 1
    }],
    products: [{
      _id: "p-recalc-clear",
      stock: 3,
      isActive: true,
      warningStock: 1,
      version: 1
    }]
  }, {
    failOn: ({ operation, collection, data }) => operation === "update"
      && collection === "orders"
      && data.accountRecalculationPending === false
  });

  const result = await handler(db)({ orderId: "o-recalc-clear" });
  const state = db.snapshot();

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "approved_pending_payment");
  assert.equal(result.data.accountRecalculationPending, true);
  assert.equal(result.data.warning, "订单已审核，客户账款汇总将在稍后更新");
  assert.equal(state.orders[0].status, "approved_pending_payment");
  assert.equal(state.orders[0].accountRecalculationPending, true);
  assert.equal(state.products[0].stock, 2);
  assert.equal(state.inventory_logs.length, 1);
  assert.equal(state.account_logs.length, 1);
});

test("repeated invocation reuses the deterministic order event without duplicating it", async () => {
  const db = database({
    orders: [{
      _id: "o-repeat",
      userId: "u-repeat",
      userOpenid: "openid-repeat",
      status: "auto_reviewing",
      riskLevelSnapshot: "risk",
      totalAmount: 300,
      version: 4
    }]
  });
  const subject = handler(db);

  const first = await subject({ orderId: "o-repeat" });
  const firstEvent = orderEvent(db.snapshot());
  const second = await subject({ orderId: "o-repeat" });
  const state = db.snapshot();

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.data.status, "pending_admin");
  assert.equal(state.sync_events.filter((event) => event.eventType === "order.status_changed").length, 1);
  assert.equal(orderEvent(state).eventId, firstEvent.eventId);
  assert.equal(
    firstEvent.eventId,
    stableEventId(
      "auto_order_state",
      "auto_order_state:o-repeat:pending_admin:5",
      0
    )
  );
});

test("an event written with a one-millisecond server clock offset remains an exact reusable retry", async () => {
  const initialOrder = {
    _id: "o-clock-offset-retry",
    userId: "u-clock-offset-retry",
    userOpenid: "openid-clock-offset-retry",
    status: "auto_reviewing",
    riskLevelSnapshot: "risk",
    totalAmount: 300,
    version: 4
  };
  const timeOptions = {
    serverDateValue: new Date("2026-07-23T07:59:59.999Z")
  };
  const handlerOptions = {
    now: () => new Date("2026-07-23T08:00:00.000Z")
  };
  const firstDb = database({ orders: [initialOrder] }, timeOptions);

  const first = await handler(firstDb, [], handlerOptions)({ orderId: initialOrder._id });
  const firstEvent = orderEvent(firstDb.snapshot());
  const retryDb = database({
    orders: [initialOrder],
    sync_events: [firstEvent]
  }, timeOptions);
  const retry = await handler(retryDb, [], handlerOptions)({ orderId: initialOrder._id });
  const retryState = retryDb.snapshot();

  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.data.status, "pending_admin");
  assert.equal(retryState.orders[0].status, "pending_admin");
  assert.equal(retryState.orders[0].version, 5);
  assert.equal(retryState.sync_events.length, 1);
  assert.equal(retryState.sync_events[0].eventId, firstEvent.eventId);
  assert.equal(firstEvent.expiresAt.getTime() - firstEvent.createdAt.getTime(), 7 * 24 * 60 * 60 * 1000);
});

test("an exact pre-existing event for the same order status and version is reused", async () => {
  const existing = storedOrderEvent({
    orderId: "o-existing-event",
    status: "pending_admin",
    version: 5,
    ownerSubject: "openid-existing-event"
  });
  const db = database({
    orders: [{
      _id: "o-existing-event",
      userId: "u-existing-event",
      userOpenid: "openid-existing-event",
      status: "auto_reviewing",
      riskLevelSnapshot: "risk",
      totalAmount: 300,
      version: 4
    }],
    sync_events: [existing]
  });

  const result = await handler(db)({ orderId: "o-existing-event" });
  const state = db.snapshot();

  assert.equal(result.ok, true);
  assert.equal(state.orders[0].status, "pending_admin");
  assert.equal(state.sync_events.length, 1);
  assert.deepEqual(state.sync_events[0], existing);
});

test("a conflicting pre-existing event id fails closed and rolls back the order transition", async () => {
  const existing = storedOrderEvent({
    orderId: "o-conflicting-event",
    status: "pending_admin",
    version: 3,
    ownerSubject: "openid-conflicting-event",
    overrides: { sourceClient: "admin_web", actorType: "admin" }
  });
  const db = database({
    orders: [{
      _id: "o-conflicting-event",
      userId: "u-conflicting-event",
      userOpenid: "openid-conflicting-event",
      status: "auto_reviewing",
      riskLevelSnapshot: "risk",
      totalAmount: 300,
      version: 2
    }],
    sync_events: [existing]
  });

  const result = await handler(db)({ orderId: "o-conflicting-event" });
  const state = db.snapshot();

  assert.equal(result.ok, false);
  assert.equal(result.message, "订单同步事件冲突，暂不能继续");
  assert.equal(state.orders[0].status, "auto_reviewing");
  assert.equal(state.orders[0].version, 2);
  assert.equal(state.admin_notifications.length, 0);
  assert.deepEqual(state.sync_events, [existing]);
});

for (const scenario of [{
  name: "a wrong seven-day TTL",
  mutate(event) {
    event.expiresAt = new Date(event.createdAt.getTime() + 6 * 24 * 60 * 60 * 1000);
  }
}, {
  name: "a missing createdAt",
  mutate(event) {
    delete event.createdAt;
  }
}, {
  name: "a missing expiresAt",
  mutate(event) {
    delete event.expiresAt;
  }
}, {
  name: "an extra private field",
  mutate(event) {
    event.phone = "13800000000";
  }
}]) {
  test(`a same-id event with ${scenario.name} fails closed and rolls back`, async () => {
    const suffix = scenario.name.replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
    const orderId = `o-unsafe-event-${suffix}`;
    const userOpenid = `openid-unsafe-event-${suffix}`;
    const existing = storedOrderEvent({
      orderId,
      status: "pending_admin",
      version: 3,
      ownerSubject: userOpenid
    });
    scenario.mutate(existing);
    const db = database({
      orders: [{
        _id: orderId,
        userId: `u-unsafe-event-${suffix}`,
        userOpenid,
        status: "auto_reviewing",
        riskLevelSnapshot: "risk",
        totalAmount: 300,
        version: 2
      }],
      sync_events: [existing]
    });

    const result = await handler(db)({ orderId });
    const state = db.snapshot();

    assert.equal(result.ok, false);
    assert.equal(result.message, "订单同步事件冲突，暂不能继续");
    assert.equal(state.orders[0].status, "auto_reviewing");
    assert.equal(state.orders[0].version, 2);
    assert.equal(state.admin_notifications.length, 0);
    assert.deepEqual(state.sync_events, [existing]);
  });
}

test("the same order status and version has one stable id while another status cannot collide", async () => {
  async function eventFor(order, product) {
    const db = database({
      orders: [order],
      products: product ? [product] : []
    });
    const result = await handler(db)({ orderId: order._id });
    assert.equal(result.ok, true);
    return orderEvent(db.snapshot());
  }

  const riskOrder = {
    _id: "o-event-id",
    userId: "u-event-id",
    userOpenid: "openid-event-id",
    status: "auto_reviewing",
    riskLevelSnapshot: "risk",
    totalAmount: 200
  };
  const first = await eventFor(riskOrder);
  const retry = await eventFor(riskOrder);
  const approved = await eventFor({
    ...riskOrder,
    riskLevelSnapshot: "normal",
    productId: "p-event-id",
    quantity: 1
  }, {
    _id: "p-event-id",
    stock: 2,
    isActive: true,
    warningStock: 0
  });

  assert.equal(first.eventId, retry.eventId);
  assert.notEqual(first.eventId, approved.eventId);
  assert.equal(first.version, approved.version);
  assert.notEqual(first.action, approved.action);
});

test("order-event write failure rolls back each automatic review outcome atomically", async () => {
  const cases = [{
    name: "risk",
    initial: {
      orders: [{
        _id: "o-rollback-risk",
        userId: "u-rollback-risk",
        userOpenid: "openid-rollback-risk",
        status: "auto_reviewing",
        riskLevelSnapshot: "risk",
        totalAmount: 200,
        version: 1
      }]
    },
    verify(state) {
      assert.equal(state.orders[0].status, "auto_reviewing");
      assert.equal(state.orders[0].version, 1);
      assert.equal(state.admin_notifications.length, 0);
    }
  }, {
    name: "inventory shortage",
    initial: {
      orders: [{
        _id: "o-rollback-shortage",
        userId: "u-rollback-shortage",
        userOpenid: "openid-rollback-shortage",
        status: "auto_reviewing",
        orderType: "cart",
        totalAmount: 500,
        version: 2
      }],
      order_items: [{
        _id: "i-rollback-shortage",
        orderId: "o-rollback-shortage",
        productId: "p-rollback-shortage",
        quantity: 2
      }],
      products: [{
        _id: "p-rollback-shortage",
        stock: 1,
        isActive: true,
        version: 3
      }]
    },
    verify(state) {
      assert.equal(state.orders[0].status, "auto_reviewing");
      assert.equal(state.orders[0].version, 2);
      assert.equal(state.order_items[0].stockCheckStatus, undefined);
      assert.equal(state.products[0].stock, 1);
    }
  }, {
    name: "approval",
    initial: {
      orders: [{
        _id: "o-rollback-approve",
        userId: "u-rollback-approve",
        userOpenid: "openid-rollback-approve",
        status: "auto_reviewing",
        productId: "p-rollback-approve",
        quantity: 1,
        totalAmount: 600,
        version: 3
      }],
      products: [{
        _id: "p-rollback-approve",
        stock: 3,
        totalSales: 4,
        isActive: true,
        warningStock: 1,
        version: 2
      }]
    },
    verify(state) {
      assert.equal(state.orders[0].status, "auto_reviewing");
      assert.equal(state.orders[0].version, 3);
      assert.equal(state.products[0].stock, 3);
      assert.equal(state.products[0].totalSales, 4);
      assert.equal(state.customer_accounts.length, 0);
      assert.equal(state.inventory_logs.length, 0);
      assert.equal(state.account_logs.length, 0);
    }
  }];

  for (const item of cases) {
    const db = database(item.initial, {
      failOn: ({ operation, collection, data }) => operation === "add"
        && collection === "sync_events"
        && data.eventType === "order.status_changed"
    });
    const result = await handler(db)({ orderId: item.initial.orders[0]._id });
    const state = db.snapshot();

    assert.equal(result.ok, false, item.name);
    assert.equal(result.message, "forced sync_events.add failure", item.name);
    assert.equal(state.sync_events.length, 0, item.name);
    item.verify(state);
  }
});

test("missing owner subject or invalid owner pepper fails closed without leaking identity", async () => {
  const cases = [{
    name: "missing owner subject",
    order: {
      _id: "o-owner-missing",
      status: "auto_reviewing",
      riskLevelSnapshot: "risk",
      totalAmount: 100,
      version: 1
    },
    options: {}
  }, {
    name: "internal userId without an OPENID owner subject",
    order: {
      _id: "o-owner-user-id-only",
      userId: "private-internal-user-id",
      status: "auto_reviewing",
      riskLevelSnapshot: "risk",
      totalAmount: 100,
      version: 1
    },
    options: {}
  }, {
    name: "short owner pepper",
    order: {
      _id: "o-pepper-short",
      userId: "private-user-pepper",
      userOpenid: "private-openid-pepper",
      status: "auto_reviewing",
      riskLevelSnapshot: "risk",
      totalAmount: 100,
      version: 1
    },
    options: { syncOwnerPepper: "too-short" }
  }];

  for (const item of cases) {
    const db = database({ orders: [item.order] });
    const result = await handler(db, [], item.options)({ orderId: item.order._id });
    const state = db.snapshot();

    assert.equal(result.ok, false, item.name);
    assert.equal(result.message, "订单同步安全配置不完整", item.name);
    assert.equal(JSON.stringify(result).includes("private-user-pepper"), false, item.name);
    assert.equal(JSON.stringify(result).includes("private-internal-user-id"), false, item.name);
    assert.equal(state.orders[0].status, "auto_reviewing", item.name);
    assert.equal(state.admin_notifications.length, 0, item.name);
    assert.equal(state.sync_events.length, 0, item.name);
  }
});
