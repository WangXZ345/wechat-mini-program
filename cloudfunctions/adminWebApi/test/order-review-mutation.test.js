"use strict";

const assert = require("assert");
const test = require("node:test");
const security = require("../../adminWebAuth/security");
const api = require("../index")._test;

function request(action, body = {}, key = "review-key") {
  return { route: { resource: "orders", mutationAction: action }, body, headers: { "idempotency-key": key } };
}

assert.equal(api.orderReviewRoute({ resource: "orders", mutationAction: "review" }), true);
assert.equal(api.orderReviewRoute({ resource: "products", mutationAction: "review" }), false);
assert.deepEqual(api.normalizeOrderReviewMutation(request("review", { id: "o-1", expectedVersion: 2, expectedStatus: "pending_admin" })), {
  idempotencyKey: "review-key",
  input: { id: "o-1", decision: "approve", expectedVersion: 2, expectedStatus: "pending_admin", reason: "" }
});
assert.throws(() => api.normalizeOrderReviewMutation(request("reject", { id: "o-1", expectedVersion: 2, expectedStatus: "pending_admin", extra: true })), /不允许/);
assert.throws(() => api.normalizeOrderReviewMutation(request("reject", { id: "o-1", expectedVersion: 2, expectedStatus: "pending_admin" })), /驳回原因/);
assert.throws(() => api.normalizeOrderReviewMutation(request("review", { id: "o-1", expectedVersion: 2, expectedStatus: "approved_pending_payment" })), /当前状态无效/);
const result = api.orderReviewMutationResult({ item: { id: "o-1", orderNo: "NO-1", status: "approved_pending_payment", reviewType: "manual", paymentStatus: "unpaid", version: 3, updatedAt: new Date() }, affected: 1, decision: "approve" }, "req-1");
assert.deepEqual(Object.keys(result).sort(), ["affected", "decision", "item", "message", "requestId", "reused"].sort());
assert.equal(result.item.id, "o-1");
assert.equal(result.message, "订单已审核通过");
const pendingRecalculation = api.orderReviewMutationResult({ item: { id: "o-1", status: "approved_pending_payment", version: 3 }, affected: 1, decision: "approve", accountRecalculationPending: true, warning: "internal-sensitive-detail" }, "req-2");
assert.equal(pendingRecalculation.accountRecalculationPending, true);
assert.equal(pendingRecalculation.warning, "订单已审核，客户账款汇总将在稍后更新");
assert.equal(pendingRecalculation.message, "订单已审核通过");
assert.equal(JSON.stringify(pendingRecalculation).includes("internal-sensitive-detail"), false);
const rejected = api.orderReviewMutationResult({ item: { id: "o-2", status: "rejected", version: 2 }, affected: 1, decision: "reject", message: "internal-sensitive-detail" }, "req-3");
assert.equal(rejected.message, "订单已驳回");
assert.equal(JSON.stringify(rejected).includes("internal-sensitive-detail"), false);

const tokenPepper = "t".repeat(32);
const csrfToken = "csrf-review-token";
const config = { tokenPepper };

function auth(role, permissions) {
  return {
    principal: { id: `${role}-1`, openid: `${role}-openid`, role, status: "active", isActive: true, permissions },
    rawAdmin: { _id: `${role}-1`, openid: `${role}-openid`, role, status: "active", isActive: true, permissions },
    session: { csrfTokenHash: security.tokenHash(csrfToken, tokenPepper) }
  };
}

function dispatchRequest(action, overrides = {}) {
  return {
    http: true,
    requestId: `req-${action}`,
    route: { action: "mutate", resource: "orders", mutationAction: action },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": `key-${action}` },
    body: {
      id: "o-1",
      expectedVersion: 2,
      expectedStatus: "pending_admin",
      ...(action === "reject" ? { reason: "资料不完整" } : {})
    },
    ...overrides
  };
}

test("dispatch approves and rejects with permission, CSRF, and the strict service contract", async () => {
  for (const action of ["review", "reject"]) {
    let received;
    const response = await api.dispatch(
      dispatchRequest(action),
      auth("customer_service", [action === "review" ? "order:review" : "order:reject"]),
      config,
      { orderReviewService: { async reviewOrder(command) { received = command; return { item: { id: "o-1", orderNo: "NO-1", status: action === "review" ? "approved_pending_payment" : "rejected", reviewType: "manual", paymentStatus: "unpaid", version: 3, updatedAt: new Date() }, affected: 1, reused: false, decision: action === "review" ? "approve" : "reject" }; } } }
    );
    assert.equal(received.strict, true);
    assert.equal(received.idempotencyKey, `key-${action}`);
    assert.equal(received.input.decision, action === "review" ? "approve" : "reject");
    assert.equal(received.input.expectedVersion, 2);
    assert.equal(received.actor.role, "customer_service");
    assert.equal(response.item.id, "o-1");
    assert.equal(Object.hasOwn(response.item, "userOpenid"), false);
  }
});

test("dispatch rejects missing permissions and invalid CSRF before invoking the service", async () => {
  let calls = 0;
  const dependency = { orderReviewService: { async reviewOrder() { calls += 1; } } };
  await assert.rejects(() => api.dispatch(dispatchRequest("review"), auth("finance", ["order:view"]), config, dependency), (error) => error.code === "FORBIDDEN" && error.statusCode === 403);
  await assert.rejects(() => api.dispatch(dispatchRequest("review", { headers: { "x-admin-csrf": "wrong", "idempotency-key": "key-review" } }), auth("customer_service", ["order:review"]), config, dependency), (error) => error.code === "CSRF_VALIDATION_FAILED" && error.statusCode === 403);
  assert.equal(calls, 0);
});

test("dispatch maps fail-closed order review conflicts without leaking internal errors", async () => {
  for (const code of ["ACCOUNT_LOG_DUPLICATE", "ACCOUNT_LOG_CONFLICT", "ORDER_ACCOUNT_STATE_CONFLICT", "INVENTORY_LOG_DUPLICATE"]) {
    await assert.rejects(
      () => api.dispatch(dispatchRequest("review"), auth("customer_service", ["order:review"]), config, { orderReviewService: { async reviewOrder() { const error = new Error("internal-sensitive-detail"); error.code = code; error.statusCode = 409; throw error; } } }),
      (error) => error.code === code && error.statusCode === 409 && !error.message.includes("internal-sensitive-detail")
    );
  }
});
