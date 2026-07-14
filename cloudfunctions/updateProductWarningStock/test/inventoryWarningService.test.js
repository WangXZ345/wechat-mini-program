const assert = require("node:assert/strict");
const test = require("node:test");

const stockAlert = require("../stockAlert");
const {
  InventoryWarningError,
  createInventoryWarningService,
  normalizeActor,
  normalizeInput
} = require("../inventoryWarningService");
const {
  assertDomainStateUnchanged,
  baseState,
  createDatabase,
  createIdempotency
} = require("./helpers");

function procurementActor(overrides = {}) {
  return {
    id: "admin-1",
    openid: "trusted-openid",
    role: "procurement",
    status: "active",
    isActive: true,
    permissions: ["inventory:set_warning"],
    sourceClient: "admin_web",
    ...overrides
  };
}

function command(overrides = {}) {
  return {
    actor: procurementActor(),
    input: {
      productId: "product-1",
      warningThreshold: 6,
      expectedVersion: 3,
      expectedWarningThreshold: 2,
      reason: "补货线调整"
    },
    idempotencyKey: "warning-key-0001",
    requireExpectedVersion: true,
    ...overrides
  };
}

function serviceFor(db, idempotency = createIdempotency(), stockAlertHelper = stockAlert) {
  return createInventoryWarningService({
    db,
    stockAlert: stockAlertHelper,
    idempotency,
    now: () => new Date("2026-07-11T08:00:00.000Z"),
    randomId: () => "fixed-random-id"
  });
}

test("canonical input accepts only explicit safe integer Web values", () => {
  const valid = normalizeInput({
    productId: "product-1",
    warningThreshold: 0,
    expectedVersion: 0,
    expectedWarningThreshold: 0
  });
  assert.equal(valid.warningThreshold, 0);
  assert.equal(valid.expectedVersion, 0);
  assert.equal(valid.expectedWarningThreshold, 0);

  for (const value of [undefined, null, "", "12", false, 1.5, -1, 100000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => normalizeInput({
        productId: "product-1",
        warningThreshold: value,
        expectedVersion: 0,
        expectedWarningThreshold: 0
      }),
      (error) => error.code === "WARNING_THRESHOLD_INVALID",
      String(value)
    );
  }
  assert.throws(
    () => normalizeInput({
      productId: "product-1",
      warningThreshold: 12,
      expectedVersion: "0",
      expectedWarningThreshold: 0
    }),
    (error) => error.code === "EXPECTED_VERSION_INVALID"
  );
  assert.throws(
    () => normalizeInput({ productId: "product-1", warningThreshold: 12 }),
    (error) => error.code === "EXPECTED_VERSION_REQUIRED"
  );
  assert.throws(
    () => normalizeInput({ productId: "product-1", warningThreshold: 12, expectedVersion: 0 }),
    (error) => error.code === "EXPECTED_WARNING_THRESHOLD_REQUIRED"
  );
  assert.throws(
    () => normalizeInput({
      productId: "product-1",
      warningThreshold: 12,
      expectedVersion: 0,
      expectedWarningThreshold: "0"
    }),
    (error) => error.code === "EXPECTED_WARNING_THRESHOLD_INVALID"
  );
  assert.throws(
    () => normalizeInput({
      productId: 123,
      warningThreshold: 12,
      expectedVersion: 0,
      expectedWarningThreshold: 0
    }),
    (error) => error.code === "PRODUCT_ID_REQUIRED"
  );
  assert.throws(
    () => normalizeInput({
      productId: "product-1",
      warningThreshold: 12,
      expectedVersion: 0,
      expectedWarningThreshold: 0,
      reason: {}
    }),
    (error) => error.code === "REASON_INVALID"
  );
});

