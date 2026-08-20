"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const {
  createRefundMutationService,
  RefundMutationError,
  REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES
} = require("./refundMutationService");
const sharedIdempotency = require("../idempotency");

const FIXED_DATE = new Date("2026-07-17T00:00:00.000Z");

function actor(role = "finance", overrides = {}) {
  return {
    id: `${role}-1`,
    openid: `${role}-openid`,
    role,
    status: "active",
    isActive: true,
    permissions: ["refund:create", "refund:process"],
    sourceClient: "admin_web",
    ...overrides
  };
}

function processInput(overrides = {}) {
  return {
    refundRecordId: "refund-1",
    refundAmountCents: 300,
    expectedRefundStatus: "pending",
    expectedRefundVersion: 2,
    expectedRefundUpdatedAt: FIXED_DATE.toISOString(),
    financeRemark: "线下退款已核对",
    refundProofFileIds: ["cloud://env.refund-proof-1"],
    ...overrides
  };
}

function rejectInput(overrides = {}) {
  return {
    refundRecordId: "refund-1",
    expectedRefundStatus: "pending",
    expectedRefundVersion: 2,
    expectedRefundUpdatedAt: FIXED_DATE.toISOString(),
    rejectReason: "退款资料不完整",
    ...overrides
  };
}

function fixture(overrides = {}) {
  const refund = {
    _id: "refund-1",
    refundNo: "RF-001",
    afterSaleId: "after-sale-1",
    afterSaleNo: "AS-001",
    orderId: "order-1",
    orderNo: "SO-001",
    userId: "user-1",
    openid: "openid-private",
    refundMethod: "offline",
    refundChannel: "offline",
    refundAmount: 300,
    refundStatus: "pending",
    version: 2,
    updatedAt: new Date(FIXED_DATE),
    ...overrides.refund
  };
  const afterSale = {
    _id: "after-sale-1",
    afterSaleNo: "AS-001",
    orderId: "order-1",
    orderNo: "SO-001",
    userId: "user-1",
    openid: "openid-private",
    afterSaleType: "refund_only",
    afterSaleStatus: "refund_pending",
    refundStatus: "pending",
    approvedRefundAmount: 500,
    actualRefundAmount: 0,
    returnRequired: false,
    returnItems: [{
      orderItemId: "item-1",
      returnQuantity: 1,
      refundableAmount: 300
    }],
    version: 3,
    updatedAt: new Date("2026-07-16T00:00:00.000Z"),
    ...overrides.afterSale
  };
  const order = {
    _id: "order-1",
    orderNo: "SO-001",
    userId: "user-1",
    userOpenid: "openid-private",
    paidAmount: 1000,
    totalRefundAmount: 0,
    refundableAmount: 1000,
    netPaidAmount: 1000,
    refundStatus: "pending",
    afterSaleStatus: "refund_pending",
    version: 5,
    updatedAt: new Date("2026-07-16T00:00:00.000Z"),
    ...overrides.order
  };
  const orderItem = {
    _id: "item-1",
    orderId: "order-1",
    quantity: 2,
    afterSaleQuantity: 0,
    refundedQuantity: 0,
    returnedQuantity: 0,
    itemRefundAmount: 0,
    ...overrides.orderItem
  };
  return {
    refund_records: [refund],
    after_sales: [afterSale],
    orders: [order],
    order_items: [orderItem],
    customer_accounts: [{
      _id: "account-1",
      userId: "user-1",
      userOpenid: "openid-private",
      totalOrderAmount: 1000,
      totalPaidAmount: 1000,
      totalUnpaidAmount: 0
    }],
    account_logs: [],
    refund_logs: [],
    after_sale_logs: [],
    admin_operation_logs: [],
    sync_events: [],
    idempotency_records: [],
    ...overrides.state
  };
}

function database(initial = {}, options = {}) {
  let state = structuredClone(initial);
  let nextId = 1;

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => {
      if (value && value.__operation === "neq") return row[key] !== value.value;
      if (value && value.__operation === "in") return value.values.includes(row[key]);
      return row[key] === value;
    });
  }

  function collection(target, name) {
    if (!target[name]) target[name] = [];
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
        const entry = {
          operation: "get",
          collection: name,
          where: structuredClone(queryState.where),
          limit: queryState.limit
        };
        if (options.observe) options.observe(entry);
        if (options.failOn && options.failOn(entry)) throw new Error(`forced ${name}.get failure`);
        return {
          data: target[name]
            .filter((row) => matches(row, queryState.where))
            .slice(0, queryState.limit)
            .map((row) => structuredClone(row))
        };
      },
      async add({ data }) {
        const entry = { operation: "add", collection: name, data: structuredClone(data) };
        if (options.observe) options.observe(entry);
        if (options.failOn && options.failOn(entry)) throw new Error(`forced ${name}.add failure`);
        let id = data._id;
        while (!id) {
          const candidate = `${name}-${nextId++}`;
          if (!target[name].some((row) => row._id === candidate)) id = candidate;
        }
        if (target[name].some((row) => row._id === id)) throw new Error("duplicate key");
        target[name].push({ ...structuredClone(data), _id: id });
        return { _id: id };
      },
      async remove() {
        const entry = {
          operation: "remove",
          collection: name,
          where: structuredClone(queryState.where)
        };
        if (options.observe) options.observe(entry);
        if (options.failOn && options.failOn(entry)) throw new Error(`forced ${name}.remove failure`);
        const before = target[name].length;
        target[name] = target[name].filter((row) => !matches(row, queryState.where));
        return { stats: { removed: before - target[name].length } };
      },
      doc(id) {
        return {
          async get() {
            const entry = { operation: "get", collection: name, id };
            if (options.observe) options.observe(entry);
            if (options.failOn && options.failOn(entry)) throw new Error(`forced ${name}.get failure`);
            const row = target[name].find((item) => item._id === id);
            return { data: row ? structuredClone(row) : null };
          },
          async update({ data }) {
            const entry = { operation: "update", collection: name, id, data: structuredClone(data) };
            if (options.observe) options.observe(entry);
            if (options.failOn && options.failOn(entry)) throw new Error(`forced ${name}.update failure`);
            const row = target[name].find((item) => item._id === id);
            if (!row) throw new Error("document not exist");
            Object.assign(row, structuredClone(data));
            return { stats: { updated: 1 } };
          },
          async set({ data }) {
            const entry = { operation: "set", collection: name, id, data: structuredClone(data) };
            if (options.observe) options.observe(entry);
            if (options.failOn && options.failOn(entry)) throw new Error(`forced ${name}.set failure`);
            const index = target[name].findIndex((item) => item._id === id);
            const row = { ...structuredClone(data), _id: id };
            if (index >= 0) target[name][index] = row;
            else target[name].push(row);
            return { stats: { updated: index >= 0 ? 1 : 0, created: index < 0 ? 1 : 0 } };
          },
          async remove() {
            const entry = { operation: "remove", collection: name, id };
            if (options.observe) options.observe(entry);
            if (options.failOn && options.failOn(entry)) throw new Error(`forced ${name}.remove failure`);
            const before = target[name].length;
            target[name] = target[name].filter((item) => item._id !== id);
            return { stats: { removed: before - target[name].length } };
          }
        };
      }
    };
    return query;
  }

  return {
    serverDate: () => new Date(FIXED_DATE),
    command: {
      neq(value) {
        return { __operation: "neq", value };
      },
      in(values) {
        return { __operation: "in", values };
      }
    },
    async createCollection(name) {
      const entry = { operation: "createCollection", collection: name };
      if (options.observe) options.observe(entry);
      if (options.failOn && options.failOn(entry)) throw new Error(`forced ${name}.createCollection failure`);
      if (!state[name]) state[name] = [];
    },
    collection(name) {
      return collection(state, name);
    },
    async runTransaction(executor) {
      const entry = { operation: "runTransaction" };
      if (options.observe) options.observe(entry);
      if (options.failOn && options.failOn(entry)) throw new Error("forced runTransaction failure");
      const draft = structuredClone(state);
      const tx = {
        collection(name) {
          return collection(draft, name);
        }
      };
      const result = await executor(tx);
      state = draft;
      return result;
    },
    snapshot() {
      return structuredClone(state);
    }
  };
}

