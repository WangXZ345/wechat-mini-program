import { describe, expect, it } from "vitest";
import {
  ACCOUNT_QUERY_STATUSES,
  parseAccountDetail,
  parseAccountListPage
} from "./account-query-contract";

function summary(id = "account-1") {
  return {
    id,
    customerMasked: "演示客户 / 138****8000",
    totalOrders: 8,
    receivableCents: 268_000,
    receivedCents: 239_300,
    unpaidAmountCents: 28_700,
    pendingConfirmAmountCents: 8_700,
    abnormalCount: 0,
    status: "unpaid" as const,
    lastOrderAt: "2026-07-13T08:00:00.000Z",
    lastPaymentAt: null,
    updatedAt: "2026-07-13T08:05:00.000Z"
  };
}

function detail() {
  return {
    account: summary(),
    orders: [{
      id: "order-1",
      orderNo: "DEMO-O-001",
      status: "pending_shipment",
      paymentStatus: "pending_confirm",
      totalAmountCents: 28_700,
      createdAt: "2026-07-13T07:00:00.000Z"
    }],
    logs: [{
      id: "log-1",
      changeType: "order_created",
      beforeReceivableCents: 239_300,
      afterReceivableCents: 268_000,
      beforeReceivedCents: 239_300,
      afterReceivedCents: 239_300,
      beforeUnpaidCents: 0,
      afterUnpaidCents: 28_700,
      changeAmountCents: 28_700,
      orderNo: "DEMO-O-001",
      createdAt: "2026-07-13T07:00:00.000Z",
      summary: "订单创建，账款增加"
    }],
    ordersHasMore: false,
    logsHasMore: false,
    relatedDataStatus: "complete" as const,
    warnings: []
  };
}

describe("account query contract", () => {
  it("accepts only the four authoritative account query states", () => {
    expect(ACCOUNT_QUERY_STATUSES).toEqual(["unpaid", "pending_confirm", "abnormal", "settled"]);
    for (const status of ACCOUNT_QUERY_STATUSES) {
      expect(parseAccountListPage({
        items: [{ ...summary(), status }],
        pageSize: 20,
        hasMore: false,
        nextCursor: null
      }).items[0]?.status).toBe(status);
    }

    expect(() => parseAccountListPage({
      items: [{ ...summary(), status: "overdue" }],
      pageSize: 20,
      hasMore: false,
      nextCursor: null
    })).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT", status: 502 }));
  });

  it("requires exact list keys, safe integer cents, valid dates, and a coherent cursor", () => {
    expect(parseAccountListPage({
      items: [summary()],
      pageSize: 20,
      hasMore: true,
      nextCursor: "opaque-cursor"
    }).nextCursor).toBe("opaque-cursor");

    for (const patch of [
      { receivableCents: 1.5 },
      { receivedCents: -1 },
      { unpaidAmountCents: Number.MAX_SAFE_INTEGER + 1 },
      { totalOrders: -1 },
      { updatedAt: "today" }
    ]) {
      expect(() => parseAccountListPage({
        items: [{ ...summary(), ...patch }],
        pageSize: 20,
        hasMore: false,
        nextCursor: null
      })).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT", status: 502 }));
    }

    expect(() => parseAccountListPage({
      items: [summary()],
      pageSize: 20,
      hasMore: true,
      nextCursor: null
    })).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT" }));
    expect(() => parseAccountListPage({
      items: [summary()],
      pageSize: 20,
      hasMore: false,
      nextCursor: null,
      total: 1
    })).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT" }));
  });

  it.each([
    ["openid", { openid: "secret-openid" }],
    ["userId", { userId: "secret-user" }],
    ["phone", { phone: "13800138000" }],
    ["address", { shippingAddress: "演示路 88 号" }],
    ["payment proof", { paymentScreenshotUrl: "cloud://secret-proof" }],
    ["transaction", { transactionId: "bank-secret" }],
    ["internal note", { adminRemark: "内部备注" }],
    ["risk", { riskLevel: "risk" }],
    ["operator", { operatorId: "admin-1" }]
  ])("rejects forbidden account list field %s", (_label, forbidden) => {
    expect(() => parseAccountListPage({
      items: [{ ...summary(), ...forbidden }],
      pageSize: 20,
      hasMore: false,
      nextCursor: null
    })).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT", status: 502 }));
  });

  it("rejects a complete phone hidden in masked customer or log summary text", () => {
    expect(() => parseAccountListPage({
      items: [{ ...summary(), customerMasked: "演示客户 13800138000" }],
      pageSize: 20,
      hasMore: false,
      nextCursor: null
    })).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT" }));

    const value = detail();
    value.logs[0]!.summary = "联系 13800138000 核对";
    expect(() => parseAccountDetail(value)).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT" }));

    const spaced = detail();
    spaced.logs[0]!.summary = "联系 138 0013 8000 核对";
    expect(() => parseAccountDetail(spaced)).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT" }));
  });

  it("parses the exact read-only account detail and bounded relation contract", () => {
    const parsed = parseAccountDetail(detail());
    expect(parsed.account.id).toBe("account-1");
    expect(parsed.orders[0]?.totalAmountCents).toBe(28_700);
    expect(parsed.logs[0]?.afterUnpaidCents).toBe(28_700);
    expect(parsed.relatedDataStatus).toBe("complete");
  });

  it.each([
    ["openid", (value: ReturnType<typeof detail>) => Object.assign(value.orders[0]!, { openid: "secret" })],
    ["complete phone", (value: ReturnType<typeof detail>) => Object.assign(value.orders[0]!, { customerPhone: "13800138000" })],
    ["address", (value: ReturnType<typeof detail>) => Object.assign(value.account, { address: "演示路 88 号" })],
    ["proof url", (value: ReturnType<typeof detail>) => Object.assign(value.logs[0]!, { screenshotUrls: ["cloud://secret"] })],
    ["transaction", (value: ReturnType<typeof detail>) => Object.assign(value.logs[0]!, { transactionNo: "TX-SECRET" })],
    ["beforeData", (value: ReturnType<typeof detail>) => Object.assign(value.logs[0]!, { beforeData: { amount: 1 } })],
    ["operator", (value: ReturnType<typeof detail>) => Object.assign(value.logs[0]!, { operatorOpenid: "secret" })],
    ["unknown root", (value: ReturnType<typeof detail>) => Object.assign(value, { unexpected: true })]
  ])("rejects forbidden or unknown detail field %s", (_label, mutate) => {
    const value = detail();
    mutate(value);
    expect(() => parseAccountDetail(value)).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT", status: 502 }));
  });

  it("rejects invalid detail cents, dates, relation caps, and unconstrained warnings", () => {
    const badAmount = detail();
    badAmount.logs[0]!.changeAmountCents = 1.5;
    expect(() => parseAccountDetail(badAmount)).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT" }));

    const badDate = detail();
    badDate.orders[0]!.createdAt = "yesterday";
    expect(() => parseAccountDetail(badDate)).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT" }));

    const tooManyOrders = detail();
    tooManyOrders.orders = Array.from({ length: 51 }, (_, index) => ({
      ...tooManyOrders.orders[0]!, id: `order-${index}`
    }));
    expect(() => parseAccountDetail(tooManyOrders)).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT" }));

    const badWarning = detail();
    Object.assign(badWarning, { relatedDataStatus: "partial", warnings: ["raw collection account_logs missing"] });
    expect(() => parseAccountDetail(badWarning)).toThrowError(expect.objectContaining({ code: "INVALID_ACCOUNT_CONTRACT" }));
  });
});
