const { setCachedAdminProfile } = require("./utils/auth");
const session = require("./utils/session");
const cache = require("./utils/cache");
const sync = require("./utils/sync");

function installLoginGuard() {
  if (typeof Page !== "function" || Page.__loginGuardInstalled) return;
  const originalPage = Page;
  const guardedPage = function guardedPage(config = {}) {
    const rawOnLoad = config.onLoad;
    const rawOnShow = config.onShow;
    config.onLoad = function guardedOnLoad(options) {
      if (!session.isPublicRoute(this.route) && !session.requireLocalLogin()) return;
      if (typeof rawOnLoad === "function") return rawOnLoad.call(this, options);
      return undefined;
    };
    config.onShow = function guardedOnShow(...args) {
      if (!session.isPublicRoute(this.route) && !session.requireLocalLogin()) return;
      if (typeof rawOnShow === "function") return rawOnShow.apply(this, args);
      return undefined;
    };
    return originalPage(config);
  };
  guardedPage.__loginGuardInstalled = true;
  Page = guardedPage;
}

installLoginGuard();

App({
  globalData: {
    envId: "cloud1-d7g4mbc5r2fac4a77",
    user: null,
    isAdmin: false,
    adminProfile: null,
    adminProfileFetchedAt: 0,
    adminProfileLoading: null,
    loginSession: null
  },

  onLaunch() {
    cache.purgeSensitivePageCaches();
    if (!wx.cloud) {
      wx.showModal({
        title: "提示",
        content: "当前基础库不支持云开发，请升级微信开发者工具或基础库版本。",
        showCancel: false
      });
      return;
    }

    const env = this.globalData.envId || undefined;
    wx.cloud.init({
      env,
      traceUser: true
    });

    const loginSession = session.getLoginSession();
    if (!loginSession) return;
    sync.start();

    this.globalData.adminProfileLoading = wx.cloud.callFunction({
      name: "getCurrentAdminProfile",
      data: {}
    }).then((res) => {
      const result = res.result || {};
      const profile = result.ok ? result.data : null;
      this.globalData.adminProfile = profile;
      this.globalData.adminProfileFetchedAt = Date.now();
      this.globalData.isAdmin = !!(profile && profile.isAdmin && profile.status !== "disabled");
      if (profile) setCachedAdminProfile(profile, this);
      if (profile) session.updateAdminProfile(profile);
      return profile;
    }).catch(() => {
      this.globalData.adminProfile = null;
      this.globalData.isAdmin = false;
      return null;
    }).finally(() => {
      this.globalData.adminProfileLoading = null;
    });
  },

  onShow() {
    sync.resume();
  },

  onHide() {
    sync.pause();
  }
});