function loadAfterSalesMain(db, openid = "finance-openid", callFunctionCalls = []) {
  const indexPath = require.resolve("../../afterSales/index.js");
  const originalLoad = Module._load;
  const previousPepper = process.env.SYNC_OWNER_PEPPER;
  process.env.SYNC_OWNER_PEPPER = "s".repeat(32);
  delete require.cache[indexPath];
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return {
        DYNAMIC_CURRENT_ENV: "test",
        init() {},
        database() {
          return db;
        },
        getWXContext() {
          return { OPENID: openid };
        },
        async callFunction(options) {
          callFunctionCalls.push(structuredClone(options));
          return { result: { ok: true } };
        }
      };
    }
    if (request === "xlsx") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(indexPath).main;
  } finally {
    Module._load = originalLoad;
    if (previousPepper === undefined) delete process.env.SYNC_OWNER_PEPPER;
    else process.env.SYNC_OWNER_PEPPER = previousPepper;
  }
}

function handlerFixture(overrides = {}) {
  return fixture({
    ...overrides,
    state: {
      admin_users: [{
        _id: "finance-1",
        openid: "finance-openid",
        role: "finance",
        status: "active",
        isActive: true,
        permissions: ["refund:create", "refund:process", "refund:view"]
      }],
      ...(overrides.state || {})
    }
  });
}

