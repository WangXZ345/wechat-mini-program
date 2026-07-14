"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("./handler");

test("legacy handler preserves response fields and delegates with compatibility mode", async () => {
  let command;
  const main = createHandler({
    async requirePermission(permission) {
      assert.equal(permission, "order:review");
      return { _id: "admin-1", openid: "admin-openid", role: "customer_service", status: "active", isActive: true, permissions: ["order:review"] };
    },
    service: {
      async reviewOrder(input) {
        command = input;
        return { status: "approved_pending_payment", userId: "u-1", userOpenid: "openid-1", reused: false, item: { id: "o-1" } };
      }
    }
  });
  const response = await main({ orderId: "o-1", action: "approve", idempotencyKey: "legacy-key" });
  assert.deepEqual(response, { ok: true, data: { status: "approved_pending_payment", userId: "u-1", userOpenid: "openid-1", reused: false, item: { id: "o-1" } } });
  assert.equal(command.strict, false);
  assert.equal(command.idempotencyKey, "legacy-key");
  assert.equal(command.actor.sourceClient, "miniprogram");
  assert.deepEqual(command.input, { orderId: "o-1", action: "approve" });
});
