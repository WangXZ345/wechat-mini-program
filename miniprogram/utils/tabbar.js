const { call } = require("./api");
const { cartCountFromPayload, readCartCache, writeCartCache } = require("./performanceCache");

let cartBadgeLoading = null;
let cartBadgeLastFetchAt = 0;
const MIN_BADGE_FETCH_INTERVAL = 1000;

function getCustomTabBar(page) {
  if (!page || typeof page.getTabBar !== "function") return null;
  return page.getTabBar();
}

function setTabBarSelected(page, selected) {
  const tabBar = getCustomTabBar(page);
  if (!tabBar) return;
  if (typeof tabBar.setSelected === "function") {
    tabBar.setSelected(selected);
    return;
  }
  tabBar.setData({ selected });
}

function setTabBarCartBadge(page, count) {
  const tabBar = getCustomTabBar(page);
  if (!tabBar) return;
  if (typeof tabBar.setBadge === "function") {
    tabBar.setBadge(count);
    return;
  }
  tabBar.setData({ cartBadge: Math.max(0, Number(count || 0)) });
}

function refreshTabBarCartBadge(page) {
  const cached = readCartCache();
  if (cached && cached.data) {
    setTabBarCartBadge(page, cached.data.totalCount || (cached.data.cartItems || []).length);
    if (!cached.expired) return Promise.resolve(cached.data);
  }
  if (cartBadgeLoading) return cartBadgeLoading;
  if (Date.now() - cartBadgeLastFetchAt < MIN_BADGE_FETCH_INTERVAL && cached && cached.data) {
    return Promise.resolve(cached.data);
  }
  cartBadgeLastFetchAt = Date.now();
  cartBadgeLoading = call("getCartList", {}, { showLoading: false })
    .then((data) => {
      const cache = writeCartCache(data);
      setTabBarCartBadge(page, cartCountFromPayload(cache));
      return cache;
    })
    .catch(() => null)
    .finally(() => {
      cartBadgeLoading = null;
    });
  return cartBadgeLoading;
}

function syncTabBar(page, selected) {
  setTabBarSelected(page, selected);
  return refreshTabBarCartBadge(page);
}

module.exports = {
  refreshTabBarCartBadge,
  setTabBarCartBadge,
  setTabBarSelected,
  syncTabBar
};
