const { call, toast, feedback } = require("../../utils/api");
const { ensureLogin } = require("../../utils/auth");
const { markDirty } = require("../../utils/performanceCache");

Page({
  data: {
    returnUrl: "",
    profile: null,
    phoneNumber: "",
    submitting: false
  },

  onLoad(options = {}) {
    this.setData({ returnUrl: decodeURIComponent(options.returnUrl || "") });
    ensureLogin().then(() => this.load()).catch((err) => toast(err.message));
  },

  load() {
    return call("getMyProfile", {}, { showLoading: false }).then((data) => {
      const profile = data.profile || {};
      this.setData({ profile });
      wx.setNavigationBarTitle({
        title: profile.phoneMasked ? "更换手机号" : "绑定手机号"
      });
    }).catch((err) => feedback.showError(err.message));
  },

  onPhoneInput(e) {
    this.setData({ phoneNumber: e.detail.value });
  },

  async confirmChangeIfNeeded(nextMasked) {
    const profile = this.data.profile || {};
    if (!profile.phoneMasked || profile.phoneMasked === nextMasked) return true;
    return feedback.confirmAction({
      title: "确认更换手机号",
      content: "更换手机号可能影响商家联系你，确认更换吗？",
      confirmText: "确认更换"
    });
  },

  maskedInputPhone() {
    const value = String(this.data.phoneNumber || "").replace(/\D/g, "");
    if (!/^1[3-9]\d{9}$/.test(value)) return "";
    return `${value.slice(0, 3)}****${value.slice(7)}`;
  },

  onGetPhoneNumber(e) {
    const detail = e.detail || {};
    if (detail.errMsg !== "getPhoneNumber:ok") {
      feedback.showWarning("你已取消手机号授权");
      return;
    }
    if (!detail.code) {
      feedback.showWarning("授权 code 为空，请重新授权");
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    call("bindPhoneByWechat", { code: detail.code })
      .then((data) => this.handleBindSuccess(data, data.message || "手机号绑定成功"))
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ submitting: false }));
  },

  async submitManual() {
    if (this.data.submitting) return;
    const nextMasked = this.maskedInputPhone();
    if (!nextMasked) {
      feedback.showWarning("请输入正确的手机号");
      return;
    }
    const confirmed = await this.confirmChangeIfNeeded(nextMasked);
    if (!confirmed) return;
    this.setData({ submitting: true });
    call("bindPhoneManual", { phoneNumber: this.data.phoneNumber })
      .then((data) => this.handleBindSuccess(data, data.message || "手机号已保存"))
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ submitting: false }));
  },

  handleBindSuccess(data, message) {
    feedback.showSuccess(message);
    markDirty("profile");
    if (data && data.profile) {
      this.setData({ profile: data.profile, phoneNumber: "" });
    }
    setTimeout(() => this.returnBack(), 800);
  },

  returnBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
      return;
    }
    wx.redirectTo({ url: "/pages/profile/index" });
  }
});
