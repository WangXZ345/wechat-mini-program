const test = require("node:test");
const assert = require("node:assert/strict");
const { canViewFullAddress, canExportAddress } = require("./address");

test("procurement needs explicit full-address permission to view a full address", () => {
  assert.equal(canViewFullAddress({ role: "procurement", permissions: [] }), false);
  assert.equal(canViewFullAddress({
    role: "procurement",
    permissions: ["customer:view_address_full"]
  }), true);
  assert.equal(canViewFullAddress({ role: "super_admin", permissions: [] }), true);
});

test("procurement needs explicit address-export permission to export addresses", () => {
  assert.equal(canExportAddress({ role: "procurement", permissions: [] }), false);
  assert.equal(canExportAddress({
    role: "procurement",
    permissions: ["customer:export_address"]
  }), true);
  assert.equal(canExportAddress({ role: "super_admin", permissions: [] }), true);
});
