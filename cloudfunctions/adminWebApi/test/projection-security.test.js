const test = require("node:test");
const assert = require("node:assert/strict");
const permissionModel = require("../permissions");
const {
  boundedPermissions,
  getMutationPermission,
  hasPermission,
  projectResource
} = require("../lib/core");

function principalFor(role) {
  const requested = role === "ordinary_user"
    ? permissionModel.ALL_PERMISSIONS
    : permissionModel.permissionsForRole(role);
  return {
    role,
    status: "active",
    permissions: boundedPermissions({ role, permissions: requested }, permissionModel)
  };
}

const principals = {
  ordinary_user: principalFor("ordinary_user"),
  customer_service: principalFor("customer_service"),
  finance: principalFor("finance"),
  procurement: principalFor("procurement"),
  super_admin: principalFor("super_admin")
};

test("ordinary user and four admin roles keep their bounded read matrix", () => {
  const permissions = [
    "order:view",
    "after_sale:view",
    "payment:view_screenshot",
    "refund:view",
    "customer:view_account",
    "product:view",
    "inventory:view"
  ];
  const actual = Object.fromEntries(Object.entries(principals).map(([role, principal]) => [
    role,
    Object.fromEntries(permissions.map((permission) => [permission, hasPermission(principal, permission)]))
  ]));

  assert.deepEqual(actual, {
    ordinary_user: {
      "order:view": false, "after_sale:view": false, "payment:view_screenshot": false,
      "refund:view": false, "customer:view_account": false, "product:view": false, "inventory:view": false
    },
    customer_service: {
      "order:view": true, "after_sale:view": true, "payment:view_screenshot": false,
      "refund:view": false, "customer:view_account": false, "product:view": false, "inventory:view": false
    },
    finance: {
      "order:view": true, "after_sale:view": true, "payment:view_screenshot": true,
      "refund:view": true, "customer:view_account": true, "product:view": false, "inventory:view": false
    },
    procurement: {
      "order:view": false, "after_sale:view": false, "payment:view_screenshot": false,
      "refund:view": false, "customer:view_account": false, "product:view": true, "inventory:view": true
    },
    super_admin: {
      "order:view": true, "after_sale:view": true, "payment:view_screenshot": true,
      "refund:view": true, "customer:view_account": true, "product:view": true, "inventory:view": true
    }
  });
});

test("ordinary user and four admin roles keep their bounded mutation matrix", () => {
  const mutations = {
    orderReview: getMutationPermission("orders", "review"),
    paymentConfirm: getMutationPermission("payments", "confirm"),
    inventoryAdjust: getMutationPermission("inventory", "adjust"),
    afterSaleApprove: getMutationPermission("after-sales", "approve"),
    refundProcess: getMutationPermission("refunds", "process")
  };
  const actual = Object.fromEntries(Object.entries(principals).map(([role, principal]) => [
    role,
    Object.fromEntries(Object.entries(mutations).map(([name, permission]) => [name, hasPermission(principal, permission)]))
  ]));

  assert.deepEqual(actual, {
    ordinary_user: { orderReview: false, paymentConfirm: false, inventoryAdjust: false, afterSaleApprove: false, refundProcess: false },
    customer_service: { orderReview: true, paymentConfirm: false, inventoryAdjust: false, afterSaleApprove: true, refundProcess: false },
    finance: { orderReview: false, paymentConfirm: true, inventoryAdjust: false, afterSaleApprove: false, refundProcess: true },
    procurement: { orderReview: false, paymentConfirm: false, inventoryAdjust: true, afterSaleApprove: false, refundProcess: false },
    super_admin: { orderReview: true, paymentConfirm: true, inventoryAdjust: true, afterSaleApprove: true, refundProcess: true }
  });
});

test("customer service order and after-sale DTOs omit financial amounts", () => {
  const orderRow = { _id: "order-1", orderNo: "NO-1", totalAmount: 12345 };
  const afterSaleRow = {
    _id: "after-sale-1",
    afterSaleNo: "AS-1",
    requestedRefundAmount: 6789,
    approvedRefundAmount: 6000
  };

  const customerServiceOrder = projectResource("orders", orderRow, principals.customer_service, true);
  const customerServiceAfterSale = projectResource("after-sales", afterSaleRow, principals.customer_service, true);
  assert.equal(Object.hasOwn(customerServiceOrder, "totalAmountCents"), false);
  assert.equal(Object.hasOwn(customerServiceAfterSale, "amountCents"), false);

  for (const principal of [principals.finance, principals.super_admin]) {
    assert.equal(projectResource("orders", orderRow, principal, true).totalAmountCents, 12345);
    assert.equal(projectResource("after-sales", afterSaleRow, principal, true).amountCents, 6789);
  }
});

