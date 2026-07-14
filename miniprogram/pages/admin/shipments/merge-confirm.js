const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const { call, moneyText, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");
const { formatDateTime } = require("../../../utils/delivery");
const { getOrCreateSubmitKey, clearSubmitKey } = require("../../../utils/idempotency");
const haptics = require("../../../utils/haptics");

function statusText(value) {
  const map = {
    paid: "已付款",
    partial_paid: "部分付款",
    unpaid: "未付款",
    pending_confirm: "待确认",
    approved_pending_payment: "已通过待支付",
    pending_shipment: "待发货",
    shipped: "已发货",
    completed: "已完成"
  };
  return map[value] || value || "未设置";
}

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    orderIds: [],
    eligibility: null,
    summary: null,
    itemSummary: [],
    creating: false
  },

  onLoad(options = {}) {
    initOrientation(this);
    const orderIds = String(options.orderIds || "").split(",").map((item) => item.trim()).filter(Boolean);
    this.setData({ orderIds });
    const eventChannel = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (eventChannel && eventChannel.on) {
      eventChannel.on("mergeShipmentEligibility", (data) => {
        const previewOrderIds = data && data.summary && data.summary.orderIds;
        if (Array.isArray(previewOrderIds) && previewOrderIds.join("|") === orderIds.join("|")) {
          this.applyEligibility(data);
        }
      });
    }
    ensureAdmin("shipment:merge").then(() => this.load()).catch((err) => toast(err.message));
  },

  load() {
    return call("checkMergeShipmentEligibility", { orderIds: this.data.orderIds })
      .then((data) => this.applyEligibility(data))
      .catch((err) => toast(err.message));
  },

  applyEligibility(data) {
    const summary = data.summary || {};
    const maskedAddress = summary.shippingAddressMasked || {};
    const shapedOrders = (summary.orders || []).map((order) => ({
      ...order,
      createdAtText: formatDateTime(order.createdAt),
      paymentText: statusText(order.paymentStatus),
      statusText: statusText(order.status),
      amountText: moneyText(order.totalAmount)
    }));
    this.setData({
      eligibility: data,
      summary: {
        ...summary,
        shippingAddressMasked: maskedAddress,
        orders: shapedOrders,
        totalOrderAmountText: moneyText(summary.totalOrderAmount),
        totalPaidAmountText: moneyText(summary.totalPaidAmount),
        totalUnpaidAmountText: moneyText(summary.totalUnpaidAmount)
      },
      itemSummary: (data.itemSummary || []).map((item) => ({
        ...item,
        orderNosText: (item.orderNos || []).join("、")
      }))
    });
  },

  createShipment() {
    if (this.data.creating) return;
    if (!this.data.eligibility || !this.data.eligibility.canMerge) {
      return toast("所选订单暂不能合并发货");
    }
    haptics.warning();
    wx.showModal({
      title: "创建合并发货单",
      content: "确认后只创建物流关联，不改变订单金额、付款记录和库存。",
      confirmText: "创建",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ creating: true });
        const idempotencyKey = getOrCreateSubmitKey(`create_merge_shipment_${this.data.orderIds.join("_")}`);
        call("createMergeShipment", { orderIds: this.data.orderIds, idempotencyKey })
          .then((data) => {
            clearSubmitKey(`create_merge_shipment_${this.data.orderIds.join("_")}`);
            toast(data.reused ? "已存在合并发货单" : "合并发货单已创建");
            wx.redirectTo({ url: `/pages/admin/shipments/detail?id=${data.shipmentGroupId}` });
          })
          .catch((err) => {
            if (err.code === "IDEMPOTENCY_KEY_CONFLICT") clearSubmitKey(`create_merge_shipment_${this.data.orderIds.join("_")}`);
            toast(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message);
          })
          .finally(() => this.setData({ creating: false }));
      }
    });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
