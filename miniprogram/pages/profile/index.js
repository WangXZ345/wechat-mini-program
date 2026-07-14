const { call, toast, feedback } = require("../../utils/api");
const { ADMIN_HOME, ensureLogin, getAdminProfile } = require("../../utils/auth");
const session = require("../../utils/session");
const { syncTabBar } = require("../../utils/tabbar");
const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const haptics = require("../../utils/haptics");
const {
  PROFILE_CACHE_TTL_MS,
  clearDirty,
  isDirty,
  readCache,
  scopedCacheKey,
  writeCache
} = require("../../utils/performanceCache");

const METHOD_TEXT = {
  wechat: "微信授权",
  manual_verified: "手动填写，已验证",
  manual_unverified: "手动填写，未验证"
};

const MAX_NICKNAME_LENGTH = 20;
const PROFILE_CACHE_SCOPE = "profile_index_v1";

function normalizeNickname(value) {
  return String(value || "").trim();
}

function dateText(value) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function shapeProfile(profile = {}) {
  return {
    ...profile,
    phoneStatusText: profile.phoneMasked
      ? (profile.phoneVerified ? "已验证" : "未验证")
      : "未绑定",
    bindMethodText: METHOD_TEXT[profile.phoneBindMethod] || "暂无",
    phoneBoundAtText: dateText(profile.phoneBoundAt)
  };
}

function publicProfileCacheState(state = {}) {
  const source = state.profile || {};
  const profile = shapeProfile({
    nickname: source.nickname || "",
    avatarUrl: source.avatarUrl || "",
    openidSuffix: source.openidSuffix || "",
    phoneMasked: source.phoneMasked || "",
    phoneVerified: source.phoneVerified === true,
    phoneBindMethod: source.phoneBindMethod || "",
    phoneBoundAt: source.phoneBoundAt || null
  });
  return {
    profile,
    nicknameDraft: normalizeNickname(state.nicknameDraft || profile.nickname)
  };
}

