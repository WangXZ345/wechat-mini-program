const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BATCH_CONCURRENCY,
  BATCH_MAX_ITEMS,
  ProductStatusError,
  createProductStatusService,
  normalizeActor,
  normalizeInput,
  normalizeManyInput,
  activeOf,
  versionOf
} = require("../../common/services/productStatusService");
const sharedIdempotency = require("../../common/idempotency");
const { createDatabase, createIdempotency } = require("../../updateProductPrice/test/helpers");

function baseState(overrides = {}) {
  return {
    products: [{
      _id: "product-1",
      name: "测试商品",
      productIndex: "P000001",
      price: 6900,
      isActive: true,
      version: 3,
      updatedAt: new Date("2026-07-10T08:00:00.000Z")
    }],
    admin_operation_logs: [],
    sync_events: [],
    ...structuredClone(overrides)
  };
}

function actor(overrides = {}) {
  return {
    id: "admin-1",
    openid: "openid-1",
    role: "procurement",
    permissions: ["product:update_status"],
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
      isActive: false,
      expectedIsActive: true,
      expectedVersion: 3,
      reason: "运营下架"
    },
    idempotencyKey: "product-status-key-0001",
    requireExpectedVersion: true,
    ...overrides
  };
}

function batchCommand(overrides = {}) {
  return {
    actor: actor(),
    input: {
      isActive: true,
      items: [{ id: "product-1", expectedIsActive: false, expectedVersion: 3 }],
      reason: "批量恢复销售"
    },
    idempotencyKey: "product-status-batch-key-0001",
    requireExpectedVersion: true,
    ...overrides
  };
}

function service(state = baseState(), options = {}) {
  const db = createDatabase(state, options.database);
  return {
    db,
    service: createProductStatusService({
      db,
      idempotency: options.idempotency || createIdempotency(),
      now: () => new Date("2026-07-11T08:00:00.000Z"),
      randomId: () => "legacy-random-id"
    })
  };
}

function createIdempotencyDatabase() {
  const records = new Map();
  let collectionExists = false;
  return {
    async createCollection(name) {
      assert.equal(name, "idempotency_records");
      if (collectionExists) throw new Error("collection already exists: idempotency_records");
      collectionExists = true;
    },
    collection(name) {
      assert.equal(name, "idempotency_records");
      assert.equal(collectionExists, true);
      return {
        async add({ data }) {
          if (records.has(data._id)) throw new Error("document exists");
          records.set(data._id, structuredClone(data));
          return { _id: data._id };
        },
        doc(id) {
          return {
            async get() {
              const record = records.get(id);
              return { data: record ? structuredClone(record) : null };
            },
            async set({ data }) {
              records.set(id, structuredClone(data));
            },
            async update({ data }) {
              const record = records.get(id);
              if (!record) throw new Error(`document not exist: ${id}`);
              records.set(id, { ...record, ...structuredClone(data) });
            }
          };
        }
      };
    },
    snapshot() {
      return Array.from(records.values()).map((record) => structuredClone(record));
    }
  };
}

function idempotencyOptions(db, payload) {
  return {
    db,
    actionType: "set_product_status_many",
    idempotencyKey: "product-status-batch-key-0001",
    operatorIdentity: "admin-1",
    operatorType: "admin",
    scope: "products",
    scopeId: "batch-enable",
    payload
  };
}

