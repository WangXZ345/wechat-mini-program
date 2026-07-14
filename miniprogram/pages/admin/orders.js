const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const { call, moneyText, toast } = require("../../utils/api");
const { ensureAdmin } = require("../../utils/auth");
const { ORDER_STATUS_TEXT, PAYMENT_STATUS_TEXT } = require("../../utils/status");
const { generateIdempotencyKey } = require("../../utils/idempotency");
const haptics = require("../../utils/haptics");

const RISK_TEXT = {
  normal: "正常",
  important: "重要客户",
  slow_pay: "付款慢",
  risk: "风险客户",
  blocked: "限制下单"
};

const SHIPPING_STATUS_TEXT = {
  pending_shipment: "待发货",
  waiting_shipping: "待发货",
  created: "待发货",
  shipped: "已发货",
  completed: "已完成",
  cancelled: "已取消",
  abnormal: "异常"
};

function shippingTypeText(order = {}) {
  const type = order.shippingType || (order.deliveryType === "self_pickup" ? "pickup" : "delivery");
  return type === "pickup" ? "自提" : "发货";
}

function addressSummary(order = {}) {
  if ((order.shippingType || "") === "pickup" || order.deliveryType === "self_pickup") return "自提订单，无需收货地址";
  const address = order.shippingAddress || order.shippingAddressMasked || {};
  return [
    address.receiverName,
    address.receiverPhoneMasked || address.receiverPhone,
    address.regionText,
    address.detailAddressMasked || address.detailAddress || address.fullAddressMasked || address.fullAddress
  ].filter(Boolean).join(" / ");
}

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    orders: [],
    dateRangeIndex: 0,
    orderStatusIndex: 0,
    paymentStatusIndex: 0,
    shipmentFilterIndex: 0,
    selectedDateRangeLabel: "全部时间",
    selectedOrderStatusLabel: "全部",
    selectedPaymentStatusLabel: "全部",
    isCustomRange: false,
    customStartDate: "",
    customEndDate: "",
    customerKeyword: "",
    productKeyword: "",
    includeCancelled: false,
    isExporting: false,
    exportResult: null,
    loading: false,
    initialized: false,
    dateRangeOptions: [
      { label: "全部时间", value: "all" },
      { label: "今日", value: "today" },
      { label: "昨日", value: "yesterday" },
      { label: "最近 3 天", value: "last3days" },
      { label: "最近 7 天", value: "last7days" },
      { label: "最近 30 天", value: "last30days" },
      { label: "本月", value: "thisMonth" },
      { label: "自定义", value: "custom" }
    ],
    orderStatusOptions: [
      { label: "全部", value: "all" },
      { label: "自动审核中", value: "auto_reviewing" },
      { label: "待管理员审核", value: "pending_admin" },
      { label: "已通过待支付", value: "approved_pending_payment" },
      { label: "待确认付款", value: "pending_payment_confirm" },
      { label: "已付款", value: "paid" },
      { label: "未付款", value: "unpaid" },
      { label: "部分付款", value: "partial_paid" },
      { label: "付款异常", value: "abnormal" },
      { label: "已拒绝", value: "rejected" },
      { label: "已取消", value: "cancelled" }
    ],
    paymentStatusOptions: [
      { label: "全部", value: "all" },
      { label: "未付款", value: "unpaid" },
      { label: "待确认", value: "pending_confirm" },
      { label: "部分付款", value: "partial_paid" },
      { label: "已付款", value: "paid" },
      { label: "付款异常", value: "abnormal" }
    ],
    shipmentFilterOptions: [
      { label: "全部", value: "all" },
      { label: "待发货", value: "pending_shipment" },
      { label: "已合并发货", value: "merged" },
      { label: "未合并发货", value: "unmerged" },
      { label: "已发货", value: "shipped" },
      { label: "同一客户订单", value: "same_customer" }
    ],
    selectedShipmentFilterLabel: "全部",
    selectedOrderIds: [],
    selectedCustomerKey: "",
    canCreateMerge: false,
    actionLocks: {}
  },

  onLoad(options = {}) {
    initOrientation(this);
    this.applyRouteFilters(options);
    ensureAdmin("order:view").then(() => this.load()).catch((err) => toast(err.message));
  },

  onShow() {
    if (!this.data.initialized) return;
    this.load({ silent: Boolean(this.data.orders.length) });
  },

  applyRouteFilters(options = {}) {
    const updates = {};
    const statusMap = {
      pending_review: "pending_admin",
      pending_admin: "pending_admin"
    };
    const statusValue = statusMap[options.status] || options.status || "";
    if (statusValue) {
      const orderStatusIndex = this.data.orderStatusOptions.findIndex((item) => item.value === statusValue);
      if (orderStatusIndex >= 0) {
        updates.orderStatusIndex = orderStatusIndex;
        updates.selectedOrderStatusLabel = this.data.orderStatusOptions[orderStatusIndex].label;
      }
    }

    if (options.paymentStatus) {
      const paymentStatusIndex = this.data.paymentStatusOptions.findIndex((item) => item.value === options.paymentStatus);
      if (paymentStatusIndex >= 0) {
        updates.paymentStatusIndex = paymentStatusIndex;
        updates.selectedPaymentStatusLabel = this.data.paymentStatusOptions[paymentStatusIndex].label;
      }
    }

    const dateMap = {
      today: "today",
      last3days: "last3days",
      last7days: "last7days",
      last30days: "last30days"
    };
    const dateValue = dateMap[options.date] || "";
    if (dateValue) {
      const dateRangeIndex = this.data.dateRangeOptions.findIndex((item) => item.value === dateValue);
      if (dateRangeIndex >= 0) {
        updates.dateRangeIndex = dateRangeIndex;
        updates.selectedDateRangeLabel = this.data.dateRangeOptions[dateRangeIndex].label;
        updates.isCustomRange = false;
      }
    }

    if (Object.keys(updates).length) this.setData(updates);
  },

  load(options = {}) {
    if (this.ordersLoading && !options.force) return this.ordersLoading;
    this.setData({ loading: !options.silent });
    this.ordersLoading = call("getOrders", { admin: true, filters: this.buildFilters() }, { showLoading: false }).then((data) => {
      const orders = data.orders.map((item) => ({
        ...item,
        selected: this.data.selectedOrderIds.includes(item._id),
        displayName: item.itemSummary || item.productName,
        items: (item.items || []).map((detail) => ({
          ...detail,
          unitPriceText: moneyText(detail.unitPrice),
          totalText: moneyText(detail.totalAmount)
        })),
        statusText: ORDER_STATUS_TEXT[item.status] || item.status,
        paymentText: PAYMENT_STATUS_TEXT[item.paymentStatus] || item.paymentStatus || "未提交",
        paymentMethodDisplay: item.paymentMethodName || item.paymentMethod || "未选择",
        paymentRemarkDisplay: item.paymentRemark || (item.paymentMethodSnapshot && item.paymentMethodSnapshot.transferRemark) || "",
        paymentScreenshotUrls: item.paymentScreenshotUrls && item.paymentScreenshotUrls.length
          ? item.paymentScreenshotUrls
          : (item.paymentScreenshotUrl ? [item.paymentScreenshotUrl] : []),
        riskText: RISK_TEXT[item.customerRiskLevel] || RISK_TEXT.normal,
        shippingTypeText: shippingTypeText(item),
        addressSummary: addressSummary(item),
        showRiskTag: ["important", "slow_pay", "risk", "blocked"].includes(item.customerRiskLevel),
        adminNoteDraft: item.adminNote || "",
        adminNoteChanged: false,
        adminNotePanelOpen: false,
        noteLogsOpen: false,
        noteLogsLoading: false,
        noteLogs: [],
        reviewLoading: false,
        reviewApproveLoading: false,
        reviewRejectLoading: false,
        adminNoteUpdatedAtText: this.formatDate(item.adminNoteUpdatedAt),
        isPaid: item.status === "paid" || item.paymentStatus === "paid",
        customerKey: item.userId || item.userOpenid || "",
        shippingStatusText: SHIPPING_STATUS_TEXT[item.shippingStatus || item.deliveryStatus] || item.shippingStatus || item.deliveryStatus || "待处理",
        shipmentTagText: item.isMergedShipment ? "已合并" : (["shipped", "completed"].includes(item.shippingStatus || item.deliveryStatus) ? "已发货" : "未合并"),
        shipmentCompanyDisplay: item.shippingCompany || item.expressCompany || "",
        trackingNoDisplay: item.trackingNo || item.expressNo || "",
        hasPaymentBatch: Number(item.paymentBatchCount || 0) > 1,
        paymentBatchAmountText: moneyText(item.paymentBatchAmount || item.totalAmount),
        totalText: moneyText(item.totalAmount),
        cancelLoading: false,
        canAdminCancel: item.status === "approved_pending_payment"
          && Number(item.paidAmount || 0) === 0
          && !["paid", "partial_paid"].includes(item.paymentStatus)
          && !["shipped", "completed", "picked_up"].includes(item.deliveryStatus)
      }));
      const nextOrders = this.applyShipmentFilter(orders);
      const state = {
        orders: nextOrders,
        initialized: true
      };
      this.setData(state);
    }).catch((err) => toast(err.message));
    this.ordersLoading.finally(() => {
      this.ordersLoading = null;
      this.setData({ loading: false });
    });
    return this.ordersLoading;
  },

  applyShipmentFilter(orders) {
    const option = this.data.shipmentFilterOptions[this.data.shipmentFilterIndex] || this.data.shipmentFilterOptions[0];
    const selectedCustomerKey = this.data.selectedCustomerKey;
    return orders.filter((order) => {
      const shippingStatus = order.shippingStatus || order.deliveryStatus || "";
      if (option.value === "pending_shipment") return ["pending_shipment", "waiting_shipping", "created"].includes(shippingStatus);
      if (option.value === "merged") return order.isMergedShipment === true;
      if (option.value === "unmerged") return order.isMergedShipment !== true;
      if (option.value === "shipped") return ["shipped", "completed"].includes(shippingStatus);
      if (option.value === "same_customer" && selectedCustomerKey) return order.customerKey === selectedCustomerKey;
      return true;
    });
  },

  formatDate(value) {
    if (!value) return "暂无";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "暂无";
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-") + " " + [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0")
    ].join(":");
  },

  findOrderIndex(id) {
    return this.data.orders.findIndex((item) => item._id === id);
  },

  setOrderPatch(id, patch) {
    const index = this.findOrderIndex(id);
    if (index < 0) return;
    const updates = {};
    Object.keys(patch).forEach((key) => {
      updates[`orders[${index}].${key}`] = patch[key];
    });
    this.setData(updates);
  },

  toggleOrderNote(e) {
    const id = e.currentTarget.dataset.id;
    const order = this.data.orders[this.findOrderIndex(id)];
    if (!order) return;
    this.setOrderPatch(id, { adminNotePanelOpen: !order.adminNotePanelOpen });
  },

  onOrderNoteInput(e) {
    const id = e.currentTarget.dataset.id;
    const value = e.detail.value || "";
    const order = this.data.orders[this.findOrderIndex(id)];
    if (!order) return;
    this.setOrderPatch(id, {
      adminNoteDraft: value,
      adminNoteChanged: value.trim() !== String(order.adminNote || "")
    });
  },

  saveOrderNote(e) {
    const id = e.currentTarget.dataset.id;
    const order = this.data.orders[this.findOrderIndex(id)];
    if (!order) return;
    const adminNote = String(order.adminNoteDraft || "").trim();
    if (adminNote.length > 500) return toast("订单备注最多 500 字");
    if (!order.adminNoteChanged) return toast("备注未修改");
    call("updateOrderAdminNote", { orderId: id, adminNote }).then((data) => {
      toast(data.unchanged ? "备注未修改" : "备注已保存");
      return this.load();
    }).catch((err) => toast(err.message));
  },

  clearOrderNote(e) {
    const id = e.currentTarget.dataset.id;
    const order = this.data.orders[this.findOrderIndex(id)];
    if (!order || !String(order.adminNote || order.adminNoteDraft || "").trim()) return toast("暂无备注可清空");
    wx.showModal({
      title: "清空备注",
      content: "确定清空这条订单的管理员备注吗？",
      confirmText: "清空",
      success: (res) => {
        if (!res.confirm) return;
        call("updateOrderAdminNote", { orderId: id, adminNote: "" }).then(() => {
          toast("备注已保存");
          this.load();
        }).catch((err) => toast(err.message));
      }
    });
  },

  loadOrderNoteLogs(e) {
    const id = e.currentTarget.dataset.id;
    const order = this.data.orders[this.findOrderIndex(id)];
    if (!order) return;
    if (order.noteLogsOpen) {
      this.setOrderPatch(id, { noteLogsOpen: false });
      return;
    }
    this.setOrderPatch(id, { noteLogsOpen: true, noteLogsLoading: true });
    call("getNoteLogs", { targetType: "order", targetId: id, page: 1, pageSize: 20 }).then((data) => {
      const logs = (data.logs || []).map((log) => ({
        ...log,
        createdAtText: this.formatDate(log.createdAt)
      }));
      this.setOrderPatch(id, { noteLogs: logs });
    }).catch((err) => toast(err.message))
      .finally(() => this.setOrderPatch(id, { noteLogsLoading: false }));
  },

  startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  },

  endOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  },

  dateText(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  },

  dateFromText(text, endOfDay = false) {
    if (!text) return "";
    const parts = text.split("-").map((item) => Number(item));
    if (parts.length !== 3 || parts.some((item) => Number.isNaN(item))) return "";
    const date = new Date(parts[0], parts[1] - 1, parts[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return date.toISOString();
  },

  rangeDates() {
    const option = this.data.dateRangeOptions[this.data.dateRangeIndex] || this.data.dateRangeOptions[0];
    const now = new Date();
    if (option.value === "all") {
      return { startDate: "", endDate: "" };
    }
    if (option.value === "today") {
      return { startDate: this.startOfDay(now).toISOString(), endDate: this.endOfDay(now).toISOString() };
    }
    if (option.value === "yesterday") {
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return { startDate: this.startOfDay(yesterday).toISOString(), endDate: this.endOfDay(yesterday).toISOString() };
    }
    if (option.value === "last7days") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      return { startDate: this.startOfDay(start).toISOString(), endDate: this.endOfDay(now).toISOString() };
    }
    if (option.value === "last3days") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
      return { startDate: this.startOfDay(start).toISOString(), endDate: this.endOfDay(now).toISOString() };
    }
    if (option.value === "last30days") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
      return { startDate: this.startOfDay(start).toISOString(), endDate: this.endOfDay(now).toISOString() };
    }
    if (option.value === "thisMonth") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startDate: this.startOfDay(start).toISOString(), endDate: this.endOfDay(now).toISOString() };
    }
    if (option.value === "custom") {
      return {
        startDate: this.dateFromText(this.data.customStartDate),
        endDate: this.dateFromText(this.data.customEndDate, true)
      };
    }
    return { startDate: this.startOfDay(now).toISOString(), endDate: this.endOfDay(now).toISOString() };
  },

  buildFilters() {
    const dateRange = this.rangeDates();
    const orderStatus = this.data.orderStatusOptions[this.data.orderStatusIndex] || this.data.orderStatusOptions[0];
    const paymentStatus = this.data.paymentStatusOptions[this.data.paymentStatusIndex] || this.data.paymentStatusOptions[0];
    return {
      ...dateRange,
      orderStatus: orderStatus.value,
      paymentStatus: paymentStatus.value,
      customerKeyword: this.data.customerKeyword.trim(),
      productKeyword: this.data.productKeyword.trim(),
      includeCancelled: this.data.includeCancelled
    };
  },

  filterSummary(exportType) {
    const dateRange = this.data.dateRangeOptions[this.data.dateRangeIndex] || this.data.dateRangeOptions[0];
    const orderStatus = this.data.orderStatusOptions[this.data.orderStatusIndex] || this.data.orderStatusOptions[0];
    const paymentStatus = this.data.paymentStatusOptions[this.data.paymentStatusIndex] || this.data.paymentStatusOptions[0];
    return [
      `导出模式：${exportType === "detail" ? "商品明细" : "订单汇总"}`,
      `时间范围：${dateRange.label}`,
      `订单状态：${orderStatus.label}`,
      `付款状态：${paymentStatus.label}`,
      `客户关键词：${this.data.customerKeyword || "无"}`,
      `商品关键词：${this.data.productKeyword || "无"}`,
      `包含已取消：${this.data.includeCancelled ? "是" : "否"}`,
      `预计订单数：${this.data.orders.length}`
    ].join("\n");
  },

  onDateRangeChange(e) {
    const index = Number(e.detail.value);
    const option = this.data.dateRangeOptions[index] || this.data.dateRangeOptions[0];
    this.setData({
      dateRangeIndex: index,
      selectedDateRangeLabel: option.label,
      isCustomRange: option.value === "custom",
      exportResult: null
    });
  },

  onOrderStatusChange(e) {
    const index = Number(e.detail.value);
    const option = this.data.orderStatusOptions[index] || this.data.orderStatusOptions[0];
    this.setData({ orderStatusIndex: index, selectedOrderStatusLabel: option.label, exportResult: null });
  },

  onPaymentStatusChange(e) {
    const index = Number(e.detail.value);
    const option = this.data.paymentStatusOptions[index] || this.data.paymentStatusOptions[0];
    this.setData({ paymentStatusIndex: index, selectedPaymentStatusLabel: option.label, exportResult: null });
  },

  onShipmentFilterChange(e) {
    const index = Number(e.detail.value);
    const option = this.data.shipmentFilterOptions[index] || this.data.shipmentFilterOptions[0];
    this.setData({
      shipmentFilterIndex: index,
      selectedShipmentFilterLabel: option.label,
      exportResult: null
    }, () => this.load());
  },

  onStartDateChange(e) {
    this.setData({ customStartDate: e.detail.value, exportResult: null });
  },

  onEndDateChange(e) {
    this.setData({ customEndDate: e.detail.value, exportResult: null });
  },

  onCustomerKeyword(e) {
    this.setData({ customerKeyword: e.detail.value, exportResult: null });
  },

  onProductKeyword(e) {
    this.setData({ productKeyword: e.detail.value, exportResult: null });
  },

  onIncludeCancelled(e) {
    this.setData({ includeCancelled: e.detail.value, exportResult: null });
  },

  resetFilters() {
    this.setData({
      dateRangeIndex: 0,
      orderStatusIndex: 0,
      paymentStatusIndex: 0,
      shipmentFilterIndex: 0,
      selectedDateRangeLabel: "全部时间",
      selectedOrderStatusLabel: "全部",
      selectedPaymentStatusLabel: "全部",
      selectedShipmentFilterLabel: "全部",
      isCustomRange: false,
      customStartDate: "",
      customEndDate: "",
      customerKeyword: "",
      productKeyword: "",
      includeCancelled: false,
      exportResult: null,
      selectedOrderIds: [],
      selectedCustomerKey: "",
      canCreateMerge: false
    }, () => this.load());
  },

  updateSelectionState(selectedOrderIds) {
    const selectedOrders = this.data.orders.filter((order) => selectedOrderIds.includes(order._id));
    const selectedCustomerKey = selectedOrders[0] ? selectedOrders[0].customerKey : "";
    const updates = { selectedOrderIds, selectedCustomerKey, canCreateMerge: selectedOrderIds.length >= 2 };
    this.data.orders.forEach((order, index) => {
      updates[`orders[${index}].selected`] = selectedOrderIds.includes(order._id);
    });
    this.setData(updates);
  },

  toggleSelectOrder(e) {
    const id = e.currentTarget.dataset.id;
    const order = this.data.orders.find((item) => item._id === id);
    if (!order) return;
    haptics.selection();
    let selectedOrderIds = this.data.selectedOrderIds.slice();
    if (selectedOrderIds.includes(id)) {
      selectedOrderIds = selectedOrderIds.filter((item) => item !== id);
    } else {
      selectedOrderIds.push(id);
    }
    this.updateSelectionState(selectedOrderIds);
  },

  clearSelection() {
    this.updateSelectionState([]);
  },

  goShipments() {
    wx.navigateTo({ url: "/pages/admin/shipments/index" });
  },

  createMergeShipmentFromSelection() {
    const orderIds = this.data.selectedOrderIds;
    if (orderIds.length < 2) return toast("请至少选择 2 个订单");
    haptics.medium();
    call("checkMergeShipmentEligibility", { orderIds }).then((data) => {
      if (!data.canMerge) {
        const message = (data.failureMessages || []).join("；") || "所选订单不能合并发货";
        wx.showModal({ title: "不能合并", content: message, showCancel: false });
        return;
      }
      wx.navigateTo({
        url: `/pages/admin/shipments/merge-confirm?orderIds=${encodeURIComponent(orderIds.join(","))}`,
        success: (res) => {
          if (res.eventChannel) res.eventChannel.emit("mergeShipmentEligibility", data);
        }
      });
    }).catch((err) => toast(err.message));
  },

  confirmExport(e) {
    if (this.data.isExporting) return;
    const exportType = e.currentTarget.dataset.type;
    const filters = this.buildFilters();
    wx.showModal({
      title: "确认导出",
      content: this.filterSummary(exportType),
      confirmText: "导出",
      success: (res) => {
        if (res.confirm) this.exportOrders(exportType, filters);
      }
    });
  },

  exportOrders(exportType, filters) {
    this.setData({ isExporting: true, exportResult: null });
    wx.showLoading({ title: "正在生成 Excel，请稍候", mask: true });
    wx.cloud.callFunction({
      name: "exportOrdersExcel",
      data: { exportType, filters }
    }).then((res) => {
      const result = res.result || {};
      if (!result.ok) throw new Error(result.message || "导出失败");
      this.setData({ exportResult: result.data });
      toast("导出成功");
    }).catch((err) => {
      toast(err.message || "导出失败");
    }).finally(() => {
      wx.hideLoading();
      this.setData({ isExporting: false });
    });
  },

  copyExportLink() {
    const fileUrl = this.data.exportResult && this.data.exportResult.fileUrl;
    if (!fileUrl) return toast("暂无导出链接");
    wx.setClipboardData({ data: fileUrl });
  },

  openExportFile() {
    const fileID = this.data.exportResult && this.data.exportResult.fileID;
    if (!fileID) return toast("暂无文件");
    wx.showLoading({ title: "打开中", mask: true });
    wx.cloud.downloadFile({ fileID })
      .then((res) => wx.openDocument({ filePath: res.tempFilePath, showMenu: true }))
      .catch((err) => toast(err.message || "打开文件失败"))
      .finally(() => wx.hideLoading());
  },

  downloadExportFile() {
    const fileID = this.data.exportResult && this.data.exportResult.fileID;
    if (!fileID) return toast("暂无文件");
    wx.showLoading({ title: "下载中", mask: true });
    wx.cloud.downloadFile({ fileID })
      .then((res) => wx.saveFile({ tempFilePath: res.tempFilePath }))
      .then(() => toast("文件已保存"))
      .catch((err) => toast(err.message || "下载文件失败"))
      .finally(() => wx.hideLoading());
  },

  review(e) {
    const orderId = e.currentTarget.dataset.id;
    const action = e.currentTarget.dataset.action;
    const lockKey = `review:${action}:${orderId}`;
    const order = this.data.orders[this.findOrderIndex(orderId)];
    if (this.data.actionLocks[lockKey] || (order && order.reviewLoading)) return;
    haptics.warning();
    this.setData({ [`actionLocks.${lockKey}`]: true });
    this.setOrderPatch(orderId, {
      reviewLoading: true,
      reviewApproveLoading: action === "approve",
      reviewRejectLoading: action === "reject"
    });
    call("adminReviewOrder", {
      orderId,
      action,
      idempotencyKey: generateIdempotencyKey(`${action}_order_${orderId}`)
    }).then(() => {
      haptics.success();
      toast("已处理");
      this.load();
    }).catch((err) => {
      if (err.code === "IDEMPOTENCY_PROCESSING") this.load();
      haptics.error();
      toast(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message);
    }).finally(() => {
      this.setData({ [`actionLocks.${lockKey}`]: false });
      this.setOrderPatch(orderId, {
        reviewLoading: false,
        reviewApproveLoading: false,
        reviewRejectLoading: false
      });
    });
  },

  markPayment(e) {
    const status = e.currentTarget.dataset.status;
    const orderId = e.currentTarget.dataset.id;
    const lockKey = `payment:${status}:${orderId}`;
    if (this.data.actionLocks[lockKey]) return;
    haptics.warning();
    if (status === "partial_paid") {
      this.setData({ [`actionLocks.${lockKey}`]: true });
      wx.showModal({
        title: "确认部分付款",
        content: "请输入实收金额（元）",
        editable: true,
        placeholderText: "例如 600.00",
        success: (res) => {
          if (!res.confirm) {
            this.setData({ [`actionLocks.${lockKey}`]: false });
            return;
          }
          call("adminUpdatePayment", {
            orderId,
            paymentStatus: "partial_paid",
            paidAmount: res.content || "",
            remark: "后台确认部分付款",
            idempotencyKey: generateIdempotencyKey(`confirm_payment_partial_${orderId}`)
          }).then(() => {
            toast("已确认部分付款");
            this.load();
          }).catch((err) => toast(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message))
            .finally(() => this.setData({ [`actionLocks.${lockKey}`]: false }));
        }
      });
      return;
    }

    if (status === "unpaid") {
      this.setData({ [`actionLocks.${lockKey}`]: true });
      wx.showModal({
        title: "驳回付款截图",
        content: "请输入驳回原因",
        editable: true,
        placeholderText: "例如：截图金额不清晰",
        success: (res) => {
          if (!res.confirm) {
            this.setData({ [`actionLocks.${lockKey}`]: false });
            return;
          }
          call("adminUpdatePayment", {
            orderId,
            paymentStatus: "unpaid",
            remark: res.content || "驳回付款截图",
            idempotencyKey: generateIdempotencyKey(`reject_payment_${orderId}`)
          }).then(() => {
            toast("已驳回");
            this.load();
          }).catch((err) => toast(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message))
            .finally(() => this.setData({ [`actionLocks.${lockKey}`]: false }));
        }
      });
      return;
    }

    this.setData({ [`actionLocks.${lockKey}`]: true });
    call("adminUpdatePayment", {
      orderId,
      paymentStatus: status,
      remark: status === "abnormal" ? "后台标记付款异常" : "后台确认全额付款",
      idempotencyKey: generateIdempotencyKey(`${status === "paid" ? "confirm_payment" : "update_payment"}_${status}_${orderId}`)
    }).then(() => {
      toast(status === "paid" ? "已确认付款" : "已更新");
      this.load();
    }).catch((err) => {
      toast(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message);
    }).finally(() => this.setData({ [`actionLocks.${lockKey}`]: false }));
  },

  cancelOrder(e) {
    const orderId = e.currentTarget.dataset.id;
    const order = this.data.orders.find(item => item._id === orderId);
    if (!order) return;

    haptics.warning();
    wx.showModal({
      title: "确认取消订单",
      content: "确定取消该订单吗？\n取消后不可恢复",
      confirmText: "确认取消",
      confirmColor: "#9A2D2D",
      success: (res) => {
        if (!res.confirm) return;

        this.setOrderPatch(orderId, { cancelLoading: true });

        call("cancelOrder", {
          orderId,
          reason: "管理员取消",
          operatorType: "admin",
          idempotencyKey: generateIdempotencyKey(`admin_cancel_order`)
        }).then((data) => {
          const message = data.message || "订单已取消";
          toast(message);

          // 只更新当前订单状态，不刷新整个列表（减少闪烁）
          this.setOrderPatch(orderId, {
            status: "cancelled",
            statusText: "已取消",
            cancelLoading: false,
            reviewLoading: false,
            canAdminCancel: false
          });
        }).catch((err) => {
          const message = err.code === "IDEMPOTENCY_PROCESSING"
            ? "操作正在处理中，请稍候"
            : err.message || "取消订单失败";
          toast(message);
          this.setOrderPatch(orderId, { cancelLoading: false });
        });
      }
    });
  },

  onPullDownRefresh() {
    this.load().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
