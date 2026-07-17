import { describe, expect, it } from "vitest";
import { ApiError } from "@/services/http/api-error";
import {
  afterSaleReviewInputFromRow,
  isCurrentAfterSaleReviewSnapshot,
  normalizeAfterSaleReviewInput,
  parseAfterSaleReviewResult,
  toAfterSaleReviewRequest
} from "./after-sale-review-contract";

const updatedAt = "2026-07-16T08:00:00.000Z";

describe("after-sale review contract", () => {
  it("normalizes an approve snapshot and emits only the BFF request fields", () => {
    const input = afterSaleReviewInputFromRow("approve", {
      id: "as-001",
      status: "pending_review",
      version: 3,
      updatedAt
    }, { approvedRefundAmount: 12800, returnRequired: true, reason: "符合规则" });

    expect(toAfterSaleReviewRequest(input)).toEqual({
      afterSaleId: "as-001",
      expectedStatus: "pending_review",
      expectedVersion: 3,
      expectedUpdatedAt: updatedAt,
      approvedRefundAmount: 12800,
      returnRequired: true,
      reason: "符合规则"
    });
    expect(isCurrentAfterSaleReviewSnapshot({ id: "as-001", status: "pending_review", version: 3, updatedAt })).toBe(true);
  });

  it("requires a reason for reject and rejects unknown fields", () => {
    expect(() => normalizeAfterSaleReviewInput("reject", {
      id: "as-001",
      expectedStatus: "pending_review",
      expectedVersion: 3,
      expectedUpdatedAt: updatedAt,
      reason: ""
    })).toThrowError(ApiError);

    expect(() => normalizeAfterSaleReviewInput("approve", {
      id: "as-001",
      expectedStatus: "pending_review",
      expectedVersion: 3,
      expectedUpdatedAt: updatedAt,
      forgedOrderId: "order-1"
    })).toThrowError(ApiError);
  });

  it("parses a safe result and rejects private fields or mismatched status", () => {
    const result = parseAfterSaleReviewResult({
      item: { id: "as-001", caseNo: "AS-001", status: "waiting_return", version: 4, updatedAt },
      afterSaleId: "as-001",
      afterSaleStatus: "waiting_return",
      refundStatus: "pending",
      approvedRefundAmount: 12800,
      affected: 1,
      reused: false,
      decision: "approve",
      message: "售后申请已审核通过",
      requestId: "request-1"
    });
    expect(result.item.status).toBe("waiting_return");
    expect(() => parseAfterSaleReviewResult({
      item: { id: "as-001", caseNo: "AS-001", status: "waiting_return", version: 4, updatedAt },
      afterSaleId: "as-001",
      afterSaleStatus: "waiting_return",
      refundStatus: "pending",
      approvedRefundAmount: 12800,
      affected: 1,
      reused: false,
      decision: "approve",
      message: "ok",
      requestId: "request-1",
      orderId: "private-order"
    })).toThrowError(ApiError);
  });
});
