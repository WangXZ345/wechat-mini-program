const cache = require("./cache");

const CART_CACHE_TTL_MS = 2 * 60 * 1000;
const HOME_CACHE_TTL_MS = 60 * 1000;
const ORDER_CACHE_TTL_MS = 30 * 1000;
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const PRODUCT_PREVIEW_TTL_MS = 2 * 60 * 1000;

const SENSITIVE_KEYS = [
  "stock",
  "realStock",
  "availableStock",
  "currentStock",
  "costPrice",
  "supplier",
  "internalTags",
  "adminRemark",
  "adminNote",
  "inventoryLogs"
];

function now() {
  return Date.now();
}

function appData() {
  try {
    return getApp().globalData || {};
  } catch (err) {
    return {};
  }
}

function currentOpenid() {
  const user = appData().user || {};
  return String(user.openid || user.userOpenid || user._openid || user.userId || user.id || "guest");
}

function readCache(key, ttlMs) {
  return cache.get(key, { ttlMs });
}

function cacheTtlForKey(key) {
  const value = String(key || "");
  if (value.indexOf("cart_cache_") === 0) return CART_CACHE_TTL_MS;
  if (value.indexOf("product_preview_v1_") === 0) return PRODUCT_PREVIEW_TTL_MS;
  if (value.indexOf("home_products_v1_") === 0 || value.indexOf("home_recommend_v1_") === 0) {
    return HOME_CACHE_TTL_MS;
  }
  if (value.indexOf("order_list_v1_") === 0) return ORDER_CACHE_TTL_MS;
  if (value.indexOf("profile_index_v1_") === 0) return PROFILE_CACHE_TTL_MS;
  return 0;
}

function writeCache(key, data) {
  cache.set(key, data, { ttlMs: cacheTtlForKey(key) });
}

function dirtyKey(name) {
  return `dirty_${name}_v1`;
}

function markDirty(name) {
  cache.set(dirtyKey(name), now());
}

function clearDirty(name) {
  cache.remove(dirtyKey(name));
}

function isDirty(name) {
  const cached = cache.get(dirtyKey(name));
  return Boolean(cached && cached.data);
}

function cartCacheKey(openid = currentOpenid()) {
  return `cart_cache_${openid || "guest"}`;
}

function publicTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  return list.filter((tag) => ["新货", "瑕疵", "热销", "常购"].includes(tag)).slice(0, 4);
}

function stripSensitive(source = {}) {
  const target = { ...source };
  SENSITIVE_KEYS.forEach((key) => delete target[key]);
  return target;
}

function normalizeCartItem(item = {}) {
  const id = item.cartItemId || item._id || item.id || "";
  const unitPrice = Number(item.unitPrice !== undefined ? item.unitPrice : item.price || 0);
  const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
  const productImage = item.productImage || item.imageUrl || item.thumbnailUrl || "";
  const clean = stripSensitive({
    _id: id,
    id,
    cartItemId: id,
    productId: item.productId || "",
    productName: item.productName || item.name || "",
    productImage,
    imageUrl: productImage,
    specification: item.specification || "",
    productionDate: item.productionDate || "",
    unitPrice,
    price: unitPrice,
    quantity,
    selected: item.selected !== false,
    tags: publicTags(item.tags || []),
    status: item.status || (item.unavailable ? "unavailable" : "active"),
    subtotal: Number(item.subtotal !== undefined ? item.subtotal : unitPrice * quantity),
    priceChanged: Boolean(item.priceChanged),
    unavailable: Boolean(item.unavailable),
    updatedAt: item.updatedAt || ""
  });
  return clean;
}

function fallbackCartItemFromProduct(product = {}, options = {}) {
  const productId = options.productId || product.productId || product._id || product.id || "";
  const cartItemId = options.cartItemId || options.id || product.cartItemId || product.cartId || (productId ? `pending_${productId}` : "");
  const unitPrice = options.unitPrice !== undefined
    ? options.unitPrice
    : (product.unitPrice !== undefined ? product.unitPrice : product.price || 0);
  const imageUrl = product.productImage || product.imageUrl || product.thumbnailUrl || "";
  return normalizeCartItem({
    _id: cartItemId,
    id: cartItemId,
    cartItemId,
    productId,
    productName: product.productName || product.name || product.title || "",
    productImage: imageUrl,
    imageUrl,
    specification: product.specification || "",
    productionDate: product.productionDate || "",
    unitPrice,
    price: unitPrice,
    quantity: options.quantity || product.quantity || 1,
    selected: true,
    tags: product.tags || [],
    status: "active",
    unavailable: false,
    priceChanged: false
  });
}

