const { call, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");
const { generateIdempotencyKey } = require("../../../utils/idempotency");

const PAGE_SIZE = 20;

Page({
  data: {
    list: [],
    selectedIds: [],
    status: "all",
    keyword: "",
    page: 1,
    hasMore: false,
    loading: false,
    loadingMore: false,
    checkingAll: false,
    summary: {},
    batchWarningStock: "",
    batchAutoHideWhenOutOfStock: false
  },

  onLoad() {
    ensureAdmin("inventory:view").then(() => this.load({ reset: true })).catch((err) => toast(err.message));
  },

  load(options = {}) {
    const reset = options.reset !== false;
    const page = reset ? 1 : this.data.page + 1;
    if (this.data.loading || this.data.loadingMore) return Promise.resolve();
    if (!reset && !this.data.hasMore) return Promise.resolve();
    this.setData(reset ? { loading: true } : { loadingMore: true });
    return call("getStockAlerts", {
      status: this.data.status,
      keyword: this.data.keyword,
      page,
      pageSize: PAGE_SIZE
    }).then((data) => {
      const selectedSet = new Set(this.data.selectedIds);
      const rows = (data.list || []).map((item) => ({
        ...item,
        checked: selectedSet.has(item.productId),
        editWarningStock: String(item.warningStock === undefined ? 10 : item.warningStock)
      }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({
        list,
        page,
        hasMore: Boolean(data.hasMore),
        summary: data.summary || {},
        selectedIds: list.filter((item) => item.checked).map((item) => item.productId)
      });
    }).catch((err) => toast(err.message))
      .finally(() => this.setData({ loading: false, loadingMore: false }));
  },

  onStatusTap(e) {
    this.setData({ status: e.currentTarget.dataset.status, selectedIds: [] }, () => this.load({ reset: true }));
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load({ reset: true }), 300);
  },

  onSelect(e) {
    const selectedIds = e.detail.value;
    const selectedSet = new Set(selectedIds);
    this.setData({
      selectedIds,
      list: this.data.list.map((item) => ({ ...item, checked: selectedSet.has(item.productId) }))
    });
  },

  onWarningInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ [`list[${index}].editWarningStock`]: e.detail.value });
  },

  onAutoHideChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.list[index];
    const idempotencyKey = generateIdempotencyKey("update_warning_stock");
    call("updateProductWarningStock", {
      productId: item.productId,
      warningStock: item.editWarningStock,
      autoHideWhenOutOfStock: e.detail.value,
      idempotencyKey
    }).then(() => {
      toast("已更新");
      this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  saveWarningStock(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.list[index];
    const idempotencyKey = generateIdempotencyKey("update_warning_stock");
    call("updateProductWarningStock", {
      productId: item.productId,
      warningStock: item.editWarningStock,
      autoHideWhenOutOfStock: item.autoHideWhenOutOfStock,
      idempotencyKey
    }).then(() => {
      toast("已更新");
      this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  onBatchInput(e) {
    this.setData({ batchWarningStock: e.detail.value });
  },

  onBatchAutoHideChange(e) {
    this.setData({ batchAutoHideWhenOutOfStock: e.detail.value });
  },

  batchUpdate() {
    if (!this.data.selectedIds.length) {
      toast("请选择商品");
      return;
    }
    const idempotencyKey = generateIdempotencyKey("batch_update_warning_stock");
    call("batchUpdateWarningStock", {
      productIds: this.data.selectedIds,
      warningStock: this.data.batchWarningStock,
      autoHideWhenOutOfStock: this.data.batchAutoHideWhenOutOfStock,
      batchOperationId: idempotencyKey,
      idempotencyKey
    }).then((data) => {
      toast(`已更新 ${data.successCount || 0} 个商品`);
      this.setData({ selectedIds: [], batchWarningStock: "" });
      this.load({ reset: true });
    }).catch((err) => toast(err.message));
  },

  checkAll() {
    if (this.data.checkingAll) return;
    const ids = this.data.list.map((item) => item.productId).filter(Boolean);
    if (!ids.length) {
      toast("当前没有可检查的商品");
      return;
    }
    this.setData({ checkingAll: true });
    this.checkVisibleBatch(ids, 0, { checked: 0, success: 0, failed: 0 })
      .then((total) => {
        toast(`已检查当前页 ${total.success} 个商品`);
        this.load({ reset: true });
      })
      .catch((err) => toast(err.message))
      .finally(() => this.setData({ checkingAll: false }));
  },

  checkVisibleBatch(ids, index, total) {
    if (index >= ids.length) return Promise.resolve(total);
    return call("updateStockAlertStatus", { productId: ids[index] }).then((data) => {
      const nextTotal = {
        checked: total.checked + 1,
        success: total.success + Number(data.successCount || 0),
        failed: total.failed + Number(data.failedCount || 0)
      };
      return this.checkVisibleBatch(ids, index + 1, nextTotal);
    });
  },

  hideOutOfStock() {
    const ids = this.data.list.filter((item) => item.stockStatus === "out_of_stock").map((item) => item.productId);
    if (!ids.length) {
      toast("当前没有缺货商品");
      return;
    }
    const idempotencyKey = generateIdempotencyKey("batch_update_warning_stock");
    call("batchUpdateWarningStock", {
      productIds: ids,
      warningStock: 10,
      autoHideWhenOutOfStock: true,
      batchOperationId: idempotencyKey,
      idempotencyKey
    }).then(() => {
      toast("已开启缺货自动下架");
      this.checkAll();
    }).catch((err) => toast(err.message));
  },

  goProduct(e) {
    wx.navigateTo({ url: `/pages/admin/products?productId=${e.currentTarget.dataset.id}` });
  },

  goInventoryLogs() {
    wx.navigateTo({ url: "/pages/admin/inventory" });
  },

  onReachBottom() {
    this.load({ reset: false });
  },

  onPullDownRefresh() {
    this.load({ reset: true }).finally(() => wx.stopPullDownRefresh());
  }
});
