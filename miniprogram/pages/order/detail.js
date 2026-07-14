const { call, moneyText, toast, feedback } = require("../../utils/api");
const { ensureLogin } = require("../../utils/auth");
const { ORDER_STATUS_TEXT, PAYMENT_STATUS_TEXT, orderStatusMap, paymentStatusMap, getStatusMeta } = require("../../utils/status");
const { DELIVERY_TYPE_TEXT, DELIVERY_STATUS_TEXT, formatDateTime } = require("../../utils/delivery");
const { generateIdempotencyKey } = require("../../utils/idempotency");
const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const sync = require("../../utils/sync");
const haptics = require("../../utils/haptics");

const ACTIVE_AFTER_SALE_STATUSES = [
  "pending_review",
  "approved",
  "waiting_return",
  "returned",
  "received",
  "inspecting",
  "refund_pending",
  "abnormal"
];

// 普通用户可以取消的订单状态
const USER_CANCELLABLE_STATUSES = [
  "pending_admin",
  "auto_reviewing"
];

function canUserCancelOrder(order) {
  if (!order) return false;
  if (!USER_CANCELLABLE_STATUSES.includes(order.status)) return false;

  // 已付款不能取消
  const paidAmount = Number(order.paidAmount || 0);
  if (paidAmount > 0) return false;
  if (["paid", "partial_paid"].includes(order.paymentStatus)) return false;

  // 已发货不能取消
  if (["shipped", "completed", "picked_up"].includes(order.deliveryStatus)) return false;

  // 有售后不能取消
  if (order.hasAfterSale === true && ACTIVE_AFTER_SALE_STATUSES.includes(order.afterSaleStatus)) {
    return false;
  }

  return true;
}