test("only active procurement and super_admin actors pass the service boundary", () => {
  assert.equal(normalizeActor(procurementActor()).role, "procurement");
  assert.equal(normalizeActor(procurementActor({ role: "super_admin", permissions: [] })).role, "super_admin");

  for (const actor of [
    procurementActor({ role: "finance", permissions: ["inventory:set_warning"] }),
    procurementActor({ role: "customer_service", permissions: ["inventory:set_warning"] }),
    procurementActor({ role: "ordinary_user", permissions: ["inventory:set_warning"] }),
    procurementActor({ status: "disabled" }),
    procurementActor({ isActive: false }),
    procurementActor({ permissions: [] })
  ]) {
    assert.throws(() => normalizeActor(actor), (error) => error.code === "FORBIDDEN");
  }
});

test("successful write increments version and atomically records alert, inventory log and minimal outbox event", async () => {
  const db = createDatabase(baseState());
  const result = await serviceFor(db).setWarningStock(command());
  const state = db.snapshot();
  const product = state.products[0];
  const inventoryLog = state.inventory_logs[0];
  const event = state.sync_events[0];

  assert.equal(result.productId, "product-1");
  assert.equal(result.warningStock, 6);
  assert.equal(result.stockStatus, "warning");
  assert.equal(result.version, 4);
  assert.equal(product.warningStock, 6);
  assert.equal(product.version, 4);
  assert.equal(product.stock, 5);
  assert.equal(typeof product.stock, "number");
  assert.equal(Object.hasOwn(product, "warningStockUpdatedBy"), false);
  assert.equal(state.stock_alert_records.length, 1);
  assert.equal(state.stock_alert_records[0].stock, 5);
  assert.equal(state.inventory_logs.length, 1);
  assert.equal(inventoryLog.operatorId, "admin-1");
  assert.equal(inventoryLog.operatorOpenid, "trusted-openid");
  assert.equal(inventoryLog.operatorRole, "procurement");
  assert.equal(inventoryLog.sourceClient, "admin_web");
  assert.equal(inventoryLog.warningStockBefore, 2);
  assert.equal(inventoryLog.warningStock, 6);
  assert.equal(inventoryLog.beforeStock, 5);
  assert.equal(inventoryLog.afterStock, 5);
  assert.equal(inventoryLog.changeAmount, 0);
  assert.equal(inventoryLog.versionBefore, 3);
  assert.equal(inventoryLog.versionAfter, 4);
  assert.equal(state.sync_events.length, 1);
  assert.deepEqual(event.changedFields, ["warningStock", "stockStatus", "updatedAt", "version"]);
  assert.deepEqual(event.audienceRoles, ["procurement", "super_admin"]);
  assert.equal(event.sourceClient, "admin_web");
  assert.equal(Object.hasOwn(event, "stock"), false);
  assert.equal(Object.hasOwn(event, "warningStock"), false);
  assert.equal(Object.hasOwn(event, "beforeStock"), false);
  assert.equal(Object.hasOwn(event, "afterStock"), false);
  assert.equal(Object.hasOwn(event, "operatorOpenid"), false);
  assert.equal(Object.hasOwn(event, "openid"), false);
});

test("invalid persisted stock fails closed without normalizing stock or emitting inventory data", async () => {
  const product = { ...baseState().products[0], stock: "5" };
  const initial = baseState({ products: [product] });
  const db = createDatabase(initial);

  await assert.rejects(
    serviceFor(db).setWarningStock(command()),
    (error) => error instanceof InventoryWarningError
      && error.code === "DATA_STOCK_INVALID"
      && error.statusCode === 409
  );

  const state = db.snapshot();
  assertDomainStateUnchanged(state, initial);
  assert.equal(state.products[0].stock, "5");
  assert.equal(state.inventory_logs.length, 0);
  assert.equal(state.stock_alert_records.length, 0);
  assert.equal(state.sync_events.length, 0);
});

