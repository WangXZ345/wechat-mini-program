const { call, feedback } = require("../../utils/api");
const haptics = require("../../utils/haptics");
const session = require("../../utils/session");
const { initOrientation, cleanupOrientation } = require("../../utils/orientation");

Page({
  data: {
    mode: "set",
    oldPassword: "",
    password: "",
    confirmPassword: "",
    loading: false,
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false
  },

  onLoad(options = {}) {
    initOrientation(this);
    const loginSession = session.requireLocalLogin();
    if (!loginSession) return;
    const hasPassword = Boolean(loginSession.user && loginSession.user.hasPassword);
    const mode = options.mode === "change" || hasPassword ? "change" : "set";
    this.setData({ mode });
  },

  onUnload() {
    cleanupOrientation(this);
  },

  onOldPasswordInput(e) {
    this.setData({ oldPassword: e.detail.value });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  onConfirmPasswordInput(e) {
    this.setData({ confirmPassword: e.detail.value });
  },

  submit() {
    if (this.data.loading) return;
    const password = String(this.data.password || "");
    const confirmPassword = String(this.data.confirmPassword || "");
    if (password.length < 6) {
      haptics.error();
      feedback.showWarning("密码长度至少 6 位");
      return;
    }
    if (password !== confirmPassword) {
      haptics.error();
      feedback.showWarning("两次输入的密码不一致");
      return;
    }

    const mode = this.data.mode;
    const payload = mode === "change"
      ? {
        oldPassword: this.data.oldPassword,
        newPassword: password,
        confirmPassword
      }
      : {
        password,
        confirmPassword
      };
    if (mode === "change" && !payload.oldPassword) {
      haptics.error();
      feedback.showWarning("请输入原密码");
      return;
    }

    this.setData({ loading: true });
    call(mode === "change" ? "changePassword" : "setPassword", payload, { showLoading: false })
      .then(() => {
        session.updateLoginSession({ user: { hasPassword: true } });
        haptics.success();
        feedback.showSuccess(mode === "change" ? "密码已修改" : "密码已设置");
        setTimeout(() => wx.navigateBack({ delta: 1 }), 500);
      })
      .catch((err) => {
        haptics.error();
        feedback.showError(err.message);
      })
      .finally(() => this.setData({ loading: false }));
  }
});
