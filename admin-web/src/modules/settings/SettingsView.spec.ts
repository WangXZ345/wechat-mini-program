import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView.vue";

const transportMock = vi.hoisted(() => ({
  mode: "mock",
  get: vi.fn(),
  mutate: vi.fn()
}));

vi.mock("@/services/transport", () => ({ transport: transportMock }));

const wrappers: VueWrapper[] = [];

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  transportMock.mode = "http";
  transportMock.get.mockResolvedValue({
    id: "system",
    version: 2,
    enableOfflineQrPayment: true,
    enableBankTransfer: false,
    enableWechatPay: false,
    requirePaymentProofForOfflinePayment: true,
    allowMultiplePaymentRecords: false,
    maxPaymentScreenshotCount: 3,
    lowStockDefaultThreshold: 50,
    updatedAt: "2026-07-17T08:15:00.000Z"
  });
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = "";
});

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(SettingsView, { attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("SettingsView", () => {
  it("omits the session idle setting when the transport response does not provide it", async () => {
    const wrapper = await mountPage();

    expect(wrapper.text()).not.toContain("无操作自动锁定（分钟）");
    expect(wrapper.findAll("input").map((input) => input.element.value)).not.toContain("30");
  });

  it("shows the session idle setting and value when the transport response provides it", async () => {
    transportMock.mode = "mock";
    transportMock.get.mockResolvedValueOnce({
      id: "system",
      version: 2,
      enableOfflineQrPayment: true,
      enableBankTransfer: false,
      enableWechatPay: false,
      requirePaymentProofForOfflinePayment: true,
      allowMultiplePaymentRecords: false,
      maxPaymentScreenshotCount: 3,
      lowStockDefaultThreshold: 50,
      sessionIdleMinutes: 30,
      updatedAt: "2026-07-17T08:15:00.000Z"
    });

    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("无操作自动锁定（分钟）");
    expect(wrapper.findAll("input").map((input) => input.element.value)).toContain("30");
  });
});
