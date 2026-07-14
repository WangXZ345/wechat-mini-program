const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const security = require("../security");
const api = require("../index");
const { parseHttpRoute } = require("../lib/core");

const { dispatch, shipmentQueryApiError } = api._test;

function principal(overrides = {}) {
  return {
    id: "admin-1",
    role: "customer_service",
    status: "active",
    isActive: true,
    permissions: ["shipment:view"],
    ...overrides
  };
}

function auth(actor = principal()) {
  return { principal: actor, rawAdmin: { _id: actor.id }, session: {} };
}

test("shipment GET routes are parsed before the generic resource routes", () => {
  assert.deepEqual(parseHttpRoute("/api/admin/v1/shipments", "GET"), { action: "shipmentList" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/shipments/group-1", "GET"), {
    action: "shipmentDetail",
    id: "group-1"
  });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/shipments/merge", "POST"), {
    action: "mutate",
    resource: "shipments",
    mutationAction: "merge"
  });
});

test("shipment list and detail pass the authenticated principal to the canonical service", async () => {
  const calls = [];
  const shipmentQueryService = {
    async listWebShipments(input) {
      calls.push(["list", input]);
      return { items: [{ id: "group-1" }], pageSize: 20, hasMore: false, nextCursor: null };
    },
    async getWebShipment(input) {
      calls.push(["detail", input]);
      return { shipment: { id: "group-1" }, orders: [], itemSummary: [], logs: [] };
    }
  };
  const actor = principal();
  const list = await dispatch(
    { route: { action: "shipmentList" }, query: { status: "created" } },
    auth(actor),
    {},
    { shipmentQueryService }
  );
  const detail = await dispatch(
    { route: { action: "shipmentDetail", id: "group-1" }, query: {} },
    auth(actor),
    {},
    { shipmentQueryService }
  );

  assert.equal(list.items[0].id, "group-1");
  assert.equal(detail.shipment.id, "group-1");
  assert.equal(calls[0][1].actor, actor);
  assert.deepEqual(calls[0][1].query, { status: "created" });
  assert.equal(calls[1][1].actor, actor);
  assert.equal(calls[1][1].id, "group-1");
});

test("procurement and principals without shipment view are rejected before the service", async () => {
  let calls = 0;
  const dependencies = {
    shipmentQueryService: {
      async listWebShipments() { calls += 1; },
      async getWebShipment() { calls += 1; }
    }
  };
  await assert.rejects(
    dispatch({ route: { action: "shipmentList" }, query: {} }, auth(principal({ role: "procurement" })), {}, dependencies),
    (error) => error.code === "FORBIDDEN" && error.statusCode === 403
  );
  await assert.rejects(
    dispatch({ route: { action: "shipmentDetail", id: "group-1" }, query: {} }, auth(principal({ permissions: [] })), {}, dependencies),
    (error) => error.code === "FORBIDDEN" && error.statusCode === 403
  );
  assert.equal(calls, 0);
});

test("known shipment query errors have fixed public status and messages", () => {
  for (const [code, statusCode] of [
    ["SHIPMENT_QUERY_INVALID", 400],
    ["SHIPMENT_CURSOR_INVALID", 400],
    ["FORBIDDEN", 403],
    ["SHIPMENT_NOT_FOUND", 404],
    ["SHIPMENT_RELATED_ROWS_LIMIT_EXCEEDED", 503],
    ["SHIPMENT_READ_FAILED", 503]
  ]) {
    const mapped = shipmentQueryApiError({ code, statusCode: 418, message: "raw collection and index failure" });
    assert.equal(mapped.code, code);
    assert.equal(mapped.statusCode, statusCode);
    assert.equal(mapped.message.includes("raw collection"), false);
  }
  const unknown = shipmentQueryApiError(new Error("secret database message"));
  assert.equal(unknown.code, "SHIPMENT_READ_FAILED");
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.message.includes("secret"), false);
});

test("shipment mutations remain permission and CSRF protected then return 501", async () => {
  const tokenPepper = "s".repeat(32);
  const csrfToken = "shipment-csrf-token";
  const mutationAuth = auth(principal({ permissions: ["shipment:merge", "shipment:ship", "shipment:update"] }));
  mutationAuth.session.csrfTokenHash = security.tokenHash(csrfToken, tokenPepper);
  for (const action of ["merge", "ship", "edit"]) {
    await assert.rejects(
      dispatch({
        route: { action: "mutate", resource: "shipments", mutationAction: action },
        headers: { "x-admin-csrf": csrfToken },
        http: true
      }, mutationAuth, { tokenPepper }),
      (error) => error.code === "SERVICE_NOT_MIGRATED" && error.statusCode === 501,
      action
    );
  }
});

test("guarded packaging declares shipmentGroups and canonical shipment query hash gates", () => {
  const script = fs.readFileSync(path.join(__dirname, "../../../scripts/package-admin-web-cloudfunctions.ps1"), "utf8");
  assert.match(script, /shipmentGroups/);
  assert.match(script, /canonicalShipmentQueryServiceSha256/);
  assert.match(script, /ShipmentQueryServiceHashVerified/);
  assert.match(script, /uploadPerformed\s*=\s*\$false/);
});

test("deployable adminWebApi shipment query service is the canonical byte copy", () => {
  const canonical = fs.readFileSync(path.join(__dirname, "../../common/services/shipmentQueryService.js"));
  const deployable = fs.readFileSync(path.join(__dirname, "../lib/shipmentQueryService.js"));
  assert.deepEqual(deployable, canonical);
});
