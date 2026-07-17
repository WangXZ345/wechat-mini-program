const test = require("node:test");
const assert = require("node:assert/strict");
const { projectResource } = require("../lib/core");

const financePrincipal = {
  role: "finance",
  status: "active",
  permissions: ["dashboard:view_sales", "refund:view"]
};

const superAdmin = {
  role: "super_admin",
  status: "active",
  permissions: ["*"]
};

function hasOwn(object, key) {
  return Object.hasOwn(object, key);
}

test("missing, empty and invalid money values are omitted across every money DTO", () => {
  const invalidValues = [undefined, null, "", "100", NaN, Infinity, -Infinity, 12.5];

  for (const value of invalidValues) {
    assert.equal(hasOwn(projectResource("products", { price: value }, superAdmin), "salePriceCents"), false, `products ${String(value)}`);
    assert.equal(hasOwn(projectResource("orders", { totalAmount: value }, financePrincipal), "totalAmountCents"), false, `orders ${String(value)}`);
    assert.equal(hasOwn(projectResource("payments", { paidAmount: value }, superAdmin), "amountCents"), false, `payments ${String(value)}`);

    const account = projectResource("accounts", {
      totalReceivableAmount: value,
      totalOrderAmount: value,
      paidAmount: value,
      totalPaidAmount: value,
      unpaidAmount: value,
      totalUnpaidAmount: value
    }, superAdmin);
    for (const key of ["receivableCents", "receivedCents", "unpaidAmountCents"]) {
      assert.equal(hasOwn(account, key), false, `accounts.${key} ${String(value)}`);
    }

    assert.equal(hasOwn(projectResource("after-sales", {
      requestedRefundAmount: value,
      refundAmount: value,
      approvedRefundAmount: value
    }, financePrincipal), "amountCents"), false, `after-sales ${String(value)}`);
    assert.equal(hasOwn(projectResource("refunds", { refundAmount: value }, superAdmin), "amountCents"), false, `refunds ${String(value)}`);
    assert.equal(hasOwn(projectResource("analytics", { price: value }, superAdmin), "salePriceCents"), false, `analytics ${String(value)}`);
  }
});

test("explicit zero is retained and wins over later compatibility fields", () => {
  assert.equal(projectResource("products", { price: 0, salePrice: 100, unitPrice: 200 }, superAdmin).salePriceCents, 0);
  assert.equal(projectResource("orders", { totalAmount: 0 }, financePrincipal).totalAmountCents, 0);
  assert.equal(projectResource("payments", { paidAmount: 0, amount: 100 }, superAdmin).amountCents, 0);

  const account = projectResource("accounts", {
    totalReceivableAmount: 0,
    totalOrderAmount: 100,
    paidAmount: 0,
    totalPaidAmount: 100,
    unpaidAmount: 0,
    totalUnpaidAmount: 100
  }, superAdmin);
  assert.equal(account.receivableCents, 0);
  assert.equal(account.receivedCents, 0);
  assert.equal(account.unpaidAmountCents, 0);

  assert.equal(projectResource("after-sales", {
    requestedRefundAmount: 0,
    refundAmount: 100,
    approvedRefundAmount: 200
  }, financePrincipal).amountCents, 0);
  assert.equal(projectResource("refunds", { refundAmount: 0 }, superAdmin).amountCents, 0);
  assert.equal(projectResource("analytics", { price: 0, salePrice: 100 }, superAdmin).salePriceCents, 0);
});

test("invalid preferred fields do not block the first valid compatibility amount", () => {
  assert.equal(hasOwn(projectResource("products", {
    salePrice: 1200,
    unitPrice: 1250
  }, superAdmin), "salePriceCents"), false);
  assert.equal(projectResource("products", {
    price: 1250,
    salePrice: 1200,
    unitPrice: 1300
  }, superAdmin).salePriceCents, 1250);
  assert.equal(projectResource("payments", {
    paidAmount: NaN,
    amount: 2300
  }, superAdmin).amountCents, 2300);

  const account = projectResource("accounts", {
    totalReceivableAmount: null,
    totalOrderAmount: 3100,
    paidAmount: Infinity,
    totalPaidAmount: 1200,
    unpaidAmount: 1.5,
    totalUnpaidAmount: 1900
  }, superAdmin);
  assert.equal(account.receivableCents, 3100);
  assert.equal(account.receivedCents, 1200);
  assert.equal(account.unpaidAmountCents, 1900);

  assert.equal(projectResource("after-sales", {
    requestedRefundAmount: "",
    refundAmount: NaN,
    approvedRefundAmount: 800
  }, financePrincipal).amountCents, 800);
  assert.equal(hasOwn(projectResource("analytics", { salePrice: 600 }, superAdmin), "salePriceCents"), false);
  assert.equal(projectResource("analytics", { price: 600, salePrice: 700 }, superAdmin).salePriceCents, 600);
});

test("money permissions are applied before value validity", () => {
  const customerService = {
    role: "customer_service",
    status: "active",
    permissions: ["order:view", "after_sale:view"]
  };
  assert.equal(hasOwn(projectResource("orders", { totalAmount: 0 }, customerService), "totalAmountCents"), false);
  assert.equal(hasOwn(projectResource("after-sales", { requestedRefundAmount: 0 }, customerService), "amountCents"), false);
});

test("customer service can see the requested after-sale amount but not refund outcomes", () => {
  const principal = { role: "customer_service", status: "active", permissions: ["after_sale:review"] };
  const projected = projectResource("after-sales", {
    requestedRefundAmount: 6789,
    approvedRefundAmount: 6000,
    refundAmount: 5000
  }, principal);
  assert.equal(projected.amountCents, 6789);
  assert.equal(Object.hasOwn(projectResource("after-sales", { requestedRefundAmount: 6789 }, {
    role: "finance",
    status: "active",
    permissions: ["after_sale:review"]
  }), "amountCents"), false);
});
