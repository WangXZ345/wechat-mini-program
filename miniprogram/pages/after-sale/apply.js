const { call, moneyText, feedback } = require("../../utils/api");
const { ensureLogin } = require("../../utils/auth");
const { AFTER_SALE_TYPE_TEXT, AFTER_SALE_REASON_TEXT } = require("../../utils/status");
const { getOrCreateSubmitKey, clearSubmitKey } = require("../../utils/idempotency");
const haptics = require("../../utils/haptics");

const MIN_REASON_LENGTH = 5;

const TYPE_OPTIONS = [
  { label: "仅退款", value: "refund_only" },
  { label: "退货退款", value: "return_refund" },
  { label: "换货", value: "exchange" },
  { label: "补发", value: "resend" },
  { label: "退款差额", value: "price_adjustment_refund" }
];

const REASON_OPTIONS = [
  { label: "客户取消", value: "customer_cancel" },
  { label: "缺货", value: "out_of_stock" },
  { label: "错发", value: "wrong_item" },
  { label: "少件", value: "missing_item" },
  { label: "破损", value: "damaged" },
  { label: "瑕疵", value: "defective" },
  { label: "质量问题", value: "quality_issue" },
  { label: "价格异常", value: "price_error" },
  { label: "客户多付", value: "overpaid" },
  { label: "重复付款", value: "duplicate_payment" },
  { label: "地址问题", value: "address_issue" },
  { label: "物流问题", value: "shipping_issue" },
  { label: "其他", value: "other" }
];

function yuanToCents(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const num = Number(text);
  if (!Number.isFinite(num)) return NaN;
  return Math.round(num * 100);
}

function reasonCharLength(value) {
  return String(value || "").replace(/\s+/g, "").length;
}

