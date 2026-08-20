"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ShipmentTransitionError,
  SHIPMENT_COMMANDS,
  SHIPMENT_STATUSES,
  normalizeShipmentStatus,
  assertShipmentTransition,
  planShipmentTransition
} = require("./shipmentStateMachine");

const ALL_STATUSES = ["created", "pending_shipment", "shipped", "completed", "cancelled", "abnormal"];

function actor(permission) {
  return { id: "admin-1", role: "customer_service", status: "active", isActive: true, permissions: [permission] };
}

function order(id, status = "pending_shipment", extra = {}) {
  return {
    _id: id,
    status: "approved",
    shippingStatus: status,
    paymentStatus: "paid",
    shippingType: "delivery",
    userId: "customer-1",
    version: 2,
    ...extra
  };
}

function shipment(status = "created", extra = {}) {
  return { _id: "shipment-1", userId: "customer-1", shippingStatus: status, orderIds: ["order-1", "order-2"], version: 2, ...extra };
}

function inputFor(command, status) {
  const permission = {
    ship_single_order: "shipment:ship",
    add_orders_to_merge: "shipment:merge",
    confirm_merge: "shipment:merge",
    edit_logistics: "shipment:update",
    cancel_pending: "shipment:cancel",
    confirm_shipment: "shipment:ship",
    complete_shipment: "shipment:complete"
  }[command];
  const base = { command, actor: actor(permission), expectedVersion: 2, settings: {} };
  if (command === "ship_single_order") return { ...base, order: order("order-1", status), logistics: { shippingCompany: "SF", trackingNo: "SF001" } };
  if (command === "add_orders_to_merge") {
    return { ...base, shipment: shipment("created"), orders: [order("order-1", status), order("order-2", status)] };
  }
  const associatedOrderStatus = command === "complete_shipment" ? "shipped" : "pending_shipment";
  const mergedOrders = [
    order("order-1", associatedOrderStatus, { mergeShipmentId: "shipment-1", mergeShipmentStatus: status }),
    order("order-2", associatedOrderStatus, { mergeShipmentId: "shipment-1", mergeShipmentStatus: status })
  ];
  return {
    ...base,
    shipment: shipment(status),
    orders: mergedOrders,
    logistics: { shippingCompany: "SF", trackingNo: "SF001" }
  };
}

function errorCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof ShipmentTransitionError, true);
    assert.equal(error.code, code);
    assert.equal(typeof error.statusCode, "number");
    assert.equal(Object.keys(error).some((key) => /openid|customer|address|payment/i.test(key)), false);
    return true;
  });
}

test("exports the complete frozen status and command metadata", () => {
  assert.deepEqual(SHIPMENT_STATUSES, ALL_STATUSES);
  assert.deepEqual(Object.keys(SHIPMENT_COMMANDS).sort(), [
    "add_orders_to_merge", "cancel_pending", "complete_shipment", "confirm_merge",
    "confirm_shipment", "edit_logistics", "ship_single_order"
  ]);
  assert.equal(Object.isFrozen(SHIPMENT_STATUSES), true);
  assert.equal(Object.isFrozen(SHIPMENT_COMMANDS), true);
});

test("normalizes explicit and legacy status without guessing conflicting data", () => {
  assert.equal(normalizeShipmentStatus({ shippingStatus: "created" }), "created");
  assert.equal(normalizeShipmentStatus({ deliveryStatus: "shipped" }), "shipped");
  assert.equal(normalizeShipmentStatus({ deliveryStatus: "completed" }), "completed");
  assert.equal(normalizeShipmentStatus({ deliveryStatus: "after_sales" }), "abnormal");
  assert.equal(normalizeShipmentStatus({ status: "approved" }), "pending_shipment");
  errorCode(() => normalizeShipmentStatus({}), "SHIPMENT_STATUS_INVALID");
  errorCode(() => normalizeShipmentStatus({ shippingStatus: "mystery" }), "SHIPMENT_STATUS_INVALID");
  errorCode(() => normalizeShipmentStatus({ shippingStatus: "shipped", deliveryStatus: "completed" }), "SHIPMENT_STATUS_INVALID");
});

