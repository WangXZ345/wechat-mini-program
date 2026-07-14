const { call, moneyText, feedback } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin } = require("../../utils/auth");
const { AFTER_SALE_TYPE_TEXT, AFTER_SALE_STATUS_TEXT, REFUND_STATUS_TEXT } = require("../../utils/status");
const sync = require("../../utils/sync");

function formatDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

Page({
  data: {
    loading: true,
    initialized: false,
    afterSales: []
  },

  onLoad() {
    this._initializing = true;
    this._unsubscribeSync = sync.subscribe(this, ["after_sale", "refund", "order"], () => {
      const busy = Boolean(this.afterSalesLoading);
      const request = this.load({ silent: true });
      if (busy) Promise.resolve(request).finally(() => this.load({ silent: true })).catch(() => null);
    });
    ensureLogin()
      .then(() => ensureFrontendAccess())
      .then(() => this.load())
      .catch((err) => {
        this.setData({ loading: false, initialized: true });
        feedback.showError(err.message);
      })
      .finally(() => {
        this._initializing = false;
      });
  },

  onShow() {
    if (this._initializing || !this._loadedOnce) return;
    ensureFrontendAccess()
      .then(() => this.load({ silent: true }))
      .catch(() => null);
  },

  onUnload() {
    if (this._unsubscribeSync) this._unsubscribeSync();
  },

  load(options = {}) {
    if (this.afterSalesLoading) return this.afterSalesLoading;
    this.setData({ loading: !options.silent && !this.data.afterSales.length });
    this.afterSalesLoading = call("getMyAfterSales", {}, { showLoading: false }).then((data) => {
      const rows = (data.afterSales || []).map((item) => ({
        ...item,
        typeText: AFTER_SALE_TYPE_TEXT[item.afterSaleType] || item.afterSaleType,
        statusText: AFTER_SALE_STATUS_TEXT[item.afterSaleStatus] || item.afterSaleStatus,
        refundText: REFUND_STATUS_TEXT[item.refundStatus] || item.refundStatus,
        amountText: moneyText(item.requestedRefundAmount),
        createdAtText: formatDate(item.createdAt)
      }));
      this.setData({ afterSales: rows });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => {
        this._loadedOnce = true;
        this.afterSalesLoading = null;
        this.setData({ loading: false, initialized: true });
      });
    return this.afterSalesLoading;
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/after-sale/detail?id=${e.currentTarget.dataset.id}` });
  }
});