test("all customer-bearing DTOs re-mask untrusted customer labels and phones", () => {
  const phone = "13800138000";
  const row = {
    _id: "row-1",
    customerMasked: `客户 ${phone} 李四`,
    itemSummary: `商品备注联系电话 ${phone}`,
    adminRemark: `客服回拨 ${phone}`,
    shippingAddressMasked: `上海市*** ${phone}`,
    trackingNo: phone
  };
  const resources = ["orders", "payments", "accounts", "shipments", "after-sales", "refunds"];

  for (const resource of resources) {
    const dto = projectResource(resource, row, principals.super_admin, true);
    assert.equal(dto.customerMasked, "138****8000", resource);
    assert.equal(JSON.stringify(dto).includes(phone), false, resource);
  }

  const untrustedAddress = projectResource("orders", {
    ...row,
    customerMasked: "openid-customer-identifier",
    shippingAddressMasked: `上海市浦东新区完整地址 ${phone}`
  }, principals.super_admin, true);
  assert.equal(untrustedAddress.customerMasked, "o***");
  assert.equal(untrustedAddress.shippingAddressMasked, "地址已脱敏");
  assert.equal(JSON.stringify(untrustedAddress).includes(phone), false);
});

test("address DTOs never trust forged masking markers", () => {
  const leakedAddress = "*** 上海市浦东新区世纪大道 100 号 8 栋 1201 室 已脱敏";
  const dto = projectResource("orders", {
    _id: "order-address-1",
    shippingAddressMasked: leakedAddress
  }, principals.customer_service, true);
  assert.equal(dto.shippingAddressMasked, "地址已脱敏");
  assert.equal(JSON.stringify(dto).includes("世纪大道"), false);
  assert.equal(JSON.stringify(dto).includes("1201"), false);
});

test("phone masking covers compatibility digits and common hidden separators", () => {
  const canonicalPhone = "13800138000";
  const variants = [
    "１３８００１３８０００",
    "138.0013.8000",
    "(138) 0013 8000",
    "138\u00a00013\u00a08000",
    "1\u200b3\u200b8\u200b0\u200b0\u200b1\u200b3\u200b8\u200b0\u200b0\u200b0",
    "+86 (138) 0013-8000",
    "١٣٨:٠٠١٣|٨٠٠٠",
    "۱۳۸:۰۰۱۳|۸۰۰۰"
  ];
  const asciiDigits = (value) => Array.from(String(value || ""), (character) => {
    const code = character.codePointAt(0);
    if (code >= 0x30 && code <= 0x39) return String(code - 0x30);
    if (code >= 0xff10 && code <= 0xff19) return String(code - 0xff10);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
    return "";
  }).join("");
  const containsCanonicalPhone = (value) => asciiDigits(value).includes(canonicalPhone);

  for (const variant of variants) {
    const dto = projectResource("orders", {
      _id: "order-phone-variant",
      customerMasked: variant,
      itemSummary: `商品联系 ${variant}`,
      adminRemark: `客服回拨 ${variant}`,
      shippingAddressMasked: `*** 收货地址 ${variant}`
    }, principals.super_admin, true);
    for (const field of ["customerMasked", "itemSummary", "adminRemark", "shippingAddressMasked"]) {
      assert.equal(containsCanonicalPhone(dto[field]), false, `${field}: ${JSON.stringify(variant)}`);
    }
  }
});

test("phone masking preserves non-phone brand, specification and product identifiers verbatim", () => {
  const itemSummary = "SK-Ⅱ 精华 50㎖ ①号色 | SKU 123456789012";
  const adminRemark = "保留 SK-Ⅱ、50㎖、①号色；商品号 138001380001";
  const dto = projectResource("orders", {
    _id: "order-preserve-text",
    itemSummary,
    adminRemark
  }, principals.super_admin, true);
  assert.equal(dto.itemSummary, itemSummary);
  assert.equal(dto.adminRemark, adminRemark);
});
