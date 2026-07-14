const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const { call, feedback, moneyText } = require("../../../utils/api");
const { ensureAnyPermission } = require("../../../utils/auth");

const PAYMENT_TYPES = [
  { label: "微信收款码", value: "wechat_qr" },
  { label: "支付宝收款码", value: "alipay_qr" },
  { label: "银行卡转账", value: "bank_transfer" },
  { label: "微信支付", value: "wechat_pay" },
  { label: "其他方式", value: "custom" }
];

const CREATE_TYPES = [
  {
    label: "微信收款码",
    value: "wechat_qr",
    name: "微信收款码",
    desc: "上传微信收款二维码，客户扫码付款后上传截图。"
  },
  {
    label: "支付宝收款码",
    value: "alipay_qr",
    name: "支付宝收款码",
    desc: "上传支付宝收款二维码，客户付款后上传截图。"
  },
  {
    label: "银行卡转账",
    value: "bank_transfer",
    name: "银行卡转账",
    desc: "填写户名、银行卡号、开户行，客户可一键复制转账信息。"
  }
];

const EMPTY_FORM = {
  paymentMethodId: "",
  paymentName: "",
  paymentType: "wechat_qr",
  description: "",
  qrCodeFileID: "",
  qrCodeUrl: "",
  qrCodeCloudPath: "",
  bankAccountName: "",
  bankName: "",
  bankBranchName: "",
  bankCardNo: "",
  transferRemark: "",
  enabled: false,
  isDefault: false,
  sortIndex: 0,
  minAmount: "",
  maxAmount: "",
  extraTips: "",
  wechatPayConfigStatus: "not_configured"
};

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    loading: false,
    saving: false,
    uploading: false,
    methods: [],
    typeOptions: PAYMENT_TYPES,
    createTypes: CREATE_TYPES,
    typeIndex: 0,
    typeChooserVisible: false,
    formVisible: false,
    isEditing: false,
    form: { ...EMPTY_FORM },
    original: null,
    canViewSensitive: false,
    wechatPaySettings: null
  },

  onLoad() {
    initOrientation(this);
    ensureAnyPermission(["system:payment_methods", "payment:config", "payment_method:view", "payment:confirm"])
      .then(() => this.load())
      .catch((err) => feedback.showError(err.message || "无权限访问支付配置"));
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return call("getAdminPaymentMethods", { includeSensitive: true }, { showLoading: false })
      .then((data) => {
        const methods = (data.paymentMethods || []).map((item) => ({
          ...item,
          typeText: this.typeText(item.paymentType),
          enabledText: item.enabled && item.status === "active" ? "已启用" : "已停用",
          statusClass: item.enabled && item.status === "active" ? "enabled" : "disabled",
          minAmountText: item.minAmount === null || item.minAmount === undefined ? "不限" : `￥${moneyText(item.minAmount)}`,
          maxAmountText: item.maxAmount === null || item.maxAmount === undefined ? "不限" : `￥${moneyText(item.maxAmount)}`,
          configLabel: item.paymentType === "bank_transfer" ? "银行卡" : item.paymentType === "wechat_pay" ? "商户配置" : "收款码",
          configText: item.paymentType === "bank_transfer"
            ? (item.bankCardNoMasked || "未填写")
            : item.paymentType === "wechat_pay"
              ? (item.wechatPayConfigStatus === "configured" ? "已配置" : "未配置")
              : (item.qrCodeUrl || item.qrCodeFileID ? "已上传" : "未上传")
        }));
        this.setData({
          methods,
          canViewSensitive: data.canViewSensitive === true,
          wechatPaySettings: data.wechatPaySettings || null
        });
      })
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ loading: false }));
  },

  typeText(type) {
    const found = PAYMENT_TYPES.find((item) => item.value === type);
    return found ? found.label : type;
  },

  startCreate() {
    this.setData({ typeChooserVisible: true });
  },

  chooseCreateType(e) {
    const type = e.currentTarget.dataset.type || "wechat_qr";
    const option = CREATE_TYPES.find((item) => item.value === type) || CREATE_TYPES[0];
    const typeIndex = Math.max(0, PAYMENT_TYPES.findIndex((item) => item.value === type));
    this.setData({
      typeChooserVisible: false,
      formVisible: true,
      isEditing: false,
      typeIndex,
      original: null,
      form: {
        ...EMPTY_FORM,
        paymentType: type,
        paymentName: option.name,
        description: option.desc,
        transferRemark: type === "bank_transfer" ? "请备注订单号或手机号" : "",
        extraTips: type === "bank_transfer" ? "转账后请上传付款截图，财务确认后才算已付款。" : "付款后请上传付款截图，财务确认后才算已付款。"
      }
    });
  },

  closeTypeChooser() {
    this.setData({ typeChooserVisible: false });
  },

  startEdit(e) {
    const id = e.currentTarget.dataset.id;
    const method = this.data.methods.find((item) => item._id === id);
    if (!method) return;
    const typeIndex = Math.max(0, PAYMENT_TYPES.findIndex((item) => item.value === method.paymentType));
    this.setData({
      formVisible: true,
      isEditing: true,
      typeIndex,
      original: method,
      form: {
        ...EMPTY_FORM,
        paymentMethodId: method._id,
        paymentName: method.paymentName || "",
        paymentType: method.paymentType || "wechat_qr",
        description: method.description || "",
        qrCodeFileID: method.qrCodeFileID || "",
        qrCodeUrl: method.qrCodeUrl || "",
        qrCodeCloudPath: method.qrCodeCloudPath || "",
        bankAccountName: method.bankAccountName || "",
        bankName: method.bankName || "",
        bankBranchName: method.bankBranchName || "",
        bankCardNo: method.bankCardNo || "",
        transferRemark: method.transferRemark || "",
        enabled: method.enabled === true,
        isDefault: method.isDefault === true,
        sortIndex: method.sortIndex || 0,
        minAmount: method.minAmount === null || method.minAmount === undefined ? "" : method.minAmount,
        maxAmount: method.maxAmount === null || method.maxAmount === undefined ? "" : method.maxAmount,
        extraTips: method.extraTips || "",
        wechatPayConfigStatus: method.wechatPayConfigStatus || "not_configured"
      }
    });
  },

  closeForm() {
    this.setData({ formVisible: false, form: { ...EMPTY_FORM }, original: null });
  },

  onTypeChange(e) {
    const index = Number(e.detail.value || 0);
    const option = PAYMENT_TYPES[index] || PAYMENT_TYPES[0];
    this.setData({ typeIndex: index, "form.paymentType": option.value });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onSwitch(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  buildPayload() {
    const form = this.data.form;
    return {
      paymentMethodId: form.paymentMethodId,
      paymentName: form.paymentName.trim(),
      paymentType: form.paymentType,
      description: form.description.trim(),
      qrCodeFileID: form.qrCodeFileID,
      qrCodeUrl: form.qrCodeUrl,
      qrCodeCloudPath: form.qrCodeCloudPath,
      bankAccountName: form.bankAccountName.trim(),
      bankName: form.bankName.trim(),
      bankBranchName: form.bankBranchName.trim(),
      bankCardNo: String(form.bankCardNo || "").replace(/\s+/g, ""),
      transferRemark: form.transferRemark.trim(),
      enabled: form.enabled === true,
      isDefault: form.isDefault === true,
      sortIndex: Number(form.sortIndex || 0),
      minAmount: form.minAmount === "" ? null : Number(form.minAmount),
      maxAmount: form.maxAmount === "" ? null : Number(form.maxAmount),
      extraTips: form.extraTips.trim(),
      wechatPayConfigStatus: form.wechatPayConfigStatus || "not_configured"
    };
  },

  confirmSensitiveChange(payload) {
    const original = this.data.original;
    if (!original) return Promise.resolve(true);
    const warnings = [];
    if (original.paymentType !== payload.paymentType) warnings.push("支付类型");
    if (String(original.bankCardNo || "") !== String(payload.bankCardNo || "")) warnings.push("银行卡号");
    if (String(original.qrCodeFileID || original.qrCodeUrl || "") !== String(payload.qrCodeFileID || payload.qrCodeUrl || "")) warnings.push("收款二维码");
    if (!warnings.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      wx.showModal({
        title: "确认修改",
        content: `${warnings.join("、")}发生变化。历史订单会继续使用原快照，确认保存吗？`,
        confirmText: "保存",
        success: (res) => resolve(res.confirm)
      });
    });
  },

  save() {
    if (this.data.saving) return;
    const payload = this.buildPayload();
    this.confirmSensitiveChange(payload).then((confirmed) => {
      if (!confirmed) return;
      const fn = this.data.isEditing ? "updatePaymentMethod" : "createPaymentMethod";
      this.setData({ saving: true });
      call(fn, payload)
        .then(() => {
          feedback.showSuccess(this.data.isEditing ? "支付方式已保存" : "支付方式已新增");
          this.closeForm();
          this.load();
        })
        .catch((err) => feedback.showError(err.message))
        .finally(() => this.setData({ saving: false }));
    });
  },

  chooseQrCode() {
    if (this.data.uploading) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"]
    }).then((res) => {
      const file = res.tempFiles && res.tempFiles[0];
      if (!file) return;
      if (file.size && file.size > 5 * 1024 * 1024) {
        feedback.showWarning("二维码图片不能超过 5MB");
        return;
      }
      const extMatch = String(file.tempFilePath || "").match(/\.(jpg|jpeg|png|webp)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
      const cloudPath = `payment-method-qrcodes/${this.data.form.paymentMethodId || "new"}-${Date.now()}.${ext}`;
      this.setData({ uploading: true });
      feedback.showLoading("上传二维码");
      return wx.cloud.uploadFile({ cloudPath, filePath: file.tempFilePath })
        .then((upload) => {
          this.setData({
            "form.qrCodeFileID": upload.fileID,
            "form.qrCodeUrl": upload.fileID,
            "form.qrCodeCloudPath": cloudPath
          });
          if (!this.data.form.paymentMethodId) {
            feedback.showSuccess("二维码已上传，保存后生效");
            return null;
          }
          return call("uploadPaymentQrCode", {
            paymentMethodId: this.data.form.paymentMethodId,
            fileID: upload.fileID,
            qrCodeUrl: upload.fileID,
            cloudPath,
            fileName: cloudPath,
            size: file.size || 0
          }, { showLoading: false }).then(() => {
            feedback.showSuccess("二维码已更新");
            this.load();
          });
        });
    }).catch((err) => {
      if (err && err.message) feedback.showError(err.message);
    }).finally(() => {
      feedback.hideLoading();
      this.setData({ uploading: false });
    });
  },

  previewQr(e) {
    const url = e.currentTarget.dataset.url || this.data.form.qrCodeUrl || this.data.form.qrCodeFileID;
    if (!url) return feedback.showWarning("暂无二维码");
    wx.previewImage({ urls: [url], current: url });
  },

  toggleEnabled(e) {
    const id = e.currentTarget.dataset.id;
    const enabled = e.currentTarget.dataset.enabled === "true";
    const fn = enabled ? "disablePaymentMethod" : "enablePaymentMethod";
    const title = enabled ? "停用支付方式" : "启用支付方式";
    const content = enabled ? "停用后用户端不再展示该支付方式，历史订单不受影响。" : "启用前会校验二维码或银行卡信息是否完整。";
    wx.showModal({
      title,
      content,
      confirmText: enabled ? "停用" : "启用",
      success: (res) => {
        if (!res.confirm) return;
        call(fn, { paymentMethodId: id })
          .then(() => {
            feedback.showSuccess(enabled ? "已停用" : "已启用");
            this.load();
          })
          .catch((err) => feedback.showError(err.message));
      }
    });
  },

  deleteMethod(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "删除支付方式",
      content: "将执行软删除，不会影响历史订单快照。确认删除吗？",
      confirmText: "删除",
      success: (res) => {
        if (!res.confirm) return;
        call("deletePaymentMethod", { paymentMethodId: id })
          .then(() => {
            feedback.showSuccess("已删除");
            this.load();
          })
          .catch((err) => feedback.showError(err.message));
      }
    });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
