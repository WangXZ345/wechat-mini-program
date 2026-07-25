"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OrderApprovalError,
  includeApprovedOrderInTransaction,
  nextVersionOf,
  normalizeReviewItems,
  normalizeOrderAmount,
  versionOf
} = require("./orderApprovalService");

function clone(value) {
  return structuredClone(value);
}

function store(initial = {}) {
  const state = clone({
    customer_accounts: [],
    account_logs: [],
    ...initial
  });
  let sequence = 0;

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }

  return {
    collection(name) {
      const rows = state[name];
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
          const row = { _id: `${name}-${++sequence}`, ...clone(data) };
          rows.push(row);
          return { _id: row._id };
        },
        doc(id) {
          return {
            async update({ data }) {
              const row = rows.find((item) => item._id === id);
              if (!row) throw new Error(`document not exist: ${id}`);
              Object.assign(row, clone(data));
            }
          };
        }
      };
      return query;
    },
    snapshot() {
      return clone(state);
    }
  };
}

function order(overrides = {}) {
  return {
    _id: "o-1",
    userId: "u-new",
    userOpenid: "openid-existing",
    nickname: "订单昵称",
    phone: "13800000000",
    totalAmount: 900,
    ...overrides
  };
}

function actor(overrides = {}) {
  return {
    id: "system",
    openid: "",
    role: "system",
    sourceClient: "system",
    ...overrides
  };
}

test("shared approval rules aggregate duplicate items and keep legacy version/amount safety", () => {
  assert.deepEqual(
    normalizeReviewItems([
      { productId: "p-1", quantity: 2 },
      { productId: "p-1", quantity: 3 },
      { productId: "p-2", quantity: 1 }
    ]),
    [
      { productId: "p-1", quantity: 5 },
      { productId: "p-2", quantity: 1 }
    ]
  );
  assert.equal(versionOf({}), 0);
  assert.equal(versionOf({ version: 4 }), 4);
  assert.equal(nextVersionOf({}), 1);
  assert.equal(nextVersionOf({ version: 4 }), 5);
  assert.equal(normalizeOrderAmount(1234), 1234);
  for (const items of [
    [{ productId: "", quantity: 1 }],
    [{ productId: "p-1", quantity: 0 }],
    Array.from({ length: 101 }, (_, index) => ({ productId: `p-${index}`, quantity: 1 }))
  ]) {
    assert.throws(() => normalizeReviewItems(items), OrderApprovalError);
  }
  for (const value of [-1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeOrderAmount(value), OrderApprovalError);
  }
  assert.throws(() => versionOf({ version: -1 }), OrderApprovalError);
  assert.throws(() => nextVersionOf({ version: Number.MAX_SAFE_INTEGER }), OrderApprovalError);
});

test("shared account primitive uses openid fallback and writes canonical debt metadata without replacing unrelated fields", async () => {
  const current = store({
    customer_accounts: [{
      _id: "account-1",
      userId: "u-old",
      userOpenid: "openid-existing",
      adminNote: "保留备注",
      adminTags: ["重点"],
      riskLevel: "important",
      totalOrderAmount: 100,
      totalReceivableAmount: 100,
      totalPaidAmount: 20,
      paidAmount: 20,
      totalUnpaidAmount: 80,
      unpaidAmount: 80,
      todayOrderAmount: 100,
      todayDate: "2026-07-22",
      orderCount: 2,
      unpaidOrderCount: 1
    }]
  });
  const timestamp = new Date("2026-07-23T08:00:00.000Z");

  const result = await includeApprovedOrderInTransaction({
    store: current,
    order: order(),
    actor: actor(),
    amount: 900,
    timestamp
  });
  const state = current.snapshot();
  const account = state.customer_accounts[0];
  const log = state.account_logs[0];

  assert.equal(result.reused, false);
  assert.equal(state.customer_accounts.length, 1);
  assert.equal(account.adminNote, "保留备注");
  assert.deepEqual(account.adminTags, ["重点"]);
  assert.equal(account.riskLevel, "important");
  assert.equal(account.totalOrderAmount, 1000);
  assert.equal(account.totalReceivableAmount, 1000);
  assert.equal(account.totalUnpaidAmount, 980);
  assert.equal(account.unpaidAmount, 980);
  assert.equal(account.todayOrderAmount, 900);
  assert.equal(account.orderCount, 3);
  assert.equal(account.unpaidOrderCount, 2);
  assert.deepEqual({
    businessKey: log.businessKey,
    sourceType: log.sourceType,
    sourceId: log.sourceId,
    userId: log.userId,
    userOpenid: log.userOpenid,
    relatedOrderId: log.relatedOrderId,
    relatedPaymentRecordId: log.relatedPaymentRecordId,
    changeType: log.changeType,
    changeAmount: log.changeAmount,
    operatorId: log.operatorId,
    operatorOpenid: log.operatorOpenid,
    operatorRole: log.operatorRole
  }, {
    businessKey: "order_debt:o-1",
    sourceType: "order",
    sourceId: "o-1",
    userId: "u-new",
    userOpenid: "openid-existing",
    relatedOrderId: "o-1",
    relatedPaymentRecordId: "",
    changeType: "order_approved",
    changeAmount: 900,
    operatorId: "system",
    operatorOpenid: "",
    operatorRole: "system"
  });
});

