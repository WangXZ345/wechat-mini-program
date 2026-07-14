import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { ElFormItem, ElInput, ElInputNumber } from "element-plus";
import { nextTick } from "vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/services/http/api-error";
import type { ProductDetail, ProductSummary } from "@/services/transport/product-write-contract";
import type { AdminTransport } from "@/types/api";
import ProductEditorDialog from "./ProductEditorDialog.vue";

const metadata = {
  name: "测试精华",
  baseName: "测试精华",
  imageUrl: "https://example.com/product.jpg",
  specification: "30ml",
  productionDate: "2026-07",
  description: "测试商品说明",
  productIndex: "P000001",
  skuCode: "SKU-001",
  keywords: ["测试", "精华"]
};
const detail: ProductDetail = {
  id: "product-1",
  version: 3,
  metadata,
  initial: {
    salePriceCents: 6990,
    stock: 20,
    warningThreshold: 5,
    isActive: true,
    tags: ["热销"]
  },
  updatedAt: "2026-07-12T08:00:00.000Z"
};
const summary: ProductSummary = {
  id: "product-1",
  sku: "SKU-001",
  name: "测试精华",
  brand: "",
  salePriceCents: 6990,
  status: "active" as const,
  isActive: true,
  tags: ["热销"],
  updatedAt: "2026-07-12T08:00:00.000Z",
  version: 4
};

const transport = {
  mode: "http",
  getProductDetail: vi.fn(),
  createProduct: vi.fn(),
  editProduct: vi.fn()
} as unknown as AdminTransport;

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
  vi.mocked(transport.getProductDetail).mockResolvedValue(structuredClone(detail));
  vi.mocked(transport.createProduct).mockResolvedValue({ item: { ...summary, version: 1 }, affected: 1, message: "商品已新增" });
  vi.mocked(transport.editProduct).mockResolvedValue({ item: summary, affected: 1, message: "商品资料已更新" });
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = "";
});

async function mountEditor(mode: "create" | "edit"): Promise<VueWrapper> {
  const wrapper = mount(ProductEditorDialog, {
    attachTo: document.body,
    props: { modelValue: false, mode, productId: mode === "edit" ? "product-1" : "", transport },
    global: { stubs: { teleport: true } }
  });
  wrappers.push(wrapper);
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  await nextTick();
  return wrapper;
}

async function setText(wrapper: VueWrapper, testId: string, value: string): Promise<void> {
  const positions: Record<string, number> = {
    "product-name": 0,
    "product-base-name": 1,
    "product-index": 2,
    "product-sku": 3
  };
  const position = positions[testId];
  if (position === undefined) throw new Error(`Unknown ${testId}`);
  const input = wrapper.findAllComponents(ElInput)[position];
  if (!input) throw new Error(`Missing ${testId}`);
  input.vm.$emit("update:modelValue", value);
  await nextTick();
}

async function setNumber(wrapper: VueWrapper, testId: string, value: number): Promise<void> {
  const positions: Record<string, number> = { "product-price": 0, "product-stock": 1, "product-warning": 2 };
  const position = positions[testId];
  if (position === undefined) throw new Error(`Unknown ${testId}`);
  const input = wrapper.findAllComponents(ElInputNumber)[position];
  if (!input) throw new Error(`Missing ${testId}`);
  input.vm.$emit("update:modelValue", value);
  await nextTick();
}

