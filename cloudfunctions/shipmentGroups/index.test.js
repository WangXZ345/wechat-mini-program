const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");

const indexPath = path.join(__dirname, "index.js");
const canonicalPath = path.join(__dirname, "..", "common", "services", "shipmentQueryService.js");
const deployablePath = path.join(__dirname, "shipmentQueryService.js");

function actor() {
  return { id: "admin-1", role: "customer_service", status: "active", isActive: true, permissions: ["shipment:view"] };
}

async function withShipmentGroups(stubService, run, options = {}) {
  const originalLoad = Module._load;
  const fakeDb = {
    command: {},
    collection() { throw new Error("legacy read query reached"); },
    serverDate() { return new Date(); }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() { return fakeDb; }
  };
  const auth = {
    async requirePermission(permission) {
      assert.equal(permission, "shipment:view");
      return actor();
    },
    async requireAnyPermission() { return actor(); },
    hasPermission() { return false; },
    async logAdminOperation() {},
    async ensureCollection() {},
    ...(options.auth || {})
  };
  const address = {
    addressSnapshot(value) { return value; },
    maskedAddressSnapshot(value) { return value; },
    canViewFullAddress() { return false; },
    canExportAddress() { return false; }
  };
  const phone = { canViewFullPhone() { return false; }, maskPhone() { return "***"; } };
  const idempotency = {
    async runIdempotentAction() { throw new Error("not used"); },
    async beginIdempotentAction() { throw new Error("not used"); },
    async finishIdempotentAction() {}, async failIdempotentAction() {},
    idempotencyEarlyReturn() { return null; }, idempotencyErrorResponse() { return null; }, firstSuccessData(value) { return value; }
  };
  const fakeXlsx = { utils: {}, write() { return Buffer.alloc(0); } };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename === indexPath) {
      if (request === "wx-server-sdk") return fakeCloud;
      if (request === "xlsx") return fakeXlsx;
      if (request === "./auth") return auth;
      if (request === "./address") return address;
      if (request === "./phone") return phone;
      if (request === "./idempotency") return idempotency;
      if (request === "./shipmentQueryService") {
        return { createShipmentQueryService() { return stubService; } };
      }
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[require.resolve(indexPath)];
  try {
    const shipmentGroups = require(indexPath);
    await run(shipmentGroups);
  } finally {
    delete require.cache[require.resolve(indexPath)];
    Module._load = originalLoad;
  }
}

test("deployable shipment query service is byte-identical to the canonical source", () => {
  assert.equal(fs.readFileSync(deployablePath, "utf8"), fs.readFileSync(canonicalPath, "utf8"));
});

test("getAdminShipmentGroups delegates to the canonical legacy list projector and preserves wrapper shape", async () => {
  const calls = [];
  const expected = { groups: [{ _id: "sg-1" }], hasMore: false, page: 2, pageSize: 30 };
  await withShipmentGroups({
    async listLegacyShipmentGroups(input) { calls.push(input); return expected; },
    async getLegacyShipmentGroupDetail() { throw new Error("not used"); }
  }, async (shipmentGroups) => {
    const result = await shipmentGroups.main({
      action: "getAdminShipmentGroups", keyword: "SHP-001", status: "pending_shipment", page: 2, pageSize: 30
    });
    assert.deepEqual(result, { ok: true, data: expected });
    assert.deepEqual(calls, [{
      actor: actor(),
      query: { keyword: "SHP-001", status: "pending_shipment", page: 2, pageSize: 30 }
    }]);
  });
});

test("getShipmentGroupDetail delegates to the canonical legacy detail projector and preserves wrapper shape", async () => {
  const calls = [];
  const expected = { shipmentGroup: { _id: "sg-1" }, orders: [], items: [], itemSummary: [], logs: [] };
  await withShipmentGroups({
    async listLegacyShipmentGroups() { throw new Error("not used"); },
    async getLegacyShipmentGroupDetail(input) { calls.push(input); return expected; }
  }, async (shipmentGroups) => {
    const result = await shipmentGroups.main({ action: "getShipmentGroupDetail", shipmentGroupId: "sg-1" });
    assert.deepEqual(result, { ok: true, data: expected });
    assert.deepEqual(calls, [{ actor: actor(), id: "sg-1" }]);
  });
});

