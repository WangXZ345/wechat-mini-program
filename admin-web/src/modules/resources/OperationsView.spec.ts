import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { ElButton, ElCheckbox, ElDialog, ElInput, ElInputNumber, ElRadioGroup, ElSelect } from "element-plus";
import { nextTick } from "vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resourceDefinitions, statusLabels } from "@/config/resources";
import { ApiError } from "@/services/http/api-error";
import InventoryAdjustDialog from "@/modules/inventory/InventoryAdjustDialog.vue";
import OperationsView from "./OperationsView.vue";

const transportMock = vi.hoisted(() => ({
  mode: "http" as "http" | "mock",
  list: vi.fn(),
  mutate: vi.fn(),
  getProductDetail: vi.fn(),
  createProduct: vi.fn(),
  editProduct: vi.fn(),
  getInventorySnapshot: vi.fn(),
  adjustInventory: vi.fn()
}));
const routeMock = vi.hoisted(() => ({ meta: { resource: "inventory" } }));
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const authMock = vi.hoisted(() => ({ can: vi.fn() }));
const messageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock("@/services/transport", () => ({ transport: transportMock }));
vi.mock("vue-router", () => ({ useRoute: () => routeMock, useRouter: () => routerMock }));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => authMock }));
vi.mock("@/stores/app", () => ({ useAppStore: () => ({ density: "compact" }) }));
vi.mock("element-plus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("element-plus")>();
  return { ...actual, ElMessage: messageMock };
});

type TestRow = Record<string, unknown> & { id: string; version: number };

const wrappers: VueWrapper[] = [];
const baseRow: TestRow = {
  id: "product-1",
  version: 0,
  sku: "SKU-001",
  name: "测试商品",
  stock: 12,
  warningThreshold: 0,
  status: "normal",
  lastChange: "测试入库",
  updatedAt: "2026-07-11T08:00:00.000Z"
};
const baseProductRow: TestRow = {
  id: "product-1",
  version: 3,
  sku: "SKU-001",
  name: "测试商品",
  brand: "测试品牌",
  salePriceCents: 6900,
  isActive: true,
  status: "active",
  tags: ["热销"],
  updatedAt: "2026-07-11T08:00:00.000Z"
};

it("exposes every supported order read status without enabling real write actions", () => {
  const orders = resourceDefinitions.orders!;
  const values = orders.statusOptions.map((option) => option.value);
  expect(values).toEqual([
    "",
    "pending_system",
    "auto_reviewing",
    "pending_admin",
    "approved_pending_payment",
    "pending_payment_confirm",
    "paid",
    "unpaid",
    "partial_paid",
    "abnormal",
    "rejected",
    "cancelled"
  ]);
  expect(values.filter(Boolean).every((status) => statusLabels[status] && statusLabels[status] !== status)).toBe(true);
  expect(orders.rowActions.filter((action) => ["review", "reject"].includes(action.key)).every((action) => action.realEnabled === true)).toBe(true);
  expect(orders.rowActions.find((action) => action.key === "remark")?.realEnabled).not.toBe(true);
  expect(orders.bulkActions.every((action) => action.realEnabled !== true)).toBe(true);
});

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  routeMock.meta.resource = "inventory";
  transportMock.mode = "http";
  authMock.can.mockImplementation((permission?: string) => !permission || [
    "inventory:view",
    "inventory:update",
    "inventory:view_log",
    "inventory:set_warning"
  ].includes(permission));
  transportMock.list.mockResolvedValue({ items: [{ ...baseRow }], total: 1, page: 1, pageSize: 20, nextCursor: null });
  transportMock.mutate.mockResolvedValue({ affected: 1, message: "预警值已更新" });
  transportMock.getInventorySnapshot.mockResolvedValue({
    id: "product-1",
    stock: 12,
    warningThreshold: 0,
    status: "normal",
    isActive: true,
    version: 0,
    updatedAt: "2026-07-11T08:00:00.000Z"
  });
  transportMock.adjustInventory.mockResolvedValue({
    item: {
      id: "product-1",
      stock: 17,
      warningThreshold: 0,
      status: "normal",
      isActive: true,
      version: 1,
      updatedAt: "2026-07-11T08:01:00.000Z"
    },
    affected: 1,
    message: "库存已从 12 调整为 17"
  });
  transportMock.getProductDetail.mockResolvedValue({
    id: "product-1",
    version: 3,
    metadata: {
      name: "测试商品",
      baseName: "测试商品",
      imageUrl: "",
      specification: "",
      productionDate: "",
      description: "",
      productIndex: "P000001",
      skuCode: "SKU-001",
      keywords: []
    },
    initial: { salePriceCents: 6900, stock: 12, warningThreshold: 0, isActive: true, tags: ["热销"] },
    updatedAt: "2026-07-11T08:00:00.000Z"
  });
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = "";
});

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(OperationsView, {
    attachTo: document.body,
    global: { directives: { loading: () => undefined } }
  });
  wrappers.push(wrapper);
  await flushPromises();
  await nextTick();
  return wrapper;
}

function actionButton(wrapper: VueWrapper, scope: "primary" | "row" | "bulk", action: string) {
  return wrapper.get(`[data-action-scope="${scope}"][data-action-key="${action}"]`);
}

async function openWarningDialog(wrapper: VueWrapper): Promise<void> {
  await actionButton(wrapper, "row", "set-warning").trigger("click");
  await nextTick();
}

async function openPriceDialog(wrapper: VueWrapper): Promise<void> {
  await actionButton(wrapper, "row", "change-price").trigger("click");
  await nextTick();
}

async function openStatusDialog(wrapper: VueWrapper): Promise<void> {
  await actionButton(wrapper, "row", "toggle-status").trigger("click");
  await nextTick();
}

async function setProductTagForm(wrapper: VueWrapper, tag: string, present: boolean): Promise<void> {
  const tagSelect = wrapper.findAllComponents(ElSelect).find((component) => component.attributes("data-testid") === "product-tag-select");
  if (!tagSelect) throw new Error("Product tag select not found");
  tagSelect.vm.$emit("update:modelValue", tag);
  const presentControl = wrapper.findComponent(ElRadioGroup);
  presentControl.vm.$emit("update:modelValue", present);
  await nextTick();
}

async function setWarningValue(wrapper: VueWrapper, value: number | null): Promise<void> {
  const input = wrapper.findComponent(ElInputNumber);
  input.vm.$emit("update:modelValue", value);
  await nextTick();
}

async function setPriceValue(wrapper: VueWrapper, value: number | null): Promise<void> {
  const input = wrapper.findComponent(ElInputNumber);
  input.vm.$emit("update:modelValue", value);
  await nextTick();
}

async function setReason(wrapper: VueWrapper, value: string): Promise<void> {
  const input = wrapper.findAllComponents(ElInput).find((candidate) => candidate.props("type") === "textarea");
  if (!input) throw new Error("Reason input not found");
  input.vm.$emit("update:modelValue", value);
  await nextTick();
}

async function selectRows(wrapper: VueWrapper, rows: TestRow[]): Promise<void> {
  wrapper.findComponent({ name: "ElTable" }).vm.$emit("selection-change", rows);
  await nextTick();
}

async function confirm(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-testid="action-confirm"]').trigger("click");
  await flushPromises();
  await nextTick();
}

function configureProductPage(row: TestRow = baseProductRow): void {
  routeMock.meta.resource = "products";
  authMock.can.mockImplementation((permission?: string) => !permission || [
    "product:view",
    "product:create",
    "product:update",
    "product:update_price",
    "product:update_status",
    "product:tag:batch_update"
  ].includes(permission));
  transportMock.list.mockResolvedValue({ items: [{ ...row }], total: 1, page: 1, pageSize: 20, nextCursor: null });
  transportMock.mutate.mockResolvedValue({ affected: 1, message: "商品售价已更新" });
}