function idempotency(options = {}) {
  const records = new Map();
  return {
    async ensureCollection() {},
    assertIdempotencyKey(value) {
      const key = typeof value === "string" ? value.trim() : "";
      if (!key) throw new RefundMutationError("IDEMPOTENCY_KEY_REQUIRED", "缺少操作凭证");
      return key;
    },
    async runIdempotentAction(config, executor) {
      const identity = `${config.actionType}:${config.operatorIdentity}:${config.idempotencyKey}`;
      const payload = JSON.stringify(config.payload);
      const current = records.get(identity);
      if (current && current.payload !== payload) {
        return { ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", message: "conflict" };
      }
      if (current && current.status === "success") {
        return { ok: true, data: { ...structuredClone(current.data), duplicate: true } };
      }
      if (options.processingRecovery) {
        const recovered = await config.recoverProcessingResult();
        if (!recovered) return { ok: false, code: "IDEMPOTENCY_PROCESSING", message: "processing" };
        return { ok: true, data: { ...structuredClone(recovered), duplicate: true } };
      }
      const data = await executor();
      if (options.throwAfterExecute) throw new Error("simulated idempotency finalization failure");
      records.set(identity, { payload, status: "success", data: structuredClone(data) });
      return { ok: true, data };
    }
  };
}

function refundService(db, options = {}) {
  return createRefundMutationService({
    db,
    idempotency: options.idempotency || idempotency(),
    ownerKeyFor: (subject, pepper) => subject && pepper ? `owner:${subject.length}:${pepper.length}` : "",
    syncOwnerPepper: "s".repeat(32),
    recalculateAccount: options.recalculateAccount,
    now: options.now || (() => new Date(FIXED_DATE)),
    randomId: () => "fixed-random"
  });
}

function processCommand(overrides = {}) {
  return {
    actor: overrides.actor || actor(),
    input: processInput(overrides.input),
    idempotencyKey: overrides.idempotencyKey || "refund-process-key-1",
    strict: overrides.strict !== false
  };
}

function rejectCommand(overrides = {}) {
  return {
    actor: overrides.actor || actor(),
    input: rejectInput(overrides.input),
    idempotencyKey: overrides.idempotencyKey || "refund-reject-key-1",
    strict: overrides.strict !== false
  };
}

async function committedProcessSnapshot() {
  const db = database(fixture());
  await assert.rejects(
    () => refundService(db, {
      idempotency: idempotency({ throwAfterExecute: true }),
      recalculateAccount: async () => ({ ok: false })
    }).processOfflineRefund(processCommand()),
    /simulated idempotency finalization failure/
  );
  return db.snapshot();
}

function ambiguousLegacyQuantityFixture(orderItem = {}, options = {}) {
  const state = fixture({
    afterSale: {
      afterSaleType: "return_refund",
      returnRequired: true,
      actualRefundAmount: 200,
      inspectionResult: {
        received: true,
        inspectedAt: new Date("2026-07-16T12:00:00.000Z")
      }
    },
    order: {
      totalRefundAmount: 200,
      refundableAmount: 800,
      netPaidAmount: 800
    },
    orderItem
  });
  state.refund_records.push({
    ...structuredClone(state.refund_records[0]),
    _id: "refund-history-1",
    refundNo: "RF-HISTORY-1",
    refundAmount: 200,
    refundStatus: "refunded",
    version: 1
  });
  if (options.sharedAfterSale) {
    state.after_sales.push({
      ...structuredClone(state.after_sales[0]),
      _id: "after-sale-other",
      afterSaleNo: "AS-OTHER",
      actualRefundAmount: 0,
      returnItems: [{
        orderItemId: "item-1",
        returnQuantity: 1,
        refundableAmount: 100
      }]
    });
  }
  return state;
}

test("refund mutations enforce the active finance/super_admin hard role boundary", async () => {
  for (const invalidActor of [
    actor("customer_service"),
    actor("procurement"),
    actor("finance", { isActive: false, status: "disabled" })
  ]) {
    await assert.rejects(
      () => refundService(database(fixture())).processOfflineRefund(processCommand({ actor: invalidActor })),
      (error) => ["FORBIDDEN", "INVALID_ACTOR"].includes(error.code)
    );
  }
  const result = await refundService(database(fixture())).processOfflineRefund(
    processCommand({ actor: actor("super_admin") })
  );
  assert.equal(result.item.status, "refunded");
});

test("strict refund amount, fields, proof count, and proof format fail closed", async () => {
  for (const [input, code] of [
    [processInput({ refundAmountCents: 10.5 }), "INVALID_REFUND_AMOUNT"],
    [processInput({ refundAmountCents: 0 }), "INVALID_REFUND_AMOUNT"],
    [processInput({ refundProofFileIds: Array.from({ length: 7 }, (_, index) => `cloud://env.proof-${index}`) }), "REFUND_PROOF_LIMIT_EXCEEDED"],
    [processInput({ refundProofFileIds: ["https://example.com/private.jpg"] }), "REFUND_PROOF_INVALID"],
    [processInput({ injectedRole: "super_admin" }), "UNKNOWN_FIELD"]
  ]) {
    await assert.rejects(
      () => refundService(database(fixture())).processOfflineRefund({
        actor: actor(),
        input,
        idempotencyKey: `invalid-${code}`,
        strict: true
      }),
      (error) => error.code === code
    );
  }
});

test("return-required refunds require completed inspection, not received or inspecting state", async () => {
  for (const afterSaleStatus of ["received", "inspecting"]) {
    const db = database(fixture({
      afterSale: {
        afterSaleType: "return_refund",
        returnRequired: true,
        afterSaleStatus,
        inspectionResult: afterSaleStatus === "inspecting" ? { received: true } : null
      }
    }));
    await assert.rejects(
      () => refundService(db).processOfflineRefund(processCommand()),
      (error) => error.code === "RETURN_INSPECTION_REQUIRED"
    );
  }
});

test("strict status, version, and updatedAt snapshots reject stale mutations", async () => {
  for (const patch of [
    { expectedRefundStatus: "processing" },
    { expectedRefundVersion: 1 },
    { expectedRefundUpdatedAt: "2026-07-16T00:00:00.000Z" }
  ]) {
    await assert.rejects(
      () => refundService(database(fixture())).processOfflineRefund(
        processCommand({ input: patch, idempotencyKey: `stale-${Object.keys(patch)[0]}` })
      ),
      (error) => error.code === "DATA_VERSION_CONFLICT"
    );
  }
});

test("refund confirmation enforces approval and paid amount ceilings", async () => {
  const approvalDb = database(fixture({ afterSale: { approvedRefundAmount: 299 } }));
  await assert.rejects(
    () => refundService(approvalDb).processOfflineRefund(processCommand()),
    (error) => error.code === "REFUND_APPROVAL_LIMIT_EXCEEDED"
  );

  const paidDb = database(fixture({ order: { paidAmount: 299, refundableAmount: 299, netPaidAmount: 299 } }));
  await assert.rejects(
    () => refundService(paidDb).processOfflineRefund(processCommand()),
    (error) => error.code === "REFUND_PAID_LIMIT_EXCEEDED"
  );
});

test("refund history is bounded at 100 rows", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    ...fixture().refund_records[0],
    _id: `refund-${index}`,
    refundNo: `RF-${index}`,
    refundStatus: index === 0 ? "pending" : "cancelled",
    refundAmount: index === 0 ? 300 : 0
  }));
  const db = database(fixture({ state: { refund_records: rows } }));
  await assert.rejects(
    () => refundService(db).processOfflineRefund(processCommand({ input: { refundRecordId: "refund-0" } })),
    (error) => error.code === "REFUND_HISTORY_LIMIT_EXCEEDED"
  );
});

test("successful confirmation writes every companion row, a frozen public journal, and safe sync events", async () => {
  const db = database(fixture());
  let recalculationCalls = 0;
  const result = await refundService(db, {
    async recalculateAccount(target) {
      recalculationCalls += 1;
      assert.deepEqual(target, { accountId: "account-1" });
      return { ok: false };
    }
  }).processOfflineRefund(processCommand());
  const state = db.snapshot();

  assert.deepEqual(Object.keys(result).sort(), [
    "accountRecalculationPending", "action", "affected", "item", "reused"
  ]);
  assert.deepEqual(Object.keys(result.item).sort(), [
    "amountCents", "id", "refundNo", "status", "updatedAt", "version"
  ]);
  assert.equal(result.item.status, "refunded");
  assert.equal(result.item.amountCents, 300);
  assert.equal(result.accountRecalculationPending, true);
  assert.equal(recalculationCalls, 1);
  assert.equal(state.refund_records[0].refundStatus, "refunded");
  assert.equal(state.after_sales[0].actualRefundAmount, 300);
  assert.equal(state.orders[0].totalRefundAmount, 300);
  assert.equal(state.order_items[0].itemRefundAmount, 300);
  assert.equal(state.account_logs.length, 1);
  assert.equal(state.refund_logs.length, 1);
  assert.equal(state.after_sale_logs.length, 1);
  assert.equal(state.admin_operation_logs.length, 1);
  assert.equal(state.sync_events.length, 2);
  assert.deepEqual(state.admin_operation_logs[0].journal.result, result);
  assert.equal(state.admin_operation_logs[0].journal.recalculation.owner, "refund-process-key-1");
  assert.equal(state.admin_operation_logs[0].journal.recalculation.expectedOrderVersion, 6);
  assert.equal(JSON.stringify(state.admin_operation_logs[0].journal).includes("user-1"), false);
  assert.equal(JSON.stringify(state.admin_operation_logs[0].journal).includes("openid-private"), false);
  for (const event of state.sync_events) {
    assert.equal("userId" in event, false);
    assert.equal("openid" in event, false);
    assert.equal("refundProofFileIds" in event, false);
    assert.equal("journal" in event, false);
  }
});