test("missing and unknown actions retain the safe wrapper error", async () => {
  await withShipmentGroups({
    async listLegacyShipmentGroups() { throw new Error("not used"); },
    async getLegacyShipmentGroupDetail() { throw new Error("not used"); }
  }, async (shipmentGroups) => {
    assert.deepEqual(await shipmentGroups.main({}), { ok: false, code: "", message: "未知合并发货操作" });
    assert.deepEqual(await shipmentGroups.main({ action: "confirmShipmentTypo" }), { ok: false, code: "", message: "未知合并发货操作" });
  });
});

test("all seven write actions dispatch to their exact authorization guards without touching the database", async () => {
  const guards = [];
  const denied = new Error("WRITE_GUARD_DENIED");
  const auth = {
    async requirePermission(permission) { guards.push(["one", permission]); throw denied; },
    async requireAnyPermission(permissions) { guards.push(["any", permissions]); throw denied; }
  };
  const cases = [
    ["checkMergeShipmentEligibility", ["any", ["shipment:merge", "order:ship"]]],
    ["createMergeShipment", ["one", "shipment:merge"]],
    ["updateShipmentInfo", ["any", ["shipment:update", "shipment:ship"]]],
    ["confirmShipment", ["one", "shipment:ship"]],
    ["cancelMergeShipment", ["one", "shipment:cancel"]],
    ["completeShipment", ["one", "shipment:complete"]],
    ["exportShipmentPickingList", ["one", "shipment:export"]]
  ];
  await withShipmentGroups({
    async listLegacyShipmentGroups() { throw new Error("not used"); },
    async getLegacyShipmentGroupDetail() { throw new Error("not used"); }
  }, async (shipmentGroups) => {
    for (const [action] of cases) {
      const response = await shipmentGroups.main({ action });
      assert.deepEqual(response, { ok: false, code: "", message: "WRITE_GUARD_DENIED" });
    }
  }, { auth });
  assert.deepEqual(guards, cases.map((entry) => entry[1]));
});

function sourceRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, startMarker);
  assert.notEqual(end, -1, endMarker);
  return source.slice(start, end).replace(/\r\n/g, "\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").toUpperCase();
}

test("write implementation blocks retain the reviewed state and idempotency skeleton", () => {
  const source = fs.readFileSync(indexPath, "utf8");
  const blocks = [
    sourceRange(source, "async function checkMergeShipmentEligibility", "async function getAdminShipmentGroups"),
    sourceRange(source, "async function updateShipmentInfo", "function buildWorkbook"),
    sourceRange(source, "async function exportShipmentPickingList", "const handlers =")
  ];
  assert.deepEqual(blocks.map(sha256), [
    "3793D7ED85EA4D03A52CD46FA86E42887F2407574B6E420A8D6F5630D87EA4D4",
    "2E2F7482C6C3F78F0BA9D824C8D551B606C04CD8B2148169A3D0363DAC46F82D",
    "4DAB52F612F19204C0E8C7D25922D1D193A8656A763627007BAB325D37972D1C"
  ]);
  assert.match(blocks[0], /runIdempotentAction\s*\(/);
  assert.equal((blocks[1].match(/beginIdempotentAction\s*\(/g) || []).length, 3);
  assert.equal((blocks[1].match(/idempotencyEarlyReturn\s*\(/g) || []).length, 3);
  assert.equal((blocks[1].match(/failIdempotentAction\s*\(/g) || []).length, 3);
  assert.equal((blocks[1].match(/EDITABLE_STATUSES\.includes/g) || []).length, 3);
  assert.match(blocks[1], /allowCancelMergeShipmentBeforeShipped/);
  assert.match(blocks[1], /shippingStatus\s*!==\s*"shipped"/);
});