describe("OperationsView real product actions", () => {
  it("enables only the migrated product actions in real mode", async () => {
    configureProductPage();
    const wrapper = await mountPage();

    expect(actionButton(wrapper, "row", "change-price").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "row", "toggle-status").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "row", "toggle-status").text()).toBe("下架");
    expect(actionButton(wrapper, "primary", "create").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "row", "edit").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "bulk", "batch-enable").attributes("disabled")).toBeDefined();
    await selectRows(wrapper, [{ ...baseProductRow }]);
    expect(actionButton(wrapper, "bulk", "batch-enable").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "bulk", "batch-tags").attributes("disabled")).toBeUndefined();
    expect(wrapper.text()).not.toContain("部分写操作尚未开放");
  });

  it("renders the primary create action disabled when product:create is missing", async () => {
    configureProductPage();
    authMock.can.mockImplementation((permission?: string) => !permission || [
      "product:view",
      "product:update",
      "product:update_price",
      "product:update_status",
      "product:tag:batch_update"
    ].includes(permission));
    const wrapper = await mountPage();

    const create = actionButton(wrapper, "primary", "create");
    expect(create.attributes("disabled")).toBeDefined();
    await create.trigger("click");
    expect(wrapper.findComponent({ name: "ProductEditorDialog" }).props("modelValue")).toBe(false);
  });

  it("submits the exact public-tag snapshots and handles a safe partial result", async () => {
    const selectedRows = [
      { ...baseProductRow, id: "product-1", version: 3, tags: ["热销"] },
      { ...baseProductRow, id: "product-2", version: 7, tags: [] }
    ];
    configureProductPage();
    transportMock.list.mockResolvedValue({ items: selectedRows, total: 2, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate.mockResolvedValue({
      affected: 1,
      changedCount: 1,
      unchangedCount: 0,
      failedCount: 1,
      failures: [{ id: "product-2", code: "DATA_VERSION_CONFLICT" }],
      message: "已更新 1 个商品，1 个未处理",
      requestId: "request-tags-1"
    });
    const wrapper = await mountPage();
    await selectRows(wrapper, selectedRows);
    await actionButton(wrapper, "bulk", "batch-tags").trigger("click");
    await nextTick();
    await setProductTagForm(wrapper, "热销", false);
    await setReason(wrapper, "季度标签复核");
    await confirm(wrapper);

    expect(transportMock.mutate).toHaveBeenCalledTimes(1);
    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("products");
    expect(action).toBe("batch-tags");
    expect(payload).toEqual({
      scope: "public",
      tag: "热销",
      present: false,
      items: [
        { id: "product-1", expectedVersion: 3, expectedPresent: true },
        { id: "product-2", expectedVersion: 7, expectedPresent: false }
      ],
      reason: "季度标签复核"
    });
    expect(Object.keys(payload)).toEqual(["scope", "tag", "present", "items", "reason"]);
    expect(options.expectedVersion).toBeUndefined();
    expect(options.idempotencyKey).toMatch(/^products:batch-tags:/);
    expect(messageMock.warning).toHaveBeenCalledWith("已更新 1 个商品，1 个未处理");
    expect(messageMock.success).not.toHaveBeenCalled();
    expect(transportMock.list).toHaveBeenCalledTimes(2);
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
  });

  it.each([
    ["缺少版本", { ...baseProductRow, version: undefined }],
    ["标签不是数组", { ...baseProductRow, tags: "热销" }],
    ["包含非法公开标签", { ...baseProductRow, tags: ["推荐"] }]
  ])("blocks batch tags when a selected row %s", async (_label, invalidRow) => {
    configureProductPage(invalidRow as TestRow);
    const wrapper = await mountPage();
    await selectRows(wrapper, [invalidRow as TestRow]);
    await actionButton(wrapper, "bulk", "batch-tags").trigger("click");
    await nextTick();

    expect(messageMock.error).toHaveBeenCalledWith("所选商品的标签或版本数据异常，请刷新后重试");
    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
  });

  it("keeps batch tags disabled without product:tag:batch_update", async () => {
    configureProductPage();
    authMock.can.mockImplementation((permission?: string) => !permission || [
      "product:view",
      "product:update_price",
      "product:update_status"
    ].includes(permission));
    const wrapper = await mountPage();
    await selectRows(wrapper, [{ ...baseProductRow }]);

    expect(actionButton(wrapper, "bulk", "batch-tags").attributes("disabled")).toBeDefined();
  });

  it("blocks more than 100 selected product tag snapshots", async () => {
    configureProductPage();
    const selectedRows = Array.from({ length: 101 }, (_, index) => ({
      ...baseProductRow,
      id: `product-${index + 1}`,
      version: index
    }));
    const wrapper = await mountPage();
    await selectRows(wrapper, selectedRows);
    await actionButton(wrapper, "bulk", "batch-tags").trigger("click");
    await nextTick();

    expect(messageMock.error).toHaveBeenCalledWith("所选商品的标签或版本数据异常，请刷新后重试");
    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
  });

  it("keeps the idempotency key for the same retry and rotates it after the tag target changes", async () => {
    configureProductPage();
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("网络连接失败", "NETWORK_ERROR"))
      .mockRejectedValueOnce(new ApiError("网络连接失败", "NETWORK_ERROR"))
      .mockResolvedValue({
        affected: 1,
        changedCount: 1,
        unchangedCount: 0,
        failedCount: 0,
        failures: [],
        message: "已更新 1 个商品",
        requestId: "request-tags-retry"
      });
    const wrapper = await mountPage();
    await selectRows(wrapper, [{ ...baseProductRow }]);
    await actionButton(wrapper, "bulk", "batch-tags").trigger("click");
    await nextTick();
    await confirm(wrapper);
    const firstOptions = transportMock.mutate.mock.calls[0]![3];

    await confirm(wrapper);
    const sameRetryOptions = transportMock.mutate.mock.calls[1]![3];
    expect(sameRetryOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);

    await setProductTagForm(wrapper, "热销", false);
    await confirm(wrapper);
    const changedOptions = transportMock.mutate.mock.calls[2]![3];
    expect(changedOptions.idempotencyKey).not.toBe(firstOptions.idempotencyKey);
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
  });

  it("rejects an inconsistent batch-tag response without closing the operation", async () => {
    configureProductPage();
    transportMock.mutate.mockResolvedValue({
      affected: 1,
      changedCount: 0,
      unchangedCount: 1,
      failedCount: 0,
      failures: [],
      message: "不一致结果",
      requestId: "request-tags-invalid"
    });
    const wrapper = await mountPage();
    await selectRows(wrapper, [{ ...baseProductRow }]);
    await actionButton(wrapper, "bulk", "batch-tags").trigger("click");
    await nextTick();
    await confirm(wrapper);

    expect(messageMock.error).toHaveBeenCalledWith("批量标签结果无效，请刷新后重试");
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
    expect(transportMock.list).toHaveBeenCalledTimes(1);
  });

  it("submits strict product snapshots and warns when batch enable is partially successful", async () => {
    const selectedRows = [
      { ...baseProductRow, id: "product-1", version: 3, isActive: false, status: "inactive" },
      { ...baseProductRow, id: "product-2", version: 7, isActive: true, status: "active" }
    ];
    configureProductPage();
    transportMock.list.mockResolvedValue({ items: selectedRows, total: 2, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate.mockResolvedValue({
      affected: 1,
      changedCount: 1,
      unchangedCount: 0,
      failedCount: 1,
      failures: [{ id: "product-2", code: "DATA_VERSION_CONFLICT" }],
      message: "批量上架完成，成功 1 项，失败 1 项"
    });
    const wrapper = await mountPage();
    await selectRows(wrapper, selectedRows);
    await actionButton(wrapper, "bulk", "batch-enable").trigger("click");
    await nextTick();
    await setReason(wrapper, "批量恢复销售");
    await confirm(wrapper);

    expect(transportMock.mutate).toHaveBeenCalledTimes(1);
    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("products");
    expect(action).toBe("batch-enable");
    expect(payload).toEqual({
      isActive: true,
      items: [
        { id: "product-1", expectedIsActive: false, expectedVersion: 3 },
        { id: "product-2", expectedIsActive: true, expectedVersion: 7 }
      ],
      reason: "批量恢复销售"
    });
    expect(Object.keys(payload)).toEqual(["isActive", "items", "reason"]);
    expect(options.expectedVersion).toBeUndefined();
    expect(options.idempotencyKey).toMatch(/^products:batch-enable:/);
    expect(messageMock.warning).toHaveBeenCalledWith("批量上架完成，成功 1 项，失败 1 项");
    expect(messageMock.success).not.toHaveBeenCalled();
    expect(transportMock.list).toHaveBeenCalledTimes(2);
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
  });

  it("blocks batch enable when any selected product snapshot is invalid", async () => {
    const invalidRow = { ...baseProductRow, id: "product-invalid", version: -1, isActive: false };
    configureProductPage(invalidRow);
    const wrapper = await mountPage();
    await selectRows(wrapper, [invalidRow]);
    await actionButton(wrapper, "bulk", "batch-enable").trigger("click");
    await nextTick();
    await confirm(wrapper);

    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(messageMock.error).toHaveBeenCalledWith("所选商品的状态或版本异常，请刷新后重试");
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
  });

  it("submits an explicit product status target and current-state guard", async () => {
    configureProductPage();
    transportMock.mutate.mockResolvedValue({ affected: 1, message: "商品已下架" });
    const wrapper = await mountPage();
    await openStatusDialog(wrapper);

    expect(wrapper.findComponent(ElDialog).props("title")).toBe("下架商品");
    expect(wrapper.get('[data-testid="status-change"]').text()).toContain("上架 → 下架");
    expect(wrapper.get('[data-testid="action-confirm"]').text()).toBe("确认下架");
    await setReason(wrapper, "运营下架");
    await confirm(wrapper);

    expect(transportMock.mutate).toHaveBeenCalledTimes(1);
    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("products");
    expect(action).toBe("toggle-status");
    expect(payload).toEqual({
      id: "product-1",
      isActive: false,
      expectedIsActive: true,
      reason: "运营下架"
    });
    expect(Object.keys(payload)).toEqual(["id", "isActive", "expectedIsActive", "reason"]);
    expect(options.expectedVersion).toBe(3);
    expect(options.idempotencyKey).toMatch(/^products:toggle-status:/);
    expect(messageMock.success).toHaveBeenCalledWith("商品已下架");
  });

  it("shows and submits an explicit enable target for an inactive product", async () => {
    configureProductPage({ ...baseProductRow, isActive: false, status: "inactive" });
    transportMock.mutate.mockResolvedValue({ affected: 1, message: "商品已上架" });
    const wrapper = await mountPage();

    expect(actionButton(wrapper, "row", "toggle-status").text()).toBe("上架");
    await openStatusDialog(wrapper);
    expect(wrapper.findComponent(ElDialog).props("title")).toBe("上架商品");
    expect(wrapper.get('[data-testid="action-confirm"]').text()).toBe("确认上架");
    await confirm(wrapper);

    expect(transportMock.mutate.mock.calls[0]![2]).toEqual({
      id: "product-1",
      isActive: true,
      expectedIsActive: false,
      reason: ""
    });
  });

  it("keeps the original status target after a conflict refresh", async () => {
    configureProductPage();
    transportMock.list
      .mockResolvedValueOnce({ items: [{ ...baseProductRow }], total: 1, page: 1, pageSize: 20, nextCursor: null })
      .mockResolvedValue({ items: [{ ...baseProductRow, version: 4, isActive: false, status: "inactive" }], total: 1, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("状态冲突", "DATA_VERSION_CONFLICT", 409))
      .mockResolvedValueOnce({ affected: 0, message: "商品已处于下架状态" });
    const wrapper = await mountPage();
    await openStatusDialog(wrapper);
    await confirm(wrapper);

    const firstOptions = transportMock.mutate.mock.calls[0]![3];
    expect(transportMock.mutate.mock.calls[0]![2]).toEqual({
      id: "product-1",
      isActive: false,
      expectedIsActive: true,
      reason: ""
    });
    expect(wrapper.get('[data-testid="status-change"]').text()).toContain("下架 → 下架");
    expect(wrapper.get('[data-testid="action-confirm"]').text()).toBe("确认下架");
    expect(messageMock.error).toHaveBeenCalledWith("记录已变化，已刷新最新状态，请重新确认下架");

    await confirm(wrapper);
    const retryPayload = transportMock.mutate.mock.calls[1]![2];
    const retryOptions = transportMock.mutate.mock.calls[1]![3];
    expect(retryPayload).toEqual({ id: "product-1", isActive: false, expectedIsActive: false, reason: "" });
    expect(retryOptions.expectedVersion).toBe(4);
    expect(retryOptions.idempotencyKey).not.toBe(firstOptions.idempotencyKey);
  });

  it("reuses the status idempotency key after a non-conflict failure", async () => {
    configureProductPage();
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("网络连接失败", "NETWORK_ERROR"))
      .mockResolvedValueOnce({ affected: 1, message: "商品已下架" });
    const wrapper = await mountPage();
    await openStatusDialog(wrapper);
    await confirm(wrapper);

    const firstPayload = transportMock.mutate.mock.calls[0]![2];
    const firstOptions = transportMock.mutate.mock.calls[0]![3];
    await confirm(wrapper);
    expect(transportMock.mutate.mock.calls[1]![2]).toEqual(firstPayload);
    expect(transportMock.mutate.mock.calls[1]![3].idempotencyKey).toBe(firstOptions.idempotencyKey);
  });

  it("rotates the status idempotency key when the payload changes after a failure", async () => {
    configureProductPage();
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("网络连接失败", "NETWORK_ERROR"))
      .mockResolvedValueOnce({ affected: 1, message: "商品已下架" });
    const wrapper = await mountPage();
    await openStatusDialog(wrapper);
    await confirm(wrapper);

    const firstOptions = transportMock.mutate.mock.calls[0]![3];
    await setReason(wrapper, "失败后补充说明");
    await confirm(wrapper);

    expect(transportMock.mutate.mock.calls[1]![2]).toEqual({
      id: "product-1",
      isActive: false,
      expectedIsActive: true,
      reason: "失败后补充说明"
    });
    expect(transportMock.mutate.mock.calls[1]![3].idempotencyKey).not.toBe(firstOptions.idempotencyKey);
  });

  it("does not open the status dialog when the authoritative boolean is missing", async () => {
    configureProductPage({ ...baseProductRow, isActive: undefined });
    const wrapper = await mountPage();
    await openStatusDialog(wrapper);

    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(messageMock.error).toHaveBeenCalledWith("当前商品状态异常，请刷新后重试");
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
  });

  it("keeps change-price disabled without product:update_price", async () => {
    configureProductPage();
    authMock.can.mockImplementation((permission?: string) => !permission || permission === "product:view");
    const wrapper = await mountPage();

    expect(actionButton(wrapper, "row", "change-price").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("当前角色为只读访问");
  });

  it("shows the current price and submits the exact integer-cents contract", async () => {
    configureProductPage();
    const wrapper = await mountPage();
    await openPriceDialog(wrapper);

    expect(wrapper.get('[data-testid="current-price"]').text()).toContain("69.00");
    expect(wrapper.text()).toContain("新售价（元）");
    expect(wrapper.findComponent(ElInputNumber).props("modelValue")).toBe(69);
    await setPriceValue(wrapper, 71.25);
    await setReason(wrapper, "季度改价");
    await confirm(wrapper);

    expect(transportMock.mutate).toHaveBeenCalledTimes(1);
    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("products");
    expect(action).toBe("change-price");
    expect(payload).toEqual({
      id: "product-1",
      newPriceCents: 7125,
      expectedPriceCents: 6900,
      reason: "季度改价"
    });
    expect(Object.keys(payload)).toEqual(["id", "newPriceCents", "expectedPriceCents", "reason"]);
    expect(options.expectedVersion).toBe(3);
    expect(options.idempotencyKey).toMatch(/^products:change-price:/);
    expect(messageMock.success).toHaveBeenCalledWith("商品售价已更新");
    expect(transportMock.list).toHaveBeenCalledTimes(2);
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
  });

  it.each([
    ["空值", null],
    ["超过两位小数", 1.234],
    ["超出安全整数分", Number.MAX_SAFE_INTEGER]
  ])("rejects %s without sending a price mutation", async (_label, invalidValue) => {
    configureProductPage();
    const wrapper = await mountPage();
    await openPriceDialog(wrapper);
    await setPriceValue(wrapper, invalidValue as number | null);
    await confirm(wrapper);

    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(messageMock.warning).toHaveBeenCalledWith("新售价必须是非负金额，最多两位小数");
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
  });

  it("blocks submission when the current price projection is invalid", async () => {
    configureProductPage({ ...baseProductRow, salePriceCents: null });
    const wrapper = await mountPage();
    await openPriceDialog(wrapper);
    await setPriceValue(wrapper, 72.5);
    await confirm(wrapper);

    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(messageMock.error).toHaveBeenCalledWith("当前售价数据异常，请刷新后重试");
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
  });

  it("keeps the desired price and idempotency key after a non-conflict failure", async () => {
    configureProductPage();
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("网络连接失败", "NETWORK_ERROR"))
      .mockResolvedValueOnce({ affected: 1, message: "商品售价已更新" });
    const wrapper = await mountPage();
    await openPriceDialog(wrapper);
    await setPriceValue(wrapper, 72.5);
    await confirm(wrapper);

    const firstPayload = transportMock.mutate.mock.calls[0]![2];
    const firstOptions = transportMock.mutate.mock.calls[0]![3];
    expect(firstPayload).toEqual({ id: "product-1", newPriceCents: 7250, expectedPriceCents: 6900, reason: "" });
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
    expect(wrapper.findComponent(ElInputNumber).props("modelValue")).toBe(72.5);
    expect(transportMock.list).toHaveBeenCalledTimes(1);

    await confirm(wrapper);
    expect(transportMock.mutate.mock.calls[1]![2]).toEqual(firstPayload);
    expect(transportMock.mutate.mock.calls[1]![3].idempotencyKey).toBe(firstOptions.idempotencyKey);
    expect(transportMock.mutate.mock.calls[1]![3].expectedVersion).toBe(3);
  });

  it("creates a new idempotency key when the payload changes after a failure", async () => {
    configureProductPage();
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("网络连接失败", "NETWORK_ERROR"))
      .mockResolvedValueOnce({ affected: 1, message: "商品售价已更新" });
    const wrapper = await mountPage();
    await openPriceDialog(wrapper);
    await setPriceValue(wrapper, 72.5);
    await confirm(wrapper);

    const firstOptions = transportMock.mutate.mock.calls[0]![3];
    await setPriceValue(wrapper, 73);
    await setReason(wrapper, "失败后调整价格");
    await confirm(wrapper);

    const secondPayload = transportMock.mutate.mock.calls[1]![2];
    const secondOptions = transportMock.mutate.mock.calls[1]![3];
    expect(secondPayload).toEqual({
      id: "product-1",
      newPriceCents: 7300,
      expectedPriceCents: 6900,
      reason: "失败后调整价格"
    });
    expect(secondOptions.idempotencyKey).not.toBe(firstOptions.idempotencyKey);
    expect(secondOptions.expectedVersion).toBe(3);
  });

  it("refreshes version and current price, then requires confirmation with a new key after conflict", async () => {
    configureProductPage();
    transportMock.list
      .mockResolvedValueOnce({ items: [{ ...baseProductRow }], total: 1, page: 1, pageSize: 20, nextCursor: null })
      .mockResolvedValue({ items: [{ ...baseProductRow, version: 4, salePriceCents: 7100 }], total: 1, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("版本冲突", "DATA_VERSION_CONFLICT", 409))
      .mockResolvedValueOnce({ affected: 1, message: "商品售价已更新" });
    const wrapper = await mountPage();
    await openPriceDialog(wrapper);
    await setPriceValue(wrapper, 72.5);
    await confirm(wrapper);

    const firstOptions = transportMock.mutate.mock.calls[0]![3];
    expect(transportMock.mutate.mock.calls[0]![2]).toEqual({
      id: "product-1",
      newPriceCents: 7250,
      expectedPriceCents: 6900,
      reason: ""
    });
    expect(firstOptions.expectedVersion).toBe(3);
    expect(wrapper.get('[data-testid="current-price"]').text()).toContain("71.00");
    expect(wrapper.findComponent(ElInputNumber).props("modelValue")).toBe(72.5);
    expect(messageMock.error).toHaveBeenCalledWith("记录已变化，已刷新最新售价，请重新确认");
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);

    await confirm(wrapper);
    const retryPayload = transportMock.mutate.mock.calls[1]![2];
    const retryOptions = transportMock.mutate.mock.calls[1]![3];
    expect(retryPayload).toEqual({ id: "product-1", newPriceCents: 7250, expectedPriceCents: 7100, reason: "" });
    expect(retryOptions.expectedVersion).toBe(4);
    expect(retryOptions.idempotencyKey).not.toBe(firstOptions.idempotencyKey);
    expect(transportMock.list).toHaveBeenCalledTimes(3);
  });

  it("prevents closing the dialog while the price save is pending", async () => {
    configureProductPage();
    let resolveMutation!: (value: { affected: number; message: string }) => void;
    transportMock.mutate.mockImplementation(() => new Promise((resolve) => {
      resolveMutation = resolve;
    }));
    const wrapper = await mountPage();
    await openPriceDialog(wrapper);
    await setPriceValue(wrapper, 72.5);
    void wrapper.get('[data-testid="action-confirm"]').trigger("click");
    await nextTick();

    const dialog = wrapper.findComponent(ElDialog);
    expect(dialog.props("width")).toBe("min(480px, calc(100vw - 32px))");
    expect(dialog.props("closeOnClickModal")).toBe(false);
    expect(dialog.props("closeOnPressEscape")).toBe(false);
    expect(dialog.props("showClose")).toBe(false);
    expect(wrapper.findComponent(ElInputNumber).props("disabled")).toBe(true);
    const reasonInput = wrapper.findAllComponents(ElInput).find((input) => input.props("type") === "textarea");
    expect(reasonInput?.props("disabled")).toBe(true);
    const cancel = wrapper.findAllComponents(ElButton).find((button) => button.text() === "取消");
    expect(cancel?.props("disabled")).toBe(true);
    const done = vi.fn();
    const beforeClose = dialog.props("beforeClose");
    expect(beforeClose).toBeTypeOf("function");
    beforeClose?.(done);
    expect(done).not.toHaveBeenCalled();

    resolveMutation({ affected: 1, message: "商品售价已更新" });
    await flushPromises();
    await nextTick();
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
  });
});

