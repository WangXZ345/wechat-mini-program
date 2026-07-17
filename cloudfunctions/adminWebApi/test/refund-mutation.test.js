"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const security = require("../../adminWebAuth/security");
const api = require("../index")._test;
const { parseHttpRoute } = require("../lib/core");

const csrfToken = "refund-mutation-csrf-token";
const config = { tokenPepper: "p".repeat(32) };
const expectedUpdatedAt = "2026-07-17T08:00:00.000Z";

function auth(role = "finance", permissions = ["refund:process"], overrides = {}) {
  const principal = {
    id: `${role}-1`,
    role,
    status: "active",
    isActive: true,
    permissions,
    ...(overrides.principal || {})
  };
  return {
    principal,
    rawAdmin: {
      _id: principal.id,
      openid: `trusted-${role}-openid`,
      role,
      status: "active",
      isActive: true,
      ...(overrides.rawAdmin || {})
    },
    session: { csrfTokenHash: security.tokenHash(csrfToken, config.tokenPepper) }
  };
}

function bodyFor(action) {
  if (action === "reject") {
    return {
      refundRecordId: "refund-1",
      expectedRefundStatus: "pending",
      expectedRefundVersion: 2,
      expectedRefundUpdatedAt: expectedUpdatedAt,
      rejectReason: "退款资料不完整"
    };
  }
  return {
    refundRecordId: "refund-1",
    refundAmountCents: 300,
    expectedRefundStatus: "pending",
    expectedRefundVersion: 2,
    expectedRefundUpdatedAt: expectedUpdatedAt,
    financeRemark: "线下退款已核对",
    refundProofFileIds: ["cloud://env.refund-proof-1"]
  };
}

function request(action = "process", overrides = {}) {
  return {
    http: true,
    requestId: `request-refund-${action}`,
    route: { action: "mutate", resource: "refunds", mutationAction: action },
    headers: {
      "x-admin-csrf": csrfToken,
      "idempotency-key": `refund-${action}-key-0001`
    },
    body: bodyFor(action),
    ...overrides
  };
}

function serviceResult(action) {
  return {
    item: {
      id: "refund-1",
      refundNo: "RF-001",
      status: action === "reject" ? "rejected" : "refunded",
      version: 3,
      updatedAt: new Date("2026-07-17T08:01:00.000Z"),
      amountCents: 300,
      userId: "private-user-id",
      openid: "private-openid",
      refundProofFileIds: ["cloud://private-proof"]
    },
    affected: 1,
    reused: false,
    action,
    accountRecalculationPending: action === "process",
    userId: "private-user-id",
    openid: "private-openid",
    journal: { private: true }
  };
}

function serviceWith(resultFactory = serviceResult) {
  return {
    async processOfflineRefund(command) {
      return typeof resultFactory === "function" ? resultFactory("process", command) : resultFactory;
    },
    async rejectRefund(command) {
      return typeof resultFactory === "function" ? resultFactory("reject", command) : resultFactory;
    }
  };
}

test("refund process and reject routes call the canonical service with strict session-derived commands", async () => {
  assert.deepEqual(parseHttpRoute("/api/admin/v1/refunds/process", "POST"), {
    action: "mutate", resource: "refunds", mutationAction: "process"
  });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/refunds/reject", "POST"), {
    action: "mutate", resource: "refunds", mutationAction: "reject"
  });

  for (const action of ["process", "reject"]) {
    let received;
    const result = await api.dispatch(request(action), auth(), config, {
      refundMutationService: serviceWith((serviceAction, command) => {
        received = command;
        return serviceResult(serviceAction);
      })
    });

    assert.deepEqual(received.input, bodyFor(action));
    assert.equal(received.idempotencyKey, `refund-${action}-key-0001`);
    assert.equal(received.strict, true);
    assert.deepEqual(received.actor, {
      id: "finance-1",
      openid: "trusted-finance-openid",
      role: "finance",
      status: "active",
      isActive: true,
      sourceClient: "admin_web"
    });
    assert.equal(result.item.status, action === "reject" ? "rejected" : "refunded");
    assert.equal(result.item.version, 3);
    assert.equal(result.item.updatedAt, "2026-07-17T08:01:00.000Z");
    assert.equal(result.action, action);
    assert.equal("userId" in result, false);
    assert.equal("openid" in result, false);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(JSON.stringify(result).includes("cloud://"), false);
  }
});

