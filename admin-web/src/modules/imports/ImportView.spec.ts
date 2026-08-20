import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ImportView from "./ImportView.vue";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));

function readyPreview(overrides: Record<string, unknown> = {}) {
  return {
    affected: 0,
    message: "文件已完成服务端预览",
    item: {
      importRecordId: "import-1",
      status: "previewed",
      fileHash: "a".repeat(64),
      parseHash: "b".repeat(64),
      fileType: "csv",
      headers: ["sku", "name", "price"],
      mapping: { sku: "sku", name: "name", value: "price" },
      counts: { total: 1, valid: 1, failed: 0, ready: 1, validation: 0, truncated: false },
      previewTruncated: false,
      rows: [{ row: 2, values: { sku: "DEMO-101", name: "演示商品", value: "6900" }, status: "ready", code: "OK", message: "可处理" }],
      ...overrides
    }
  };
}

function successfulExecution() {
  return {
    affected: 1,
    changedCount: 1,
    failedCount: 0,
    message: "导入批次处理完成",
    item: { importRecordId: "import-1", status: "success", counts: { total: 1, success: 1, failed: 0 } }
  };
}

vi.mock("@/config/env", () => ({ useMockTransport: false }));
vi.mock("@/services/transport", () => ({
  transport: { mutate }
}));

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

beforeEach(() => {
  mutate.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ImportView", () => {
  it("uses the real imports preview and confirm chain with the same file hashes and mapping", async () => {
    mutate.mockResolvedValueOnce(readyPreview()).mockResolvedValueOnce(successfulExecution());
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
    await flushPromises();
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));

    expect(mutate).toHaveBeenNthCalledWith(
      1,
      "imports",
      "preview",
      expect.objectContaining({
        type: "quotes",
        file: expect.objectContaining({ name: "quotes.csv", mimeType: "text/csv" })
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    );

    const confirmButton = wrapper.findAll("button").find((button) => button.text().includes("确认导入 1 条"));
    expect(confirmButton).toBeDefined();
    expect(confirmButton!.attributes("disabled")).toBeUndefined();
    await confirmButton!.trigger("click");
    await flushPromises();

    expect(document.body.textContent).toContain("提交前请再次核对文件和影响范围");
    expect(document.body.textContent).toContain("quotes.csv");

    const submitButton = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes("确认提交"));
    expect(submitButton).toBeDefined();
    submitButton!.click();
    await flushPromises();
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));

    expect(mutate).toHaveBeenNthCalledWith(
      2,
      "imports",
      "confirm",
      expect.objectContaining({
        previewRecordId: "import-1",
        expectedFileHash: "a".repeat(64),
        expectedParseHash: "b".repeat(64),
        mapping: { sku: "sku", name: "name", value: "price" }
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    );
    wrapper.unmount();
  });

  it("uses complete server counts so an error after row 200 disables confirmation", async () => {
    mutate.mockResolvedValueOnce(readyPreview({
      counts: { total: 5000, valid: 4999, failed: 1, ready: 4999, validation: 1, truncated: true },
      rows: Array.from({ length: 200 }, (_, index) => ({
        row: index + 2,
        values: { sku: `SKU-${index}`, name: `Item ${index}`, value: String(index) },
        status: "ready",
        code: "OK",
        message: "可处理"
      })),
      previewTruncated: true
    }));
    const wrapper = mount(ImportView, { attachTo: document.body, props: { mode: "inventory" } });
    const input = wrapper.get('input[type="file"]');
    const file = new File(["sku,name,stock\nA,Safe,1"], "inventory.csv", { type: "text/csv" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await wrapper.findAll("button").find((button) => button.text().includes("开始校验"))!.trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    await flushPromises();

    expect(document.body.textContent).toContain("4999 条可处理");
    expect(document.body.textContent).toContain("1 条错误");
    const confirmButton = wrapper.findAll("button").find((button) => button.text().includes("确认导入 4999 条"));
    expect(confirmButton?.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("renders mapping controls from mapping_required without creating a ready preview", async () => {
    mutate.mockResolvedValueOnce({
      affected: 0,
      message: "请完成表头映射后重新校验",
      item: {
        status: "mapping_required",
        headers: ["货号", "品名", "数量"],
        suggestedMapping: { sku: "货号" },
        requiredFields: ["name", "value"],
        mappingErrors: [
          { field: "name", code: "IMPORT_MAPPING_REQUIRED", message: "请选择对应表头" },
          { field: "value", code: "IMPORT_MAPPING_REQUIRED", message: "请选择对应表头" }
        ],
        fileHash: "a".repeat(64),
        parseContext: { hash: "b".repeat(64), fileType: "csv", sheetName: "", headerRow: 1, rowCount: 1 }
      }
    });
    const wrapper = mount(ImportView, { attachTo: document.body, props: { mode: "inventory" } });
    const input = wrapper.get('input[type="file"]');
    const file = new File(["货号,品名,数量\nA,Safe,1"], "inventory.csv", { type: "text/csv" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await wrapper.findAll("button").find((button) => button.text().includes("开始校验"))!.trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    await flushPromises();

    expect(document.body.textContent).toContain("请完成表头映射");
    expect(wrapper.findAll(".mapping-bar label")).toHaveLength(3);
    const confirmButton = wrapper.findAll("button").find((button) => button.text().includes("确认导入"));
    expect(confirmButton?.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
