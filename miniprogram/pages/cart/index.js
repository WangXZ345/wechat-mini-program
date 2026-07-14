const { call, moneyText, toast, feedback } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin } = require("../../utils/auth");
const { DELIVERY_TYPE_OPTIONS, EMPTY_SHIPPING_ADDRESS, normalizeShippingAddress } = require("../../utils/delivery");
const { setTabBarCartBadge, setTabBarSelected } = require("../../utils/tabbar");
const { createSubmitKey, clearSubmitKey, generateIdempotencyKey } = require("../../utils/idempotency");
const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const haptics = require("../../utils/haptics");
const {
  CART_CACHE_TTL_MS,
  clearDirty,
  isDirty,
  markDirty,
  extractCartItems,
  cartCountFromPayload,
  normalizeCartItem,
  readCartCache,
  removeCartCacheItem,
  removeCartCacheItems,
  clearCartCache,
  writeCartCache
} = require("../../utils/performanceCache");

function formatSelectedAddress(address = {}) {
  return [address.regionText, address.detailAddress].filter(Boolean).join(" ");
}

function maskPhone(phone) {
  const text = String(phone || "").trim();
  if (!text) return "";
  if (text.length < 7) return text.replace(/.(?=.{2})/g, "*");
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

function decorateSelectedAddress(address) {
  if (!address || !address._id) return null;
  return {
    ...address,
    receiverPhoneDisplay: address.receiverPhoneMasked || maskPhone(address.receiverPhone)
  };
}
const { ensurePhoneBeforeOrder, handlePhoneRequiredError } = require("../../utils/phone");

const MAX_QTY = 999;
const SUBMIT_CART_ORDER_SCENE = "submit_cart_order";
const RECENT_ORDER_WINDOW_MS = 10 * 60 * 1000;
const MIN_CART_FETCH_INTERVAL = 1000;

function normalizeQuantity(value) {
  const quantity = Math.floor(Number(value || 1));
  if (!Number.isInteger(quantity) || quantity < 1) return 1;
  return Math.min(quantity, MAX_QTY);
}

function normalizeQuantityInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const quantity = Math.floor(Number(text));
  if (!Number.isInteger(quantity) || quantity < 1) return "";
  return Math.min(quantity, MAX_QTY);
}

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value && value.$date) return toMillis(value.$date);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function itemSignature(items = []) {
  const counts = {};
  items.forEach((item) => {
    const productId = String(item.productId || "").trim();
    if (!productId) return;
    counts[productId] = (counts[productId] || 0) + normalizeQuantity(item.quantity);
  });
  return Object.keys(counts).sort().map((productId) => `${productId}:${counts[productId]}`).join("|");
}

function isRecentOrder(order) {
  const createdAt = toMillis(order && order.createdAt);
  if (!createdAt) return true;
  return Date.now() - createdAt <= RECENT_ORDER_WINDOW_MS;
}

function matchesSelectedCartOrder(order, selectedItems) {
  if (!order || !(order.orderType === "cart" || order.createdFromCart === true)) return false;
  if (!isRecentOrder(order)) return false;
  const selectedSignature = itemSignature(selectedItems);
  if (!selectedSignature) return true;
  return itemSignature(order.items || []) === selectedSignature;
}

function logSubmitDebug(stage, details = {}) {
  console.info("[cartSubmit]", {
    stage,
    actionType: "submit_cart_order",
    keyTail: String(details.idempotencyKey || "").slice(-6),
    idempotencyStatus: details.idempotencyStatus || "",
    errorCode: details.errorCode || "",
    message: details.message || "",
    hasOrderId: Boolean(details.orderId)
  });
}