test("warning-only update excludes stock returned by the shared status helper", async () => {
  const db = createDatabase(baseState());
  const sentinelStockAlert = {
    ...stockAlert,
    buildStockStatusUpdate(product, overrides) {
      return {
        ...stockAlert.buildStockStatusUpdate(product, overrides),
        stock: 0
      };
    }
  };

  await serviceFor(db, createIdempotency(), sentinelStockAlert).setWarningStock(command());

  const state = db.snapshot();
  assert.equal(state.products[0].stock, 5);
  assert.equal(state.stock_alert_records[0].stock, 5);
  assert.equal(state.inventory_logs[0].beforeStock, 5);
  assert.equal(state.inventory_logs[0].afterStock, 5);
  assert.equal(Object.hasOwn(state.sync_events[0], "stock"), false);
  assert.equal(Object.hasOwn(state.sync_events[0], "beforeStock"), false);
  assert.equal(Object.hasOwn(state.sync_events[0], "afterStock"), false);
});

test("version conflict leaves every domain collection unchanged", async () => {
  const initial = baseState();
  const db = createDatabase(initial);
  await assert.rejects(
    serviceFor(db).setWarningStock(command({
      input: {
        productId: "product-1",
        warningThreshold: 6,
        expectedVersion: 2,
        expectedWarningThreshold: 2,
        reason: "stale"
      }
    })),
    (error) => error instanceof InventoryWarningError && error.code === "DATA_VERSION_CONFLICT" && error.statusCode === 409
  );
  assertDomainStateUnchanged(db.snapshot(), initial);
});

test("corrupt stored version fails closed instead of being treated as legacy version zero", async () => {
  const initial = baseState({ products: [{ ...baseState().products[0], version: -1 }] });
  const db = createDatabase(initial);
  await assert.rejects(
    serviceFor(db).setWarningStock(command({
      input: {
        productId: "product-1",
        warningThreshold: 6,
        expectedVersion: 0,
        expectedWarningThreshold: 2,
        reason: "invalid stored version"
      }
    })),
    (error) => error.code === "DATA_VERSION_INVALID" && error.statusCode === 409
  );
  assertDomainStateUnchanged(db.snapshot(), initial);
});

test("sync event failure rolls back product, alert and inventory log", async () => {
  const initial = baseState();
  const db = createDatabase(initial, { failAddCollection: "sync_events" });
  await assert.rejects(
    serviceFor(db).setWarningStock(command()),
    /simulated sync_events write failure/
  );
  assertDomainStateUnchanged(db.snapshot(), initial);
});

test("missing outbox collection fails closed without creating or partially writing domain data", async () => {
  const initial = baseState({ sync_events: undefined });
  const db = createDatabase(initial);
  await assert.rejects(
    serviceFor(db).setWarningStock(command()),
    /collection not exists: sync_events/
  );
  assertDomainStateUnchanged(db.snapshot(), initial);
});

test("same idempotency key replays once while a changed payload conflicts", async () => {
  const db = createDatabase(baseState());
  const service = serviceFor(db);
  const first = await service.setWarningStock(command());
  const replay = await service.setWarningStock(command());

  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(db.snapshot().inventory_logs.length, 1);
  assert.equal(db.snapshot().sync_events.length, 1);

  await assert.rejects(
    service.setWarningStock(command({
      input: {
        productId: "product-1",
        warningThreshold: 7,
        expectedVersion: 3,
        expectedWarningThreshold: 2,
        reason: "different"
      }
    })),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409
  );
  assert.equal(db.snapshot().inventory_logs.length, 1);
});

test("business key converges a retry even if the idempotency wrapper executes again", async () => {
  const db = createDatabase(baseState());
  const service = serviceFor(db, createIdempotency({ alwaysExecute: true }));
  const first = await service.setWarningStock(command());
  const replay = await service.setWarningStock(command());

  assert.equal(first.reused, false);
  assert.equal(replay.reused, true);
  assert.equal(replay.changed, false);
  assert.equal(replay.version, 4);
  assert.equal(db.snapshot().inventory_logs.length, 1);
  assert.equal(db.snapshot().sync_events.length, 1);
});

