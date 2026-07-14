const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const { call, moneyText, toast } = require("../../../utils/api");
const { ensureAnyPermission } = require("../../../utils/auth");
const { formatDateTime } = require("../../../utils/delivery");

const STATUS_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "待发货", value: "pending_shipment" },
  { label: "已创建", value: "created" },
  { label: "已发货", value: "shipped" },
  { label: "已完成", value: "completed" },
  { label: "已取消", value: "cancelled" },
  { label: "异常", value: "abnormal" }
];

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
    groups: [],
    keyword: "",
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
    loading: false,
    initialized: false
  },

  onLoad() {
    initOrientation(this);
    ensureAnyPermission(["shipment:ship", "shipment:merge", "shipment:update", "shipment:complete", "shipment:export"]).then(() => this.load({ reset: true })).catch((err) => toast(err.message));
  },

  onShow() {
    if (!this.data.initialized) return;
    this.load({ reset: true, silent: true });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  onStatusChange(e) {
    this.setData({ statusIndex: Number(e.detail.value) }, () => this.load({ reset: true }));
  },

  load(options = {}) {
    if (this.shipmentsLoading && !options.force) return this.shipmentsLoading;
    if (this.data.loading && !options.force) return Promise.resolve();
    const page = options.reset ? 1 : this.data.page;
    const status = this.data.statusOptions[this.data.statusIndex] || this.data.statusOptions[0];
    this.setData({ loading: !options.silent || !this.data.groups.length });
    this.shipmentsLoading = call("getAdminShipmentGroups", {
      keyword: this.data.keyword,
      status: status.value,
      page,
      pageSize: this.data.pageSize
    }, { showLoading: false }).then((data) => {
      const groups = (data.groups || []).map((group) => ({
        ...group,
        statusText: STATUS_TEXT[group.shippingStatus] || group.shippingStatus,
        totalOrderAmountText: moneyText(group.totalOrderAmount),
        createdAtText: formatDateTime(group.createdAt),
        shippedAtText: formatDateTime(group.shippedAt),
        orderNosText: (group.orderNos || []).join("、")
      }));
      this.setData({
        groups: options.reset ? groups : this.data.groups.concat(groups),
        page: page + 1,
        hasMore: data.hasMore === true,
        initialized: true
      });
    }).catch((err) => toast(err.message))
      .finally(() => {
        this.shipmentsLoading = null;
        this.setData({ loading: false });
      });
    return this.shipmentsLoading;
  },

  search() {
    this.load({ reset: true });
  },

  loadMore() {
    if (this.data.hasMore) this.load();
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/admin/shipments/detail?id=${e.currentTarget.dataset.id}` });
  },

  goOrders() {
    wx.navigateTo({ url: "/pages/admin/orders" });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
