const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const api = require("../index");

const {
  dispatch,
  productWriteRoute,
  normalizeProductWriteMutation,
  defaultProductWriteService
} = api._test;

const tokenPepper = "w".repeat(32);
const csrfToken = "csrf-token-for-product-write";
const config = { tokenPepper };

function auth(permission = "product:create") {
  return {
    principal: { id: "session-admin", role: "procurement", permissions: [permission], status: "active" },
    rawAdmin: { _id: "raw-admin", openid: "server-openid", role: "finance" },
    session: { csrfTokenHash: security.tokenHash(csrfToken, tokenPepper) }
  };
}

function metadata(overrides = {}) {
  return {
    name: "测试精华", baseName: "测试精华", imageUrl: "cloud://image", specification: "50ml",
    productionDate: "2026-07", description: "商品说明", productIndex: "P000009", skuCode: "SKU-9",
    keywords: ["精华", "修护"], ...overrides
  };
}

function request(action = "create", overrides = {}) {
  const body = action === "create"
    ? { metadata: metadata(), initial: { salePriceCents: 6900, stock: 8, warningThreshold: 10, isActive: true, tags: ["新货"] }, reason: "网页新增" }
    : { id: "product-1", expectedVersion: 3, metadata: metadata(), reason: "网页编辑" };
  return {
    route: { action: "mutate", resource: "products", mutationAction: action },
    body,
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": `product-${action}-key-0001` },
    http: true,
    requestId: `request-${action}`,
    ...overrides
  };
}

test("only product create and edit are handled by the product write service", () => {
  assert.equal(typeof defaultProductWriteService.createProduct, "function");
  assert.equal(typeof defaultProductWriteService.updateProductMetadata, "function");
  assert.equal(productWriteRoute({ resource: "products", mutationAction: "create" }), true);
  assert.equal(productWriteRoute({ resource: "products", mutationAction: "edit" }), true);
  assert.equal(productWriteRoute({ resource: "products", mutationAction: "change-price" }), false);
});

test("normalizes the exact create and edit contracts", () => {
  assert.deepEqual(normalizeProductWriteMutation(request()), {
    idempotencyKey: "product-create-key-0001",
    action: "create",
    input: { ...metadata(), priceCents: 6900, stock: 8, warningStock: 10, isActive: true, publicTags: ["新货"], reason: "网页新增" }
  });
  assert.deepEqual(normalizeProductWriteMutation(request("edit")), {
    idempotencyKey: "product-edit-key-0001",
    action: "edit",
    input: { productId: "product-1", ...metadata(), expectedVersion: 3, reason: "网页编辑" }
  });
});

test("edit rejects operational fields at every nesting level", () => {
  for (const field of ["price", "salePriceCents", "stock", "warningStock", "warningThreshold", "isActive", "tags", "internalTags", "defectDescription", "autoHideWhenOutOfStock", "brand", "category"]) {
    assert.throws(
      () => normalizeProductWriteMutation(request("edit", { body: { ...request("edit").body, metadata: { ...metadata(), [field]: field === "tags" ? [] : 1 } } })),
      (error) => error.code === "INVALID_REQUEST_BODY",
      field
    );
  }
  assert.throws(() => normalizeProductWriteMutation(request("edit", { body: { ...request("edit").body, stock: 10 } })), (error) => error.code === "INVALID_REQUEST_BODY");
});

test("requires complete typed metadata, strict initial values, version and idempotency", () => {
  const missingName = metadata(); delete missingName.name;
  assert.throws(() => normalizeProductWriteMutation(request("create", { body: { ...request().body, metadata: missingName } })), (error) => error.code === "INVALID_REQUEST_BODY");
  assert.throws(() => normalizeProductWriteMutation(request("create", { body: { ...request().body, initial: { ...request().body.initial, salePriceCents: "6900" } } })), (error) => error.code === "INVALID_REQUEST_BODY");
  assert.throws(() => normalizeProductWriteMutation(request("edit", { body: { ...request("edit").body, expectedVersion: undefined } })), (error) => error.code === "EXPECTED_VERSION_REQUIRED");
  assert.throws(() => normalizeProductWriteMutation(request("create", { headers: { "x-admin-csrf": csrfToken } })), (error) => error.code === "IDEMPOTENCY_KEY_REQUIRED");
});

test("dispatch derives the actor from session and maps create to a safe list DTO", async () => {
  let command;
  const result = await dispatch(request(), auth(), config, {
    productWriteService: {
      async createProduct(value) {
        command = value;
        return {
          productId: "product-9", productIndex: "P000009", metadata: metadata(), price: 6900, stock: 8,
          warningStock: 10, stockStatus: "warning", isActive: true, tags: ["新货"], version: 1,
          updatedAt: new Date("2026-07-12T08:00:00.000Z"), changed: true
        };
      }
    }
  });
  assert.deepEqual(command.actor, {
    id: "session-admin", openid: "server-openid", role: "procurement", permissions: ["product:create"],
    status: "active", isActive: true, sourceClient: "admin_web"
  });
  assert.equal(command.input.priceCents, 6900);
  assert.equal(command.input.stock, 8);
  assert.equal(Object.hasOwn(command.input, "internalTags"), false);
  assert.deepEqual(result, {
    item: {
      id: "product-9", sku: "P000009", name: "测试精华", brand: "", status: "active", isActive: true,
      tags: ["新货"], updatedAt: "2026-07-12T08:00:00.000Z", version: 1, salePriceCents: 6900
    },
    affected: 1, message: "商品资料已保存", requestId: "request-create"
  });
});

test("dispatch maps edit to metadata service and no-op to affected zero", async () => {
  let command;
  const result = await dispatch(request("edit"), auth("product:update"), config, {
    productWriteService: {
      async updateProductMetadata(value) {
        command = value;
        return { productId: "product-1", metadata: metadata(), price: 6900, stock: 8, warningStock: 10, stockStatus: "warning", isActive: true, tags: [], version: 3, changed: false };
      }
    }
  });
  assert.equal(command.requireExpectedVersion, true);
  assert.equal(command.input.expectedVersion, 3);
  assert.equal(result.affected, 0);
  assert.equal(result.message, "商品资料未发生变化");
});

test("permission and CSRF checks precede service invocation", async () => {
  let calls = 0;
  const dependencies = { productWriteService: { async createProduct() { calls += 1; } } };
  await assert.rejects(dispatch(request(), auth("product:update"), config, dependencies), (error) => error.code === "FORBIDDEN");
  await assert.rejects(dispatch(request("create", { headers: { "idempotency-key": "product-create-key-0001" } }), auth(), config, dependencies), (error) => error.code === "CSRF_VALIDATION_FAILED");
  assert.equal(calls, 0);
});

test("product detail is strict and never exposes internal or operational-only storage fields", () => {
  const dto = api._test.getResource;
  assert.equal(typeof dto, "function");
  const projected = require("../lib/core").projectResource("products", {
    _id: "product-1", ...metadata(), price: 6900, stock: 8, warningStock: 10, isActive: true, tags: ["新货"],
    internalTags: ["供应商A"], defectDescription: "压痕", autoHideWhenOutOfStock: true, version: 3
  }, { role: "procurement", status: "active", permissions: ["product:view"] }, true);
  assert.deepEqual(Object.keys(projected).sort(), ["id", "initial", "metadata", "updatedAt", "version"]);
  assert.equal(JSON.stringify(projected).includes("供应商A"), false);
  assert.equal(JSON.stringify(projected).includes("压痕"), false);
  assert.deepEqual(projected.initial.tags, ["新货"]);
});
