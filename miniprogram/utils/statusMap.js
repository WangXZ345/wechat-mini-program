const STATUS_TYPE_CLASS = {
  success: "tag-success",
  warning: "tag-warning",
  danger: "tag-danger",
  info: "tag-info",
  muted: "tag-muted"
};

const orderStatusMap = {
  pending_system: { label: "待系统判断", type: "info", color: "#B99C74", description: "订单已提交，等待系统判断" },
  auto_reviewing: { label: "自动审核中", type: "info", color: "#B99C74", description: "系统正在审核订单" },
  pending_admin: { label: "待管理员审核", type: "warning", color: "#B99C74", description: "需要管理员人工审核" },
  approved_pending_payment: { label: "待付款", type: "warning", color: "#B99C74", description: "订单已通过，请提交付款截图" },
  pending_payment_confirm: { label: "待确认付款", type: "info", color: "#B99C74", description: "付款截图已提交，等待商家确认" },
  paid: { label: "已付款", type: "success", color: "#6F8A5F", description: "付款已确认" },
  unpaid: { label: "未付款", type: "warning", color: "#B99C74", description: "订单尚未付款" },
  partial_paid: { label: "部分付款", type: "warning", color: "#B99C74", description: "仅确认了部分款项" },
  abnormal: { label: "付款异常", type: "danger", color: "#9A2D2D", description: "付款需要人工处理" },
  rejected: { label: "已拒绝", type: "danger", color: "#9A2D2D", description: "订单未通过审核" },
  cancelled: { label: "已取消", type: "muted", color: "#82776B", description: "订单已取消" }
};

const paymentStatusMap = {
  none: { label: "未提交", type: "muted", color: "#82776B", description: "尚未提交付款截图" },
  unpaid: { label: "未付款", type: "warning", color: "#B99C74", description: "尚未付款" },
  pending_confirm: { label: "待确认", type: "info", color: "#B99C74", description: "等待财务确认" },
  paid: { label: "已付款", type: "success", color: "#6F8A5F", description: "付款已确认" },
  partial: { label: "部分付款", type: "warning", color: "#B99C74", description: "仅确认了部分款项" },
  partial_paid: { label: "部分付款", type: "warning", color: "#B99C74", description: "仅确认了部分款项" },
  abnormal: { label: "付款异常", type: "danger", color: "#9A2D2D", description: "付款需要人工处理" },
  refunded: { label: "已退款", type: "muted", color: "#82776B", description: "付款已退款" }
};

const inventoryStatusMap = {
  normal: { label: "正常", type: "success", color: "#6F8A5F", description: "库存状态正常" },
  low: { label: "低库存", type: "warning", color: "#B99C74", description: "库存低于预警值" },
  sold_out: { label: "已售罄", type: "danger", color: "#9A2D2D", description: "库存为 0" },
  expiring: { label: "临期", type: "warning", color: "#B99C74", description: "生产日期较早或即将临期" },
  old_production: { label: "生产日期较早", type: "warning", color: "#B99C74", description: "需要关注批次" }
};

const importStatusMap = {
  pending: { label: "待解析", type: "muted", color: "#82776B", description: "文件等待解析" },
  parsed: { label: "已解析", type: "info", color: "#B99C74", description: "文件解析完成" },
  importing: { label: "导入中", type: "info", color: "#B99C74", description: "数据正在导入" },
  success: { label: "导入成功", type: "success", color: "#6F8A5F", description: "数据已导入" },
  partial_failed: { label: "部分失败", type: "warning", color: "#B99C74", description: "部分数据需要处理" },
  failed: { label: "导入失败", type: "danger", color: "#9A2D2D", description: "导入未完成" },
  check_passed: { label: "自检通过", type: "success", color: "#6F8A5F", description: "自检未发现问题" },
  check_warning: { label: "自检警告", type: "warning", color: "#B99C74", description: "存在需要确认的提示" },
  check_failed: { label: "自检失败", type: "danger", color: "#9A2D2D", description: "存在阻断问题" }
};

const permissionStatusMap = {
  active: { label: "正常", type: "success", color: "#6F8A5F", description: "账号可用" },
  disabled: { label: "已禁用", type: "danger", color: "#9A2D2D", description: "账号已被禁用" },
  forbidden: { label: "无权限", type: "danger", color: "#9A2D2D", description: "当前账号没有访问权限" }
};

function getStatusMeta(map, status, fallbackLabel) {
  const meta = map[status] || {
    label: fallbackLabel || status || "未知状态",
    type: "muted",
    color: "#82776B",
    description: ""
  };
  return {
    ...meta,
    className: STATUS_TYPE_CLASS[meta.type] || STATUS_TYPE_CLASS.muted
  };
}

module.exports = {
  orderStatusMap,
  paymentStatusMap,
  inventoryStatusMap,
  importStatusMap,
  permissionStatusMap,
  getStatusMeta
};