const legalEdges = [
  ["ship_single_order", "pending_shipment", "shipped"],
  ["add_orders_to_merge", "pending_shipment", "created"],
  ["confirm_merge", "created", "pending_shipment"],
  ["edit_logistics", "created", "pending_shipment"],
  ["edit_logistics", "pending_shipment", "pending_shipment"],
  ["cancel_pending", "created", "cancelled"],
  ["cancel_pending", "pending_shipment", "cancelled"],
  ["confirm_shipment", "created", "shipped"],
  ["confirm_shipment", "pending_shipment", "shipped"],
  ["complete_shipment", "shipped", "completed"]
];

for (const [command, from, to] of legalEdges) {
  test(`allows ${command}: ${from} -> ${to}`, () => {
    const result = assertShipmentTransition(inputFor(command, from));
    assert.equal(result.fromStatus, from);
    assert.equal(result.toStatus, to);
  });
}

for (const command of ["ship_single_order", "add_orders_to_merge", "confirm_merge", "edit_logistics", "cancel_pending", "confirm_shipment", "complete_shipment"]) {
  const legal = new Set(legalEdges.filter(([candidate]) => candidate === command).map(([, from]) => from));
  for (const status of ALL_STATUSES.filter((candidate) => !legal.has(candidate))) {
    test(`rejects illegal edge ${command}: ${status}`, () => {
      errorCode(() => assertShipmentTransition(inputFor(command, status)), "SHIPMENT_TRANSITION_NOT_ALLOWED");
    });
  }
}

test("rejects invalid command and inactive, role-less, or under-permissioned actors", () => {
  errorCode(() => assertShipmentTransition({ ...inputFor("ship_single_order", "pending_shipment"), command: "ship_now" }), "SHIPMENT_COMMAND_INVALID");
  errorCode(() => assertShipmentTransition({ ...inputFor("ship_single_order", "pending_shipment"), actor: { ...actor("shipment:ship"), isActive: false } }), "INVALID_ACTOR");
  errorCode(() => assertShipmentTransition({ ...inputFor("ship_single_order", "pending_shipment"), actor: { ...actor("shipment:ship"), role: "" } }), "INVALID_ACTOR");
  errorCode(() => assertShipmentTransition({ ...inputFor("ship_single_order", "pending_shipment"), actor: actor("shipment:view") }), "FORBIDDEN");
  errorCode(() => assertShipmentTransition({ ...inputFor("ship_single_order", "pending_shipment"), actor: { ...actor("shipment:ship"), role: "procurement" } }), "FORBIDDEN");
  assert.equal(assertShipmentTransition({ ...inputFor("ship_single_order", "pending_shipment"), actor: actor("order:ship") }).requiredPermission, "order:ship");
});

test("requires an explicit valid matching version and treats legacy missing version as zero", () => {
  const base = inputFor("ship_single_order", "pending_shipment");
  errorCode(() => assertShipmentTransition({ ...base, expectedVersion: undefined }), "EXPECTED_VERSION_REQUIRED");
  for (const expectedVersion of [-1, 1.2, "2", Number.MAX_SAFE_INTEGER + 1]) {
    errorCode(() => assertShipmentTransition({ ...base, expectedVersion }), "EXPECTED_VERSION_INVALID");
  }
  errorCode(() => assertShipmentTransition({ ...base, expectedVersion: 1 }), "DATA_VERSION_CONFLICT");
  errorCode(() => assertShipmentTransition({ ...base, order: { ...base.order, version: "2" } }), "DATA_VERSION_CONFLICT");
  assert.equal(assertShipmentTransition({ ...base, order: { ...base.order, version: undefined }, expectedVersion: 0 }).fromStatus, "pending_shipment");
});

test("merge creation fails closed unless every candidate order matches the explicit expectedVersion", () => {
  const base = inputFor("add_orders_to_merge", "pending_shipment");
  errorCode(() => assertShipmentTransition({
    ...base,
    orders: [base.orders[0], { ...base.orders[1], version: 3 }]
  }), "DATA_VERSION_CONFLICT");
});

