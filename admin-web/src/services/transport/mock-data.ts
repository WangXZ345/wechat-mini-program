type MockRow = Record<string, unknown> & { id: string; version: number };

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

export const MOCK_DATA_NOTICE = "本页为本地演示数据，不含真实客户隐私或业务凭证。";

export const mockRows: Record<string, MockRow[]> = {
  products: [
    { id: "p-001", version: 3, sku: "DEMO-101", name: "演示柔雾唇釉", brand: "示例品牌 A", salePriceCents: 6900, isActive: true, status: "active", tags: ["热销"], updatedAt: ago(8) },
    { id: "p-002", version: 5, sku: "DEMO-102", name: "演示修护精华", brand: "示例品牌 B", salePriceCents: 15800, isActive: true, status: "active", tags: ["新货"], updatedAt: ago(18) },
    { id: "p-003", version: 2, sku: "DEMO-103", name: "演示控油散粉", brand: "示例品牌 C", salePriceCents: 8800, isActive: false, status: "inactive", tags: [], updatedAt: ago(46) },
    { id: "p-004", version: 1, sku: "DEMO-104", name: "演示水感面霜", brand: "示例品牌 A", salePriceCents: 12900, isActive: false, status: "draft", tags: [], updatedAt: ago(93) },
    { id: "p-005", version: 7, sku: "DEMO-105", name: "演示清透防晒", brand: "示例品牌 D", salePriceCents: 9900, isActive: true, status: "active", tags: ["热销"], updatedAt: ago(120) },
    { id: "p-006", version: 4, sku: "DEMO-106", name: "演示氨基酸洁面", brand: "示例品牌 B", salePriceCents: 7600, isActive: true, status: "active", tags: [], updatedAt: ago(170) },
    { id: "p-007", version: 2, sku: "DEMO-107", name: "演示眉笔 02", brand: "示例品牌 E", salePriceCents: 3900, isActive: true, status: "active", tags: ["新货"], updatedAt: ago(250) },
    { id: "p-008", version: 6, sku: "DEMO-108", name: "演示卸妆膏", brand: "示例品牌 C", salePriceCents: 10900, isActive: true, status: "active", tags: [], updatedAt: ago(320) }
  ],
  inventory: [
    { id: "p-001", version: 3, sku: "DEMO-101", name: "演示柔雾唇釉", stock: 286, warningThreshold: 80, status: "normal", lastChange: "+40 导入", updatedAt: ago(8) },
    { id: "p-002", version: 5, sku: "DEMO-102", name: "演示修护精华", stock: 42, warningThreshold: 60, status: "low", lastChange: "-12 订单", updatedAt: ago(18) },
    { id: "p-003", version: 2, sku: "DEMO-103", name: "演示控油散粉", stock: 0, warningThreshold: 30, status: "out", lastChange: "-8 订单", updatedAt: ago(46) },
    { id: "p-004", version: 1, sku: "DEMO-104", name: "演示水感面霜", stock: 96, warningThreshold: 40, status: "normal", lastChange: "+96 入库", updatedAt: ago(93) },
    { id: "p-005", version: 7, sku: "DEMO-105", name: "演示清透防晒", stock: 58, warningThreshold: 80, status: "low", lastChange: "-24 订单", updatedAt: ago(120) },
    { id: "p-006", version: 4, sku: "DEMO-106", name: "演示氨基酸洁面", stock: 510, warningThreshold: 100, status: "normal", lastChange: "+200 导入", updatedAt: ago(170) }
  ],
  "inventory-alerts": [
    { id: "p-002", version: 5, sku: "DEMO-102", name: "演示修护精华", stock: 42, warningThreshold: 60, status: "low", suggestion: "建议补充 18 件", updatedAt: ago(18) },
    { id: "p-003", version: 2, sku: "DEMO-103", name: "演示控油散粉", stock: 0, warningThreshold: 30, status: "out", suggestion: "已缺货，优先补货", updatedAt: ago(46) },
    { id: "p-005", version: 7, sku: "DEMO-105", name: "演示清透防晒", stock: 58, warningThreshold: 80, status: "low", suggestion: "建议补充 22 件", updatedAt: ago(120) }
  ],
  orders: [
    { id: "o-001", version: 2, orderNo: "DEMO-O-24071101", customerMasked: "演示客户 01 / 138****1201", itemSummary: "柔雾唇釉等 3 件", totalAmountCents: 28700, status: "pending_admin", paymentStatus: "pending_confirm", createdAt: ago(4) },
    { id: "o-002", version: 4, orderNo: "DEMO-O-24071102", customerMasked: "演示客户 02 / 139****2302", itemSummary: "修护精华等 6 件", totalAmountCents: 64800, status: "approved_pending_payment", paymentStatus: "pending_confirm", createdAt: ago(17) },
    { id: "o-003", version: 5, orderNo: "DEMO-O-24071103", customerMasked: "演示客户 03 / 137****3403", itemSummary: "清透防晒等 12 件", totalAmountCents: 118800, status: "pending_shipment", paymentStatus: "paid", createdAt: ago(38) },
    { id: "o-004", version: 8, orderNo: "DEMO-O-24071007", customerMasked: "演示客户 04 / 136****4504", itemSummary: "氨基酸洁面等 9 件", totalAmountCents: 73400, status: "completed", paymentStatus: "paid", createdAt: ago(150) }
  ],
  payments: [
    { id: "pay-001", version: 1, orderNo: "DEMO-O-24071101", customerMasked: "演示客户 01 / 138****1201", amountCents: 28700, proofLabel: "演示凭证 #01", status: "pending_confirm", submittedAt: ago(3) },
    { id: "pay-002", version: 2, orderNo: "DEMO-O-24071102", customerMasked: "演示客户 02 / 139****2302", amountCents: 32000, proofLabel: "演示凭证 #02", status: "pending_confirm", submittedAt: ago(15) },
    { id: "pay-003", version: 3, orderNo: "DEMO-O-24071007", customerMasked: "演示客户 04 / 136****4504", amountCents: 73400, proofLabel: "演示凭证 #03", status: "paid", submittedAt: ago(132) }
  ],
  accounts: [
    { id: "acct-001", version: 3, nickname: "演示客户 01", customerName: "演示客户 01", phoneMasked: "138****1201", customerMasked: "演示客户 01 / 138****1201", totalOrders: 8, receivableCents: 268000, receivedCents: 239300, unpaidAmountCents: 28700, pendingConfirmAmountCents: 0, abnormalCount: 0, status: "unpaid", lastOrderAt: ago(18), lastPaymentAt: ago(120), internalRemark: "内部风险命中", updatedAt: ago(12) },
    { id: "acct-002", version: 5, nickname: "演示客户 02", customerName: "演示客户 02", phoneMasked: "139****2302", customerMasked: "演示客户 02 / 139****2302", totalOrders: 14, receivableCents: 516000, receivedCents: 451200, unpaidAmountCents: 64800, pendingConfirmAmountCents: 32000, abnormalCount: 0, status: "pending_confirm", lastOrderAt: ago(35), lastPaymentAt: ago(80), updatedAt: ago(35) },
    { id: "acct-003", version: 2, nickname: "演示客户 05", customerName: "演示客户 05", phoneMasked: "137****3405", customerMasked: "演示客户 05 / 137****3405", totalOrders: 5, receivableCents: 197000, receivedCents: 102000, unpaidAmountCents: 95000, pendingConfirmAmountCents: 0, abnormalCount: 2, status: "abnormal", lastOrderAt: ago(240), lastPaymentAt: null, updatedAt: ago(240) },
    { id: "acct-004", version: 4, nickname: "演示客户 08", customerName: "演示客户 08", phoneMasked: "136****4508", customerMasked: "演示客户 08 / 136****4508", totalOrders: 11, receivableCents: 386000, receivedCents: 386000, unpaidAmountCents: 0, pendingConfirmAmountCents: 0, abnormalCount: 0, status: "settled", lastOrderAt: ago(480), lastPaymentAt: ago(460), updatedAt: ago(450) }
  ],
  shipments: [
    { id: "ship-001", version: 2, shipmentNo: "DEMO-S-24071101", ordersCount: 1, customerMasked: "演示客户 03", carrier: "顺丰速运", trackingMasked: "SF****8301", status: "pending_shipment", updatedAt: ago(22) },
    { id: "ship-002", version: 4, shipmentNo: "DEMO-S-24071002", ordersCount: 2, customerMasked: "演示客户 04", carrier: "中通快递", trackingMasked: "ZT****1942", status: "shipped", updatedAt: ago(95) },
    { id: "ship-003", version: 7, shipmentNo: "DEMO-S-24070908", ordersCount: 1, customerMasked: "演示客户 06", carrier: "圆通速递", trackingMasked: "YT****4408", status: "completed", updatedAt: ago(420) }
  ],
  "after-sales": [
    { id: "as-001", version: 1, caseNo: "DEMO-A-24071101", orderNo: "DEMO-O-24071007", customerMasked: "演示客户 04", type: "退货退款", amountCents: 21800, status: "pending_review", refundStatus: "none", createdAt: ago(9), updatedAt: ago(9) },
    { id: "as-002", version: 3, caseNo: "DEMO-A-24071002", orderNo: "DEMO-O-24070908", customerMasked: "演示客户 06", type: "仅退款", amountCents: 9900, status: "approved", refundStatus: "pending", createdAt: ago(105), updatedAt: ago(105) },
    { id: "as-003", version: 6, caseNo: "DEMO-A-24070803", orderNo: "DEMO-O-24070804", customerMasked: "演示客户 07", type: "退货退款", amountCents: 15800, status: "completed", refundStatus: "none", createdAt: ago(720), updatedAt: ago(720) }
  ],
  refunds: [
    { id: "ref-001", version: 1, refundNo: "DEMO-R-24071101", orderNo: "DEMO-O-24070908", customerMasked: "演示客户 06", amountCents: 9900, method: "原路退回", status: "pending", updatedAt: ago(12) },
    { id: "ref-002", version: 3, refundNo: "DEMO-R-24071002", orderNo: "DEMO-O-24070804", customerMasked: "演示客户 07", amountCents: 15800, method: "线下退款", status: "processing", updatedAt: ago(160) },
    { id: "ref-003", version: 5, refundNo: "DEMO-R-24070903", orderNo: "DEMO-O-24070702", customerMasked: "演示客户 08", amountCents: 7600, method: "原路退回", status: "failed", updatedAt: ago(490) },
    { id: "ref-004", version: 2, refundNo: "DEMO-R-24070804", orderNo: "DEMO-O-24070601", customerMasked: "演示客户 02", amountCents: 21800, method: "原路退回", status: "refunded", updatedAt: ago(720) },
    { id: "ref-005", version: 4, refundNo: "DEMO-R-24070705", orderNo: "DEMO-O-24070503", customerMasked: "演示客户 03", amountCents: 12800, method: "线下退款", status: "partial_refunded", updatedAt: ago(860) },
    { id: "ref-006", version: 3, refundNo: "DEMO-R-24070606", orderNo: "DEMO-O-24070402", customerMasked: "演示客户 05", amountCents: 6800, method: "原路退回", status: "rejected", updatedAt: ago(990) },
    { id: "ref-007", version: 2, refundNo: "DEMO-R-24070507", orderNo: "DEMO-O-24070301", customerMasked: "演示客户 01", amountCents: 5200, method: "线下退款", status: "cancelled", updatedAt: ago(1200) }
  ],
  admins: [
    { id: "adm-001", version: 4, name: "演示超级管理员", username: "super_admin.demo", role: "super_admin", permissionSummary: "全部合法后台模块", status: "enabled", lastLoginAt: ago(2) },
    { id: "adm-002", version: 2, name: "演示采购", username: "procurement.demo", role: "procurement", permissionSummary: "商品、库存、导入、分析", status: "enabled", lastLoginAt: ago(25) },
    { id: "adm-003", version: 3, name: "演示财务", username: "finance.demo", role: "finance", permissionSummary: "付款、账款、退款", status: "enabled", lastLoginAt: ago(41) },
    { id: "adm-004", version: 2, name: "演示客服", username: "customer_service.demo", role: "customer_service", permissionSummary: "订单、发货、售后", status: "enabled", lastLoginAt: ago(67) }
  ],
  audit: [
    { id: "log-001", version: 1, operator: "演示采购", action: "调整商品售价", targetType: "商品", summary: "DEMO-102 售价已更新（不含真实价格日志）", status: "success", createdAt: ago(6) },
    { id: "log-002", version: 1, operator: "演示客服", action: "审核订单", targetType: "订单", summary: "DEMO-O-24071101 进入待付款", status: "success", createdAt: ago(11) },
    { id: "log-003", version: 1, operator: "演示财务", action: "确认付款", targetType: "付款", summary: "演示付款记录已确认", status: "success", createdAt: ago(23) },
    { id: "log-004", version: 1, operator: "系统", action: "拒绝重复请求", targetType: "幂等", summary: "同一业务键的重复提交已拦截", status: "rejected", createdAt: ago(38) }
  ],
  settings: [
    {
      id: "system",
      version: 7,
      enableOfflineQrPayment: true,
      enableBankTransfer: true,
      enableWechatPay: false,
      requirePaymentProofForOfflinePayment: true,
      allowMultiplePaymentRecords: true,
      maxPaymentScreenshotCount: 3,
      lowStockDefaultThreshold: 50,
      sessionIdleMinutes: 30,
      updatedAt: ago(180)
    }
  ]
};

export function cloneMockRows(): Record<string, MockRow[]> {
  return structuredClone(mockRows);
}