test("normalizes an active procurement actor and the strict explicit-state contract", () => {
  assert.deepEqual(normalizeActor(actor()), {
    id: "admin-1",
    openid: "openid-1",
    role: "procurement",
    permissions: ["product:update_status"],
    sourceClient: "admin_web"
  });
  assert.deepEqual(normalizeInput(command().input, true), command().input);
  for (const input of [
    { ...command().input, isActive: 0 },
    { ...command().input, expectedIsActive: "true" },
    { ...command().input, expectedVersion: "3" },
    { ...command().input, expectedVersion: -1 },
    { ...command().input, reason: 123 }
  ]) {
    assert.throws(() => normalizeInput(input, true), (error) => [
      "STATUS_INVALID",
      "EXPECTED_STATUS_INVALID",
      "EXPECTED_VERSION_INVALID",
      "REASON_INVALID"
    ].includes(error.code));
  }
  assert.throws(
    () => normalizeInput({ productId: "product-1", isActive: false, expectedVersion: 3 }, true),
    (error) => error.code === "EXPECTED_STATUS_REQUIRED"
  );
  assert.throws(
    () => normalizeInput({ productId: "product-1", isActive: false, expectedIsActive: true }, true),
    (error) => error.code === "EXPECTED_VERSION_REQUIRED"
  );
});

test("normalizes, deduplicates and bounds strict batch-enable items", () => {
  const normalized = normalizeManyInput({
    isActive: true,
    items: [
      { id: "product-1", expectedIsActive: false, expectedVersion: 3 },
      { id: "product-1", expectedIsActive: false, expectedVersion: 3 }
    ],
    reason: "批量恢复销售"
  }, true);
  assert.deepEqual(normalized, {
    isActive: true,
    items: [{ id: "product-1", expectedIsActive: false, expectedVersion: 3 }],
    reason: "批量恢复销售"
  });
  assert.equal(BATCH_MAX_ITEMS, 100);
  assert.equal(BATCH_CONCURRENCY, 5);
  assert.throws(
    () => normalizeManyInput({
      isActive: true,
      items: Array.from({ length: 101 }, () => ({
        id: "product-1",
        expectedIsActive: false,
        expectedVersion: 3
      }))
    }, true),
    (error) => error.code === "BATCH_LIMIT_EXCEEDED"
  );
  assert.throws(
    () => normalizeManyInput({
      isActive: true,
      items: [
        { id: "product-1", expectedIsActive: false, expectedVersion: 3 },
        { id: "product-1", expectedIsActive: true, expectedVersion: 3 }
      ]
    }, true),
    (error) => error.code === "BATCH_ITEM_CONFLICT"
  );
  for (const input of [
    { isActive: false, items: [{ id: "product-1", expectedIsActive: false, expectedVersion: 3 }] },
    { isActive: true, items: [] },
    { isActive: true, items: [{ id: "product-1", expectedIsActive: false }] },
    {
      isActive: true,
      items: Array.from({ length: 101 }, (_, index) => ({
        id: `product-${index}`,
        expectedIsActive: false,
        expectedVersion: 1
      }))
    }
  ]) {
    assert.throws(
      () => normalizeManyInput(input, true),
      (error) => [
        "STATUS_INVALID",
        "BATCH_ITEMS_REQUIRED",
        "EXPECTED_VERSION_REQUIRED",
        "BATCH_LIMIT_EXCEEDED"
      ].includes(error.code)
    );
  }
});

test("a conflicting payload does not poison a successful idempotency replay", async () => {
  const db = createIdempotencyDatabase();
  const originalPayload = batchCommand().input;
  const originalOptions = idempotencyOptions(db, originalPayload);
  let executions = 0;

  const first = await sharedIdempotency.runIdempotentAction(originalOptions, async () => {
    executions += 1;
    return { changedCount: 1, unchangedCount: 0, failedCount: 0, failures: [] };
  });
  const beforeConflict = db.snapshot();
  const conflict = await sharedIdempotency.runIdempotentAction({
    ...originalOptions,
    payload: { ...originalPayload, reason: "另一个批量原因" }
  }, async () => {
    assert.fail("conflicting payload must not execute");
  });
  const replay = await sharedIdempotency.runIdempotentAction(originalOptions, async () => {
    executions += 1;
    assert.fail("successful original payload must replay without executing");
  });

  assert.equal(first.ok, true);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "IDEMPOTENCY_KEY_CONFLICT");
  assert.deepEqual(db.snapshot(), beforeConflict);
  assert.equal(replay.ok, true);
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.changedCount, 1);
  assert.equal(executions, 1);
});

