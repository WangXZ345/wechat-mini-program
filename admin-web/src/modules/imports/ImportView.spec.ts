import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import ImportView from "./ImportView.vue";

vi.mock("@/config/env", () => ({ useMockTransport: true }));
vi.mock("@/services/transport", () => ({
  transport: {
    mutate: vi.fn().mockResolvedValue({ affected: 3, message: "演示导入已完成", requestId: "mock-import" })
  }
}));

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ImportView", () => {
  it("opens the confirmation dialog after a normal mock file passes validation", async () => {
    const wrapper = mount(ImportView, {
      attachTo: document.body,
      props: { mode: "quotes" }
    });

    const input = wrapper.get('input[type="file"]');
    const file = new File(["sku,price\nDEMO-101,6900"], "quotes.csv", { type: "text/csv" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await flushPromises();

    const validateButton = wrapper.findAll("button").find((button) => button.text().includes("开始校验"));
    expect(validateButton).toBeDefined();
    await validateButton!.trigger("click");
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    await flushPromises();

    const confirmButton = wrapper.findAll("button").find((button) => button.text().includes("确认导入 3 条"));
    expect(confirmButton).toBeDefined();
    expect(confirmButton!.attributes("disabled")).toBeUndefined();
    await confirmButton!.trigger("click");
    await flushPromises();

    expect(document.body.textContent).toContain("提交前请再次核对文件和影响范围");
    expect(document.body.textContent).toContain("quotes.csv");
    wrapper.unmount();
  });
});