test("every confirmation write failure including order_items rolls back the entire transaction", async () => {
  const failures = [
    ["refund_records", "update", 1],
    ["after_sales", "update", 1],
    ["orders", "update", 1],
    ["order_items", "update", 1],
    ["account_logs", "add", 1],
    ["refund_logs", "add", 1],
    ["after_sale_logs", "add", 1],
    ["admin_operation_logs", "add", 1],
    ["sync_events", "add", 1],
    ["sync_events", "add", 2]
  ];
  for (const [collection, operation, occurrence] of failures) {
    let seen = 0;
    const initial = fixture();
    const db = database(initial, {
      failOn(entry) {
        if (entry.collection === collection && entry.operation === operation) {
          seen += 1;
          return seen === occurrence;
        }
        return false;
      }
    });
    await assert.rejects(
      () => refundService(db).processOfflineRefund(
        processCommand({ idempotencyKey: `rollback-${collection}-${occurrence}` })
      ),
      new RegExp(`forced ${collection}`)
    );
    assert.deepEqual(db.snapshot(), structuredClone(initial));
  }
});

test("processing recovery fails closed on duplicate or missing immutable evidence", async () => {
  const seed = database(fixture());
  await assert.rejects(
    () => refundService(seed, {
      idempotency: idempotency({ throwAfterExecute: true }),
      recalculateAccount: async () => ({ ok: false })
    }).processOfflineRefund(processCommand()),
    /simulated idempotency finalization failure/
  );
  const committed = seed.snapshot();
  assert.equal(committed.refund_records[0].refundStatus, "refunded");

  const duplicateState = structuredClone(committed);
  duplicateState.admin_operation_logs.push({
    ...duplicateState.admin_operation_logs[0],
    _id: "duplicate-journal"
  });
  await assert.rejects(
    () => refundService(database(duplicateState), {
      idempotency: idempotency({ processingRecovery: true })
    }).processOfflineRefund(processCommand()),
    (error) => error.code === "IMMUTABLE_EVIDENCE_DUPLICATE"
  );

  const missingState = structuredClone(committed);
  missingState.account_logs = [];
  await assert.rejects(
    () => refundService(database(missingState), {
      idempotency: idempotency({ processingRecovery: true })
    }).processOfflineRefund(processCommand()),
    (error) => error.code === "IMMUTABLE_EVIDENCE_MISSING"
  );
});

test("recovery cross-checks immutable confirmed evidence against after-sale and order totals", async () => {
  const seed = database(fixture());
  await assert.rejects(
    () => refundService(seed, {
      idempotency: idempotency({ throwAfterExecute: true }),
      recalculateAccount: async () => ({ ok: false })
    }).processOfflineRefund(processCommand()),
    /simulated idempotency finalization failure/
  );
  for (const mutate of [
    (state) => { state.after_sales[0].actualRefundAmount = 299; },
    (state) => { state.orders[0].totalRefundAmount = 299; },
    (state) => { state.refund_logs[0].amountCents = 299; },
    (state) => { state.after_sale_logs[0].afterData.actualRefundAmount = 299; },
    (state) => { state.sync_events[0].version = 999; }
  ]) {
    const state = seed.snapshot();
    mutate(state);
    await assert.rejects(
      () => refundService(database(state), {
        idempotency: idempotency({ processingRecovery: true })
      }).processOfflineRefund(processCommand()),
      (error) => error.code === "IMMUTABLE_EVIDENCE_CONFLICT"
    );
  }
});

test("processing recovery uses the frozen owner key after current customer identity changes", async () => {
  const state = await committedProcessSnapshot();
  state.orders[0].userId = "user-new";
  state.orders[0].userOpenid = "openid-new";
  const recovered = await refundService(database(state), {
    idempotency: idempotency({ processingRecovery: true })
  }).processOfflineRefund(processCommand());
  assert.equal(recovered.item.id, "refund-1");
  assert.equal(recovered.reused, true);
  assert.equal(recovered.affected, 0);
});

test("processing recovery recalculates the frozen accountId after customer identity changes", async () => {
  const state = await committedProcessSnapshot();
  state.orders[0].userId = "user-new";
  state.orders[0].userOpenid = "openid-new";
  const db = database(state);
  const calls = [];
  const recovered = await refundService(db, {
    idempotency: idempotency({ processingRecovery: true }),
    recalculateAccount: async (target) => {
      calls.push(structuredClone(target));
      return { ok: true };
    }
  }).processOfflineRefund(processCommand());
  assert.deepEqual(calls, [{ accountId: "account-1" }]);
  assert.equal(recovered.accountRecalculationPending, false);
  assert.equal(db.snapshot().orders[0].accountRecalculationPending, false);
  assert.equal(
    db.snapshot().admin_operation_logs.some((row) => row.operationKind === "refund_recalculation_completion"),
    true
  );
});

test("processing recovery ignores later refund-history growth beyond the mutation bound", async () => {
  const state = await committedProcessSnapshot();
  state.refund_records.push(...Array.from({ length: 101 }, (_, index) => ({
    ...fixture().refund_records[0],
    _id: `later-refund-${index}`,
    refundNo: `LATER-${index}`,
    refundStatus: "cancelled",
    version: 1,
    updatedAt: new Date("2026-07-18T00:00:00.000Z")
  })));
  const recovered = await refundService(database(state), {
    idempotency: idempotency({ processingRecovery: true })
  }).processOfflineRefund(processCommand());
  assert.equal(recovered.item.status, "refunded");
  assert.equal(recovered.reused, true);
});

