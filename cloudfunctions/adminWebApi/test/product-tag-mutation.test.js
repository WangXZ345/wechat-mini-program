const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const security = require("../security");
const api = require("../index");
const { projectResource } = require("../lib/core");

const {
  buildRequest,
  dispatch,
  productBatchTagsRoute,
  normalizeProductBatchTagsMutation,
  productTagApiError,
  productBatchTagsMutationResult,
  defaultProductTagService
} = api._test;

const tokenPepper = "t".repeat(32);
const csrfToken = "csrf-token-for-product-tags";
const config = { tokenPepper };

function auth(overrides = {}) {
  return {
    principal: {
      id: "admin-session-id",
      role: "procurement",
      permissions: ["product:tag:batch_update"],
      status: "active",
      ...overrides.principal
    },
    rawAdmin: {
      _id: "raw-admin-id",
      openid: "server-openid",
      role: "procurement",
      ...overrides.rawAdmin
    },
    session: {
      csrfTokenHash: security.tokenHash(csrfToken, tokenPepper),
      ...overrides.session
    }
  };
}

function request(overrides = {}) {
  return {
    route: { action: "mutate", resource: "products", mutationAction: "batch-tags" },
    body: {
      scope: "public",
      tag: "新货",
      present: true,
      items: [
        { id: "product-1", expectedVersion: 3, expectedPresent: false },
        { id: "product-2", expectedVersion: 7, expectedPresent: true }
      ],
      reason: "批量设置新货"
    },
    headers: {
      "x-admin-csrf": csrfToken,
      "idempotency-key": "product-batch-tag-key-0001"
    },
    http: true,
    requestId: "request-product-tags-1",
    ...overrides
  };
}

test("deployable BFF tag service matches canonical and exposes only the explicit route", () => {
  assert.equal(
    fs.readFileSync(path.resolve(__dirname, "../lib/productTagService.js"), "utf8"),
    fs.readFileSync(path.resolve(__dirname, "../../common/services/productTagService.js"), "utf8")
  );
  assert.equal(typeof defaultProductTagService.setManyPublicTags, "function");
  assert.equal(productBatchTagsRoute({ resource: "products", mutationAction: "batch-tags" }), true);
  assert.equal(productBatchTagsRoute({ resource: "products", mutationAction: "batch-enable" }), false);
  assert.equal(productBatchTagsRoute({ resource: "inventory", mutationAction: "batch-tags" }), false);
});

test("normalizes the strict public explicit-set contract and deduplicates identical snapshots", () => {
  assert.deepEqual(normalizeProductBatchTagsMutation(request({
    body: {
      scope: "public",
      tag: " 热销 ",
      present: false,
      items: [
        { id: " product-1 ", expectedVersion: 3, expectedPresent: true },
        { id: "product-1", expectedVersion: 3, expectedPresent: true }
      ],
      reason: " 取消热销 "
    }
  })), {
    idempotencyKey: "product-batch-tag-key-0001",
    input: {
      scope: "public",
      tag: "热销",
      present: false,
      items: [{ id: "product-1", expectedVersion: 3, expectedPresent: true }],
      reason: "取消热销"
    }
  });
});

