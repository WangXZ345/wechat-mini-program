const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ProductPriceError,
  createProductPriceService,
  normalizeActor,
  normalizeInput,
  priceOf,
  versionOf
} = require("../../common/services/productPriceService");
const { assertDomainStateUnchanged, baseState, createDatabase, createIdempotency } = require("./helpers");

function actor(overrides = {}) {
  return {
    id: "admin-1",
    openid: "openid-1",
    role: "procurement",
    permissions: ["product:update_price"],
    status: "active",
    isActive: true,
    sourceClient: "admin_web",
    ...overrides
  };
}

function command(overrides = {}) {
  return {
    actor: actor(),
    input: {
      productId: "product-1",
      newPriceCents: 7200,
      expectedPriceCents: 6900,
      expectedVersion: 3,
      reason: "季度调价"
    },
    idempotencyKey: "product-price-key-0001",
    requireExpectedVersion: true,
    ...overrides
  };
}

function service(state = baseState(), options = {}) {
  const db = createDatabase(state, options.database);
  return {
    db,
    service: createProductPriceService({
      db,
      idempotency: options.idempotency || createIdempotency(options.idempotencyOptions),
      now: () => new Date("2026-07-11T08:00:00.000Z"),
      randomId: () => "legacy-random-id"
    })
  };
}

test("normalizes actor and strict Web input without coercing integer cents", () => {
  assert.deepEqual(normalizeActor(actor()), {
    id: "admin-1",
    openid: "openid-1",
    role: "procurement",
    permissions: ["product:update_price"],
    sourceClient: "admin_web"
  });
  assert.deepEqual(normalizeInput(command().input, true), command().input);
  for (const value of ["7200", 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => normalizeInput({ ...command().input, newPriceCents: value }, true),
      (error) => error.code === "PRICE_INVALID"
    );
  }
  assert.throws(
    () => normalizeInput({ productId: "product-1", newPriceCents: 7200, expectedVersion: 3 }, true),
    (error) => error.code === "EXPECTED_PRICE_REQUIRED"
  );
  assert.throws(
    () => normalizeInput({ productId: "product-1", newPriceCents: 7200, expectedPriceCents: 6900 }, true),
    (error) => error.code === "EXPECTED_VERSION_REQUIRED"
  );
});

test("writes product, price log and public sync outbox atomically", async () => {
  const setup = service();
  const result = await setup.service.setPrice(command());
  const state = setup.db.snapshot();

  assert.equal(result.productId, "product-1");
  assert.equal(result.beforePrice, 6900);
  assert.equal(result.afterPrice, 7200);
  assert.equal(result.version, 4);
  assert.equal(result.changed, true);
  assert.equal(result.duplicate, false);
  assert.equal(state.products[0].price, 7200);
  assert.equal(state.products[0].version, 4);
  assert.equal(state.products[0].priceUpdatedBy, "openid-1");
  assert.equal(state.price_logs.length, 1);
  assert.deepEqual(state.price_logs[0], {
    _id: state.price_logs[0]._id,
    businessKey: state.price_logs[0].businessKey,
    sourceType: "manual",
    sourceId: "product-price-key-0001",
    idempotencyKey: "product-price-key-0001",
    productId: "product-1",
    productIndex: "P000001",
    productName: "测试商品",
    beforePrice: 6900,
    afterPrice: 7200,
    changeType: "set",
    changeValue: 7200,
    operatorId: "admin-1",
    operatorOpenid: "openid-1",
    operatorRole: "procurement",
    sourceClient: "admin_web",
    reason: "季度调价",
    versionBefore: 3,
    versionAfter: 4,
    createdAt: new Date("2026-07-11T08:00:00.000Z")
  });
  assert.equal(state.sync_events.length, 1);
  assert.equal(state.sync_events[0].eventType, "product.price_updated");
  assert.equal(state.sync_events[0].entityType, "product");
  assert.equal(state.sync_events[0].entityId, "product-1");
  assert.equal(state.sync_events[0].version, 4);
  assert.deepEqual(state.sync_events[0].changedFields, ["price", "updatedAt", "version"]);
  assert.equal(state.sync_events[0].audience, "public");
  assert.equal(state.sync_events[0].isPublic, true);
});

test("same idempotency key replays one committed change and conflicting payload is rejected", async () => {
  const setup = service();
  const first = await setup.service.setPrice(command());
  const repeated = await setup.service.setPrice(command());
  assert.equal(first.duplicate, false);
  assert.equal(repeated.duplicate, true);
  assert.equal(setup.db.snapshot().price_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);
  await assert.rejects(
    setup.service.setPrice(command({ input: { ...command().input, newPriceCents: 7300 } })),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409
  );
});