test("fails closed for unapproved, unpaid, and disallowed partially paid orders", () => {
  const base = inputFor("ship_single_order", "pending_shipment");
  errorCode(() => assertShipmentTransition({ ...base, order: { ...base.order, status: "pending_review" } }), "SHIPMENT_ORDER_NOT_APPROVED");
  errorCode(() => assertShipmentTransition({ ...base, order: { ...base.order, paymentStatus: "unpaid" }, settings: {} }), "SHIPMENT_PAYMENT_REQUIRED");
  errorCode(() => assertShipmentTransition({ ...base, order: { ...base.order, paymentStatus: "unpaid" }, settings: { requirePaidBeforeShipment: true } }), "SHIPMENT_PAYMENT_REQUIRED");
  errorCode(() => assertShipmentTransition({ ...base, order: { ...base.order, paymentStatus: "partial_paid" }, settings: { requirePaidBeforeShipment: true } }), "SHIPMENT_PAYMENT_REQUIRED");
  assert.equal(assertShipmentTransition({ ...base, order: { ...base.order, paymentStatus: "partial_paid" }, settings: { requirePaidBeforeShipment: true, allowPartialPaidShipment: true } }).toStatus, "shipped");
  assert.equal(assertShipmentTransition({ ...base, order: { ...base.order, paymentStatus: "unpaid" }, settings: { requirePaidBeforeShipment: false } }).toStatus, "shipped");
});

test("treats canonical approved aliases as reviewed while payment settings remain authoritative", () => {
  const base = inputFor("ship_single_order", "pending_shipment");
  assert.equal(assertShipmentTransition({
    ...base,
    order: { ...base.order, status: "pending_payment_confirm", paymentStatus: "paid" }
  }).toStatus, "shipped");

  const partialPaid = { ...base.order, status: "partial_paid", paymentStatus: "partial_paid" };
  assert.equal(assertShipmentTransition({
    ...base,
    order: partialPaid,
    settings: { requirePaidBeforeShipment: true, allowPartialPaidShipment: true }
  }).toStatus, "shipped");
  errorCode(() => assertShipmentTransition({
    ...base,
    order: partialPaid,
    settings: { requirePaidBeforeShipment: true, allowPartialPaidShipment: false }
  }), "SHIPMENT_PAYMENT_REQUIRED");

  const unpaid = { ...base.order, status: "unpaid", paymentStatus: "unpaid" };
  assert.equal(assertShipmentTransition({
    ...base,
    order: unpaid,
    settings: { requirePaidBeforeShipment: false }
  }).toStatus, "shipped");
  errorCode(() => assertShipmentTransition({
    ...base,
    order: unpaid,
    settings: { requirePaidBeforeShipment: true }
  }), "SHIPMENT_PAYMENT_REQUIRED");

  errorCode(() => assertShipmentTransition({
    ...base,
    order: { ...base.order, status: "pending_review", paymentStatus: "paid" }
  }), "SHIPMENT_ORDER_NOT_APPROVED");
});

test("merged transitions fail closed unless every synchronized order matches expectedVersion", () => {
  for (const [command, status] of [["confirm_merge", "created"], ["confirm_shipment", "pending_shipment"], ["cancel_pending", "created"], ["complete_shipment", "shipped"]]) {
    const base = inputFor(command, status);
    errorCode(() => assertShipmentTransition({
      ...base,
      orders: [base.orders[0], { ...base.orders[1], version: 3 }]
    }), "DATA_VERSION_CONFLICT");
  }
});

test("merged transitions reject every associated order outside the command source state", () => {
  for (const [command, shipmentStatus, requiredOrderStatus] of [
    ["confirm_merge", "created", "pending_shipment"],
    ["confirm_shipment", "pending_shipment", "pending_shipment"],
    ["cancel_pending", "created", "pending_shipment"],
    ["complete_shipment", "shipped", "shipped"]
  ]) {
    const base = inputFor(command, shipmentStatus);
    const invalidStatus = requiredOrderStatus === "shipped" ? "completed" : "completed";
    errorCode(() => assertShipmentTransition({
      ...base,
      orders: [
        { ...base.orders[0], shippingStatus: requiredOrderStatus, mergeShipmentStatus: requiredOrderStatus },
        { ...base.orders[1], shippingStatus: invalidStatus, mergeShipmentStatus: invalidStatus }
      ]
    }), "SHIPMENT_TRANSITION_NOT_ALLOWED");
  }
});