test("processing recovery returns the frozen result after later entity status and version advances", async () => {
  const state = await committedProcessSnapshot();
  state.refund_records[0].version = 9;
  state.refund_records[0].updatedAt = new Date("2026-07-18T00:00:00.000Z");
  state.after_sales[0].afterSaleStatus = "completed";
  state.after_sales[0].version = 12;
  state.orders[0].afterSaleStatus = "completed";
  state.orders[0].status = "completed";
  state.orders[0].version = 15;
  const recovered = await refundService(database(state), {
    idempotency: idempotency({ processingRecovery: true })
  }).processOfflineRefund(processCommand());
  assert.deepEqual(recovered.item, {
    id: "refund-1",
    refundNo: "RF-001",
    status: "refunded",
    version: 3,
    updatedAt: FIXED_DATE.toISOString(),
    amountCents: 300
  });
});

test("journal freezes limits, owner key, relationships, and all committed versions", async () => {
  const state = await committedProcessSnapshot();
  const journal = state.admin_operation_logs[0].journal;
  assert.deepEqual(journal.recovery, {
    relationships: {
      refundRecordId: "refund-1",
      afterSaleId: "after-sale-1",
      orderId: "order-1"
    },
    limits: {
      approvedAmountCents: 500,
      paidAmountCents: 1000
    },
    committedVersions: {
      refund: 3,
      afterSale: 4,
      order: 6
    },
    cumulative: {
      afterSaleBeforeCents: 0,
      afterSaleAfterCents: 300,
      orderBeforeCents: 0,
      orderAfterCents: 300
    },
    accountId: "account-1",
    ownerKey: state.sync_events.find((event) => event.audience === "owner").ownerKey
  });
  assert.deepEqual(
    state.refund_logs[0].result.recovery,
    journal.recovery
  );
});

test("processing recovery fails closed when frozen approved or paid limits are tampered", async () => {
  for (const mutate of [
    (journal) => { journal.recovery.limits.approvedAmountCents = 499; },
    (journal) => { journal.recovery.limits.paidAmountCents = 999; }
  ]) {
    const state = await committedProcessSnapshot();
    mutate(state.admin_operation_logs[0].journal);
    await assert.rejects(
      () => refundService(database(state), {
        idempotency: idempotency({ processingRecovery: true })
      }).processOfflineRefund(processCommand()),
      (error) => error.code === "IMMUTABLE_EVIDENCE_CONFLICT"
    );
  }
});

test("processing recovery rejects consistently tampered limits below frozen cumulative totals", async () => {
  const state = fixture({
    afterSale: { actualRefundAmount: 200 },
    order: {
      totalRefundAmount: 200,
      refundableAmount: 800,
      netPaidAmount: 800
    },
    orderItem: {
      afterSaleQuantity: 1,
      refundedQuantity: 1,
      returnedQuantity: 0,
      refundQuantityAppliedAfterSaleIds: ["after-sale-1"]
    }
  });
  state.refund_records.push({
    ...structuredClone(state.refund_records[0]),
    _id: "refund-history-1",
    refundNo: "RF-HISTORY-1",
    refundAmount: 200,
    refundStatus: "refunded",
    version: 1
  });
  const db = database(state);
  await assert.rejects(
    () => refundService(db, {
      idempotency: idempotency({ throwAfterExecute: true }),
      recalculateAccount: async () => ({ ok: false })
    }).processOfflineRefund(processCommand()),
    /simulated idempotency finalization failure/
  );
  const committed = db.snapshot();
  assert.equal(committed.admin_operation_logs[0].journal.afterSale.actualRefundAmount, 500);
  assert.equal(committed.admin_operation_logs[0].journal.order.totalRefundAmount, 500);
  for (const recovery of [
    committed.admin_operation_logs[0].journal.recovery,
    committed.refund_logs[0].result.recovery
  ]) {
    recovery.limits.approvedAmountCents = 400;
    recovery.limits.paidAmountCents = 400;
  }
  await assert.rejects(
    () => refundService(database(committed), {
      idempotency: idempotency({ processingRecovery: true })
    }).processOfflineRefund(processCommand()),
    (error) => error.code === "IMMUTABLE_EVIDENCE_CONFLICT"
  );
});

test("canonical refund service exports the exact required unique index metadata gate", () => {
  const migrationNote = "Legacy rows without the indexed business key are excluded by the partial filter; backfill keys and resolve duplicates before replacing this with a full unique index.";
  assert.ok(Object.isFrozen(REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES));
  assert.deepEqual(REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES, [
    {
      collection: "admin_operation_logs",
      indexName: "uniq_refund_admin_operation_business_key",
      unique: true,
      fields: ["businessKey"],
      sparse: false,
      partialFilterExpression: { businessKey: { $exists: true, $type: "string" } },
      migrationNote
    },
    {
      collection: "account_logs",
      indexName: "uniq_refund_account_log_business_key",
      unique: true,
      fields: ["businessKey"],
      sparse: false,
      partialFilterExpression: { businessKey: { $exists: true, $type: "string" } },
      migrationNote
    },
    {
      collection: "refund_logs",
      indexName: "uniq_refund_log_business_key",
      unique: true,
      fields: ["businessKey"],
      sparse: false,
      partialFilterExpression: { businessKey: { $exists: true, $type: "string" } },
      migrationNote
    },
    {
      collection: "after_sale_logs",
      indexName: "uniq_refund_after_sale_log_business_key",
      unique: true,
      fields: ["businessKey"],
      sparse: false,
      partialFilterExpression: { businessKey: { $exists: true, $type: "string" } },
      migrationNote
    },
    {
      collection: "sync_events",
      indexName: "uniq_refund_sync_event_id",
      unique: true,
      fields: ["eventId"],
      sparse: false,
      partialFilterExpression: { eventId: { $exists: true, $type: "string" } },
      migrationNote: "Legacy rows without eventId are excluded by the partial filter; backfill eventId values and resolve duplicates before replacing this with a full unique index."
    }
  ]);
  for (const index of REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES) {
    assert.equal(index.unique, true);
    assert.equal(index.sparse, false);
    assert.ok(Object.isFrozen(index));
    assert.ok(Object.isFrozen(index.fields));
    assert.ok(Object.isFrozen(index.partialFilterExpression));
    const filter = index.partialFilterExpression[index.fields[0]];
    assert.ok(Object.isFrozen(filter));
  }
});