test("legacy mode may omit expectedVersion but still increments the shared version", async () => {
  const db = createDatabase(baseState());
  const service = serviceFor(db);
  const result = await service.setWarningStock(command({
    input: { productId: "product-1", warningThreshold: 4, reason: "legacy" },
    idempotencyKey: "",
    requireExpectedVersion: false,
    allowMissingIdempotencyKey: true
  }));

  assert.equal(result.version, 4);
  assert.equal(db.snapshot().products[0].version, 4);
  assert.equal(db.snapshot().inventory_logs.length, 1);
  assert.equal(db.snapshot().sync_events.length, 1);
});

test("legacy auto-hide behavior remains intact without rewriting zero stock", async () => {
  const product = {
    ...baseState().products[0],
    stock: 0,
    stockStatus: "normal",
    autoHideWhenOutOfStock: false,
    isActive: true
  };
  const db = createDatabase(baseState({ products: [product] }));

  await serviceFor(db).setWarningStock(command({
    input: { productId: "product-1", warningThreshold: 4, reason: "legacy auto hide" },
    idempotencyKey: "",
    requireExpectedVersion: false,
    allowMissingIdempotencyKey: true,
    legacyAutoHideWhenOutOfStock: true
  }));

  const state = db.snapshot();
  assert.equal(state.products[0].stock, 0);
  assert.equal(state.products[0].stockStatus, "out_of_stock");
  assert.equal(state.products[0].autoHideWhenOutOfStock, true);
  assert.equal(state.products[0].isActive, false);
  assert.equal(state.inventory_logs[0].beforeStock, 0);
  assert.equal(state.inventory_logs[0].afterStock, 0);
});

test("unchanged version cannot hide a legacy batch warning overwrite", async () => {
  const product = { ...baseState().products[0], warningStock: 9, version: 3 };
  const initial = baseState({ products: [product] });
  const db = createDatabase(initial);

  await assert.rejects(
    serviceFor(db).setWarningStock(command()),
    (error) => error.code === "DATA_VERSION_CONFLICT"
      && error.statusCode === 409
      && error.details.currentVersion === 3
      && error.details.expectedWarningThreshold === 2
      && error.details.currentWarningThreshold === 9
      && error.details.conflictFields.includes("warningThreshold")
  );
  assertDomainStateUnchanged(db.snapshot(), initial);
});

test("missing stored warning threshold is compared using the BFF-compatible zero value", async () => {
  const product = { ...baseState().products[0], version: 0 };
  delete product.warningStock;
  const db = createDatabase(baseState({ products: [product] }));

  const result = await serviceFor(db).setWarningStock(command({
    input: {
      productId: "product-1",
      warningThreshold: 5,
      expectedVersion: 0,
      expectedWarningThreshold: 0,
      reason: "initialize legacy threshold"
    }
  }));

  assert.equal(result.warningStock, 5);
  assert.equal(result.version, 1);
  assert.equal(db.snapshot().inventory_logs[0].warningStockBefore, 0);
});

test("invalid persisted warning threshold fails closed without domain writes", async () => {
  const product = { ...baseState().products[0], warningStock: 100000 };
  const initial = baseState({ products: [product] });
  const db = createDatabase(initial);

  await assert.rejects(
    serviceFor(db).setWarningStock(command()),
    (error) => error.code === "DATA_WARNING_THRESHOLD_INVALID" && error.statusCode === 409
  );
  assertDomainStateUnchanged(db.snapshot(), initial);
});

test("strict Web mode cannot opt into legacy missing-key or auto-hide behavior", async () => {
  const initial = baseState();
  const db = createDatabase(initial);
  await assert.rejects(
    serviceFor(db).setWarningStock(command({
      idempotencyKey: "",
      allowMissingIdempotencyKey: true,
      legacyAutoHideWhenOutOfStock: true
    })),
    (error) => error.code === "IDEMPOTENCY_KEY_REQUIRED"
  );
  assertDomainStateUnchanged(db.snapshot(), initial);
});
