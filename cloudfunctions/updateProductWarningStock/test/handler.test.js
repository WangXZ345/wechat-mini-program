const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createLegacyHandler,
  normalizeLegacyWarningStock
} = require("../handler");
const stockAlert = require("../stockAlert");
const { createInventoryWarningService } = require("../inventoryWarningService");
const { baseState, createDatabase, createIdempotency } = require("./helpers");

test("legacy warningStock keeps the old default and numeric-string compatibility", () => {
  assert.equal(normalizeLegacyWarningStock(undefined), 10);
  assert.equal(normalizeLegacyWarningStock(null), 10);
  assert.equal(normalizeLegacyWarningStock(""), 10);
  assert.equal(normalizeLegacyWarningStock("0"), 0);
  assert.equal(normalizeLegacyWarningStock("99999"), 99999);
  for (const value of ["1.5", "-1", "100000", "not-a-number"]) {
    assert.throws(() => normalizeLegacyWarningStock(value), (error) => error.code === "WARNING_THRESHOLD_INVALID");
  }
});

test("legacy adapter derives actor only from requirePermission and ignores forged body identity", async () => {
  const calls = [];
  const service = {
    async setWarningStock(command) {
      calls.push(command);
      return { productId: command.input.productId, warningStock: command.input.warningThreshold, version: 4 };
    }
  };
  const permissions = [];
  const handler = createLegacyHandler({
    async requirePermission(permission) {
      permissions.push(permission);
      return {
        _id: "admin-doc-1",
        openid: "trusted-mini-openid",
        role: "procurement",
        status: "active",
        isActive: true,
        permissions: ["inventory:set_warning"]
      };
    },
    service
  });

  const response = await handler({
    productId: "product-1",
    warningStock: "12",
    autoHideWhenOutOfStock: true,
    idempotencyKey: "legacy-key-0001",
    reason: "旧入口",
    expectedVersion: 999,
    actor: { id: "forged-admin" },
    adminId: "forged-admin",
    openid: "forged-openid",
    role: "super_admin",
    permissions: ["*"],
    sourceClient: "admin_web"
  });

  assert.deepEqual(permissions, ["inventory:set_warning"]);
  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].actor, {
    id: "trusted-mini-openid",
    openid: "trusted-mini-openid",
    role: "procurement",
    permissions: ["inventory:set_warning"],
    status: "active",
    isActive: true,
    sourceClient: "miniprogram"
  });
  assert.deepEqual(calls[0].input, {
    productId: "product-1",
    warningThreshold: 12,
    reason: "旧入口"
  });
  assert.equal(calls[0].requireExpectedVersion, false);
  assert.equal(calls[0].allowMissingIdempotencyKey, true);
  assert.equal(calls[0].legacyAutoHideWhenOutOfStock, true);
  assert.equal(Object.hasOwn(calls[0].input, "expectedVersion"), false);
});

test("forged legacy body identity cannot enter inventory log or outbox audit fields", async () => {
  const db = createDatabase(baseState());
  const service = createInventoryWarningService({
    db,
    stockAlert,
    idempotency: createIdempotency(),
    now: () => new Date("2026-07-11T08:00:00.000Z")
  });
  const handler = createLegacyHandler({
    async requirePermission() {
      return {
        _id: "trusted-admin-doc",
        openid: "trusted-mini-openid",
        role: "procurement",
        status: "active",
        isActive: true,
        permissions: ["inventory:set_warning"]
      };
    },
    service
  });

  const response = await handler({
    productId: "product-1",
    warningStock: "6",
    idempotencyKey: "legacy-key-audit-1",
    actor: { id: "forged-admin" },
    adminId: "forged-admin",
    openid: "forged-openid",
    role: "super_admin",
    sourceClient: "admin_web"
  });
  const state = db.snapshot();
  const inventoryLog = state.inventory_logs[0];
  const event = state.sync_events[0];

  assert.equal(response.ok, true);
  assert.equal(inventoryLog.operatorId, "trusted-mini-openid");
  assert.equal(inventoryLog.operatorOpenid, "trusted-mini-openid");
  assert.equal(inventoryLog.operatorRole, "procurement");
  assert.equal(inventoryLog.sourceClient, "miniprogram");
  assert.equal(JSON.stringify(inventoryLog).includes("forged"), false);
  assert.equal(Object.hasOwn(event, "openid"), false);
  assert.equal(Object.hasOwn(event, "operatorOpenid"), false);
  assert.equal(JSON.stringify(event).includes("forged"), false);
});

test("legacy adapter preserves missing-key success and old response envelope", async () => {
  let captured;
  const handler = createLegacyHandler({
    async requirePermission() {
      return {
        openid: "mini-openid",
        role: "procurement",
        status: "active",
        isActive: true,
        permissions: ["inventory:set_warning"]
      };
    },
    service: {
      async setWarningStock(command) {
        captured = command;
        return { productId: command.input.productId, warningStock: command.input.warningThreshold, version: 1 };
      }
    }
  });

  const response = await handler({ productId: "product-1" });
  assert.deepEqual(response, {
    ok: true,
    data: { productId: "product-1", warningStock: 10, version: 1 }
  });
  assert.equal(captured.idempotencyKey, undefined);
  assert.equal(captured.input.warningThreshold, 10);
});

test("legacy adapter keeps validation and idempotency failures in ok:false envelopes", async () => {
  let serviceCalled = false;
  const handler = createLegacyHandler({
    async requirePermission() {
      return {
        openid: "mini-openid",
        role: "procurement",
        status: "active",
        isActive: true,
        permissions: ["inventory:set_warning"]
      };
    },
    service: {
      async setWarningStock() {
        serviceCalled = true;
        const error = new Error("请求已被用于其他操作");
        error.code = "IDEMPOTENCY_KEY_CONFLICT";
        error.details = { duplicate: true, idempotencyStatus: "conflict" };
        throw error;
      }
    }
  });

  assert.deepEqual(await handler({ warningStock: 5 }), { ok: false, message: "PRODUCT_ID_REQUIRED" });
  assert.equal(serviceCalled, false);
  const invalid = await handler({ productId: "product-1", warningStock: -1 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /0 到 99999/);
  assert.equal(serviceCalled, false);

  const conflict = await handler({ productId: "product-1", warningStock: 5, idempotencyKey: "legacy-key-0002" });
  assert.deepEqual(conflict, {
    ok: false,
    code: "IDEMPOTENCY_KEY_CONFLICT",
    message: "请求已被用于其他操作",
    data: { duplicate: true, idempotencyStatus: "conflict" }
  });
});
