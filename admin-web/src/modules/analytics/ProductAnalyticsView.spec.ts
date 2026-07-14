import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { ElButton, ElRadioGroup } from "element-plus";
import { nextTick } from "vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/services/http/api-error";
import type { ProductAnalyticsData } from "@/types/api";
import ProductAnalyticsView from "./ProductAnalyticsView.vue";

const transportMock = vi.hoisted(() => ({
  getProductAnalytics: vi.fn()
}));

vi.mock("@/services/transport", () => ({ transport: transportMock }));
vi.mock("vue-echarts", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "VChartTestStub",
      props: { option: { type: Object, required: true } },
      setup: () => () => h("div", { "data-testid": "chart-stub" })
    })
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function analyticsData(
  range: ProductAnalyticsData["range"] = "30d",
  overrides: Partial<ProductAnalyticsData> = {}
): ProductAnalyticsData {
  return {
    range,
    status: "available",
    summary: [
      { key: `sales-${range}`, label: `${range} 销量`, value: 12, kind: "number", change: 5 }
    ],
    series: [
      {
        date: "2026-07-11",
        salesCount: 12,
        averagePriceCents: 1200,
        quotePriceCents: 1300,
        inventoryChange: -1
      }
    ],
    ranking: [
      {
        id: `product-${range}`,
        name: `${range} 商品`,
        sku: `SKU-${range}`,
        salesCount: 12,
        averagePriceCents: 1200,
        currentPriceCents: 1300,
        change: 5
      }
    ],
    updatedAt: "2026-07-11T12:00:00.000Z",
    ...overrides
  };
}

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
  vi.useRealTimers();
  transportMock.getProductAnalytics.mockResolvedValue(analyticsData());
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(ProductAnalyticsView, {
    attachTo: document.body
  });
  wrappers.push(wrapper);
  await flushPromises();
  await nextTick();
  return wrapper;
}

async function selectRange(wrapper: VueWrapper, value: ProductAnalyticsData["range"]): Promise<void> {
  const control = wrapper.getComponent(ElRadioGroup);
  control.vm.$emit("update:modelValue", value);
  await nextTick();
  control.vm.$emit("change", value);
  await nextTick();
}

function refreshButton(wrapper: VueWrapper) {
  const button = wrapper.findAllComponents(ElButton).find((candidate) => candidate.text() === "刷新");
  if (!button) throw new Error("Refresh button not found");
  return button;
}