describe("ProductEditorDialog", () => {
  it("creates a product with integer cents and the exact initial business fields", async () => {
    const wrapper = await mountEditor("create");
    await setText(wrapper, "product-name", " 新增面霜 ");
    await setText(wrapper, "product-sku", " NEW-001 ");
    await setNumber(wrapper, "product-price", 88.5);
    await setNumber(wrapper, "product-stock", 30);
    await setNumber(wrapper, "product-warning", 6);
    await wrapper.get('[data-testid="product-editor-submit"]').trigger("click");
    await flushPromises();

    expect(transport.createProduct).toHaveBeenCalledTimes(1);
    const [input, options] = vi.mocked(transport.createProduct).mock.calls[0]!;
    expect(input).toEqual({
      metadata: {
        name: "新增面霜",
        baseName: "",
        imageUrl: "",
        specification: "",
        productionDate: "",
        description: "",
        productIndex: "",
        skuCode: "NEW-001",
        keywords: []
      },
      initial: { salePriceCents: 8850, stock: 30, warningThreshold: 6, isActive: false, tags: [] },
      reason: ""
    });
    expect(options.idempotencyKey).toMatch(/^products:create:/);
    expect(wrapper.emitted("saved")?.[0]).toEqual(["商品已新增"]);
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([false]);
  });

  it("loads detail and submits metadata only for edit", async () => {
    const wrapper = await mountEditor("edit");
    expect(transport.getProductDetail).toHaveBeenCalledWith("product-1");
    expect(wrapper.text()).toContain("本窗口只修改商品资料");
    expect(wrapper.text()).toContain("当前库存");
    expect(wrapper.find('[data-testid="product-stock"]').exists()).toBe(false);

    await setText(wrapper, "product-name", "测试精华升级版");
    await wrapper.get('[data-testid="product-editor-submit"]').trigger("click");
    await flushPromises();

    const [input, options] = vi.mocked(transport.editProduct).mock.calls[0]!;
    expect(input).toEqual({
      id: "product-1",
      expectedVersion: 3,
      metadata: { ...metadata, name: "测试精华升级版" },
      reason: ""
    });
    expect(input).not.toHaveProperty("initial");
    expect(input.metadata).not.toHaveProperty("stock");
    expect(input.metadata).not.toHaveProperty("internalTags");
    expect(options.expectedVersion).toBe(3);
  });

  it("preserves the draft and refreshes the version after a conflict", async () => {
    vi.mocked(transport.getProductDetail)
      .mockResolvedValueOnce(structuredClone(detail))
      .mockResolvedValueOnce({ ...structuredClone(detail), version: 4, metadata: { ...metadata, name: "其他管理员修改" } });
    vi.mocked(transport.editProduct)
      .mockRejectedValueOnce(new ApiError("版本冲突", "DATA_VERSION_CONFLICT", 409))
      .mockResolvedValueOnce({ item: { ...summary, name: "我的修订", version: 5 }, affected: 1, message: "商品资料已更新" });
    const wrapper = await mountEditor("edit");
    await setText(wrapper, "product-name", "我的修订");
    await wrapper.get('[data-testid="product-editor-submit"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("已保留当前填写内容");
    const name = wrapper.findAllComponents(ElInput)[0];
    expect(name?.props("modelValue")).toBe("我的修订");
    const firstKey = vi.mocked(transport.editProduct).mock.calls[0]![1].idempotencyKey;

    await wrapper.get('[data-testid="product-editor-submit"]').trigger("click");
    await flushPromises();
    const [retryInput, retryOptions] = vi.mocked(transport.editProduct).mock.calls[1]!;
    expect(retryInput.expectedVersion).toBe(4);
    expect(retryInput.metadata.name).toBe("我的修订");
    expect(retryOptions.idempotencyKey).not.toBe(firstKey);
  });

  it("shows field errors and does not call the transport for invalid input", async () => {
    const wrapper = await mountEditor("create");
    await setText(wrapper, "product-name", "");
    await setNumber(wrapper, "product-price", -1);
    await wrapper.get('[data-testid="product-editor-submit"]').trigger("click");
    await nextTick();

    expect(transport.createProduct).not.toHaveBeenCalled();
    expect(wrapper.findAllComponents(ElFormItem)[0]?.props("error")).toBe("请输入商品名称");
    expect(wrapper.text()).toContain("请修正表单中的错误后再保存");
  });

  it("requires an existing or newly supplied product index when editing", async () => {
    vi.mocked(transport.getProductDetail).mockResolvedValue({
      ...structuredClone(detail),
      metadata: { ...metadata, productIndex: "" }
    });
    const wrapper = await mountEditor("edit");
    await wrapper.get('[data-testid="product-editor-submit"]').trigger("click");
    await nextTick();

    expect(transport.editProduct).not.toHaveBeenCalled();
    expect(wrapper.findAllComponents(ElFormItem)[2]?.props("error")).toBe("编辑商品时必须填写商品索引");
  });

  it("preserves a CloudBase fileID when editing product metadata", async () => {
    const cloudFileId = "cloud://test-env.1234-test-env/product-images/item.jpg";
    vi.mocked(transport.getProductDetail).mockResolvedValue({
      ...structuredClone(detail),
      metadata: { ...metadata, imageUrl: cloudFileId }
    });
    const wrapper = await mountEditor("edit");
    await wrapper.get('[data-testid="product-editor-submit"]').trigger("click");
    await flushPromises();

    expect(transport.editProduct).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport.editProduct).mock.calls[0]![0].metadata.imageUrl).toBe(cloudFileId);
  });

  it("rejects an image URL with an unsupported scheme", async () => {
    const wrapper = await mountEditor("create");
    await setText(wrapper, "product-name", "测试商品");
    const imageInput = wrapper.findAllComponents(ElInput)[6];
    imageInput?.vm.$emit("update:modelValue", "ftp://example.com/item.jpg");
    await nextTick();
    await wrapper.get('[data-testid="product-editor-submit"]').trigger("click");
    await nextTick();

    expect(transport.createProduct).not.toHaveBeenCalled();
    expect(wrapper.findAllComponents(ElFormItem)[6]?.props("error")).toContain("HTTP、HTTPS 或 CloudBase");
  });

  it("rejects a CloudBase fileID without a file path", async () => {
    const wrapper = await mountEditor("create");
    await setText(wrapper, "product-name", "测试商品");
    const imageInput = wrapper.findAllComponents(ElInput)[6];
    imageInput?.vm.$emit("update:modelValue", "cloud://env-only");
    await nextTick();
    await wrapper.get('[data-testid="product-editor-submit"]').trigger("click");
    await nextTick();

    expect(transport.createProduct).not.toHaveBeenCalled();
    expect(wrapper.findAllComponents(ElFormItem)[6]?.props("error")).toContain("环境标识和文件路径");
  });
});
