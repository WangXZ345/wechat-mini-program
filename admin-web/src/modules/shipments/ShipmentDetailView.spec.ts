import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { ElButton } from "element-plus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/services/http/api-error";
import type { ShipmentDetail } from "@/services/transport/shipment-query-contract";
import ShipmentDetailView from "./ShipmentDetailView.vue";

const transportMock = vi.hoisted(() => ({ getShipmentDetail: vi.fn(), mutate: vi.fn(), get: vi.fn() }));
const routerMock = vi.hoisted(() => ({ back: vi.fn() }));

vi.mock("@/services/transport", () => ({ transport: transportMock }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "shipment-1" } }),
  useRouter: () => routerMock
}));

const detail: ShipmentDetail = {
  shipment: {
    id: "shipment-1",
    shipmentNo: "S-20260713-001",
    status: "pending_shipment",
    version: 4,
    orderCount: 2,
    totalItemCount: 3,
    totalProductCount: 8,
    customerMasked: "王**",
    shippingAddressMasked: {
      receiverName: "王**",
      receiverPhoneMasked: "138****1201",
      regionText: "上海市 浦东新区",
      detailAddressMasked: "张江路 *** 号",
      fullAddressMasked: "上海市 浦东新区 张江路 *** 号"
    },
    carrier: "顺丰速运",
    trackingMasked: "SF********01",
    addressConsistent: true,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-13T09:00:00.000Z",
    shippedAt: null,
    completedAt: null,
    cancelledAt: null,
    totalOrderAmountCents: 28700,
    totalPaidAmountCents: 8900,
    totalUnpaidAmountCents: 19800
  },
  orders: [
    {
      id: "order-1",
      orderNo: "O-001",
      status: "approved_pending_payment",
      paymentStatus: "partial_paid",
      shippingStatus: "pending_shipment",
      createdAt: "2026-07-13T07:00:00.000Z",
      totalAmountCents: 17800
    },
    {
      id: "order-2",
      orderNo: "O-002",
      status: "paid",
      paymentStatus: "paid",
      shippingStatus: "pending_shipment",
      createdAt: "2026-07-13T07:30:00.000Z",
      totalAmountCents: 10900
    }
  ],
  itemSummary: [
    {
      productId: "product-1",
      productName: "柔雾唇釉",
      brand: "示例品牌",
      category: "彩妆",
      specification: "3.5g / 豆沙色",
      productionDate: "2026-06-01",
      totalQuantity: 8,
      orderNos: ["O-001", "O-002"]
    }
  ],
  logs: [
    {
      id: "log-1",
      action: "create",
      operatorRole: "customer_service",
      createdAt: "2026-07-13T08:00:00.000Z",
      remark: "合并同一地址订单"
    }
  ],
  logsHasMore: false,
  relatedDataStatus: "complete",
  warnings: []
};

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  transportMock.getShipmentDetail.mockResolvedValue(structuredClone(detail));
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = "";
});

async function mountPage(waitForLoad = true): Promise<VueWrapper> {
  const wrapper = mount(ShipmentDetailView, { attachTo: document.body });
  wrappers.push(wrapper);
  if (waitForLoad) await flushPromises();
  return wrapper;
}

function button(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAllComponents(ElButton).find((candidate) => candidate.text() === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

describe("ShipmentDetailView", () => {
  it("loads exactly once through getShipmentDetail and renders only DTO-backed read sections", async () => {
    const wrapper = await mountPage();

    expect(transportMock.getShipmentDetail).toHaveBeenCalledTimes(1);
    expect(transportMock.getShipmentDetail).toHaveBeenCalledWith("shipment-1");
    expect(transportMock.get).not.toHaveBeenCalled();
    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="shipment-summary"]').text()).toContain("S-20260713-001");
    expect(wrapper.get('[data-testid="shipment-summary"]').text()).toContain("2 单 / 8 种 / 3 件");
    expect(wrapper.get('[data-testid="shipment-orders"]').text()).toContain("O-001");
    expect(wrapper.get('[data-testid="shipment-items"]').text()).toContain("柔雾唇釉");
    expect(wrapper.get('[data-testid="shipment-address"]').text()).toContain("张江路 *** 号");
    expect(wrapper.get('[data-testid="shipment-logs"]').text()).toContain("合并同一地址订单");
    expect(wrapper.text()).not.toMatch(/保存|确认发货|合并所选|完成发货|取消发货|导出/);
  });

  it("shows the initial skeleton and coalesces concurrent refresh requests", async () => {
    let resolve!: (value: ShipmentDetail) => void;
    transportMock.getShipmentDetail.mockReturnValue(new Promise((done) => { resolve = done; }));
    const wrapper = await mountPage(false);

    expect(wrapper.find('[aria-label="合并发货单详情加载中"]').exists()).toBe(true);
    await button(wrapper, "刷新").trigger("click");
    expect(transportMock.getShipmentDetail).toHaveBeenCalledTimes(1);

    resolve(structuredClone(detail));
    await flushPromises();
    expect(wrapper.get('[data-testid="shipment-summary"]').text()).toContain("S-20260713-001");
  });

  it("keeps old data visible during silent refresh and re-reads on shipment sync events", async () => {
    const wrapper = await mountPage();
    let resolve!: (value: ShipmentDetail) => void;
    transportMock.getShipmentDetail.mockReturnValue(new Promise((done) => { resolve = done; }));

    window.dispatchEvent(new CustomEvent("admin-web:sync-events", {
      detail: { events: [{ entityType: "shipment", entityId: "shipment-1" }] }
    }));
    await flushPromises();

    expect(transportMock.getShipmentDetail).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="shipment-summary"]').text()).toContain("S-20260713-001");
    expect(wrapper.find('[aria-label="合并发货单详情加载中"]').exists()).toBe(false);
    resolve(structuredClone(detail));
    await flushPromises();
    expect(transportMock.mutate).not.toHaveBeenCalled();
  });

  it("renders fixed partial warning and explicit empty related sections", async () => {
    transportMock.getShipmentDetail.mockResolvedValue({
      ...structuredClone(detail),
      orders: [],
      itemSummary: [],
      logs: [],
      logsHasMore: true,
      relatedDataStatus: "partial",
      warnings: ["部分关联订单缺失，数据可能不完整"]
    });
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("部分关联订单缺失，数据可能不完整");
    expect(wrapper.get('[data-testid="shipment-orders"]').text()).toContain("暂无关联订单");
    expect(wrapper.get('[data-testid="shipment-items"]').text()).toContain("暂无商品汇总");
    expect(wrapper.get('[data-testid="shipment-logs"]').text()).toContain("暂无可见操作记录");
    expect(wrapper.get('[data-testid="shipment-logs"]').text()).toContain("仅显示最近 100 条记录");
  });

  it.each([
    ["SHIPMENT_NOT_FOUND", 404, "合并发货单不存在"],
    ["SHIPMENT_READ_UNAVAILABLE", 503, "合并发货单暂时不可用"]
  ])("shows retry for %s and recovers without generic reads", async (code, status, message) => {
    transportMock.getShipmentDetail
      .mockRejectedValueOnce(new ApiError(message, code, status))
      .mockResolvedValueOnce(structuredClone(detail));
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain(message);
    expect(wrapper.text()).toContain(code);
    await button(wrapper, "重新加载").trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="shipment-summary"]').text()).toContain("S-20260713-001");
    expect(transportMock.get).not.toHaveBeenCalled();
  });

  it("renders an explicit unavailable state when no detail is returned", async () => {
    transportMock.getShipmentDetail.mockResolvedValue(null);
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("合并发货单不存在或已不可见");
  });
});
