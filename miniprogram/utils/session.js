const LOGIN_SESSION_KEY = "login_session_v1";
const ADMIN_PROFILE_CACHE_KEY = "admin_profile_cache_v1";
const cache = require("./cache");
const LOGIN_PAGE = "/pages/login/index";
const ADMIN_HOME = "/pages/admin/dashboard/index";
const FRONTEND_HOME = "/pages/index/index";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PUBLIC_ROUTE_PREFIXES = [
  "pages/legal/"
];

const PUBLIC_ROUTES = [
  "pages/login/index"
];

function safeGetApp() {
  try {
    return getApp();
  } catch (err) {
    return null;
  }
}

function normalizeRoute(route = "") {
  return String(route || "").replace(/^\//, "").split("?")[0];
}

function getCurrentRouteWithQuery() {
  try {
    const pages = getCurrentPages();
    const current = pages && pages[pages.length - 1];
    if (!current || !current.route) return "";
    const options = current.options || {};
    const query = Object.keys(options)
      .filter((key) => options[key] !== undefined && options[key] !== null && options[key] !== "")
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(options[key])}`)
      .join("&");
    return `/${current.route}${query ? `?${query}` : ""}`;
  } catch (err) {
    return "";
  }
}

function isPublicRoute(route) {
  const normalized = normalizeRoute(route);
  if (PUBLIC_ROUTES.includes(normalized)) return true;
  return PUBLIC_ROUTE_PREFIXES.some((prefix) => normalized.indexOf(prefix) === 0);
}

function isLoginRoute(route) {
  return normalizeRoute(route) === "pages/login/index";
}

function readStorage(key) {
  try {
    return wx.getStorageSync(key);
  } catch (err) {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (err) {
    // Local storage is best-effort.
  }
}

function removeStorage(key) {
  try {
    wx.removeStorageSync(key);
  } catch (err) {
    // Local storage is best-effort.
  }
}

function isExpired(session) {
  return !session || !session.isLoggedIn || Number(session.expiresAt || 0) <= Date.now();
}

function applySessionToApp(session) {
  const app = safeGetApp();
  if (!app || !app.globalData) return;
  app.globalData.user = session && session.user || null;
  app.globalData.loginSession = session || null;
  app.globalData.adminProfile = session && session.adminProfile || null;
  app.globalData.adminProfileFetchedAt = session && session.savedAt || 0;
  app.globalData.isAdmin = Boolean(
    session
    && session.adminProfile
    && session.adminProfile.isAdmin
    && session.adminProfile.status !== "disabled"
  );
}

function clearAppSession() {
  const app = safeGetApp();
  if (!app || !app.globalData) return;
  app.globalData.user = null;
  app.globalData.loginSession = null;
  app.globalData.isAdmin = false;
  app.globalData.adminProfile = null;
  app.globalData.adminProfileFetchedAt = 0;
  app.globalData.adminProfileLoading = null;
}

function getLoginSession() {
  const session = readStorage(LOGIN_SESSION_KEY);
  if (isExpired(session)) {
    clearLoginSession();
    return null;
  }
  applySessionToApp(session);
  return session;
}

function hasLoginSession() {
  return Boolean(getLoginSession());
}

function shapeSession(data = {}) {
  const adminProfile = data.adminProfile || null;
  return {
    isLoggedIn: true,
    user: data.user || {},
    adminProfile,
    loginType: data.loginType || "",
    role: adminProfile && adminProfile.role || "user",
    defaultEntry: adminProfile && adminProfile.defaultEntry || "frontend",
    expiresAt: Number(data.expiresAt || 0) || Date.now() + SESSION_TTL_MS,
    savedAt: Date.now()
  };
}

function saveLoginSession(data = {}) {
  const session = shapeSession(data);
  writeStorage(LOGIN_SESSION_KEY, session);
  if (session.adminProfile) {
    writeStorage(ADMIN_PROFILE_CACHE_KEY, {
      data: session.adminProfile,
      updatedAt: session.savedAt
    });
  }
  applySessionToApp(session);
  return session;
}

function updateLoginSession(patch = {}) {
  const current = getLoginSession();
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    user: {
      ...(current.user || {}),
      ...(patch.user || {})
    },
    adminProfile: patch.adminProfile !== undefined ? patch.adminProfile : current.adminProfile,
    savedAt: Date.now()
  };
  writeStorage(LOGIN_SESSION_KEY, next);
  applySessionToApp(next);
  return next;
}

function updateAdminProfile(adminProfile) {
  writeStorage(ADMIN_PROFILE_CACHE_KEY, {
    data: adminProfile,
    updatedAt: Date.now()
  });
  return updateLoginSession({ adminProfile });
}

function shouldClearCacheKey(key) {
  return key === ADMIN_PROFILE_CACHE_KEY
    || key === "selectedShippingAddress"
    || key === "mergeShipmentEligibility"
    || key.indexOf("cart_cache_") === 0
    || key.indexOf("product_preview_v1_") === 0
    || key.indexOf("dirty_") === 0
    || key.indexOf("home_products_v1_") === 0
    || key.indexOf("home_recommend_v1_") === 0
    || key.indexOf("profile_index_v1_") === 0
    || key.indexOf("order_list_v1_") === 0
    || key.indexOf("admin_orders_v1_") === 0
    || key.indexOf("admin_products_v1_") === 0
    || key.indexOf("admin_dashboard_legacy_v1_") === 0
    || key.indexOf("admin_dashboard_ui_v2_") === 0
    || key.indexOf("mergedImportPreview:") === 0;
}

function clearLocalCaches() {
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || []).forEach((key) => {
      if (shouldClearCacheKey(key)) removeStorage(key);
    });
  } catch (err) {
    removeStorage(ADMIN_PROFILE_CACHE_KEY);
    removeStorage("selectedShippingAddress");
  }
  cache.purgeSensitivePageCaches({ force: true, markComplete: false });
}

function clearLoginSession() {
  removeStorage(LOGIN_SESSION_KEY);
  clearLocalCaches();
  clearAppSession();
}

function defaultEntryUrl(adminProfile) {
  const profile = adminProfile || {};
  if (profile.defaultEntry === "admin" && profile.canAccessAdmin) return ADMIN_HOME;
  return FRONTEND_HOME;
}

function isAdminRoute(url) {
  return normalizeRoute(url).indexOf("pages/admin/") === 0;
}

function canUseReturnUrl(returnUrl, adminProfile) {
  if (!returnUrl) return false;
  const normalized = normalizeRoute(decodeURIComponent(returnUrl));
  if (!normalized || isPublicRoute(normalized)) return false;
  if (isAdminRoute(normalized)) {
    return Boolean(adminProfile && adminProfile.canAccessAdmin);
  }
  return !(adminProfile && adminProfile.canAccessFrontend === false);
}

function redirectAfterLogin(adminProfile, returnUrl = "") {
  const target = canUseReturnUrl(returnUrl, adminProfile)
    ? decodeURIComponent(returnUrl)
    : defaultEntryUrl(adminProfile);
  wx.reLaunch({ url: target.indexOf("/") === 0 ? target : `/${target}` });
}

function redirectToLogin(returnUrl = "") {
  const current = returnUrl || getCurrentRouteWithQuery();
  if (isLoginRoute(current)) return;
  const query = current ? `?returnUrl=${encodeURIComponent(current)}` : "";
  wx.reLaunch({ url: `${LOGIN_PAGE}${query}` });
}

function requireLocalLogin(options = {}) {
  const session = getLoginSession();
  if (session) return session;
  if (options.redirect !== false) redirectToLogin(options.returnUrl || "");
  return null;
}

module.exports = {
  LOGIN_PAGE,
  ADMIN_HOME,
  FRONTEND_HOME,
  getLoginSession,
  hasLoginSession,
  saveLoginSession,
  updateLoginSession,
  updateAdminProfile,
  clearLoginSession,
  requireLocalLogin,
  redirectToLogin,
  redirectAfterLogin,
  defaultEntryUrl,
  isPublicRoute,
  isLoginRoute
};
