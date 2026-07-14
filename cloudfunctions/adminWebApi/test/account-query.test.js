const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const security = require("../security");
const api = require("../index");
const { parseHttpRoute } = require("../lib/core");

const { dispatch, accountQueryApiError } = api._test;

function principal(overrides = {}) {
  return {
    id: "admin-finance-1",
    role: "finance",
    status: "active",
    isActive: true,
    permissions: ["customer:view_account"],
    ...overrides
  };
}

function auth(actor = principal()) {
  return { principal: actor, rawAdmin: { _id: actor.id }, session: {} };
}

test("account GET routes are parsed before generic resource routes", () => {
  assert.deepEqual(parseHttpRoute("/api/admin/v1/accounts", "GET"), { action: "accountList" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/accounts/account-1", "GET"), {
    action: "accountDetail",
    id: "account-1"
  });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/accounts/export", "POST"), {
    action: "mutate",
    resource: "accounts",
    mutationAction: "export"
  });
});

test("account list and detail pass the authenticated principal to the canonical service", async () => {
  const calls = [];
  const accountQueryService = {
    async listWebAccounts(input) {
      calls.push(["list", input]);
      return { items: [{ id: "account-1" }], pageSize: 20, hasMore: false, nextCursor: null };
    },
    async getWebAccount(input) {
      calls.push(["detail", input]);
      return { account: { id: "account-1" }, orders: [], logs: [] };
    }
  };
  const actor = principal();
  const list = await dispatch(
    { route: { action: "accountList" }, query: { status: "unpaid" } },
    auth(actor),
    {},
    { accountQueryService }
  );
  const detail = await dispatch(
    { route: { action: "accountDetail", id: "account-1" }, query: {} },
    auth(actor),
    {},
    { accountQueryService }
  );

  assert.equal(list.items[0].id, "account-1");
  assert.equal(detail.account.id, "account-1");
  assert.equal(calls[0][1].actor, actor);
  assert.deepEqual(calls[0][1].query, { status: "unpaid" });
  assert.equal(calls[1][1].actor, actor);
  assert.equal(calls[1][1].id, "account-1");
});

test("only active finance or super_admin with customer account permission can reach the service", async () => {
  let calls = 0;
  const dependencies = {
    accountQueryService: {
      async listWebAccounts() { calls += 1; },
      async getWebAccount() { calls += 1; }
    }
  };
  const denied = [
    principal({ role: "procurement" }),
    principal({ role: "customer_service" }),
    principal({ permissions: [] }),
    principal({ status: "disabled", isActive: false }),
    principal({ role: "invalid-role" })
  ];
  for (const actor of denied) {
    await assert.rejects(
      dispatch({ route: { action: "accountList" }, query: {} }, auth(actor), {}, dependencies),
      (error) => error.code === "FORBIDDEN" && error.statusCode === 403
    );
  }
  await dispatch(
    { route: { action: "accountList" }, query: {} },
    auth(principal({ role: "super_admin", permissions: ["*"] })),
    {},
    dependencies
  );
  assert.equal(calls, 1);
});

test("known account query errors expose fixed safe messages", () => {
  for (const [code, statusCode] of [
    ["ACCOUNT_QUERY_INVALID", 400],
    ["ACCOUNT_CURSOR_INVALID", 400],
    ["ACCOUNT_DATA_INVALID", 503],
    ["FORBIDDEN", 403],
    ["ACCOUNT_NOT_FOUND", 404],
    ["ACCOUNT_READ_FAILED", 503]
  ]) {
    const mapped = accountQueryApiError({ code, statusCode: 418, message: "raw collection and index failure" });
    assert.equal(mapped.code, code);
    assert.equal(mapped.statusCode, statusCode);
    assert.equal(mapped.message.includes("raw collection"), false);
  }
  const unknown = accountQueryApiError(new Error("secret database message"));
  assert.equal(unknown.code, "ACCOUNT_READ_FAILED");
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.message.includes("secret"), false);
});

test("account export stays permission and CSRF protected then returns 501", async () => {
  const tokenPepper = "a".repeat(32);
  const csrfToken = "account-csrf-token";
  const mutationAuth = auth(principal({ permissions: ["customer:view_account", "customer:export_account"] }));
  mutationAuth.session.csrfTokenHash = security.tokenHash(csrfToken, tokenPepper);
  await assert.rejects(
    dispatch({
      route: { action: "mutate", resource: "accounts", mutationAction: "export" },
      headers: { "x-admin-csrf": csrfToken },
      http: true
    }, mutationAuth, { tokenPepper }),
    (error) => error.code === "SERVICE_NOT_MIGRATED" && error.statusCode === 501
  );
});

test("guarded packaging declares account adapters and canonical account query hash gates", () => {
  const script = fs.readFileSync(path.join(__dirname, "../../../scripts/package-admin-web-cloudfunctions.ps1"), "utf8");
  assert.match(script, /adminListCustomerAccounts/);
  assert.match(script, /adminGetCustomerAccountDetail/);
  assert.match(script, /canonicalAccountQueryServiceSha256/);
  assert.match(script, /AccountQueryServiceHashVerified/);
  assert.match(script, /uploadPerformed\s*=\s*\$false/);
});

test("deployable account query service copies are canonical byte copies", () => {
  const canonical = fs.readFileSync(path.join(__dirname, "../../common/services/accountQueryService.js"));
  for (const relative of [
    "../lib/accountQueryService.js",
    "../../adminListCustomerAccounts/accountQueryService.js",
    "../../adminGetCustomerAccountDetail/accountQueryService.js"
  ]) {
    assert.deepEqual(fs.readFileSync(path.join(__dirname, relative)), canonical, relative);
  }
});
