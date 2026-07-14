const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const { call, moneyText, toast } = require("../../../utils/api");
const { ensureAnyPermission, profileHasAnyPermission, profileHasPermission } = require("../../../utils/auth");
const { DELIVERY_TYPE_TEXT, DELIVERY_STATUS_TEXT, formatDateTime } = require("../../../utils/delivery");
const { PAYMENT_STATUS_TEXT } = require("../../../utils/status");
const haptics = require("../../../utils/haptics");

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    orders: [],
    loading: false,
    initialized: false,
    deliveryTypeIndex: 0,
    deliveryStatusIndex: 0,
    paymentStatusIndex: 0,
    deliveryTypeOptions: [
      { label: "全部", value: "all" },
      { label: "自提", value: "self_pickup" },
      { label: "发货", value: "shipping" }
    ],
    deliveryStatusOptions: [
      { label: "全部", value: "all" },
      { label: "待自提", value: "waiting_pickup" },
      { label: "已自提", value: "picked_up" },
      { label: "待发货", value: "waiting_shipping" },
      { label: "已发货", value: "shipped" },
      { label: "已完成", value: "completed" },
      { label: "售后中", value: "after_sales" }
    ],
    paymentStatusOptions: [
      { label: "全部", value: "all" },
      { label: "已付款", value: "paid" },
      { label: "未付款", value: "unpaid" },
      { label: "待确认付款", value: "pending_confirm" },
      { label: "部分付款", value: "partial_paid" },
      { label: "付款异常", value: "abnormal" }
    ],
    permissions: {
      canUpdate: false,
      canShip: false,
      canComplete: false
    }
  },

  onLoad() {
    initOrientation(this);
    ensureAnyPermission(["shipment:ship", "order:ship", "shipment:update", "shipment:complete"]).then((profile) => {
      this.setData({
        permissions: {
          canUpdate: profileHasPermission(profile, "shipment:update"),
          canShip: profileHasAnyPermission(profile, ["shipment:ship", "order:ship"]),
          canComplete: profileHasPermission(profile, "shipment:complete")
        }
      });
      return this.load();
    }).catch((err) => toast(err.message));
  },

  onShow() {
    if (!this.data.initialized) return;
    this.load({ silent: true });
  },

  selectedLabel(options, index) {
    return (options[index] || options[0]).label;
  },

  buildFilters() {
    const deliveryType = this.data.deliveryTypeOptions[this.data.deliveryTypeIndex] || this.data.deliveryTypeOptions[0];
    const deliveryStatus = this.data.deliveryStatusOptions[this.data.deliveryStatusIndex] || this.data.deliveryStatusOptions[0];
    const paymentStatus = this.data.paymentStatusOptions[this.data.paymentStatusIndex] || this.data.paymentStatusOptions[0];
    return {
      deliveryType: deliveryType.value,
      deliveryStatus: deliveryStatus.value,
      paymentStatus: paymentStatus.value,
      includeCancelled: true
    };
  },

  load(options = {}) {
    if (this.deliveryLoading && !options.force) return this.deliveryLoading;
    if (this.data.loading && !options.force) return Promise.resolve();
    this.setData({ loading: !options.silent && !this.data.orders.length });
    this.deliveryLoading = call("getOrders", { admin: true, filters: this.buildFilters(), limit: 100 }, { showLoading: false }).then((data) => {
      const orders = (data.orders || [])
        .filter((order) => order.deliveryType)
        .map((order) => ({
          ...order,
          displayName: order.itemSummary || order.productName,
          deliveryTypeText: DELIVERY_TYPE_TEXT[order.deliveryType] || "未设置",
          deliveryStatusText: DELIVERY_STATUS_TEXT[order.deliveryStatus] || order.deliveryStatus || "待处理",
          paymentText: PAYMENT_STATUS_TEXT[order.paymentStatus] || order.paymentStatus || "未提交",
          createdAtText: formatDateTime(order.createdAt),
          shippedAtText: formatDateTime(order.shippedAt),
          pickedUpAtText: formatDateTime(order.pickedUpAt),
          totalText: moneyText(order.totalAmount),
          expressCompanyDraft: order.expressCompany || "",
          expressNoDraft: order.expressNo || "",
          deliveryRemarkDraft: order.deliveryRemark || "",
          deliveryImageDraft: order.deliveryImageUrl || ""
        }));
      this.setData({ orders, initialized: true });
    }).catch((err) => toast(err.message))
      .finally(() => {
        this.deliveryLoading = null;
        this.setData({ loading: false });
      });
    return this.deliveryLoading;
  },

  onDeliveryTypeChange(e) {
    this.setData({ deliveryTypeIndex: Number(e.detail.value) }, () => this.load());
  },

  onDeliveryStatusChange(e) {
    this.setData({ deliveryStatusIndex: Number(e.detail.value) }, () => this.load());
  },

  onPaymentStatusChange(e) {
    this.setData({ paymentStatusIndex: Number(e.detail.value) }, () => this.load());
  },

  findOrderIndex(id) {
    return this.data.orders.findIndex((item) => item._id === id);
  },

  onDraftInput(e) {
    const id = e.currentTarget.dataset.id;
    const field = e.currentTarget.dataset.field;
    const index = this.findOrderIndex(id);
    if (index < 0) return;
    this.setData({ [`orders[${index}].${field}`]: e.detail.value });
  },

  uploadImage(e) {
    const id = e.currentTarget.dataset.id;
    const index = this.findOrderIndex(id);
    if (index < 0) return;
    haptics.medium();
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file || !file.tempFilePath) return toast("未选择图片");
        wx.showLoading({ title: "上传中", mask: true });
        const ext = file.tempFilePath.split(".").pop() || "jpg";
        wx.cloud.uploadFile({
          cloudPath: `delivery/${id}-${Date.now()}.${ext}`,
          filePath: file.tempFilePath
        }).then((uploadRes) => {
          haptics.success();
          this.setData({ [`orders[${index}].deliveryImageDraft`]: uploadRes.fileID });
          toast("图片已上传");
        }).catch((err) => toast(err.message || "上传失败"))
          .finally(() => wx.hideLoading());
      }
    });
  },

  updateDelivery(e) {
    const id = e.currentTarget.dataset.id;
    const action = e.currentTarget.dataset.action;
    const order = this.data.orders[this.findOrderIndex(id)];
    if (!order) return;
    const { canUpdate, canShip, canComplete } = this.data.permissions;
    if ((action === "confirm_shipping" || action === "mark_picked_up") && !canShip) {
      haptics.error();
      return toast("需要发货权限（shipment:ship 或 order:ship）");
    }
    if (action === "complete" && !canComplete) {
      haptics.error();
      return toast("需要完成发货权限（shipment:complete）");
    }
    if (action === "after_sales" && !canUpdate) {
      haptics.error();
      return toast("需要更新发货状态权限（shipment:update）");
    }
    haptics.warning();
    call("adminUpdateDeliveryStatus", {
      orderId: id,
      action,
      expressCompany: order.expressCompanyDraft,
      expressNo: order.expressNoDraft,
      remark: order.deliveryRemarkDraft,
      imageUrl: order.deliveryImageDraft
    }).then(() => {
      toast("已更新配送状态");
      haptics.success();
      this.load();
    }).catch((err) => {
      haptics.error();
      toast(err.message);
    });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