test("rejects unknown fields, aliases, internal tags, invalid snapshots and 101 raw items", () => {
  const baseItem = { id: "product-1", expectedVersion: 3, expectedPresent: false };
  const invalidBodies = [
    { scope: "internal", tag: "新货", present: true, items: [baseItem] },
    { scope: "public", tag: "内部", present: true, items: [baseItem] },
    { scope: "public", tag: "新货", present: 1, items: [baseItem] },
    { scope: "public", tag: "新货", present: true, items: [] },
    { scope: "public", tag: "新货", present: true, items: [{ id: "product-1", expectedVersion: "3", expectedPresent: false }] },
    { scope: "public", tag: "新货", present: true, items: [{ id: "product-1", expectedVersion: 3, expectedPresent: "false" }] },
    { scope: "public", tag: "新货", present: true, items: [{ ...baseItem, internalTags: ["secret"] }] },
    { scope: "public", tag: "新货", present: true, items: [baseItem], identity: "forged" },
    { scope: "public", tag: "新货", present: true, items: [baseItem], ids: ["product-1"] },
    { scope: "public", tag: "新货", present: true, items: [baseItem], productIds: ["product-1"] },
    { scope: "public", tag: "新货", present: true, items: [baseItem], setFlags: { isNew: true } },
    { scope: "public", tag: "新货", present: true, items: [baseItem], isFrequent: true },
    {
      scope: "public",
      tag: "新货",
      present: true,
      items: [
        baseItem,
        { id: "product-1", expectedVersion: 3, expectedPresent: true }
      ]
    },
    {
      scope: "public",
      tag: "新货",
      present: true,
      items: Array.from({ length: 101 }, () => baseItem)
    }
  ];
  for (const body of invalidBodies) {
    assert.throws(
      () => normalizeProductBatchTagsMutation(request({ body })),
      (error) => [
        "INVALID_REQUEST_BODY",
        "TAG_SCOPE_INVALID",
        "TAG_INVALID",
        "PUBLIC_TAG_INVALID",
        "TAG_PRESENT_INVALID",
        "BATCH_ITEMS_REQUIRED",
        "BATCH_ITEM_INVALID",
        "BATCH_SIZE_EXCEEDED",
        "EXPECTED_VERSION_INVALID",
        "EXPECTED_PRESENT_INVALID",
        "DUPLICATE_ITEM_CONFLICT"
      ].includes(error.code),
      JSON.stringify(body).slice(0, 240)
    );
  }
  assert.throws(
    () => normalizeProductBatchTagsMutation(request({ headers: { "x-admin-csrf": csrfToken } })),
    (error) => error.code === "IDEMPOTENCY_KEY_REQUIRED"
  );
});

