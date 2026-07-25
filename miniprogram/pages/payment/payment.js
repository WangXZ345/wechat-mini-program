const { call, moneyText, toast, feedback } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin } = require("../../utils/auth");
const { createSubmitKey, clearSubmitKey } = require("../../utils/idempotency");
const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const sync = require("../../utils/sync");
const haptics = require("../../utils/haptics");

const OFFLINE_TYPES = ["wechat_qr", "alipay_qr", "bank_transfer", "custom"];

Page({
  data: {
    id: "",
    order: null,
    paymentMethods: [],
    selectedMethodId: "",
    selectedMethod: null,
    screenshotUrls: [],
    localImages: [],
    remark: "",
    loading: false,
    submitting: false,
    paying: false,
    maxScreenshotCount: 3,
    account: {
      todayText: "0.00",
      historyText: "0.00",
      pendingText: "0.00",
      totalText: "0.00",
      paidText: "0.00",
      unpaidText: "0.00"
    },
    hasPendingPayment: false,
    currentOrderPending: false,
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false
  },

  onLoad(options) {
    this._paymentPageAlive = true;
    initOrientation(this);
    const id = options.id || "";
    if (id) clearSubmitKey(`payment_proof_${id}`);
    this.setData({ id, loading: true });
    ensureLogin()
      .then(() => ensureFrontendAccess())
      .then(() => Promise.all([this.loadOrder(), this.loadAccount()]))
      .then(() => this.loadPaymentMethods())
      .catch((err) => toast(err.message))
      .finally(() => {
        this.setData({ loading: false });
        if (!this._paymentPageAlive || this._unsubscribeSync) return;
        this._unsubscribeSync = sync.subscribe(this, ["order", "payment"], () => {
          if (this.paymentSyncLoading) return;
          this.paymentSyncLoading = Promise.all([this.loadOrder(), this.loadAccount()])
            .catch(() => null)
            .finally(() => {
              this.paymentSyncLoading = null;
            });
        });
      });
  },

  onUnload() {
    this._paymentPageAlive = false;
    if (this._unsubscribeSync) this._unsubscribeSync();
    cleanupOrientation(this);
  },

  loadOrder() {
    return call("getOrders", { orderId: this.data.id }, { showLoading: false }).then((data) => {
      const order = data.orders.find((item) => item._id === this.data.id);
      if (!order) throw new Error("订单不存在");
      this.setData({ order }, () => this.refreshAccountText());
    });
  },

  loadAccount() {
    return call("getAccountSummary", {}, { showLoading: false }).then((data) => {
      this.setData({ rawAccount: data.account || null }, () => this.refreshAccountText());
    });
  },

  loadPaymentMethods() {
    const amount = this.unpaidAmount();
    return call("getEnabledPaymentMethods", { amount }, { showLoading: false }).then((data) => {
      const settings = data.systemSettings || {};
      const methods = (data.paymentMethods || []).map((item) => ({
        ...item,
        typeText: this.typeText(item.paymentType),
        selected: item.paymentMethodId === this.data.selectedMethodId,
        disabled: item.enabled === false,
        tagText: item.isDefault ? "推荐" : ""
      }));
      const selected = methods.find((item) => item.paymentMethodId === this.data.selectedMethodId)
        || methods.find((item) => item.isDefault)
        || methods[0]
        || null;
      this.setData({
        paymentMethods: methods.map((item) => ({ ...item, selected: selected && item.paymentMethodId === selected.paymentMethodId })),
        selectedMethodId: selected ? selected.paymentMethodId : "",
        selectedMethod: selected,
        maxScreenshotCount: Math.max(1, Number(settings.maxPaymentScreenshotCount || 3))
      });
      if (selected) this.selectMethodOnServer(selected.paymentMethodId, { silent: true });
    });
  },

  refreshAccountText() {
    const order = this.data.order;
    if (!order) return;
    const raw = this.data.rawAccount || {};
    const today = Number(raw.todayOrderAmount || order.totalAmount || 0);
    const history = Number(raw.historyUnpaidAmount || 0);
    const pending = Number(raw.pendingConfirmAmount || 0);
    const paid = Number(order.paidAmount || 0);
    const unpaid = this.unpaidAmount(order);
    const payable = raw.payableAmount !== undefined ? Number(raw.payableAmount || 0) : today + history;
    this.setData({
      account: {
        todayText: moneyText(today),
        historyText: moneyText(history),
        pendingText: moneyText(pending),
        totalText: moneyText(payable),
        paidText: moneyText(paid),
        unpaidText: moneyText(unpaid)
      },
      hasPendingPayment: pending > 0 || order.paymentStatus === "pending_confirm",
      currentOrderPending: order.paymentStatus === "pending_confirm"
    });
  },

  unpaidAmount(order = this.data.order) {
    if (!order) return 0;
    if (order.unpaidAmount !== undefined && order.unpaidAmount !== null) return Math.max(0, Number(order.unpaidAmount || 0));
    return Math.max(0, Number(order.totalAmount || 0) - Number(order.paidAmount || 0));
  },

  typeText(type) {
    return {
      wechat_qr: "微信收款码",
      alipay_qr: "支付宝收款码",
      bank_transfer: "银行卡转账",
      wechat_pay: "微信支付",
      custom: "其他方式"
    }[type] || type;
  },

  selectMethod(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.submitting || this.data.paying) return;
    haptics.selection();
    this.selectMethodOnServer(id);
  },

  selectMethodOnServer(id, options = {}) {
    const method = this.data.paymentMethods.find((item) => item.paymentMethodId === id);
    if (!method) return Promise.resolve();
    return call("selectOrderPaymentMethod", {
      orderId: this.data.id,
      paymentMethodId: id
    }, { showLoading: !options.silent }).then((data) => {
      const selected = data.paymentMethod || method;
      this.setData({
        selectedMethodId: id,
        selectedMethod: selected,
        paymentMethods: this.data.paymentMethods.map((item) => ({ ...item, selected: item.paymentMethodId === id }))
      });
    }).catch((err) => {
      if (!options.silent) {
        haptics.error();
        feedback.showError(err.message);
      }
    });
  },

  previewQr() {
    const method = this.data.selectedMethod;
    const url = method && method.qrCodeUrl;
    if (!url) return feedback.showWarning("暂无收款二维码");
    wx.previewImage({ urls: [url], current: url });
  },

  chooseImages() {
    const remain = this.data.maxScreenshotCount - this.data.localImages.length;
    if (remain <= 0) return feedback.showWarning(`最多上传 ${this.data.maxScreenshotCount} 张截图`);
    haptics.medium();
    wx.chooseMedia({
      count: remain,
      mediaType: ["image"],
      sourceType: ["album", "camera"]
    }).then((res) => {
      const files = (res.tempFiles || []).filter(Boolean);
      if (!files.length) return;
      const tooLarge = files.find((file) => file.size && file.size > 10 * 1024 * 1024);
      if (tooLarge) return feedback.showWarning("单张付款截图不能超过 10MB");
      this.setData({
        localImages: this.data.localImages.concat(files.map((file) => file.tempFilePath)),
        screenshotUrls: []
      });
    }).catch(() => null);
  },

  previewScreenshot(e) {
    const current = e.currentTarget.dataset.url;
    if (!current) return;
    wx.previewImage({ urls: this.data.localImages, current });
  },

  removeScreenshot(e) {
    const index = Number(e.currentTarget.dataset.index);
    const localImages = this.data.localImages.slice();
    localImages.splice(index, 1);
    this.setData({ localImages, screenshotUrls: [] });
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value });
  },

  uploadScreenshots() {
    const cachedUrls = this.data.screenshotUrls || [];
    if (cachedUrls.length && cachedUrls.length === this.data.localImages.length) {
      return Promise.resolve(cachedUrls);
    }
    const orderId = this.data.id;
    return Promise.all(this.data.localImages.map((filePath, index) => {
      const extMatch = String(filePath).match(/\.(jpg|jpeg|png|webp)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
      const cloudPath = `payments/${orderId}/${Date.now()}-${index}.${ext}`;
      return wx.cloud.uploadFile({ cloudPath, filePath }).then((upload) => upload.fileID);
    })).then((screenshotUrls) => {
      this.setData({ screenshotUrls });
      return screenshotUrls;
    });
  },

  submitOfflineProof() {
    if (this.data.submitting) return;
    if (this.data.currentOrderPending) return feedback.showInfo("当前订单付款正在等待财务确认，请勿重复提交");
    const method = this.data.selectedMethod;
    if (!method) return feedback.showWarning("请选择付款方式");
    if (!OFFLINE_TYPES.includes(method.paymentType)) return feedback.showWarning("该方式不需要提交截图");
    if (!this.data.localImages.length) return feedback.showWarning("请先上传至少一张付款截图");
    haptics.medium();
    wx.showModal({
      title: "提交付款凭证",
      content: "提交后将等待财务确认，确认提交吗？",
      confirmText: "提交",
      success: (res) => {
        if (!res.confirm) return;
        haptics.warning();
        this.setData({ submitting: true });
        feedback.showLoading("上传截图");
        this.uploadScreenshots()
          .then((screenshotUrls) => {
            feedback.showLoading("提交凭证");
            const idempotencyKey = createSubmitKey(`payment_proof_${this.data.id}`);
            return call("submitOfflinePaymentProof", {
              orderId: this.data.id,
              paymentMethodId: method.paymentMethodId,
              screenshotUrls,
              remark: this.data.remark,
              idempotencyKey
            }, { showLoading: false });
          })
          .then(() => {
            clearSubmitKey(`payment_proof_${this.data.id}`);
            this.setData({ screenshotUrls: [] });
            haptics.success();
            feedback.showSuccess("付款凭证已提交，请等待财务确认。");
            setTimeout(() => wx.navigateBack(), 900);
          })
          .catch((err) => {
            if (err.code === "IDEMPOTENCY_PROCESSING") {
              clearSubmitKey(`payment_proof_${this.data.id}`);
              return feedback.showInfo("操作正在处理中，请稍候");
            }
            if (err.code === "IDEMPOTENCY_KEY_CONFLICT") {
              clearSubmitKey(`payment_proof_${this.data.id}`);
              this.setData({ screenshotUrls: [] });
            }
            haptics.error();
            feedback.showError(err.message);
          })
          .finally(() => {
            feedback.hideLoading();
            this.setData({ submitting: false });
          });
      }
    });
  },

  copyText(e) {
    const text = e.currentTarget.dataset.text || "";
    if (!text) return feedback.showWarning("暂无可复制内容");
    wx.setClipboardData({
      data: text,
      success: () => feedback.showSuccess("已复制"),
      fail: () => feedback.showError("复制失败")
    });
  },

  copyAllBankInfo() {
    const method = this.data.selectedMethod || {};
    const lines = [
      `收款户名：${method.bankAccountName || ""}`,
      `银行名称：${method.bankName || ""}`,
      `开户支行：${method.bankBranchName || ""}`,
      `银行卡号：${method.bankCardNo || ""}`,
      `转账备注：${method.transferRemark || ""}`
    ].filter((line) => line.split("：")[1]);
    if (!lines.length) return feedback.showWarning("暂无可复制内容");
    wx.setClipboardData({
      data: lines.join("\n"),
      success: () => feedback.showSuccess("已复制"),
      fail: () => feedback.showError("复制失败")
    });
  },

  startWechatPay() {
    const method = this.data.selectedMethod;
    if (!method) return feedback.showWarning("请选择付款方式");
    if (method.paymentType !== "wechat_pay") return;
    if (this.data.paying) return;
    haptics.medium();
    this.setData({ paying: true });
    call("createWechatPayOrder", {
      orderId: this.data.id,
      paymentMethodId: method.paymentMethodId
    }, { showLoading: false }).then((data) => {
      if (!data || !data.payParams) throw new Error("微信支付暂未启用");
      feedback.showInfo("正在调起微信支付");
      return wx.requestPayment(data.payParams);
    }).then(() => call("queryWechatPayOrder", {
      orderId: this.data.id,
      paymentMethodId: method.paymentMethodId
    }, { showLoading: false })).then(() => {
      feedback.showSuccess("支付已确认");
      haptics.success();
      wx.navigateTo({ url: `/pages/order/detail?id=${this.data.id}` });
    }).catch((err) => {
      const message = err && err.errMsg && err.errMsg.includes("cancel") ? "支付已取消" : err.message || "支付失败，请重试或选择其他支付方式";
      haptics.error();
      feedback.showError(message);
    }).finally(() => this.setData({ paying: false }));
  }
});
