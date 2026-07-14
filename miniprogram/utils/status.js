const {
  orderStatusMap,
  paymentStatusMap,
  getStatusMeta
} = require("./statusMap");

const ORDER_STATUS_TEXT = {
  pending_system: "待系统判断",
  auto_reviewing: "自动审核中",
  pending_admin: "待管理员审核",
  approved_pending_payment: "已通过，待付款",
  pending_payment_confirm: "待确认付款",
  paid: "已付款",
  unpaid: "未付款",
  partial_paid: "部分付款",
  abnormal: "付款异常",
  rejected: "已拒绝",
  cancelled: "已取消"
};

const PAYMENT_STATUS_TEXT = {
  none: "未提交",
  unpaid: "未付款",
  pending_confirm: "待确认",
  paid: "已付款",
  partial: "部分付款",
  partial_paid: "部分付款",
  abnormal: "付款异常",
  refunded: "已退款"
};

const DELIVERY_STATUS_TEXT = {
  pending: "待处理",
  waiting_pickup: "待自提",
  picked_up: "已自提",
  waiting_shipping: "待发货",
  shipped: "已发货",
  completed: "已完成",
  after_sales: "售后中"
};

const AFTER_SALE_TYPE_TEXT = {
  refund_only: "仅退款",
  return_refund: "退货退款",
  exchange: "换货",
  resend: "补发",
  price_adjustment_refund: "退款差额"
};

const AFTER_SALE_REASON_TEXT = {
  customer_cancel: "客户取消",
  out_of_stock: "缺货",
  wrong_item: "错发",
  missing_item: "少件",
  damaged: "破损",
  defective: "瑕疵",
  quality_issue: "质量问题",
  price_error: "价格异常",
  overpaid: "客户多付",
  duplicate_payment: "重复付款",
  address_issue: "地址问题",
  shipping_issue: "物流问题",
  other: "其他"
};

const AFTER_SALE_STATUS_TEXT = {
  pending_review: "待人工审核",
  approved: "审核通过",
  rejected: "审核拒绝",
  waiting_return: "待客户退货",
  returned: "客户已退回",
  received: "商家已收货",
  inspecting: "验货中",
  refund_pending: "待退款",
  refunded: "已退款",
  exchanged: "已换货",
  resent: "已补发",
  completed: "已完成",
  cancelled: "已取消",
  abnormal: "异常"
};

const REFUND_STATUS_TEXT = {
  none: "无退款",
  pending: "待退款",
  processing: "处理中",
  refunded: "已退款",
  partial_refunded: "部分退款",
  failed: "退款失败",
  rejected: "退款拒绝",
  cancelled: "退款取消"
};

module.exports = {
  ORDER_STATUS_TEXT,
  PAYMENT_STATUS_TEXT,
  DELIVERY_STATUS_TEXT,
  AFTER_SALE_TYPE_TEXT,
  AFTER_SALE_REASON_TEXT,
  AFTER_SALE_STATUS_TEXT,
  REFUND_STATUS_TEXT,
  orderStatusMap,
  paymentStatusMap,
  getStatusMeta
};