describe("ProductAnalyticsView", () => {
  it("loads the 30d range initially", async () => {
    const wrapper = await mountPage();

    expect(transportMock.getProductAnalytics).toHaveBeenCalledTimes(1);
    expect(transportMock.getProductAnalytics).toHaveBeenCalledWith("30d");
    expect(wrapper.get('[data-testid="analytics-range-label"]').text()).toBe("近 30 天");
  });

  it("keeps old data during rapid switches and lets only the latest response, error, and finally win", async () => {
    const seven = deferred<ProductAnalyticsData>();
    const secondThirty = deferred<ProductAnalyticsData>();
    const ninety = deferred<ProductAnalyticsData>();
    let initialThirty = true;
    transportMock.getProductAnalytics.mockImplementation((requestedRange: ProductAnalyticsData["range"]) => {
      if (requestedRange === "7d") return seven.promise;
      if (requestedRange === "90d") return ninety.promise;
      if (initialThirty) {
        initialThirty = false;
        return Promise.resolve(analyticsData("30d"));
      }
      return secondThirty.promise;
    });
    const wrapper = await mountPage();

    await selectRange(wrapper, "7d");
    await selectRange(wrapper, "30d");
    await selectRange(wrapper, "90d");
    expect(transportMock.getProductAnalytics.mock.calls.map(([value]) => value)).toEqual(["30d", "7d", "30d", "90d"]);
    expect(wrapper.get('[data-testid="analytics-range-label"]').text()).toBe("近 30 天");
    expect(refreshButton(wrapper).props("loading")).toBe(true);

    seven.resolve(analyticsData("7d"));
    await flushPromises();
    expect(wrapper.get('[data-testid="analytics-range-label"]').text()).toBe("近 30 天");
    expect(wrapper.find('[data-testid="summary-sales-7d"]').exists()).toBe(false);
    expect(refreshButton(wrapper).props("loading")).toBe(true);

    secondThirty.reject(new ApiError("旧请求失败", "STALE_ERROR", 503));
    await flushPromises();
    expect(wrapper.text()).not.toContain("旧请求失败");
    expect(refreshButton(wrapper).props("loading")).toBe(true);

    ninety.resolve(analyticsData("90d"));
    await flushPromises();
    expect(wrapper.get('[data-testid="analytics-range-label"]').text()).toBe("近 90 天");
    expect(wrapper.find('[data-testid="summary-sales-90d"]').exists()).toBe(true);
    expect(refreshButton(wrapper).props("loading")).toBe(false);
  });

  it("rejects a mismatched response range and supports retry", async () => {
    transportMock.getProductAnalytics
      .mockResolvedValueOnce(analyticsData("7d"))
      .mockResolvedValueOnce(analyticsData("30d"));
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("商品分析响应范围不匹配");
    expect(wrapper.text()).toContain("PRODUCT_ANALYTICS_RANGE_MISMATCH");
    expect(wrapper.find('[data-testid="analytics-range-label"]').exists()).toBe(false);

    const retry = wrapper.findAllComponents(ElButton).find((candidate) => candidate.text() === "重新加载");
    if (!retry) throw new Error("Retry button not found");
    await retry.trigger("click");
    await flushPromises();

    expect(transportMock.getProductAnalytics).toHaveBeenNthCalledWith(2, "30d");
    expect(wrapper.get('[data-testid="analytics-range-label"]').text()).toBe("近 30 天");
  });

  it("renders null as a dash while preserving real zero values", async () => {
    transportMock.getProductAnalytics.mockResolvedValue(analyticsData("30d", {
      summary: [
        { key: "zero", label: "零销量", value: 0, kind: "number", change: 0 },
        { key: "no-change", label: "零金额", value: 0, kind: "money", change: null },
        { key: "null-value", label: "暂无均价", value: null, kind: "money", change: null }
      ],
      series: [{
        date: "2026-07-11",
        salesCount: 0,
        averagePriceCents: 0,
        quotePriceCents: null,
        inventoryChange: null
      }],
      ranking: [{
        id: "product-null-zero",
        name: "零值商品",
        sku: "",
        salesCount: 0,
        averagePriceCents: null,
        currentPriceCents: 0,
        change: null
      }]
    }));
    const wrapper = await mountPage();

    expect(wrapper.get('[data-testid="summary-zero"]').text()).toContain("0%");
    expect(wrapper.get('[data-testid="summary-no-change"]').text()).toContain("¥0.00");
    expect(wrapper.get('[data-testid="summary-no-change"]').text()).toMatch(/-$/);
    expect(wrapper.get('[data-testid="summary-value-null-value"]').text()).toBe("-");
    expect(wrapper.get('[data-testid="ranking-average-product-null-zero"]').text()).toBe("-");
    expect(wrapper.get('[data-testid="ranking-current-product-null-zero"]').text()).toBe("¥0.00");
    expect(wrapper.get('[data-testid="ranking-change-product-null-zero"]').text()).toBe("-");
    expect(wrapper.get('[data-testid="ranking-sku-product-null-zero"]').text()).toBe("-");
    expect(wrapper.text()).toContain("当前售价");

    const option = wrapper.getComponent({ name: "VChartTestStub" }).props("option") as {
      yAxis: Array<{ name: string }>;
      series: Array<{ data: Array<number | null> }>;
    };
    expect(option.yAxis[0]?.name).toBe("数量");
    expect(option.series[1]?.data).toEqual([0]);
    expect(option.series[2]?.data).toEqual([null]);
    expect(option.series[3]?.data).toEqual([null]);
  });

  it("uses one empty state and shows an available message without hiding data", async () => {
    transportMock.getProductAnalytics
      .mockResolvedValueOnce(analyticsData("30d", {
        status: "empty",
        message: "当前范围暂无成交数据",
        summary: [],
        series: [],
        ranking: []
      }))
      .mockResolvedValueOnce(analyticsData("7d", { message: "库存变化暂不可见" }));
    const wrapper = await mountPage();

    expect(wrapper.get('[data-testid="analytics-empty"]').text()).toContain("当前范围暂无成交数据");
    expect(wrapper.find('[aria-label="分析摘要"]').exists()).toBe(false);

    await selectRange(wrapper, "7d");
    await flushPromises();
    expect(wrapper.text()).toContain("库存变化暂不可见");
    expect(wrapper.find('[data-testid="summary-sales-7d"]').exists()).toBe(true);
  });

  it("keeps the unavailable compatibility state", async () => {
    transportMock.getProductAnalytics.mockResolvedValue(analyticsData("30d", {
      status: "unavailable",
      message: "分析服务维护中",
      summary: [],
      series: [],
      ranking: []
    }));
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("分析服务维护中");
    expect(wrapper.find('[aria-label="分析摘要"]').exists()).toBe(false);
  });

  it("merges relevant sync bursts, ignores unrelated events, and cleans up on unmount", async () => {
    vi.useFakeTimers();
    const wrapper = await mountPage();

    window.dispatchEvent(new CustomEvent("admin-web:sync-events", {
      detail: { events: [{ entityType: "payment" }] }
    }));
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(transportMock.getProductAnalytics).toHaveBeenCalledTimes(1);

    for (const entityType of ["product", "inventory", "order"]) {
      window.dispatchEvent(new CustomEvent("admin-web:sync-events", {
        detail: { events: [{ entityType }] }
      }));
    }
    vi.advanceTimersByTime(249);
    await flushPromises();
    expect(transportMock.getProductAnalytics).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(transportMock.getProductAnalytics).toHaveBeenCalledTimes(2);
    expect(transportMock.getProductAnalytics).toHaveBeenLastCalledWith("30d");

    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    window.dispatchEvent(new CustomEvent("admin-web:sync-events", {
      detail: { events: [{ entityType: "product" }] }
    }));
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(transportMock.getProductAnalytics).toHaveBeenCalledTimes(2);
  });

  it("uses a visible-page bounded fallback refresh and clears it on unmount", async () => {
    vi.useFakeTimers();
    const wrapper = await mountPage();
    expect(transportMock.getProductAnalytics).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(transportMock.getProductAnalytics).toHaveBeenCalledTimes(2);

    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transportMock.getProductAnalytics).toHaveBeenCalledTimes(2);
  });
});
