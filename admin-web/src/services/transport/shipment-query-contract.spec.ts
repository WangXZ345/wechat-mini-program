import { describe, expect, it } from "vitest";
import { parseShipmentDetail, parseShipmentListPage } from "./shipment-query-contract";

function summary() {
  return {
    id: "shipment-1",
    shipmentNo: "SHP-20260713-001",
    status: "pending_shipment",
    orderCount: 2,
    totalItemCount: 5,
    customerMasked: "张* 138****8000",
    carrier: "顺丰速运",
    trackingMasked: "SF*******789",
    addressConsistent: true,
    orderNosPreview: ["ORD-001", "ORD-002"],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z",
    shippedAt: null,
    completedAt: null,
    version: 0
  };
}

function detail() {
  return {
    shipment: {
      id: "shipment-1",
      shipmentNo: "SHP-20260713-001",
      status: "pending_shipment",
      version: 0,
      orderCount: 1,
      totalItemCount: 2,
      totalProductCount: 1,
      customerMasked: "张* 138****8000",
      shippingAddressMasked: {
        receiverName: "张*",
        receiverPhoneMasked: "138****8000",
        regionText: "上海市 浦东新区",
        detailAddressMasked: "演示路 ** 号",
        fullAddressMasked: "上海市 浦东新区 演示路 ** 号"
      },
      carrier: "顺丰速运",
      trackingMasked: "SF*******789",
      addressConsistent: true,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T01:00:00.000Z",
      shippedAt: null,
      completedAt: null,
      cancelledAt: null
    },
    orders: [{
      id: "order-1",
      orderNo: "ORD-001",
      status: "paid",
      paymentStatus: "paid",
      shippingStatus: "pending_shipment",
      createdAt: "2026-07-13T00:00:00.000Z"
    }],
    itemSummary: [{
      productId: "product-1",
      productName: "修护精华",
      brand: "演示品牌",
      category: "护肤",
      specification: "30ml",
      productionDate: "2026-01-01",
      totalQuantity: 2,
      orderNos: ["ORD-001"]
    }],
    logs: [{
      id: "log-1",
      action: "create",
      operatorRole: "customer_service",
      createdAt: "2026-07-13T01:00:00.000Z"
    }],
    logsHasMore: false,
    relatedDataStatus: "complete",
    warnings: []
  };
}