function maskPhone(phone) {
  const text = String(phone || "").trim();
  if (!text) return "";
  if (text.length < 7) return text.replace(/.(?=.{2})/g, "*");
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

function maskAddressText(address = {}) {
  const text = String(address.fullAddress || [address.regionText, address.detailAddress].filter(Boolean).join(" ") || "").trim();
  if (!text) return "";
  if (text.length <= 8) return text.replace(/.(?=.{2})/g, "*");
  return `${text.slice(0, 6)}****${text.slice(-2)}`;
}

function buildShippingAddressDisplay(order = {}) {
  const masked = order.shippingAddressMasked || {};
  const full = order.shippingAddress || {};
  const maskedAddressText = masked.fullAddressMasked
    || [masked.regionText, masked.detailAddressMasked].filter(Boolean).join(" ");
  return {
    receiverName: masked.receiverName || full.receiverName || "",
    receiverPhone: masked.receiverPhoneMasked || full.receiverPhoneMasked || maskPhone(full.receiverPhone),
    addressText: maskedAddressText || maskAddressText(full),
    addressTag: masked.addressTag || full.addressTag || ""
  };
}

Page({
  data: {
    id: "",
    order: null,
    loading: true,
    initialized: false,
    cancelling: false,
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false
  },

  onLoad(options) {
    this._detailInitializing = true;
    this.setData({ id: options.id || "" });
    initOrientation(this);
    this._unsubscribeSync = sync.subscribe(this, ["order", "payment", "shipment", "after_sale", "refund"], () => {
      const busy = Boolean(this.orderLoading);
      const request = this.loadOrder({ silent: true });
      if (busy) Promise.resolve(request).finally(() => this.loadOrder({ silent: true })).catch(() => null);
    });
    ensureLogin()
      .then(() => this.loadOrder())
      .catch((err) => {
        this.setData({ loading: false, initialized: true });
        toast(err.message);
      })
      .finally(() => {
        this._detailInitializing = false;
      });
  },

  onShow() {
    if (this._detailInitializing || !this._loadedOnce || !this.data.id) return;
    this.loadOrder({ silent: true });
  },

  onUnload() {
    if (this._unsubscribeSync) this._unsubscribeSync();
    cleanupOrientation(this);
  },

  loadOrder(options = {}) {
    if (this.orderLoading) return this.orderLoading;
    this.setData({ loading: !options.silent && !this.data.order });
    this.orderLoading = call("getOrders", { orderId: this.data.id }, { showLoading: false }).then((data) => {
      const found = data.orders.find((item) => item._id === this.data.id);
      if (!found) {
        feedback.showWarning("订单不存在");
        this.setData({ order: null });
        return;
      }
      const items = (found.items || []).map((item) => ({
        ...item,
        unitPriceText: moneyText(item.unitPrice),
        totalText: moneyText(item.totalAmount)
      }));
      const statusMeta = getStatusMeta(orderStatusMap, found.status, ORDER_STATUS_TEXT[found.status] || found.status);
      const paymentMeta = getStatusMeta(paymentStatusMap, found.paymentStatus, PAYMENT_STATUS_TEXT[found.paymentStatus] || found.paymentStatus);
      const shipment = found.shipmentDisplay || {};
      const order = {
        ...found,
        items,
        displayName: found.itemSummary || found.productName,
        statusText: statusMeta.label,
        statusClass: statusMeta.className,
        statusDescription: statusMeta.description,
        paymentText: paymentMeta.label,
        paymentClass: paymentMeta.className,
        deliveryTypeText: DELIVERY_TYPE_TEXT[found.deliveryType] || "未设置",
        deliveryStatusText: DELIVERY_STATUS_TEXT[found.deliveryStatus] || found.deliveryStatus || "待处理",
        showMergedShipment: shipment.isMergedShipment === true,
        mergeShipmentNoDisplay: shipment.mergeShipmentNo || found.mergeShipmentNo || "",
        shipmentStatusText: this.shipmentStatusText(shipment.shippingStatus || found.shippingStatus || found.deliveryStatus),
        shipmentCompanyDisplay: shipment.shippingCompany || found.shippingCompany || found.expressCompany || "",
        trackingNoDisplay: shipment.trackingNo || found.trackingNo || found.expressNo || "",
        shipmentShippedAtText: formatDateTime(shipment.shippedAt || found.shippedAt),
        shippedAtText: formatDateTime(found.shippedAt),
        pickedUpAtText: formatDateTime(found.pickedUpAt),
        completedAtText: formatDateTime(found.completedAt),
        hasPaymentBatch: Number(found.paymentBatchCount || 0) > 1,
        paymentBatchAmountText: moneyText(found.paymentBatchAmount || found.totalAmount),
        totalText: moneyText(found.totalAmount),
        shippingAddressDisplay: buildShippingAddressDisplay(found),
        afterSaleStatusText: this.afterSaleStatusText(found.afterSaleStatus),
        showAfterSaleEntry: this.canApplyAfterSale(found),
        showAfterSaleProcessing: found.hasAfterSale === true && ACTIVE_AFTER_SALE_STATUSES.includes(found.afterSaleStatus),
        firstAfterSaleId: Array.isArray(found.afterSaleIds) && found.afterSaleIds[0] || "",
        showCancelButton: canUserCancelOrder(found),
        cancelReason: found.cancelReason || ""
      };
      this.setData({ order });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => {
        this._loadedOnce = true;
        this.orderLoading = null;
        this.setData({ loading: false, initialized: true });
      });
    return this.orderLoading;
  },

  triggerAutoReview() {
    haptics.medium();
    call("autoReviewOrder", { orderId: this.data.id })
      .then(() => {
        haptics.success();
        feedback.showSuccess("已刷新审核结果");
        this.loadOrder();
      })
      .catch((err) => {
        haptics.error();
        feedback.showError(err.message);
      });
  },

  goPayment() {
    haptics.medium();
    wx.navigateTo({ url: `/pages/payment/payment?id=${this.data.id}` });
  },

  goAfterSaleApply() {
    const order = this.data.order;
    if (!order) return;
    if (order.showAfterSaleProcessing) {
      haptics.error();
      feedback.showWarning("该订单已有售后处理中，请勿重复提交。");
      return;
    }
    haptics.medium();
    wx.navigateTo({ url: `/pages/after-sale/apply?orderId=${order._id}` });
  },

  goAfterSaleDetail() {
    const order = this.data.order;
    haptics.selection();
    if (order && order.firstAfterSaleId) {
      wx.navigateTo({ url: `/pages/after-sale/detail?id=${order.firstAfterSaleId}` });
      return;
    }
    wx.navigateTo({ url: "/pages/after-sale/list" });
  },

  shipmentStatusText(status) {
    const map = {
      created: "待发货",
      pending_shipment: "待发货",
      waiting_shipping: "待发货",
      shipped: "已发货",
      completed: "已完成",
      cancelled: "已取消",
      abnormal: "异常"
    };
    return map[status] || status || "待处理";
  },

  copyTrackingNo() {
    const trackingNo = this.data.order && this.data.order.trackingNoDisplay;
    if (!trackingNo) return toast("暂无快递单号");
    wx.setClipboardData({ data: trackingNo });
  },

  canApplyAfterSale(order) {
    if (!order) return false;
    if (["pending_review", "pending_admin", "auto_reviewing", "rejected", "cancelled"].includes(order.status)) return false;
    if (order.hasAfterSale === true && ACTIVE_AFTER_SALE_STATUSES.includes(order.afterSaleStatus)) return false;
    const paid = Number(order.paidAmount || 0) > 0 || ["paid", "partial_paid"].includes(order.paymentStatus) || order.status === "paid";
    const delivered = ["waiting_shipping", "pending_shipment", "shipped", "completed", "waiting_pickup", "picked_up"].includes(order.deliveryStatus || order.shippingStatus || "");
    return paid || delivered;
  },

  afterSaleStatusText(status) {
    const map = {
      pending_review: "待人工审核",
      approved: "审核通过",
      rejected: "审核拒绝",
      waiting_return: "待客户退货",
      returned: "客户已退回",
      received: "商家已收货",
      inspecting: "验货中",
      refund_pending: "待退款",
      refunded: "已退款",
      completed: "已完成",
      abnormal: "异常"
    };
    return map[status] || status || "";
  },

  async cancelOrder() {
    if (this.data.cancelling) return;

    const order = this.data.order;
    if (!order) return;

    if (!canUserCancelOrder(order)) {
      haptics.error();
      feedback.showWarning("当前订单状态不能取消");
      return;
    }

    haptics.warning();
    const confirmed = await feedback.confirmAction({
      title: "确认取消订单",
      content: "确定取消该订单吗？",
      confirmText: "确认取消",
      confirmColor: "#9A2D2D"
    });

    if (!confirmed) return;

    this.setData({ cancelling: true });

    call("cancelOrder", {
      orderId: order._id,
      reason: "",
      operatorType: "user",
      idempotencyKey: generateIdempotencyKey("cancel_order")
    })
      .then((data) => {
        haptics.success();
        const message = data.message || "订单已取消";
        feedback.showSuccess(message);

        // 更新当前订单状态，不重新加载（减少闪烁）
        this.setData({
          "order.status": "cancelled",
          "order.statusText": "已取消",
          "order.showCancelButton": false,
          cancelling: false
        });
      })
      .catch((err) => {
        feedback.showError(err.message || "取消订单失败");
        haptics.error();
        this.setData({ cancelling: false });
      });
  }
});