test("a conflicting payload does not block processing-result recovery", async () => {
  const db = createIdempotencyDatabase();
  const originalPayload = batchCommand().input;
  const originalOptions = idempotencyOptions(db, originalPayload);
  await sharedIdempotency.beginIdempotentAction(originalOptions);
  const processingState = db.snapshot();

  const conflict = await sharedIdempotency.runIdempotentAction({
    ...originalOptions,
    payload: { ...originalPayload, reason: "冲突请求" }
  }, async () => {
    assert.fail("conflicting payload must not execute");
  });
  assert.equal(conflict.code, "IDEMPOTENCY_KEY_CONFLICT");
  assert.deepEqual(db.snapshot(), processingState);

  let recoveries = 0;
  const recovered = await sharedIdempotency.runIdempotentAction({
    ...originalOptions,
    recoverProcessingResult: async () => {
      recoveries += 1;
      return { changedCount: 1, unchangedCount: 0, failedCount: 0, failures: [] };
    }
  }, async () => {
    assert.fail("committed processing result must recover without executing");
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.duplicate, true);
  assert.equal(recovered.data.changedCount, 1);
  assert.equal(recoveries, 1);
  assert.equal(db.snapshot()[0].status, "success");
});

test("batch-enable reports deduplicated partial success without leaking failure messages", async () => {
  const setup = service(baseState({
    products: [{ ...baseState().products[0], isActive: false }]
  }));
  const result = await setup.service.setManyStatuses(batchCommand({
    input: {
      isActive: true,
      items: [
        { id: "product-1", expectedIsActive: false, expectedVersion: 3 },
        { id: "product-1", expectedIsActive: false, expectedVersion: 3 },
        { id: "missing-product", expectedIsActive: false, expectedVersion: 0 }
      ],
      reason: "批量恢复销售"
    }
  }));
  const state = setup.db.snapshot();
  assert.equal(result.changedCount, 1);
  assert.equal(result.unchangedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(result.failures, [{ id: "missing-product", code: "PRODUCT_NOT_FOUND" }]);
  assert.deepEqual(Object.keys(result.failures[0]).sort(), ["code", "id"]);
  assert.equal(state.products[0].isActive, true);
  assert.equal(state.products[0].version, 4);
  assert.equal(state.admin_operation_logs.length, 1);
  assert.equal(state.sync_events.length, 1);
});

test("batch idempotency replays the whole summary and conflicts on another payload", async () => {
  const setup = service(baseState({
    products: [{ ...baseState().products[0], isActive: false }]
  }));
  const first = await setup.service.setManyStatuses(batchCommand());
  const replay = await setup.service.setManyStatuses(batchCommand());
  assert.equal(first.changedCount, 1);
  assert.equal(first.duplicate, false);
  assert.equal(replay.changedCount, 1);
  assert.equal(replay.duplicate, true);
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 1);
  await assert.rejects(
    setup.service.setManyStatuses(batchCommand({
      input: { ...batchCommand().input, reason: "另一个批量原因" }
    })),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409
  );
});

function processingBatchIdempotency() {
  const childIdempotency = createIdempotency();
  let batchCalls = 0;
  return {
    ...childIdempotency,
    async runIdempotentAction(config, executor) {
      if (config.actionType !== "set_product_status_many") {
        return childIdempotency.runIdempotentAction(config, executor);
      }
      batchCalls += 1;
      if (batchCalls === 1) {
        await executor();
        return {
          ok: false,
          code: "IDEMPOTENCY_PROCESSING",
          message: "操作正在处理中",
          data: { duplicate: true, idempotencyStatus: "processing" }
        };
      }
      const recovered = await config.recoverProcessingResult();
      return recovered
        ? { ok: true, data: { ...recovered, duplicate: true, idempotencyStatus: "success" } }
        : { ok: false, code: "IDEMPOTENCY_PROCESSING", message: "操作正在处理中" };
    }
  };
}

function pendingBatchIdempotency() {
  const childIdempotency = createIdempotency();
  return {
    ...childIdempotency,
    async runIdempotentAction(config, executor) {
      if (config.actionType !== "set_product_status_many") {
        return childIdempotency.runIdempotentAction(config, executor);
      }
      const recovered = await config.recoverProcessingResult();
      assert.equal(recovered, null);
      return { ok: false, code: "IDEMPOTENCY_PROCESSING", message: "操作正在处理中" };
    }
  };
}

test("processing batch recovery counts a committed child as originally changed", async () => {
  const setup = service(baseState({
    products: [{ ...baseState().products[0], isActive: false }]
  }), { idempotency: processingBatchIdempotency() });
  await assert.rejects(
    setup.service.setManyStatuses(batchCommand()),
    (error) => error.code === "IDEMPOTENCY_PROCESSING"
  );
  const recovered = await setup.service.setManyStatuses(batchCommand());
  assert.equal(recovered.changedCount, 1);
  assert.equal(recovered.unchangedCount, 0);
  assert.equal(recovered.duplicate, true);
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);
});

