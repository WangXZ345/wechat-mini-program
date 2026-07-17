"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AfterSaleReviewError,
  normalizeReviewActor,
  normalizeReviewInput
} = require("../afterSaleReviewService");

function actor(overrides = {}) {
  return {
    id: "admin-1",
    openid: "openid-1",
    role: "customer_service",
    status: "active",
    isActive: true,
    permissions: ["after_sale:review"],
    ...overrides
  };
}

test("strict after-sale approval accepts bounded refund and return fields", () => {
  const input = normalizeReviewInput({
    id: "as-1",
    decision: "approve",
    expectedStatus: "pending_review",
    expectedVersion: 3,
    expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
    approvedRefundAmount: 12800,
    returnRequired: true,
    reason: "符合售后规则"
  }, { strict: true });

  assert.deepEqual(input, {
    id: "as-1",
    decision: "approve",
    expectedStatus: "pending_review",
    expectedVersion: 3,
    expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
    approvedRefundAmount: 12800,
    returnRequired: true,
    reason: "符合售后规则"
  });
});

test("strict after-sale rejection requires a non-empty reason", () => {
  assert.throws(
    () => normalizeReviewInput({
      id: "as-1",
      decision: "reject",
      expectedStatus: "pending_review",
      expectedVersion: 1,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      reason: "   "
    }, { strict: true }),
    (error) => error instanceof AfterSaleReviewError && error.code === "REASON_REQUIRED"
  );
});

test("after-sale review rejects finance actors even with an injected permission", () => {
  assert.throws(
    () => normalizeReviewActor(actor({
      role: "finance",
      permissions: ["after_sale:review"]
    }), "approve"),
    (error) => error instanceof AfterSaleReviewError && error.code === "FORBIDDEN"
  );
});

test("after-sale review rejects unknown strict fields", () => {
  assert.throws(
    () => normalizeReviewInput({
      id: "as-1",
      decision: "approve",
      expectedStatus: "pending_review",
      expectedVersion: 1,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      orderId: "forged-order"
    }, { strict: true }),
    (error) => error instanceof AfterSaleReviewError && error.code === "UNKNOWN_FIELD"
  );
});
