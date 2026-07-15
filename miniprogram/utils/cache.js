const CACHE_VERSION = 1;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SENSITIVE_PAGE_CACHE_CLEANUP_KEY = "sensitive_page_cache_cleanup_v1";

const SENSITIVE_PAGE_CACHE_PREFIXES = [
  "admin_orders_v1_",
  "admin_products_v1_",
  "admin_dashboard_legacy_v1_",
  "admin_dashboard_ui_v2_",
  "order_list_v1_",
  "profile_index_v1_",
  "mergedImportPreview:"
];

const SENSITIVE_PAGE_CACHE_KEYS = [
  "mergeShipmentEligibility"
];

function rawGet(key) {
  try {
    return wx.getStorageSync(key);
  } catch (err) {
    return null;
  }
}

function rawSet(key, value) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (err) {
    return false;
  }
}

function rawSetAsync(key, value) {
  if (typeof wx.setStorage !== "function") return Promise.resolve(rawSet(key, value));
  return new Promise((resolve) => {
    try {
      wx.setStorage({
        key,
        data: value,
        success: () => resolve(true),
        fail: () => resolve(false)
      });
    } catch (err) {
      resolve(false);
    }
  });
}

function remove(key) {
  try {
    wx.removeStorageSync(key);
    return true;
  } catch (err) {
    return false;
  }
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function cacheEnvelope(data, options = {}) {
  if (data === undefined) return null;
  let cacheData = data;
  if (typeof options.sanitize === "function") {
    try {
      cacheData = options.sanitize(data);
    } catch (err) {
      return null;
    }
  }
  if (cacheData === undefined) return null;

  const updatedAt = Date.now();
  const ttlMs = positiveNumber(options.ttlMs);
  return {
    __cacheVersion: positiveNumber(options.version) || CACHE_VERSION,
    data: cacheData,
    updatedAt,
    expiresAt: ttlMs ? updatedAt + ttlMs : 0
  };
}

function set(key, data, options = {}) {
  if (!key) return false;
  const envelope = cacheEnvelope(data, options);
  return envelope ? rawSet(key, envelope) : false;
}

function setAsync(key, data, options = {}) {
  if (!key) return Promise.resolve(false);
  const envelope = cacheEnvelope(data, options);
  return envelope ? rawSetAsync(key, envelope) : Promise.resolve(false);
}

function get(key, options = {}) {
  if (!key) return null;
  const cached = rawGet(key);
  const expectedVersion = positiveNumber(options.version) || CACHE_VERSION;
  if (!cached || typeof cached !== "object" || Array.isArray(cached)) {
    if (cached !== null && cached !== undefined && cached !== "") remove(key);
    return null;
  }
  if (Number(cached.__cacheVersion || 0) !== expectedVersion || cached.data === undefined) {
    remove(key);
    return null;
  }

  const now = Date.now();
  const updatedAt = positiveNumber(cached.updatedAt);
  const storedExpiresAt = positiveNumber(cached.expiresAt);
  const requestedTtlMs = positiveNumber(options.ttlMs);
  const requestedExpiresAt = updatedAt && requestedTtlMs ? updatedAt + requestedTtlMs : 0;
  const expiresAt = storedExpiresAt && requestedExpiresAt
    ? Math.min(storedExpiresAt, requestedExpiresAt)
    : (storedExpiresAt || requestedExpiresAt);

  if (!updatedAt || updatedAt > now + MAX_FUTURE_SKEW_MS || (expiresAt && expiresAt < updatedAt)) {
    remove(key);
    return null;
  }
  if (typeof options.validate === "function") {
    let valid = false;
    try {
      valid = options.validate(cached.data) === true;
    } catch (err) {
      valid = false;
    }
    if (!valid) {
      remove(key);
      return null;
    }
  }

  const expired = Boolean(expiresAt && now > expiresAt);
  if (expired && options.allowExpired === false) {
    remove(key);
    return null;
  }
  return {
    data: cached.data,
    updatedAt,
    expiresAt,
    expired,
    version: expectedVersion
  };
}

function matchesSensitivePageCache(key) {
  return SENSITIVE_PAGE_CACHE_KEYS.includes(key)
    || SENSITIVE_PAGE_CACHE_PREFIXES.some((prefix) => key.indexOf(prefix) === 0);
}

function purgeSensitivePageCaches(options = {}) {
  const force = options.force === true;
  if (!force && rawGet(SENSITIVE_PAGE_CACHE_CLEANUP_KEY)) return 0;

  let removed = 0;
  let enumerated = false;
  try {
    const info = wx.getStorageInfoSync();
    enumerated = true;
    (info.keys || []).forEach((key) => {
      if (!matchesSensitivePageCache(key)) return;
      if (remove(key)) removed += 1;
    });
  } catch (err) {
    SENSITIVE_PAGE_CACHE_KEYS.forEach((key) => {
      if (remove(key)) removed += 1;
    });
  }

  if (enumerated && options.markComplete !== false) {
    rawSet(SENSITIVE_PAGE_CACHE_CLEANUP_KEY, {
      version: CACHE_VERSION,
      completedAt: Date.now()
    });
  }
  return removed;
}

module.exports = {
  CACHE_VERSION,
  get,
  set,
  setAsync,
  remove,
  purgeSensitivePageCaches
};
