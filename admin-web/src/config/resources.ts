import type { ResourceDefinition } from "@/types/resource";

export const statusLabels: Record<string, string> = {
  created: "已创建",
  active: "在售",
  inactive: "已下架",
  draft: "草稿",
  normal: "正常",
  low: "低库存",
  out: "缺货",
  pending_system: "待系统判断",
  auto_reviewing: "自动审核中",
  pending_admin: "待审核",
  approved_pending_payment: "待付款",
  pending_payment_confirm: "待确认付款",
  pending_confirm: "待确认",
  paid: "已付款",
  unpaid: "未付款",
  partial_paid: "部分付款",
  abnormal: "付款异常",
  rejected: "已驳回",
  cancelled: "已取消",
  pending: "待处理",
  pending_shipment: "待发货",
  shipped: "已发货",
  completed: "已完成",
  pending_review: "待审核",
  approved: "已通过",
  waiting_return: "待退货",
  returned: "已寄回",
  received: "已收货",
  inspecting: "验货中",
  refund_pending: "待退款",
  processing: "处理中",
  refunded: "已退款",
  partial_refunded: "部分退款",
  failed: "失败",
  pending_refund: "待退款",
  overdue: "逾期",
  warning: "关注",
  enabled: "启用",
  disabled: "停用",
  success: "成功"
};

