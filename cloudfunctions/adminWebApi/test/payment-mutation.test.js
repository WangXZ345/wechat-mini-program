"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const security = require("../../adminWebAuth/security");
const api = require("../index")._test;
const { parseHttpRoute } = require("../lib/core");

const tokenPepper = "p".repeat(32);
const csrfToken = "payment-review-csrf-token";
const config = { tokenPepper };
const expectedUpdatedAt = "2026-07-14T00:00:00.000Z";

function principal(role = "finance", permissions = ["payment:confirm", "payment:update_status"]) {
  return { id: `${role}-1`, role, status: "active", isActive: true, permissions };
}

function auth(role = "finance", permissions = ["payment:confirm", "payment:update_status"], overrides = {}) {
  const actor = { ...principal(role, permissions), ...(overrides.principal || {}) };
  return {
    principal: actor,
    rawAdmin: { _id: actor.id, openid: `trusted-${role}-openid`, role, status: "active", isActive: true },
    session: { csrfTokenHash: security.tokenHash(csrfToken, tokenPepper) }
  };
}

function request(action = "confirm", overrides = {}) {
  return {
    http: true,
    requestId: `request-payment-${action}`,
    route: { action: "mutate", resource: "payments", mutationAction: action },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": `payment-${action}-key-0001` },
    body: {
      paymentId: "payment-1",
      expectedStatus: "pending_confirm",
      expectedVersion: 2,
      expectedUpdatedAt,
      reason: action === "reject" ? "未核对到款项" : "已核对到账"
    },
    ...overrides
  };
}

function serviceResult(decision) {
  return {
    paymentId: "payment-1",
    orderNo: "ORDER-1",
    status: decision === "reject" ? "rejected" : "paid",
    version: 3,
    updatedAt: new Date("2026-07-14T00:01:00.000Z"),
    affected: 1,
    reused: false,
    decision,
    accountRecalculationPending: decision === "confirm",
    warning: "internal recalculation details",
    orderId: "private-order-id",
    userId: "private-user-id",
    proofUrl: "cloud://private-proof",
    journal: { amount: 32000 }
  };
}