test("refund process preserves existing optional fields when the request omits them", async () => {
  const body = { ...bodyFor("process") };
  delete body.financeRemark;
  delete body.refundProofFileIds;
  let received;

  await api.dispatch(request("process", { body }), auth(), config, {
    refundMutationService: serviceWith((action, command) => {
      received = command;
      return serviceResult(action);
    })
  });

  assert.equal(Object.hasOwn(received.input, "financeRemark"), false);
  assert.equal(Object.hasOwn(received.input, "refundProofFileIds"), false);
});

test("refund mutations hard-gate active finance and super_admin even with injected permissions", async () => {
  await api.dispatch(request("process"), auth("finance", ["refund:process"]), config, {
    refundMutationService: serviceWith()
  });
  await api.dispatch(request("reject"), auth("super_admin", ["*"]), config, {
    refundMutationService: serviceWith()
  });

  for (const actor of [
    auth("customer_service", ["refund:process"]),
    auth("procurement", ["refund:process"]),
    auth("ordinary_user", ["refund:process"]),
    auth("finance", ["refund:process"], { principal: { status: "disabled", isActive: false } })
  ]) {
    let calls = 0;
    await assert.rejects(
      () => api.dispatch(request("process"), actor, config, {
        refundMutationService: serviceWith(() => {
          calls += 1;
          return serviceResult("process");
        })
      }),
      (error) => error.code === "FORBIDDEN" && error.statusCode === 403
    );
    assert.equal(calls, 0);
  }
});

test("refund mutations validate CSRF before invoking the service", async () => {
  let calls = 0;
  await assert.rejects(
    () => api.dispatch(request("process", {
      headers: {
        "x-admin-csrf": "wrong",
        "idempotency-key": "refund-process-key-0001"
      }
    }), auth(), config, {
      refundMutationService: serviceWith(() => {
        calls += 1;
        return serviceResult("process");
      })
    }),
    (error) => error.code === "CSRF_VALIDATION_FAILED" && error.statusCode === 403
  );
  assert.equal(calls, 0);
});

test("refund mutation DTO requires idempotency and complete optimistic snapshots", async () => {
  const missingStatus = { ...bodyFor("process") };
  const missingVersion = { ...bodyFor("process") };
  const missingUpdatedAt = { ...bodyFor("process") };
  delete missingStatus.expectedRefundStatus;
  delete missingVersion.expectedRefundVersion;
  delete missingUpdatedAt.expectedRefundUpdatedAt;
  const invalid = [
    ["process", { ...bodyFor("process"), refundRecordId: "" }, "REFUND_RECORD_ID_REQUIRED"],
    ["process", { ...bodyFor("process"), refundAmountCents: 1.5 }, "INVALID_REFUND_AMOUNT"],
    ["process", missingStatus, "EXPECTED_REFUND_STATUS_REQUIRED"],
    ["process", { ...bodyFor("process"), expectedRefundStatus: "refunded" }, "EXPECTED_REFUND_STATUS_INVALID"],
    ["process", missingVersion, "EXPECTED_REFUND_VERSION_REQUIRED"],
    ["process", { ...bodyFor("process"), expectedRefundVersion: -1 }, "EXPECTED_REFUND_VERSION_INVALID"],
    ["process", missingUpdatedAt, "EXPECTED_REFUND_UPDATED_AT_REQUIRED"],
    ["process", { ...bodyFor("process"), expectedRefundUpdatedAt: "stale-date" }, "EXPECTED_REFUND_UPDATED_AT_INVALID"],
    ["process", { ...bodyFor("process"), refundProofFileIds: ["https://example.com/proof.jpg"] }, "REFUND_PROOF_INVALID"],
    ["process", {
      ...bodyFor("process"),
      refundProofFileIds: Array.from(
        { length: 7 },
        (_, index) => `cloud://env.refund-proof-${index + 1}`
      )
    }, "REFUND_PROOF_LIMIT_EXCEEDED"],
    ["reject", { ...bodyFor("reject"), rejectReason: "   " }, "REJECT_REASON_REQUIRED"]
  ];
  for (const [action, body, code] of invalid) {
    let calls = 0;
    await assert.rejects(
      () => api.dispatch(request(action, { body }), auth(), config, {
        refundMutationService: serviceWith(() => {
          calls += 1;
          return serviceResult(action);
        })
      }),
      (error) => error.code === code && error.statusCode === 400
    );
    assert.equal(calls, 0);
  }

  await assert.rejects(
    () => api.dispatch(request("process", {
      headers: { "x-admin-csrf": csrfToken }
    }), auth(), config, { refundMutationService: serviceWith() }),
    (error) => error.code === "IDEMPOTENCY_KEY_REQUIRED" && error.statusCode === 400
  );
});

