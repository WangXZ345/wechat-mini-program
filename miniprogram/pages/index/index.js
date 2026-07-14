const { call, moneyText, toast, feedback } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin, redirectDefaultEntry } = require("../../utils/auth");
const { normalizeSearchText } = require("../../utils/searchNormalize");
const { setTabBarCartBadge, setTabBarSelected } = require("../../utils/tabbar");
const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const sync = require("../../utils/sync");
const haptics = require("../../utils/haptics");
const {
  HOME_CACHE_TTL_MS,
  cartItemFromAddResult,
  cartCountFromPayload,
  clearDirty,
  isDirty,
  readCache,
  readCartCache,
  scopedCacheKey,
  upsertCartCacheItem,
  writeProductPreview,
  writeCache,
  writeCartCache
} = require("../../utils/performanceCache");

const PAGE_SIZE = 20;
const LOCAL_RECENT_SEARCH_KEY = "local_recent_searches_v1";
const MAX_RECENT_SEARCHES = 20;
const HOME_PRODUCTS_SCOPE = "home_products_v1";
const HOME_RECOMMEND_SCOPE = "home_recommend_v1";
const HOME_RECOMMEND_DISPLAY_ORDER = ["frequent_purchase", "new_arrivals", "hot_selling"];
const HOME_RECOMMEND_DISPLAY_META = {
  frequent_purchase: { sectionTitle: "常购", subtitle: "你常买的商品" },
  new_arrivals: { sectionTitle: "新货", subtitle: "最近上新商品" },
  hot_selling: { sectionTitle: "热销", subtitle: "近期热销商品" }
};

function cleanSearchKeyword(keyword) {
  return String(keyword || "").replace(/\s+/g, " ").trim().slice(0, 30);
}

function normalizeHistoryKeyword(keyword) {
  return cleanSearchKeyword(keyword).toLowerCase().replace(/\s+/g, "");
}

function buildRecommendDisplayState(rawSections = [], activeKey = "") {
  const byKey = new Map((rawSections || [])
    .filter((section) => section && (section.products || []).length)
    .map((section) => [section.sectionKey, section]));
  const sections = HOME_RECOMMEND_DISPLAY_ORDER
    .map((key) => {
      const section = byKey.get(key);
      if (!section) return null;
      return {
        ...section,
        ...(HOME_RECOMMEND_DISPLAY_META[key] || {})
      };
    })
    .filter(Boolean);
  const activeStillExists = sections.some((section) => section.sectionKey === activeKey);
  const activeRecommendKey = activeStillExists
    ? activeKey
    : (sections[0] && sections[0].sectionKey || "");
  return {
    recommendSections: sections,
    recommendTabs: sections.map((section) => ({
      sectionKey: section.sectionKey,
      sectionTitle: section.sectionTitle
    })),
    activeRecommendKey,
    visibleRecommendSections: sections.filter((section) => section.sectionKey === activeRecommendKey)
  };
}

