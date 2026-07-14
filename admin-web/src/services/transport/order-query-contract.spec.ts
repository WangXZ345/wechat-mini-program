import { describe, expect, it } from "vitest";
import { parseOrderDetail, parseOrderList } from "./order-query-contract";

const summary = {
  id: "order-1", orderNo: "PO-1", customerMasked: "张* / 138****8000", customerPhoneMasked: "138****8000",
  itemSummary: "精华等 2 件商品", itemCount: 2, totalQuantity: 3, status: "pending_admin",
  paymentStatus: "unpaid", deliveryStatus: "", createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z", version: 0
};

describe("order query contract", () => {
  it("parses a strict list and role-shaped detail", () => {
    expect(parseOrderList({ items: [summary], total: 1, page: 1, pageSize: 20, nextCursor: null }).items[0]!.id).toBe("order-1");
    const detail = parseOrderDetail({
      ...summary,
      items: [{ id: "item-1", productId: "product-1", productName: "精华", specification: "30ml", productionDate: "2026-06", quantity: 2 }],
      customer: { nameMasked: "张*", phoneMasked: "138****8000" },
      shippingAddressMasked: { receiverName: "张*", receiverPhoneMasked: "138****8000", regionText: "上海市", detailAddressMasked: "浦东新区**" },
      riskLevelSnapshot: "risk",
      adminRemark: "请人工核对"
    });
    expect(detail.items[0]!.quantity).toBe(2);
    expect(detail.shippingAddressMasked?.regionText).toBe("上海市");
  });

  it.each([
    { ...summary, openid: "secret" },
    { ...summary, totalAmountCents: -1 },
    { ...summary, createdAt: "not-a-date" },
    { ...summary, itemCount: 1.5 }
  ])("rejects malformed or overexposed summaries", (row) => {
    expect(() => parseOrderList({ items: [row], total: 1, page: 1, pageSize: 20, nextCursor: null })).toThrowError(expect.objectContaining({ code: "INVALID_ORDER_CONTRACT" }));
  });

  it("rejects sensitive or unknown nested detail fields", () => {
    expect(() => parseOrderDetail({
      ...summary,
      items: [{ id: "item-1", productId: "product-1", productName: "精华", specification: "", productionDate: "", quantity: 1, currentStock: 99 }],
      customer: { nameMasked: "张*", phoneMasked: "138****8000", openid: "secret" }
    })).toThrowError(expect.objectContaining({ code: "INVALID_ORDER_CONTRACT" }));
  });
});