test("processing batch recovery recognizes an exact strict no-op without a write", async () => {
  const setup = service(baseState(), { idempotency: processingBatchIdempotency() });
  const noOpCommand = batchCommand({
    input: {
      isActive: true,
      items: [{ id: "product-1", expectedIsActive: true, expectedVersion: 3 }],
      reason: "批量恢复销售"
    }
  });
  await assert.rejects(
    setup.service.setManyStatuses(noOpCommand),
    (error) => error.code === "IDEMPOTENCY_PROCESSING"
  );
  const recovered = await setup.service.setManyStatuses(noOpCommand);
  assert.equal(recovered.changedCount, 0);
  assert.equal(recovered.unchangedCount, 1);
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 0);
  assert.equal(setup.db.snapshot().sync_events.length, 0);
});

test("processing batch recovery rebuilds changed and stable-failure partial results", async () => {
  const setup = service(baseState({
    products: [{ ...baseState().products[0], isActive: false }]
  }), { idempotency: processingBatchIdempotency() });
  const partialCommand = batchCommand({
    input: {
      isActive: true,
      items: [
        { id: "product-1", expectedIsActive: false, expectedVersion: 3 },
        { id: "missing-product", expectedIsActive: false, expectedVersion: 0 }
      ],
      reason: "批量恢复销售"
    }
  });
  await assert.rejects(
    setup.service.setManyStatuses(partialCommand),
    (error) => error.code === "IDEMPOTENCY_PROCESSING"
  );
  const recovered = await setup.service.setManyStatuses(partialCommand);
  assert.equal(recovered.changedCount, 1);
  assert.equal(recovered.unchangedCount, 0);
  assert.equal(recovered.failedCount, 1);
  assert.deepEqual(recovered.failures, [{ id: "missing-product", code: "PRODUCT_NOT_FOUND" }]);
  assert.deepEqual(Object.keys(recovered.failures[0]).sort(), ["code", "id"]);
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);
});

test("processing recovery does not guess that an untouched inactive snapshot completed", async () => {
  const setup = service(baseState({
    products: [{ ...baseState().products[0], isActive: false }]
  }), { idempotency: pendingBatchIdempotency() });
  await assert.rejects(
    setup.service.setManyStatuses(batchCommand()),
    (error) => error.code === "IDEMPOTENCY_PROCESSING"
  );
  assert.equal(setup.db.snapshot().products[0].isActive, false);
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 0);
  assert.equal(setup.db.snapshot().sync_events.length, 0);
});

test("unknown child infrastructure failures reject the outer batch for a safe retry", async () => {
  const setup = service(baseState({
    products: [{ ...baseState().products[0], isActive: false }]
  }), { database: { failAddCollection: "sync_events" } });
  const initial = setup.db.snapshot();
  await assert.rejects(
    setup.service.setManyStatuses(batchCommand()),
    /simulated sync_events write failure/
  );
  assert.deepEqual(setup.db.snapshot(), initial);
});