test("shared account primitive reuses one valid debt log and fails closed on duplicate or conflicting rows", async () => {
  const approvedOrder = order();
  const validLog = {
    _id: "log-1",
    businessKey: "order_debt:o-1",
    sourceType: "order",
    sourceId: "o-1",
    userId: "u-new",
    userOpenid: "openid-existing",
    relatedOrderId: "o-1",
    relatedPaymentRecordId: "",
    changeType: "order_approved",
    changeAmount: 900
  };
  const account = {
    _id: "account-1",
    userId: "u-new",
    totalOrderAmount: 900,
    totalReceivableAmount: 900,
    totalUnpaidAmount: 900,
    unpaidAmount: 900,
    orderCount: 1,
    unpaidOrderCount: 1
  };

  const replay = store({
    customer_accounts: [account],
    account_logs: [validLog]
  });
  const reused = await includeApprovedOrderInTransaction({
    store: replay,
    order: approvedOrder,
    actor: actor(),
    amount: 900,
    timestamp: new Date("2026-07-23T08:00:00.000Z")
  });
  assert.equal(reused.reused, true);
  assert.equal(replay.snapshot().customer_accounts[0].totalOrderAmount, 900);
  assert.equal(replay.snapshot().account_logs.length, 1);

  for (const [logs, code] of [
    [[validLog, { ...validLog, _id: "log-2" }], "ACCOUNT_LOG_DUPLICATE"],
    [[{ ...validLog, changeAmount: 901 }], "ACCOUNT_LOG_CONFLICT"]
  ]) {
    const invalid = store({
      customer_accounts: [account],
      account_logs: logs
    });
    await assert.rejects(
      () => includeApprovedOrderInTransaction({
        store: invalid,
        order: approvedOrder,
        actor: actor(),
        amount: 900,
        timestamp: new Date("2026-07-23T08:00:00.000Z")
      }),
      (error) => error.code === code
    );
    assert.equal(invalid.snapshot().customer_accounts[0].totalOrderAmount, 900);
  }
});

test("shared account primitive derives todayDate from calendarDate instead of a ServerDate write placeholder", async () => {
  const current = store();
  const timestamp = { __serverDate: true };

  await includeApprovedOrderInTransaction({
    store: current,
    order: order(),
    actor: actor(),
    amount: 900,
    timestamp,
    calendarDate: new Date("2026-07-24T08:00:00.000Z")
  });

  const state = current.snapshot();
  assert.equal(state.customer_accounts[0].todayDate, "2026-07-24");
  assert.deepEqual(state.customer_accounts[0].lastOrderAt, timestamp);
  assert.deepEqual(state.customer_accounts[0].updatedAt, timestamp);
  assert.deepEqual(state.account_logs[0].createdAt, timestamp);
});