Page({
  data: {
    profile: null,
    editingNickname: false,
    nicknameDraft: "",
    savingNickname: false,
    isAdmin: false,
    adminProfile: null,
    roleName: "普通用户",
    roleHint: "",
    showCustomerEntries: true,
    showAdminEntry: false,
    backendOnly: false,
    loading: false,
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false
  },

  onLoad() {
    this._profileInitializing = true;
    initOrientation(this);
    const hasCache = this.applyProfileCache();
    ensureLogin().then(() => {
      return this.load({ force: true, silent: hasCache });
    }).catch((err) => toast(err.message))
      .finally(() => {
        this._profileInitializing = false;
      });
  },

  onShow() {
    syncTabBar(this, 3);
    if (this._profileInitializing) return;
    const hasCache = Boolean(this.data.profile) || this.applyProfileCache();
    const cached = readCache(scopedCacheKey(PROFILE_CACHE_SCOPE), PROFILE_CACHE_TTL_MS);
    if (isDirty("profile") || !cached || cached.expired) {
      this.load({ silent: hasCache });
    }
  },

  onPullDownRefresh() {
    this.load({ silent: true }).finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    cleanupOrientation(this);
  },

  applyProfileCache() {
    const cached = readCache(scopedCacheKey(PROFILE_CACHE_SCOPE), PROFILE_CACHE_TTL_MS);
    if (!cached || !cached.data || !cached.data.profile) return false;
    this.setData({
      ...cached.data,
      loading: false
    });
    return true;
  },

  load(options = {}) {
    if (this.profileLoading && !options.force) return this.profileLoading;
    this.setData({ loading: !options.silent });
    this.profileLoading = call("getMyProfile", {}, { showLoading: false }).then((data) => {
      const profile = data.profile || {};
      const profileState = {
        profile: shapeProfile(profile),
        nicknameDraft: this.data.editingNickname ? this.data.nicknameDraft : (profile.nickname || "")
      };
      this.setData(profileState);
      return getAdminProfile().then((adminProfile) => {
        const backendOnly = adminProfile.canAccessFrontend === false;
        const state = {
          ...profileState,
          adminProfile,
          isAdmin: !!adminProfile.isAdmin && adminProfile.status !== "disabled",
          roleName: adminProfile.roleName || "普通用户",
          roleHint: adminProfile.roleHint || "",
          showCustomerEntries: adminProfile.canAccessFrontend !== false,
          showAdminEntry: adminProfile.canAccessAdmin === true,
          backendOnly
        };
        this.setData(state);
        writeCache(scopedCacheKey(PROFILE_CACHE_SCOPE), publicProfileCacheState(state));
        clearDirty("profile");
      }).catch(() => {
        const state = {
          ...profileState,
          adminProfile: null,
          isAdmin: false,
          roleName: "普通用户",
          roleHint: "",
          showCustomerEntries: true,
          showAdminEntry: false,
          backendOnly: false
        };
        this.setData(state);
        writeCache(scopedCacheKey(PROFILE_CACHE_SCOPE), publicProfileCacheState(state));
      });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => {
        this.profileLoading = null;
        this.setData({ loading: false });
      });
    return this.profileLoading;
  },

  startEditNickname() {
    haptics.light();
    const profile = this.data.profile || {};
    this.setData({
      editingNickname: true,
      nicknameDraft: profile.nickname || ""
    });
  },

  onNicknameInput(e) {
    this.setData({ nicknameDraft: e.detail.value });
  },

  cancelEditNickname() {
    if (this.data.savingNickname) return;
    const profile = this.data.profile || {};
    this.setData({
      editingNickname: false,
      nicknameDraft: profile.nickname || ""
    });
  },

  saveNickname() {
    if (this.data.savingNickname) return;
    const nickname = normalizeNickname(this.data.nicknameDraft);
    if (!nickname) {
      haptics.error();
      feedback.showWarning("请输入昵称");
      return;
    }
    if (Array.from(nickname).length > MAX_NICKNAME_LENGTH) {
      haptics.error();
      feedback.showWarning(`昵称不能超过 ${MAX_NICKNAME_LENGTH} 个字符`);
      return;
    }

    const currentNickname = normalizeNickname(this.data.profile && this.data.profile.nickname);
    if (nickname === currentNickname) {
      this.setData({ editingNickname: false, nicknameDraft: currentNickname });
      feedback.showInfo("昵称没有变化");
      return;
    }

    haptics.medium();
    this.setData({ savingNickname: true });
    call("getMyProfile", { nickname }, { loadingText: "保存中" })
      .then((data) => {
        const profile = data.profile || {};
        const state = {
          profile: shapeProfile(profile),
          editingNickname: false,
          nicknameDraft: profile.nickname || ""
        };
        this.setData(state);
        writeCache(scopedCacheKey(PROFILE_CACHE_SCOPE), publicProfileCacheState({
          ...this.data,
          ...state
        }));
        clearDirty("profile");
        haptics.success();
        feedback.showSuccess("昵称已保存");
      })
      .catch((err) => {
        haptics.error();
        feedback.showError(err.message);
      })
      .finally(() => this.setData({ savingNickname: false }));
  },

  goBindPhone() {
    haptics.selection();
    wx.navigateTo({ url: "/pages/profile/bind-phone" });
  },

  goAddressList() {
    haptics.selection();
    wx.navigateTo({ url: "/pages/address/list" });
  },

  goAfterSales() {
    haptics.selection();
    wx.navigateTo({ url: "/pages/after-sale/list" });
  },

  goOrders() {
    haptics.selection();
    wx.switchTab({ url: "/pages/order/list" });
  },

  goAdmin() {
    if (!this.data.showAdminEntry) return toast("无权限访问后台");
    haptics.medium();
    wx.navigateTo({ url: ADMIN_HOME });
  },

  goLegal(e) {
    const page = e.currentTarget.dataset.page;
    if (!page) return;
    haptics.selection();
    wx.navigateTo({ url: `/pages/legal/${page}/index` });
  },

  goPasswordSettings() {
    const loginSession = session.getLoginSession();
    const hasPassword = Boolean(loginSession && loginSession.user && loginSession.user.hasPassword);
    haptics.selection();
    wx.navigateTo({ url: `/pages/login/password?mode=${hasPassword ? "change" : "set"}` });
  },

  logout() {
    wx.showModal({
      title: "退出登录",
      content: "退出后将清除本地登录状态和页面缓存。",
      confirmText: "退出",
      confirmColor: "#9A2D2D",
      success: (res) => {
        if (!res.confirm) return;
        haptics.warning();
        call("logout", {}, { showLoading: false })
          .catch(() => null)
          .finally(() => {
            session.clearLoginSession();
            wx.reLaunch({ url: session.LOGIN_PAGE });
          });
      }
    });
  }
});
