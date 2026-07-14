const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const api = require("../index");
const { parseHttpRoute } = require("../lib/core");

const { dispatch, paymentQueryApiError } = api._test;

function principal(overrides = {}) {
  return { id: "admin-finance-1", role: "finance", status: "active", isActive: true, permissions: ["payment:view_screenshot"], ...overrides };
}
function auth(actor = principal()) { return { principal: actor, rawAdmin: { _id: actor.id }, session: {} }; }

test("payment list and detail use the canonical read service with the session principal", async () => {
  const calls = [];
  const paymentQueryService = {
    async listWebPayments(input) { calls.push(["list", input]); return { items: [], pageSize: 20, hasMore: false, nextCursor: null }; },
    async getWebPayment(input) { calls.push(["detail", input]); return { id: "pay-1" }; }
  };
  assert.deepEqual(parseHttpRoute("/api/admin/v1/payments", "GET"), { action: "paymentList" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/payments/pay-1", "GET"), { action: "paymentDetail", id: "pay-1" });
  await dispatch({ route: { action: "paymentList" }, query: { status: "pending_confirm" } }, auth(), {}, { paymentQueryService });
  await dispatch({ route: { action: "paymentDetail", id: "pay-1" }, query: {} }, auth(), {}, { paymentQueryService });
  assert.equal(calls[0][1].actor.role, "finance");
  assert.deepEqual(calls[0][1].query, { status: "pending_confirm" });
  assert.equal(calls[1][1].id, "pay-1");
});

test("payment reads reject non-finance roles and injected missing permission", async () => {
  const paymentQueryService = { async listWebPayments() { throw new Error("must not call"); } };
  for (const actor of [principal({ role: "procurement" }), principal({ role: "customer_service" }), principal({ permissions: [] }), principal({ status: "disabled", isActive: false })]) {
    await assert.rejects(() => dispatch({ route: { action: "paymentList" }, query: {} }, auth(actor), {}, { paymentQueryService }), (error) => error.code === "FORBIDDEN" && error.statusCode === 403);
  }
});

test("payment query errors map to fixed safe messages", () => {
  for (const [code, statusCode] of [["PAYMENT_QUERY_INVALID", 400], ["PAYMENT_CURSOR_INVALID", 400], ["PAYMENT_DATA_INVALID", 503], ["FORBIDDEN", 403], ["PAYMENT_NOT_FOUND", 404], ["PAYMENT_READ_FAILED", 503]]) {
    const error = paymentQueryApiError({ code, statusCode: 418, message: "secret collection details" });
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.message.includes("secret"), false);
  }
});

test("guarded packaging includes the canonical payment query service hash gate", () => {
  const script = fs.readFileSync(path.join(__dirname, "../../../scripts/package-admin-web-cloudfunctions.ps1"), "utf8");
  assert.match(script, /canonicalPaymentQueryServiceSha256/);
  assert.match(script, /PaymentQueryServiceHashVerified/);
  const canonical = fs.readFileSync(path.join(__dirname, "../../common/services/paymentQueryService.js"));
  const deployable = fs.readFileSync(path.join(__dirname, "../lib/paymentQueryService.js"));
  assert.deepEqual(deployable, Buffer.from('module.exports = require("../../common/services/paymentQueryService");\n'));
  assert.ok(canonical.length > 1000);
});
