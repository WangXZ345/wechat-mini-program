const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const cloudfunctionsRoot = path.join(__dirname, "..");
const addressCopies = [
  "addMyAddress/common/address.js",
  "cancelMergeShipment/common/address.js",
  "checkMergeShipmentEligibility/common/address.js",
  "common/address.js",
  "common/common/address.js",
  "completeShipment/common/address.js",
  "confirmShipment/common/address.js",
  "createMergeShipment/common/address.js",
  "createOrder/common/address.js",
  "deleteMyAddress/common/address.js",
  "exportOrdersExcel/address.js",
  "exportOrdersExcel/common/address.js",
  "exportShipmentPickingList/common/address.js",
  "getAdminCustomerAddresses/address.js",
  "getAdminCustomerAddresses/common/address.js",
  "getAdminShipmentGroups/common/address.js",
  "getDefaultAddress/common/address.js",
  "getMyAddresses/common/address.js",
  "getOrders/address.js",
  "getOrders/common/address.js",
  "getShipmentGroupDetail/common/address.js",
  "setDefaultAddress/common/address.js",
  "shipmentGroups/common/address.js",
  "submitCartOrder/common/address.js",
  "updateMyAddress/common/address.js",
  "updateShipmentInfo/common/address.js"
];

test("all 26 address helper copies require explicit permissions for procurement", async (t) => {
  assert.equal(addressCopies.length, 26);
  for (const relativePath of addressCopies) {
    await t.test(relativePath, () => {
      const helper = require(path.join(cloudfunctionsRoot, relativePath));
      assert.equal(helper.canViewFullAddress({ role: "procurement", permissions: [] }), false);
      assert.equal(helper.canExportAddress({ role: "procurement", permissions: [] }), false);
      assert.equal(helper.canViewFullAddress({
        role: "procurement",
        permissions: ["customer:view_address_full"]
      }), true);
      assert.equal(helper.canExportAddress({
        role: "procurement",
        permissions: ["customer:export_address"]
      }), true);
      assert.equal(helper.canViewFullAddress({ role: "super_admin", permissions: [] }), true);
      assert.equal(helper.canExportAddress({ role: "super_admin", permissions: [] }), true);
    });
  }
});
