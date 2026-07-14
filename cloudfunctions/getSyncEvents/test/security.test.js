const test = require("node:test");
const assert = require("node:assert/strict");
const { activeAdmin, boundedRolePermissions } = require("../security");

test("configured permissions are intersected with the fixed role boundary", () => {
  assert.deepEqual(
    boundedRolePermissions("customer_service", ["order:view", "payment:view_screenshot", "refund:view"]),
    ["order:view"]
  );
  assert.deepEqual(
    boundedRolePermissions("procurement", ["product:view", "inventory:view", "customer:view_account"]),
    ["product:view", "inventory:view"]
  );
});

test("only active known admin roles are accepted", () => {
  assert.equal(activeAdmin({ role: "finance", isActive: true, status: "active" }), true);
  assert.equal(activeAdmin({ role: "finance", isActive: false }), false);
  assert.equal(activeAdmin({ role: "user", isActive: true }), false);
});
