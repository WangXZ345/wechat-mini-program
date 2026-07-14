const { call, moneyText, feedback } = require("../../utils/api");
const { ensureLogin } = require("../../utils/auth");
const { AFTER_SALE_TYPE_TEXT, AFTER_SALE_REASON_TEXT, AFTER_SALE_STATUS_TEXT, REFUND_STATUS_TEXT } = require("../../utils/status");
const sync = require("../../utils/sync");

function formatDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

Page({
  data: {
    id: "",
    loading: true,
    initialized: false,
    submitting: false,
    afterSale: null,
    logs: [],
    shippingCompany: "",
    trackingNo: ""
  },

  onLoad(options = {}) {
    this._initializing = true;
    this.setData({ id: options.id || "" });
    this._unsubscribeSync = sync.subscribe(this, ["after_sale", "refund", "order"], () => {
      const busy = Boolean(this.afterSaleLoading);
      const request = this.load({ silent: true });
      if (busy) Promise.resolve(request).finally(() => this.load({ silent: true })).catch(() => null);
    });
    ensureLogin()
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
    if (this._initializing || !this._loadedOnce || !this.data.id) return;
    this.load({ silent: true });
  },

  onUnload() {
    if (this._unsubscribeSync) this._unsubscribeSync();
  },

  load(options = {}) {
    if (this.afterSaleLoading) return this.afterSaleLoading;
    this.setData({ loading: !options.silent && !this.data.afterSale });
    this.afterSaleLoading = call("getMyAfterSaleDetail", { afterSaleId: this.data.id }, { showLoading: false }).then((data) => {
      const raw = data.afterSale || {};
      const afterSale = {
        ...raw,
        evidenceImages: raw.evidenceImages || [],
        returnLogistics: raw.returnLogistics || {},
        typeText: AFTER_SALE_TYPE_TEXT[raw.afterSaleType] || raw.afterSaleType,
        reasonText: AFTER_SALE_REASON_TEXT[raw.afterSaleReason] || raw.afterSaleReason,
        statusText: AFTER_SALE_STATUS_TEXT[raw.afterSaleStatus] || raw.afterSaleStatus,
        refundText: REFUND_STATUS_TEXT[raw.refundStatus] || raw.refundStatus,
        orderAmountText: moneyText(raw.orderAmount),
        paidAmountText: moneyText(raw.paidAmount),
        requestedRefundText: moneyText(raw.requestedRefundAmount),
        approvedRefundText: moneyText(raw.approvedRefundAmount),
        actualRefundText: moneyText(raw.actualRefundAmount),
        createdAtText: formatDate(raw.createdAt),
        reviewedAtText: formatDate(raw.reviewedAt),
        refundedAtText: formatDate(raw.refundedAt),
        returnItems: (raw.returnItems || []).map((item) => ({
          ...item,
          unitPriceText: moneyText(item.unitPrice),
          refundableAmountText: moneyText(item.refundableAmount)
        }))
      };
      const logistics = raw.returnLogistics || {};
      this.setData({
        afterSale,
        logs: (data.logs || []).map((log) => ({ ...log, createdAtText: formatDate(log.createdAt) })),
        shippingCompany: logistics.shippingCompany || "",
        trackingNo: logistics.trackingNo || ""
      });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => {
        this._loadedOnce = true;
        this.afterSaleLoading = null;
        this.setData({ loading: false, initialized: true });
      });
    return this.afterSaleLoading;
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  submitLogistics() {
    if (this.data.submitting) return;
    if (!this.data.shippingCompany.trim() || !this.data.trackingNo.trim()) {
      feedback.showWarning("请填写快递公司和快递单号");
      return;
    }
    this.setData({ submitting: true });
    call("submitReturnLogistics", {
      afterSaleId: this.data.id,
      shippingCompany: this.data.shippingCompany,
      trackingNo: this.data.trackingNo
    }).then(() => {
      feedback.showSuccess("退货物流已提交");
      this.load();
    }).catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ submitting: false }));
  }
});