describe("OperationsView real inventory warning action", () => {
  it("declares only the migrated real write capabilities", () => {
    const enabled = Object.values(resourceDefinitions).flatMap((definition) => [
      ...(definition.primaryAction ? [definition.primaryAction] : []),
      ...definition.rowActions,
      ...definition.bulkActions
    ].filter((action) => action.realEnabled).map((action) => `${definition.key}:${action.key}`));

    expect(enabled).toEqual(["products:create", "products:edit", "products:change-price", "products:toggle-status", "products:batch-enable", "products:batch-tags", "inventory:adjust", "inventory:set-warning", "inventory-alerts:set-warning", "inventory-alerts:adjust", "orders:review", "orders:reject", "payments:confirm", "payments:reject", "after-sales:approve", "after-sales:reject", "after-sales:receive", "after-sales:inspect", "refunds:process", "refunds:reject"]);
  });

  it("enables row adjustment and set-warning while keeping unsafe top-level and bulk actions disabled", async () => {
    const wrapper = await mountPage();

    expect(actionButton(wrapper, "row", "set-warning").attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-action-scope="primary"][data-action-key="adjust"]').exists()).toBe(false);
    expect(actionButton(wrapper, "row", "adjust").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "row", "view-log").attributes("disabled")).toBeDefined();
    expect(actionButton(wrapper, "bulk", "batch-warning").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("部分写操作尚未开放");
  });

  it("opens the dedicated row adjustment dialog with the selected product", async () => {
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "adjust").trigger("click");
    await flushPromises();

    const dialog = wrapper.getComponent(InventoryAdjustDialog);
    expect(dialog.props()).toMatchObject({
      modelValue: true,
      productId: "product-1",
      productName: "测试商品",
      sku: "SKU-001",
      resource: "inventory"
    });
    expect(transportMock.getInventorySnapshot).toHaveBeenCalledWith("product-1");
  });

  it("queues an inventory sync refresh while the adjustment dialog is open", async () => {
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "adjust").trigger("click");
    await flushPromises();
    window.dispatchEvent(new CustomEvent("admin-web:sync-events", {
      detail: { events: [{ entityType: "inventory" }] }
    }));
    await nextTick();
    expect(transportMock.list).toHaveBeenCalledTimes(1);

    wrapper.getComponent(InventoryAdjustDialog).vm.$emit("update:modelValue", false);
    await flushPromises();
    expect(transportMock.list).toHaveBeenCalledTimes(2);
  });

  it("keeps row adjustment disabled without inventory:update", async () => {
    authMock.can.mockImplementation((permission?: string) => !permission || ["inventory:view", "inventory:set_warning"].includes(permission));
    const wrapper = await mountPage();
    expect(actionButton(wrapper, "row", "adjust").attributes("disabled")).toBeDefined();
  });

  it("keeps set-warning disabled without inventory:set_warning", async () => {
    authMock.can.mockImplementation((permission?: string) => !permission || permission === "inventory:view");
    const wrapper = await mountPage();

    expect(actionButton(wrapper, "row", "set-warning").attributes("disabled")).toBeDefined();
  });

  it("uses the inventory-alerts resource for the alert-page action", async () => {
    routeMock.meta.resource = "inventory-alerts";
    const wrapper = await mountPage();
    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, 10);
    await confirm(wrapper);

    expect(transportMock.mutate).toHaveBeenCalledWith(
      "inventory-alerts",
      "set-warning",
      { id: "product-1", warningThreshold: 10, expectedWarningThreshold: 0, reason: "" },
      expect.objectContaining({ expectedVersion: 0 })
    );
    expect(actionButton(wrapper, "row", "adjust").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "bulk", "batch-warning").attributes("disabled")).toBeDefined();
  });

  it("reuses the dedicated adjustment dialog from an inventory alert row", async () => {
    routeMock.meta.resource = "inventory-alerts";
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "adjust").trigger("click");
    await flushPromises();

    expect(wrapper.getComponent(InventoryAdjustDialog).props()).toMatchObject({
      modelValue: true,
      productId: "product-1",
      resource: "inventory-alerts"
    });
  });

  it("submits the exact payload, preserves version zero, accepts zero, closes, and refreshes once", async () => {
    const wrapper = await mountPage();
    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, 0);
    await setReason(wrapper, "季度阈值复核");
    await confirm(wrapper);

    expect(transportMock.mutate).toHaveBeenCalledTimes(1);
    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("inventory");
    expect(action).toBe("set-warning");
    expect(payload).toEqual({
      id: "product-1",
      warningThreshold: 0,
      expectedWarningThreshold: 0,
      reason: "季度阈值复核"
    });
    expect(Object.keys(payload)).toEqual(["id", "warningThreshold", "expectedWarningThreshold", "reason"]);
    expect(options.expectedVersion).toBe(0);
    expect(options.idempotencyKey).toMatch(/^inventory:set-warning:/);
    expect(messageMock.success).toHaveBeenCalledWith("预警值已更新");
    expect(transportMock.list).toHaveBeenCalledTimes(2);
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
  });

  it("consumes a queued sync event with the single success refresh", async () => {
    const wrapper = await mountPage();
    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, 4);
    window.dispatchEvent(new CustomEvent("admin-web:sync-events", {
      detail: { events: [{ entityType: "inventory" }] }
    }));
    await nextTick();

    expect(transportMock.list).toHaveBeenCalledTimes(1);
    await confirm(wrapper);
    expect(transportMock.list).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["空值", null],
    ["负数", -1],
    ["小数", 1.5],
    ["超限", 100_000],
    ["非安全整数", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects %s warning threshold without calling mutate", async (_label, invalidValue) => {
    const wrapper = await mountPage();
    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, invalidValue as number | null);
    await confirm(wrapper);

    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(messageMock.warning).toHaveBeenCalledWith("预警值必须是 0 到 99999 的整数");
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
  });

  it.each([
    ["空值", null],
    ["负数", -1],
    ["小数", 1.5],
    ["超限", 100_000],
    ["非安全整数", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects an invalid current %s warning threshold before mutating", async (_label, invalidValue) => {
    transportMock.list.mockResolvedValue({
      items: [{ ...baseRow, warningThreshold: invalidValue }],
      total: 1,
      page: 1,
      pageSize: 20,
      nextCursor: null
    });
    const wrapper = await mountPage();
    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, 6);
    await confirm(wrapper);

    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(messageMock.error).toHaveBeenCalledWith("当前预警值数据异常，请刷新后重试");
    expect(messageMock.warning).not.toHaveBeenCalled();
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
    expect(wrapper.findComponent(ElInputNumber).props("modelValue")).toBe(6);
  });

  it("reuses the idempotency key after failure and creates a new key for a newly opened dialog", async () => {
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("网络连接失败", "NETWORK_ERROR"))
      .mockResolvedValue({ affected: 1, message: "预警值已更新" });
    const wrapper = await mountPage();
    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, 8);
    await confirm(wrapper);

    const [, , firstPayload, firstOptions] = transportMock.mutate.mock.calls[0]!;
    const firstKey = firstOptions.idempotencyKey;
    expect(firstPayload).toEqual({
      id: "product-1",
      warningThreshold: 8,
      expectedWarningThreshold: 0,
      reason: ""
    });
    expect(firstOptions.expectedVersion).toBe(0);
    expect(transportMock.list).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
    expect(wrapper.findComponent(ElInputNumber).props("modelValue")).toBe(8);
    expect(messageMock.success).not.toHaveBeenCalled();
    await confirm(wrapper);
    const [, , retryPayload, retryOptions] = transportMock.mutate.mock.calls[1]!;
    expect(retryPayload).toEqual(firstPayload);
    expect(retryOptions.idempotencyKey).toBe(firstKey);
    expect(retryOptions.expectedVersion).toBe(0);

    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, 9);
    await confirm(wrapper);
    const nextOperationKey = transportMock.mutate.mock.calls[2]![3].idempotencyKey;
    expect(nextOperationKey).not.toBe(firstKey);
  });

  it("uses a new idempotency key and refreshed version after a version conflict", async () => {
    transportMock.list
      .mockResolvedValueOnce({ items: [{ ...baseRow }], total: 1, page: 1, pageSize: 20, nextCursor: null })
      .mockResolvedValue({ items: [{ ...baseRow, version: 1, warningThreshold: 3 }], total: 1, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("版本冲突", "DATA_VERSION_CONFLICT", 409))
      .mockResolvedValueOnce({ affected: 1, message: "预警值已更新" });
    const wrapper = await mountPage();
    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, 6);
    await confirm(wrapper);

    const [, , firstPayload, firstOptions] = transportMock.mutate.mock.calls[0]!;
    expect(firstPayload).toEqual({
      id: "product-1",
      warningThreshold: 6,
      expectedWarningThreshold: 0,
      reason: ""
    });
    expect(firstOptions.expectedVersion).toBe(0);
    expect(transportMock.list).toHaveBeenCalledTimes(2);
    expect(messageMock.error).toHaveBeenCalledWith("记录已变化，已刷新最新数据，请重新确认");
    expect(messageMock.success).not.toHaveBeenCalled();
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
    expect(wrapper.findComponent(ElInputNumber).props("modelValue")).toBe(6);

    await confirm(wrapper);
    const [, , retryPayload, retryOptions] = transportMock.mutate.mock.calls[1]!;
    expect(retryPayload).toEqual({
      id: "product-1",
      warningThreshold: 6,
      expectedWarningThreshold: 3,
      reason: ""
    });
    expect(retryOptions.expectedVersion).toBe(1);
    expect(retryOptions.idempotencyKey).not.toBe(firstOptions.idempotencyKey);
    expect(messageMock.success).toHaveBeenCalledTimes(1);
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
    expect(transportMock.list).toHaveBeenCalledTimes(3);
  });

  it("blocks retry when a conflict refresh returns an invalid warning threshold", async () => {
    transportMock.list
      .mockResolvedValueOnce({ items: [{ ...baseRow }], total: 1, page: 1, pageSize: 20, nextCursor: null })
      .mockResolvedValue({ items: [{ ...baseRow, version: 1, warningThreshold: null }], total: 1, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate.mockRejectedValueOnce(new ApiError("版本冲突", "DATA_VERSION_CONFLICT", 409));
    const wrapper = await mountPage();
    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, 6);
    await confirm(wrapper);

    expect(transportMock.mutate).toHaveBeenCalledTimes(1);
    expect(transportMock.list).toHaveBeenCalledTimes(2);
    expect(messageMock.error).toHaveBeenCalledWith("记录已变化，但最新预警值数据异常，暂不能修改");
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
    expect(wrapper.findComponent(ElInputNumber).props("modelValue")).toBe(6);

    await confirm(wrapper);
    expect(transportMock.mutate).toHaveBeenCalledTimes(1);
    expect(transportMock.list).toHaveBeenCalledTimes(2);
    expect(messageMock.error).toHaveBeenLastCalledWith("当前预警值数据异常，请刷新后重试");
  });

  it.each([
    ["IDEMPOTENCY_PROCESSING", "操作正在处理中，请稍候"],
    ["IDEMPOTENCY_KEY_CONFLICT", "请求已被用于其他操作，请刷新后重试"],
    ["DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改"]
  ])("keeps the current request context for %s", async (code, message) => {
    transportMock.mutate.mockRejectedValue(new ApiError(message, code, 409));
    const wrapper = await mountPage();
    await openWarningDialog(wrapper);
    await setWarningValue(wrapper, 6);
    await confirm(wrapper);

    const [, , firstPayload, firstOptions] = transportMock.mutate.mock.calls[0]!;
    expect(firstPayload).toEqual({
      id: "product-1",
      warningThreshold: 6,
      expectedWarningThreshold: 0,
      reason: ""
    });
    expect(firstOptions.expectedVersion).toBe(0);
    expect(transportMock.list).toHaveBeenCalledTimes(1);
    expect(messageMock.error).toHaveBeenCalledWith(message);
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
    expect(wrapper.findComponent(ElInputNumber).props("modelValue")).toBe(6);

    await confirm(wrapper);
    const [, , retryPayload, retryOptions] = transportMock.mutate.mock.calls[1]!;
    expect(retryPayload).toEqual(firstPayload);
    expect(retryOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
    expect(retryOptions.expectedVersion).toBe(0);
    expect(transportMock.list).toHaveBeenCalledTimes(1);
    expect(messageMock.success).not.toHaveBeenCalled();
  });
});

