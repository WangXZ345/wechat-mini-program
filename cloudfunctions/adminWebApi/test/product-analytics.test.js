const test = require("node:test");
const assert = require("node:assert/strict");

const api = require("../index");
const {
  analyticsApiError,
  projectProductAnalytics,
  readProductAnalytics
} = api._test;

function principal(overrides = {}) {
  return {
    id: "admin-1",
    role: "procurement",
    status: "active",
    permissions: ["product:analytics:view", "inventory:view"],
    ...overrides
  };
}

function rawOverview(overrides = {}) {
  return {
    range: "7d",
    status: "available",
    message: "真实聚合",
    summary: {
      salesCount: 3,
      salesAmountCents: 300,
      orderCount: 2,
      averagePriceCents: 100,
      changes: { salesCount: 50, salesAmountCents: 50, orderCount: 0, averagePriceCents: 0 },
      orderNo: "must-not-leak"
    },
    series: [{
      date: "2026-07-11",
      salesCount: 3,
      averagePriceCents: 100,
      quotePriceCents: null,
      inventoryChange: -3,
      orderId: "must-not-leak",
      operator: "must-not-leak"
    }],
    ranking: [{
      id: "p1",
      name: "商品一",
      sku: "SKU-1",
      salesCount: 3,
      averagePriceCents: 100,
      currentPriceCents: 110,
      change: null,
      phone: "13800000000",
      address: "must-not-leak"
    }],
    updatedAt: "2026-07-11T04:00:00.000Z",
    openid: "must-not-leak",
    ...overrides
  };
}

test("procurement receives aggregate metrics but never the sales amount summary", async () => {
  const result = await readProductAnalytics({ range: "7d" }, principal(), {
    async getOverview(input) {
      assert.deepEqual(input, { range: "7d" });
      return rawOverview();
    }
  });
  assert.deepEqual(result.summary.map((item) => item.key), ["salesCount", "orderCount", "averagePriceCents"]);
  assert.equal(result.series[0].inventoryChange, -3);
  assert.equal(result.ranking[0].currentPriceCents, 110);
});

test("super_admin receives sales amount while inventory data still follows inventory:view semantics", () => {
  const superResult = projectProductAnalytics(rawOverview(), principal({ role: "super_admin", permissions: [] }));
  assert.equal(superResult.summary.some((item) => item.key === "salesAmountCents"), true);
  assert.equal(superResult.series[0].inventoryChange, -3);

  const noInventory = projectProductAnalytics(
    rawOverview(),
    principal({ permissions: ["product:analytics:view"] })
  );
  assert.equal(noInventory.series[0].inventoryChange, null);
});

test("BFF recursively strips order, customer, actor and raw-log fields", () => {
  const projected = projectProductAnalytics(rawOverview(), principal());
  const serialized = JSON.stringify(projected).toLowerCase();
  for (const forbidden of [
    "orderno",
    "orderid",
    "userid",
    "openid",
    "phone",
    "address",
    "operator",
    "reason",
    "relatedorderid",
    "beforestock",
    "afterstock"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("an injected permission cannot widen customer_service or finance roles", async () => {
  let calls = 0;
  const service = { async getOverview() { calls += 1; return rawOverview(); } };
  for (const role of ["customer_service", "finance"]) {
    await assert.rejects(
      readProductAnalytics({}, principal({ role, permissions: ["product:analytics:view", "inventory:view"] }), service),
      (error) => error.code === "FORBIDDEN" && error.statusCode === 403
    );
  }
  assert.equal(calls, 0);
});

test("missing analytics permission blocks procurement before querying", async () => {
  let calls = 0;
  await assert.rejects(
    readProductAnalytics({}, principal({ permissions: [] }), { async getOverview() { calls += 1; } }),
    (error) => error.code === "FORBIDDEN" && error.statusCode === 403
  );
  assert.equal(calls, 0);
});

test("empty service results keep summary truth while forcing series and ranking empty", () => {
  const projected = projectProductAnalytics(rawOverview({
    status: "empty",
    summary: {
      salesCount: 0,
      salesAmountCents: 0,
      orderCount: 0,
      averagePriceCents: null,
      changes: { salesCount: null, salesAmountCents: null, orderCount: null, averagePriceCents: null }
    },
    series: [{ date: "2026-07-11", salesCount: 1, averagePriceCents: 1, quotePriceCents: 1, inventoryChange: 1 }],
    ranking: [{ id: "bad", name: "bad", sku: "bad", salesCount: 1, averagePriceCents: 1, currentPriceCents: 1, change: 1 }]
  }), principal());
  assert.equal(projected.status, "empty");
  assert.deepEqual(projected.series, []);
  assert.deepEqual(projected.ranking, []);
  assert.equal(projected.summary.find((item) => item.key === "averagePriceCents").value, null);
});

test("malformed arrays and timestamps fail closed instead of becoming fake empty or fresh data", () => {
  for (const malformed of [
    rawOverview({ series: null }),
    rawOverview({ ranking: null }),
    rawOverview({ series: Array.from({ length: 91 }, () => rawOverview().series[0]) }),
    rawOverview({ ranking: Array.from({ length: 21 }, () => rawOverview().ranking[0]) }),
    rawOverview({ updatedAt: "not-a-date" })
  ]) {
    assert.throws(
      () => projectProductAnalytics(malformed, principal()),
      (error) => error.code === "ANALYTICS_SOURCE_UNAVAILABLE" && error.statusCode === 503
    );
  }
});

test("analytics errors map only the public 400/422/503 allowlist", () => {
  assert.equal(analyticsApiError({ code: "ANALYTICS_RANGE_INVALID", message: "raw", statusCode: 999 }).statusCode, 400);
  assert.equal(analyticsApiError({ code: "ANALYTICS_DATA_INVALID", message: "raw field", statusCode: 999 }).statusCode, 422);
  assert.equal(analyticsApiError({ code: "ANALYTICS_SOURCE_UNAVAILABLE", message: "index name", statusCode: 999 }).statusCode, 503);
  const unknown = new Error("database internals");
  assert.equal(analyticsApiError(unknown), unknown);
});

test("dispatch awaits the injected product analytics service", async () => {
  const request = {
    route: { action: "productAnalytics" },
    query: { range: "30d" }
  };
  const auth = { principal: principal(), rawAdmin: {}, session: {} };
  const result = await api._test.dispatch(request, auth, {}, {
    productAnalyticsService: {
      async getOverview(input) {
        await Promise.resolve();
        return rawOverview({ range: input.range });
      }
    }
  });
  assert.equal(result.range, "30d");
  assert.equal(result.status, "available");
});