Page({
  data: {
    products: [],
    cartCount: 0,
    addingId: "",
    keyword: "",
    normalizedKeyword: "",
    activeKeyword: "",
    showSearchPanel: false,
    searchSuggestions: [],
    recentSearches: [],
    hotSearches: [],
    suggestionLoading: false,
    recentLoading: false,
    searchFocused: false,
    suggestionEmpty: false,
    lastSuggestionKeyword: "",
    noResultSearch: false,
    isSearching: false,
    skeletonRows: [1, 2, 3, 4],
    recommendSkeletonRows: [1, 2, 3],
    page: 1,
    hasMore: false,
    total: 0,
    loading: true,
    initialized: false,
    loadingMore: false,
    favoriteChangingId: "",
    category: "",
    categories: [],
    recommendSections: [],
    visibleRecommendSections: [],
    recommendTabs: [],
    activeRecommendKey: "",
    recommendLoading: true,
    recommendInitialized: false,
    recommendError: "",
    isLandscape: false,
    isWideScreen: false,
    screenWidth: 0,
    screenHeight: 0
  },

  onLoad() {
    this._homeInitializing = true;
    initOrientation(this);
    this._unsubscribeSync = sync.subscribe(this, ["product", "inventory"], () => {
      const productsBusy = Boolean(this.productsLoading);
      const recommendationsBusy = Boolean(this.recommendLoadingPromise);
      const productsRequest = this.loadProducts({ reset: true, silent: true });
      const recommendationsRequest = this.loadRecommendations({ silent: true });
      if (productsBusy) Promise.resolve(productsRequest).finally(() => this.loadProducts({ reset: true, silent: true })).catch(() => null);
      if (recommendationsBusy) Promise.resolve(recommendationsRequest).finally(() => this.loadRecommendations({ silent: true })).catch(() => null);
    });
    const hasProductCache = this.applyHomeProductsCache();
    const hasRecommendCache = this.applyRecommendationsCache();
    ensureLogin({ showLoading: false }).then(() => redirectDefaultEntry("pages/index/index"))
      .then((result) => {
        if (result.redirected) return null;
        return ensureFrontendAccess().then((profile) => ({
          profile,
          hasProductCache,
          hasRecommendCache
        }));
      }).then((result) => {
      if (!result || !result.profile) return;
      const hasProducts = result.hasProductCache || Boolean(this.data.products.length);
      const hasRecommendations = result.hasRecommendCache || Boolean(this.data.recommendSections.length);
      this.loadRecommendations({ silent: hasRecommendations });
      this.loadProducts({ reset: true, silent: hasProducts });
      this.loadCartCount();
    }).catch((err) => {
      this.setData({
        loading: false,
        initialized: true,
        recommendLoading: false,
        recommendInitialized: true
      });
      toast(err.message);
    }).finally(() => {
      this._homeInitializing = false;
    });
  },

  onShow() {
    setTabBarSelected(this, 0);
    if (this._homeInitializing) return;
    const hasProductCache = Boolean(this.data.products.length) || this.applyHomeProductsCache();
    const hasRecommendCache = Boolean(this.data.recommendSections.length) || this.applyRecommendationsCache();
    ensureFrontendAccess().then(() => {
      const productCache = readCache(scopedCacheKey(HOME_PRODUCTS_SCOPE, this.cacheScope()), HOME_CACHE_TTL_MS);
      const recommendCache = readCache(scopedCacheKey(HOME_RECOMMEND_SCOPE), HOME_CACHE_TTL_MS);
      if (isDirty("products") || !productCache || productCache.expired) {
        this.loadProducts({ reset: true, silent: this.data.products.length > 0 });
      }
      if (!recommendCache || recommendCache.expired) {
        this.loadRecommendations({ silent: this.data.recommendSections.length > 0 });
      }
      this.loadCartCount();
    }).catch(() => null);
  },

  cacheScope() {
    return JSON.stringify({
      keyword: this.data.activeKeyword || "",
      category: this.data.category || "",
      pageSize: PAGE_SIZE
    });
  },

  decorateProducts(products = []) {
    return products.map((item) => ({
      ...item,
      priceText: item.priceText || moneyText(item.price),
      tagItems: item.tagItems || (item.tags || []).map((tag) => ({ name: tag, className: this.tagClass(tag) }))
    }));
  },

  applyHomeProductsCache() {
    const cached = readCache(scopedCacheKey(HOME_PRODUCTS_SCOPE, this.cacheScope()), HOME_CACHE_TTL_MS);
    if (!cached || !cached.data || !(cached.data.products || []).length) return false;
    this.setData({
      ...cached.data,
      loading: false,
      loadingMore: false,
      initialized: true
    });
    return true;
  },

  applyRecommendationsCache() {
    const cached = readCache(scopedCacheKey(HOME_RECOMMEND_SCOPE), HOME_CACHE_TTL_MS);
    if (!cached || !cached.data || !(cached.data.recommendSections || []).length) return false;
    this.setData({
      ...buildRecommendDisplayState(cached.data.recommendSections, cached.data.activeRecommendKey || this.data.activeRecommendKey),
      recommendLoading: false,
      recommendInitialized: true,
      recommendError: ""
    });
    return true;
  },

  loadProducts(options = {}) {
    const reset = options.reset !== false;
    const page = reset ? 1 : this.data.page + 1;
    const activeKeyword = this.data.activeKeyword || "";
    const category = this.data.category || "";
    const requestScope = this.cacheScope();
    const cacheKey = scopedCacheKey(HOME_PRODUCTS_SCOPE, requestScope);
    const requestKey = JSON.stringify({ activeKeyword, category, page, reset });
    if (this.productsLoading) {
      if (reset && this.productsRequestKey !== requestKey) {
        this.pendingProductLoad = { ...options, reset: true };
      }
      return this.productsLoading;
    }
    if (!reset && !this.data.hasMore) return Promise.resolve({ total: this.data.total });
    this.setData(reset ? { loading: !options.silent } : { loadingMore: true });
    this.productsRequestKey = requestKey;

    this.productsLoading = call("searchProducts", {
      keyword: activeKeyword,
      category,
      page,
      pageSize: PAGE_SIZE
    }, { showLoading: false }).then((data) => {
      if (reset && requestScope !== this.cacheScope()) return { total: this.data.total, stale: true };
      const nextProducts = this.decorateProducts(data.products || []);
      const products = reset ? nextProducts : this.data.products.concat(nextProducts);
      const categories = Array.from(new Set(products.map((item) => item.category).filter(Boolean)));
      const total = Number(data.total || products.length);
      const state = {
        products,
        categories,
        page,
        total,
        hasMore: Boolean(data.hasMore),
        isSearching: Boolean(activeKeyword || category),
        noResultSearch: reset && Boolean(activeKeyword || category) && total === 0
      };
      this.setData(state);
      if (reset) {
        writeCache(cacheKey, state);
        clearDirty("products");
      }
      return { total };
    }).catch((err) => {
      toast(err.message);
      return { total: 0 };
    }).finally(() => {
      this.productsLoading = null;
      this.productsRequestKey = "";
      this.setData({ loading: false, loadingMore: false, initialized: true });
      const pending = this.pendingProductLoad;
      this.pendingProductLoad = null;
      if (pending) {
        const runPending = () => this.loadProducts(pending);
        if (wx.nextTick) wx.nextTick(runPending);
        else setTimeout(runPending, 0);
      }
    });
    return this.productsLoading;
  },

  tagClass(tag) {
    return {
      "新货": "new",
      "瑕疵": "defective",
      "热销": "hot",
      "常购": "frequent"
    }[tag] || "";
  },

  loadRecommendations(options = {}) {
    if (this.recommendLoadingPromise) return this.recommendLoadingPromise;
    this.setData({ recommendLoading: !options.silent, recommendError: "" });
    this.recommendLoadingPromise = call("getHomeRecommendations", {}, { showLoading: false })
      .then((data) => {
        const sections = (data.sections || [])
          .filter((section) => (section.products || []).length)
          .map((section) => ({
            ...section,
            products: (section.products || []).map((item) => ({
              ...item,
              priceText: moneyText(item.price),
              tagItems: item.tagItems || (item.tags || []).map((tag) => ({ name: tag, className: this.tagClass(tag) }))
            }))
          }));
        const state = buildRecommendDisplayState(sections, this.data.activeRecommendKey);
        this.setData(state);
        writeCache(scopedCacheKey(HOME_RECOMMEND_SCOPE), state);
      })
      .catch((err) => {
        this.setData({ recommendError: err.message || "推荐区加载失败" });
      })
      .finally(() => {
        this.recommendLoadingPromise = null;
        this.setData({ recommendLoading: false, recommendInitialized: true });
      });
    return this.recommendLoadingPromise;
  },

  onCategoryTap(e) {
    haptics.selection();
    this.hideSearchPanel();
    const category = e.currentTarget.dataset.category || "";
    this.setData({
      category,
      isSearching: Boolean(this.data.activeKeyword || category)
    }, () => this.loadProducts({ reset: true }));
  },

  onRecommendTabTap(e) {
    haptics.selection();
    const activeRecommendKey = e.currentTarget.dataset.key || "";
    const visibleRecommendSections = this.data.recommendSections.filter((section) => section.sectionKey === activeRecommendKey);
    this.setData({
      activeRecommendKey,
      visibleRecommendSections
    });
    writeCache(scopedCacheKey(HOME_RECOMMEND_SCOPE), {
      recommendSections: this.data.recommendSections,
      recommendTabs: this.data.recommendTabs,
      activeRecommendKey,
      visibleRecommendSections
    });
  },

  onSearchFocus() {
    haptics.light();
    this.setData({ searchFocused: true, showSearchPanel: true });
    if (!String(this.data.keyword || "").trim()) {
      this.fetchRecentSearches();
      this.fetchHotSearches();
    } else {
      this.scheduleSuggestions(this.data.keyword, 0);
    }
  },

  onSearchInput(e) {
    const keyword = e.detail.value;
    const normalizedKeyword = normalizeSearchText(keyword);
    this.setData({
      keyword,
      normalizedKeyword,
      isSearching: Boolean(normalizedKeyword || this.data.category),
      showSearchPanel: true,
      searchFocused: true,
      suggestionEmpty: false
    });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      const activeKeyword = normalizeSearchText(this.data.keyword);
      this.setData({
        activeKeyword,
        isSearching: Boolean(activeKeyword || this.data.category)
      }, () => this.loadProducts({ reset: true }));
    }, 300);
    this.scheduleSuggestions(keyword);
    if (!String(keyword || "").trim()) this.fetchRecentSearches();
  },

  scheduleSuggestions(keyword, wait = 300) {
    clearTimeout(this.suggestionTimer);
    const text = String(keyword || "").trim();
    if (!text) {
      this.setData({ searchSuggestions: [], suggestionLoading: false, suggestionEmpty: false });
      return;
    }
    this.suggestionTimer = setTimeout(() => this.fetchSearchSuggestions(text), wait);
  },

  fetchSearchSuggestions(keyword) {
    const requestKeyword = String(keyword || "").trim();
    if (!requestKeyword) return Promise.resolve();
    if (requestKeyword === this.data.lastSuggestionKeyword && this.data.searchSuggestions.length) return Promise.resolve();
    this.setData({ suggestionLoading: true, lastSuggestionKeyword: requestKeyword });
    return call("getSearchSuggestions", { keyword: requestKeyword, limit: 10 }, { showLoading: false })
      .then((data) => {
        if (String(this.data.keyword || "").trim() !== requestKeyword) return;
        const suggestions = data.suggestions || [];
        this.setData({
          searchSuggestions: suggestions,
          suggestionEmpty: suggestions.length === 0
        });
      })
      .catch(() => {
        if (String(this.data.keyword || "").trim() === requestKeyword) {
          this.setData({ searchSuggestions: [], suggestionEmpty: false });
        }
      })
      .finally(() => {
        if (String(this.data.keyword || "").trim() === requestKeyword) {
          this.setData({ suggestionLoading: false });
        }
      });
  },

  fetchRecentSearches() {
    if (this.data.recentLoading) return Promise.resolve();
    this.setData({ recentLoading: true });
    return call("getRecentSearches", { limit: 10 }, { showLoading: false })
      .then((data) => {
        const cloudList = data.list || [];
        this.setData({ recentSearches: cloudList.length ? cloudList : this.getLocalRecentSearches(10) });
      })
      .catch(() => this.setData({ recentSearches: this.getLocalRecentSearches(10) }))
      .finally(() => this.setData({ recentLoading: false }));
  },

  fetchHotSearches() {
    if (this.hotSearchesLoading) return this.hotSearchesLoading;
    if (this.hotSearchesFetchedAt && Date.now() - this.hotSearchesFetchedAt < HOME_CACHE_TTL_MS) {
      return Promise.resolve(this.data.hotSearches);
    }
    this.hotSearchesLoading = call("getHotSearches", { limit: 10 }, { showLoading: false })
      .then((data) => {
        const hotSearches = data.list || [];
        this.hotSearchesFetchedAt = Date.now();
        this.setData({ hotSearches });
        return hotSearches;
      })
      .catch(() => {
        this.setData({ hotSearches: [] });
        return [];
      })
      .finally(() => {
        this.hotSearchesLoading = null;
      });
    return this.hotSearchesLoading;
  },

  searchNow() {
    return this.onSearchConfirm();
  },

  onSearchConfirm() {
    clearTimeout(this.searchTimer);
    clearTimeout(this.suggestionTimer);
    const keyword = String(this.data.keyword || "").trim();
    const activeKeyword = normalizeSearchText(keyword);
    this.setData({
      keyword,
      normalizedKeyword: activeKeyword,
      activeKeyword,
      isSearching: Boolean(activeKeyword || this.data.category),
      showSearchPanel: false,
      searchSuggestions: []
    });
    return this.loadProducts({ reset: true }).then((result) => {
      if (!keyword) return null;
      return this.saveSearchKeyword(keyword, result && result.total);
    });
  },

  clearSearch() {
    clearTimeout(this.searchTimer);
    clearTimeout(this.suggestionTimer);
    this.setData({
      keyword: "",
      normalizedKeyword: "",
      activeKeyword: "",
      isSearching: Boolean(this.data.category),
      searchSuggestions: [],
      suggestionEmpty: false,
      noResultSearch: false,
      showSearchPanel: this.data.searchFocused
    }, () => {
      this.loadProducts({ reset: true });
      if (this.data.searchFocused) this.fetchRecentSearches();
    });
  },

  onSuggestionTap(e) {
    const keyword = e.currentTarget.dataset.keyword || "";
    if (!keyword) return;
    haptics.selection();
    this.setData({
      keyword,
      normalizedKeyword: normalizeSearchText(keyword),
      showSearchPanel: false,
      searchSuggestions: []
    }, () => this.onSearchConfirm());
  },

  onRecentSearchTap(e) {
    const keyword = e.currentTarget.dataset.keyword || "";
    if (!keyword) return;
    haptics.selection();
    this.setData({
      keyword,
      normalizedKeyword: normalizeSearchText(keyword),
      showSearchPanel: false,
      searchSuggestions: []
    }, () => this.onSearchConfirm());
  },

  onDeleteRecentSearch(e) {
    const keyword = e.currentTarget.dataset.keyword || "";
    if (!keyword) return;
    this.removeLocalRecentSearch(keyword);
    call("deleteRecentSearch", { keyword }, { showLoading: false })
      .then(() => this.fetchRecentSearches())
      .catch(() => this.setData({ recentSearches: this.getLocalRecentSearches(10) }));
  },

  onClearRecentSearches() {
    wx.showModal({
      title: "清空最近搜索",
      content: "确定清空全部最近搜索记录吗？",
      confirmText: "清空",
      confirmColor: "#8A6A43",
      success: (res) => {
        if (!res.confirm) return;
        this.clearLocalRecentSearches();
        call("clearRecentSearches", {}, { showLoading: false })
          .then(() => this.setData({ recentSearches: [] }))
          .catch(() => this.setData({ recentSearches: [] }));
      }
    });
  },

  hideSearchPanel() {
    this.setData({ showSearchPanel: false, searchFocused: false });
  },

  noop() {},

  saveSearchKeyword(keyword, resultCount) {
    this.upsertLocalRecentSearch(keyword);
    return call("saveSearchHistory", { keyword, resultCount: Number(resultCount || 0) }, { showLoading: false })
      .then(() => this.fetchRecentSearches())
      .catch(() => this.setData({ recentSearches: this.getLocalRecentSearches(10) }));
  },

  getLocalRecentSearches(limit = 10) {
    try {
      const list = wx.getStorageSync(LOCAL_RECENT_SEARCH_KEY) || [];
      return (Array.isArray(list) ? list : []).slice(0, limit);
    } catch (err) {
      return [];
    }
  },

  setLocalRecentSearches(list) {
    try {
      wx.setStorageSync(LOCAL_RECENT_SEARCH_KEY, list.slice(0, MAX_RECENT_SEARCHES));
    } catch (err) {
      // Local storage is only a fallback. Ignore write failures.
    }
  },

  upsertLocalRecentSearch(keyword) {
    const clean = cleanSearchKeyword(keyword);
    const normalized = normalizeHistoryKeyword(clean);
    if (!normalized || !/[\u4e00-\u9fa5a-zA-Z0-9]/.test(clean)) return;
    const now = new Date().toISOString();
    const before = this.getLocalRecentSearches(MAX_RECENT_SEARCHES);
    const existed = before.find((item) => normalizeHistoryKeyword(item.keyword) === normalized);
    const nextItem = {
      keyword: clean,
      lastSearchedAt: now,
      searchCount: existed ? Number(existed.searchCount || 1) + 1 : 1
    };
    const next = [nextItem].concat(before.filter((item) => normalizeHistoryKeyword(item.keyword) !== normalized));
    this.setLocalRecentSearches(next);
    this.setData({ recentSearches: next.slice(0, 10) });
  },

  removeLocalRecentSearch(keyword) {
    const normalized = normalizeHistoryKeyword(keyword);
    const next = this.getLocalRecentSearches(MAX_RECENT_SEARCHES)
      .filter((item) => normalizeHistoryKeyword(item.keyword) !== normalized);
    this.setLocalRecentSearches(next);
    this.setData({ recentSearches: next.slice(0, 10) });
  },

  clearLocalRecentSearches() {
    this.setLocalRecentSearches([]);
  },

  requestWantedProduct() {
    feedback.showInfo("可先联系商家处理找货需求");
  },

  goRecommend(e) {
    haptics.selection();
    const sectionKey = e.currentTarget.dataset.key;
    const sectionTitle = e.currentTarget.dataset.title || "";
    wx.navigateTo({
      url: `/pages/recommend/list?sectionKey=${sectionKey}&sectionTitle=${encodeURIComponent(sectionTitle)}`
    });
  },

  refreshProducts() {
    this.hideSearchPanel();
    this.loadRecommendations();
    this.loadProducts({ reset: true });
  },

  loadCartCount() {
    if (this.cartCountLoading) return this.cartCountLoading;
    const cached = readCartCache();
    if (cached && cached.data) {
      const cartCount = cached.data.totalCount || (cached.data.cartItems || []).length;
      this.setData({ cartCount });
      setTabBarCartBadge(this, cartCount);
      if (!cached.expired) return Promise.resolve({ count: cartCount });
    }
    this.cartCountLoading = call("getCartList", {}, { showLoading: false })
      .then((data) => {
        const cache = writeCartCache(data);
        const cartCount = cartCountFromPayload(cache);
        this.setData({ cartCount });
        setTabBarCartBadge(this, cartCount);
        return { count: cartCount };
      })
      .catch(() => null)
      .finally(() => {
        this.cartCountLoading = null;
      });
    return this.cartCountLoading;
  },

  findProductForCart(productId) {
    const id = String(productId || "");
    const product = (this.data.products || []).find((item) => item._id === id || item.productId === id);
    if (product) return product;
    const sections = this.data.visibleRecommendSections || [];
    for (let i = 0; i < sections.length; i += 1) {
      const match = (sections[i].products || []).find((item) => item._id === id || item.productId === id);
      if (match) return match;
    }
    return {};
  },

  goDetail(e) {
    haptics.selection();
    const product = this.findProductForCart(e.currentTarget.dataset.id);
    if (product && (product._id || product.productId)) writeProductPreview(product);
    wx.navigateTo({
      url: `/pages/product/detail?id=${e.currentTarget.dataset.id}`
    });
  },

  goCart() {
    wx.switchTab({ url: "/pages/cart/index" });
  },

  goFavorite() {
    wx.navigateTo({ url: "/pages/favorite/index" });
  },

  goFrequent() {
    wx.navigateTo({ url: "/pages/frequent/index" });
  },

  toggleFavorite(e) {
    const productId = e.currentTarget.dataset.id;
    if (!productId || this.data.favoriteChangingId) return;
    const before = this.data.products;
    const next = before.map((item) => {
      if (item._id !== productId) return item;
      return { ...item, isFavorite: !item.isFavorite };
    });
    this.setData({ products: next, favoriteChangingId: productId });

    call("toggleFavorite", { productId }, { showLoading: false })
      .then((data) => {
        this.setData({
          products: this.data.products.map((item) => {
            if (item._id !== productId) return item;
            return { ...item, isFavorite: Boolean(data.isFavorite) };
          })
        });
        feedback.showSuccess(data.isFavorite ? "已收藏" : "已取消收藏");
      })
      .catch((err) => {
        this.setData({ products: before });
        feedback.showError(err.message);
      })
      .finally(() => this.setData({ favoriteChangingId: "" }));
  },

  addToCart(e) {
    const productId = e.currentTarget.dataset.id;
    if (this.data.addingId) return;
    this.setData({ addingId: productId });
    call("addToCart", { productId, quantity: 1 }, { showLoading: false })
      .then((data) => {
        const cartItem = cartItemFromAddResult(data, this.findProductForCart(productId), 1);
        const cache = upsertCartCacheItem(cartItem);
        const cartCount = cache ? cache.totalCount : this.data.cartCount + 1;
        this.setData({ cartCount });
        setTabBarCartBadge(this, cartCount);
        haptics.success();
        feedback.showSuccess("已加入购物车");
      })
      .catch((err) => {
        haptics.error();
        feedback.showError(err.message);
      })
      .finally(() => this.setData({ addingId: "" }));
  },

  onReachBottom() {
    this.loadProducts({ reset: false });
  },

  onPullDownRefresh() {
    this.hideSearchPanel();
    Promise.all([this.loadRecommendations(), this.loadProducts({ reset: true })]).finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    if (this._unsubscribeSync) this._unsubscribeSync();
    cleanupOrientation(this);
  }
});