test("refund process accepts exactly six unique CloudBase proofs", async () => {
  let calls = 0;
  const proofs = Array.from(
    { length: 6 },
    (_, index) => `cloud://env.refund-proof-${index + 1}`
  );
  await api.dispatch(request("process", {
    body: { ...bodyFor("process"), refundProofFileIds: proofs }
  }), auth(), config, {
    refundMutationService: serviceWith((action, command) => {
      calls += 1;
      assert.deepEqual(command.input.refundProofFileIds, proofs);
      return serviceResult(action);
    })
  });
  assert.equal(calls, 1);
});

test("refund mutation DTO rejects every unknown or client-derived authority and limit field", async () => {
  const forbiddenFields = [
    "role",
    "openid",
    "userId",
    "paidAmountCents",
    "approvedRefundAmountCents",
    "maxRefundAmountCents",
    "refundLimitCents",
    "unknown"
  ];
  for (const action of ["process", "reject"]) {
    for (const field of forbiddenFields) {
      let calls = 0;
      await assert.rejects(
        () => api.dispatch(request(action, {
          body: { ...bodyFor(action), [field]: field.endsWith("Cents") ? 999999 : "forged" }
        }), auth(), config, {
          refundMutationService: serviceWith(() => {
            calls += 1;
            return serviceResult(action);
          })
        }),
        (error) => error.code === "INVALID_REQUEST_BODY" && error.statusCode === 400
      );
      assert.equal(calls, 0);
    }
  }
});

test("stale refund snapshots and canonical service failures map to fixed safe BFF errors", async () => {
  const cases = [
    ["UNKNOWN_FIELD", 400],
    ["FORBIDDEN", 403],
    ["REFUND_NOT_FOUND", 404],
    ["REFUND_STATUS_CONFLICT", 409],
    ["DATA_VERSION_CONFLICT", 409],
    ["IDEMPOTENCY_KEY_CONFLICT", 409],
    ["SYNC_OWNER_CONFIG_REQUIRED", 503]
  ];
  for (const [code, statusCode] of cases) {
    const error = api.refundMutationApiError({
      code,
      statusCode: 418,
      message: "secret refund account cloud://private"
    });
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.message.includes("secret"), false);
    assert.equal(error.message.includes("cloud://"), false);
  }
  const unknown = api.refundMutationApiError({ code: "DATABASE_SECRET", message: "secret" });
  assert.equal(unknown.code, "REFUND_MUTATION_FAILED");
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.message.includes("secret"), false);

  await assert.rejects(
    () => api.dispatch(request("process"), auth(), config, {
      refundMutationService: serviceWith(() => {
        throw { code: "DATA_VERSION_CONFLICT", message: "secret stale row" };
      })
    }),
    (error) => error.code === "DATA_VERSION_CONFLICT"
      && error.statusCode === 409
      && !error.message.includes("secret")
  );
});

test("invalid refund service responses fail closed without leaking raw service data", async () => {
  const malformed = [
    {},
    { ...serviceResult("process"), item: { ...serviceResult("process").item, status: "paid" } },
    { ...serviceResult("process"), item: { ...serviceResult("process").item, version: -1 } },
    { ...serviceResult("process"), item: { ...serviceResult("process").item, updatedAt: "bad-date" } },
    { ...serviceResult("process"), item: { ...serviceResult("process").item, amountCents: 1.5 } },
    { ...serviceResult("process"), affected: 2 },
    { ...serviceResult("process"), action: "reject" }
  ];
  for (const result of malformed) {
    await assert.rejects(
      () => api.dispatch(request("process"), auth(), config, {
        refundMutationService: serviceWith(result)
      }),
      (error) => error.code === "INVALID_SERVICE_RESPONSE"
        && error.statusCode === 502
        && !error.message.includes("private")
    );
  }
});

test("unsupported Web create and WeChat refund routes remain explicit 404 mutations", async () => {
  for (const action of ["create", "wechat", "wechat-notify", "process-wechat"]) {
    const route = parseHttpRoute(`/api/admin/v1/refunds/${action}`, "POST");
    assert.deepEqual(route, { action: "mutate", resource: "refunds", mutationAction: action });
    await assert.rejects(
      () => api.dispatch({ ...request("process"), route }, auth("super_admin", ["*"]), config, {
        refundMutationService: serviceWith()
      }),
      (error) => error.code === "MUTATION_NOT_SUPPORTED" && error.statusCode === 404
    );
  }
});
