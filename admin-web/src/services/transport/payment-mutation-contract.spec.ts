import { describe, expect, it } from "vitest";
import {
  normalizePaymentMutationInput,
  parsePaymentMutationResult,
  toPaymentMutationRequest
} from "./payment-mutation-contract";

const input = {
  id: "pay-001",
  expectedStatus: "pending_confirm" as const,
  expectedVersion: 2,
  expectedUpdatedAt: "2026-07-13T08:05:00.000Z",
  reason: "  已核对到账  "
};

const result = {
  item: {
    id: "pay-001",
    orderNo: "ORDER-001",
    status: "paid" as const,
    version: 3,
    updatedAt: "2026-07-13T08:06:00.000Z"
  },
  affected: 1,
  reused: false,
  decision: "confirm" as const,
  accountRecalculationPending: false,
  message: "付款已确认",
  requestId: "request-1"
};

describe("payment mutation contract", () => {
  it("normalizes the exact UI input and maps id to the exact BFF body", () => {
    const normalized = normalizePaymentMutationInput("confirm", {
      ...input,
      id: "  pay-001  ",
      reason: ` ${"x".repeat(300)} `
    });
    expect(normalized).toEqual({
      ...input,
      id: "pay-001",
      reason: "x".repeat(300)
    });
    expect(toPaymentMutationRequest(normalized)).toEqual({
      paymentId: "pay-001",
      expectedStatus: "pending_confirm",
      expectedVersion: 2,
      expectedUpdatedAt: "2026-07-13T08:05:00.000Z",
      reason: "x".repeat(300)
    });
  });

  it.each([
    ["amountCents", 32000],
    ["orderId", "order-1"],
    ["actor", { role: "finance" }],
    ["openid", "secret"],
    ["paymentScreenshotUrl", "cloud://secret"],
    ["transactionNo", "secret"],
    ["idempotencyKey", "body-key"],
    ["unknown", true]
  ])("rejects forbidden request field %s", (key, value) => {
    expect(() => normalizePaymentMutationInput("confirm", { ...input, [key]: value })).toThrow("付款审核请求");
  });

  it("requires a trimmed reject reason but permits an empty confirm reason", () => {
    expect(() => normalizePaymentMutationInput("reject", { ...input, reason: "   " })).toThrow("驳回原因");
    expect(() => normalizePaymentMutationInput("reject", { ...input, reason: "x".repeat(301) })).toThrow("付款审核请求");
    expect(normalizePaymentMutationInput("confirm", { ...input, reason: "   " }).reason).toBe("");
  });

  it.each([
    ["empty trimmed id", { id: "   " }],
    ["overlong trimmed id", { id: ` ${"x".repeat(129)} ` }],
    ["overlong trimmed reason", { reason: ` ${"x".repeat(301)} ` }]
  ])("rejects %s", (_label, patch) => {
    expect(() => normalizePaymentMutationInput("confirm", { ...input, ...patch })).toThrow("付款审核请求");
  });

  it.each([
    { expectedStatus: "paid" },
    { expectedVersion: -1 },
    { expectedVersion: 1.5 },
    { expectedUpdatedAt: null },
    { expectedUpdatedAt: "not-a-date" },
    { id: "" }
  ])("rejects an invalid snapshot %#", (patch) => {
    expect(() => normalizePaymentMutationInput("confirm", { ...input, ...patch })).toThrow("付款审核请求");
  });

  it("rejects non-canonical offset timestamps in both requests and results", () => {
    expect(() => normalizePaymentMutationInput("confirm", {
      ...input,
      expectedUpdatedAt: "2026-07-13T16:05:00.000+08:00"
    })).toThrow("付款审核请求");
    expect(() => parsePaymentMutationResult({
      ...result,
      item: { ...result.item, updatedAt: "2026-07-13T16:06:00.000+08:00" }
    })).toThrow("付款审核响应");
  });

  it("parses the exact safe result and enforces decision/status/replay combinations", () => {
    expect(parsePaymentMutationResult(result)).toEqual(result);
    expect(() => parsePaymentMutationResult({ ...result, item: { ...result.item, status: "rejected" } })).toThrow("付款审核响应");
    expect(() => parsePaymentMutationResult({ ...result, reused: true })).toThrow("付款审核响应");
    expect(parsePaymentMutationResult({ ...result, affected: 0, reused: true })).toMatchObject({ affected: 0, reused: true });
  });

  it.each([
    ["orderId", "order-1"],
    ["userId", "user-1"],
    ["openid", "secret"],
    ["amountCents", 32000],
    ["proofUrl", "cloud://secret"],
    ["warning", "internal detail"],
    ["unknown", true]
  ])("rejects overexposed result field %s", (key, value) => {
    expect(() => parsePaymentMutationResult({ ...result, [key]: value })).toThrow("付款审核响应");
  });
});
