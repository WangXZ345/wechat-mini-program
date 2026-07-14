import { describe, expect, it } from "vitest";
import { resourceDefinitions } from "./resources";

describe("shipment resource definition", () => {
  it("describes only merge shipment groups and keeps every write action disabled in real mode", () => {
    const shipment = resourceDefinitions.shipments!;

    expect(shipment.title).toBe("合并发货单");
    expect(shipment.description).toBe("当前仅展示已创建的合并发货单；单订单发货将在后续接入");
    expect(shipment.searchPlaceholder).toBe("输入完整发货单号、订单号或运单号");
    expect(shipment.statusOptions.map((option) => option.value)).toEqual([
      "",
      "created",
      "pending_shipment",
      "shipped",
      "completed",
      "cancelled",
      "abnormal"
    ]);
    const actions = [
      ...(shipment.primaryAction ? [shipment.primaryAction] : []),
      ...shipment.rowActions,
      ...shipment.bulkActions
    ];
    expect(actions).not.toHaveLength(0);
    expect(actions.every((action) => action.realEnabled !== true)).toBe(true);
  });
});

describe("account resource definition", () => {
  it("uses the authoritative read filters and columns while keeping export disabled in real mode", () => {
    const account = resourceDefinitions.accounts!;

    expect(account.description).toBe("查看客户应收、已收、未收与待确认账款摘要");
    expect(account.searchPlaceholder).toBe("搜索客户名称或掩码手机号");
    expect(account.statusOptions.map((option) => option.value)).toEqual([
      "",
      "unpaid",
      "pending_confirm",
      "abnormal",
      "settled"
    ]);
    expect(account.columns.map((column) => column.key)).toEqual(expect.arrayContaining([
      "pendingConfirmAmountCents",
      "lastOrderAt",
      "lastPaymentAt"
    ]));
    expect(account.statusOptions.map((option) => option.value)).not.toContain("overdue");
    expect(account.statusOptions.map((option) => option.value)).not.toContain("warning");
    expect(account.bulkActions.find((action) => action.key === "export")?.realEnabled).not.toBe(true);
  });
});