export const resourceDefinitions: Record<string, ResourceDefinition> = {
  products: {
    key: "products",
    entityType: "product",
    title: "商品管理",
    description: "维护商品资料、售价、标签和销售状态",
    searchPlaceholder: "搜索商品名称、品牌或 SKU",
    readPermission: "product:view",
    writePermission: "product:update",
    emptyText: "没有符合条件的商品",
    statusOptions: [
      { label: "全部状态", value: "" },
      { label: "在售", value: "active" },
      { label: "已下架", value: "inactive" },
      { label: "草稿", value: "draft" }
    ],
    columns: [
      { key: "sku", label: "SKU", width: 120 },
      { key: "name", label: "商品", minWidth: 220 },
      { key: "brand", label: "品牌", width: 120 },
      { key: "salePriceCents", label: "销售价", kind: "money", width: 120 },
      { key: "status", label: "状态", kind: "status", width: 100 },
      { key: "tags", label: "标签", minWidth: 160 },
      { key: "updatedAt", label: "更新时间", kind: "date", width: 150 }
    ],
    primaryAction: { key: "create", label: "新增商品", permission: "product:create", realEnabled: true, type: "primary", confirmTitle: "新增商品" },
    rowActions: [
      { key: "edit", label: "编辑", permission: "product:update", realEnabled: true },
      {
        key: "change-price",
        label: "改价",
        permission: "product:update_price",
        realEnabled: true,
        confirmTitle: "修改商品售价",
        confirmText: "改价将写入价格变更日志，请核对新售价。"
      },
      {
        key: "toggle-status",
        label: "上下架",
        permission: "product:update_status",
        realEnabled: true,
        type: "warning",
        confirmText: "状态变更将记录操作日志，请确认目标销售状态。"
      }
    ],
    bulkActions: [
      {
        key: "batch-enable",
        label: "批量上架",
        permission: "product:update_status",
        realEnabled: true,
        bulk: true,
        confirmText: "所选商品将按当前版本批量上架，状态冲突的商品不会被覆盖。"
      },
      {
        key: "batch-tags",
        label: "批量标签",
        permission: "product:tag:batch_update",
        realEnabled: true,
        bulk: true,
        confirmTitle: "批量设置公开标签",
        confirmText: "标签将按当前版本逐项处理，状态冲突的商品不会被覆盖。"
      }
    ]
  },
  inventory: {
    key: "inventory",
    entityType: "inventory",
    title: "库存管理",
    description: "查看实时库存、预警阈值和最近调整记录",
    searchPlaceholder: "搜索商品名称或 SKU",
    readPermission: "inventory:view",
    writePermission: "inventory:update",
    emptyText: "没有符合条件的库存记录",
    statusOptions: [
      { label: "全部库存", value: "" },
      { label: "正常", value: "normal" },
      { label: "低库存", value: "low" },
      { label: "缺货", value: "out" }
    ],
    columns: [
      { key: "sku", label: "SKU", width: 120 },
      { key: "name", label: "商品", minWidth: 230 },
      { key: "stock", label: "可用库存", kind: "number", width: 110, sensitive: true },
      { key: "warningThreshold", label: "预警值", kind: "number", width: 100 },
      { key: "status", label: "库存状态", kind: "status", width: 110 },
      { key: "lastChange", label: "最近变动", width: 140 },
      { key: "updatedAt", label: "更新时间", kind: "date", width: 150 }
    ],
    rowActions: [
      { key: "adjust", label: "调整", permission: "inventory:update", realEnabled: true, confirmText: "库存调整将记录操作日志。" },
      { key: "set-warning", label: "预警值", permission: "inventory:set_warning", realEnabled: true },
      { key: "view-log", label: "日志", permission: "inventory:view_log" }
    ],
    bulkActions: [{ key: "batch-warning", label: "批量预警值", permission: "inventory:set_warning", bulk: true }]
  },
  "inventory-alerts": {
    key: "inventory-alerts",
    entityType: "inventory",
    title: "库存预警",
    description: "集中处理低库存、缺货和临期提醒",
    searchPlaceholder: "搜索预警商品",
    readPermission: "inventory:view",
    writePermission: "inventory:set_warning",
    emptyText: "当前没有库存预警",
    statusOptions: [
      { label: "全部预警", value: "" },
      { label: "低库存", value: "low" },
      { label: "缺货", value: "out" },
      { label: "关注", value: "warning" }
    ],
    columns: [
      { key: "sku", label: "SKU", width: 120 },
      { key: "name", label: "商品", minWidth: 240 },
      { key: "stock", label: "当前库存", kind: "number", width: 110, sensitive: true },
      { key: "warningThreshold", label: "预警值", kind: "number", width: 100 },
      { key: "status", label: "级别", kind: "status", width: 100 },
      { key: "suggestion", label: "建议", minWidth: 180 },
      { key: "updatedAt", label: "更新时间", kind: "date", width: 150 }
    ],
    rowActions: [
      { key: "set-warning", label: "调整预警", permission: "inventory:set_warning", realEnabled: true },
      { key: "adjust", label: "补充库存", permission: "inventory:update", realEnabled: true, type: "primary" }
    ],
    bulkActions: [{ key: "batch-warning", label: "批量设置", permission: "inventory:set_warning", bulk: true }]
  },
  orders: {
    key: "orders",
    entityType: "order",
    title: "订单管理",
    description: "审核订单、跟踪付款和履约状态",
    searchPlaceholder: "搜索订单号或掩码客户信息",
    readPermission: "order:view",
    writePermission: "order:review",
    emptyText: "没有符合条件的订单",
    statusOptions: [
      { label: "全部订单", value: "" },
      { label: "待系统判断", value: "pending_system" },
      { label: "自动审核中", value: "auto_reviewing" },
      { label: "待审核", value: "pending_admin" },
      { label: "待付款", value: "approved_pending_payment" },
      { label: "待确认付款", value: "pending_payment_confirm" },
      { label: "已付款", value: "paid" },
      { label: "未付款", value: "unpaid" },
      { label: "部分付款", value: "partial_paid" },
      { label: "付款异常", value: "abnormal" },
      { label: "已驳回", value: "rejected" },
      { label: "已取消", value: "cancelled" }
    ],
    columns: [
      { key: "orderNo", label: "订单号", width: 170 },
      { key: "customerMasked", label: "客户", minWidth: 140 },
      { key: "itemSummary", label: "商品摘要", minWidth: 220 },
      { key: "totalAmountCents", label: "订单金额", kind: "money", width: 125 },
      { key: "status", label: "订单状态", kind: "status", width: 115 },
      { key: "paymentStatus", label: "付款状态", kind: "status", width: 110 },
      { key: "createdAt", label: "下单时间", kind: "date", width: 150 }
    ],
    rowActions: [
      { key: "review", label: "审核通过", permission: "order:review", realEnabled: true, type: "primary", confirmText: "请确认订单审核结果。" },
      { key: "reject", label: "驳回", permission: "order:reject", realEnabled: true, type: "danger" },
      { key: "remark", label: "备注", permission: "order:edit_remark" }
    ],
    bulkActions: [{ key: "batch-review", label: "批量审核", permission: "order:review", bulk: true }]
  },
  payments: {
    key: "payments",
    entityType: "payment",
    title: "付款审核",
    description: "核对付款凭证并确认或驳回付款记录",
    searchPlaceholder: "搜索订单号或掩码客户信息",
    readPermission: "payment:view_screenshot",
    writePermission: "payment:confirm",
    emptyText: "当前没有待处理付款",
    statusOptions: [
      { label: "全部状态", value: "" },
      { label: "待确认", value: "pending_confirm" },
      { label: "已付款", value: "paid" },
      { label: "已驳回", value: "rejected" }
    ],
    columns: [
      { key: "orderNo", label: "订单号", width: 170 },
      { key: "customerMasked", label: "客户", minWidth: 140, sensitive: true },
      { key: "amountCents", label: "提交金额", kind: "money", width: 125, sensitive: true },
      { key: "proofLabel", label: "付款凭证", minWidth: 150, sensitive: true },
      { key: "status", label: "状态", kind: "status", width: 105 },
      { key: "submittedAt", label: "提交时间", kind: "date", width: 150 }
    ],
    rowActions: [
      { key: "confirm", label: "确认付款", permission: "payment:confirm", realEnabled: true, type: "success", confirmText: "请确认付款记录已核对无误。" },
      { key: "reject", label: "驳回", permission: "payment:update_status", realEnabled: true, type: "danger" }
    ],
    bulkActions: []
  },
  accounts: {
    key: "accounts",
    entityType: "account",
    title: "客户账款",
    description: "查看客户应收、已收、未收与待确认账款摘要",
    searchPlaceholder: "搜索客户名称或掩码手机号",
    readPermission: "customer:view_account",
    emptyText: "没有符合条件的账款",
    statusOptions: [
      { label: "全部账款", value: "" },
      { label: "未结清", value: "unpaid" },
      { label: "待确认", value: "pending_confirm" },
      { label: "异常", value: "abnormal" },
      { label: "已结清", value: "settled" }
    ],
    columns: [
      { key: "customerMasked", label: "客户", minWidth: 170, sensitive: true },
      { key: "totalOrders", label: "订单数", kind: "number", width: 95 },
      { key: "receivableCents", label: "应收", kind: "money", width: 125, sensitive: true },
      { key: "receivedCents", label: "已收", kind: "money", width: 125, sensitive: true },
      { key: "unpaidAmountCents", label: "未收", kind: "money", width: 125, sensitive: true },
      { key: "pendingConfirmAmountCents", label: "待确认", kind: "money", width: 125, sensitive: true },
      { key: "abnormalCount", label: "异常数", kind: "number", width: 90 },
      { key: "status", label: "账款状态", kind: "status", width: 105 },
      { key: "lastOrderAt", label: "最近订单", kind: "date", width: 150 },
      { key: "lastPaymentAt", label: "最近付款", kind: "date", width: 150 },
      { key: "updatedAt", label: "更新时间", kind: "date", width: 150 }
    ],
    rowActions: [],
    bulkActions: [{ key: "export", label: "导出所选", permission: "customer:export_account", bulk: true }]
  },
  shipments: {
    key: "shipments",
    entityType: "shipment",
    title: "合并发货单",
    description: "当前仅展示已创建的合并发货单；单订单发货将在后续接入",
    searchPlaceholder: "输入完整发货单号、订单号或运单号",
    readPermission: "shipment:view",
    writePermission: "shipment:ship",
    emptyText: "没有符合条件的合并发货单",
    statusOptions: [
      { label: "全部状态", value: "" },
      { label: "已创建", value: "created" },
      { label: "待发货", value: "pending_shipment" },
      { label: "已发货", value: "shipped" },
      { label: "已完成", value: "completed" },
      { label: "已取消", value: "cancelled" },
      { label: "异常", value: "abnormal" }
    ],
    columns: [
      { key: "shipmentNo", label: "发货单", width: 165 },
      { key: "orderCount", label: "订单数", kind: "number", width: 90 },
      { key: "customerMasked", label: "客户", minWidth: 140 },
      { key: "carrier", label: "快递公司", width: 120 },
      { key: "trackingMasked", label: "运单号", minWidth: 150 },
      { key: "status", label: "状态", kind: "status", width: 105 },
      { key: "updatedAt", label: "更新时间", kind: "date", width: 150 }
    ],
    primaryAction: { key: "merge", label: "合并发货", permission: "shipment:merge", type: "primary", confirmText: "请确认合并所选发货记录。" },
    rowActions: [
      { key: "ship", label: "确认发货", permission: "shipment:ship", type: "success" },
      { key: "edit", label: "物流信息", permission: "shipment:update" }
    ],
    bulkActions: [{ key: "merge", label: "合并所选", permission: "shipment:merge", bulk: true }]
  },
  "after-sales": {
    key: "after-sales",
    entityType: "after_sale",
    title: "售后审核",
    description: "审核售后申请并跟踪退货验收",
    searchPlaceholder: "搜索售后单或订单号",
    readPermission: "after_sale:view",
    writePermission: "after_sale:review",
    emptyText: "当前没有售后申请",
    statusOptions: [
      { label: "全部状态", value: "" },
      { label: "待审核", value: "pending_review" },
      { label: "已通过", value: "approved" },
      { label: "待退货", value: "waiting_return" },
      { label: "已寄回", value: "returned" },
      { label: "已收货", value: "received" },
      { label: "验货中", value: "inspecting" },
      { label: "待退款", value: "refund_pending" },
      { label: "处理中", value: "processing" },
      { label: "已驳回", value: "rejected" },
      { label: "已完成", value: "completed" }
    ],
    columns: [
      { key: "caseNo", label: "售后单", width: 165 },
      { key: "orderNo", label: "订单号", width: 165 },
      { key: "customerMasked", label: "客户", minWidth: 130 },
      { key: "type", label: "类型", width: 100 },
      { key: "amountCents", label: "申请金额", kind: "money", width: 120 },
      { key: "status", label: "状态", kind: "status", width: 105 },
      { key: "createdAt", label: "申请时间", kind: "date", width: 150 }
    ],
    rowActions: [
      { key: "approve", label: "通过", permission: "after_sale:review", realEnabled: true, type: "success" },
      { key: "reject", label: "驳回", permission: "after_sale:review", realEnabled: true, type: "danger" },
      { key: "receive", label: "确认收货", permission: "after_sale:receive_return", realEnabled: true, type: "primary" },
      { key: "inspect", label: "退货验货", permission: "after_sale:inspect", realEnabled: true, type: "warning" }
    ],
    bulkActions: []
  },
  refunds: {
    key: "refunds",
    entityType: "refund",
    title: "退款处理",
    description: "仅处理已通过售后审核的退款记录",
    searchPlaceholder: "搜索退款单或订单号",
    readPermission: "refund:view",
    writePermission: "refund:process",
    emptyText: "当前没有待处理退款",
    statusOptions: [
      { label: "全部状态", value: "" },
      { label: "待处理", value: "pending" },
      { label: "处理中", value: "processing" },
      { label: "失败", value: "failed" },
      { label: "已退款", value: "refunded" },
      { label: "部分退款", value: "partial_refunded" },
      { label: "已驳回", value: "rejected" },
      { label: "已取消", value: "cancelled" }
    ],
    columns: [
      { key: "refundNo", label: "退款单", width: 165 },
      { key: "orderNo", label: "订单号", width: 165 },
      { key: "customerMasked", label: "客户", minWidth: 130, sensitive: true },
      { key: "amountCents", label: "退款金额", kind: "money", width: 125, sensitive: true },
      { key: "method", label: "退款方式", width: 115, sensitive: true },
      { key: "status", label: "状态", kind: "status", width: 105 },
      { key: "updatedAt", label: "更新时间", kind: "date", width: 150 }
    ],
    rowActions: [
      { key: "process", label: "处理退款", permission: "refund:process", realEnabled: true, type: "primary", confirmText: "请确认退款信息已核对无误。" },
      { key: "reject", label: "驳回", permission: "refund:process", realEnabled: true, type: "danger" }
    ],
    bulkActions: []
  },
  admins: {
    key: "admins",
    entityType: "admin",
    title: "管理员",
    description: "维护后台账号状态和职责角色",
    searchPlaceholder: "搜索管理员名称或账号",
    readPermission: "admin:view",
    writePermission: "admin:update_role",
    emptyText: "没有符合条件的管理员",
    statusOptions: [
      { label: "全部状态", value: "" },
      { label: "启用", value: "enabled" },
      { label: "停用", value: "disabled" }
    ],
    columns: [
      { key: "name", label: "管理员", minWidth: 140 },
      { key: "username", label: "账号", minWidth: 160 },
      { key: "role", label: "角色", kind: "role", width: 125 },
      { key: "permissionSummary", label: "权限摘要", minWidth: 240 },
      { key: "status", label: "状态", kind: "status", width: 100 },
      { key: "lastLoginAt", label: "最近登录", kind: "date", width: 150 }
    ],
    primaryAction: { key: "create", label: "新增管理员", permission: "admin:create", type: "primary" },
    rowActions: [
      { key: "change-role", label: "调整角色", permission: "admin:update_role" },
      { key: "disable", label: "停用", permission: "admin:disable", type: "danger" }
    ],
    bulkActions: []
  },
  audit: {
    key: "audit",
    entityType: "operation_log",
    title: "操作日志",
    description: "按职责范围查看后台操作摘要",
    searchPlaceholder: "搜索操作人、对象或摘要",
    readPermission: "operation_log:view",
    emptyText: "没有符合条件的操作日志",
    statusOptions: [
      { label: "全部结果", value: "" },
      { label: "成功", value: "success" },
      { label: "已驳回", value: "rejected" }
    ],
    columns: [
      { key: "operator", label: "操作人", width: 130 },
      { key: "action", label: "操作", minWidth: 150 },
      { key: "targetType", label: "对象", width: 120 },
      { key: "summary", label: "摘要", minWidth: 260 },
      { key: "status", label: "结果", kind: "status", width: 95 },
      { key: "createdAt", label: "时间", kind: "date", width: 150 }
    ],
    rowActions: [{ key: "view", label: "查看详情", permission: "operation_log:view" }],
    bulkActions: []
  }
};
