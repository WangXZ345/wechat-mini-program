"use strict";

const MANUAL_REVIEWABLE_STATUSES = new Set(["pending_admin", "auto_reviewing"]);
const AUTO_REVIEWABLE_STATUSES = new Set(["auto_reviewing"]);
const APPROVED_ORDER_STATUSES = new Set([
  "approved_pending_payment",
  "pending_payment_confirm",
  "paid",
  "partial_paid",
  "unpaid"
]);
const TERMINAL_REVIEW_STATUSES = new Set(["rejected", "cancelled"]);
const USER_CANCELLABLE_STATUSES = new Set(["pending_admin", "auto_reviewing"]);
const ADMIN_CANCELLABLE_STATUSES = new Set([
  "pending_admin",
  "auto_reviewing",
  "approved_pending_payment"
]);
const PAID_ORDER_PAYMENT_STATUSES = new Set(["paid", "partial_paid"]);
const SHIPPED_ORDER_STATUSES = new Set(["shipped", "completed", "picked_up"]);
const CONFIRMED_PAYMENT_RECORD_STATUSES = new Set(["paid", "partial", "partial_paid"]);
const PENDING_PAYMENT_CONFIRMATION_STATUSES = new Set(["pending", "pending_confirm"]);

function canReviewOrder(status) {
  return MANUAL_REVIEWABLE_STATUSES.has(status);
}

function canAutoReviewOrder(status) {
  return AUTO_REVIEWABLE_STATUSES.has(status);
}

function isApprovedOrderStatus(status) {
  return APPROVED_ORDER_STATUSES.has(status);
}

function isApprovedOrder(status, paymentStatus) {
  return isApprovedOrderStatus(status) || paymentStatus === "paid";
}

function isTerminalReviewStatus(status) {
  return TERMINAL_REVIEW_STATUSES.has(status);
}

function canCancelOrderStatus(status, actorKind) {
  const allowed = actorKind === "admin"
    ? ADMIN_CANCELLABLE_STATUSES
    : USER_CANCELLABLE_STATUSES;
  return allowed.has(status);
}

function hasBlockingOrderPayment(order = {}) {
  return Number(order.paidAmount || 0) > 0
    || PAID_ORDER_PAYMENT_STATUSES.has(order.paymentStatus);
}

function hasBlockingOrderShipping(order = {}) {
  return SHIPPED_ORDER_STATUSES.has(order.deliveryStatus)
    || SHIPPED_ORDER_STATUSES.has(order.shippingStatus);
}

function isConfirmedPaymentRecord(record = {}) {
  return CONFIRMED_PAYMENT_RECORD_STATUSES.has(record.status)
    || CONFIRMED_PAYMENT_RECORD_STATUSES.has(record.paymentStatus)
    || record.confirmStatus === "confirmed";
}

function isPendingPaymentConfirmationRecord(record = {}) {
  return record.status === "pending_confirm"
    || record.paymentStatus === "pending_confirm"
    || PENDING_PAYMENT_CONFIRMATION_STATUSES.has(record.confirmStatus);
}

function requiresCancellationInventoryRestore(status) {
  return status === "approved_pending_payment";
}

const orderStatusPolicy = {
  canAutoReviewOrder,
  canCancelOrderStatus,
  canReviewOrder,
  hasBlockingOrderPayment,
  hasBlockingOrderShipping,
  isApprovedOrder,
  isApprovedOrderStatus,
  isConfirmedPaymentRecord,
  isPendingPaymentConfirmationRecord,
  isTerminalReviewStatus,
  requiresCancellationInventoryRestore
};

const exportedStatusSets = {
  ADMIN_CANCELLABLE_STATUSES,
  APPROVED_ORDER_STATUSES,
  AUTO_REVIEWABLE_STATUSES,
  CONFIRMED_PAYMENT_RECORD_STATUSES,
  MANUAL_REVIEWABLE_STATUSES,
  PAID_ORDER_PAYMENT_STATUSES,
  PENDING_PAYMENT_CONFIRMATION_STATUSES,
  SHIPPED_ORDER_STATUSES,
  TERMINAL_REVIEW_STATUSES,
  USER_CANCELLABLE_STATUSES
};

for (const [name, statuses] of Object.entries(exportedStatusSets)) {
  Object.defineProperty(orderStatusPolicy, name, {
    enumerable: true,
    get() {
      return new Set(statuses);
    }
  });
}

module.exports = orderStatusPolicy;