describe("shipment query contract", () => {
  it("accepts the six authoritative states and optional finance amount", () => {
    for (const status of ["created", "pending_shipment", "shipped", "completed", "cancelled", "abnormal"] as const) {
      const value = summary();
      value.status = status;
      expect(parseShipmentListPage({
        items: [{ ...value, totalOrderAmountCents: 12_345 }],
        pageSize: 20,
        hasMore: false,
        nextCursor: null
      }).items[0]?.status).toBe(status);
    }
  });

  it.each([
    ["trackingNo", "SF123456789"],
    ["orderIds", ["order-1"]],
    ["shippingAddressSnapshot", { detailAddress: "secret" }],
    ["openid", "secret-openid"]
  ])("rejects forbidden or unknown list field %s", (key, value) => {
    expect(() => parseShipmentListPage({
      items: [{ ...summary(), [key]: value }],
      pageSize: 20,
      hasMore: false,
      nextCursor: null
    })).toThrowError(expect.objectContaining({ code: "INVALID_SHIPMENT_CONTRACT", status: 502 }));
  });

  it.each([
    ["unsafe integer", { orderCount: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative amount", { totalOrderAmountCents: -1 }],
    ["invalid date", { updatedAt: "13/07/2026" }],
    ["unknown status", { status: "approved" }]
  ])("rejects %s in a list summary", (_label, patch) => {
    expect(() => parseShipmentListPage({
      items: [{ ...summary(), ...patch }],
      pageSize: 20,
      hasMore: false,
      nextCursor: null
    })).toThrowError(expect.objectContaining({ code: "INVALID_SHIPMENT_CONTRACT" }));
  });

  it("requires a cursor when a list says that more rows exist", () => {
    expect(() => parseShipmentListPage({
      items: [summary()],
      pageSize: 20,
      hasMore: true,
      nextCursor: null
    })).toThrowError(expect.objectContaining({ code: "INVALID_SHIPMENT_CONTRACT" }));
  });

  it("accepts masked and privileged optional detail fields", () => {
    const masked = parseShipmentDetail(detail());
    expect(masked.shipment.shippingAddressMasked?.receiverPhoneMasked).toBe("138****8000");

    const privileged = detail();
    Reflect.deleteProperty(privileged.shipment, "shippingAddressMasked");
    Reflect.deleteProperty(privileged.shipment, "trackingMasked");
    Object.assign(privileged.shipment, {
      shippingAddress: {
        receiverName: "张三",
        receiverPhoneMasked: "138****8000",
        regionText: "上海市 浦东新区",
        detailAddress: "演示路 88 号",
        fullAddress: "上海市 浦东新区 演示路 88 号"
      },
      trackingNo: "SF123456789",
      adminRemark: "优先处理",
      cancelReason: "客户取消",
      totalOrderAmountCents: 12_345,
      totalPaidAmountCents: 10_000,
      totalUnpaidAmountCents: 2_345
    });
    Object.assign(privileged.orders[0]!, { totalAmountCents: 12_345 });
    Object.assign(privileged.logs[0]!, { remark: "已核对" });
    expect(parseShipmentDetail(privileged).shipment.trackingNo).toBe("SF123456789");
  });

  it("accepts an explicit empty tracking projection before a waybill is assigned", () => {
    const value = detail();
    value.shipment.trackingMasked = "";
    expect(parseShipmentDetail(value).shipment.trackingMasked).toBe("");
  });

  it.each([
    ["openid", (value: ReturnType<typeof detail>) => Object.assign(value.shipment, { openid: "secret" })],
    ["operatorOpenid", (value: ReturnType<typeof detail>) => Object.assign(value.logs[0]!, { operatorOpenid: "secret" })],
    ["beforeData", (value: ReturnType<typeof detail>) => Object.assign(value.logs[0]!, { beforeData: { status: "old" } })],
    ["afterData", (value: ReturnType<typeof detail>) => Object.assign(value.logs[0]!, { afterData: { status: "new" } })],
    ["unitPrice", (value: ReturnType<typeof detail>) => Object.assign(value.itemSummary[0]!, { unitPrice: 6_000 })],
    ["subtotal", (value: ReturnType<typeof detail>) => Object.assign(value.itemSummary[0]!, { subtotal: 12_000 })],
    ["tags", (value: ReturnType<typeof detail>) => Object.assign(value.itemSummary[0]!, { tags: ["internal"] })],
    ["unknown", (value: ReturnType<typeof detail>) => Object.assign(value, { unexpected: true })]
  ])("rejects forbidden or unknown detail field %s", (_key, mutate) => {
    const value = detail();
    mutate(value);
    expect(() => parseShipmentDetail(value)).toThrowError(expect.objectContaining({ code: "INVALID_SHIPMENT_CONTRACT", status: 502 }));
  });

  it("rejects invalid detail dates, counts, amounts, and unconstrained warnings", () => {
    const badDate = detail();
    badDate.logs[0]!.createdAt = "yesterday";
    expect(() => parseShipmentDetail(badDate)).toThrowError(expect.objectContaining({ code: "INVALID_SHIPMENT_CONTRACT" }));

    const badCount = detail();
    badCount.itemSummary[0]!.totalQuantity = -1;
    expect(() => parseShipmentDetail(badCount)).toThrowError(expect.objectContaining({ code: "INVALID_SHIPMENT_CONTRACT" }));

    const badAmount = detail();
    Object.assign(badAmount.shipment, { totalPaidAmountCents: 1.5 });
    expect(() => parseShipmentDetail(badAmount)).toThrowError(expect.objectContaining({ code: "INVALID_SHIPMENT_CONTRACT" }));

    const badWarning = detail();
    Object.assign(badWarning, {
      relatedDataStatus: "partial",
      warnings: ["missing order id=secret-order"]
    });
    expect(() => parseShipmentDetail(badWarning)).toThrowError(expect.objectContaining({ code: "INVALID_SHIPMENT_CONTRACT" }));
  });
});
