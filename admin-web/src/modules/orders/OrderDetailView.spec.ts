import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { ElButton } from "element-plus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/services/http/api-error";
import type { OrderDetail } from "@/services/transport/order-query-contract";
import OrderDetailView from "./OrderDetailView.vue";

const transportMock = vi.hoisted(() => ({ get: vi.fn() }));
const routerMock = vi.hoisted(() => ({ back: vi.fn() }));

vi.mock("@/services/transport", () => ({ transport: transportMock }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "order-1" } }),
  useRouter: () => routerMock
}));

const detail: OrderDetail = {
  id: "order-1",
  orderNo: "O-20260713-001",
  customerMasked: "王** / 138****1201",
  customerPhoneMasked: "138****1201",
  itemSummary: "柔雾唇釉等 3 件",
  itemCount: 2,
  totalQuantity: 3,
  status: "pending_review",
  paymentStatus: "unpaid",
  deliveryStatus: "pending",
  createdAt: "2026-07-13T08:00:00.000Z",
  updatedAt: "2026-07-13T09:00:00.000Z",
  version: 7,
  totalAmountCents: 28700,
  items: [
    {
      id: "line-1",
      productId: "product-1",
      productName: "柔雾唇釉",
      specification: "3.5g / 豆沙色",
      productionDate: "2026-06-01",
      quantity: 2,
      unitPriceCents: 8900,
      totalAmountCents: 17800
    },
    {
      id: "line-2",
      productId: "product-2",
      productName: "修护精华",
      specification: "30ml",
      productionDate: "",
      quantity: 1,
      unitPriceCents: 10900,
      totalAmountCents: 10900
    }
  ],
  customer: {
    nameMasked: "王**",
    phoneMasked: "138****1201",
    phone: "13800131201"
  },
  shippingAddressMasked: {
    receiverName: "王**",
    receiverPhoneMasked: "138****1201",
    regionText: "上海市 浦东新区",
    detailAddressMasked: "张江路 *** 号"
  },
  shippingAddress: {
    receiverName: "王希哲",
    receiverPhone: "13800131201",
    regionText: "上海市 浦东新区",
    detailAddress: "张江路 100 号"
  },
  adminRemark: "优先安排现货",
  riskLevelSnapshot: "important"
};

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  transportMock.get.mockResolvedValue(structuredClone(detail));
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(OrderDetailView, { attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("OrderDetailView", () => {
  it("loads the strict order detail and renders dense operational sections", async () => {
    const wrapper = await mountPage();

    expect(transportMock.get).toHaveBeenCalledWith("orders", "order-1");
    expect(wrapper.get('[data-testid="order-heading"]').text()).toContain("O-20260713-001");
    expect(wrapper.get('[data-testid="order-summary"]').text()).toContain("¥287.00");
    expect(wrapper.get('[data-testid="order-items"]').text()).toContain("柔雾唇釉");
    expect(wrapper.get('[data-testid="order-items"]').text()).toContain("2");
    expect(wrapper.get('[data-testid="order-customer"]').text()).toContain("13800131201");
    expect(wrapper.get('[data-testid="order-address"]').text()).toContain("张江路 100 号");
    expect(wrapper.get('[data-testid="order-sensitive"]').text()).toContain("优先安排现货");
    expect(wrapper.text()).toContain("版本 7");
  });

  it("does not render optional amount, full contact, remark, or risk fields when the DTO omits them", async () => {
    transportMock.get.mockResolvedValue({
      ...structuredClone(detail),
      totalAmountCents: undefined,
      customer: { nameMasked: "王**", phoneMasked: "138****1201" },
      shippingAddress: undefined,
      adminRemark: undefined,
      riskLevelSnapshot: undefined,
      items: detail.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        specification: item.specification,
        productionDate: item.productionDate,
        quantity: item.quantity
      }))
    });
    const wrapper = await mountPage();

    expect(wrapper.find('[data-testid="order-total-amount"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("13800131201");
    expect(wrapper.get('[data-testid="order-address"]').text()).toContain("张江路 *** 号");
    expect(wrapper.find('[data-testid="order-sensitive"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="line-amount-line-1"]').exists()).toBe(false);
  });

  it("shows a retryable error and keeps back navigation available", async () => {
    transportMock.get
      .mockRejectedValueOnce(new ApiError("订单详情加载失败", "ORDER_READ_FAILED", 503))
      .mockResolvedValueOnce(structuredClone(detail));
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("订单详情加载失败");
    expect(wrapper.text()).toContain("ORDER_READ_FAILED");
    const retry = wrapper.findAllComponents(ElButton).find((button) => button.text() === "重新加载");
    if (!retry) throw new Error("Retry button not found");
    await retry.trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="order-heading"]').text()).toContain("O-20260713-001");

    const back = wrapper.findAllComponents(ElButton).find((button) => button.text() === "返回订单列表");
    if (!back) throw new Error("Back button not found");
    await back.trigger("click");
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it("renders an explicit empty state when the order is unavailable", async () => {
    transportMock.get.mockResolvedValue(null);
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("订单不存在或已不可见");
    expect(wrapper.find('[data-testid="order-summary"]').exists()).toBe(false);
  });
});
