const { call } = require("./api");
const session = require("./session");
const {
  canAccessAdmin,
  canAccessFrontend,
  isFullAccessRole,
  normalizeRole,
  roleName,
  shouldDefaultEnterAdmin,
  shouldShowFrontendTabBar
} = require("./role");
const { PROFILE_CACHE_TTL_MS } = require("./performanceCache");

const ADMIN_HOME = "/pages/admin/dashboard/index";
const ADMIN_PROFILE_CACHE_KEY = "admin_profile_cache_v1";

function profileHasPermission(profile, permission) {
  if (!permission) return true;
  if (!profile || profile.status === "disabled") return false;
  if (profile.showAllAdminMenus || isFullAccessRole(profile.role)) return true;
  return Array.isArray(profile.permissions)
    && (profile.permissions.includes("*") || profile.permissions.includes(permission));
}

function profileHasAnyPermission(profile, permissions) {
  if (!permissions || !permissions.length) return true;
  return permissions.some((permission) => profileHasPermission(profile, permission));
}

function ensureLogin(options = {}) {
  const app = getApp();
  const loginSession = session.requireLocalLogin({ redirect: options.redirect !== false });
  if (loginSession && loginSession.user) return Promise.resolve(loginSession.user);
  if (app.globalData.user) {
    return Promise.resolve(app.globalData.user);
  }
  return Promise.reject(new Error("请先登录"));
}

function getAdminProfile(options = {}) {
  const app = getApp();
  const loginSession = session.getLoginSession();
  if (!loginSession) return Promise.resolve(customerProfile());
  if (!options.force && loginSession.adminProfile) {
    const normalized = normalizeProfile(loginSession.adminProfile);
    setCachedAdminProfile(normalized);
    return Promise.resolve(normalized);
  }
  if (app.globalData.adminProfile && !options.force) {
    const normalized = normalizeProfile(app.globalData.adminProfile);
    const fetchedAt = Number(app.globalData.adminProfileFetchedAt || 0);
    if (!fetchedAt || Date.now() - fetchedAt < PROFILE_CACHE_TTL_MS) {
      app.globalData.adminProfile = normalized;
      app.globalData.isAdmin = !!normalized.isAdmin && normalized.status !== "disabled";
      return Promise.resolve(normalized);
    }
  }
  if (!options.force) {
    const cached = getCachedAdminProfile();
    if (cached) return Promise.resolve(cached);
  }
  if (app.globalData.adminProfileLoading && !options.force) {
    return app.globalData.adminProfileLoading.then((profile) => {
      const normalized = profile ? normalizeProfile(profile) : customerProfile();
      setCachedAdminProfile(normalized);
      return normalized;
    });
  }
  return call("getCurrentAdminProfile", {}, { showLoading: options.showLoading === true }).then((profile) => {
    const normalized = normalizeProfile(profile);
    setCachedAdminProfile(normalized);
    session.updateAdminProfile(normalized);
    return normalized;
  });
}

function publicCachedAdminProfile(profile = {}) {
  const allowed = [
    "success",
    "isAdmin",
    "role",
    "roleName",
    "permissions",
    "status",
    "defaultEntry",
    "canAccessFrontend",
    "canAccessAdmin",
    "showFrontendTabBar",
    "showAllAdminMenus",
    "roleHint"
  ];
  return allowed.reduce((data, key) => {
    if (profile[key] !== undefined) data[key] = profile[key];
    return data;
  }, {});
}

function setCachedAdminProfile(profile, appOverride) {
  const app = appOverride || getApp();
  const normalized = normalizeProfile(profile);
  app.globalData.adminProfile = normalized;
  app.globalData.adminProfileFetchedAt = Date.now();
  app.globalData.isAdmin = !!normalized.isAdmin && normalized.status !== "disabled";
  try {
    wx.setStorageSync(ADMIN_PROFILE_CACHE_KEY, {
      data: publicCachedAdminProfile(normalized),
      updatedAt: app.globalData.adminProfileFetchedAt
    });
  } catch (err) {
    // Best-effort cache only.
  }
}

function getCachedAdminProfile() {
  let cached = null;
  try {
    cached = wx.getStorageSync(ADMIN_PROFILE_CACHE_KEY);
  } catch (err) {
    cached = null;
  }
  if (!cached || !cached.data || Date.now() - Number(cached.updatedAt || 0) > PROFILE_CACHE_TTL_MS) return null;
  const normalized = normalizeProfile(cached.data);
  const app = getApp();
  app.globalData.adminProfile = normalized;
  app.globalData.adminProfileFetchedAt = Number(cached.updatedAt || Date.now());
  app.globalData.isAdmin = !!normalized.isAdmin && normalized.status !== "disabled";
  return normalized;
}