describe("OperationsView real payment review", () => {
  const pendingPayment: TestRow = {
    id: "pay-001",
    version: 2,
    orderNo: "ORDER-1",
    customerMasked: "张* / 138****1201",
    amountCents: 32000,
    proofLabel: "已提交凭证",
    proofCount: 1,
    status: "pending_confirm",
    submittedAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-13T08:05:00.000Z"
  };

  function configurePaymentPage(row: TestRow = pendingPayment): void {
    routeMock.meta.resource = "payments";
    authMock.can.mockImplementation((permission?: string) => !permission || [
      "payment:view_screenshot",
      "payment:confirm",
      "payment:update_status"
    ].includes(permission));
    transportMock.list.mockResolvedValue({ items: [{ ...row }], total: 1, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate.mockResolvedValue({
      item: { id: row.id, orderNo: row.orderNo, status: "paid", version: row.version + 1, updatedAt: "2026-07-13T08:06:00.000Z" },
      affected: 1,
      reused: false,
      decision: "confirm",
      accountRecalculationPending: false,
      message: "付款已确认",
      requestId: "request-1"
    });
  }

  it("enables only current pending snapshots with the matching permission", async () => {
    configurePaymentPage();
    const wrapper = await mountPage();

    expect(resourceDefinitions.payments?.rowActions.every((action) => action.realEnabled === true)).toBe(true);
    expect(actionButton(wrapper, "row", "confirm").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "row", "reject").attributes("disabled")).toBeUndefined();
  });

  it.each([
    ["payment:update_status", "confirm", "reject"],
    ["payment:confirm", "reject", "confirm"]
  ])("enables only the payment action backed by %s", async (permission, disabledAction, enabledAction) => {
    configurePaymentPage();
    authMock.can.mockImplementation((requested?: string) => !requested || ["payment:view_screenshot", permission].includes(requested));
    const wrapper = await mountPage();
    expect(actionButton(wrapper, "row", disabledAction).attributes("disabled")).toBeDefined();
    expect(actionButton(wrapper, "row", enabledAction).attributes("disabled")).toBeUndefined();
  });

  it.each([
    ["non-pending status", { status: "paid" }],
    ["missing updatedAt", { updatedAt: null }],
    ["invalid updatedAt", { updatedAt: "not-a-date" }],
    ["invalid version", { version: -1 }],
    ["empty id", { id: "" }]
  ])("disables payment actions for a %s", async (_label, patch) => {
    configurePaymentPage({ ...pendingPayment, ...patch } as TestRow);
    const wrapper = await mountPage();
    expect(actionButton(wrapper, "row", "confirm").attributes("disabled")).toBeDefined();
    expect(actionButton(wrapper, "row", "reject").attributes("disabled")).toBeDefined();
  });

  it("builds only the exact payment snapshot payload and does not apply order reject rules", async () => {
    configurePaymentPage();
    transportMock.mutate.mockResolvedValue({
      item: { id: "pay-001", orderNo: "ORDER-1", status: "rejected", version: 3, updatedAt: "2026-07-13T08:06:00.000Z" },
      affected: 1,
      reused: false,
      decision: "reject",
      accountRecalculationPending: false,
      message: "付款已驳回",
      requestId: "request-1"
    });
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "reject").trigger("click");
    await setReason(wrapper, "  凭证不清晰  ");
    await confirm(wrapper);

    expect(transportMock.mutate).toHaveBeenCalledTimes(1);
    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("payments");
    expect(action).toBe("reject");
    expect(payload).toEqual({
      id: "pay-001",
      expectedStatus: "pending_confirm",
      expectedVersion: 2,
      expectedUpdatedAt: "2026-07-13T08:05:00.000Z",
      reason: "凭证不清晰"
    });
    expect(Object.keys(payload)).toEqual(["id", "expectedStatus", "expectedVersion", "expectedUpdatedAt", "reason"]);
    expect(options).toMatchObject({ expectedVersion: 2, idempotencyKey: expect.stringMatching(/^payments:reject:/) });
  });

  it("requires a reject reason without sending a mutation", async () => {
    configurePaymentPage();
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "reject").trigger("click");
    await confirm(wrapper);

    expect(messageMock.warning).toHaveBeenCalledWith("请填写驳回原因");
    expect(transportMock.mutate).not.toHaveBeenCalled();
    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
  });

  it("closes and refreshes on any payment 409, then reopens with the fresh snapshot and key", async () => {
    configurePaymentPage();
    const refreshed = { ...pendingPayment, version: 3, updatedAt: "2026-07-13T08:07:00.000Z" };
    transportMock.list
      .mockResolvedValueOnce({ items: [{ ...pendingPayment }], total: 1, page: 1, pageSize: 20, nextCursor: null })
      .mockResolvedValue({ items: [refreshed], total: 1, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("付款记录已变化", "PAYMENT_STATE_CONFLICT", 409))
      .mockResolvedValueOnce({
        item: { id: "pay-001", orderNo: "ORDER-1", status: "paid", version: 4, updatedAt: "2026-07-13T08:08:00.000Z" },
        affected: 1,
        reused: false,
        decision: "confirm",
        accountRecalculationPending: false,
        message: "付款已确认",
        requestId: "request-2"
      });
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "confirm").trigger("click");
    await confirm(wrapper);
    const firstOptions = transportMock.mutate.mock.calls[0]![3];

    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
    expect(transportMock.list).toHaveBeenCalledTimes(2);
    expect(messageMock.error).toHaveBeenCalledWith("付款记录已变化，请重新核对后提交");

    await actionButton(wrapper, "row", "confirm").trigger("click");
    await confirm(wrapper);
    const [,, retryPayload, retryOptions] = transportMock.mutate.mock.calls[1]!;
    expect(retryPayload).toMatchObject({ expectedVersion: 3, expectedUpdatedAt: "2026-07-13T08:07:00.000Z" });
    expect(retryOptions.idempotencyKey).not.toBe(firstOptions.idempotencyKey);
  });

  it("keeps the dialog and reuses the same key for an unchanged non-conflict retry", async () => {
    configurePaymentPage();
    transportMock.mutate
      .mockRejectedValueOnce(new ApiError("网络不可用", "NETWORK_ERROR", 503))
      .mockResolvedValueOnce({
        item: { id: "pay-001", orderNo: "ORDER-1", status: "paid", version: 3, updatedAt: "2026-07-13T08:06:00.000Z" },
        affected: 1,
        reused: false,
        decision: "confirm",
        accountRecalculationPending: false,
        message: "付款已确认",
        requestId: "request-3"
      });
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "confirm").trigger("click");
    await confirm(wrapper);
    const firstKey = transportMock.mutate.mock.calls[0]![3].idempotencyKey;

    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(true);
    await confirm(wrapper);
    expect(transportMock.mutate.mock.calls[1]![3].idempotencyKey).toBe(firstKey);
  });

  it("rotates the key when the payment payload is edited after a failure", async () => {
    configurePaymentPage();
    transportMock.mutate.mockRejectedValueOnce(new ApiError("暂时失败", "NETWORK_ERROR", 503));
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "confirm").trigger("click");
    await setReason(wrapper, "第一次核对");
    await confirm(wrapper);
    const firstKey = transportMock.mutate.mock.calls[0]![3].idempotencyKey;

    await setReason(wrapper, "第二次核对");
    await confirm(wrapper);
    expect(transportMock.mutate.mock.calls[1]![3].idempotencyKey).not.toBe(firstKey);
  });
});

