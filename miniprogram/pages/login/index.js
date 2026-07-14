const { call, feedback } = require("../../utils/api");
const haptics = require("../../utils/haptics");
const session = require("../../utils/session");
const { initOrientation, cleanupOrientation } = require("../../utils/orientation");

function normalizePhone(value) {
  return String(value || "").trim().replace(/\D/g, "").slice(0, 11);
}

function validPhone(value) {
  return /^1[3-9]\d{9}$/.test(value);
}

function shouldFallbackToLegacyLogin(err) {
  const message = String(err && err.message || err || "");
  return /FUNCTION_NOT_FOUND|functionName parameter could not be found|could not be found|not found/i.test(message);
}

Page({
  data: {
    phone: "",
    password: "",
    resetPhone: "",
    resetVisible: false,
    wechatLoading: false,
    passwordLoading: false,
    resetLoading: false,
    returnUrl: "",
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false
  },

  onLoad(options = {}) {
    initOrientation(this);
    this.setData({ returnUrl: options.returnUrl || "" });
    const loginSession = session.getLoginSession();
    if (loginSession) {
      session.redirectAfterLogin(loginSession.adminProfile, options.returnUrl || "");
    }
  },

  onUnload() {
    cleanupOrientation(this);
  },

  onPhoneInput(e) {
    this.setData({ phone: normalizePhone(e.detail.value) });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  onResetPhoneInput(e) {
    this.setData({ resetPhone: normalizePhone(e.detail.value) });
  },

  finishLogin(data) {
    const loginSession = session.saveLoginSession(data || {});
    haptics.success();
    feedback.showSuccess("登录成功");
    setTimeout(() => {
      session.redirectAfterLogin(loginSession.adminProfile, this.data.returnUrl);
    }, 300);
  },

  legacyWechatLogin() {
    return call("login", {}, { showLoading: false })
      .then((legacyData) => {
        return call("getCurrentAdminProfile", {}, { showLoading: false })
          .catch(() => null)
          .then((adminProfile) => ({
            loginType: "wechat",
            user: legacyData.user || {},
            adminProfile: adminProfile || legacyData.adminProfile || null,
            expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
          }));
      });
  },

  loginWechat() {
    if (this.data.wechatLoading || this.data.passwordLoading) return;
    haptics.medium();
    this.setData({ wechatLoading: true });
    wx.login({
      complete: () => {
        call("loginWithWechat", {}, { showLoading: false })
          .catch((err) => {
            if (!shouldFallbackToLegacyLogin(err)) throw err;
            return this.legacyWechatLogin();
          })
          .then((data) => this.finishLogin(data))
          .catch((err) => {
            haptics.error();
            feedback.showError(err.message);
          })
          .finally(() => this.setData({ wechatLoading: false }));
      }
    });
  },

  loginPassword() {
    if (this.data.passwordLoading || this.data.wechatLoading) return;
    const phone = normalizePhone(this.data.phone);
    const password = String(this.data.password || "");
    if (!validPhone(phone)) {
      haptics.error();
      feedback.showWarning("请输入正确的手机号");
      return;
    }
    if (password.length < 6) {
      haptics.error();
      feedback.showWarning("密码长度至少 6 位");
      return;
    }

    haptics.medium();
    this.setData({ passwordLoading: true });
    call("loginWithPassword", { phone, password }, { showLoading: false })
      .then((data) => this.finishLogin(data))
      .catch((err) => {
        haptics.error();
        feedback.showError(err.message);
      })
      .finally(() => this.setData({ passwordLoading: false }));
  },

  goPasswordSettings() {
    const loginSession = session.getLoginSession();
    if (!loginSession) {
      feedback.showInfo("请先使用微信快捷登录，再设置或修改密码");
      return;
    }
    const hasPassword = Boolean(loginSession.user && loginSession.user.hasPassword);
    wx.navigateTo({ url: `/pages/login/password?mode=${hasPassword ? "change" : "set"}` });
  },

  showResetForm() {
    this.setData({
      resetVisible: true,
      resetPhone: this.data.phone || ""
    });
  },

  hideResetForm() {
    if (this.data.resetLoading) return;
    this.setData({ resetVisible: false });
  },

  submitReset() {
    const phone = normalizePhone(this.data.resetPhone);
    if (!validPhone(phone)) {
      haptics.error();
      feedback.showWarning("请输入正确的手机号");
      return;
    }
    this.setData({ resetLoading: true });
    call("resetPasswordRequest", { phone }, { showLoading: false })
      .then((data) => {
        haptics.success();
        feedback.showSuccess(data.message || "已提交申请");
        this.setData({ resetVisible: false, resetPhone: "" });
      })
      .catch((err) => {
        haptics.error();
        feedback.showError(err.message);
      })
      .finally(() => this.setData({ resetLoading: false }));
  },

  goLegal(e) {
    const page = e.currentTarget.dataset.page;
    if (!page) return;
    wx.navigateTo({ url: `/pages/legal/${page}/index` });
  }
});