test("shared account primitive uses a fixed UTC+8 business date across host time zones", async () => {
  const originalTimezone = process.env.TZ;
  const cases = [
    ["2026-07-23T15:59:59.999Z", "2026-07-23"],
    ["2026-07-23T16:00:00.000Z", "2026-07-24"],
    ["2026-07-23T16:30:00.000Z", "2026-07-24"]
  ];

  try {
    for (const hostTimezone of ["UTC", "Asia/Shanghai"]) {
      process.env.TZ = hostTimezone;
      for (const [instant, expectedBusinessDate] of cases) {
        const current = store();
        const timestamp = new Date(instant);

        await includeApprovedOrderInTransaction({
          store: current,
          order: order(),
          actor: actor(),
          amount: 900,
          timestamp
        });

        assert.equal(
          current.snapshot().customer_accounts[0].todayDate,
          expectedBusinessDate,
          `${instant} should use UTC+8 under TZ=${hostTimezone}`
        );
      }
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("shared account primitive resolves canonical, sparse, and missing logs for both accountIncluded states", async () => {
  const canonical = {
    _id: "log-canonical",
    businessKey: "order_debt:o-1",
    sourceType: "order",
    sourceId: "o-1",
    userId: "u-new",
    userOpenid: "openid-existing",
    relatedOrderId: "o-1",
    relatedPaymentRecordId: "",
    changeType: "order_approved",
    changeAmount: 900
  };
  const sparse = {
    _id: "log-sparse",
    relatedOrderId: "o-1",
    changeType: "order_approved",
    changeAmount: 900
  };
  const existingAccount = {
    _id: "account-1",
    userId: "u-new",
    userOpenid: "openid-existing",
    totalOrderAmount: 900,
    totalReceivableAmount: 900,
    totalUnpaidAmount: 900,
    unpaidAmount: 900,
    orderCount: 1,
    unpaidOrderCount: 1
  };

  for (const accountIncluded of [false, true]) {
    const replay = store({
      customer_accounts: [existingAccount],
      account_logs: [canonical]
    });
    const reused = await includeApprovedOrderInTransaction({
      store: replay,
      order: order({ accountIncluded }),
      actor: actor(),
      amount: 900,
      timestamp: { __serverDate: true },
      calendarDate: new Date("2026-07-24T08:00:00.000Z")
    });
    assert.equal(reused.reused, true);
    assert.equal(replay.snapshot().customer_accounts[0].totalOrderAmount, 900);
    assert.equal(replay.snapshot().account_logs.length, 1);

    const legacyConflict = store({
      customer_accounts: [existingAccount],
      account_logs: [sparse]
    });
    await assert.rejects(
      () => includeApprovedOrderInTransaction({
        store: legacyConflict,
        order: order({ accountIncluded }),
        actor: actor(),
        amount: 900,
        timestamp: { __serverDate: true },
        calendarDate: new Date("2026-07-24T08:00:00.000Z")
      }),
      (error) => error.code === "ACCOUNT_LOG_LEGACY_CONFLICT"
    );
    assert.equal(legacyConflict.snapshot().customer_accounts[0].totalOrderAmount, 900);
    assert.equal(legacyConflict.snapshot().account_logs.length, 1);
  }

  const missingAllowed = store({ customer_accounts: [existingAccount] });
  const inserted = await includeApprovedOrderInTransaction({
    store: missingAllowed,
    order: order({ accountIncluded: false }),
    actor: actor(),
    amount: 900,
    timestamp: { __serverDate: true },
    calendarDate: new Date("2026-07-24T08:00:00.000Z")
  });
  assert.equal(inserted.reused, false);
  assert.equal(missingAllowed.snapshot().customer_accounts[0].totalOrderAmount, 1800);
  assert.equal(missingAllowed.snapshot().account_logs.length, 1);

  const missingConflict = store({ customer_accounts: [existingAccount] });
  await assert.rejects(
    () => includeApprovedOrderInTransaction({
      store: missingConflict,
      order: order({ accountIncluded: true }),
      actor: actor(),
      amount: 900,
      timestamp: { __serverDate: true },
      calendarDate: new Date("2026-07-24T08:00:00.000Z")
    }),
    (error) => error.code === "ORDER_ACCOUNT_STATE_CONFLICT"
  );
  assert.equal(missingConflict.snapshot().customer_accounts[0].totalOrderAmount, 900);
  assert.equal(missingConflict.snapshot().account_logs.length, 0);
});

test("shared account primitive rejects mixed canonical and sparse evidence instead of returning the canonical replay early", async () => {
  const current = store({
    customer_accounts: [{
      _id: "account-mixed",
      userId: "u-new",
      userOpenid: "openid-existing",
      totalOrderAmount: 900,
      totalReceivableAmount: 900,
      totalUnpaidAmount: 900,
      unpaidAmount: 900,
      orderCount: 1,
      unpaidOrderCount: 1
    }],
    account_logs: [{
      _id: "log-mixed-canonical",
      businessKey: "order_debt:o-1",
      sourceType: "order",
      sourceId: "o-1",
      userId: "u-new",
      userOpenid: "openid-existing",
      relatedOrderId: "o-1",
      relatedPaymentRecordId: "",
      changeType: "order_approved",
      changeAmount: 900
    }, {
      _id: "log-mixed-sparse",
      relatedOrderId: "o-1",
      changeType: "order_approved",
      changeAmount: 900
    }]
  });

  await assert.rejects(
    () => includeApprovedOrderInTransaction({
      store: current,
      order: order({ accountIncluded: true }),
      actor: actor(),
      amount: 900,
      timestamp: { __serverDate: true },
      calendarDate: new Date("2026-07-24T08:00:00.000Z")
    }),
    (error) => error.code === "ACCOUNT_LOG_DUPLICATE"
  );
  assert.equal(current.snapshot().customer_accounts[0].totalOrderAmount, 900);
  assert.equal(current.snapshot().account_logs.length, 2);
});

test("shared account evidence deduplicates one id-less canonical row across both queries and rejects two sparse rows", async () => {
  const canonicalWithoutId = {
    businessKey: "order_debt:o-1",
    sourceType: "order",
    sourceId: "o-1",
    userId: "u-new",
    userOpenid: "openid-existing",
    relatedOrderId: "o-1",
    relatedPaymentRecordId: "",
    changeType: "order_approved",
    changeAmount: 900
  };
  const replay = store({
    customer_accounts: [{
      _id: "account-idless",
      userId: "u-new",
      totalOrderAmount: 900,
      totalUnpaidAmount: 900,
      orderCount: 1,
      unpaidOrderCount: 1
    }],
    account_logs: [canonicalWithoutId]
  });
  const reused = await includeApprovedOrderInTransaction({
    store: replay,
    order: order({ accountIncluded: true }),
    actor: actor(),
    amount: 900,
    timestamp: { __serverDate: true },
    calendarDate: new Date("2026-07-24T08:00:00.000Z")
  });
  assert.equal(reused.reused, true);
  assert.equal(replay.snapshot().account_logs.length, 1);
  assert.equal(replay.snapshot().customer_accounts[0].totalOrderAmount, 900);

  const sparseDuplicates = store({
    customer_accounts: [{
      _id: "account-sparse-duplicates",
      userId: "u-new",
      totalOrderAmount: 900,
      totalUnpaidAmount: 900,
      orderCount: 1,
      unpaidOrderCount: 1
    }],
    account_logs: [{
      _id: "sparse-duplicate-1",
      relatedOrderId: "o-1",
      changeType: "order_approved",
      changeAmount: 900
    }, {
      _id: "sparse-duplicate-2",
      relatedOrderId: "o-1",
      changeType: "order_approved",
      changeAmount: 900
    }]
  });
  await assert.rejects(
    () => includeApprovedOrderInTransaction({
      store: sparseDuplicates,
      order: order(),
      actor: actor(),
      amount: 900,
      timestamp: { __serverDate: true },
      calendarDate: new Date("2026-07-24T08:00:00.000Z")
    }),
    (error) => error.code === "ACCOUNT_LOG_DUPLICATE"
  );
  assert.equal(sparseDuplicates.snapshot().account_logs.length, 2);
  assert.equal(sparseDuplicates.snapshot().customer_accounts[0].totalOrderAmount, 900);
});