test("owned recalculation marker clears after unrelated order version advancement", async () => {
  const committed = await committedProcessSnapshot();
  committed.orders[0].version = 7;
  committed.orders[0].updatedAt = new Date("2026-07-18T00:00:00.000Z");
  const db = database(committed);
  const recovered = await refundService(db, {
    idempotency: idempotency({ processingRecovery: true }),
    recalculateAccount: async () => ({ ok: true })
  }).processOfflineRefund(processCommand());
  const state = db.snapshot();
  assert.equal(recovered.accountRecalculationPending, false);
  assert.equal(state.orders[0].accountRecalculationPending, false);
  assert.equal(state.orders[0].accountRecalculationOwner, "refund-process-key-1");
  assert.equal(state.orders[0].accountRecalculationExpectedVersion, 6);
  assert.equal(state.orders[0].version, 7);
  assert.equal(
    state.admin_operation_logs.some((row) => row.operationKind === "refund_recalculation_completion"),
    true
  );
});

test("partial refund records apply after-sale item quantities only once", async () => {
  const state = fixture({
    refund: { refundAmount: 250 },
    afterSale: {
      afterSaleType: "return_refund",
      returnRequired: true,
      inspectionResult: {
        received: true,
        inspectedAt: new Date("2026-07-16T12:00:00.000Z")
      },
      refundRecordIds: ["refund-1", "refund-2"]
    }
  });
  state.refund_records.push({
    ...structuredClone(state.refund_records[0]),
    _id: "refund-2",
    refundNo: "RF-002"
  });
  const db = database(state);
  await refundService(db).processOfflineRefund(processCommand({
    idempotencyKey: "partial-refund-1",
    input: { refundAmountCents: 250 }
  }));
  const second = await refundService(db).processOfflineRefund(processCommand({
    idempotencyKey: "partial-refund-2",
    input: {
      refundRecordId: "refund-2",
      refundAmountCents: 250
    }
  }));
  const committed = db.snapshot();
  const item = committed.order_items[0];
  assert.equal(second.item.status, "refunded");
  assert.equal(committed.after_sales[0].actualRefundAmount, 500);
  assert.equal(committed.orders[0].totalRefundAmount, 500);
  assert.equal(item.itemRefundAmount, 500);
  assert.equal(item.afterSaleQuantity, 1);
  assert.equal(item.refundedQuantity, 1);
  assert.equal(item.returnedQuantity, 1);
});

test("legacy confirmed refund with fully missing item ownership fails before writes", async () => {
  const initial = ambiguousLegacyQuantityFixture({
    afterSaleQuantity: 0,
    refundedQuantity: 0,
    returnedQuantity: 0
  });
  const operations = [];
  const db = database(initial, { observe: (entry) => operations.push(entry) });
  await assert.rejects(
    () => refundService(db).processOfflineRefund(processCommand()),
    (error) => error.code === "REFUND_ITEM_QUANTITY_RECONCILIATION_REQUIRED"
  );
  assert.equal(operations.some((entry) => ["add", "update"].includes(entry.operation)), false);
  assert.deepEqual(db.snapshot(), initial);
});

test("legacy confirmed refund with partially missing item counts fails before writes", async () => {
  const initial = ambiguousLegacyQuantityFixture({
    afterSaleQuantity: 1,
    refundedQuantity: 0,
    returnedQuantity: 1
  });
  const operations = [];
  const db = database(initial, { observe: (entry) => operations.push(entry) });
  await assert.rejects(
    () => refundService(db).processOfflineRefund(processCommand()),
    (error) => error.code === "REFUND_ITEM_QUANTITY_RECONCILIATION_REQUIRED"
  );
  assert.equal(operations.some((entry) => ["add", "update"].includes(entry.operation)), false);
  assert.deepEqual(db.snapshot(), initial);
});

test("shared item marker for another after-sale does not resolve legacy ownership ambiguity", async () => {
  const initial = ambiguousLegacyQuantityFixture({
    afterSaleQuantity: 1,
    refundedQuantity: 1,
    returnedQuantity: 1,
    refundQuantityAppliedAfterSaleIds: ["after-sale-other"]
  }, { sharedAfterSale: true });
  const operations = [];
  const db = database(initial, { observe: (entry) => operations.push(entry) });
  await assert.rejects(
    () => refundService(db).processOfflineRefund(processCommand()),
    (error) => error.code === "REFUND_ITEM_QUANTITY_RECONCILIATION_REQUIRED"
  );
  assert.equal(operations.some((entry) => ["add", "update"].includes(entry.operation)), false);
  assert.deepEqual(db.snapshot(), initial);
});

test("committed recovery retries recalculation and compare-before-clears only the owned marker", async () => {
  const seed = database(fixture());
  await assert.rejects(
    () => refundService(seed, {
      idempotency: idempotency({ throwAfterExecute: true }),
      recalculateAccount: async () => ({ ok: false })
    }).processOfflineRefund(processCommand()),
    /simulated idempotency finalization failure/
  );

  let calls = 0;
  const recovered = await refundService(seed, {
    idempotency: idempotency({ processingRecovery: true }),
    recalculateAccount: async () => {
      calls += 1;
      return { ok: true };
    }
  }).processOfflineRefund(processCommand());
  assert.equal(calls, 1);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.affected, 0);
  assert.equal(recovered.accountRecalculationPending, false);
  assert.equal(seed.snapshot().orders[0].accountRecalculationPending, false);
  assert.equal(seed.snapshot().admin_operation_logs.length, 2);

  const movedState = seed.snapshot();
  movedState.orders[0].accountRecalculationPending = true;
  movedState.orders[0].accountRecalculationOwner = "newer-refund";
  movedState.orders[0].accountRecalculationExpectedVersion = 7;
  movedState.orders[0].version = 7;
  movedState.admin_operation_logs = movedState.admin_operation_logs.slice(0, 1);
  const movedDb = database(movedState);
  const pending = await refundService(movedDb, {
    idempotency: idempotency({ processingRecovery: true }),
    recalculateAccount: async () => ({ ok: true })
  }).processOfflineRefund(processCommand());
  assert.equal(pending.accountRecalculationPending, true);
  assert.equal(movedDb.snapshot().orders[0].accountRecalculationOwner, "newer-refund");
});