function cartItemFromAddResult(result = {}, product = {}, quantity = 1) {
  const data = unwrapCartPayload(result);
  if (data.item) return normalizeCartItem(data.item);
  return fallbackCartItemFromProduct(product, {
    cartItemId: data.cartItemId || data._id || data.id,
    quantity: data.quantity || quantity,
    productId: data.productId || product.productId || product._id || product.id
  });
}

function summarizeCartItems(items = []) {
  const cartItems = items.map(normalizeCartItem);
  const selectedItems = cartItems.filter((item) => item.selected && !item.unavailable);
  return {
    cartItems,
    items: cartItems,
    updatedAt: now(),
    totalCount: cartItems.length,
    selectedCount: selectedItems.length,
    totalAmount: selectedItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0)
  };
}

function readCartCache(options = {}) {
  const cached = readCache(cartCacheKey(options.openid), CART_CACHE_TTL_MS);
  if (!cached || !cached.data) return null;
  const data = {
    ...cached.data,
    cartItems: (cached.data.cartItems || cached.data.items || []).map(normalizeCartItem)
  };
  data.items = data.cartItems;
  return {
    ...cached,
    data
  };
}

function unwrapCartPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return payload;
}

function extractCartItems(payload = {}) {
  const data = unwrapCartPayload(payload);
  const candidates = [
    data.items,
    data.cartItems,
    data.cartList,
    data.carts,
    data.list,
    data.records
  ];
  const items = candidates.find((candidate) => Array.isArray(candidate));
  return items || [];
}

function hasCartItemsPayload(payload = {}) {
  const data = unwrapCartPayload(payload);
  return [
    data.items,
    data.cartItems,
    data.cartList,
    data.carts,
    data.list,
    data.records
  ].some((candidate) => Array.isArray(candidate));
}

