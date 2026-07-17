import { describe, expect, it } from "vitest";
import {
  isCurrentReturnInspectionSnapshot,
  normalizeReturnInspectionInput,
  parseReturnInspectionResult,
  toReturnInspectionRequest
} from "./return-inspection-contract";

const updatedAt = "2026-07-16T08:00:00.000Z";

describe("return inspection contract", () => {
  it("builds a strict receive request from the row snapshot", () => {
    const input = normalizeReturnInspectionInput("receive", {
      id: "as-1",
      expectedStatus: "waiting_return",
      expectedVersion: 4,
      expectedUpdatedAt: updatedAt,
      remark: "物流已核对"
    });
    expect(toReturnInspectionRequest(input)).toEqual({
      afterSaleId: "as-1",
      expectedStatus: "waiting_return",
      expectedVersion: 4,
      expectedUpdatedAt: updatedAt,
      remark: "物流已核对"
    });
  });

  it("rejects non-sellable or ambiguous restock payloads", () => {
    expect(() => normalizeReturnInspectionInput("inspect", {
      id: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt: updatedAt,
      itemCondition: "damaged",
      canRestock: true,
      restockQuantity: 1,
      inspectionRemark: ""
    })).toThrow();
    expect(() => normalizeReturnInspectionInput("inspect", {
      id: "as-1",
      expectedStatus: "received",
      expectedVersion: 4,
      expectedUpdatedAt: updatedAt,
      itemCondition: "sellable",
      canRestock: false,
      restockQuantity: 1,
      inspectionRemark: ""
    })).toThrow();
  });

  it("only treats receive and inspect rows in their current workflow states as actionable", () => {
    const row = { id: "as-1", status: "waiting_return", version: 4, updatedAt };
    expect(isCurrentReturnInspectionSnapshot("receive", row)).toBe(true);
    expect(isCurrentReturnInspectionSnapshot("inspect", row)).toBe(false);
    expect(isCurrentReturnInspectionSnapshot("receive", { ...row, status: "refund_pending" })).toBe(false);
  });

  it("rejects sensitive fields in the result contract", () => {
    expect(() => parseReturnInspectionResult({
      item: { id: "as-1", status: "received", version: 5, updatedAt },
      afterSaleId: "as-1",
      afterSaleStatus: "received",
      restoredQuantity: 0,
      affected: 1,
      reused: false,
      message: "ok",
      requestId: "req-1",
      orderId: "secret-order"
    })).toThrow();
  });
});
