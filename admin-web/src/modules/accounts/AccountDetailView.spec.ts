import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { ElButton } from "element-plus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/services/http/api-error";
import AccountDetailView from "./AccountDetailView.vue";

const transportMock = vi.hoisted(() => ({ getAccountDetail: vi.fn(), mutate: vi.fn(), get: vi.fn() }));
const routerMock = vi.hoisted(() => ({ back: vi.fn() }));

vi.mock("@/services/transport", () => ({ transport: transportMock }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "account-1" } }),
  useRouter: () => routerMock
}));

const detail = {
  account: {
    id: "account-1",
    customerMasked: "演示客户 / 138****8000",
    totalOrders: 8,
    receivableCents: 268000,
    receivedCents: 239300,
    unpaidAmountCents: 28700,
    pendingConfirmAmountCents: 8700,
    abnormalCount: 0,
    status: "unpaid",
    lastOrderAt: "2026-07-13T08:00:00.000Z",
    lastPaymentAt: "2026-07-13T08:30:00.000Z",
    updatedAt: "2026-07-13T09:00:00.000Z"
  },
  orders: [{
    id: "order-1",
    orderNo: "DEMO-O-001",
    status: "pending_shipment",
    paymentStatus: "pending_confirm",
    totalAmountCents: 28700,
    createdAt: "2026-07-13T07:00:00.000Z"
  }],
  logs: [{
    id: "log-1",
    changeType: "order_created",
    beforeReceivableCents: 239300,
    afterReceivableCents: 268000,
    beforeReceivedCents: 239300,
    afterReceivedCents: 239300,
    beforeUnpaidCents: 0,
    afterUnpaidCents: 28700,
    changeAmountCents: 28700,
    orderNo: "DEMO-O-001",
    createdAt: "2026-07-13T07:00:00.000Z",
    summary: "订单创建，账款增加"
  }],
  ordersHasMore: false,
  logsHasMore: false,
  relatedDataStatus: "complete",
  warnings: []
};

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  transportMock.getAccountDetail.mockResolvedValue(structuredClone(detail));
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = "";
});

async function mountPage(waitForLoad = true): Promise<VueWrapper> {
  const wrapper = mount(AccountDetailView, { attachTo: document.body });
  wrappers.push(wrapper);
  if (waitForLoad) await flushPromises();
  return wrapper;
}

function button(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAllComponents(ElButton).find((candidate) => candidate.text() === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

describe("AccountDetailView", () => {
  it("loads once through getAccountDetail and renders only DTO-backed read sections", async () => {
    const wrapper = await mountPage();

    expect(transportMock.getAccountDetail).toHaveBeenCalledTimes(1);
    expect(transportMock.getAccountDetail).toHaveBeenCalledWith("account-1");
    expect(transportMock.get).not.toHaveBeenCalled();
    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="account-summary"]').text()).toContain("演示客户 / 138****8000");
    expect(wrapper.get('[data-testid="account-summary"]').text()).toContain("¥2,680.00");
    expect(wrapper.get('[data-testid="account-orders"]').text()).toContain("DEMO-O-001");
    expect(wrapper.get('[data-testid="account-logs"]').text()).toContain("订单创建，账款增加");
    expect(wrapper.text()).not.toMatch(/重算账款|修改账款|确认结清|导出账款|确认付款/);
  });

  it("shows the initial skeleton and coalesces concurrent refresh requests", async () => {
    let resolve!: (value: typeof detail) => void;
    transportMock.getAccountDetail.mockReturnValue(new Promise((done) => { resolve = done; }));
    const wrapper = await mountPage(false);

    expect(wrapper.find('[aria-label="客户账款详情加载中"]').exists()).toBe(true);
    await button(wrapper, "刷新").trigger("click");
    expect(transportMock.getAccountDetail).toHaveBeenCalledTimes(1);

    resolve(structuredClone(detail));
    await flushPromises();
    expect(wrapper.get('[data-testid="account-summary"]').text()).toContain("演示客户 / 138****8000");
  });

  it("keeps old data visible during silent refresh and rereads only matching account sync events", async () => {
    const wrapper = await mountPage();
    let resolve!: (value: typeof detail) => void;
    transportMock.getAccountDetail.mockReturnValue(new Promise((done) => { resolve = done; }));

    window.dispatchEvent(new CustomEvent("admin-web:sync-events", {
      detail: { events: [{ entityType: "account", entityId: "account-1" }] }
    }));
    await flushPromises();

    expect(transportMock.getAccountDetail).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="account-summary"]').text()).toContain("演示客户 / 138****8000");
    expect(wrapper.find('[aria-label="客户账款详情加载中"]').exists()).toBe(false);
    window.dispatchEvent(new CustomEvent("admin-web:sync-events", {
      detail: { events: [{ entityType: "account", entityId: "account-2" }] }
    }));
    await flushPromises();
    expect(transportMock.getAccountDetail).toHaveBeenCalledTimes(2);

    resolve(structuredClone(detail));
    await flushPromises();
    expect(transportMock.mutate).not.toHaveBeenCalled();
  });

  it("renders fixed partial warning and explicit empty related sections", async () => {
    transportMock.getAccountDetail.mockResolvedValue({
      ...structuredClone(detail),
      orders: [],
      logs: [],
      ordersHasMore: true,
      logsHasMore: true,
      relatedDataStatus: "partial",
      warnings: ["部分关联数据暂时不可用"]
    });
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("部分关联账款数据暂时不可用");
    expect(wrapper.get('[data-testid="account-orders"]').text()).toContain("暂无关联订单");
    expect(wrapper.get('[data-testid="account-orders"]').text()).toContain("仅显示最近 50 条订单");
    expect(wrapper.get('[data-testid="account-logs"]').text()).toContain("暂无可见账款流水");
    expect(wrapper.get('[data-testid="account-logs"]').text()).toContain("仅显示最近 100 条流水");
  });

  it.each([
    ["ACCOUNT_NOT_FOUND", 404, "客户账款不存在"],
    ["ACCOUNT_READ_UNAVAILABLE", 503, "客户账款暂时不可用"]
  ])("shows retry for %s and recovers without generic reads", async (code, status, message) => {
    transportMock.getAccountDetail
      .mockRejectedValueOnce(new ApiError(message, code, status))
      .mockResolvedValueOnce(structuredClone(detail));
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain(message);
    expect(wrapper.text()).toContain(code);
    await button(wrapper, "重新加载").trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="account-summary"]').text()).toContain("演示客户 / 138****8000");
    expect(transportMock.get).not.toHaveBeenCalled();
  });

  it("renders an explicit unavailable state when no detail is returned", async () => {
    transportMock.getAccountDetail.mockResolvedValue(null);
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("客户账款不存在或已不可见");
  });
});
