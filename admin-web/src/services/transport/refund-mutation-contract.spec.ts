import { describe, expect, it } from "vitest";
import {
  buildRefundProcessPayload,
  buildRefundRejectPayload,
  isCurrentRefundMutationSnapshot,
  normalizeRefundMutationInput,
  parseRefundMutationResult
} from "./refund-mutation-contract";

const row = {
  id: "ref-001",
  amountCents: 9_900,
  status: "pending",
  version: 3,
  updatedAt: "2026-07-17T08:00:00.000Z"
};
const proofFileIds = (count: number) => Array.from(
  { length: count },
  (_, index) => `cloud://env.refund-proof-${index + 1}`
);

function expectContractError(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected contract error");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("refund mutation contract", () => {
  it("builds the process request from an immutable refund snapshot", () => {
    expect(buildRefundProcessPayload(row, { remark: "  reconciled  " })).toEqual({
      refundRecordId: row.id,
      refundAmountCents: row.amountCents,
      expectedRefundStatus: row.status,
      expectedRefundVersion: row.version,
      expectedRefundUpdatedAt: row.updatedAt,
      financeRemark: "reconciled",
      refundProofFileIds: []
    });
  });

  it("builds a reject request only with a non-empty reason and current snapshot", () => {
    expect(buildRefundRejectPayload(row, { reason: "  account mismatch  " })).toEqual({
      refundRecordId: row.id,
      expectedRefundStatus: row.status,
      expectedRefundVersion: row.version,
      expectedRefundUpdatedAt: row.updatedAt,
      rejectReason: "account mismatch"
    });
    expectContractError(() => buildRefundRejectPayload(row, { reason: " " }), "INVALID_REFUND_MUTATION");
  });

  it.each(["pending", "processing", "failed"])("accepts the processable %s snapshot", (status) => {
    expect(isCurrentRefundMutationSnapshot({ ...row, status })).toBe(true);
  });

  it.each(["refunded", "partial_refunded", "rejected", "cancelled"])("rejects the terminal %s snapshot", (status) => {
    expect(isCurrentRefundMutationSnapshot({ ...row, status })).toBe(false);
  });

  it("rejects missing snapshots, non-integer cents, unknown states, and unknown form fields", () => {
    expectContractError(
      () => buildRefundProcessPayload({ ...row, version: undefined }, { remark: "" }),
      "INVALID_REFUND_MUTATION"
    );
    expectContractError(
      () => buildRefundProcessPayload({ ...row, updatedAt: undefined }, { remark: "" }),
      "INVALID_REFUND_MUTATION"
    );
    expectContractError(
      () => buildRefundProcessPayload({ ...row, amountCents: 99.5 }, { remark: "" }),
      "INVALID_REFUND_MUTATION"
    );
    expectContractError(
      () => buildRefundProcessPayload({ ...row, status: "pending_refund" }, { remark: "" }),
      "INVALID_REFUND_MUTATION"
    );
    expectContractError(
      () => buildRefundProcessPayload(row, { remark: "", orderId: "unsafe" } as never),
      "INVALID_REFUND_MUTATION"
    );
    expectContractError(
      () => normalizeRefundMutationInput("process", {
        refundRecordId: row.id,
        refundAmountCents: row.amountCents,
        expectedRefundStatus: row.status,
        expectedRefundVersion: row.version,
        expectedRefundUpdatedAt: row.updatedAt,
        financeRemark: "",
        refundProofFileIds: ["https://example.com/private-proof"]
      }),
      "INVALID_REFUND_MUTATION"
    );
  });

  it("accepts exactly six unique CloudBase proofs and rejects seven", () => {
    const input = {
      refundRecordId: row.id,
      refundAmountCents: row.amountCents,
      expectedRefundStatus: row.status,
      expectedRefundVersion: row.version,
      expectedRefundUpdatedAt: row.updatedAt,
      financeRemark: "",
      refundProofFileIds: proofFileIds(6)
    };
    expect(normalizeRefundMutationInput("process", input)).toEqual(input);
    expectContractError(
      () => normalizeRefundMutationInput("process", {
        ...input,
        refundProofFileIds: proofFileIds(7)
      }),
      "INVALID_REFUND_MUTATION"
    );
  });

  it("accepts only processable canonical snapshots and safe mutation results", () => {
    expect(isCurrentRefundMutationSnapshot(row)).toBe(true);
    expect(isCurrentRefundMutationSnapshot({ ...row, status: "partial_refunded" })).toBe(false);
    expect(isCurrentRefundMutationSnapshot({ ...row, updatedAt: undefined })).toBe(false);
    expect(parseRefundMutationResult({
      item: { id: row.id, refundNo: "R-001", status: "refunded", version: 4, updatedAt: "2026-07-17T08:01:00.000Z", amountCents: 9_900 },
      affected: 1,
      reused: false,
      action: "process",
      accountRecalculationPending: true,
      message: "refund confirmed",
      requestId: "request-1"
    })).toMatchObject({ action: "process", item: { status: "refunded" } });
    expectContractError(() => parseRefundMutationResult({
      item: { id: row.id, refundNo: "R-001", status: "refunded", version: 4, updatedAt: "2026-07-17T08:01:00.000Z", amountCents: 9_900, orderId: "secret" },
      affected: 1,
      reused: false,
      action: "process",
      accountRecalculationPending: true,
      message: "refund confirmed",
      requestId: "request-1"
    }), "INVALID_REFUND_MUTATION_CONTRACT");
  });

  it("strictly parses reject results and rejects action/status or replay mismatches", () => {
    const result = {
      item: {
        id: row.id,
        refundNo: "R-001",
        status: "rejected",
        version: 4,
        updatedAt: "2026-07-17T08:01:00.000Z",
        amountCents: 9_900
      },
      affected: 1,
      reused: false,
      action: "reject",
      accountRecalculationPending: false,
      message: "refund rejected",
      requestId: "request-2"
    };
    expect(parseRefundMutationResult(result)).toEqual(result);
    expectContractError(() => parseRefundMutationResult({
      ...result,
      item: { ...result.item, status: "refunded" }
    }), "INVALID_REFUND_MUTATION_CONTRACT");
    expectContractError(
      () => parseRefundMutationResult({ ...result, affected: 0, reused: false }),
      "INVALID_REFUND_MUTATION_CONTRACT"
    );
  });

  it("fails closed when a process result reports the list-only partial_refunded status", () => {
    expectContractError(() => parseRefundMutationResult({
      item: {
        id: row.id,
        refundNo: "R-001",
        status: "partial_refunded",
        version: 4,
        updatedAt: "2026-07-17T08:01:00.000Z",
        amountCents: row.amountCents
      },
      affected: 1,
      reused: false,
      action: "process",
      accountRecalculationPending: true,
      message: "refund confirmed",
      requestId: "request-partial"
    }), "INVALID_REFUND_MUTATION_CONTRACT");
  });
});
