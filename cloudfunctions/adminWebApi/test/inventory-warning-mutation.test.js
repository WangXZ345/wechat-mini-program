const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const api = require("../index");

const {
  buildRequest,
  dispatch,
  inventoryWarningRoute,
  normalizeInventoryWarningMutation,
  defaultInventoryWarningService
} = api._test;

const tokenPepper = "t".repeat(32);
const csrfToken = "csrf-token-for-inventory-warning";
const config = { tokenPepper };

function auth(overrides = {}) {
  const principal = {
    id: "admin-session-id",
    role: "procurement",
    permissions: ["inventory:set_warning"],
    status: "active",
    ...overrides.principal
  };
  return {
    principal,
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

function request(resource = "inventory", action = "set-warning", overrides = {}) {
  return {
    route: { action: "mutate", resource, mutationAction: action },
    body: {
      id: "product-1",
      warningThreshold: 12,
      expectedWarningThreshold: 6,
      expectedVersion: 4,
      reason: "季度阈值调整"
    },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": "warning-key-0001" },
    http: true,
    requestId: "request-warning-1",
    ...overrides
  };
}

test("only the two single warning routes are migrated", () => {
  assert.equal(typeof defaultInventoryWarningService.setWarningStock, "function");
  assert.equal(inventoryWarningRoute({ resource: "inventory", mutationAction: "set-warning" }), true);
  assert.equal(inventoryWarningRoute({ resource: "inventory-alerts", mutationAction: "set-warning" }), true);
  assert.equal(inventoryWarningRoute({ resource: "inventory", mutationAction: "batch-warning" }), false);
  assert.equal(inventoryWarningRoute({ resource: "inventory-alerts", mutationAction: "adjust" }), false);
  assert.equal(inventoryWarningRoute({ resource: "products", mutationAction: "change-price" }), false);
});

test("normalizes the existing Web payload and requires the idempotency header and version", () => {
  assert.deepEqual(normalizeInventoryWarningMutation(request()), {
    idempotencyKey: "warning-key-0001",
    input: {
      productId: "product-1",
      warningThreshold: 12,
      expectedWarningThreshold: 6,
      expectedVersion: 4,
      reason: "季度阈值调整"
    }
  });

  assert.throws(
    () => normalizeInventoryWarningMutation(request("inventory", "set-warning", { headers: { "x-admin-csrf": csrfToken } })),
    (err) => err.code === "IDEMPOTENCY_KEY_REQUIRED"
  );
  assert.throws(
    () => normalizeInventoryWarningMutation(request("inventory", "set-warning", {
      body: { id: "product-1", warningThreshold: 12, expectedWarningThreshold: 6 }
    })),
    (err) => err.code === "EXPECTED_VERSION_REQUIRED"
  );
  assert.throws(
    () => normalizeInventoryWarningMutation(request("inventory", "set-warning", {
      body: { id: "product-1", warningThreshold: 100000, expectedWarningThreshold: 6, expectedVersion: 1 }
    })),
    (err) => err.code === "WARNING_THRESHOLD_INVALID"
  );
});

test("rejects client-supplied actor, aliases and every unknown field", () => {
  for (const field of ["actor", "role", "openid", "autoHideWhenOutOfStock", "idempotencyKey", "productId", "value", "remark", "expectedWarningStock", "unknown"]) {
    const body = {
      id: "product-1",
      warningThreshold: 10,
      expectedWarningThreshold: 5,
      expectedVersion: 0,
      [field]: field === "autoHideWhenOutOfStock" ? true : "forged"
    };
    assert.throws(
      () => normalizeInventoryWarningMutation(request("inventory", "set-warning", { body })),
      (err) => err.code === "INVALID_REQUEST_BODY",
      field
    );
  }
});

test("rejects null, empty and string-encoded scalar values without coercion", () => {
  const invalidBodies = [
    { id: null, warningThreshold: 10, expectedWarningThreshold: 5, expectedVersion: 0 },
    { id: "", warningThreshold: 10, expectedWarningThreshold: 5, expectedVersion: 0 },
    { id: "product-1", warningThreshold: null, expectedWarningThreshold: 5, expectedVersion: 0 },
    { id: "product-1", warningThreshold: "10", expectedWarningThreshold: 5, expectedVersion: 0 },
    { id: "product-1", warningThreshold: 10, expectedWarningThreshold: 5, expectedVersion: null },
    { id: "product-1", warningThreshold: 10, expectedWarningThreshold: 5, expectedVersion: "0" },
    { id: "product-1", warningThreshold: 10, expectedWarningThreshold: 5, expectedVersion: 0, reason: 123 }
  ];
  for (const body of invalidBodies) {
    assert.throws(
      () => normalizeInventoryWarningMutation(request("inventory", "set-warning", { body })),
      (err) => ["PRODUCT_ID_REQUIRED", "WARNING_THRESHOLD_INVALID", "EXPECTED_VERSION_INVALID", "INVALID_REQUEST_BODY"].includes(err.code),
      JSON.stringify(body)
    );
  }
});

test("expected warning threshold is mandatory and never coerced", () => {
  const invalidValues = [undefined, null, "", "5", -1, 1.5, 100000, Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalidValues) {
    const body = { id: "product-1", warningThreshold: 10, expectedVersion: 0 };
    if (value !== undefined) body.expectedWarningThreshold = value;
    assert.throws(
      () => normalizeInventoryWarningMutation(request("inventory", "set-warning", { body })),
      (err) => value === undefined
        ? err.code === "EXPECTED_WARNING_THRESHOLD_REQUIRED"
        : err.code === "EXPECTED_WARNING_THRESHOLD_INVALID",
      String(value)
    );
  }
  assert.equal(normalizeInventoryWarningMutation(request("inventory", "set-warning", {
    body: { id: "product-1", warningThreshold: 10, expectedWarningThreshold: 0, expectedVersion: 0 }
  })).input.expectedWarningThreshold, 0);
});

test("dispatch uses only the session actor and returns the Web MutationResult contract", async () => {
  for (const resource of ["inventory", "inventory-alerts"]) {
    let command;
    const result = await dispatch(request(resource), auth(), config, {
      inventoryWarningService: {
        async setWarningStock(value) {
          command = value;
          return {
            productId: "product-1",
            stock: 8,
            warningStock: 12,
            stockStatus: "warning",
            version: 5,
            changed: true
          };
        }
      }
    });

    assert.deepEqual(command.input, {
      productId: "product-1",
      warningThreshold: 12,
      expectedWarningThreshold: 6,
      expectedVersion: 4,
      reason: "季度阈值调整"
    });
    assert.deepEqual(command.actor, {
      id: "admin-session-id",
      openid: "server-openid",
      role: "procurement",
      permissions: ["inventory:set_warning"],
      status: "active",
      isActive: true,
      sourceClient: "admin_web"
    });
    assert.equal(command.requireExpectedVersion, true);
    assert.equal(command.idempotencyKey, "warning-key-0001");
    assert.deepEqual(result, {
      item: { id: "product-1", stock: 8, warningThreshold: 12, status: "low", version: 5 },
      affected: 1,
      message: "库存预警值已更新",
      requestId: "request-warning-1"
    });
  }
});

test("trusted Action routing stays outside the strict business body", async () => {
  for (const payloadField of ["data", "payload"]) {
    const built = buildRequest({
      action: "mutate",
      resource: "inventory",
      mutationAction: "set-warning",
      headers: {
        "X-Admin-CSRF": csrfToken,
        "Idempotency-Key": `warning-action-${payloadField}`
      },
      [payloadField]: {
        id: "product-1",
        warningThreshold: 7,
        expectedWarningThreshold: 4,
        expectedVersion: 2,
        reason: "Action transport"
      }
    });
    assert.deepEqual(built.route, { action: "mutate", resource: "inventory", mutationAction: "set-warning" });
    assert.equal(built.http, false);
    let command;
    const result = await dispatch(built, auth(), config, {
      inventoryWarningService: {
        async setWarningStock(value) {
          command = value;
          return { productId: "product-1", stock: 20, warningStock: 7, stockStatus: "normal", version: 3, changed: true };
        }
      }
    });
    assert.equal(command.idempotencyKey, `warning-action-${payloadField}`);
    assert.equal(command.input.expectedWarningThreshold, 4);
    assert.equal(command.input.expectedVersion, 2);
    assert.equal(result.affected, 1);
  }

  const forged = buildRequest({
    action: "mutate",
    resource: "inventory",
    mutationAction: "set-warning",
    headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "warning-action-forged" },
    data: {
      id: "product-1",
      warningThreshold: 7,
      expectedWarningThreshold: 4,
      expectedVersion: 2,
      actor: { role: "super_admin" }
    }
  });
  await assert.rejects(
    dispatch(forged, auth(), config, { inventoryWarningService: { async setWarningStock() { throw new Error("must not run"); } } }),
    (err) => err.code === "INVALID_REQUEST_BODY"
  );
});

test("HTTP mutation preserves expected warning threshold as a strict service input", async () => {
  const built = buildRequest({
    httpMethod: "POST",
    rawPath: "/api/admin/v1/inventory/set-warning",
    headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "warning-http-contract" },
    body: JSON.stringify({
      id: "product-1",
      warningThreshold: 9,
      expectedWarningThreshold: 3,
      expectedVersion: 1,
      reason: "HTTP transport"
    })
  });
  let command;
  await dispatch(built, auth(), config, {
    inventoryWarningService: {
      async setWarningStock(value) {
        command = value;
        return { productId: "product-1", stock: 20, warningStock: 9, stockStatus: "normal", version: 2, changed: true };
      }
    }
  });
  assert.equal(command.input.expectedWarningThreshold, 3);
  assert.equal(command.input.expectedVersion, 1);
});