Page({
  data: {
    orderId: "",
    order: null,
    loading: false,
    submitting: false,
    typeOptions: TYPE_OPTIONS,
    reasonOptions: REASON_OPTIONS,
    typeIndex: 0,
    reasonIndex: 0,
    minReasonLength: MIN_REASON_LENGTH,
    reasonCharCount: 0,
    customerReasonDetail: "",
    customerRemark: "",
    refundAmountYuan: "",
    evidenceImages: [],
    items: []
  },

  onLoad(options = {}) {
    this.setData({ orderId: options.orderId || options.id || "" });
    ensureLogin().then(() => this.loadOrder()).catch((err) => feedback.showError(err.message));
  },

  loadOrder() {
    this.setData({ loading: true });
    return call("getOrders", { orderId: this.data.orderId }, { showLoading: false }).then((data) => {
      const order = (data.orders || []).find((item) => item._id === this.data.orderId);
      if (!order) throw new Error("订单不存在");
      const paidAmount = Number(order.paidAmount || (order.paymentStatus === "paid" || order.status === "paid" ? order.totalAmount : 0) || 0);
      const totalRefundAmount = Number(order.totalRefundAmount || 0);
      const maxRefundableAmount = Math.max(paidAmount - totalRefundAmount, 0);
      const items = (order.items || []).map((item) => {
        const availableQuantity = Math.max(Number(item.quantity || 0) - Number(item.afterSaleQuantity || 0) - Number(item.refundedQuantity || 0), 0);
        return {
          ...item,
          selected: availableQuantity > 0,
          applyQuantity: availableQuantity > 0 ? 1 : 0,
          availableQuantity,
          unitPriceText: moneyText(item.unitPrice),
          totalText: moneyText(item.totalAmount)
        };
      });
      this.setData({
        order: {
          ...order,
          paidAmount,
          totalRefundAmount,
          maxRefundableAmount,
          totalText: moneyText(order.totalAmount),
          paidText: moneyText(paidAmount),
          refundedText: moneyText(totalRefundAmount),
          refundableText: moneyText(maxRefundableAmount)
        },
        items,
        refundAmountYuan: maxRefundableAmount ? moneyText(maxRefundableAmount) : ""
      });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ loading: false }));
  },

  onTypeChange(e) {
    haptics.selection();
    this.setData({ typeIndex: Number(e.detail.value || 0) });
  },

  onReasonChange(e) {
    haptics.selection();
    this.setData({ reasonIndex: Number(e.detail.value || 0) });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    if (field === "customerReasonDetail") {
      const value = e.detail.value || "";
      this.setData({
        customerReasonDetail: value,
        reasonCharCount: reasonCharLength(value)
      });
      return;
    }
    this.setData({ [field]: e.detail.value });
  },

  toggleItem(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.items[index];
    if (!item || item.availableQuantity <= 0) return;
    haptics.selection();
    this.setData({ [`items[${index}].selected`]: !item.selected });
  },

  onQuantityInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.items[index];
    if (!item) return;
    const value = Math.max(0, Math.min(Number(e.detail.value || 0), item.availableQuantity));
    this.setData({ [`items[${index}].applyQuantity`]: Math.round(value) });
  },

  chooseImages() {
    const remain = 6 - this.data.evidenceImages.length;
    if (remain <= 0) return feedback.showWarning("图片凭证最多上传 6 张");
    haptics.medium();
    wx.chooseMedia({
      count: remain,
      mediaType: ["image"],
      sourceType: ["album", "camera"]
    }).then((res) => {
      const files = (res.tempFiles || []).map((file) => file.tempFilePath).filter(Boolean);
      this.setData({ evidenceImages: this.data.evidenceImages.concat(files).slice(0, 6) });
    }).catch((err) => {
      if (err && err.message) feedback.showError(err.message);
    });
  },

  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const evidenceImages = this.data.evidenceImages.slice();
    evidenceImages.splice(index, 1);
    this.setData({ evidenceImages });
  },

  uploadEvidenceImages() {
    const files = this.data.evidenceImages || [];
    const uploads = files.map((filePath, index) => {
      if (/^cloud:\/\//.test(filePath) || /^https?:\/\//.test(filePath)) return Promise.resolve(filePath);
      const extMatch = String(filePath || "").match(/\.(jpg|jpeg|png|webp)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
      const cloudPath = `after-sales/evidence/${this.data.orderId}-${Date.now()}-${index}.${ext}`;
      return wx.cloud.uploadFile({ cloudPath, filePath }).then((res) => res.fileID);
    });
    return Promise.all(uploads);
  },

  validateForm() {
    const reason = String(this.data.customerReasonDetail || "").trim();
    if (!reason) throw new Error("请填写详细的售后原因，方便客服审核");
    const compact = reason.replace(/\s+/g, "");
    if (compact.length < MIN_REASON_LENGTH) {
      throw new Error(`详细原因至少填写 ${MIN_REASON_LENGTH} 个字，例如：拍错了商品、客户取消订单、商品临时缺货。`);
    }
    const selectedItems = this.data.items.filter((item) => item.selected && Number(item.applyQuantity || 0) > 0);
    if (!selectedItems.length) throw new Error("请选择售后商品和申请数量");
    const requestedRefundAmount = yuanToCents(this.data.refundAmountYuan);
    if (!Number.isFinite(requestedRefundAmount)) throw new Error("退款金额格式错误");
    if (requestedRefundAmount > Number(this.data.order.maxRefundableAmount || 0)) throw new Error("申请退款金额不能超过可退金额");
    return { selectedItems, requestedRefundAmount };
  },

  submit() {
    if (this.data.submitting) return;
    let checked;
    try {
      checked = this.validateForm();
    } catch (err) {
      haptics.error();
      feedback.showWarning(err.message);
      return;
    }
    haptics.medium();
    const type = this.data.typeOptions[this.data.typeIndex] || TYPE_OPTIONS[0];
    const reason = this.data.reasonOptions[this.data.reasonIndex] || REASON_OPTIONS[0];
    const returnItems = checked.selectedItems.map((item) => ({
      orderItemId: item._id || "",
      productId: item.productId || "",
      returnQuantity: Number(item.applyQuantity || 0),
      refundableAmount: Math.min(Number(item.unitPrice || 0) * Number(item.applyQuantity || 0), checked.requestedRefundAmount || Number(item.totalAmount || 0)),
      itemReason: reason.label,
      imageUrl: ""
    }));
    this.setData({ submitting: true });
    const idempotencyKey = getOrCreateSubmitKey(`create_after_sale_${this.data.orderId}`);
    this.uploadEvidenceImages().then((evidenceImages) => call("createAfterSaleRequest", {
      orderId: this.data.orderId,
      afterSaleType: type.value,
      afterSaleReason: reason.value,
      customerReasonDetail: this.data.customerReasonDetail,
      customerRemark: this.data.customerRemark,
      requestedRefundAmount: checked.requestedRefundAmount,
      evidenceImages,
      returnItems,
      idempotencyKey
    })).then((data) => {
      clearSubmitKey(`create_after_sale_${this.data.orderId}`);
      haptics.success();
      feedback.showSuccess("售后申请已提交，请等待客服审核。");
      wx.redirectTo({ url: `/pages/after-sale/detail?id=${data.afterSaleId}` });
    }).catch((err) => {
      if (err.code === "IDEMPOTENCY_KEY_CONFLICT") clearSubmitKey(`create_after_sale_${this.data.orderId}`);
      haptics.error();
      feedback.showError(err.code === "IDEMPOTENCY_PROCESSING" ? "操作正在处理中，请稍候" : err.message);
    })
      .finally(() => this.setData({ submitting: false }));
  }
});