test("completed replay does not recalculate again after completion evidence exists", async () => {
  const db = database(fixture());
  const idem = idempotency();
  let calls = 0;
  const service = refundService(db, {
    idempotency: idem,
    recalculateAccount: async () => {
      calls += 1;
      return { ok: true };
    }
  });
  const first = await service.processOfflineRefund(processCommand());
  const second = await service.processOfflineRefund(processCommand());
  assert.equal(first.accountRecalculationPending, false);
  assert.equal(second.accountRecalculationPending, false);
  assert.equal(second.reused, true);
  assert.equal(second.affected, 0);
  assert.equal(calls, 1);
});

test("shared idempotency recovers committed business after finalization failure and persists only the safe result", async () => {
  let idempotencyUpdates = 0;
  const db = database(fixture(), {
    failOn(entry) {
      if (entry.collection === "idempotency_records" && entry.operation === "update") {
        idempotencyUpdates += 1;
        return idempotencyUpdates === 1;
      }
      return false;
    }
  });
  let recalculationCalls = 0;
  const service = refundService(db, {
    idempotency: sharedIdempotency,
    recalculateAccount: async () => {
      recalculationCalls += 1;
      return { ok: true };
    }
  });
  const first = await service.processOfflineRefund(
    processCommand({ idempotencyKey: "shared-recovery-key" })
  );
  const second = await service.processOfflineRefund(
    processCommand({ idempotencyKey: "shared-recovery-key" })
  );
  const record = db.snapshot().idempotency_records[0];
  assert.equal(first.accountRecalculationPending, false);
  assert.equal(second.accountRecalculationPending, false);
  assert.equal(second.reused, true);
  assert.equal(second.affected, 0);
  assert.equal(recalculationCalls, 1);
  assert.equal(record.status, "success");
  assert.equal(record.resultDataMasked.item.id, "refund-1");
  assert.equal("userId" in record.resultDataMasked, false);
  assert.equal("openid" in record.resultDataMasked, false);
  assert.equal("refundProofFileIds" in record.resultDataMasked, false);
  assert.equal("journal" in record.resultDataMasked, false);
});

test("reject updates refund, after-sale, and order with complete logs and safe sync events", async () => {
  const db = database(fixture());
  const result = await refundService(db).rejectRefund(rejectCommand());
  const state = db.snapshot();
  assert.equal(result.item.status, "rejected");
  assert.equal(result.action, "reject");
  assert.equal(result.accountRecalculationPending, false);
  assert.equal(state.refund_records[0].refundStatus, "rejected");
  assert.equal(state.after_sales[0].refundStatus, "pending");
  assert.equal(state.after_sales[0].version, 4);
  assert.equal(state.orders[0].refundStatus, "pending");
  assert.equal(state.orders[0].version, 6);
  assert.equal(state.refund_logs.length, 1);
  assert.equal(state.after_sale_logs.length, 1);
  assert.equal(state.admin_operation_logs.length, 1);
  assert.equal(state.sync_events.length, 2);
  assert.equal(state.account_logs.length, 0);
  assert.equal(state.order_items[0].itemRefundAmount, 0);
  for (const event of state.sync_events) {
    assert.equal("rejectReason" in event, false);
    assert.equal("userId" in event, false);
    assert.equal("openid" in event, false);
  }
});

test("reject is idempotent and every rejection companion failure rolls back", async () => {
  const idem = idempotency();
  const replayDb = database(fixture());
  const replayService = refundService(replayDb, { idempotency: idem });
  await replayService.rejectRefund(rejectCommand());
  const replay = await replayService.rejectRefund(rejectCommand());
  assert.equal(replay.reused, true);
  assert.equal(replay.affected, 0);
  assert.equal(replayDb.snapshot().refund_logs.length, 1);

  for (const [collection, operation] of [
    ["refund_records", "update"],
    ["after_sales", "update"],
    ["orders", "update"],
    ["refund_logs", "add"],
    ["after_sale_logs", "add"],
    ["admin_operation_logs", "add"],
    ["sync_events", "add"]
  ]) {
    const initial = fixture();
    const db = database(initial, {
      failOn: (entry) => entry.collection === collection && entry.operation === operation
    });
    await assert.rejects(
      () => refundService(db).rejectRefund(
        rejectCommand({ idempotencyKey: `reject-rollback-${collection}` })
      ),
      new RegExp(`forced ${collection}`)
    );
    assert.deepEqual(db.snapshot(), structuredClone(initial));
  }
});

test("legacy aliases remain supported while strict snapshots stay optional", async () => {
  const db = database(fixture());
  const result = await refundService(db).processOfflineRefund({
    actor: actor(),
    input: {
      refundRecordId: "refund-1",
      financeRemark: "旧入口备注",
      refundProofImages: ["cloud://env.legacy-proof"]
    },
    idempotencyKey: "legacy-process-key",
    strict: false
  });
  assert.equal(result.item.status, "refunded");
  assert.deepEqual(db.snapshot().refund_records[0].refundProofFileIds, ["cloud://env.legacy-proof"]);
});

test("legacy confirmation preserves stored proof and finance remark when aliases are omitted", async () => {
  const db = database(fixture({
    refund: {
      financeRemark: "原财务备注",
      refundProofFileIds: ["cloud://env.existing-proof"],
      refundProofImages: ["cloud://env.existing-proof"]
    }
  }));
  await refundService(db).processOfflineRefund({
    actor: actor(),
    input: { refundRecordId: "refund-1" },
    idempotencyKey: "legacy-preserve-key",
    strict: false
  });
  assert.equal(db.snapshot().refund_records[0].financeRemark, "原财务备注");
  assert.deepEqual(
    db.snapshot().refund_records[0].refundProofFileIds,
    ["cloud://env.existing-proof"]
  );
});

test("legacy createRefundRecord uses the shared transaction and deterministic public result", async () => {
  const db = database(fixture({
    state: { refund_records: [] },
    afterSale: { refundRecordIds: [] }
  }));
  const result = await refundService(db).createRefundRecord({
    actor: actor(),
    input: {
      afterSaleId: "after-sale-1",
      refundAmount: 300,
      refundMethod: "offline",
      refundChannel: "offline",
      financeRemark: "创建退款",
      offlineRefundAccount: {
        accountName: "张*",
        bankName: "测试银行",
        bankCardNoMasked: "****1234"
      }
    },
    idempotencyKey: "legacy-create-key",
    strict: false
  });
  const state = db.snapshot();
  assert.equal(result.action, "create");
  assert.equal(result.item.status, "pending");
  assert.equal(result.item.amountCents, 300);
  assert.equal(state.refund_records.length, 1);
  assert.deepEqual(state.refund_records[0].offlineRefundAccount, {
    accountName: "张*",
    bankName: "测试银行",
    bankCardNoMasked: "****1234",
    alipayAccountMasked: "",
    wechatAccountMasked: ""
  });
  assert.equal(state.after_sales[0].refundRecordIds.length, 1);
  assert.equal(state.refund_logs.length, 1);
  assert.equal(state.after_sale_logs.length, 1);
  assert.equal(state.admin_operation_logs.length, 1);
  assert.equal(state.sync_events.length, 2);
});

