"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const security = require("../../adminWebAuth/security");
const api = require("../index")._test;
const { parseHttpRoute } = require("../lib/core");

const csrfToken = "after-sale-review-csrf-token";
const config = { tokenPepper: "p".repeat(32) };
const expectedUpdatedAt = "2026-07-16T08:00:00.000Z";

function auth(role = "customer_service", permissions = ["after_sale:review"]) {
  const actor = { id: `${role}-1`, role, status: "active", isActive: true, permissions };
  return {
    principal: actor,
    rawAdmin: { _id: actor.id, openid: `trusted-${role}-openid`, role, status: "active", isActive: true },
    session: { csrfTokenHash: security.tokenHash(csrfToken, config.tokenPepper) }
  };
}

function request(action = "approve", overrides = {}) {
  return {
    http: true,
    requestId: `request-after-sale-${action}`,
    route: { action: "mutate", resource: "after-sales", mutationAction: action },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": `after-sale-${action}-key-0001` },
    body: {
      afterSaleId: "as-1",
      expectedStatus: "pending_review",
      expectedVersion: 3,
      expectedUpdatedAt,
      approvedRefundAmount: action === "approve" ? 12800 : undefined,
      returnRequired: action === "approve" ? true : undefined,
      reason: action === "reject" ? "凭证不足" : "符合规则"
    },
    ...overrides
  };
}

function serviceResult(decision) {
  return {
    item: {
      id: "as-1",
      caseNo: "AS-001",
      status: decision === "reject" ? "rejected" : "waiting_return",
      version: 4,
      updatedAt: new Date("2026-07-16T08:01:00.000Z")
    },
    afterSaleId: "as-1",
    afterSaleStatus: decision === "reject" ? "rejected" : "waiting_return",
    refundStatus: decision === "reject" ? "rejected" : "pending",
    approvedRefundAmount: decision === "reject" ? 0 : 12800,
    affected: 1,
    reused: false,
    decision,
    orderId: "private-order",
    refundAccountInfo: { bank: "private" }
  };
}

test("after-sale approve and reject routes call the canonical service with strict input", async () => {
  assert.deepEqual(parseHttpRoute("/api/admin/v1/after-sales/approve", "POST"), { action: "mutate", resource: "after-sales", mutationAction: "approve" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/after-sales/reject", "POST"), { action: "mutate", resource: "after-sales", mutationAction: "reject" });
  for (const action of ["approve", "reject"]) {
    let received;
    const response = await api.dispatch(request(action), auth(), config, {
      afterSaleReviewService: {
        async reviewAfterSale(command) {
          received = command;
          return serviceResult(action);
        }
      }
    });
    assert.equal(received.input.id, "as-1");
    assert.equal(received.input.decision, action);
    assert.equal(received.input.expectedStatus, "pending_review");
    assert.equal(received.input.expectedVersion, 3);
    assert.equal(received.input.expectedUpdatedAt, expectedUpdatedAt);
    assert.equal(received.idempotencyKey, `after-sale-${action}-key-0001`);
    assert.equal(received.actor.id, "customer_service-1");
    assert.equal(received.actor.openid, "trusted-customer_service-openid");
    assert.equal(response.item.id, "as-1");
    assert.equal(response.item.status, action === "reject" ? "rejected" : "waiting_return");
    assert.equal(response.item.version, 4);
    assert.equal(response.affected, 1);
    assert.equal(JSON.stringify(response).includes("private"), false);
  }
});

test("after-sale review body rejects unknown fields before service", async () => {
  let calls = 0;
  await assert.rejects(
    () => api.dispatch(
      request("approve", { body: { ...request("approve").body, orderId: "forged" } }),
      auth(),
      config,
      { afterSaleReviewService: { async reviewAfterSale() { calls += 1; } } }
    ),
    (error) => error.code === "INVALID_REQUEST_BODY" && error.statusCode === 400
  );
  assert.equal(calls, 0);
});

test("after-sale review hard-gates finance and procurement", async () => {
  for (const role of ["finance", "procurement"]) {
    await assert.rejects(
      () => api.dispatch(request("approve"), auth(role, ["after_sale:review"]), config, {
        afterSaleReviewService: { async reviewAfterSale() { throw new Error("must not call"); } }
      }),
      (error) => error.code === "FORBIDDEN" && error.statusCode === 403
    );
  }
});

test("after-sale review maps canonical amount and optimistic-lock conflicts to safe 409 errors", async () => {
  for (const code of ["REFUND_AMOUNT_EXCEEDED", "DATA_VERSION_CONFLICT", "IDEMPOTENCY_KEY_CONFLICT"]) {
    const error = api.afterSaleReviewApiError({ code, statusCode: 418, message: "private implementation detail" });
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 409);
    assert.equal(error.message.includes("private"), false);
  }
});

test("after-sale reject requires a reason before invoking the service", async () => {
  let calls = 0;
  const body = { ...request("reject").body, reason: "   " };
  await assert.rejects(
    () => api.dispatch(request("reject", { body }), auth(), config, {
      afterSaleReviewService: { async reviewAfterSale() { calls += 1; } }
    }),
    (error) => error.code === "REASON_REQUIRED" && error.statusCode === 400
  );
  assert.equal(calls, 0);
});

test("after-sale approve rejects a non-integer refund amount with a readable message", async () => {
  const body = { ...request("approve").body, approvedRefundAmount: 12.5 };
  await assert.rejects(
    () => api.dispatch(request("approve", { body }), auth(), config, {
      afterSaleReviewService: { async reviewAfterSale() { throw new Error("must not call"); } }
    }),
    (error) => error.code === "REFUND_AMOUNT_INVALID"
      && error.statusCode === 400
      && error.message === "审批退款金额无效，必须是整数分"
  );
});

test("after-sale review maps unknown service failures and validates the public result", async () => {
  await assert.rejects(
    () => api.dispatch(request("approve"), auth(), config, {
      afterSaleReviewService: { async reviewAfterSale() { throw new Error("private collection detail"); } }
    }),
    (error) => error.code === "AFTER_SALE_REVIEW_FAILED" && error.statusCode === 503 && !error.message.includes("private")
  );
  await assert.rejects(
    () => api.dispatch(request("approve"), auth(), config, {
      afterSaleReviewService: { async reviewAfterSale() { return { item: { id: "as-1" } }; } }
    }),
    (error) => error.code === "INVALID_SERVICE_RESPONSE" && error.statusCode === 502
  );
});

test("unsupported after-sale actions remain closed", async () => {
  await assert.rejects(
    () => api.dispatch(request("complete"), auth("customer_service", ["after_sale:review"]), config),
    (error) => error.code === "MUTATION_NOT_SUPPORTED" && error.statusCode === 404
  );
});
