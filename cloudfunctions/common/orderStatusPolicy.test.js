"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("./orderStatusPolicy");

test("manual and automatic review keep distinct status boundaries", () => {
  assert.equal(policy.canReviewOrder("pending_admin"), true);
  assert.equal(policy.canReviewOrder("auto_reviewing"), true);
  assert.equal(policy.canReviewOrder("approved_pending_payment"), false);
  assert.equal(policy.canReviewOrder("rejected"), false);
  assert.equal(policy.canReviewOrder("cancelled"), false);

  assert.equal(policy.canAutoReviewOrder("auto_reviewing"), true);
  assert.equal(policy.canAutoReviewOrder("pending_admin"), false);
  assert.equal(policy.canAutoReviewOrder("approved_pending_payment"), false);
});

test("approved status and paid rejection guards preserve historical aliases", () => {
  for (const status of [
    "approved_pending_payment",
    "pending_payment_confirm",
    "paid",
    "partial_paid",
    "unpaid"
  ]) {
    assert.equal(policy.isApprovedOrderStatus(status), true, status);
    assert.equal(policy.isApprovedOrder(status, "unpaid"), true, status);
  }
  assert.equal(policy.isApprovedOrder("pending_admin", "paid"), true);
  assert.equal(policy.isApprovedOrder("pending_admin", "partial_paid"), false);
  assert.equal(policy.isApprovedOrderStatus("pending_admin"), false);
});

test("user and admin cancellation status policies remain role-specific", () => {
  for (const status of ["pending_admin", "auto_reviewing"]) {
    assert.equal(policy.canCancelOrderStatus(status, "user"), true, status);
    assert.equal(policy.canCancelOrderStatus(status, "admin"), true, status);
  }
  assert.equal(policy.canCancelOrderStatus("approved_pending_payment", "user"), false);
  assert.equal(policy.canCancelOrderStatus("approved_pending_payment", "admin"), true);
  assert.equal(policy.canCancelOrderStatus("pending_payment_confirm", "admin"), false);
  assert.equal(policy.canCancelOrderStatus("cancelled", "admin"), false);
});

test("order payment and fulfillment guards inspect the existing fields only", () => {
  assert.equal(policy.hasBlockingOrderPayment({ paidAmount: 1, paymentStatus: "unpaid" }), true);
  assert.equal(policy.hasBlockingOrderPayment({ paidAmount: 0, paymentStatus: "paid" }), true);
  assert.equal(policy.hasBlockingOrderPayment({ paidAmount: 0, paymentStatus: "partial_paid" }), true);
  assert.equal(policy.hasBlockingOrderPayment({ paidAmount: 0, paymentStatus: "partial" }), false);
  assert.equal(policy.hasBlockingOrderPayment({ paidAmount: 0, paymentStatus: "pending_confirm" }), false);

  for (const field of ["deliveryStatus", "shippingStatus"]) {
    for (const status of ["shipped", "completed", "picked_up"]) {
      assert.equal(policy.hasBlockingOrderShipping({ [field]: status }), true, `${field}:${status}`);
    }
  }
  assert.equal(policy.hasBlockingOrderShipping({ deliveryStatus: "pending", shippingStatus: "" }), false);
});

test("payment record guards preserve confirmed, partial, and pending-confirm aliases", () => {
  for (const status of ["paid", "partial", "partial_paid"]) {
    assert.equal(policy.isConfirmedPaymentRecord({ status }), true, `status:${status}`);
    assert.equal(policy.isConfirmedPaymentRecord({ paymentStatus: status }), true, `paymentStatus:${status}`);
  }
  assert.equal(policy.isConfirmedPaymentRecord({ confirmStatus: "confirmed" }), true);
  assert.equal(policy.isConfirmedPaymentRecord({ status: "pending_confirm" }), false);

  assert.equal(policy.isPendingPaymentConfirmationRecord({ status: "pending_confirm" }), true);
  assert.equal(policy.isPendingPaymentConfirmationRecord({ paymentStatus: "pending_confirm" }), true);
  assert.equal(policy.isPendingPaymentConfirmationRecord({ confirmStatus: "pending" }), true);
  assert.equal(policy.isPendingPaymentConfirmationRecord({ confirmStatus: "pending_confirm" }), true);
  assert.equal(policy.isPendingPaymentConfirmationRecord({ confirmStatus: "rejected" }), false);
});

test("only the approved-pending-payment cancellation path restores inventory", () => {
  assert.equal(policy.requiresCancellationInventoryRestore("approved_pending_payment"), true);
  for (const status of ["pending_admin", "auto_reviewing", "pending_payment_confirm", "paid"]) {
    assert.equal(policy.requiresCancellationInventoryRestore(status), false, status);
  }
});

test("mutating every exported status set cannot change policy decisions in the same process", () => {
  const setNames = [
    "ADMIN_CANCELLABLE_STATUSES",
    "APPROVED_ORDER_STATUSES",
    "AUTO_REVIEWABLE_STATUSES",
    "CONFIRMED_PAYMENT_RECORD_STATUSES",
    "MANUAL_REVIEWABLE_STATUSES",
    "PAID_ORDER_PAYMENT_STATUSES",
    "PENDING_PAYMENT_CONFIRMATION_STATUSES",
    "SHIPPED_ORDER_STATUSES",
    "TERMINAL_REVIEW_STATUSES",
    "USER_CANCELLABLE_STATUSES"
  ];

  function assertStable(candidate) {
    assert.equal(candidate.canReviewOrder("pending_admin"), true);
    assert.equal(candidate.canReviewOrder("paid"), false);
    assert.equal(candidate.canAutoReviewOrder("auto_reviewing"), true);
    assert.equal(candidate.canAutoReviewOrder("pending_admin"), false);
    assert.equal(candidate.isApprovedOrderStatus("unpaid"), true);
    assert.equal(candidate.isApprovedOrderStatus("pending_admin"), false);
    assert.equal(candidate.isTerminalReviewStatus("cancelled"), true);
    assert.equal(candidate.canCancelOrderStatus("approved_pending_payment", "admin"), true);
    assert.equal(candidate.canCancelOrderStatus("approved_pending_payment", "user"), false);
    assert.equal(candidate.hasBlockingOrderPayment({ paymentStatus: "partial_paid" }), true);
    assert.equal(candidate.hasBlockingOrderShipping({ shippingStatus: "picked_up" }), true);
    assert.equal(candidate.isConfirmedPaymentRecord({ status: "partial" }), true);
    assert.equal(candidate.isPendingPaymentConfirmationRecord({ confirmStatus: "pending" }), true);
  }

  for (const name of setNames) {
    const exported = policy[name];
    const original = [...exported];
    try {
      exported.add("__polluted__");
      exported.delete(original[0]);
      exported.clear();
      exported.add("__polluted__");
      assertStable(policy);

      const requiredAgain = require("./orderStatusPolicy");
      assertStable(requiredAgain);
      assert.notStrictEqual(requiredAgain[name], exported, `${name} must be a defensive copy`);
      assert.deepEqual([...requiredAgain[name]], original, `${name} must retain canonical values`);
    } finally {
      exported.clear();
      for (const status of original) exported.add(status);
    }
  }
});
