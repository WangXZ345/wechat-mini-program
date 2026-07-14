const { call, moneyText, toast } = require("../../../utils/api");
const { ensureAnyPermission } = require("../../../utils/auth");
const { normalizeSearchText } = require("../../../utils/searchNormalize");
const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const { staggerClass } = require("../../../utils/motion");
const haptics = require("../../../utils/haptics");

const RANGE_OPTIONS = [
  { label: "近 7 天", value: "7d" },
  { label: "近 30 天", value: "30d" },
  { label: "近 90 天", value: "90d" },
  { label: "自定义", value: "custom" }
];

function todayText(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function money(value) {
  return `￥${moneyText(value)}`;
}

Page({
  data: {
    rangeOptions: RANGE_OPTIONS,
    range: "30d",
    rangeText: "近 30 天",
    startDate: todayText(-29),
    endDate: todayText(0),
    keyword: "",
    normalizedKeyword: "",
    productResults: [],
    selectedProduct: {},
    summaryItems: [],
    salesTrend: [],
    dealPriceTrend: [],
    listPriceTrend: [],
    analyticsMessage: "",
    searchLoading: false,
    analyticsLoading: false,
    initializedSearch: false,
    errorMessage: "",
    hasSalesData: false,
    hasDealPriceData: false,
    hasListPriceData: false,
    isLandscape: false,
    isWideScreen: false
  },

  onLoad() {
    initOrientation(this);
    ensureAnyPermission(["product:analytics:view", "dashboard:view_product"])
      .then(() => this.searchProducts())
      .catch((err) => {
        this.setData({ errorMessage: err.message || "无权限访问商品数据分析" });
      });
  },

  onUnload() {
    cleanupOrientation(this);
  },

  onKeywordInput(e) {
    const keyword = e.detail.value;
    this.setData({ keyword, normalizedKeyword: normalizeSearchText(keyword) });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.searchProducts(), 300);
  },

  searchProducts() {
    const requestId = Number(this.productSearchRequestId || 0) + 1;
    const keyword = this.data.normalizedKeyword || this.data.keyword;
    this.productSearchRequestId = requestId;
    this.setData({ searchLoading: true, errorMessage: "" });
    return call("adminSearchProducts", {
      keyword,
      page: 1,
      pageSize: 20,
      filters: {}
    }, { showLoading: false }).then((data) => {
      if (requestId !== this.productSearchRequestId) return;
      const products = (data.products || []).map((item, index) => ({
        ...item,
        priceText: money(item.price),
        motionClass: staggerClass(index)
      }));
      this.setData({ productResults: products, initializedSearch: true });
      if (!this.data.selectedProduct.productId && products[0]) {
        this.selectProductById(products[0]._id);
      }
    }).catch((err) => {
      if (requestId !== this.productSearchRequestId) return;
      this.setData({ errorMessage: err.message || "搜索商品失败" });
      toast(err.message || "搜索商品失败");
    }).finally(() => {
      if (requestId === this.productSearchRequestId) this.setData({ searchLoading: false });
    });
  },

  clearSearch() {
    clearTimeout(this.searchTimer);
    this.setData({ keyword: "", normalizedKeyword: "" }, () => this.searchProducts());
  },

  selectProduct(e) {
    this.selectProductById(e.currentTarget.dataset.id);
  },

  selectProductById(productId) {
    const product = this.data.productResults.find((item) => item._id === productId);
    if (!product) return;
    haptics.selection();
    this.setData({
      selectedProduct: {
        productId: product._id,
        name: product.name || "",
        brand: product.brand || "",
        category: product.category || "",
        specification: product.specification || "",
        imageUrl: product.imageUrl || "",
        tags: Array.isArray(product.tags) ? product.tags : [],
        currentPrice: Number(product.price || 0),
        currentPriceText: money(product.price),
        currentStock: Number(product.stock || 0)
      }
    }, () => this.loadAnalytics());
  },

  onRangeTap(e) {
    const range = e.currentTarget.dataset.value;
    const option = RANGE_OPTIONS.find((item) => item.value === range) || RANGE_OPTIONS[1];
    this.setData({ range, rangeText: option.label }, () => {
      if (this.data.selectedProduct.productId && range !== "custom") this.loadAnalytics();
    });
  },

  onStartDateChange(e) {
    this.setData({ startDate: e.detail.value, range: "custom", rangeText: "自定义" }, () => this.loadAnalytics());
  },

  onEndDateChange(e) {
    this.setData({ endDate: e.detail.value, range: "custom", rangeText: "自定义" }, () => this.loadAnalytics());
  },

  analyticsParams() {
    const params = {
      productId: this.data.selectedProduct.productId,
      range: this.data.range
    };
    if (params.range === "custom") {
      params.startDate = this.data.startDate;
      params.endDate = this.data.endDate;
    }
    return params;
  },

  loadAnalytics() {
    if (!this.data.selectedProduct.productId) return Promise.resolve();
    const requestId = Number(this.analyticsRequestId || 0) + 1;
    const params = this.analyticsParams();
    this.analyticsRequestId = requestId;
    this.setData({ analyticsLoading: true, errorMessage: "" });
    return call("getProductAnalytics", params, { showLoading: false }).then((data) => {
      if (requestId !== this.analyticsRequestId || params.productId !== this.data.selectedProduct.productId) return;
      const product = data.product || {};
      const summary = data.summary || {};
      const salesTrend = data.salesTrend || [];
      const dealPriceTrend = data.dealPriceTrend || [];
      const listPriceTrend = data.listPriceTrend || [];
      const selectedProduct = {
        ...this.data.selectedProduct,
        ...product,
        productId: product.productId || this.data.selectedProduct.productId,
        currentPriceText: money(product.currentPrice),
        currentStock: Number(product.currentStock || 0),
        tags: Array.isArray(product.tags) ? product.tags : []
      };
      const summaryItems = [
        { label: "总销量", value: `${summary.totalQuantity || 0}` },
        { label: "总销售额", value: money(summary.totalAmount) },
        { label: "平均成交价", value: money(summary.avgDealPrice) },
        { label: "当前售价", value: money(summary.currentPrice) },
        { label: "最高成交价", value: money(summary.maxDealPrice) },
        { label: "最低成交价", value: money(summary.minDealPrice) },
        { label: "订单数", value: `${summary.orderCount || 0}` }
      ].map((item, index) => ({ ...item, motionClass: staggerClass(index) }));
      this.setData({
        selectedProduct,
        summaryItems,
        salesTrend,
        dealPriceTrend,
        listPriceTrend,
        analyticsMessage: data.message || "",
        hasSalesData: salesTrend.some((item) => Number(item.quantity || 0) > 0),
        hasDealPriceData: dealPriceTrend.some((item) => Number(item.avgPrice || 0) > 0),
        hasListPriceData: listPriceTrend.some((item) => Number(item.price || 0) > 0)
      }, () => this.drawCharts());
    }).catch((err) => {
      if (requestId !== this.analyticsRequestId) return;
      this.setData({ errorMessage: err.message || "加载商品分析失败" });
      toast(err.message || "加载商品分析失败");
    }).finally(() => {
      if (requestId === this.analyticsRequestId) this.setData({ analyticsLoading: false });
    });
  },

  retry() {
    this.loadAnalytics();
  },

  drawCharts() {
    wx.nextTick(() => {
      this.drawLineChart("salesChart", this.data.salesTrend, "quantity", { color: "#9A6F3F", label: "销量", money: false });
      this.drawLineChart("dealPriceChart", this.data.dealPriceTrend, "avgPrice", { color: "#4F6F63", label: "成交均价", money: true });
      if (this.data.hasListPriceData) {
        this.drawLineChart("listPriceChart", this.data.listPriceTrend, "price", { color: "#7B5E8E", label: "报价", money: true });
      }
    });
  },

  drawLineChart(canvasId, rows, valueKey, options = {}) {
    const query = wx.createSelectorQuery().in(this);
    query.select(`#${canvasId}`).boundingClientRect((rect) => {
      if (!rect || !rect.width || !rect.height) return;
      const ctx = wx.createCanvasContext(canvasId, this);
      const width = rect.width;
      const height = rect.height;
      const padding = { left: 42, right: 18, top: 24, bottom: 34 };
      const chartWidth = Math.max(1, width - padding.left - padding.right);
      const chartHeight = Math.max(1, height - padding.top - padding.bottom);
      const points = (rows || []).map((item) => ({
        date: item.date || "",
        value: Number(item[valueKey] || 0)
      }));
      const values = points.map((item) => item.value).filter((value) => Number.isFinite(value));
      const maxRaw = values.length ? Math.max(...values) : 0;
      const minRaw = values.length ? Math.min(...values) : 0;
      const max = maxRaw === minRaw ? maxRaw + (maxRaw > 0 ? maxRaw * 0.2 : 1) : maxRaw;
      const min = maxRaw === minRaw ? 0 : Math.min(0, minRaw);
      const span = Math.max(1, max - min);

      ctx.clearRect(0, 0, width, height);
      ctx.setFillStyle("#FFFCF7");
      ctx.fillRect(0, 0, width, height);
      ctx.setStrokeStyle("#E6D8C7");
      ctx.setLineWidth(1);
      ctx.beginPath();
      ctx.moveTo(padding.left, padding.top);
      ctx.lineTo(padding.left, padding.top + chartHeight);
      ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
      ctx.stroke();

      ctx.setFillStyle("#8E867D");
      ctx.setFontSize(10);
      ctx.fillText(options.money ? money(maxRaw) : String(Math.round(maxRaw)), 4, padding.top + 4);
      ctx.fillText(options.money ? money(0) : "0", 10, padding.top + chartHeight);

      if (!points.length) {
        ctx.draw();
        return;
      }

      const stepX = points.length > 1 ? chartWidth / (points.length - 1) : 0;
      const coords = points.map((point, index) => {
        const x = padding.left + (points.length > 1 ? index * stepX : chartWidth / 2);
        const y = padding.top + chartHeight - ((point.value - min) / span) * chartHeight;
        return { ...point, x, y };
      });

      ctx.setStrokeStyle(options.color || "#9A6F3F");
      ctx.setLineWidth(2);
      ctx.beginPath();
      coords.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();

      ctx.setFillStyle(options.color || "#9A6F3F");
      coords.forEach((point) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2.5, 0, 2 * Math.PI);
        ctx.fill();
      });

      ctx.setFillStyle("#82776B");
      ctx.setFontSize(10);
      ctx.fillText(points[0].date.slice(5), padding.left, height - 10);
      const last = points[points.length - 1];
      const lastLabel = last.date.slice(5);
      ctx.fillText(lastLabel, Math.max(padding.left, width - padding.right - 38), height - 10);
      ctx.draw();
    }).exec();
  }
});