test("payment confirm and reject routes call the canonical service with only session-derived actor and strict input", async () => {
  assert.deepEqual(parseHttpRoute("/api/admin/v1/payments/confirm", "POST"), { action: "mutate", resource: "payments", mutationAction: "confirm" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/payments/reject", "POST"), { action: "mutate", resource: "payments", mutationAction: "reject" });

  for (const action of ["confirm", "reject"]) {
    let received;
    const response = await api.dispatch(request(action), auth("finance", [action === "confirm" ? "payment:confirm" : "payment:update_status"]), config, {
      paymentMutationService: {
        async reviewWebPayment(command) {
          received = command;
          return serviceResult(action);
        }
      }
    });
    assert.deepEqual(received.input, {
      paymentId: "payment-1",
      decision: action,
      expectedStatus: "pending_confirm",
      expectedVersion: 2,
      expectedUpdatedAt,
      reason: action === "reject" ? "未核对到款项" : "已核对到账"
    });
    assert.equal(received.idempotencyKey, `payment-${action}-key-0001`);
    assert.deepEqual(received.actor, {
      id: "finance-1",
      openid: "trusted-finance-openid",
      role: "finance",
      permissions: [action === "confirm" ? "payment:confirm" : "payment:update_status"],
      status: "active",
      isActive: true,
      sourceClient: "admin_web"
    });
    assert.deepEqual(response, {
      item: {
        id: "payment-1",
        orderNo: "ORDER-1",
        status: action === "reject" ? "rejected" : "paid",
        version: 3,
        updatedAt: "2026-07-14T00:01:00.000Z"
      },
      affected: 1,
      reused: false,
      decision: action,
      accountRecalculationPending: action === "confirm",
      message: action === "reject" ? "付款凭证已驳回" : "付款已确认",
      requestId: `request-payment-${action}`
    });
    assert.equal(JSON.stringify(response).includes("private"), false);
    assert.equal(JSON.stringify(response).includes("32000"), false);
    assert.equal(JSON.stringify(response).includes("internal"), false);
  }
});

test("payment mutation body and idempotency header fail closed before the service", async () => {
  const forbiddenFields = ["id", "decision", "orderId", "amount", "paidAmount", "actor", "openid", "proofUrl", "transactionNo", "account", "unknown"];
  let calls = 0;
  const dependencies = { paymentMutationService: { async reviewWebPayment() { calls += 1; } } };
  for (const field of forbiddenFields) {
    await assert.rejects(
      () => api.dispatch(request("confirm", { body: { ...request("confirm").body, [field]: "forged" } }), auth("finance", ["payment:confirm"]), config, dependencies),
      (error) => error.code === "INVALID_REQUEST_BODY" && error.statusCode === 400
    );
  }
  await assert.rejects(
    () => api.dispatch(request("confirm", { headers: { "x-admin-csrf": csrfToken } }), auth("finance", ["payment:confirm"]), config, dependencies),
    (error) => error.code === "IDEMPOTENCY_KEY_REQUIRED" && error.statusCode === 400
  );
  assert.equal(calls, 0);
});

test("payment mutation requires exact snapshots and a reject reason", async () => {
  const cases = [
    [{ paymentId: "", expectedStatus: "pending_confirm", expectedVersion: 2, expectedUpdatedAt, reason: "" }, "PAYMENT_ID_REQUIRED"],
    [{ paymentId: "payment-1", expectedStatus: "paid", expectedVersion: 2, expectedUpdatedAt, reason: "" }, "EXPECTED_STATUS_INVALID"],
    [{ paymentId: "payment-1", expectedStatus: "pending_confirm", expectedVersion: -1, expectedUpdatedAt, reason: "" }, "EXPECTED_VERSION_INVALID"],
    [{ paymentId: "payment-1", expectedStatus: "pending_confirm", expectedVersion: 2, expectedUpdatedAt: "not-a-date", reason: "" }, "EXPECTED_UPDATED_AT_INVALID"]
  ];
  for (const [body, code] of cases) {
    await assert.rejects(
      () => api.dispatch(request("confirm", { body }), auth("finance", ["payment:confirm"]), config, { paymentMutationService: { async reviewWebPayment() { throw new Error("must not call"); } } }),
      (error) => error.code === code && error.statusCode === 400
    );
  }
  await assert.rejects(
    () => api.dispatch(request("reject", { body: { ...request("reject").body, reason: "   " } }), auth("finance", ["payment:update_status"]), config, { paymentMutationService: { async reviewWebPayment() { throw new Error("must not call"); } } }),
    (error) => error.code === "REASON_REQUIRED" && error.statusCode === 400
  );

  let received;
  const bodyWithoutReason = { ...request("confirm").body };
  delete bodyWithoutReason.reason;
  await api.dispatch(request("confirm", { body: bodyWithoutReason }), auth("finance", ["payment:confirm"]), config, {
    paymentMutationService: {
      async reviewWebPayment(command) {
        received = command;
        return serviceResult("confirm");
      }
    }
  });
  assert.equal(received.input.reason, "");
});

test("payment mutation hard-gates active finance and super_admin with the exact action permission", async () => {
  const service = { async reviewWebPayment({ input }) { return serviceResult(input.decision); } };
  await api.dispatch(request("confirm"), auth("finance", ["payment:confirm"]), config, { paymentMutationService: service });
  await api.dispatch(request("reject"), auth("super_admin", ["payment:update_status"]), config, { paymentMutationService: service });

  const forbidden = [
    auth("procurement", ["payment:confirm", "payment:update_status"]),
    auth("customer_service", ["payment:confirm", "payment:update_status"]),
    auth("finance", ["payment:update_status"]),
    auth("super_admin", []),
    auth("finance", ["payment:confirm"], { principal: { status: "disabled", isActive: false } })
  ];
  for (const actor of forbidden) {
    await assert.rejects(
      () => api.dispatch(request("confirm"), actor, config, { paymentMutationService: { async reviewWebPayment() { throw new Error("must not call"); } } }),
      (error) => error.code === "FORBIDDEN" && error.statusCode === 403
    );
  }
});

test("payment mutation validates CSRF before invoking the canonical service", async () => {
  let calls = 0;
  await assert.rejects(
    () => api.dispatch(
      request("confirm", { headers: { "x-admin-csrf": "wrong", "idempotency-key": "payment-confirm-key-0001" } }),
      auth("finance", ["payment:confirm"]),
      config,
      { paymentMutationService: { async reviewWebPayment() { calls += 1; } } }
    ),
    (error) => error.code === "CSRF_VALIDATION_FAILED" && error.statusCode === 403
  );
  assert.equal(calls, 0);
});

test("payment mutation maps canonical failures to fixed safe BFF errors", async () => {
  const cases = [
    ["UNKNOWN_FIELD", 400],
    ["FORBIDDEN", 403],
    ["PAYMENT_NOT_FOUND", 404],
    ["DATA_VERSION_CONFLICT", 409],
    ["SYNC_OWNER_CONFIG_REQUIRED", 503]
  ];
  for (const [code, statusCode] of cases) {
    const error = api.paymentMutationApiError({ code, statusCode: 418, message: "secret collection and proof URL" });
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.message.includes("secret"), false);
    assert.equal(error.message.includes("proof"), false);
  }
  const unknown = api.paymentMutationApiError({ code: "DATABASE_SECRET", message: "secret" });
  assert.equal(unknown.code, "PAYMENT_MUTATION_FAILED");
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.message.includes("secret"), false);
});

test("only payment confirm and reject leave the existing 501 migration gate", async () => {
  const response = await api.dispatch(request("confirm"), auth("finance", ["payment:confirm"]), config, {
    paymentMutationService: { async reviewWebPayment() { return serviceResult("confirm"); } }
  });
  assert.equal(response.item.status, "paid");
  await assert.rejects(
    () => api.dispatch({ ...request("confirm"), route: { action: "mutate", resource: "accounts", mutationAction: "export" } }, auth("super_admin", ["*"]), config),
    (error) => error.code === "SERVICE_NOT_MIGRATED" && error.statusCode === 501
  );
});

test("adminWebApi carries a byte-identical canonical payment mutation service", () => {
  const canonical = fs.readFileSync(path.join(__dirname, "../../common/services/paymentMutationService.js"));
  const deployable = fs.readFileSync(path.join(__dirname, "../lib/paymentMutationService.js"));
  assert.deepEqual(deployable, canonical);
});
