const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadMain({ account = null, actor = { role: "finance", permissions: ["customer:view_account"] }, service = null } = {}) {
  const permissionCalls = [];
  const reads = [];
  const collections = {
    customer_accounts: account ? [account] : [],
    users: [],
    orders: [{ _id: "order-1", userId: account && account.userId }],
    payment_records: [{ _id: "payment-1", userId: account && account.userId }],
    account_logs: [{ _id: "log-1", userId: account && account.userId }]
  };
  const db = {
    command: { neq(value) { return { neq: value }; } },
    collection(name) {
      reads.push(name);
      let rows = collections[name] || [];
      return {
        where(condition) { rows = rows.filter((row) => Object.entries(condition).every(([key, value]) => row[key] === value)); return this; },
        orderBy() { return this; },
        limit() { return this; },
        doc(id) { return { async get() { return { data: rows.find((row) => row._id === id) || null }; } }; },
        async get() { return { data: rows }; }
      };
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() { return db; },
    getWXContext() { return { OPENID: "admin-openid" }; }
  };
  const canonicalService = service || {
    async getLegacyAccountDetail() {
      if (!account) throw new Error("客户账款不存在");
      return {
        account,
        orders: collections.orders,
        paymentRecords: collections.payment_records,
        accountLogs: collections.account_logs
      };
    }
  };
  const filename = path.join(__dirname, "index.js");
  const code = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require(request) {
      if (request === "wx-server-sdk") return cloud;
      if (request === "./auth") return { async requirePermission(permission) { permissionCalls.push(permission); return actor; } };
      if (request === "./phone") return {
        canViewFullPhone() { return false; },
        canViewMaskedPhone() { return true; },
        maskPhone() { return "138****5678"; }
      };
      if (request === "./accountQueryService") return { createAccountQueryService() { return canonicalService; } };
      throw new Error(`Unexpected require: ${request}`);
    },
    __dirname,
    __filename: filename,
    Buffer,
    console,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    RegExp,
    Promise,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(code, sandbox, { filename });
  return { main: module.exports.main, permissionCalls, reads };
}

test("legacy detail wrapper keeps customer:view_account and four established data keys", async () => {
  const { main, permissionCalls } = loadMain({ account: { _id: "a-1", userId: "u-1" } });
  const result = await main({ accountId: "a-1" });
  assert.equal(result.ok, true);
  assert.deepEqual(permissionCalls, ["customer:view_account"]);
  assert.deepEqual(Object.keys(result.data).sort(), ["account", "accountLogs", "orders", "paymentRecords"].sort());
});

test("legacy detail wrapper keeps the not-found failure envelope", async () => {
  const { main } = loadMain({ account: null });
  const result = await main({ accountId: "missing" });
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, "string");
});

test("legacy detail wrapper delegates accountId/userId/userOpenid selectors to canonical service", async () => {
  const calls = [];
  const expected = { account: { _id: "a-1" }, orders: [], paymentRecords: [], accountLogs: [] };
  const service = {
    async getLegacyAccountDetail(input) { calls.push(input); return expected; }
  };
  const actor = { role: "finance", permissions: ["customer:view_account"] };
  const event = { accountId: "a-1", userId: "u-1", userOpenid: "openid-1", ignored: "kept-out" };
  const { main } = loadMain({ actor, service });
  assert.deepEqual(JSON.parse(JSON.stringify(await main(event))), { ok: true, data: expected });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor, actor);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].selector)), { accountId: "a-1", userId: "u-1", userOpenid: "openid-1" });
});