Page({
  data: {
    items: [],
    allSelected: false,
    selectedCount: 0,
    totalText: "0.00",
    loading: true,
    refreshing: false,
    loadError: "",
    initialized: false,
    submitting: false,
    deliveryTypeOptions: DELIVERY_TYPE_OPTIONS,
    deliveryType: "shipping",
    pickupInfo: {},
    shippingAddress: { ...EMPTY_SHIPPING_ADDRESS },
    selectedAddress: null,
    selectedAddressText: "",
    isLandscape: false,
    isWideScreen: false,
    screenWidth: 0,
    screenHeight: 0
  },

  onLoad() {
    this._alive = true;
    this._cartInitializing = true;
    this.cartMutationVersion = 0;
    this.cartMutationPending = 0;
    this.cartMutationQueue = Promise.resolve();
    this.cartMutationSequenceByField = new Map();
    this.cartConfirmedValueByField = new Map();
    this.cartQtyDraftIds = new Set();
    this.cartPendingRevalidate = false;
    initOrientation(this);
    setTabBarSelected(this, 1);
    const hasImmediateCache = this.applyCartCache();
    ensureLogin({ showLoading: false })
      .then(() => {
        return ensureFrontendAccess();
      })
      .then(() => {
        return this.load({ force: !hasImmediateCache, silent: hasImmediateCache, revalidate: hasImmediateCache });
      })
      .catch((err) => {
        this.safeSetData({ loading: false, initialized: true });
        toast(err.message);
      })
      .finally(() => {
        this._cartInitializing = false;
      });
  },

  onShow() {
    if (this._cartInitializing) return;
    ensureLogin({ showLoading: false }).then(() => {
      setTabBarSelected(this, 1);
      const hasCache = this.applyCartCache();
      return ensureFrontendAccess().then(() => hasCache);
    }).then((hasImmediateCache) => {
      this.load({ silent: hasImmediateCache, revalidate: hasImmediateCache });
      this.applySelectedAddressFromStorage();
    }).catch(() => null);
  },

  onUnload() {
    this._alive = false;
    this.cartPendingRevalidate = false;
    if (this.cartQtyDraftIds) this.cartQtyDraftIds.clear();
    cleanupOrientation(this);
  },

  safeSetData(data, callback) {
    if (this._alive === false) return;
    this.setData(data, callback);
  },

  currentCartMutationVersion() {
    return Number(this.cartMutationVersion || 0);
  },

  bumpCartMutationVersion() {
    this.cartMutationVersion = this.currentCartMutationVersion() + 1;
    return this.cartMutationVersion;
  },

  cloneCartMutationValue(value) {
    if (Array.isArray(value)) return value.slice();
    if (value && typeof value === "object") return { ...value };
    return value;
  },

  cartItemFieldKey(id, field) {
    return `item:${id}:${field}`;
  },

  rememberCartConfirmedValue(key, value) {
    if (!key) return;
    if (!this.cartConfirmedValueByField) this.cartConfirmedValueByField = new Map();
    if (!this.cartConfirmedValueByField.has(key)) {
      this.cartConfirmedValueByField.set(key, this.cloneCartMutationValue(value));
    }
  },

  setCartConfirmedValue(key, value) {
    if (!key) return;
    if (!this.cartConfirmedValueByField) this.cartConfirmedValueByField = new Map();
    this.cartConfirmedValueByField.set(key, this.cloneCartMutationValue(value));
  },

  beginCartMutation(fields = []) {
    if (!this.cartMutationSequenceByField) this.cartMutationSequenceByField = new Map();
    const sequence = this.bumpCartMutationVersion();
    const normalizedFields = fields.map((field) => {
      const key = field.key || this.cartItemFieldKey(field.id, field.field);
      this.rememberCartConfirmedValue(key, field.value);
      this.cartMutationSequenceByField.set(key, sequence);
      return { ...field, key };
    });
    this.cartMutationPending = Number(this.cartMutationPending || 0) + 1;
    return { sequence, fields: normalizedFields };
  },

  isLatestCartMutationField(context, key) {
    return Boolean(
      context
      && key
      && this.cartMutationSequenceByField
      && this.cartMutationSequenceByField.get(key) === context.sequence
    );
  },

  finishCartMutation() {
    this.cartMutationPending = Math.max(0, Number(this.cartMutationPending || 0) - 1);
    if (!this.cartMutationPending) this.flushCartPendingRevalidate();
  },

  enqueueCartMutation(context, request, handlers = {}) {
    const execute = () => Promise.resolve()
      .then(request)
      .then(
        (data) => {
          if (handlers.success) handlers.success(data);
          return data;
        },
        (err) => {
          if (handlers.error) return handlers.error(err);
          throw err;
        }
      )
      .finally(() => {
        if (handlers.finally) handlers.finally();
        this.finishCartMutation(context);
      });
    const previous = this.cartMutationQueue || Promise.resolve();
    const result = previous.then(execute, execute);
    this.cartMutationQueue = result.then(() => undefined, () => undefined);
    return result;
  },

  rollbackLatestCartFields(context, fields = context && context.fields || []) {
    const patchesById = new Map();
    fields.forEach((field) => {
      if (!field.id || !field.field || !this.isLatestCartMutationField(context, field.key)) return;
      if (!this.cartConfirmedValueByField || !this.cartConfirmedValueByField.has(field.key)) return;
      const patch = patchesById.get(field.id) || {};
      patch[field.field] = this.cloneCartMutationValue(this.cartConfirmedValueByField.get(field.key));
      patchesById.set(field.id, patch);
    });
    if (!patchesById.size) return false;
    let changed = false;
    const items = this.data.items.map((item) => {
      const patch = patchesById.get(item._id);
      if (!patch) return item;
      const needsPatch = Object.keys(patch).some((field) => !Object.is(item[field], patch[field]));
      if (!needsPatch) return item;
      changed = true;
      return { ...item, ...patch };
    });
    if (!changed) return false;
    this.bumpCartMutationVersion();
    this.applyCartItems(items);
    return true;
  },

  cartItemWithConfirmedFields(item) {
    if (!item || !item._id) return item;
    const presenceKey = this.cartItemFieldKey(item._id, "presence");
    if (
      this.cartConfirmedValueByField
      && this.cartConfirmedValueByField.has(presenceKey)
      && this.cartConfirmedValueByField.get(presenceKey) === false
    ) return null;
    const next = { ...item };
    ["quantity", "selected"].forEach((field) => {
      const key = this.cartItemFieldKey(item._id, field);
      if (this.cartConfirmedValueByField && this.cartConfirmedValueByField.has(key)) {
        next[field] = this.cloneCartMutationValue(this.cartConfirmedValueByField.get(key));
      }
    });
    return next;
  },

  restoreRemovedCartItem(context, item, index) {
    if (!item || !item._id || !context || !context.fields.length) return false;
    const presenceField = context.fields[0];
    const clearSequence = this.cartMutationSequenceByField
      ? Number(this.cartMutationSequenceByField.get("cart:clear") || 0)
      : 0;
    if (clearSequence > context.sequence || !this.isLatestCartMutationField(context, presenceField.key)) return false;
    if (this.data.items.some((row) => row._id === item._id)) return false;
    const items = this.data.items.slice();
    const insertAt = Math.max(0, Math.min(Number(index || 0), items.length));
    const restoredItem = this.cartItemWithConfirmedFields(item);
    if (!restoredItem) return false;
    items.splice(insertAt, 0, restoredItem);
    this.bumpCartMutationVersion();
    this.applyCartItems(items);
    return true;
  },

  restoreClearedCartItems(context, before = []) {
    const clearField = context && context.fields && context.fields[0];
    if (!clearField || !this.isLatestCartMutationField(context, clearField.key)) return false;
    const currentById = new Map(this.data.items.map((item) => [item._id, item]));
    const restoredIds = new Set();
    const items = before.reduce((result, item) => {
      restoredIds.add(item._id);
      const restoredItem = currentById.get(item._id) || this.cartItemWithConfirmedFields(item);
      if (restoredItem) result.push(restoredItem);
      return result;
    }, []);
    this.data.items.forEach((item) => {
      if (!restoredIds.has(item._id)) items.push(item);
    });
    this.bumpCartMutationVersion();
    this.applyCartItems(items);
    return true;
  },

  discardCartItemConfirmedState(id, upToSequence) {
    if (!id || !this.cartConfirmedValueByField) return;
    ["quantity", "selected", "presence"].forEach((field) => {
      const key = this.cartItemFieldKey(id, field);
      const latestSequence = this.cartMutationSequenceByField
        ? Number(this.cartMutationSequenceByField.get(key) || 0)
        : 0;
      if (latestSequence <= upToSequence) this.cartConfirmedValueByField.delete(key);
    });
  },

  resetCartConfirmedState() {
    if (this.cartMutationSequenceByField) this.cartMutationSequenceByField.clear();
    if (this.cartConfirmedValueByField) this.cartConfirmedValueByField.clear();
  },

  requestCartTrailingRevalidate() {
    this.cartPendingRevalidate = true;
    markDirty("cart");
  },

  flushCartPendingRevalidate() {
    if (!this.cartPendingRevalidate || this._alive === false) return null;
    if (this.cartLoading || this.hasUnsettledCartMutation()) return null;
    this.cartPendingRevalidate = false;
    return this.load({ force: true, silent: true, trailingRevalidate: true });
  },

  markCartQtyDraft(id) {
    if (!id) return;
    if (!this.cartQtyDraftIds) this.cartQtyDraftIds = new Set();
    const item = this.data.items.find((row) => row._id === id);
    if (item) this.rememberCartConfirmedValue(this.cartItemFieldKey(id, "quantity"), item.quantity);
    this.cartQtyDraftIds.add(id);
    this.bumpCartMutationVersion();
  },

  clearCartQtyDraft(id) {
    if (!this.cartQtyDraftIds) return;
    if (id) this.cartQtyDraftIds.delete(id);
    else this.cartQtyDraftIds.clear();
  },

  hasUnsettledCartMutation() {
    return Number(this.cartMutationPending || 0) > 0
      || Boolean(this.cartQtyDraftIds && this.cartQtyDraftIds.size);
  },

  decorateCartItems(items = []) {
    return items.map((item) => {
      const normalized = normalizeCartItem(item);
      return {
        ...normalized,
        unitPriceText: moneyText(normalized.unitPrice),
        subtotalText: moneyText(Number(normalized.unitPrice || 0) * Number(normalized.quantity || 0))
      };
    });
  },

  cartSummaryState(items = []) {
    const available = items.filter((item) => !item.unavailable);
    const selectedItems = available.filter((item) => item.selected);
    const total = selectedItems.reduce((sum, item) => {
      return sum + Number(item.unitPrice || 0) * Number(item.quantity || 0);
    }, 0);
    return {
      allSelected: available.length > 0 && selectedItems.length === available.length,
      selectedCount: selectedItems.length,
      totalText: moneyText(total)
    };
  },

  applyCartItems(items = [], options = {}) {
    const nextItems = this.decorateCartItems(items);
    const summary = this.cartSummaryState(nextItems);
    this.safeSetData({
      items: nextItems,
      ...summary,
      initialized: true
    });
    if (options.syncCache !== false) writeCartCache(nextItems);
    setTabBarCartBadge(this, nextItems.length);
    if (nextItems.length) this.ensureDeliveryOptionsLoaded();
  },

  applyCartCache() {
    const cached = readCartCache();
    if (!cached || !cached.data) return false;
    const cartItems = cached.data.cartItems || [];
    const totalCount = cartCountFromPayload(cached.data);
    if (!cartItems.length && totalCount > 0) return false;
    this.applyCartItems(cartItems, { syncCache: false });
    this.safeSetData({
      loading: false,
      refreshing: false,
      loadError: "",
      initialized: true
    });
    return true;
  },

  shouldSkipCartFetch(options = {}) {
    if (this.hasUnsettledCartMutation()) {
      this.requestCartTrailingRevalidate();
      return true;
    }
    if (options.force || isDirty("cart")) return false;
    if (this.cartLoading) return true;
    const elapsed = Date.now() - Number(this.cartLastFetchAt || 0);
    if (elapsed > 0 && elapsed < MIN_CART_FETCH_INTERVAL) return true;
    if (options.revalidate) return false;
    const cached = readCartCache();
    const totalCount = cached && cached.data ? cartCountFromPayload(cached.data) : null;
    return Boolean(cached && !cached.expired && (this.data.items.length || totalCount === 0));
  },

  load(options = {}) {
    if (this.cartLoading) return this.cartLoading;
    if (this.shouldSkipCartFetch(options)) return Promise.resolve({ items: this.data.items });
    const requestMutationVersion = this.currentCartMutationVersion();
    const showSkeleton = !options.silent && !this.data.items.length;
    this.safeSetData({
      loading: showSkeleton,
      refreshing: !showSkeleton,
      loadError: ""
    });
    this.cartLastFetchAt = Date.now();
    this.cartLoading = call("getCartList", {}, { showLoading: false }).then((data) => {
      if (requestMutationVersion !== this.currentCartMutationVersion()) {
        this.requestCartTrailingRevalidate();
        this.safeSetData({ initialized: true });
        return data;
      }
      const items = extractCartItems(data);
      const remoteCount = cartCountFromPayload(data);
      if (!items.length && remoteCount > 0 && this.data.items.length) {
        setTabBarCartBadge(this, remoteCount);
        markDirty("cart");
        this.safeSetData({ initialized: true });
        return data;
      }
      this.resetCartConfirmedState();
      this.applyCartItems(items);
      clearDirty("cart");
      return data;
    }).catch((err) => {
      const message = err.message || "购物车加载失败";
      if (options.trailingRevalidate) markDirty("cart");
      this.safeSetData({ loadError: message });
      feedback.showError(message);
      return { items: this.data.items };
    }).finally(() => {
      this.cartLoading = null;
      this.safeSetData({ loading: false, refreshing: false, initialized: true });
      this.flushCartPendingRevalidate();
    });
    return this.cartLoading;
  },

  retryLoad() {
    this.load({ force: true });
  },

  updateSummary(options = {}) {
    const summary = this.cartSummaryState(this.data.items);
    this.safeSetData(summary);
    if (options.syncCache !== false) writeCartCache(this.data.items);
  },

  ensureDeliveryOptionsLoaded() {
    if (!this.data.items.length) return Promise.resolve();
    if (this.deliveryOptionsLoaded) return Promise.resolve();
    if (this.deliveryOptionsLoading) return this.deliveryOptionsLoading;
    this.deliveryOptionsLoading = this.loadDeliveryOptions()
      .then(() => {
        this.deliveryOptionsLoaded = true;
      })
      .finally(() => {
        this.deliveryOptionsLoading = null;
      });
    return this.deliveryOptionsLoading;
  },

  loadDeliveryOptions() {
    return Promise.all([
      call("getUserDeliveryPreference", {}, { showLoading: false }),
      call("getSettings", {}, { showLoading: false }),
      call("getDefaultAddress", {}, { showLoading: false })
    ]).then(([preference, settings, defaultAddress]) => {
      const pickup = settings.pickupSettings || {};
      const deliveryType = pickup.isConfigured === false && preference.defaultDeliveryType === "self_pickup"
        ? "shipping"
        : (preference.defaultDeliveryType || "shipping");
      const selectedAddress = decorateSelectedAddress(defaultAddress.address || null);
      this.safeSetData({
        deliveryType,
        shippingAddress: normalizeShippingAddress(preference.lastShippingAddress),
        pickupInfo: pickup,
        selectedAddress,
        selectedAddressText: selectedAddress ? formatSelectedAddress(selectedAddress) : ""
      });
    }).catch((err) => {
      this.safeSetData({
        deliveryType: "shipping",
        shippingAddress: { ...EMPTY_SHIPPING_ADDRESS },
        pickupInfo: {},
        selectedAddress: null,
        selectedAddressText: ""
      });
      feedback.showError(err.message);
    });
  },

  applySelectedAddressFromStorage() {
    const selectedAddress = wx.getStorageSync("selectedShippingAddress");
    if (!selectedAddress || !selectedAddress._id) return;
    const displayAddress = decorateSelectedAddress(selectedAddress);
    this.safeSetData({
      selectedAddress: displayAddress,
      selectedAddressText: formatSelectedAddress(displayAddress)
    });
  },

  onDeliveryTypeChange(e) {
    if (e.detail.value === "self_pickup" && this.data.pickupInfo.isConfigured === false) {
      haptics.error();
      feedback.showWarning("自提暂未配置，请先选择快递配送");
      this.safeSetData({ deliveryType: "shipping" });
      return;
    }
    haptics.selection();
    this.safeSetData({ deliveryType: e.detail.value });
  },

  onShippingInput(e) {
    const field = e.currentTarget.dataset.field;
    this.safeSetData({ [`shippingAddress.${field}`]: e.detail.value });
  },

  chooseAddress() {
    haptics.selection();
    wx.navigateTo({ url: "/pages/address/list?select=1" });
  },

  addAddress() {
    haptics.selection();
    wx.navigateTo({ url: "/pages/address/edit?select=1" });
  },

  deliveryPayload() {
    const isPickup = this.data.deliveryType === "self_pickup";
    return {
      deliveryType: this.data.deliveryType,
      shippingType: isPickup ? "pickup" : "delivery",
      addressId: isPickup ? "" : (this.data.selectedAddress && this.data.selectedAddress._id)
    };
  },

  async ensureDeliveryAddress() {
    if (this.data.deliveryType !== "shipping" || (this.data.selectedAddress && this.data.selectedAddress._id)) return true;
    return new Promise((resolve) => {
      wx.showModal({
        title: "需要收货地址",
        content: "发货订单需要选择收货地址。",
        cancelText: "取消",
        confirmText: "去新增",
        success: (res) => {
          if (res.confirm) this.addAddress();
          resolve(false);
        },
        fail: () => resolve(false)
      });
    });
  },

  toggleItem(e) {
    const item = this.data.items.find((row) => row._id === e.currentTarget.dataset.id);
    if (!item || item.unavailable) return;
    haptics.selection();
    const before = this.data.items;
    const selected = !item.selected;
    const next = before.map((row) => row._id === item._id ? { ...row, selected } : row);
    const field = { id: item._id, field: "selected", value: item.selected };
    const context = this.beginCartMutation([field]);
    const idempotencyKey = generateIdempotencyKey("update_cart_item");
    this.applyCartItems(next);
    return this.enqueueCartMutation(context, () => call("updateCartItem", {
      cartItemId: item._id,
      selected,
      idempotencyKey
    }, { showLoading: false }), {
      success: () => {
        this.setCartConfirmedValue(context.fields[0].key, selected);
        writeCartCache(this.data.items);
      },
      error: (err) => {
        this.rollbackLatestCartFields(context);
        this.requestCartTrailingRevalidate();
        haptics.error();
        feedback.showError(err.message);
      }
    });
  },

  toggleAll() {
    haptics.medium();
    const selected = !this.data.allSelected;
    const before = this.data.items;
    const next = before.map((item) => item.unavailable ? item : { ...item, selected });
    const targets = before.filter((item) => !item.unavailable);
    const context = this.beginCartMutation(targets.map((item) => ({
      id: item._id,
      field: "selected",
      value: item.selected
    })));
    this.applyCartItems(next);
    return this.enqueueCartMutation(context, () => Promise.all(context.fields.map((field) => {
      return Promise.resolve()
        .then(() => call("updateCartItem", {
          cartItemId: field.id,
          selected
        }, { showLoading: false }))
        .then(
          () => ({ ok: true, field }),
          (error) => ({ ok: false, field, error })
        );
    })), {
      success: (results) => {
        const failedFields = [];
        let firstError = null;
        results.forEach((result) => {
          if (result.ok) {
            this.setCartConfirmedValue(result.field.key, selected);
            return;
          }
          failedFields.push(result.field);
          if (!firstError) firstError = result.error;
        });
        if (failedFields.length) {
          this.rollbackLatestCartFields(context, failedFields);
          this.requestCartTrailingRevalidate();
          haptics.error();
          feedback.showError(firstError && firstError.message || "购物车更新失败");
        }
        writeCartCache(this.data.items);
      },
      error: (err) => {
        this.rollbackLatestCartFields(context);
        this.requestCartTrailingRevalidate();
        haptics.error();
        feedback.showError(err.message);
      }
    });
  },

  changeQty(e) {
    const id = e.currentTarget.dataset.id;
    const delta = Number(e.currentTarget.dataset.delta);
    const item = this.data.items.find((row) => row._id === id);
    if (!item) return;
    haptics.light();
    this.saveQty(id, normalizeQuantity(Number(item.quantity || 1) + delta));
  },

  onQtyInput(e) {
    const id = e.currentTarget.dataset.id;
    const quantity = normalizeQuantityInput(e.detail.value);
    this.markCartQtyDraft(id);
    const items = this.data.items.map((item) => {
      if (item._id !== id) return item;
      return {
        ...item,
        quantity,
        subtotalText: moneyText(Number(item.unitPrice || 0) * quantity)
      };
    });
    this.safeSetData({ items }, () => this.updateSummary({ syncCache: false }));
  },

  onQtyBlur(e) {
    this.saveQty(e.currentTarget.dataset.id, normalizeQuantity(e.detail.value));
  },

  saveQty(id, quantity) {
    const normalizedQuantity = normalizeQuantity(quantity);
    const before = this.data.items;
    const itemBefore = before.find((item) => item._id === id);
    const next = before.map((item) => {
      if (item._id !== id) return item;
      return {
        ...item,
        quantity: normalizedQuantity,
        subtotalText: moneyText(Number(item.unitPrice || 0) * normalizedQuantity)
      };
    });
    this.clearCartQtyDraft(id);
    const context = this.beginCartMutation([{
      id,
      field: "quantity",
      value: itemBefore ? itemBefore.quantity : normalizedQuantity
    }]);
    const idempotencyKey = generateIdempotencyKey("update_cart_item");
    this.applyCartItems(next);
    return this.enqueueCartMutation(context, () => call("updateCartItem", {
      cartItemId: id,
      quantity: normalizedQuantity,
      idempotencyKey
    }, { showLoading: false }), {
      success: () => {
        this.setCartConfirmedValue(context.fields[0].key, normalizedQuantity);
        writeCartCache(this.data.items);
      },
      error: (err) => {
        this.rollbackLatestCartFields(context);
        this.requestCartTrailingRevalidate();
        haptics.error();
        feedback.showError(err.message);
      }
    });
  },

  async removeItem(e) {
    haptics.warning();
    const confirmed = await feedback.confirmAction({
      title: "删除商品",
      content: "确定从购物车删除该商品？",
      confirmText: "删除",
      confirmColor: "#9A2D2D"
    });
    if (!confirmed) return;
    const id = e.currentTarget.dataset.id;
    const before = this.data.items;
    const removedItem = before.find((item) => item._id === id);
    if (!removedItem) return;
    const removedIndex = before.findIndex((item) => item._id === id);
    this.clearCartQtyDraft(id);
    const context = this.beginCartMutation([{
      key: this.cartItemFieldKey(id, "presence"),
      value: removedItem
    }]);
    this.applyCartItems(before.filter((item) => item._id !== id));
    return this.enqueueCartMutation(context, () => call("removeCartItem", { cartItemId: id }), {
      success: () => {
        this.setCartConfirmedValue(context.fields[0].key, false);
        this.discardCartItemConfirmedState(id, context.sequence);
        removeCartCacheItem(id);
        haptics.success();
        feedback.showSuccess("已删除");
      },
      error: (err) => {
        this.restoreRemovedCartItem(context, removedItem, removedIndex);
        this.requestCartTrailingRevalidate();
        haptics.error();
        feedback.showError(err.message);
      }
    });
  },

  async clearCart() {
    haptics.warning();
    const confirmed = await feedback.confirmAction({
      title: "清空购物车",
      content: "确定清空全部购物车商品？",
      confirmText: "清空",
      confirmColor: "#9A2D2D"
    });
    if (!confirmed) return;
    const before = this.data.items;
    this.clearCartQtyDraft();
    const context = this.beginCartMutation([{
      key: "cart:clear",
      value: before
    }]);
    this.applyCartItems([]);
    return this.enqueueCartMutation(context, () => call("clearCart"), {
      success: () => {
        this.setCartConfirmedValue(context.fields[0].key, []);
        before.forEach((item) => this.discardCartItemConfirmedState(item._id, context.sequence));
        clearCartCache();
        haptics.success();
        feedback.showSuccess("购物车已清空");
      },
      error: (err) => {
        this.restoreClearedCartItems(context, before);
        this.requestCartTrailingRevalidate();
        haptics.error();
        feedback.showError(err.message);
      }
    });
  },

  selectedAvailableItems() {
    return this.data.items.filter((item) => item.selected && !item.unavailable);
  },

  findRecentSubmittedOrder(selectedItems) {
    return call("getOrders", { limit: 10 }, { showLoading: false })
      .then((data) => {
        const orders = data.orders || [];
        return orders.find((order) => matchesSelectedCartOrder(order, selectedItems)) || null;
      });
  },

  goOrderDetail(order) {
    clearSubmitKey(SUBMIT_CART_ORDER_SCENE);
    if (order && order._id) {
      wx.navigateTo({ url: `/pages/order/detail?id=${order._id}` });
      return;
    }
    wx.switchTab({ url: "/pages/order/list" });
  },

  retrySubmitCartOrder() {
    const selectedBeforeRetry = this.selectedAvailableItems();
    this.findRecentSubmittedOrder(selectedBeforeRetry).then((order) => {
      if (order) {
        feedback.showInfo("已找到刚刚提交的订单");
        this.goOrderDetail(order);
        return;
      }
      clearSubmitKey(SUBMIT_CART_ORDER_SCENE);
      this.load().then(() => {
        const selectedItems = this.selectedAvailableItems();
        if (!selectedItems.length) {
          feedback.showInfo("购物车已更新，请先到订单列表确认是否已生成订单");
          wx.switchTab({ url: "/pages/order/list" });
          return;
        }
        this.submitCartOrder({ retry: true });
      }).catch((err) => feedback.showError(err.message));
    }).catch((err) => {
      feedback.showError(err.message || "查询订单失败，请稍后再试");
    });
  },

  async submitCartOrder(options = {}) {
    const isRetry = Boolean(options && options.retry);
    if (this.data.submitting) return;
    if (!this.data.selectedCount) {
      haptics.error();
      feedback.showWarning("请先选择商品");
      return;
    }
    if (this.data.deliveryType === "self_pickup" && this.data.pickupInfo.isConfigured === false) {
      haptics.error();
      feedback.showWarning("自提暂未配置，请先选择快递配送");
      this.safeSetData({ deliveryType: "shipping" });
      return;
    }
    const hasAddress = await this.ensureDeliveryAddress();
    if (!hasAddress) {
      haptics.error();
      return;
    }
    const phoneReady = await ensurePhoneBeforeOrder("/pages/cart/index");
    if (!phoneReady) {
      haptics.error();
      return;
    }
    haptics.medium();
    const confirmed = await feedback.confirmAction({
      title: isRetry ? "重新提交订单" : "提交订单",
      content: isRetry
        ? "确认订单列表里没有生成新订单后，重新提交当前选中的商品？"
        : "确认提交当前选中的商品？提交后将进入审核流程。",
      confirmText: isRetry ? "重新提交" : "提交"
    });
    if (!confirmed) return;
    this.safeSetData({ submitting: true });
    const selectedItems = this.selectedAvailableItems();
    const selectedCartItemIds = selectedItems.map((item) => item._id).filter(Boolean).sort();
    selectedCartItemIds.forEach((id) => this.clearCartQtyDraft(id));
    const context = this.beginCartMutation(selectedItems.map((item) => ({
      key: this.cartItemFieldKey(item._id, "presence"),
      value: item
    })));
    const idempotencyKey = createSubmitKey(SUBMIT_CART_ORDER_SCENE);
    logSubmitDebug("request", { idempotencyKey });
    return this.enqueueCartMutation(context, () => {
      const syncTasks = selectedItems.map((item) => call("updateCartItem", {
        cartItemId: item._id,
        quantity: normalizeQuantity(item.quantity)
      }, { showLoading: false }));
      return Promise.all(syncTasks).then(() => call("submitCartOrder", {
        ...this.deliveryPayload(),
        selectedCartItemIds,
        idempotencyKey
      }));
    }, {
      success: (data) => {
        clearSubmitKey(SUBMIT_CART_ORDER_SCENE);
        logSubmitDebug("success", {
          idempotencyKey,
          idempotencyStatus: data.idempotencyStatus,
          orderId: data.orderId
        });
        haptics.success();
        feedback.showSuccess(data.message || "订单已提交");
        const selectedIds = new Set(selectedCartItemIds);
        const remaining = this.data.items.filter((item) => !selectedIds.has(item._id));
        this.bumpCartMutationVersion();
        this.applyCartItems(remaining);
        context.fields.forEach((field) => {
          this.setCartConfirmedValue(field.key, false);
          this.discardCartItemConfirmedState(field.value && field.value._id, context.sequence);
        });
        removeCartCacheItems(selectedCartItemIds);
        markDirty("order");
        if (data.status === "auto_reviewing") {
          setTimeout(() => {
            call("autoReviewOrder", { orderId: data.orderId }, { showLoading: false }).catch(() => null);
          }, 10000);
        }
        setTimeout(() => {
          wx.navigateTo({ url: `/pages/order/detail?id=${data.orderId}` });
        }, 800);
      },
      error: (err) => {
        this.requestCartTrailingRevalidate();
        if (handlePhoneRequiredError(err, "/pages/cart/index")) return;
        if (err.code === "IDEMPOTENCY_PROCESSING") {
          logSubmitDebug("processing", {
            idempotencyKey,
            idempotencyStatus: "processing",
            errorCode: err.code
          });
          wx.showModal({
            title: "订单还在处理",
            content: "上一次提交仍在处理中。你可以先查看订单列表，若没有生成订单，可重新提交。",
            cancelText: "查看订单",
            confirmText: "重新提交",
            confirmColor: "#B99C74",
            success: (res) => {
              if (res.confirm) this.retrySubmitCartOrder();
              else if (res.cancel) wx.switchTab({ url: "/pages/order/list" });
            }
          });
          return;
        }
        clearSubmitKey(SUBMIT_CART_ORDER_SCENE);
        logSubmitDebug("failed", {
          idempotencyKey,
          errorCode: err.code || "",
          message: err.message || ""
        });
        haptics.error();
        feedback.showError(err.message);
      },
      finally: () => this.safeSetData({ submitting: false })
    });
  },

  goShop() {
    wx.switchTab({ url: "/pages/index/index" });
  }
});
