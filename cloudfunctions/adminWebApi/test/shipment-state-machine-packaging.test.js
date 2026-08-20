"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseHttpRoute } = require("../lib/core");

const canonicalPath = path.join(__dirname, "..", "..", "common", "services", "shipmentStateMachine.js");
const adminCopyPath = path.join(__dirname, "..", "lib", "shipmentStateMachine.js");
const shipmentGroupsCopyPath = path.join(__dirname, "..", "..", "shipmentGroups", "shipmentStateMachine.js");

test("all deployable shipment state machines are byte-identical and expose the canonical contract", () => {
  const canonical = fs.readFileSync(canonicalPath);
  assert.deepEqual(fs.readFileSync(adminCopyPath), canonical);
  assert.deepEqual(fs.readFileSync(shipmentGroupsCopyPath), canonical);
  const expectedExports = [
    "SHIPMENT_COMMANDS", "SHIPMENT_STATUSES", "ShipmentTransitionError",
    "assertShipmentTransition", "normalizeShipmentStatus", "planShipmentTransition"
  ];
  assert.deepEqual(Object.keys(require(adminCopyPath)).sort(), expectedExports);
  assert.deepEqual(Object.keys(require(shipmentGroupsCopyPath)).sort(), expectedExports);
  assert.deepEqual(require(adminCopyPath).SHIPMENT_COMMANDS, require(canonicalPath).SHIPMENT_COMMANDS);
});

test("P1-08 does not enable adminWebApi shipment write routes", () => {
  for (const action of ["merge", "ship", "edit", "cancel", "complete"]) {
    assert.deepEqual(parseHttpRoute(`/api/admin/v1/shipments/${action}`, "POST"), {
      action: "mutate", resource: "shipments", mutationAction: action
    });
  }
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.equal(source.includes("shipmentStateMachine"), false);
});