function firstNonNegativeNumber(values = []) {
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function cartCountFromPayload(payload = {}) {
  const data = unwrapCartPayload(payload);
  const count = firstNonNegativeNumber([
    data.totalCount,
    data.count,
    data.cartCount,
    data.total
  ]);
  if (count !== null) return count;
  return extractCartItems(data).length;
}

function normalizeCartPayload(payload = {}) {
  const data = unwrapCartPayload(payload);
  const summary = summarizeCartItems(extractCartItems(data));
  const totalCount = firstNonNegativeNumber([
    data.totalCount,
    data.count,
    data.cartCount,
    data.total
  ]);
  const selectedCount = firstNonNegativeNumber([data.selectedCount]);
  const totalAmount = firstNonNegativeNumber([data.totalAmount]);
  return {
    ...summary,
    count: totalCount !== null ? totalCount : summary.totalCount,
    totalCount: totalCount !== null ? totalCount : summary.totalCount,
    selectedCount: selectedCount !== null ? selectedCount : summary.selectedCount,
    totalAmount: totalAmount !== null ? totalAmount : summary.totalAmount
  };
}

function writeCartCache(itemsOrData, options = {}) {
  const data = Array.isArray(itemsOrData)
    ? summarizeCartItems(itemsOrData)
    : normalizeCartPayload(itemsOrData || {});
  if (!Array.isArray(itemsOrData) && !hasCartItemsPayload(itemsOrData) && data.totalCount > 0) {
    const cached = readCartCache(options);
    const cachedItems = cached && cached.data && cached.data.cartItems || [];
    if (cachedItems.length) {
      data.cartItems = cachedItems;
      data.items = cachedItems;
    }
  }
  writeCache(cartCacheKey(options.openid), data);
  clearDirty("cart");
  return data;
}

function updateCartCache(updater) {
  const cached = readCartCache();
  const before = cached && cached.data ? cached.data.cartItems : [];
  const next = updater(before.slice());
  return writeCartCache(next);
}

function upsertCartCacheItem(item) {
  if (!item) return null;
  const nextItem = normalizeCartItem(item);
  const data = updateCartCache((items) => {
    const index = items.findIndex((row) => row._id === nextItem._id || row.cartItemId === nextItem.cartItemId);
    if (index >= 0) items[index] = { ...items[index], ...nextItem };
    else items.unshift(nextItem);
    return items;
  });
  markDirty("cart");
  return data;
}

function patchCartCacheItem(id, patch) {
  if (!id) return null;
  return updateCartCache((items) => items.map((item) => {
    if (item._id !== id && item.cartItemId !== id) return item;
    return normalizeCartItem({ ...item, ...patch });
  }));
}

function removeCartCacheItem(id) {
  if (!id) return null;
  return updateCartCache((items) => items.filter((item) => item._id !== id && item.cartItemId !== id));
}

function removeCartCacheItems(ids = []) {
  const idSet = new Set(ids.filter(Boolean));
  return updateCartCache((items) => items.filter((item) => !idSet.has(item._id) && !idSet.has(item.cartItemId)));
}

function clearCartCache() {
  cache.remove(cartCacheKey());
  clearDirty("cart");
}

function scopedCacheKey(prefix, scope = "") {
  return `${prefix}_${currentOpenid()}_${encodeURIComponent(String(scope || "default"))}`;
}

function productPreviewCacheKey(productId, openid = currentOpenid()) {
  const id = String(productId || "").trim();
  if (!id) return "";
  return `product_preview_v1_${openid || "guest"}_${encodeURIComponent(id)}`;
}

function publicProductPreview(product = {}) {
  const id = String(product.productId || product._id || product.id || "").trim();
  const name = product.productName || product.name || product.baseName || "";
  const imageUrl = product.imageUrl || product.thumbnailUrl || product.productImage || "";
  const price = Number(product.price !== undefined ? product.price : product.unitPrice || 0);
  return {
    _id: id,
    id,
    productId: id,
    name,
    productName: name,
    baseName: product.baseName || "",
    brand: product.brand || "",
    category: product.category || "",
    specification: product.specification || "",
    productionDate: product.productionDate || "",
    imageUrl,
    thumbnailUrl: product.thumbnailUrl || imageUrl,
    price: Number.isFinite(price) ? price : 0,
    priceText: product.priceText || "",
    tags: publicTags(product.tags || []),
    isNew: product.isNew === true,
    isDefective: product.isDefective === true,
    isHot: product.isHot === true
  };
}

function writeProductPreview(product = {}, options = {}) {
  const preview = publicProductPreview(product);
  const key = productPreviewCacheKey(preview.productId, options.openid);
  if (!key || !preview.productId) return null;
  cache.set(key, preview, { ttlMs: PRODUCT_PREVIEW_TTL_MS });
  return preview;
}

function readProductPreview(productId, options = {}) {
  const id = String(productId || "").trim();
  const key = productPreviewCacheKey(id, options.openid);
  if (!key) return null;
  return cache.get(key, {
    ttlMs: PRODUCT_PREVIEW_TTL_MS,
    validate: (data) => Boolean(data && typeof data === "object" && String(data.productId || data._id || "") === id)
  });
}

function clearProductPreview(productId, options = {}) {
  const key = productPreviewCacheKey(productId, options.openid);
  if (key) cache.remove(key);
}

module.exports = {
  CART_CACHE_TTL_MS,
  HOME_CACHE_TTL_MS,
  ORDER_CACHE_TTL_MS,
  PROFILE_CACHE_TTL_MS,
  PRODUCT_PREVIEW_TTL_MS,
  currentOpenid,
  readCache,
  writeCache,
  markDirty,
  clearDirty,
  isDirty,
  scopedCacheKey,
  normalizeCartItem,
  fallbackCartItemFromProduct,
  cartItemFromAddResult,
  summarizeCartItems,
  extractCartItems,
  hasCartItemsPayload,
  cartCountFromPayload,
  readCartCache,
  writeCartCache,
  upsertCartCacheItem,
  patchCartCacheItem,
  removeCartCacheItem,
  removeCartCacheItems,
  clearCartCache,
  publicProductPreview,
  readProductPreview,
  writeProductPreview,
  clearProductPreview
};
