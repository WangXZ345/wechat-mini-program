const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcileAccountAfterCancellation, PENDING_WARNING } = require("../accountRecalculation");

function setup({ callResult, callError, updateError } = {}) {
  const calls = [];
  const updates = [];
  const warnings = [];
  return {
    calls,
    updates,
    warnings,
    cloud: {
      async callFunction(input) {
        calls.push(input);
        if (callError) throw callError;
        return callResult;
      }
    },
    db: {
      serverDate: () => new Date("2026-07-12T12:00:00.000Z"),
      collection(name) {
        assert.equal(name, "orders");
        return { doc(id) { return { async update(input) {
          if (updateError) throw updateError;
          updates.push({ id, input });
        } }; } };
      }
    },
    logger: { warn(...args) { warnings.push(args); } }
  };
}

const pendingResult = {
  orderId: "order-1",
  userId: "user-1",
  userOpenid: "openid-1",
  accountRecalculationRequired: true
};

test("successful account recalculation clears the persisted pending marker", async () => {
  const current = setup({ callResult: { result: { ok: true } } });
  const result = await reconcileAccountAfterCancellation({ ...current, result: pendingResult });
  assert.deepEqual(result, { accountRecalculationPending: false, warning: "" });
  assert.deepEqual(current.calls[0], {
    name: "recalculateCustomerAccount",
    data: { userId: "user-1", userOpenid: "openid-1" }
  });
  assert.equal(current.updates[0].id, "order-1");
  assert.equal(current.updates[0].input.data.accountRecalculationPending, false);
});

test("failed recalculation or marker update stays visibly retryable", async () => {
  for (const current of [
    setup({ callResult: { result: { ok: false } } }),
    setup({ callError: Object.assign(new Error("timeout"), { code: "TIMEOUT" }) }),
    setup({ callResult: { result: { ok: true } }, updateError: new Error("update failed") })
  ]) {
    const result = await reconcileAccountAfterCancellation({ ...current, result: pendingResult });
    assert.deepEqual(result, { accountRecalculationPending: true, warning: PENDING_WARNING });
  }
});

test("orders without a pending recalculation do not call the account function", async () => {
  const current = setup();
  const result = await reconcileAccountAfterCancellation({ ...current, result: { accountRecalculationRequired: false } });
  assert.deepEqual(result, { accountRecalculationPending: false, warning: "" });
  assert.equal(current.calls.length, 0);
});
