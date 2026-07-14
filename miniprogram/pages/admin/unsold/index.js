const { call, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");
const { generateIdempotencyKey } = require("../../../utils/idempotency");

const PAGE_SIZE = 20;

function todayText() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function moneyInputFromCents(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

Page({
  data: {
    rangeType: "today",
    startDate: todayText(),
    endDate: todayText(),
    keyword: "",
    productIndex: "",
    skuCode: "",
    category: "",
    activeIndex: 0,
    activeOptions: [
      { label: "全部", value: "" },
      { label: "已上架", value: true },
      { label: "未上架", value: false }
    ],
    minStock: "",
    maxStock: "",
    minPrice: "",
    maxPrice: "",
    productionDateStart: "",
    productionDateEnd: "",
    sortIndex: 0,
    sortOptions: [
      { label: "库存高到低", value: "stock_desc" },
      { label: "生产日期早到晚", value: "productionDate_asc" },
      { label: "价格高到低", value: "price_desc" },
      { label: "最近售出远到近", value: "lastSoldAt_asc" },
      { label: "创建时间早到晚", value: "createdAt_asc" }
    ],
    products: [],
    summary: {},
    rangeText: "",
    total: 0,
    page: 1,
    hasMore: false,
    loading: false,
    loadingMore: false,
    exporting: false
  },

  onLoad() {
    ensureAdmin("product:view").then(() => this.load({ reset: true })).catch((err) => toast(err.message));
  },

  params(extra = {}) {
    const activeOption = this.data.activeOptions[this.data.activeIndex] || {};
    const sortOption = this.data.sortOptions[this.data.sortIndex] || this.data.sortOptions[0];
    const params = {
      rangeType: this.data.rangeType,
      keyword: this.data.keyword,
      productIndex: this.data.productIndex,
      skuCode: this.data.skuCode,
      category: this.data.category,
      minStock: this.data.minStock,
      maxStock: this.data.maxStock,
      minPrice: this.data.minPrice ? Math.round(Number(this.data.minPrice) * 100) : "",
      maxPrice: this.data.maxPrice ? Math.round(Number(this.data.maxPrice) * 100) : "",
      productionDateStart: this.data.productionDateStart,
      productionDateEnd: this.data.productionDateEnd,
      sortBy: sortOption.value,
      pageSize: PAGE_SIZE,
      ...extra
    };
    if (activeOption.value === true || activeOption.value === false) params.isActive = activeOption.value;
    if (this.data.rangeType === "custom") {
      params.startDate = this.data.startDate;
      params.endDate = this.data.endDate;
    }
    return params;
  },

  load(options = {}) {
    const reset = options.reset !== false;
    const page = reset ? 1 : this.data.page + 1;
    if (this.data.loading || this.data.loadingMore) return Promise.resolve();
    if (!reset && !this.data.hasMore) return Promise.resolve();

    this.setData(reset ? { loading: true } : { loadingMore: true });
    return call("getUnsoldProducts", this.params({ page })).then((data) => {
      const next = (data.list || []).map((item) => ({
        ...item,
        newPrice: moneyInputFromCents(item.price),
        newStock: String(item.stock || 0)
      }));
      this.setData({
        products: reset ? next : this.data.products.concat(next),
        summary: data.summary || {},
        rangeText: data.range ? `${data.range.startDate} 至 ${data.range.endDate}` : "",
        total: Number(data.total || 0),
        page: Number(data.page || page),
        hasMore: Boolean(data.hasMore)
      });
    }).catch((err) => {
      toast("查询失败，请稍后重试");
      console.error(err);
    }).finally(() => this.setData({ loading: false, loadingMore: false }));
  },

  setRange(e) {
    const rangeType = e.currentTarget.dataset.range;
    this.setData({ rangeType }, () => {
      if (rangeType !== "custom") this.load({ reset: true });
    });
  },

  queryCustom() {
    if (!this.data.startDate || !this.data.endDate) {
      toast("请选择开始日期和结束日期");
      return;
    }
    this.setData({ rangeType: "custom" }, () => this.load({ reset: true }));
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [key]: e.detail.value });
    clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => this.load({ reset: true }), 400);
  },

  onDateChange(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [key]: e.detail.value });
  },

  onActiveChange(e) {
    this.setData({ activeIndex: Number(e.detail.value || 0) }, () => this.load({ reset: true }));
  },

  onSortChange(e) {
    this.setData({ sortIndex: Number(e.detail.value || 0) }, () => this.load({ reset: true }));
  },

  resetFilters() {
    this.setData({
      keyword: "",
      productIndex: "",
      skuCode: "",
      category: "",
      activeIndex: 0,
      minStock: "",
      maxStock: "",
      minPrice: "",
      maxPrice: "",
      productionDateStart: "",
      productionDateEnd: ""
    }, () => this.load({ reset: true }));
  },

  viewProduct(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/product/detail?id=${id}` });
  },

  onRowInput(e) {
    const id = e.currentTarget.dataset.id;
    const key = e.currentTarget.dataset.key;
    const products = this.data.products.map((item) => item.productId === id ? { ...item, [key]: e.detail.value } : item);
    this.setData({ products });
  },

  savePrice(e) {
    const id = e.currentTarget.dataset.id;
    const product = this.data.products.find((item) => item.productId === id);
    if (!product) return;
    const newPrice = Math.round(Number(product.newPrice) * 100);
    if (!Number.isInteger(newPrice) || newPrice < 0) {
      toast("请输入有效售价");
      return;
    }
    call("updateProductPrice", {
      productId: id,
      newPrice,
      reason: "未售商品分析页调整价格"
    }).then(() => {
      toast("价格已更新");
      this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  saveStock(e) {
    const id = e.currentTarget.dataset.id;
    const product = this.data.products.find((item) => item.productId === id);
    if (!product) return;
    const stock = Math.floor(Number(product.newStock));
    if (!Number.isInteger(stock) || stock < 0) {
      toast("请输入有效库存");
      return;
    }
    call("getUnsoldProducts", {
      action: "updateStock",
      productId: id,
      stock,
      expectedStock: Number(product.stock || 0),
      expectedVersion: Number(product.version || 0),
      reason: "未售商品分析页调整库存",
      idempotencyKey: generateIdempotencyKey(`unsold-stock-${id}`)
    }).then(() => {
      toast("库存已更新");
      this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  deactivate(e) {
    const id = e.currentTarget.dataset.id;
    const product = this.data.products.find((item) => item.productId === id);
    if (!product) {
      toast("商品已变化，请刷新后重试");
      return;
    }
    wx.showModal({
      title: "下架商品",
      content: "确认下架该商品吗？",
      success: (res) => {
        if (!res.confirm) return;
        call("getUnsoldProducts", {
          action: "deactivate",
          productId: id,
          expectedIsActive: product.isActive !== false,
          expectedVersion: Number.isSafeInteger(product.version) && product.version >= 0 ? product.version : 0,
          reason: "未售商品分析页下架",
          idempotencyKey: generateIdempotencyKey("unsold_product_deactivate")
        }).then(() => {
          toast("商品已下架");
          this.load({ reset: true });
        }).catch((err) => toast(err.message));
      }
    });
  },

  toggleFlag(e) {
    const id = e.currentTarget.dataset.id;
    const flag = e.currentTarget.dataset.flag;
    const product = this.data.products.find((item) => item.productId === id);
    if (!product) return;
    const value = !product[flag];
    call("getUnsoldProducts", {
      action: "updateFlag",
      productId: id,
      flag,
      value
    }).then(() => {
      toast(value ? "已标记" : "已取消标记");
      const products = this.data.products.map((item) => item.productId === id ? { ...item, [flag]: value } : item);
      this.setData({ products });
    }).catch((err) => toast(err.message));
  },

  exportExcel() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    call("getUnsoldProducts", this.params({ action: "export" })).then((data) => {
      toast("导出完成，正在打开");
      return new Promise((resolve, reject) => {
        wx.cloud.downloadFile({
          fileID: data.fileID,
          success: (res) => {
            wx.openDocument({
              filePath: res.tempFilePath,
              fileType: "xlsx",
              showMenu: true,
              success: resolve,
              fail: reject
            });
          },
          fail: reject
        });
      });
    }).catch((err) => {
      toast(err.message || "导出 Excel 失败");
    }).finally(() => this.setData({ exporting: false }));
  },

  onReachBottom() {
    this.load({ reset: false });
  },

  onPullDownRefresh() {
    this.load({ reset: true }).finally(() => wx.stopPullDownRefresh());
  }
});