describe("OperationsView real after-sale review", () => {
  const pendingAfterSale: TestRow = {
    id: "as-001",
    version: 3,
    caseNo: "AS-001",
    orderNo: "ORDER-1",
    customerMasked: "演示客户 / 138****1201",
    type: "退货退款",
    amountCents: 21800,
    status: "pending_review",
    updatedAt: "2026-07-16T08:00:00.000Z"
  };

  function configureAfterSalePage(row: TestRow = pendingAfterSale): void {
    routeMock.meta.resource = "after-sales";
    authMock.can.mockImplementation((permission?: string) => !permission || ["after_sale:view", "after_sale:review"].includes(permission));
    transportMock.list.mockResolvedValue({ items: [{ ...row }], total: 1, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate.mockResolvedValue({
      item: { id: row.id, caseNo: row.caseNo, status: "waiting_return", version: row.version + 1, updatedAt: "2026-07-16T08:01:00.000Z" },
      afterSaleId: row.id,
      afterSaleStatus: "waiting_return",
      refundStatus: "pending",
      approvedRefundAmount: 12800,
      affected: 1,
      reused: false,
      decision: "approve",
      message: "售后申请已审核通过",
      requestId: "request-1"
    });
  }

  it("enables only review actions for a current snapshot and leaves receive closed", async () => {
    configureAfterSalePage();
    const wrapper = await mountPage();
    expect(actionButton(wrapper, "row", "approve").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "row", "reject").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "row", "receive").attributes("disabled")).toBeDefined();
  });

  it("submits a strict receive snapshot for a returned after-sale", async () => {
    const row = {
      ...pendingAfterSale,
      status: "returned",
      version: 8,
      updatedAt: "2026-07-16T09:00:00.000Z"
    };
    configureAfterSalePage(row);
    authMock.can.mockImplementation((permission?: string) => !permission || [
      "after_sale:view",
      "after_sale:receive_return",
      "after_sale:inspect"
    ].includes(permission));
    transportMock.mutate.mockResolvedValue({
      item: { id: row.id, status: "received", version: 9, updatedAt: "2026-07-16T09:01:00.000Z" },
      afterSaleId: row.id,
      afterSaleStatus: "received",
      restoredQuantity: 0,
      affected: 1,
      reused: false,
      message: "return received",
      requestId: "request-receive-1"
    });
    const wrapper = await mountPage();

    expect(actionButton(wrapper, "row", "receive").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "row", "inspect").attributes("disabled")).toBeDefined();
    await actionButton(wrapper, "row", "receive").trigger("click");
    await setReason(wrapper, "return received");
    await confirm(wrapper);

    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("after-sales");
    expect(action).toBe("receive");
    expect(payload).toEqual({
      action: "receive",
      id: row.id,
      expectedStatus: "returned",
      expectedVersion: 8,
      expectedUpdatedAt: "2026-07-16T09:00:00.000Z",
      remark: "return received"
    });
    expect(options).toMatchObject({ expectedVersion: 8, idempotencyKey: expect.stringMatching(/^after-sales:receive:/) });
  });

  it("submits strict inspect controls only for a received after-sale", async () => {
    const row = {
      ...pendingAfterSale,
      status: "received",
      version: 9,
      updatedAt: "2026-07-16T09:02:00.000Z"
    };
    configureAfterSalePage(row);
    authMock.can.mockImplementation((permission?: string) => !permission || [
      "after_sale:view",
      "after_sale:inspect"
    ].includes(permission));
    transportMock.mutate.mockResolvedValue({
      item: { id: row.id, status: "refund_pending", version: 10, updatedAt: "2026-07-16T09:03:00.000Z" },
      afterSaleId: row.id,
      afterSaleStatus: "refund_pending",
      restoredQuantity: 2,
      affected: 1,
      reused: false,
      message: "return inspected",
      requestId: "request-inspect-1"
    });
    const wrapper = await mountPage();

    expect(actionButton(wrapper, "row", "receive").attributes("disabled")).toBeDefined();
    expect(actionButton(wrapper, "row", "inspect").attributes("disabled")).toBeUndefined();
    await actionButton(wrapper, "row", "inspect").trigger("click");
    const condition = wrapper.findAllComponents(ElSelect).find((candidate) => candidate.attributes("data-testid") === "item-condition");
    if (!condition) throw new Error("Item condition select not found");
    condition.vm.$emit("update:modelValue", "sellable");
    const restock = wrapper.findAllComponents(ElCheckbox).find((candidate) => candidate.attributes("data-testid") === "restock-toggle");
    if (!restock) throw new Error("Restock toggle not found");
    restock.vm.$emit("update:modelValue", true);
    await nextTick();
    const quantity = wrapper.findAllComponents(ElInputNumber).find((candidate) => candidate.attributes("data-testid") === "restock-quantity");
    if (!quantity) throw new Error("Restock quantity input not found");
    quantity.vm.$emit("update:modelValue", 2);
    await setReason(wrapper, "items are sellable");
    await confirm(wrapper);

    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("after-sales");
    expect(action).toBe("inspect");
    expect(payload).toEqual({
      action: "inspect",
      id: row.id,
      expectedStatus: "received",
      expectedVersion: 9,
      expectedUpdatedAt: "2026-07-16T09:02:00.000Z",
      itemCondition: "sellable",
      canRestock: true,
      restockQuantity: 2,
      inspectionRemark: "items are sellable"
    });
    expect(options).toMatchObject({ expectedVersion: 9, idempotencyKey: expect.stringMatching(/^after-sales:inspect:/) });
  });

  it("sends the strict approve amount and return requirement", async () => {
    configureAfterSalePage();
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "approve").trigger("click");
    const amount = wrapper.findComponent(ElInputNumber);
    amount.vm.$emit("update:modelValue", 12800);
    const returnRequired = wrapper.findComponent(ElCheckbox);
    returnRequired.vm.$emit("update:modelValue", true);
    await setReason(wrapper, "符合规则");
    await confirm(wrapper);

    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("after-sales");
    expect(action).toBe("approve");
    expect(payload).toEqual({
      id: "as-001",
      expectedStatus: "pending_review",
      expectedVersion: 3,
      expectedUpdatedAt: "2026-07-16T08:00:00.000Z",
      approvedRefundAmount: 12800,
      returnRequired: true,
      reason: "符合规则"
    });
    expect(options).toMatchObject({ expectedVersion: 3, idempotencyKey: expect.stringMatching(/^after-sales:approve:/) });
  });

  it("requires a reason before sending a reject", async () => {
    configureAfterSalePage();
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "reject").trigger("click");
    await confirm(wrapper);
    expect(messageMock.warning).toHaveBeenCalledWith("请填写驳回原因");
    expect(transportMock.mutate).not.toHaveBeenCalled();
  });
});