test("permission and CSRF checks run before the shared service", async () => {
  let calls = 0;
  const dependencies = { inventoryWarningService: { async setWarningStock() { calls += 1; return {}; } } };
  await assert.rejects(
    dispatch(request(), auth({ principal: { permissions: [] } }), config, dependencies),
    (err) => err.code === "FORBIDDEN"
  );
  await assert.rejects(
    dispatch(request("inventory", "set-warning", {
      headers: { "x-admin-csrf": "wrong", "idempotency-key": "warning-key-0001" }
    }), auth(), config, dependencies),
    (err) => err.code === "CSRF_VALIDATION_FAILED"
  );
  assert.equal(calls, 0);
});

test("version conflicts are stable 409 errors", async () => {
  await assert.rejects(
    dispatch(request(), auth(), config, {
      inventoryWarningService: {
        async setWarningStock() {
          const error = new Error("记录已变化，请刷新后重新确认");
          error.code = "DATA_VERSION_CONFLICT";
          error.statusCode = 409;
          throw error;
        }
      }
    }),
    (err) => err.code === "DATA_VERSION_CONFLICT" && err.statusCode === 409
  );
});

test("corrupt stored version and warning threshold keep safe 409 errors", async () => {
  for (const code of ["DATA_VERSION_INVALID", "DATA_WARNING_THRESHOLD_INVALID"]) {
    await assert.rejects(
      dispatch(request(), auth(), config, {
        inventoryWarningService: {
          async setWarningStock() {
            const error = new Error("商品库存预警数据异常，暂不能修改");
            error.code = code;
            error.statusCode = 409;
            throw error;
          }
        }
      }),
      (err) => err.code === code && err.statusCode === 409 && err.message === "商品库存预警数据异常，暂不能修改",
      code
    );
  }
});

