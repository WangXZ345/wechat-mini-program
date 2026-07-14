const { call, moneyText, feedback } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin } = require("../../utils/auth");
const { cartItemFromAddResult, upsertCartCacheItem, writeProductPreview } = require("../../utils/performanceCache");

const PAGE_SIZE = 20;
const SORT_LABELS = {
  purchaseCount: "按次数",
  totalQuantity: "按数量",
  lastPurchasedAt: "按最近购买"
};

function formatDate(value) {
  if (!value) return "暂无";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

Page({
  data: {
    list: [],
    page: 1,
    pageSize: PAGE_SIZE,
    hasMore: false,
    sortBy: "purchaseCount",
    sortOptions: [
      { value: "purchaseCount", label: SORT_LABELS.purchaseCount },
      { value: "totalQuantity", label: SORT_LABELS.totalQuantity },
      { value: "lastPurchasedAt", label: SORT_LABELS.lastPurchasedAt }
    ],
    loading: false,
    refreshing: false,
    loadingMore: false,
    addingCartId: "",
    favoriteChangingId: ""
  },

  onLoad() {
    ensureLogin()
      .then(() => ensureFrontendAccess())
      .then(() => this.load({ reset: true }))
      .catch((err) => feedback.showError(err.message));
  },

  onShow() {
    ensureFrontendAccess().then(() => {
      if (this.data.list.length) this.load({ reset: true });
    }).catch(() => null);
  },

  formatItem(item) {
    return {
      ...item,
      priceText: moneyText(item.price),
      totalAmountText: moneyText(item.totalAmount),
      lastPurchasedText: formatDate(item.lastPurchasedAt),
      statusText: item.unavailable ? item.unavailableReason : "正常"
    };
  },

  load(options = {}) {
    const reset = options.reset !== false;
    const page = reset ? 1 : this.data.page + 1;
    if (this.data.loading || this.data.refreshing || this.data.loadingMore) return Promise.resolve();
    if (!reset && !this.data.hasMore) return Promise.resolve();
    if (reset) {
      const showSkeleton = !this.data.list.length;
      this.setData({
        loading: showSkeleton,
        refreshing: !showSkeleton
      });
    } else {
      this.setData({ loadingMore: true });
    }

    return call("getFrequentPurchaseList", {
      sortBy: this.data.sortBy,
      page,
      pageSize: this.data.pageSize
    }, { showLoading: false }).then((data) => {
      const rows = (data.list || []).map((item) => this.formatItem(item));
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page,
        hasMore: Boolean(data.hasMore)
      });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ loading: false, refreshing: false, loadingMore: false }));
  },

  changeSort(e) {
    const sortBy = e.currentTarget.dataset.value;
    if (!sortBy || sortBy === this.data.sortBy || this.data.loading || this.data.refreshing || this.data.loadingMore) return;
    this.setData({ sortBy }, () => this.load({ reset: true }));
  },

  goShop() {
    wx.switchTab({ url: "/pages/index/index" });
  },

  goDetail(e) {
    const productId = e.currentTarget.dataset.id;
    if (!productId) return;
    const product = this.data.list.find((item) => item.productId === productId || item._id === productId);
    if (product) writeProductPreview(product);
    wx.navigateTo({ url: `/pages/product/detail?id=${productId}` });
  },

  stopTap() {},

  addToCart(e) {
    const productId = e.currentTarget.dataset.id;
    const item = this.data.list.find((row) => row.productId === productId);
    if (!item || item.unavailable || this.data.addingCartId) return;
    this.setData({ addingCartId: productId });
    call("addToCart", { productId, quantity: 1 }, { showLoading: false })
      .then((data) => {
        upsertCartCacheItem(cartItemFromAddResult(data, item, 1));
        feedback.showSuccess("已加入购物车");
      })
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ addingCartId: "" }));
  },

  toggleFavorite(e) {
    const productId = e.currentTarget.dataset.id;
    if (!productId || this.data.favoriteChangingId) return;
    const before = this.data.list;
    const next = before.map((item) => {
      if (item.productId !== productId) return item;
      return { ...item, isFavorite: !item.isFavorite };
    });
    this.setData({ list: next, favoriteChangingId: productId });
    call("toggleFavorite", { productId }, { showLoading: false })
      .then((data) => {
        this.setData({
          list: this.data.list.map((item) => {
            if (item.productId !== productId) return item;
            return { ...item, isFavorite: Boolean(data.isFavorite) };
          })
        });
        feedback.showSuccess(data.isFavorite ? "已收藏" : "已取消收藏");
      })
      .catch((err) => {
        this.setData({ list: before });
        feedback.showError(err.message);
      })
      .finally(() => this.setData({ favoriteChangingId: "" }));
  },

  onReachBottom() {
    this.load({ reset: false });
  },

  onPullDownRefresh() {
    this.load({ reset: true }).finally(() => wx.stopPullDownRefresh());
  }
});