test("business log recovery is reported as reused without claiming a second write", async () => {
  const idempotency = createIdempotency({ alwaysExecute: true });
  const setup = service(baseState(), { idempotency });
  await setup.service.setPrice(command());
  const replay = await setup.service.setPrice(command());
  assert.equal(replay.reused, true);
  assert.equal(replay.changed, false);
  assert.equal(setup.db.snapshot().price_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);
});

test("an immediate retry recovers a committed transaction while idempotency is still processing", async () => {
  const setup = service();
  await setup.service.setPrice(command());
  const baseIdempotency = createIdempotency();
  const retryService = createProductPriceService({
    db: setup.db,
    idempotency: {
      ...baseIdempotency,
      async runIdempotentAction(config) {
        const recovered = await config.recoverProcessingResult(
          { status: "processing" },
          { status: "processing" }
        );
        assert.ok(recovered);
        return {
          ok: true,
          data: { ...recovered, duplicate: true, idempotencyStatus: "success" }
        };
      }
    }
  });

  const recovered = await retryService.setPrice(command());
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.changed, false);
  assert.equal(recovered.afterPrice, 7200);
  assert.equal(setup.db.snapshot().price_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);
});

test("expected price catches legacy writers even when version did not move", async () => {
  const initial = baseState({ products: [{ ...baseState().products[0], price: 7100, version: 3 }] });
  const setup = service(initial);
  await assert.rejects(
    setup.service.setPrice(command()),
    (error) => error.code === "DATA_VERSION_CONFLICT"
      && error.statusCode === 409
      && error.details.currentPriceCents === 7100
      && error.details.conflictFields.includes("price")
  );
  assertDomainStateUnchanged(setup.db.snapshot(), initial);
});

test("expected version conflict leaves every domain collection unchanged", async () => {
  const setup = service();
  const initial = setup.db.snapshot();
  await assert.rejects(
    setup.service.setPrice(command({ input: { ...command().input, expectedVersion: 2 } })),
    (error) => error.code === "DATA_VERSION_CONFLICT" && error.details.conflictFields.includes("version")
  );
  assertDomainStateUnchanged(setup.db.snapshot(), initial);
});

test("unchanged price does not increment version or emit logs", async () => {
  const setup = service();
  const result = await setup.service.setPrice(command({
    input: { ...command().input, newPriceCents: 6900 }
  }));
  assert.equal(result.changed, false);
  assert.equal(result.version, 3);
  assert.equal(setup.db.snapshot().price_logs.length, 0);
  assert.equal(setup.db.snapshot().sync_events.length, 0);
  assert.equal(setup.db.snapshot().products[0].version, 3);
});

test("legacy mode may omit idempotency and optimistic-lock fields", async () => {
  const setup = service();
  const result = await setup.service.setPrice({
    actor: actor({ sourceClient: "miniprogram" }),
    input: { productId: "product-1", newPriceCents: 7000, reason: "x".repeat(150) },
    requireExpectedVersion: false,
    allowMissingIdempotencyKey: true
  });
  const state = setup.db.snapshot();
  assert.equal(result.afterPrice, 7000);
  assert.equal(state.price_logs[0].idempotencyKey, "");
  assert.match(state.price_logs[0].sourceId, /^legacy_/);
  assert.equal(state.price_logs[0].sourceClient, "miniprogram");
  assert.equal(state.price_logs[0].reason.length, 120);
});

test("missing log collections are ensured before the transaction", async () => {
  const setup = service({ products: baseState().products });
  await setup.service.setPrice(command());
  assert.equal(setup.db.snapshot().price_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);
});

test("sync outbox failure rolls back the product and price log", async () => {
  const setup = service(baseState(), { database: { failAddCollection: "sync_events" } });
  const initial = setup.db.snapshot();
  await assert.rejects(setup.service.setPrice(command()), /simulated sync_events write failure/);
  assertDomainStateUnchanged(setup.db.snapshot(), initial);
});

test("corrupt data, deleted products and unauthorized actors fail closed", async () => {
  assert.throws(() => normalizeActor(actor({ role: "finance" })), (error) => error.code === "FORBIDDEN");
  assert.throws(() => priceOf({ price: "6900" }), (error) => error.code === "DATA_PRICE_INVALID");
  assert.throws(() => versionOf({ version: "3" }), (error) => error.code === "DATA_VERSION_INVALID");

  for (const product of [
    { ...baseState().products[0], price: "6900" },
    { ...baseState().products[0], version: -1 },
    { ...baseState().products[0], isDeleted: true }
  ]) {
    const setup = service(baseState({ products: [product] }));
    await assert.rejects(
      setup.service.setPrice(command()),
      (error) => error instanceof ProductPriceError && ["DATA_PRICE_INVALID", "DATA_VERSION_INVALID", "PRODUCT_NOT_FOUND"].includes(error.code)
    );
  }
});
