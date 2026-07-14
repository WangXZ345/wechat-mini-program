const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadMain({ rows = [], actor = { role: "finance", permissions: ["customer:view_basic", "customer:view_account"] }, service = null } = {}) {
  const permissionCalls = [];
  const reads = [];
  const db = {
    command: { neq(value) { return { neq: value }; } },
    collection(name) {
      reads.push(name);
      return {
        orderBy() { return this; },
        limit() { return this; },
        where() { return this; },
        doc() { return { async get() { return { data: null }; } }; },
        async get() { return { data: name === "customer_accounts" ? rows : [] }; }
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
    async listLegacyAccounts({ query }) {
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.max(1, Number(query.pageSize) || 100);
      const start = (page - 1) * pageSize;
      return { accounts: rows.slice(start, start + pageSize), page, pageSize, hasMore: start + pageSize < rows.length, total: rows.length };
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
        canSearchByPhone() { return false; },
        maskPhone() { return "138****5678"; }
      };
      if (request === "./sanitize") return { sanitizeCustomerAccountForRole(row) { return row; } };
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
    parseInt,
    RegExp,
    Promise,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(code, sandbox, { filename });
  return { main: module.exports.main, permissionCalls, reads };
}

test("legacy list wrapper keeps customer:view_basic and {ok,data.accounts,page,pageSize,hasMore,total}", async () => {
  const { main, permissionCalls } = loadMain({ rows: [{ _id: "a-1", updatedAt: new Date(), totalUnpaidAmount: 100 }] });
  const result = await main({ filter: "all", keyword: "", sortBy: "unpaid", page: 1, pageSize: 20 });
  assert.equal(result.ok, true);
  assert.deepEqual(permissionCalls, ["customer:view_basic"]);
  assert.deepEqual(Object.keys(result.data).sort(), ["accounts", "hasMore", "page", "pageSize", "total"].sort());
  assert.equal(result.data.page, 1);
  assert.equal(result.data.pageSize, 20);
});

test("legacy list wrapper returns the established failure envelope", async () => {
  const { main } = loadMain({ rows: [] });
  const result = await main({});
  assert.equal(typeof result.ok, "boolean");
  assert.equal(result.ok, true);
});

test("legacy list wrapper delegates the unchanged event and actor to canonical service", async () => {
  const calls = [];
  const expected = { accounts: [{ _id: "canonical" }], page: 3, pageSize: 7, hasMore: false, total: 1 };
  const service = {
    async listLegacyAccounts(input) { calls.push(input); return expected; }
  };
  const actor = { role: "finance", permissions: ["customer:view_basic", "customer:view_account"] };
  const event = { filter: "pending", keyword: "张", sortBy: "today", page: 3, pageSize: 7 };
  const { main } = loadMain({ actor, service });
  assert.deepEqual(JSON.parse(JSON.stringify(await main(event))), { ok: true, data: expected });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor, actor);
  assert.deepEqual(calls[0].query, event);
});
