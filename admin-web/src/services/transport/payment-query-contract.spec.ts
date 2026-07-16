import { describe, expect, it } from "vitest";
import { parsePaymentDetail, parsePaymentListPage } from "./payment-query-contract";

const row = {
  id: "pay-001",
  version: 2,
  orderNo: "ORDER-001",
  customerMasked: "张* / 138****1201",
  amountCents: 32000,
  proofLabel: "已提交凭证" as const,
  proofCount: 1,
  status: "pending_confirm" as const,
  submittedAt: "2026-07-13T08:00:00.000Z",
  updatedAt: "2026-07-13T08:05:00.000Z"
};

describe("payment query contract", () => {
  it("accepts the strict list page", () => {
    expect(parsePaymentListPage({ items: [row], pageSize: 20, hasMore: false, nextCursor: null })).toEqual({ items: [row], pageSize: 20, hasMore: false, nextCursor: null });
  });

  it("rejects sensitive proof URLs and unsafe status values", () => {
    expect(() => parsePaymentDetail({ ...row, paymentScreenshotUrl: "cloud://secret" })).toThrow("付款记录详情响应");
    expect(() => parsePaymentDetail({ ...row, status: "processing" })).toThrow("付款记录详情响应");
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined])("rejects an invalid payment version %s", (version) => {
    expect(() => parsePaymentDetail({ ...row, version })).toThrow("付款记录详情响应");
  });

  it("requires a cursor only when more rows exist", () => {
    expect(() => parsePaymentListPage({ items: [], pageSize: 20, hasMore: true, nextCursor: null })).toThrow("付款记录列表响应");
    expect(() => parsePaymentListPage({ items: [], pageSize: 20, hasMore: false, nextCursor: "next" })).toThrow("付款记录列表响应");
  });
});
