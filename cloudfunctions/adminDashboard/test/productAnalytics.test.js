const test = require("node:test");
const assert = require("node:assert/strict");

const { createProductAnalytics } = require("../productAnalytics");

function admin(overrides = {}) {
  return {
    id: "admin-1",
    role: "procurement",
    status: "active",
    isActive: true,
    permissions: ["product:analytics:view"],
    ...overrides
  };
}

function adapterFor(currentAdmin, options = {}) {
  let calls = 0;
  const service = {
    async getProductDetail(input) {
      calls += 1;
      return { productId: input.productId };
    }
  };
  return {
    get calls() { return calls; },
    run: createProductAnalytics({
      service,
      requireAdmin: async () => currentAdmin,
      hasPermission: options.hasPermission || ((actor, permission) => actor.permissions.includes(permission))
    })
  };
}

test("procurement with the real analytics permission reaches the canonical detail service", async () => {
  const adapter = adapterFor(admin());
  assert.deepEqual(await adapter.run({ productId: "p1", range: "7d" }), { productId: "p1" });
  assert.equal(adapter.calls, 1);
});

test("existing mini-program assignable analytics permissions remain compatible across admin roles", async () => {
  for (const currentAdmin of [
    admin({ role: "customer_service", permissions: ["product:analytics:view"] }),
    admin({ role: "finance", permissions: ["dashboard:view_product"] })
  ]) {
    const adapter = adapterFor(currentAdmin);
    assert.deepEqual(await adapter.run({ productId: "p1", range: "7d" }), { productId: "p1" });
    assert.equal(adapter.calls, 1);
  }
});

test("procurement still needs analytics permission and an active account", async () => {
  const missingPermission = adapterFor(admin({ permissions: [] }));
  await assert.rejects(missingPermission.run({ productId: "p1" }), (error) => error.code === "FORBIDDEN");
  assert.equal(missingPermission.calls, 0);

  const disabled = adapterFor(admin({ status: "disabled", isActive: false }), { hasPermission: () => true });
  await assert.rejects(disabled.run({ productId: "p1" }), (error) => error.code === "FORBIDDEN");
  assert.equal(disabled.calls, 0);
});

test("super_admin remains allowed through the canonical permission evaluator", async () => {
  const allowed = adapterFor(admin({ role: "super_admin", permissions: [] }), { hasPermission: () => true });
  await allowed.run({ productId: "p1" });
  assert.equal(allowed.calls, 1);

  const denied = adapterFor(admin({ role: "super_admin", permissions: [] }), { hasPermission: () => false });
  await assert.rejects(denied.run({ productId: "p1" }), (error) => error.code === "FORBIDDEN");
});