test("dispatch derives actor from the session and returns the existing strict Web DTO", async () => {
  let command;
  const result = await dispatch(request(), auth(), config, {
    productTagService: {
      async setManyPublicTags(value) {
        command = value;
        return {
          changedCount: 1,
          unchangedCount: 0,
          failedCount: 1,
          warningCount: 1,
          failures: [{
            id: "product-2",
            code: "DATA_VERSION_CONFLICT",
            message: "internal products/product-2",
            internalTags: ["must-not-leak"]
          }]
        };
      }
    }
  });
  assert.deepEqual(command, {
    actor: {
      id: "admin-session-id",
      openid: "server-openid",
      role: "procurement",
      permissions: ["product:tag:batch_update"],
      status: "active",
      isActive: true,
      sourceClient: "admin_web"
    },
    input: request().body,
    idempotencyKey: "product-batch-tag-key-0001"
  });
  assert.deepEqual(result, {
    affected: 1,
    changedCount: 1,
    unchangedCount: 0,
    failedCount: 1,
    failures: [{ id: "product-2", code: "DATA_VERSION_CONFLICT" }],
    message: "已更新 1 个商品，1 个未处理",
    requestId: "request-product-tags-1"
  });
  assert.equal(Object.hasOwn(result, "warningCount"), false);
  for (const value of ["新货", "must-not-leak", "products/product-2"]) {
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test("permission and CSRF run before body validation or the tag service", async () => {
  let calls = 0;
  const dependencies = {
    productTagService: {
      async setManyPublicTags() {
        calls += 1;
        return {};
      }
    }
  };
  await assert.rejects(
    dispatch(request({ body: { invalid: true } }), auth({ principal: { permissions: [] } }), config, dependencies),
    (error) => error.code === "FORBIDDEN"
  );
  await assert.rejects(
    dispatch(request({
      body: { invalid: true },
      headers: { "x-admin-csrf": "wrong", "idempotency-key": "product-batch-tag-key-0001" }
    }), auth(), config, dependencies),
    (error) => error.code === "CSRF_VALIDATION_FAILED"
  );
  assert.equal(calls, 0);
});

test("HTTP and trusted Action transports preserve the same strict body", async () => {
  const payload = {
    scope: "public",
    tag: "瑕疵",
    present: true,
    items: [{ id: "product-1", expectedVersion: 3, expectedPresent: false }],
    reason: "标记瑕疵"
  };
  const requests = [
    buildRequest({
      httpMethod: "POST",
      rawPath: "/api/admin/v1/products/batch-tags",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "batch-tag-http-key-0001" },
      body: JSON.stringify(payload)
    }),
    buildRequest({
      action: "mutate",
      resource: "products",
      mutationAction: "batch-tags",
      headers: { "X-Admin-CSRF": csrfToken, "Idempotency-Key": "batch-tag-action-key-0001" },
      data: payload
    })
  ];
  for (const transportRequest of requests) {
    let command;
    const result = await dispatch(transportRequest, auth(), config, {
      productTagService: {
        async setManyPublicTags(value) {
          command = value;
          return { changedCount: 1, unchangedCount: 0, failedCount: 0, warningCount: 1, failures: [] };
        }
      }
    });
    assert.deepEqual(command.input, payload);
    assert.equal(result.changedCount, 1);
    assert.equal(Object.hasOwn(result, "warningCount"), false);
  }
});

test("strict result validation rejects malformed counts, failures and extra failure codes", () => {
  const expected = [{ id: "product-1" }];
  const invalidResults = [
    {},
    { changedCount: 1, unchangedCount: 0, failedCount: 0, failures: [] },
    { changedCount: 0, unchangedCount: 0, failedCount: 1, warningCount: 0, failures: [] },
    { changedCount: 0, unchangedCount: 0, failedCount: 1, warningCount: 0, failures: [{ id: "product-1", code: "INTERNAL_SECRET" }] },
    { changedCount: 0, unchangedCount: 1, failedCount: 0, warningCount: 2, failures: [] },
    { changedCount: 2, unchangedCount: 0, failedCount: 0, warningCount: 0, failures: [] }
  ];
  for (const result of invalidResults) {
    assert.throws(
      () => productBatchTagsMutationResult(result, "request-1", expected),
      (error) => error.code === "INVALID_SERVICE_RESPONSE" && error.statusCode === 502,
      JSON.stringify(result)
    );
  }
});

test("known conflicts map safely and unknown service exceptions fail closed as 502", () => {
  const conflict = new Error("internal products/product-1 openid-secret");
  conflict.code = "DATA_VERSION_CONFLICT";
  conflict.details = { path: "products/product-1", internalTags: ["secret"] };
  const mappedConflict = productTagApiError(conflict);
  assert.equal(mappedConflict.code, "DATA_VERSION_CONFLICT");
  assert.equal(mappedConflict.statusCode, 409);
  assert.equal(mappedConflict.message, "记录已变化，请刷新后重新确认");
  assert.equal(mappedConflict.details, undefined);

  const unknown = productTagApiError(new Error("database socket failed products/product-1"));
  assert.equal(unknown.code, "PRODUCT_TAG_SERVICE_UNAVAILABLE");
  assert.equal(unknown.statusCode, 502);
  assert.equal(unknown.message, "商品标签服务暂时不可用");
  assert.equal(JSON.stringify(unknown).includes("products/product-1"), false);
});

test("product projection emits canonical public tags from tags OR flags and never internal values", () => {
  const projected = projectResource("products", {
    _id: "product-1",
    tags: ["热销", "legacy-private", "新货"],
    internalTags: ["采购关注"],
    isNew: false,
    isDefective: true,
    isHot: false,
    version: 4
  }, {
    role: "procurement",
    status: "active",
    permissions: ["product:view"]
  });
  assert.deepEqual(projected.tags, ["新货", "瑕疵", "热销"]);
  assert.equal(Object.hasOwn(projected, "internalTags"), false);
  assert.equal(Object.hasOwn(projected, "isDefective"), false);
  assert.equal(JSON.stringify(projected).includes("legacy-private"), false);
  assert.equal(JSON.stringify(projected).includes("采购关注"), false);
});