test("merged transitions reject a shipment whose customer differs from bound orders", () => {
  const base = inputFor("confirm_shipment", "pending_shipment");
  errorCode(() => assertShipmentTransition({
    ...base,
    shipment: { ...base.shipment, userId: "customer-2" }
  }), "SHIPMENT_CUSTOMER_MISMATCH");
});

test("merge creation accepts mixed legacy identities when every order shares an openid", () => {
  const base = inputFor("add_orders_to_merge", "pending_shipment");
  const orders = [
    { ...base.orders[0], userId: "customer-1", userOpenid: "openid-1" },
    { ...base.orders[1], userId: undefined, userOpenid: "openid-1" }
  ];
  assert.equal(assertShipmentTransition({ ...base, orders }).toStatus, "created");
});

test("bound transition accepts the common openid across shipment and legacy orders", () => {
  const base = inputFor("confirm_shipment", "pending_shipment");
  const shipmentRecord = { ...base.shipment, userId: "customer-1", openid: "openid-1" };
  const orders = base.orders.map((record) => ({
    ...record,
    userId: undefined,
    userOpenid: "openid-1"
  }));
  assert.equal(assertShipmentTransition({ ...base, shipment: shipmentRecord, orders }).toStatus, "shipped");
});

test("customer identity comparison fails closed without a shared non-empty identifier", () => {
  const mergeBase = inputFor("add_orders_to_merge", "pending_shipment");
  errorCode(() => assertShipmentTransition({
    ...mergeBase,
    orders: [
      { ...mergeBase.orders[0], userId: "customer-1", userOpenid: "openid-1" },
      { ...mergeBase.orders[1], userId: "customer-2", userOpenid: "openid-2" }
    ]
  }), "SHIPMENT_CUSTOMER_MISMATCH");
  errorCode(() => assertShipmentTransition({
    ...mergeBase,
    orders: mergeBase.orders.map((record) => ({
      ...record,
      userId: undefined,
      userOpenid: undefined,
      openid: undefined
    }))
  }), "SHIPMENT_CUSTOMER_MISMATCH");
});

test("merge creation rejects an existing binding with an unknown binding status", () => {
  const base = inputFor("add_orders_to_merge", "pending_shipment");
  errorCode(() => assertShipmentTransition({
    ...base,
    orders: [base.orders[0], { ...base.orders[1], mergeShipmentId: "shipment-old", mergeShipmentStatus: "mystery" }]
  }), "SHIPMENT_ALREADY_BOUND");
});

test("paid status alone cannot normalize an unreviewed order as pending shipment", () => {
  errorCode(() => normalizeShipmentStatus({ status: "pending_review", paymentStatus: "paid" }), "SHIPMENT_STATUS_INVALID");
});

test("merge creation requires a valid future shipment identifier", () => {
  const base = inputFor("add_orders_to_merge", "pending_shipment");
  errorCode(() => planShipmentTransition({ ...base, shipment: undefined }), "SHIPMENT_BINDING_INCONSISTENT");
  errorCode(() => planShipmentTransition({ ...base, shipment: { ...base.shipment, _id: "" } }), "SHIPMENT_BINDING_INCONSISTENT");
});

test("rejects unsafe merge candidates", () => {
  const base = inputFor("add_orders_to_merge", "pending_shipment");
  errorCode(() => assertShipmentTransition({ ...base, orders: [base.orders[0], { ...base.orders[1], shippingType: "pickup" }] }), "SHIPMENT_PICKUP_NOT_ALLOWED");
  errorCode(() => assertShipmentTransition({ ...base, orders: [base.orders[0], { ...base.orders[1], userId: "customer-2" }] }), "SHIPMENT_CUSTOMER_MISMATCH");
  errorCode(() => assertShipmentTransition({ ...base, orders: [base.orders[0], { ...base.orders[0] }] }), "SHIPMENT_ORDER_DUPLICATE");
  errorCode(() => assertShipmentTransition({ ...base, orders: [base.orders[0], { ...base.orders[1], mergeShipmentId: "other-active", mergeShipmentStatus: "created" }] }), "SHIPMENT_ALREADY_BOUND");
  errorCode(() => assertShipmentTransition({ ...base, orders: [base.orders[0], { ...base.orders[1], shippingAddressSnapshot: { detailAddress: "different" } }], settings: { allowMergeDifferentAddress: false } }), "SHIPMENT_ADDRESS_MISMATCH");
});

