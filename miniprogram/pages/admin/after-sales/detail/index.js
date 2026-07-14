const { initOrientation, cleanupOrientation } = require("../../../../utils/orientation");
const { call, moneyText, feedback } = require("../../../../utils/api");
const { ensureAdmin } = require("../../../../utils/auth");
const { AFTER_SALE_TYPE_TEXT, AFTER_SALE_REASON_TEXT, AFTER_SALE_STATUS_TEXT, REFUND_STATUS_TEXT } = require("../../../../utils/status");
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
    saving: false,
    afterSale: null,
    refundRecords: [],
    logs: [],
    adminReviewRemark: "",
    rejectReason: "",
    approvedRefundAmountYuan: "",
    returnRequired: false,
    inspectionCondition: "sellable",
    canRestock: false,
    restockQuantity: "",
    inspectionRemark: ""
  },

  onLoad(options = {}) {
    initOrientation(this);
    this.setData({ id: options.id || "" });
    ensureAdmin("after_sale:view").then(() => this.load()).catch((err) => feedback.showError(err.message));
  },

  onShow() {
    if (this.data.id && this._loadedOnce) this.load({ silent: true });
  },

  load(options = {}) {
    if (this.detailLoading) return this.detailLoading;
    this.setData({ loading: !options.silent && !this.data.afterSale });
    this.detailLoading = call("getAdminAfterSaleDetail", { afterSaleId: this.data.id }, { showLoading: false }).then((data) => {
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
        maxRefundableText: moneyText(raw.maxRefundableAmount),
        requestedRefundText: moneyText(raw.requestedRefundAmount),
        approvedRefundText: moneyText(raw.approvedRefundAmount),
        actualRefundText: moneyText(raw.actualRefundAmount),
        createdAtText: formatDate(raw.createdAt),
        reviewedAtText: formatDate(raw.reviewedAt),
        returnItems: (raw.returnItems || []).map((item) => ({
          ...item,
          unitPriceText: moneyText(item.unitPrice),
          refundableAmountText: moneyText(item.refundableAmount)
        }))
      };
      this.setData({
        afterSale,
        refundRecords: (data.refundRecords || []).map((item) => ({
          ...item,
          refundAmountText: moneyText(item.refundAmount),
          refundText: REFUND_STATUS_TEXT[item.refundStatus] || item.refundStatus,
          createdAtText: formatDate(item.createdAt)
        })),
        logs: (data.logs || []).map((item) => ({ ...item, createdAtText: formatDate(item.createdAt) })),
        adminReviewRemark: raw.adminReviewRemark || "",
        rejectReason: raw.rejectReason || "",
        approvedRefundAmountYuan: raw.approvedRefundAmount ? moneyText(raw.approvedRefundAmount) : moneyText(raw.requestedRefundAmount),
        returnRequired: raw.returnRequired === true
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

  onSwitch(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  review(e) {
    const action = e.currentTarget.dataset.action;
    const approvedRefundAmount = yuanToCents(this.data.approvedRefundAmountYuan);
    haptics.warning();
    if (action === "approve" && !Number.isFinite(approvedRefundAmount)) return feedback.showWarning("审批金额格式错误");
    if (action === "reject" && !this.data.rejectReason.trim()) return feedback.showWarning("请填写拒绝原因");
    const title = action === "approve" ? "审核通过售后" : "审核拒绝售后";
    wx.showModal({
      title,
      content: action === "approve" ? "通过后将进入待退款或待退货流程，财务仍需单独确认退款。" : "拒绝后不能创建退款记录。",
      confirmText: action === "approve" ? "通过" : "拒绝",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ saving: true });
        call("reviewAfterSale", {
          afterSaleId: this.data.id,
          action,
          approvedRefundAmount,
          adminReviewRemark: this.data.adminReviewRemark,
          rejectReason: this.data.rejectReason,
          returnRequired: this.data.returnRequired,
          idempotencyKey: generateIdempotencyKey("review_after_sale")
        }).then(() => {
          feedback.showSuccess("已处理");
          this.load();
        }).catch((err) => feedback.showError(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message))
          .finally(() => this.setData({ saving: false }));
      }
    });
  },

  confirmReceived() {
    call("confirmReturnReceived", { afterSaleId: this.data.id })
      .then(() => {
        feedback.showSuccess("已确认收货");
        this.load();
      })
      .catch((err) => feedback.showError(err.message));
  },

  inspect() {
    call("inspectReturnItems", {
      afterSaleId: this.data.id,
      itemCondition: this.data.inspectionCondition,
      canRestock: this.data.canRestock,
      restockQuantity: Number(this.data.restockQuantity || 0),
      inspectionRemark: this.data.inspectionRemark,
      idempotencyKey: generateIdempotencyKey("after_sale_restock")
    }).then(() => {
      feedback.showSuccess("验货已保存");
      this.load();
    }).catch((err) => feedback.showError(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message));
  },

  createRefund() {
    const amount = Number(this.data.afterSale && this.data.afterSale.approvedRefundAmount || 0);
    if (amount <= 0) return feedback.showWarning("审批退款金额必须大于 0");
    call("createRefundRecord", {
      afterSaleId: this.data.id,
      refundAmount: amount,
      refundMethod: "offline",
      financeRemark: "售后审核通过后创建退款记录",
      idempotencyKey: generateIdempotencyKey("create_refund")
    }).then((data) => {
      feedback.showSuccess("退款记录已创建");
      wx.navigateTo({ url: `/pages/admin/refunds/detail/index?id=${data.refundRecordId}` });
    }).catch((err) => feedback.showError(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message));
  },

  complete() {
    call("completeAfterSale", {
      afterSaleId: this.data.id,
      remark: "后台标记售后完成",
      idempotencyKey: generateIdempotencyKey("complete_after_sale")
    })
      .then(() => {
        feedback.showSuccess("售后已完成");
        this.load();
      })
      .catch((err) => feedback.showError(err.message));
  },

  goRefund(e) {
    wx.navigateTo({ url: `/pages/admin/refunds/detail/index?id=${e.currentTarget.dataset.id}` });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
