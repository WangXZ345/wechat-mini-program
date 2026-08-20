const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const api = require("../index");

const {
  buildRequest,
  dispatch,
  productPriceRoute,
  normalizeProductPriceMutation,
  defaultProductPriceService
} = api._test;

const tokenPepper = "p".repeat(32);
const csrfToken = "csrf-token-for-product-price";
const config = { tokenPepper };

function auth(overrides = {}) {
  return {
    principal: {
      id: "admin-session-id",
      role: "procurement",
      permissions: ["product:update_price"],
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

function request(action = "change-price", overrides = {}) {
  return {
    route: { action: "mutate", resource: "products", mutationAction: action },
    body: {
      id: "product-1",
      newPriceCents: 7200,
      expectedPriceCents: 6900,
      expectedVersion: 3,
      reason: "季度调价"
    },
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": "product-price-key-0001" },
    http: true,
    requestId: "request-price-1",
    ...overrides
  };
}

test("only the single product change-price route is migrated", () => {
  assert.equal(typeof defaultProductPriceService.setPrice, "function");
  assert.equal(productPriceRoute({ resource: "products", mutationAction: "change-price" }), true);
  assert.equal(productPriceRoute({ resource: "products", mutationAction: "toggle-status" }), false);
  assert.equal(productPriceRoute({ resource: "products", mutationAction: "batch-enable" }), false);
  assert.equal(productPriceRoute({ resource: "inventory", mutationAction: "set-warning" }), false);
});

test("normalizes the strict integer-cent contract and header idempotency key", () => {
  assert.deepEqual(normalizeProductPriceMutation(request()), {
    idempotencyKey: "product-price-key-0001",
    input: {
      productId: "product-1",
      newPriceCents: 7200,
      expectedPriceCents: 6900,
      expectedVersion: 3,
      reason: "季度调价"
    }
  });
  assert.throws(
    () => normalizeProductPriceMutation(request("change-price", { headers: { "x-admin-csrf": csrfToken } })),
    (error) => error.code === "IDEMPOTENCY_KEY_REQUIRED"
  );
});

test("requires both expected version and expected price without scalar coercion", () => {
  const invalidBodies = [
    { id: "product-1", newPriceCents: 7200, expectedVersion: 3 },
    { id: "product-1", newPriceCents: 7200, expectedPriceCents: 6900 },
    { id: "product-1", newPriceCents: "7200", expectedPriceCents: 6900, expectedVersion: 3 },
    { id: "product-1", newPriceCents: 7200, expectedPriceCents: "6900", expectedVersion: 3 },
    { id: "product-1", newPriceCents: 7200, expectedPriceCents: 6900, expectedVersion: "3" },
    { id: "product-1", newPriceCents: -1, expectedPriceCents: 6900, expectedVersion: 3 },
    { id: "product-1", newPriceCents: 7200, expectedPriceCents: -1, expectedVersion: 3 },
    { id: "product-1", newPriceCents: 7200, expectedPriceCents: 6900, expectedVersion: -1 },
    { id: "product-1", newPriceCents: 7200, expectedPriceCents: 6900, expectedVersion: 3, reason: 1 }
  ];
  for (const body of invalidBodies) {
    assert.throws(
      () => normalizeProductPriceMutation(request("change-price", { body })),
      (error) => [
        "PRICE_INVALID",
        "EXPECTED_PRICE_REQUIRED",
        "EXPECTED_PRICE_INVALID",
        "EXPECTED_VERSION_REQUIRED",
        "EXPECTED_VERSION_INVALID",
        "INVALID_REQUEST_BODY"
      ].includes(error.code),
      JSON.stringify(body)
    );
  }
});

test("rejects aliases, client actor fields and every unknown body field", () => {
  for (const field of ["actor", "role", "openid", "idempotencyKey", "productId", "newPrice", "value", "remark", "expectedPrice", "unknown"]) {
    assert.throws(
      () => normalizeProductPriceMutation(request("change-price", {
        body: {
          id: "product-1",
          newPriceCents: 7200,
          expectedPriceCents: 6900,
          expectedVersion: 3,
          [field]: "forged"
        }
      })),
      (error) => error.code === "INVALID_REQUEST_BODY",
      field
    );
  }
});

test("dispatch derives actor only from the validated session and maps MutationResult", async () => {
  let command;
  const result = await dispatch(request(), auth(), config, {
    productPriceService: {
      async setPrice(value) {
        command = value;
        return {
          productId: "product-1",
          beforePrice: 6900,
          afterPrice: 7200,
          isActive: true,
          status: "",
          version: 4,
          updatedAt: new Date("2026-07-11T08:00:00.000Z"),
          changed: true
        };
      }
    }
  });
  assert.deepEqual(command, {
    actor: {
      id: "admin-session-id",
      openid: "server-openid",
      role: "procurement",
      permissions: ["product:update_price"],
      status: "active",
      isActive: true,
      sourceClient: "admin_web"
    },
    input: {
      productId: "product-1",
      newPriceCents: 7200,
      expectedPriceCents: 6900,
      expectedVersion: 3,
      reason: "季度调价"
    },
    idempotencyKey: "product-price-key-0001",
    requestId: "request-price-1",
    requireExpectedVersion: true
  });
  assert.deepEqual(result, {
    item: {
      id: "product-1",
      salePriceCents: 7200,
      status: "active",
      version: 4,
      updatedAt: "2026-07-11T08:00:00.000Z"
    },
    affected: 1,
    message: "商品售价已更新",
    requestId: "request-price-1"
  });
});

test("no-op and business-log recovery do not report another affected row", async () => {
  const result = await dispatch(request(), auth(), config, {
    productPriceService: {
      async setPrice() {
        return {
          productId: "product-1",
          beforePrice: 7200,
          afterPrice: 7200,
          isActive: true,
          version: 4,
          changed: false,
          reused: true
        };
      }
    }
  });
  assert.equal(result.affected, 0);
  assert.equal(result.message, "商品售价未重复写入");
});

test("invalid shared-service success data fails closed instead of reporting a fake update", async () => {
  const validResult = {
    productId: "product-1",
    afterPrice: 7200,
    version: 4,
    changed: true,
    isActive: true
  };
  const invalidResults = [
    {},
    { ...validResult, productId: "" },
    { ...validResult, productId: 123 },
    { ...validResult, afterPrice: "7200" },
    { ...validResult, afterPrice: -1 },
    { ...validResult, version: "4" },
    { ...validResult, version: -1 },
    { ...validResult, changed: "false" },
    { ...validResult, changed: undefined },
    { ...validResult, isActive: undefined }
  ];
  for (const invalidResult of invalidResults) {
    await assert.rejects(
      dispatch(request(), auth(), config, {
        productPriceService: { async setPrice() { return invalidResult; } }
      }),
      (error) => error.code === "INVALID_SERVICE_RESPONSE"
        && error.statusCode === 502
        && error.message === "商品改价结果无效",
      JSON.stringify(invalidResult)
    );
  }
});

test("permission and CSRF checks run before normalization or the shared service", async () => {
  let calls = 0;
  const dependencies = { productPriceService: { async setPrice() { calls += 1; return {}; } } };
  await assert.rejects(
    dispatch(request(), auth({ principal: { permissions: [] } }), config, dependencies),
    (error) => error.code === "FORBIDDEN"
  );
  await assert.rejects(
    dispatch(request("change-price", { headers: { "x-admin-csrf": "wrong", "idempotency-key": "product-price-key-0001" } }), auth(), config, dependencies),
    (error) => error.code === "CSRF_VALIDATION_FAILED"
  );
  assert.equal(calls, 0);
});

test("HTTP and trusted Action transports preserve the same strict body", async () => {
  const payload = {
    id: "product-1",
    newPriceCents: 7300,
    expectedPriceCents: 7200,
    expectedVersion: 4,
    reason: "transport contract"
  };
  const requests = [
    buildRequest({
      httpMethod: "POST",
      rawPath: "/api/admin/v1/products/change-price",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "price-http-key-0001" },
      body: JSON.stringify(payload)
    }),
    buildRequest({
      action: "mutate",
      resource: "products",
      mutationAction: "change-price",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "price-action-key-0001" },
      data: payload
    })
  ];
  for (const transportRequest of requests) {
    let command;
    await dispatch(transportRequest, auth(), config, {
      productPriceService: {
        async setPrice(value) {
          command = value;
          return { productId: "product-1", beforePrice: 7200, afterPrice: 7300, isActive: true, version: 5, changed: true };
        }
      }
    });
    assert.deepEqual(command.input, {
      productId: "product-1",
      newPriceCents: 7300,
      expectedPriceCents: 7200,
      expectedVersion: 4,
      reason: "transport contract"
    });
  }
});

test("version conflicts and corrupt stored data map to stable non-leaking 409 errors", async () => {
  for (const code of ["DATA_VERSION_CONFLICT", "DATA_VERSION_INVALID", "DATA_PRICE_INVALID"]) {
    await assert.rejects(
      dispatch(request(), auth(), config, {
        productPriceService: {
          async setPrice() {
            const error = new Error(`internal ${code} products/product-1`);
            error.code = code;
            error.statusCode = 409;
            error.details = { documentPath: "products/product-1", rawPrice: "6900" };
            throw error;
          }
        }
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.statusCode, 409);
        if (code !== "DATA_VERSION_CONFLICT") {
          assert.equal(error.details, undefined);
          assert.equal(JSON.stringify(error).includes("products/product-1"), false);
          assert.equal(JSON.stringify(error).includes("6900"), false);
        }
        return true;
      },
      code
    );
  }
});

test("remaining non-status product mutations stay explicitly unmigrated", async () => {
  for (const [action, permission] of [["import-confirm", "inventory:import"]]) {
    await assert.rejects(
      dispatch(request(action), auth({ principal: { permissions: [permission] } }), config, {
        productPriceService: { async setPrice() { throw new Error("must not run"); } }
      }),
      (error) => error.code === "SERVICE_NOT_MIGRATED" && error.statusCode === 501,
      action
    );
  }
});