test("a failed outer batch retries with the same key and reuses a completed child", async () => {
  const setup = service(baseState({
    products: [
      { ...baseState().products[0], _id: "product-1", isActive: false },
      { ...baseState().products[0], _id: "product-2", productIndex: "P000002", isActive: false }
    ]
  }));
  const originalRunTransaction = setup.db.runTransaction.bind(setup.db);
  let transactionCalls = 0;
  setup.db.runTransaction = async (callback) => {
    transactionCalls += 1;
    if (transactionCalls === 2) throw new Error("temporary database outage");
    return originalRunTransaction(callback);
  };
  const retryableCommand = batchCommand({
    input: {
      isActive: true,
      items: [
        { id: "product-1", expectedIsActive: false, expectedVersion: 3 },
        { id: "product-2", expectedIsActive: false, expectedVersion: 3 }
      ],
      reason: "批量恢复销售"
    }
  });
  await assert.rejects(
    setup.service.setManyStatuses(retryableCommand),
    /temporary database outage/
  );
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 1);

  const retried = await setup.service.setManyStatuses(retryableCommand);
  assert.equal(retried.changedCount, 2);
  assert.equal(retried.failedCount, 0);
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 2);
  assert.equal(setup.db.snapshot().sync_events.length, 2);
});

test("batch workers cap concurrent child transactions", async () => {
  const setup = service(baseState({ products: [] }));
  const originalRunTransaction = setup.db.runTransaction.bind(setup.db);
  let activeTransactions = 0;
  let maxActiveTransactions = 0;
  setup.db.runTransaction = async (callback) => {
    activeTransactions += 1;
    maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await originalRunTransaction(callback);
    } finally {
      activeTransactions -= 1;
    }
  };
  const result = await setup.service.setManyStatuses(batchCommand({
    input: {
      isActive: true,
      items: Array.from({ length: 12 }, (_, index) => ({
        id: `missing-${index}`,
        expectedIsActive: false,
        expectedVersion: 0
      })),
      reason: "批量恢复销售"
    }
  }));
  assert.equal(result.failedCount, 12);
  assert.ok(maxActiveTransactions > 1);
  assert.ok(maxActiveTransactions <= BATCH_CONCURRENCY);
});

