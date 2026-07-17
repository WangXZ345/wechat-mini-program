"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function database(initial = {}) {
  const state = structuredClone(initial);
  let nextId = 1;

  function matches(row, where = {}) {
    return Object.entries(where).every(([field, value]) => {
      if (value && value.__operation === "neq") return row[field] !== value.value;
      return row[field] === value;
    });
  }

  function collection(name) {
    if (!state[name]) state[name] = [];
    const queryState = { where: {}, limit: Infinity };
    const query = {
      where(where) {
        queryState.where = where || {};
        return query;
      },
      orderBy() {
        return query;
      },
      limit(limit) {
        queryState.limit = limit;
        return query;
      },
      async get() {
        return {
          data: state[name]
            .filter((row) => matches(row, queryState.where))
            .slice(0, queryState.limit)
            .map((row) => structuredClone(row))
        };
      },
      async add({ data }) {
        const id = data._id || `${name}-${nextId++}`;
        state[name].push({ ...structuredClone(data), _id: id });
        return { _id: id };
      },
      doc(id) {
        return {
          async get() {
            const row = state[name].find((item) => item._id === id);
            return { data: row ? structuredClone(row) : null };
          },
          async update({ data }) {
            const row = state[name].find((item) => item._id === id);
            if (!row) throw new Error("document not found");
            Object.assign(row, structuredClone(data));
            return { stats: { updated: 1 } };
          }
        };
      }
    };
    return query;
  }

  return {
    command: {
      neq(value) {
        return { __operation: "neq", value };
      }
    },
    serverDate() {
      return new Date("2026-07-17T00:00:00.000Z");
    },
    collection,
    snapshot() {
      return structuredClone(state);
    }
  };
}

function loadMain(db, callerOpenid = "finance-openid") {
  const indexPath = require.resolve("./index.js");
  const originalLoad = Module._load;
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
          return { OPENID: callerOpenid };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(indexPath).main;
  } finally {
    Module._load = originalLoad;
  }
}

test("admin recalculation resolves the immutable accountId instead of mutable event identity", async () => {
  const db = database({
    admin_users: [{
      _id: "finance-1",
      openid: "finance-openid",
      role: "finance",
      status: "active",
      isActive: true
    }],
    users: [],
    customer_accounts: [{
      _id: "account-1",
      userId: "user-original",
      userOpenid: "openid-original",
      nickname: "Original",
      totalOrderAmount: 0,
      totalPaidAmount: 0,
      totalUnpaidAmount: 0
    }],
    orders: [{
      _id: "order-1",
      userId: "user-original",
      userOpenid: "openid-original",
      status: "paid",
      paymentStatus: "paid",
      totalAmount: 1000,
      paidAmount: 1000,
      createdAt: new Date("2026-07-16T00:00:00.000Z")
    }]
  });
  const main = loadMain(db);
  const result = await main({
    accountId: "account-1",
    userId: "user-new",
    userOpenid: "openid-new"
  });
  const state = db.snapshot();
  assert.equal(result.ok, true);
  assert.equal(result.data.accountId, "account-1");
  assert.equal(result.data.account.userId, "user-original");
  assert.equal(result.data.account.userOpenid, "openid-original");
  assert.equal(state.customer_accounts.length, 1);
  assert.equal(state.customer_accounts[0].userId, "user-original");
  assert.equal(state.customer_accounts[0].userOpenid, "openid-original");
  assert.equal(state.customer_accounts[0].totalPaidAmount, 1000);
});

test("non-admin recalculation ignores another customer's injected accountId", async () => {
  const db = database({
    admin_users: [],
    users: [
      {
        _id: "user-caller",
        openid: "openid-caller",
        nickname: "Caller"
      },
      {
        _id: "user-other",
        openid: "openid-other",
        nickname: "Other"
      }
    ],
    customer_accounts: [
      {
        _id: "account-caller",
        userId: "user-caller",
        userOpenid: "openid-caller",
        totalOrderAmount: 0,
        totalPaidAmount: 0,
        totalUnpaidAmount: 0
      },
      {
        _id: "account-other",
        userId: "user-other",
        userOpenid: "openid-other",
        totalOrderAmount: 9900,
        totalPaidAmount: 9900,
        totalUnpaidAmount: 0
      }
    ],
    orders: [
      {
        _id: "order-caller",
        userId: "user-caller",
        userOpenid: "openid-caller",
        status: "paid",
        paymentStatus: "paid",
        totalAmount: 1200,
        paidAmount: 1200,
        createdAt: new Date("2026-07-16T00:00:00.000Z")
      },
      {
        _id: "order-other",
        userId: "user-other",
        userOpenid: "openid-other",
        status: "paid",
        paymentStatus: "paid",
        totalAmount: 9900,
        paidAmount: 9900,
        createdAt: new Date("2026-07-16T00:00:00.000Z")
      }
    ]
  });
  const main = loadMain(db, "openid-caller");

  const result = await main({
    accountId: "account-other",
    userId: "user-other",
    userOpenid: "openid-other",
    openid: "openid-other"
  });
  const state = db.snapshot();
  const callerAccount = state.customer_accounts.find((row) => row._id === "account-caller");
  const otherAccount = state.customer_accounts.find((row) => row._id === "account-other");

  assert.equal(result.ok, true);
  assert.equal(result.data.accountId, "account-caller");
  assert.equal("userId" in result.data.account, false);
  assert.equal("userOpenid" in result.data.account, false);
  assert.equal(callerAccount.totalPaidAmount, 1200);
  assert.equal(otherAccount.totalPaidAmount, 9900);
});
