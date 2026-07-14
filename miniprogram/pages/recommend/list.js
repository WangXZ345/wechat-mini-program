const { call, moneyText, toast, feedback } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin } = require("../../utils/auth");
const { normalizeSearchText } = require("../../utils/searchNormalize");
const { cartItemFromAddResult, upsertCartCacheItem, writeProductPreview } = require("../../utils/performanceCache");

const PAGE_SIZE = 20;
const SECTION_TITLES = {
  new_arrivals: "新货",
  defective: "瑕疵",
  hot_selling: "热销推荐",
  frequent_purchase: "常购"
};

Page({
  data: {
    sectionKey: "",
    sectionTitle: "",
    keyword: "",
    normalizedKeyword: "",
    category: "",
    categories: [],
    sortBy: "default",
    sortOptions: [
      { value: "default", label: "默认排序" },
      { value: "price_asc", label: "价格从低到高" },
      { value: "price_desc", label: "价格从高到低" },
      { value: "created_desc", label: "上架时间最新" },
      { value: "production_desc", label: "生产日期较新" }
    ],
    sortIndex: 0,
    products: [],
    page: 1,
    total: 0,
    hasMore: false,
    loading: false,
    loadingMore: false,
    addingId: "",
    invalid: false
  },

  onLoad(options = {}) {
    const sectionKey = String(options.sectionKey || "").trim();
    const sectionTitle = decodeURIComponent(options.sectionTitle || "") || SECTION_TITLES[sectionKey] || "";
    if (!SECTION_TITLES[sectionKey]) {
      this.setData({ invalid: true, sectionTitle: "推荐分类不存在" });
      wx.setNavigationBarTitle({ title: "推荐分类不存在" });
      feedback.showWarning("推荐分类不存在");
      return;
    }
    this.setData({ sectionKey, sectionTitle }, () => {
      wx.setNavigationBarTitle({ title: sectionTitle });
      ensureLogin()
        .then(() => ensureFrontendAccess())
        .then(() => this.load({ reset: true }))
        .catch((err) => toast(err.message));
    });
  },

  tagClass(tag) {
    return {
      "新货": "new",
      "瑕疵": "defective",
      "热销": "hot",
      "常购": "frequent"
    }[tag] || "";
  },

  load(options = {}) {
    if (this.data.invalid) return Promise.resolve();
    const reset = options.reset !== false;
    const page = reset ? 1 : this.data.page + 1;
    if (this.data.loading || this.data.loadingMore) return Promise.resolve();
    if (!reset && !this.data.hasMore) return Promise.resolve();
    this.setData(reset ? { loading: true } : { loadingMore: true });
    return call("getRecommendProducts", {
      sectionKey: this.data.sectionKey,
      page,
      pageSize: PAGE_SIZE,
      keyword: this.data.normalizedKeyword || this.data.keyword,
      category: this.data.category,
      sortBy: this.data.sortBy
    }, { showLoading: false }).then((data) => {
      const nextProducts = (data.products || []).map((item) => ({
        ...item,
        priceText: moneyText(item.price),
        tagItems: item.tagItems || (item.tags || []).map((tag) => ({ name: tag, className: this.tagClass(tag) }))
      }));
      const products = reset ? nextProducts : this.data.products.concat(nextProducts);
      this.setData({
        products,
        categories: data.categories || this.data.categories,
        page,
        total: Number(data.total || products.length),
        hasMore: Boolean(data.hasMore)
      });
    }).catch((err) => {
      if (err.code === "INVALID_RECOMMEND_SECTION") {
        this.setData({ invalid: true, products: [] });
        feedback.showWarning("推荐分类不存在");
        return;
      }
      feedback.showError(err.message);
    }).finally(() => this.setData({ loading: false, loadingMore: false }));
  },

  onSearchInput(e) {
    const keyword = e.detail.value;
    this.setData({ keyword, normalizedKeyword: normalizeSearchText(keyword) });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load({ reset: true }), 300);
  },

  searchNow() {
    clearTimeout(this.searchTimer);
    this.load({ reset: true });
  },

  clearSearch() {
    clearTimeout(this.searchTimer);
    this.setData({ keyword: "", normalizedKeyword: "" }, () => this.load({ reset: true }));
  },

  onCategoryTap(e) {
    this.setData({ category: e.currentTarget.dataset.category || "" }, () => this.load({ reset: true }));
  },

  onSortChange(e) {
    const sortIndex = Number(e.detail.value);
    const sort = this.data.sortOptions[sortIndex] || this.data.sortOptions[0];
    this.setData({ sortIndex, sortBy: sort.value }, () => this.load({ reset: true }));
  },

  goDetail(e) {
    const productId = e.currentTarget.dataset.id;
    const product = this.data.products.find((item) => item._id === productId || item.productId === productId);
    if (product) writeProductPreview(product);
    wx.navigateTo({ url: `/pages/product/detail?id=${productId}` });
  },

  addToCart(e) {
    const productId = e.currentTarget.dataset.id;
    if (this.data.addingId) return;
    this.setData({ addingId: productId });
    const item = (this.data.products || []).find((row) => row._id === productId || row.productId === productId) || {};
    call("addToCart", { productId, quantity: 1 }, { showLoading: false })
      .then((data) => {
        upsertCartCacheItem(cartItemFromAddResult(data, item, 1));
        feedback.showSuccess("已加入购物车");
      })
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ addingId: "" }));
  },

  goHome() {
    wx.switchTab({ url: "/pages/index/index" });
  },

  onReachBottom() {
    this.load({ reset: false });
  },

  onPullDownRefresh() {
    this.load({ reset: true }).finally(() => wx.stopPullDownRefresh());
  }
});
