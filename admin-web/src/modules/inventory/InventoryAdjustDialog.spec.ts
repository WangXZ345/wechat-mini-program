import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { ElFormItem, ElInput, ElInputNumber } from "element-plus";
import { nextTick } from "vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/services/http/api-error";
import type { InventorySnapshot } from "@/services/transport/inventory-adjustment-contract";
import type { AdminTransport } from "@/types/api";
import InventoryAdjustDialog from "./InventoryAdjustDialog.vue";

const initial: InventorySnapshot = {
  id: "product-1",
  stock: 12,
  warningThreshold: 5,
  status: "normal",
  isActive: true,
  version: 3,
  updatedAt: "2026-07-12T08:00:00.000Z"
};
const adjusted: InventorySnapshot = {
  ...initial,
  stock: 8,
  version: 4,
  updatedAt: "2026-07-12T08:01:00.000Z"
};
const transport = {
  mode: "http",
  getInventorySnapshot: vi.fn(),
  adjustInventory: vi.fn()
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
  vi.mocked(transport.getInventorySnapshot).mockResolvedValue(structuredClone(initial));
  vi.mocked(transport.adjustInventory).mockResolvedValue({ item: adjusted, affected: 1, message: "库存已从 12 调整为 8" });
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = "";
});

async function mountDialog(): Promise<VueWrapper> {
  const wrapper = mount(InventoryAdjustDialog, {
    attachTo: document.body,
    props: {
      modelValue: false,
      productId: "product-1",
      productName: "测试商品",
      sku: "SKU-001",
      resource: "inventory",
      transport
    },
    global: { stubs: { teleport: true } }
  });
  wrappers.push(wrapper);
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  await nextTick();
  return wrapper;
}

async function setDelta(wrapper: VueWrapper, value: number): Promise<void> {
  wrapper.getComponent(ElInputNumber).vm.$emit("update:modelValue", value);
  await nextTick();
}

async function setReason(wrapper: VueWrapper, value: string): Promise<void> {
  const input = wrapper.findAllComponents(ElInput).at(-1);
  if (!input) throw new Error("Missing reason input");
  input.vm.$emit("update:modelValue", value);
  await nextTick();
}

async function submit(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-testid="inventory-adjust-submit"]').trigger("click");
  await nextTick();
}

describe("InventoryAdjustDialog", () => {
  it("loads the latest snapshot and submits the exact delta contract", async () => {
    const wrapper = await mountDialog();
    expect(transport.getInventorySnapshot).toHaveBeenCalledWith("product-1");
    expect(wrapper.get('[data-testid="inventory-current-stock"]').text()).toBe("12");

    await setDelta(wrapper, -4);
    await setReason(wrapper, " 盘点修正 ");
    expect(wrapper.get('[data-testid="inventory-after-stock"]').text()).toBe("12 → 8");
    expect(wrapper.get('[data-testid="inventory-adjust-submit"]').text()).toContain("确认减少 4 件");
    await submit(wrapper);
    await flushPromises();

    expect(transport.adjustInventory).toHaveBeenCalledTimes(1);
    const [resource, input, options] = vi.mocked(transport.adjustInventory).mock.calls[0]!;
    expect(resource).toBe("inventory");
    expect(input).toEqual({
      id: "product-1",
      mode: "delta",
      delta: -4,
      expectedStock: 12,
      expectedVersion: 3,
      reason: "盘点修正"
    });
    expect(Object.keys(input)).toEqual(["id", "mode", "delta", "expectedStock", "expectedVersion", "reason"]);
    expect(options.expectedVersion).toBe(3);
    expect(options.idempotencyKey).toMatch(/^inventory:adjust:/);
    expect(wrapper.emitted("saved")?.[0]).toEqual(["库存已从 12 调整为 8"]);
  });

  it("clears stale field errors as the operator corrects each input", async () => {
    const wrapper = await mountDialog();
    await setDelta(wrapper, -1);
    await wrapper.get("form").trigger("submit");
    await nextTick();
    expect(wrapper.findAllComponents(ElFormItem)[1]?.props("error")).toBe("请填写本次库存调整原因");

    const reasonInput = wrapper.findAllComponents(ElInput).find((input) => input.props("type") === "textarea");
    expect(reasonInput).toBeDefined();
    await setReason(wrapper, "盘点修正");
    await reasonInput!.vm.$emit("input", "盘点修正");
    await nextTick();
    expect(wrapper.findAllComponents(ElFormItem)[1]?.props("error")).toBe("");
  });

  it("rejects zero delta, negative resulting stock, and an empty reason inline", async () => {
    const wrapper = await mountDialog();
    await setDelta(wrapper, 0);
    await wrapper.get("form").trigger("submit");
    await nextTick();
    const formItems = wrapper.findAllComponents(ElFormItem);
    expect(formItems[0]?.props("error")).toContain("请输入非零整数");
    expect(formItems[1]?.props("error")).toBe("请填写本次库存调整原因");
    expect(transport.adjustInventory).not.toHaveBeenCalled();

    await setDelta(wrapper, -13);
    await setReason(wrapper, "报损");
    await wrapper.get("form").trigger("submit");
    await nextTick();
    expect(wrapper.findAllComponents(ElFormItem)[0]?.props("error")).toContain("调整后库存必须在 0 到 9999999 之间");
    expect(transport.adjustInventory).not.toHaveBeenCalled();
  });

  it("refreshes after a conflict, preserves the draft, rotates the key, and never auto-submits", async () => {
    vi.mocked(transport.getInventorySnapshot)
      .mockResolvedValueOnce(structuredClone(initial))
      .mockResolvedValueOnce({ ...structuredClone(initial), stock: 10, version: 4 });
    vi.mocked(transport.adjustInventory)
      .mockRejectedValueOnce(new ApiError("库存冲突", "DATA_VERSION_CONFLICT", 409))
      .mockResolvedValueOnce({ item: { ...adjusted, stock: 6, version: 5 }, affected: 1, message: "库存已调整" });
    const wrapper = await mountDialog();
    await setDelta(wrapper, -4);
    await setReason(wrapper, "盘点修正");
    await submit(wrapper);
    await flushPromises();

    expect(transport.adjustInventory).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("已保留调整数量和原因");
    expect(wrapper.get('[data-testid="inventory-after-stock"]').text()).toBe("10 → 6");
    const firstKey = vi.mocked(transport.adjustInventory).mock.calls[0]![2].idempotencyKey;

    await submit(wrapper);
    await flushPromises();
    expect(transport.adjustInventory).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(transport.adjustInventory).mock.calls[1]!;
    expect(secondCall[1]).toMatchObject({ delta: -4, reason: "盘点修正", expectedStock: 10, expectedVersion: 4 });
    expect(secondCall[2].idempotencyKey).not.toBe(firstKey);
  });

  it("keeps the same idempotency key for a network retry with unchanged input", async () => {
    vi.mocked(transport.adjustInventory)
      .mockRejectedValueOnce(new ApiError("网络异常", "NETWORK_ERROR"))
      .mockResolvedValueOnce({ item: adjusted, affected: 1, message: "库存已调整" });
    const wrapper = await mountDialog();
    await setDelta(wrapper, -4);
    await setReason(wrapper, "盘点修正");
    await submit(wrapper);
    await flushPromises();
    const firstKey = vi.mocked(transport.adjustInventory).mock.calls[0]![2].idempotencyKey;

    await submit(wrapper);
    await flushPromises();
    expect(vi.mocked(transport.adjustInventory).mock.calls[1]![2].idempotencyKey).toBe(firstKey);
  });
});