test("corrupt stored stock stays a non-leaking 409 over HTTP and trusted Action", async () => {
  const payload = {
    id: "product-1",
    warningThreshold: 9,
    expectedWarningThreshold: 3,
    expectedVersion: 1,
    reason: "stock validation"
  };
  const transports = [
    buildRequest({
      httpMethod: "POST",
      rawPath: "/api/admin/v1/inventory/set-warning",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "warning-http-invalid-stock" },
      body: JSON.stringify(payload)
    }),
    buildRequest({
      action: "mutate",
      resource: "inventory",
      mutationAction: "set-warning",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "warning-action-invalid-stock" },
      data: payload
    })
  ];

  for (const transportRequest of transports) {
    await assert.rejects(
      dispatch(transportRequest, auth(), config, {
        inventoryWarningService: {
          async setWarningStock() {
            const error = new Error("internal stock value was string 5");
            error.code = "DATA_STOCK_INVALID";
            error.statusCode = 409;
            error.details = { stock: "5", documentPath: "products/product-1" };
            throw error;
          }
        }
      }),
      (err) => {
        assert.equal(err.code, "DATA_STOCK_INVALID");
        assert.equal(err.statusCode, 409);
        assert.equal(err.message, "商品库存数据异常，暂不能修改");
        assert.equal(err.details, undefined);
        assert.equal(JSON.stringify(err).includes("products/product-1"), false);
        assert.equal(JSON.stringify(err).includes('"stock":"5"'), false);
        return true;
      }
    );
  }
});

test("MutationResult keeps a stable zero version when the service omits one", async () => {
  const result = await dispatch(request(), auth(), config, {
    inventoryWarningService: {
      async setWarningStock() {
        return { productId: "product-1", stock: 0, warningStock: 0, stockStatus: "out_of_stock", changed: true };
      }
    }
  });
  assert.equal(result.item.version, 0);
});

test("all other mutations remain explicitly unmigrated", async () => {
  for (const [resource, action] of [
    ["inventory", "batch-warning"]
  ]) {
    const principal = action === "adjust" ? { permissions: ["inventory:update"] } : {};
    await assert.rejects(
      dispatch(request(resource, action), auth({ principal }), config, {
        inventoryWarningService: { async setWarningStock() { throw new Error("must not run"); } }
      }),
      (err) => err.code === "SERVICE_NOT_MIGRATED" && err.statusCode === 501,
      `${resource}/${action}`
    );
  }
});