describe("OperationsView real refund mutation", () => {
  const pendingRefund: TestRow = {
    id: "ref-001", version: 1, refundNo: "R-001", orderNo: "ORDER-1", customerMasked: "Customer / 138****1201",
    amountCents: 9_900, method: "offline", status: "pending", updatedAt: "2026-07-17T08:00:00.000Z"
  };

  function configureRefundPage(row: TestRow = pendingRefund): void {
    routeMock.meta.resource = "refunds";
    authMock.can.mockImplementation((permission?: string) => !permission || ["refund:view", "refund:process"].includes(permission));
    transportMock.list.mockResolvedValue({ items: [{ ...row }], total: 1, page: 1, pageSize: 20, nextCursor: null });
    transportMock.mutate.mockResolvedValue({
      item: { id: row.id, refundNo: row.refundNo, status: "refunded", version: row.version + 1, updatedAt: "2026-07-17T08:01:00.000Z", amountCents: row.amountCents },
      affected: 1, reused: false, action: "process", accountRecalculationPending: true, message: "refund confirmed", requestId: "refund-1"
    });
  }

  it.each(["pending", "processing", "failed"])("enables refund actions only for the processable %s status", async (status) => {
    configureRefundPage({ ...pendingRefund, status });
    const wrapper = await mountPage();
    expect(actionButton(wrapper, "row", "process").attributes("disabled")).toBeUndefined();
    expect(actionButton(wrapper, "row", "reject").attributes("disabled")).toBeUndefined();
  });

  it.each(["refunded", "partial_refunded", "rejected", "cancelled"])("disables refund actions for terminal %s status", async (status) => {
    configureRefundPage({ ...pendingRefund, status });
    const wrapper = await mountPage();
    expect(actionButton(wrapper, "row", "process").attributes("disabled")).toBeDefined();
    expect(actionButton(wrapper, "row", "reject").attributes("disabled")).toBeDefined();
  });

  it("uses the immutable row amount and complete snapshot for process", async () => {
    configureRefundPage();
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "process").trigger("click");
    await setReason(wrapper, "  reconciled  ");
    await confirm(wrapper);
    const [resource, action, payload, options] = transportMock.mutate.mock.calls[0]!;
    expect(resource).toBe("refunds");
    expect(action).toBe("process");
    expect(payload).toEqual({
      refundRecordId: "ref-001", refundAmountCents: 9_900, expectedRefundStatus: "pending", expectedRefundVersion: 1,
      expectedRefundUpdatedAt: "2026-07-17T08:00:00.000Z", financeRemark: "reconciled", refundProofFileIds: []
    });
    expect(options).toMatchObject({ expectedVersion: 1, idempotencyKey: expect.stringMatching(/^refunds:process:/) });
  });

  it("requires a reject reason and sends the strict reject snapshot", async () => {
    configureRefundPage();
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "reject").trigger("click");
    await confirm(wrapper);
    expect(messageMock.warning).toHaveBeenCalledWith("请填写驳回原因");
    expect(transportMock.mutate).not.toHaveBeenCalled();

    await setReason(wrapper, "  account mismatch  ");
    await confirm(wrapper);
    expect(transportMock.mutate).toHaveBeenCalledWith("refunds", "reject", {
      refundRecordId: "ref-001",
      expectedRefundStatus: "pending",
      expectedRefundVersion: 1,
      expectedRefundUpdatedAt: "2026-07-17T08:00:00.000Z",
      rejectReason: "account mismatch"
    }, expect.objectContaining({
      expectedVersion: 1,
      idempotencyKey: expect.stringMatching(/^refunds:reject:/)
    }));
  });

  it.each([
    ["version", undefined],
    ["updatedAt", undefined]
  ])("does not enable a refund mutation without the %s snapshot", async (field, value) => {
    configureRefundPage({ ...pendingRefund, [field]: value });
    const wrapper = await mountPage();
    expect(actionButton(wrapper, "row", "process").attributes("disabled")).toBeDefined();
    expect(actionButton(wrapper, "row", "reject").attributes("disabled")).toBeDefined();
  });

  it("retains the key for unchanged network retries and rotates it after payload changes", async () => {
    configureRefundPage();
    transportMock.mutate.mockRejectedValue(new ApiError("network", "NETWORK_ERROR"));
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "process").trigger("click");
    await setReason(wrapper, "same payload");
    await confirm(wrapper);
    await confirm(wrapper);
    const firstKey = transportMock.mutate.mock.calls[0]![3].idempotencyKey;
    expect(transportMock.mutate.mock.calls[1]![3].idempotencyKey).toBe(firstKey);

    await setReason(wrapper, "changed payload");
    await confirm(wrapper);
    expect(transportMock.mutate.mock.calls[2]![3].idempotencyKey).not.toBe(firstKey);
  });

  it("closes and rotates the key after a refund conflict", async () => {
    configureRefundPage();
    transportMock.mutate.mockRejectedValueOnce(new ApiError("conflict", "DATA_VERSION_CONFLICT", 409));
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "process").trigger("click");
    await confirm(wrapper);
    const firstKey = transportMock.mutate.mock.calls[0]![3].idempotencyKey;

    expect(wrapper.findComponent(ElDialog).props("modelValue")).toBe(false);
    await actionButton(wrapper, "row", "process").trigger("click");
    await confirm(wrapper);
    expect(transportMock.mutate.mock.calls[1]![3].idempotencyKey).not.toBe(firstKey);
  });
});