test("legacy batch mode accepts product ids without snapshots or an outer key", async () => {
  const setup = service(baseState({
    products: [{ ...baseState().products[0], isActive: false }]
  }));
  const result = await setup.service.setManyStatuses({
    actor: actor({ sourceClient: "miniprogram" }),
    input: { isActive: true, items: [{ id: "product-1" }], reason: "后台批量上架" },
    requireExpectedVersion: false,
    allowMissingIdempotencyKey: true
  });
  assert.equal(result.changedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(setup.db.snapshot().admin_operation_logs[0].sourceClient, "miniprogram");
});

test("writes product, operation log and public sync event in one transaction", async () => {
  const setup = service();
  const result = await setup.service.setStatus(command());
  const state = setup.db.snapshot();

  assert.equal(result.productId, "product-1");
  assert.equal(result.beforeIsActive, true);
  assert.equal(result.isActive, false);
  assert.equal(result.version, 4);
  assert.equal(result.changed, true);
  assert.equal(result.duplicate, false);
  assert.equal(state.products[0].isActive, false);
  assert.equal(state.products[0].version, 4);
  assert.equal(Object.hasOwn(state.products[0], "statusUpdatedBy"), false);
  assert.equal(Object.hasOwn(state.products[0], "statusUpdatedAt"), false);
  assert.equal(state.admin_operation_logs.length, 1);
  assert.deepEqual(state.admin_operation_logs[0], {
    _id: state.admin_operation_logs[0]._id,
    businessKey: state.admin_operation_logs[0].businessKey,
    sourceId: "product-status-key-0001",
    idempotencyKey: "product-status-key-0001",
    action: "set_product_status",
    resourceType: "product",
    resourceId: "product-1",
    productId: "product-1",
    productIndex: "P000001",
    productName: "测试商品",
    beforeIsActive: true,
    afterIsActive: false,
    beforeData: { isActive: true, version: 3 },
    afterData: { isActive: false, version: 4 },
    operatorId: "admin-1",
    operatorOpenid: "openid-1",
    operatorRole: "procurement",
    sourceClient: "admin_web",
    reason: "运营下架",
    versionBefore: 3,
    versionAfter: 4,
    description: "商品已下架",
    publicSummary: "商品已下架",
    status: "success",
    createdAt: new Date("2026-07-11T08:00:00.000Z")
  });
  assert.equal(state.sync_events.length, 1);
  assert.equal(state.sync_events[0].eventType, "product.status_updated");
  assert.equal(state.sync_events[0].action, "deactivate");
  assert.equal(state.sync_events[0].entityType, "product");
  assert.equal(state.sync_events[0].entityId, "product-1");
  assert.equal(state.sync_events[0].version, 4);
  assert.deepEqual(state.sync_events[0].changedFields, ["isActive", "updatedAt", "version"]);
  assert.equal(state.sync_events[0].audience, "public");
  assert.equal(state.sync_events[0].isPublic, true);
  assert.equal(JSON.stringify(state.sync_events[0]).includes("openid-1"), false);
  assert.equal(JSON.stringify(state.sync_events[0]).includes("运营下架"), false);
});

test("explicit set also activates an inactive product and emits activate", async () => {
  const setup = service(baseState({
    products: [{ ...baseState().products[0], isActive: false, version: 7 }]
  }));
  const result = await setup.service.setStatus(command({
    input: {
      productId: "product-1",
      isActive: true,
      expectedIsActive: false,
      expectedVersion: 7,
      reason: "重新上架"
    },
    idempotencyKey: "product-status-activate-0001"
  }));
  const state = setup.db.snapshot();
  assert.equal(result.beforeIsActive, false);
  assert.equal(result.isActive, true);
  assert.equal(result.version, 8);
  assert.equal(state.products[0].isActive, true);
  assert.equal(state.admin_operation_logs[0].beforeIsActive, false);
  assert.equal(state.admin_operation_logs[0].afterIsActive, true);
  assert.equal(state.sync_events[0].action, "activate");
  assert.equal(state.sync_events[0].version, 8);
});

test("same key replays one change and rejects a different target state", async () => {
  const setup = service();
  const first = await setup.service.setStatus(command());
  const repeated = await setup.service.setStatus(command());
  assert.equal(first.duplicate, false);
  assert.equal(repeated.duplicate, true);
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);
  await assert.rejects(
    setup.service.setStatus(command({ input: { ...command().input, isActive: true } })),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409
  );
});

test("business-log recovery returns the committed result without a second write", async () => {
  const alwaysExecute = createIdempotency({ alwaysExecute: true });
  const setup = service(baseState(), { idempotency: alwaysExecute });
  await setup.service.setStatus(command());
  const replay = await setup.service.setStatus(command());
  assert.equal(replay.reused, true);
  assert.equal(replay.changed, false);
  assert.equal(replay.isActive, false);
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);
});

test("an immediate retry recovers a committed transaction still marked processing", async () => {
  const setup = service();
  await setup.service.setStatus(command());
  const baseIdempotency = createIdempotency();
  const retryService = createProductStatusService({
    db: setup.db,
    idempotency: {
      ...baseIdempotency,
      async runIdempotentAction(config) {
        const recovered = await config.recoverProcessingResult(
          { status: "processing" },
          { status: "processing" }
        );
        assert.ok(recovered);
        return { ok: true, data: { ...recovered, duplicate: true, idempotencyStatus: "success" } };
      }
    }
  });
  const recovered = await retryService.setStatus(command());
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.changed, false);
  assert.equal(recovered.isActive, false);
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);
});