test("refund creation requires an approved state and includes pending reservations in the approval ceiling", async () => {
  const unapproved = database(fixture({
    state: { refund_records: [] },
    afterSale: { afterSaleStatus: "pending_review", refundRecordIds: [] }
  }));
  await assert.rejects(
    () => refundService(unapproved).createRefundRecord({
      actor: actor(),
      input: {
        afterSaleId: "after-sale-1",
        refundAmount: 300,
        refundMethod: "offline"
      },
      idempotencyKey: "create-unapproved",
      strict: false
    }),
    (error) => error.code === "AFTER_SALE_NOT_APPROVED"
  );

  const reserved = {
    ...fixture().refund_records[0],
    _id: "refund-reserved",
    refundAmount: 400,
    refundStatus: "pending"
  };
  const overReserved = database(fixture({
    state: { refund_records: [reserved] },
    afterSale: { refundRecordIds: ["refund-reserved"] }
  }));
  await assert.rejects(
    () => refundService(overReserved).createRefundRecord({
      actor: actor(),
      input: {
        afterSaleId: "after-sale-1",
        refundAmount: 300,
        refundMethod: "offline"
      },
      idempotencyKey: "create-over-reserved",
      strict: false
    }),
    (error) => error.code === "REFUND_APPROVAL_LIMIT_EXCEEDED"
  );
});

test("afterSales handler accepts the current mini-program createRefundRecord payload", async () => {
  const db = database(handlerFixture({
    state: { refund_records: [] },
    afterSale: { refundRecordIds: [] }
  }));
  const main = loadAfterSalesMain(db);
  const response = await main({
    action: "createRefundRecord",
    afterSaleId: "after-sale-1",
    refundAmount: 300,
    refundMethod: "offline",
    financeRemark: "售后审核通过后创建退款记录",
    idempotencyKey: "create_refund_current_1"
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.refundStatus, "pending");
  assert.equal(response.data.refundAmount, 300);
});

test("unimplemented WeChat refund handlers return fail-closed codes without database mutations", async () => {
  const mutationOperations = new Set([
    "createCollection",
    "runTransaction",
    "add",
    "update",
    "remove"
  ]);
  for (const [action, expectedCode] of [
    ["createWechatPayRefund", "WECHAT_REFUND_NOT_CONFIGURED"],
    ["handleWechatRefundNotify", "WECHAT_REFUND_NOTIFY_NOT_IMPLEMENTED"]
  ]) {
    const mutations = [];
    const db = database(handlerFixture({
      state: {
        admin_users: [{
          _id: "finance-1",
          openid: "finance-openid",
          role: "finance",
          status: "active",
          isActive: true,
          permissions: ["refund:wechat_pay"]
        }]
      }
    }), {
      observe(entry) {
        if (mutationOperations.has(entry.operation)) mutations.push(entry);
      }
    });
    const main = loadAfterSalesMain(db);
    const response = await main({ action, refundRecordId: "refund-1" });
    assert.equal(response.ok, false);
    assert.equal(response.code, expectedCode);
    assert.deepEqual(mutations, []);
  }
});

test("afterSales handler accepts the current mini-program processOfflineRefund payload", async () => {
  const db = database(handlerFixture());
  const calls = [];
  const main = loadAfterSalesMain(db, "finance-openid", calls);
  const response = await main({
    action: "processOfflineRefund",
    refundRecordId: "refund-1",
    refundAmount: 300,
    refundProofImages: ["cloud://env.current-proof"],
    financeRemark: "财务核对完成",
    idempotencyKey: "confirm_refund_current_1"
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.refundStatus, "refunded");
  assert.equal(db.snapshot().refund_records[0].financeRemark, "财务核对完成");
  assert.deepEqual(calls, [{
    name: "recalculateCustomerAccount",
    data: { accountId: "account-1" }
  }]);
});

test("afterSales handler derives a deterministic key for the current keyless rejectRefund payload", async () => {
  const db = database(handlerFixture({
    refund: { financeRemark: "原财务备注" }
  }));
  const main = loadAfterSalesMain(db);
  const payload = {
    action: "rejectRefund",
    refundRecordId: "refund-1",
    failedReason: "退款资料不完整"
  };
  const first = await main(payload);
  const second = await main(payload);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.data.reused, true);
  assert.equal(db.snapshot().refund_records[0].financeRemark, "原财务备注");
  assert.equal(db.snapshot().refund_logs.length, 1);
  assert.equal(db.snapshot().idempotency_records.length, 1);
});

test("afterSales handler preserves stored process remark when the legacy payload omits it", async () => {
  const db = database(handlerFixture({
    refund: { financeRemark: "原财务备注" }
  }));
  const main = loadAfterSalesMain(db);
  const response = await main({
    action: "processOfflineRefund",
    refundRecordId: "refund-1",
    refundAmount: 300,
    refundProofImages: [],
    idempotencyKey: "confirm_refund_no_remark"
  });
  assert.equal(response.ok, true);
  assert.equal(db.snapshot().refund_records[0].financeRemark, "原财务备注");
});

test("afterSales handler calculates the remaining reservation when legacy create omits amount", async () => {
  const reserved = {
    ...fixture().refund_records[0],
    _id: "refund-reserved",
    refundNo: "RF-RESERVED",
    refundAmount: 400,
    refundStatus: "pending"
  };
  const db = database(handlerFixture({
    state: { refund_records: [reserved] },
    afterSale: { refundRecordIds: ["refund-reserved"] }
  }));
  const main = loadAfterSalesMain(db);
  const response = await main({
    action: "createRefundRecord",
    afterSaleId: "after-sale-1",
    refundMethod: "offline",
    idempotencyKey: "create_refund_remaining_1"
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.refundAmount, 100);
  assert.equal(db.snapshot().refund_records.length, 2);
});
