const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const { call, moneyText, toast } = require("../../../utils/api");
const { ensureAnyPermission } = require("../../../utils/auth");
const { formatDateTime } = require("../../../utils/delivery");
const { generateIdempotencyKey } = require("../../../utils/idempotency");
const haptics = require("../../../utils/haptics");

const STATUS_TEXT = {
  created: "待发货",
  pending_shipment: "待发货",
  shipped: "已发货",
  completed: "已完成",
  cancelled: "已取消",
  abnormal: "异常"
};

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    id: "",
    loading: false,
    initialized: false,
    group: null,
    orders: [],
    items: [],
    logs: [],
    shippingCompanyDraft: "",
    trackingNoDraft: "",
    adminRemarkDraft: "",
    saving: false,
    exportResult: null
  },

  onLoad(options = {}) {
    initOrientation(this);
    this.setData({ id: options.id || "" });
    ensureAnyPermission(["shipment:ship", "shipment:merge", "shipment:update", "shipment:complete", "shipment:export"]).then(() => this.load()).catch((err) => toast(err.message));
  },

  onShow() {
    if (this.data.id && this._loadedOnce) this.load({ silent: true });
  },

  load(options = {}) {
    if (this.detailLoading) return this.detailLoading;
    if (this.data.loading && !options.force) return Promise.resolve();
    this.setData({ loading: !options.silent && !this.data.group });
    this.detailLoading = call("getShipmentGroupDetail", { shipmentGroupId: this.data.id }, { showLoading: false }).then((data) => {
      const group = data.shipmentGroup || {};
      const shippingAddress = group.shippingAddress || group.shippingAddressMasked || {};
      this.setData({
        group: {
          ...group,
          shippingAddress,
          statusText: STATUS_TEXT[group.shippingStatus] || group.shippingStatus,
          totalOrderAmountText: moneyText(group.totalOrderAmount),
          totalPaidAmountText: moneyText(group.totalPaidAmount),
          totalUnpaidAmountText: moneyText(group.totalUnpaidAmount),
          createdAtText: formatDateTime(group.createdAt),
          shippedAtText: formatDateTime(group.shippedAt),
          completedAtText: formatDateTime(group.completedAt)
        },
        orders: (data.orders || []).map((order) => ({
          ...order,
          totalAmountText: moneyText(order.totalAmount),
          createdAtText: formatDateTime(order.createdAt)
        })),
        items: (data.itemSummary || []).map((item) => ({
          ...item,
          orderNosText: (item.orderNos || []).join("、")
        })),
        logs: (data.logs || []).map((log) => ({
          ...log,
          createdAtText: formatDateTime(log.createdAt)
        })),
        shippingCompanyDraft: group.shippingCompany || "",
        trackingNoDraft: group.trackingNo || "",
        adminRemarkDraft: group.adminRemark || ""
      });
    }).catch((err) => toast(err.message))
      .finally(() => {
        this._loadedOnce = true;
        this.detailLoading = null;
        this.setData({ loading: false, initialized: true });
      });
    return this.detailLoading;
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  saveInfo() {
    if (!this.data.group) return;
    haptics.medium();
    this.setData({ saving: true });
    call("updateShipmentInfo", {
      shipmentGroupId: this.data.id,
      shippingCompany: this.data.shippingCompanyDraft,
      trackingNo: this.data.trackingNoDraft,
      adminRemark: this.data.adminRemarkDraft,
      shipmentImages: []
    }).then(() => {
      toast("物流信息已保存");
      this.load();
    }).catch((err) => toast(err.message))
      .finally(() => this.setData({ saving: false }));
  },

  confirmShipment() {
    haptics.warning();
    wx.showModal({
      title: "确认发货",
      content: "确认后关联订单会同步为已发货，不会扣库存或改付款。",
      confirmText: "发货",
      success: (res) => {
        if (!res.confirm) return;
        call("confirmShipment", {
          shipmentGroupId: this.data.id,
          shippingCompany: this.data.shippingCompanyDraft,
          trackingNo: this.data.trackingNoDraft,
          adminRemark: this.data.adminRemarkDraft,
          idempotencyKey: generateIdempotencyKey("confirm_shipment")
        }).then(() => {
          toast("已确认发货");
          this.load();
        }).catch((err) => toast(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message));
      }
    });
  },

  cancelShipment() {
    haptics.warning();
    wx.showModal({
      title: "取消合并发货",
      content: "请输入取消原因。取消只解除发货关联，不取消订单、不恢复库存。",
      editable: true,
      placeholderText: "例如：客户要求拆单发货",
      confirmText: "取消发货单",
      success: (res) => {
        if (!res.confirm) return;
        call("cancelMergeShipment", {
          shipmentGroupId: this.data.id,
          cancelReason: res.content || "",
          idempotencyKey: generateIdempotencyKey("cancel_merge_shipment")
        }).then(() => {
          toast("已取消合并发货");
          this.load();
        }).catch((err) => toast(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message));
      }
    });
  },

  completeShipment() {
    haptics.warning();
    wx.showModal({
      title: "标记完成",
      content: "确认该合并发货单已完成配送？",
      confirmText: "完成",
      success: (res) => {
        if (!res.confirm) return;
        call("completeShipment", {
          shipmentGroupId: this.data.id,
          idempotencyKey: generateIdempotencyKey("complete_shipment")
        }).then(() => {
          toast("已标记完成");
          this.load();
        }).catch((err) => toast(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message));
      }
    });
  },

  exportPickingList() {
    call("exportShipmentPickingList", { shipmentGroupId: this.data.id }, { loadingText: "生成 Excel" }).then((data) => {
      this.setData({ exportResult: data });
      toast("导出成功");
    }).catch((err) => toast(err.message));
  },

  copyTrackingNo() {
    const trackingNo = this.data.group && this.data.group.trackingNo;
    if (!trackingNo) return toast("暂无快递单号");
    wx.setClipboardData({ data: trackingNo });
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
      .catch((err) => toast(err.message || "打开失败"))
      .finally(() => wx.hideLoading());
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
