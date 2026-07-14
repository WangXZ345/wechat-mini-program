const { initOrientation, cleanupOrientation } = require("../../../../utils/orientation");
const { call, moneyText, feedback } = require("../../../../utils/api");
const { ensureAdmin } = require("../../../../utils/auth");
const { AFTER_SALE_STATUS_TEXT, REFUND_STATUS_TEXT } = require("../../../../utils/status");
const { generateIdempotencyKey } = require("../../../../utils/idempotency");
const haptics = require("../../../../utils/haptics");

function formatDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function yuanToCents(value) {
  const num = Number(String(value || "").trim());
  if (!Number.isFinite(num)) return NaN;
  return Math.round(num * 100);
}

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    id: "",
    loading: false,
    processing: false,
    refund: null,
    afterSale: null,
    logs: [],
    refundAmountYuan: "",
    financeRemark: "",
    failedReason: "",
    proofImages: []
  },

  onLoad(options = {}) {
    initOrientation(this);
    this.setData({ id: options.id || "" });
    ensureAdmin("refund:view").then(() => this.load()).catch((err) => feedback.showError(err.message));
  },

  onShow() {
    if (this.data.id && this._loadedOnce) this.load({ silent: true });
  },

  load(options = {}) {
    if (this.detailLoading) return this.detailLoading;
    this.setData({ loading: !options.silent && !this.data.refund });
    this.detailLoading = call("getAdminRefundDetail", { refundRecordId: this.data.id }, { showLoading: false }).then((data) => {
      const raw = data.refund || {};
      const afterSaleRaw = data.afterSale || {};
      const refund = {
        ...raw,
        refundProofImages: raw.refundProofImages || [],
        refundText: REFUND_STATUS_TEXT[raw.refundStatus] || raw.refundStatus,
        amountText: moneyText(raw.refundAmount),
        createdAtText: formatDate(raw.createdAt),
        confirmedAtText: formatDate(raw.confirmedAt),
        processedAtText: formatDate(raw.processedAt)
      };
      const afterSale = {
        ...afterSaleRaw,
        statusText: AFTER_SALE_STATUS_TEXT[afterSaleRaw.afterSaleStatus] || afterSaleRaw.afterSaleStatus,
        approvedRefundText: moneyText(afterSaleRaw.approvedRefundAmount),
        actualRefundText: moneyText(afterSaleRaw.actualRefundAmount),
        reviewedAtText: formatDate(afterSaleRaw.reviewedAt)
      };
      this.setData({
        refund,
        afterSale,
        logs: (data.logs || []).map((item) => ({ ...item, createdAtText: formatDate(item.createdAt) })),
        refundAmountYuan: moneyText(raw.refundAmount),
        financeRemark: raw.financeRemark || "",
        failedReason: raw.failedReason || "",
        proofImages: raw.refundProofImages || []
      });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => {
        this._loadedOnce = true;
        this.detailLoading = null;
        this.setData({ loading: false });
      });
    return this.detailLoading;
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  chooseProofImages() {
    const remain = 6 - this.data.proofImages.length;
    if (remain <= 0) return feedback.showWarning("退款凭证最多上传 6 张");
    haptics.medium();
    wx.chooseMedia({ count: remain, mediaType: ["image"], sourceType: ["album", "camera"] })
      .then((res) => {
        const files = (res.tempFiles || []).map((file) => file.tempFilePath).filter(Boolean);
        this.setData({ proofImages: this.data.proofImages.concat(files).slice(0, 6) });
      })
      .catch((err) => {
        if (err && err.message) feedback.showError(err.message);
      });
  },

  removeProof(e) {
    const index = Number(e.currentTarget.dataset.index);
    const proofImages = this.data.proofImages.slice();
    proofImages.splice(index, 1);
    this.setData({ proofImages });
  },

  uploadProofImages() {
    const files = this.data.proofImages || [];
    const uploads = files.map((filePath, index) => {
      if (/^cloud:\/\//.test(filePath) || /^https?:\/\//.test(filePath)) return Promise.resolve(filePath);
      const extMatch = String(filePath || "").match(/\.(jpg|jpeg|png|webp)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
      const cloudPath = `after-sales/refund-proofs/${this.data.id}-${Date.now()}-${index}.${ext}`;
      return wx.cloud.uploadFile({ cloudPath, filePath }).then((res) => res.fileID);
    });
    return Promise.all(uploads);
  },

  processRefund() {
    const refundAmount = yuanToCents(this.data.refundAmountYuan);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) return feedback.showWarning("请填写正确退款金额");
    haptics.warning();
    wx.showModal({
      title: "确认退款",
      content: "确认后会写入退款记录、订单退款字段和客户账款流水。该操作不会发起微信自动退款。",
      confirmText: "确认退款",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ processing: true });
        this.uploadProofImages().then((refundProofImages) => call("processOfflineRefund", {
          refundRecordId: this.data.id,
          refundAmount,
          refundProofImages,
          financeRemark: this.data.financeRemark,
          idempotencyKey: generateIdempotencyKey("confirm_refund")
        })).then(() => {
          feedback.showSuccess("退款已确认");
          this.load();
        }).catch((err) => feedback.showError(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message))
          .finally(() => this.setData({ processing: false }));
      }
    });
  },

  rejectRefund() {
    if (!this.data.failedReason.trim()) return feedback.showWarning("请填写拒绝原因");
    haptics.warning();
    call("rejectRefund", {
      refundRecordId: this.data.id,
      failedReason: this.data.failedReason
    }).then(() => {
      feedback.showSuccess("已拒绝退款记录");
      this.load();
    }).catch((err) => feedback.showError(err.message));
  },

  wechatRefund() {
    haptics.warning();
    call("createWechatPayRefund", { refundRecordId: this.data.id })
      .then(() => feedback.showSuccess("微信退款已提交"))
      .catch((err) => feedback.showError(err.message));
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