test("expected state catches a legacy writer even when version did not move", async () => {
  const initial = baseState({ products: [{ ...baseState().products[0], isActive: false, version: 3 }] });
  const setup = service(initial);
  await assert.rejects(
    setup.service.setStatus(command()),
    (error) => error.code === "DATA_VERSION_CONFLICT"
      && error.statusCode === 409
      && error.details.currentIsActive === false
      && error.details.conflictFields.includes("isActive")
  );
  assert.deepEqual(setup.db.snapshot(), initial);
});

test("version conflict, no-op and failed outbox preserve their atomic boundaries", async () => {
  const conflict = service();
  const initial = conflict.db.snapshot();
  await assert.rejects(
    conflict.service.setStatus(command({ input: { ...command().input, expectedVersion: 2 } })),
    (error) => error.code === "DATA_VERSION_CONFLICT" && error.details.conflictFields.includes("version")
  );
  assert.deepEqual(conflict.db.snapshot(), initial);

  const unchanged = service(baseState({ products: [{ ...baseState().products[0], isActive: false }] }));
  const noOp = await unchanged.service.setStatus(command({
    input: { ...command().input, expectedIsActive: false }
  }));
  assert.equal(noOp.changed, false);
  assert.equal(noOp.version, 3);
  assert.equal(unchanged.db.snapshot().admin_operation_logs.length, 0);
  assert.equal(unchanged.db.snapshot().sync_events.length, 0);

  const failed = service(baseState(), { database: { failAddCollection: "sync_events" } });
  const failedInitial = failed.db.snapshot();
  await assert.rejects(failed.service.setStatus(command()), /simulated sync_events write failure/);
  assert.deepEqual(failed.db.snapshot(), failedInitial);
});

test("legacy mode supports missing key and optimistic-lock fields without using toggle semantics", async () => {
  const setup = service();
  const result = await setup.service.setStatus({
    actor: actor({ sourceClient: "miniprogram" }),
    input: { productId: "product-1", isActive: false, reason: "x".repeat(150) },
    requireExpectedVersion: false,
    allowMissingIdempotencyKey: true
  });
  const state = setup.db.snapshot();
  assert.equal(result.isActive, false);
  assert.equal(state.admin_operation_logs[0].idempotencyKey, "");
  assert.match(state.admin_operation_logs[0].sourceId, /^legacy_/);
  assert.equal(state.admin_operation_logs[0].sourceClient, "miniprogram");
  assert.equal(state.admin_operation_logs[0].reason.length, 120);
  assert.equal(state.admin_operation_logs[0].afterIsActive, false);
});

test("missing collections are created and corrupt or unauthorized data fails closed", async () => {
  const setup = service({ products: baseState().products });
  await setup.service.setStatus(command());
  assert.equal(setup.db.snapshot().admin_operation_logs.length, 1);
  assert.equal(setup.db.snapshot().sync_events.length, 1);

  assert.doesNotThrow(() => normalizeActor(actor({ role: "super_admin", permissions: [] })));
  for (const forbiddenActor of [
    actor({ role: "finance" }),
    actor({ role: "customer_service", permissions: ["product:update_status"] }),
    actor({ status: "disabled" }),
    actor({ isActive: false })
  ]) {
    assert.throws(() => normalizeActor(forbiddenActor), (error) => error.code === "FORBIDDEN");
  }
  assert.throws(() => activeOf({ isActive: "false" }), (error) => error.code === "DATA_STATUS_INVALID");
  assert.throws(() => versionOf({ version: "3" }), (error) => error.code === "DATA_VERSION_INVALID");
  for (const product of [
    { ...baseState().products[0], isActive: "false" },
    { ...baseState().products[0], version: -1 },
    { ...baseState().products[0], isDeleted: true }
  ]) {
    const invalid = service(baseState({ products: [product] }));
    await assert.rejects(
      invalid.service.setStatus(command()),
      (error) => error instanceof ProductStatusError
        && ["DATA_STATUS_INVALID", "DATA_VERSION_INVALID", "PRODUCT_NOT_FOUND"].includes(error.code)
    );
  }
});