test("rejects missing, duplicate, cross-customer, and inconsistent merged bindings", () => {
  const base = inputFor("confirm_shipment", "pending_shipment");
  errorCode(() => assertShipmentTransition({ ...base, orders: [base.orders[0]] }), "SHIPMENT_BINDING_INCONSISTENT");
  errorCode(() => assertShipmentTransition({ ...base, shipment: { ...base.shipment, orderIds: ["order-1", "order-1"] } }), "SHIPMENT_BINDING_INCONSISTENT");
  errorCode(() => assertShipmentTransition({ ...base, orders: [base.orders[0], { ...base.orders[1], userId: "customer-2" }] }), "SHIPMENT_CUSTOMER_MISMATCH");
  errorCode(() => assertShipmentTransition({ ...base, orders: [base.orders[0], { ...base.orders[1], mergeShipmentId: "shipment-2" }] }), "SHIPMENT_BINDING_INCONSISTENT");
  errorCode(() => assertShipmentTransition({ ...base, orders: [base.orders[0], { ...base.orders[1], shipmentGroupId: "shipment-2", mergeShipmentId: undefined }] }), "SHIPMENT_BINDING_INCONSISTENT");
});

test("shipping confirmation requires complete logistics", () => {
  for (const command of ["ship_single_order", "confirm_shipment"]) {
    const base = inputFor(command, command === "ship_single_order" ? "pending_shipment" : "created");
    errorCode(() => assertShipmentTransition({ ...base, logistics: { trackingNo: "SF001" } }), "SHIPMENT_LOGISTICS_REQUIRED");
    errorCode(() => assertShipmentTransition({ ...base, logistics: { shippingCompany: "SF" } }), "SHIPMENT_LOGISTICS_REQUIRED");
  }
});

test("plans synchronized whitelist-only deeply immutable shipment and order patches", () => {
  const base = inputFor("confirm_shipment", "pending_shipment");
  const plan = planShipmentTransition(base);
  assert.deepEqual(Object.keys(plan).sort(), ["fromStatus", "orderPatches", "requiredPermission", "shipmentPatch", "toStatus"]);
  assert.equal(plan.shipmentPatch.shippingStatus, "shipped");
  assert.equal(plan.shipmentPatch.version, 3);
  assert.deepEqual(plan.orderPatches.map((entry) => entry.orderId), ["order-1", "order-2"]);
  assert.equal(plan.orderPatches.every((entry) => entry.patch.shippingStatus === "shipped" && entry.patch.version === 3), true);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.shipmentPatch), true);
  assert.equal(Object.isFrozen(plan.orderPatches), true);
  assert.equal(Object.isFrozen(plan.orderPatches[0].patch), true);
  assert.throws(() => { plan.shipmentPatch.shippingStatus = "cancelled"; }, TypeError);
  const serializedKeys = [];
  (function visit(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { serializedKeys.push(key); visit(child); }
  }(plan));
  assert.equal(serializedKeys.some((key) => /stock|inventory|amount|account|payment|price|debt|balance/i.test(key)), false);
});

test("cancel plan unbinds merged orders while complete plan preserves binding", () => {
  const cancelled = planShipmentTransition(inputFor("cancel_pending", "created"));
  assert.equal(cancelled.shipmentPatch.shippingStatus, "cancelled");
  assert.equal(cancelled.orderPatches.every(({ patch }) => patch.shippingStatus === "pending_shipment" && patch.mergeShipmentId === null && patch.shipmentGroupId === null), true);
  const completed = planShipmentTransition(inputFor("complete_shipment", "shipped"));
  assert.equal(completed.orderPatches.every(({ patch }) => patch.shippingStatus === "completed" && !Object.hasOwn(patch, "mergeShipmentId")), true);
});