function clearAdminProfileCache() {
  const app = getApp();
  app.globalData.adminProfile = null;
  app.globalData.adminProfileFetchedAt = 0;
  app.globalData.isAdmin = false;
  try {
    wx.removeStorageSync(ADMIN_PROFILE_CACHE_KEY);
  } catch (err) {
    // Best-effort cache only.
  }
}

function customerProfile() {
  return normalizeProfile({
    success: true,
    isAdmin: false,
    role: "user",
    roleName: "普通用户",
    permissions: [],
    status: "none",
    defaultEntry: "frontend",
    canAccessFrontend: true,
    canAccessAdmin: false,
    showFrontendTabBar: true,
    showAllAdminMenus: false
  });
}

function normalizeProfile(profile = {}) {
  const role = profile.role && profile.isAdmin !== false ? normalizeRole(profile.role) : "user";
  const disabled = profile.status === "disabled" || profile.isActive === false;
  const admin = Boolean(profile.isAdmin) && canAccessAdmin(role) && !disabled;
  const permissions = Array.isArray(profile.permissions) ? profile.permissions : [];
  return {
    ...profile,
    success: profile.success !== false,
    isAdmin: admin,
    role: admin ? role : "user",
    roleName: profile.roleName || (admin ? roleName(role) : "普通用户"),
    permissions,
    status: disabled ? "disabled" : (profile.status || (admin ? "active" : "none")),
    defaultEntry: profile.defaultEntry || (shouldDefaultEnterAdmin(role) ? "admin" : "frontend"),
    canAccessFrontend: profile.canAccessFrontend !== undefined ? Boolean(profile.canAccessFrontend) : canAccessFrontend(role),
    canAccessAdmin: profile.canAccessAdmin !== undefined ? Boolean(profile.canAccessAdmin) : admin,
    showFrontendTabBar: profile.showFrontendTabBar !== undefined ? Boolean(profile.showFrontendTabBar) : shouldShowFrontendTabBar(role),
    showAllAdminMenus: profile.showAllAdminMenus !== undefined ? Boolean(profile.showAllAdminMenus) : isFullAccessRole(role)
  };
}

function showNoPermission(content = "你没有权限访问此页面") {
  wx.showModal({
    title: "无权限",
    content,
    showCancel: false
  });
}

function ensureAdmin(permission, options = {}) {
  const app = getApp();
  const showLoading = options.showLoading === true;
  return ensureLogin({ showLoading }).then((user) => {
    app.globalData.user = user;
    return user;
  }).then(() => getAdminProfile({ force: options.force === true, showLoading }))
    .then((profile) => {
      if (!profile.isAdmin || profile.status === "disabled" || !profile.canAccessAdmin) {
        showNoPermission("当前账号不是管理员，或管理员账号已禁用");
        throw new Error("没有管理员权限");
      }
      if (!profileHasPermission(profile, permission)) {
        showNoPermission();
        throw new Error("无权限访问此页面");
      }
      return profile;
    });
}

function ensureAnyPermission(permissions) {
  return ensureAdmin().then((profile) => {
    if (!profileHasAnyPermission(profile, permissions || [])) {
      showNoPermission();
      throw new Error("无管理员权限");
    }
    return profile;
  });
}

function ensureFrontendAccess() {
  return ensureLogin({ showLoading: false }).then(() => getAdminProfile()).then((profile) => {
    if (profile.canAccessFrontend) return profile;
    wx.redirectTo({ url: ADMIN_HOME });
    throw new Error("当前账号默认进入后台工作台");
  }).catch((err) => {
    if (String(err && err.message || "").indexOf("请先登录") > -1) throw err;
    if (String(err && err.message || "").indexOf("后台工作台") > -1) throw err;
    const profile = customerProfile();
    const app = getApp();
    app.globalData.adminProfile = profile;
    app.globalData.isAdmin = false;
    return profile;
  });
}

function redirectDefaultEntry(currentRoute = "") {
  return getAdminProfile().then((profile) => {
    const route = String(currentRoute || "");
    const isAdminRoute = route.indexOf("pages/admin/") === 0;
    if (profile.defaultEntry === "admin" && profile.canAccessAdmin && !isAdminRoute) {
      wx.redirectTo({ url: ADMIN_HOME });
      return { redirected: true, profile };
    }
    return { redirected: false, profile };
  }).catch(() => ({ redirected: false, profile: customerProfile() }));
}

module.exports = {
  ADMIN_HOME,
  ensureLogin,
  ensureAdmin,
  ensureAnyPermission,
  ensureFrontendAccess,
  redirectDefaultEntry,
  getAdminProfile,
  setCachedAdminProfile,
  clearAdminProfileCache,
  normalizeProfile,
  profileHasPermission,
  profileHasAnyPermission
};
