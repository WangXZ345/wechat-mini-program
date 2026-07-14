const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const api = require("../index");

const {
  dispatch,
  inventoryAdjustmentRoute,
  normalizeInventoryAdjustmentMutation,
  inventoryAdjustmentMutationResult,
  defaultInventoryMutationService
} = api._test;

const tokenPepper = "t".repeat(32);
const csrfToken = "csrf-token-for-inventory-adjustment";
const config = { tokenPepper };

function auth(overrides = {}) {
  return {
    principal: {
      id: "admin-session-id",
      role: "procurement",
      permissions: ["inventory:update"],
      status: "active",
      ...overrides.principal
    },
    rawAdmin: {
      _id: "raw-admin-id",
      openid: "server-openid",
      role: "finance",
      ...overrides.rawAdmin
    },
    session: {
      csrfTokenHash: security.tokenHash(csrfToken, tokenPepper),
      ...overrides.session
    }
  };
}

function request(resource = "inventory", overrides = {}) {
  return {
    route: { action: "mutate", resource, mutationAction: "adjust" },
    body: {
      id: "product-1",
      mode: "delta",
      delta: -4,
      expectedStock: 12,
      expectedVersion: 7,
      reason: "盘点差异调整"
    },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": "inventory-adjust-0001" },
    http: true,
    requestId: "request-inventory-1",
    ...overrides
  };
}

test("only inventory and inventory-alerts adjust routes use the canonical service", () => {
  assert.equal(typeof defaultInventoryMutationService.adjustInventory, "function");
  assert.equal(inventoryAdjustmentRoute({ resource: "inventory", mutationAction: "adjust" }), true);
  assert.equal(inventoryAdjustmentRoute({ resource: "inventory-alerts", mutationAction: "adjust" }), true);
  assert.equal(inventoryAdjustmentRoute({ resource: "products", mutationAction: "adjust" }), false);
  assert.equal(inventoryAdjustmentRoute({ resource: "inventory", mutationAction: "set-warning" }), false);
});

test("normalizes the exact delta-only Web contract without coercion", () => {
  assert.deepEqual(normalizeInventoryAdjustmentMutation(request()), {
    idempotencyKey: "inventory-adjust-0001",
    input: {
      productId: "product-1",
      mode: "delta",
      delta: -4,
      expectedStock: 12,
      expectedVersion: 7,
      reason: "盘点差异调整"
    }
  });

  const invalidBodies = [
    { id: "product-1", mode: "set", delta: 1, expectedStock: 12, expectedVersion: 7, reason: "x" },
    { id: "product-1", mode: "delta", delta: "1", expectedStock: 12, expectedVersion: 7, reason: "x" },
    { id: "product-1", mode: "delta", delta: 0, expectedStock: 12, expectedVersion: 7, reason: "x" },
    { id: "product-1", mode: "delta", delta: 1, expectedStock: "12", expectedVersion: 7, reason: "x" },
    { id: "product-1", mode: "delta", delta: 1, expectedStock: 12, expectedVersion: "7", reason: "x" },
    { id: "product-1", mode: "delta", delta: 1, expectedStock: 12, expectedVersion: 7, reason: "" },
    { id: "product-1", mode: "delta", delta: 1, expectedStock: 12, expectedVersion: 7, reason: "x", actor: { role: "super_admin" } }
  ];
  for (const body of invalidBodies) {
    assert.throws(() => normalizeInventoryAdjustmentMutation(request("inventory", { body })), (error) => error.statusCode === 400);
  }
  assert.throws(
    () => normalizeInventoryAdjustmentMutation(request("inventory", { headers: { "x-admin-csrf": csrfToken } })),
    (error) => error.code === "IDEMPOTENCY_KEY_REQUIRED"
  );
});

test("dispatch trusts only the session actor and returns the exact inventory item", async () => {
  for (const resource of ["inventory", "inventory-alerts"]) {
    let command;
    const result = await dispatch(request(resource), auth(), config, {
      inventoryMutationService: {
        async adjustInventory(value) {
          command = value;
          return {
            productId: "product-1",
            beforeStock: 12,
            stock: 8,
            warningStock: 10,
            stockStatus: "warning",
            isActive: true,
            version: 8,
            updatedAt: new Date("2026-07-12T12:00:00.000Z"),
            changed: true,
            reused: false
          };
        }
      }
    });
    assert.deepEqual(command.actor, {
      id: "admin-session-id",
      openid: "server-openid",
      role: "procurement",
      permissions: ["inventory:update"],
      status: "active",
      isActive: true,
      sourceClient: "admin_web"
    });
    assert.deepEqual(command.input, normalizeInventoryAdjustmentMutation(request()).input);
    assert.equal(command.idempotencyKey, "inventory-adjust-0001");
    assert.equal(command.requireExpectedSnapshots, true);
    assert.equal(command.requireReason, true);
    assert.deepEqual(result, {
      item: {
        id: "product-1",
        stock: 8,
        warningThreshold: 10,
        status: "low",
        isActive: true,
        version: 8,
        updatedAt: "2026-07-12T12:00:00.000Z"
      },
      affected: 1,
      message: "库存已从 12 调整为 8",
      requestId: "request-inventory-1"
    });
  }
});

test("permission and CSRF gates run before the inventory service", async () => {
  const dependency = { inventoryMutationService: { async adjustInventory() { throw new Error("must not run"); } } };
  await assert.rejects(
    () => dispatch(request(), auth({ principal: { role: "finance", permissions: [] } }), config, dependency),
    (error) => error.code === "FORBIDDEN"
  );
  await assert.rejects(
    () => dispatch(request("inventory", { headers: { "x-admin-csrf": "wrong", "idempotency-key": "inventory-adjust-0001" } }), auth(), config, dependency),
    (error) => error.code === "CSRF_VALIDATION_FAILED"
  );
});

test("service result projection rejects missing activation state and never exposes log data", () => {
  assert.throws(
    () => inventoryAdjustmentMutationResult({
      productId: "product-1", beforeStock: 2, stock: 1, warningStock: 1,
      stockStatus: "warning", version: 2, changed: true
    }),
    (error) => error.code === "INVALID_SERVICE_RESPONSE"
  );
  const result = inventoryAdjustmentMutationResult({
    productId: "product-1", beforeStock: 2, stock: 1, warningStock: 1,
    stockStatus: "warning", isActive: false, version: 2, changed: false,
    updatedAt: null, operationReason: "sensitive", operatorOpenid: "secret"
  }, "request-2");
  assert.deepEqual(Object.keys(result.item), ["id", "stock", "warningThreshold", "status", "isActive", "version", "updatedAt"]);
  assert.equal(result.affected, 0);
});
