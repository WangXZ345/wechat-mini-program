"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const security = require("../../adminWebAuth/security");
const api = require("../index")._test;
const { parseHttpRoute } = require("../lib/core");

const csrfToken = "return-inspection-csrf-token";
const config = { tokenPepper: "p".repeat(32) };
const expectedUpdatedAt = "2026-07-16T08:00:00.000Z";

function auth(role = "customer_service", permissions = ["after_sale:receive_return", "after_sale:inspect"]) {
  const actor = { id: `${role}-1`, role, status: "active", isActive: true, permissions };
  return {
    principal: actor,
    rawAdmin: { _id: actor.id, openid: `trusted-${role}-openid`, role, status: "active", isActive: true },
    session: { csrfTokenHash: security.tokenHash(csrfToken, config.tokenPepper) }
  };
}

function request(action = "receive", overrides = {}) {
  const body = action === "receive"
    ? {
      afterSaleId: "as-1",
      expectedStatus: "waiting_return",
      expectedVersion: 4,
      expectedUpdatedAt,
      remark: "物流已核对"
    }
    : {
      afterSaleId: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt,
      itemCondition: "sellable",
      canRestock: true,
      restockQuantity: 2,
      inspectionRemark: "商品可售"
    };
  return {
    http: true,
    requestId: `request-return-${action}`,
    route: { action: "mutate", resource: "after-sales", mutationAction: action },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": `return-${action}-key-0001` },
    body,
    ...overrides
  };
}

function serviceResult(action) {
  return {
    afterSaleId: "as-1",
    afterSaleStatus: action === "receive" ? "received" : "refund_pending",
    version: 5,
    updatedAt: new Date("2026-07-16T08:01:00.000Z"),
    restoredQuantity: action === "inspect" ? 2 : 0,
    affected: 1,
    reused: false,
    orderId: "private-order",
    inventoryLog: { stock: 99 }
  };
}

test("after-sale receive and inspect routes call the canonical service with strict input", async () => {
  assert.deepEqual(parseHttpRoute("/api/admin/v1/after-sales/receive", "POST"), {
    action: "mutate", resource: "after-sales", mutationAction: "receive"
  });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/after-sales/inspect", "POST"), {
    action: "mutate", resource: "after-sales", mutationAction: "inspect"
  });
  for (const action of ["receive", "inspect"]) {
    let received;
    const result = await api.dispatch(request(action), auth(), config, {
      returnInspectionService: {
        async confirmReturnReceived(command) {
          received = command;
          return serviceResult(action);
        },
        async inspectReturnItems(command) {
          received = command;
          return serviceResult(action);
        }
      }
    });
    assert.equal(received.input.action, action);
    assert.equal(received.input.afterSaleId, "as-1");
    assert.equal(received.input.expectedVersion, 4);
    assert.equal(received.input.expectedUpdatedAt, expectedUpdatedAt);
    assert.equal(received.idempotencyKey, `return-${action}-key-0001`);
    assert.equal(received.actor.id, "customer_service-1");
    assert.equal(result.item.id, "as-1");
    assert.equal(result.item.version, 5);
    assert.equal(result.restoredQuantity, action === "inspect" ? 2 : 0);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("after-sale inspection body rejects unknown fields before the service", async () => {
  let calls = 0;
  await assert.rejects(
    () => api.dispatch(request("inspect", {
      body: { ...request("inspect").body, orderId: "forged" }
    }), auth(), config, {
      returnInspectionService: {
        async inspectReturnItems() {
          calls += 1;
        }
      }
    }),
    (error) => error.code === "INVALID_REQUEST_BODY" && error.statusCode === 400
  );
  assert.equal(calls, 0);
});

test("finance and procurement cannot receive or inspect even with injected permissions", async () => {
  for (const role of ["finance", "procurement"]) {
    for (const action of ["receive", "inspect"]) {
      await assert.rejects(
        () => api.dispatch(request(action), auth(role, ["after_sale:receive_return", "after_sale:inspect"]), config, {
          returnInspectionService: {
            async confirmReturnReceived() { throw new Error("must not call"); },
            async inspectReturnItems() { throw new Error("must not call"); }
          }
        }),
        (error) => error.code === "FORBIDDEN" && error.statusCode === 403
      );
    }
  }
});