describe("OperationsView real order review feedback", () => {
  function configureOrderPage(): void {
    routeMock.meta.resource = "orders";
    authMock.can.mockImplementation((permission?: string) => !permission || ["order:view", "order:review", "order:reject"].includes(permission));
    transportMock.list.mockResolvedValue({
      items: [{ id: "order-1", version: 2, orderNo: "ORDER-1", status: "pending_admin", paymentStatus: "unpaid", updatedAt: "2026-07-13T08:00:00.000Z" }],
      total: 1,
      page: 1,
      pageSize: 20,
      nextCursor: null
    });
  }

  it("shows only the fixed warning when account recalculation is pending", async () => {
    configureOrderPage();
    transportMock.mutate.mockResolvedValue({
      affected: 1,
      message: "订单已审核通过",
      accountRecalculationPending: true,
      warning: "internal-sensitive-detail"
    });
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "review").trigger("click");
    await nextTick();
    await confirm(wrapper);

    expect(messageMock.warning).toHaveBeenCalledWith("订单已审核，客户账款汇总将在稍后更新");
    expect(messageMock.warning).not.toHaveBeenCalledWith("internal-sensitive-detail");
    expect(messageMock.success).not.toHaveBeenCalled();
  });

  it("shows the safe mutation message when account recalculation is not pending", async () => {
    configureOrderPage();
    transportMock.mutate.mockResolvedValue({ affected: 1, message: "订单已审核通过" });
    const wrapper = await mountPage();
    await actionButton(wrapper, "row", "review").trigger("click");
    await nextTick();
    await confirm(wrapper);

    expect(messageMock.success).toHaveBeenCalledWith("订单已审核通过");
    expect(messageMock.warning).not.toHaveBeenCalled();
  });
});

