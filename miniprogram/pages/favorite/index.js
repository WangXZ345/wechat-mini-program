const { call, moneyText, feedback } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin } = require("../../utils/auth");
const { cartItemFromAddResult, upsertCartCacheItem, writeProductPreview } = require("../../utils/performanceCache");

const PAGE_SIZE = 20;

Page({
  data: {
    list: [],
    page: 1,
    pageSize: PAGE_SIZE,
    hasMore: false,
    loading: false,
    loadingMore: false,
    removingId: "",
    addingCartId: ""
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
      statusText: item.unavailable ? item.unavailableReason : "正常"
    };
  },

  load(options = {}) {
    const reset = options.reset !== false;
    const page = reset ? 1 : this.data.page + 1;
    if (this.data.loading || this.data.loadingMore) return Promise.resolve();
    if (!reset && !this.data.hasMore) return Promise.resolve();
    this.setData(reset ? { loading: true } : { loadingMore: true });

    return call("getFavoriteList", {
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
      .finally(() => this.setData({ loading: false, loadingMore: false }));
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

  removeFavorite(e) {
    const productId = e.currentTarget.dataset.id;
    if (!productId || this.data.removingId) return;
    this.setData({ removingId: productId });
    call("removeFavorite", { productId }, { showLoading: false })
      .then(() => {
        feedback.showSuccess("已取消收藏");
        this.setData({
          list: this.data.list.filter((item) => item.productId !== productId)
        });
      })
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ removingId: "" }));
  },

  onReachBottom() {
    this.load({ reset: false });
  },

  onPullDownRefresh() {
    this.load({ reset: true }).finally(() => wx.stopPullDownRefresh());
  }
});