describe("OperationsView merge shipment list", () => {
  function configureShipmentPage(): void {
    routeMock.meta.resource = "shipments";
    authMock.can.mockImplementation((permission?: string) => !permission || ["shipment:view", "shipment:ship", "shipment:update", "shipment:merge"].includes(permission));
    transportMock.list.mockResolvedValue({
      items: [{
        id: "shipment-1",
        shipmentNo: "S-001",
        orderCount: 2,
        customerMasked: "王**",
        carrier: "顺丰速运",
        trackingMasked: "SF********01",
        status: "pending_shipment",
        updatedAt: "2026-07-13T09:00:00.000Z",
        version: 2
      }],
      total: 1,
      page: 1,
      pageSize: 20,
      nextCursor: null
    });
  }

  it("keeps all writes disabled and opens the dedicated detail route from the safe drawer", async () => {
    configureShipmentPage();
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("合并发货单");
    expect(wrapper.text()).toContain("当前仅展示已创建的合并发货单；单订单发货将在后续接入");
    expect(actionButton(wrapper, "primary", "merge").attributes("disabled")).toBeDefined();
    expect(actionButton(wrapper, "row", "ship").attributes("disabled")).toBeDefined();
    expect(actionButton(wrapper, "row", "edit").attributes("disabled")).toBeDefined();

    wrapper.findComponent({ name: "ElTable" }).vm.$emit("row-dblclick", {
      id: "shipment-1",
      shipmentNo: "S-001",
      orderCount: 2,
      customerMasked: "王**",
      carrier: "顺丰速运",
      trackingMasked: "SF********01",
      status: "pending_shipment",
      updatedAt: "2026-07-13T09:00:00.000Z",
      version: 2
    });
    await nextTick();
    expect(document.body.textContent).toContain("S-001");
    const openDetail = wrapper.findAllComponents(ElButton).find((candidate) => candidate.text() === "打开详情页");
    if (!openDetail) throw new Error("Shipment detail button not found");
    await openDetail.trigger("click");
    expect(routerMock.push).toHaveBeenCalledWith("/shipments/shipment-1");
  });

  it("renders retryable list errors", async () => {
    configureShipmentPage();
    transportMock.list
      .mockRejectedValueOnce(new ApiError("合并发货单暂时不可用", "SHIPMENT_READ_UNAVAILABLE", 503))
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20, nextCursor: null });
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("合并发货单暂时不可用");
    const retry = wrapper.findAllComponents(ElButton).find((candidate) => candidate.text() === "重新加载");
    if (!retry) throw new Error("Retry button not found");
    await retry.trigger("click");
    await flushPromises();
    expect(transportMock.list).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("没有符合条件的合并发货单");
  });
});

describe("OperationsView account list", () => {
  function configureAccountPage(): void {
    routeMock.meta.resource = "accounts";
    authMock.can.mockImplementation((permission?: string) => !permission || [
      "customer:view_account",
      "customer:export_account"
    ].includes(permission));
    transportMock.list.mockResolvedValue({
      items: [{
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
      }],
      total: 1,
      page: 1,
      pageSize: 20,
      nextCursor: null
    });
  }

  it("keeps export disabled and opens the dedicated detail route from the safe drawer", async () => {
    configureAccountPage();
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("待确认");
    expect(wrapper.text()).toContain("最近订单");
    expect(wrapper.text()).toContain("最近付款");
    expect(actionButton(wrapper, "bulk", "export").attributes("disabled")).toBeDefined();

    wrapper.findComponent({ name: "ElTable" }).vm.$emit("row-dblclick", {
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
    });
    await nextTick();

    expect(document.body.textContent).toContain("演示客户 / 138****8000");
    const openDetail = wrapper.findAllComponents(ElButton).find((candidate) => candidate.text() === "打开详情页");
    if (!openDetail) throw new Error("Account detail button not found");
    await openDetail.trigger("click");

    expect(routerMock.push).toHaveBeenCalledWith("/accounts/account-1");
    expect(transportMock.mutate).not.toHaveBeenCalled();
  });
});
