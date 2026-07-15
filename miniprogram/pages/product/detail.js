const { call, moneyText, toast, feedback } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin } = require("../../utils/auth");
const { DELIVERY_TYPE_OPTIONS, EMPTY_SHIPPING_ADDRESS, normalizeShippingAddress } = require("../../utils/delivery");
const { createSubmitKey, clearSubmitKey, generateIdempotencyKey } = require("../../utils/idempotency");
const {
  cartItemFromAddResult,
  clearProductPreview,
  consumeProductPreview,
  markDirty,
  readProductPreview,
  upsertCartCacheItem,
  writeProductPreview
} = require("../../utils/performanceCache");
const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const sync = require("../../utils/sync");
const haptics = require("../../utils/haptics");

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

function submitSceneFor(productId) {
  return `submit_order_${productId}`;
}

const RECENT_ORDER_WINDOW_MS = 10 * 60 * 1000;

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value && value.$date) return toMillis(value.$date);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecentOrder(order) {
  const createdAt = toMillis(order && order.createdAt);
  if (!createdAt) return true;
  return Date.now() - createdAt <= RECENT_ORDER_WINDOW_MS;
}

function matchesSubmittedProductOrder(order, productId, quantity) {
  if (!order || !isRecentOrder(order)) return false;
  if (order.createdFromCart === true || order.orderType === "cart") return false;
  return String(order.productId || "") === String(productId || "")
    && Number(order.quantity || 0) === Number(quantity || 0);
}

function logSubmitDebug(stage, details = {}) {
  console.info("[productSubmit]", {
    stage,
    actionType: "submit_order",
    keyTail: String(details.idempotencyKey || "").slice(-6),
    idempotencyStatus: details.idempotencyStatus || "",
    errorCode: details.errorCode || "",
    hasOrderId: Boolean(details.orderId)
  });
}

function tagClass(tag) {
  return {
    "新货": "new",
    "瑕疵": "defective",
    "热销": "hot",
    "常购": "frequent"
  }[tag] || "";
}

Page({
  data: {
    id: "",
    product: null,
    quantity: "1",
    totalText: "0.00",
    loading: true,
    initialized: false,
    submitting: false,
    addingCart: false,
    favoriteChanging: false,
    isFavorite: false,
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

  onLoad(options) {
    const id = options.id || "";
    this.setData({ id });
    initOrientation(this);
    this._unsubscribeSync = sync.subscribe(this, ["product", "inventory"], (events) => {
      const relevant = events.some((event) => !event.entityId || event.entityId === this.data.id);
      if (!relevant) return;
      const busy = Boolean(this.productLoading);
      const request = this.loadProduct({ silent: true });
      if (busy) Promise.resolve(request).finally(() => this.loadProduct({ silent: true })).catch(() => null);
    });
    const hasPreview = this.applyProductPreview(id);
    this.afterFirstPaint(() => this.initializeAfterFirstPaint(hasPreview));
  },

  onShow() {
    this.afterFirstPaint(() => {
      ensureFrontendAccess()
        .then(() => this.applySelectedAddressFromStorage())
        .catch(() => null);
    });
  },

  afterFirstPaint(callback) {
    if (typeof wx.nextTick === "function") {
      wx.nextTick(callback);
      return;
    }
    setTimeout(callback, 0);
  },

  initializeAfterFirstPaint(hasPreview) {
    return ensureLogin({ showLoading: false })
      .then(() => ensureFrontendAccess())
      .then(() => Promise.all([
        this.loadProduct({ silent: hasPreview }),
        this.loadDeliveryOptions()
      ]))
      .catch((err) => toast(err.message));
  },

  shapeProduct(source = {}) {
    const product = { ...source };
    const tags = Array.isArray(product.tags) ? product.tags : [];
    const isDefective = product.isDefective === true || tags.indexOf("瑕疵") > -1;
    product.priceText = moneyText(product.price);
    product.tagItems = product.tagItems || tags.map((tag) => ({ name: tag, className: tagClass(tag) }));
    product.isDefective = isDefective;
    product.defectNotice = isDefective
      ? (product.defectDescription || "该商品为瑕疵商品，详情请联系商家。")
      : "";
    return product;
  },

  applyProductPreview(productId = this.data.id) {
    const cached = consumeProductPreview(productId) || readProductPreview(productId);
    if (!cached || !cached.data) return false;
    const product = this.shapeProduct(cached.data);
    this.setData({ product, loading: false, initialized: true }, () => this.updateTotal());
    return true;
  },

  loadProduct(options = {}) {
    if (this.productLoading) return this.productLoading;
    this.setData({ loading: !options.silent && !this.data.product });
    this.productLoading = call("getProducts", {
      onlyActive: true,
      productId: this.data.id
    }, { showLoading: false }).then((data) => {
      const product = (data.products || []).find((item) => item._id === this.data.id);
      if (!product) {
        clearProductPreview(this.data.id);
        feedback.showWarning("商品不存在或已下架");
        this.setData({ product: null, isFavorite: false });
        return;
      }
      const shapedProduct = this.shapeProduct(product);
      writeProductPreview(shapedProduct);
      this.setData({ product: shapedProduct }, () => {
        this.updateTotal();
        this.loadFavoriteStatus();
      });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => {
        this.productLoading = null;
        this.setData({ loading: false, initialized: true });
      });
    return this.productLoading;
  },

  loadFavoriteStatus() {
    if (!this.data.id) return Promise.resolve();
    return call("getFavoriteStatus", { productId: this.data.id }, { showLoading: false })
      .then((data) => this.setData({ isFavorite: Boolean(data.isFavorite) }))
      .catch(() => this.setData({ isFavorite: false }));
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
      this.setData({
        deliveryType,
        shippingAddress: normalizeShippingAddress(preference.lastShippingAddress),
        pickupInfo: pickup,
        selectedAddress,
        selectedAddressText: selectedAddress ? formatSelectedAddress(selectedAddress) : ""
      });
    }).catch((err) => feedback.showError(err.message));
  },

  applySelectedAddressFromStorage() {
    const selectedAddress = wx.getStorageSync("selectedShippingAddress");
    if (!selectedAddress || !selectedAddress._id) return;
    const displayAddress = decorateSelectedAddress(selectedAddress);
    this.setData({
      selectedAddress: displayAddress,
      selectedAddressText: formatSelectedAddress(displayAddress)
    });
  },

  onQtyInput(e) {
    this.setData({ quantity: e.detail.value }, () => this.updateTotal());
  },

  onQtyBlur() {
    haptics.light();
    const quantity = Math.max(1, Number(this.data.quantity || 1));
    this.setData({ quantity: String(quantity) }, () => this.updateTotal());
  },

  changeQty(e) {
    const delta = Number(e.currentTarget.dataset.delta || 0);
    const current = Math.max(1, Number(this.data.quantity || 1));
    const quantity = Math.max(1, current + delta);
    haptics.selection();
    this.setData({ quantity: String(quantity) }, () => this.updateTotal());
  },

  onDeliveryTypeChange(e) {
    if (e.detail.value === "self_pickup" && this.data.pickupInfo.isConfigured === false) {
      haptics.error();
      feedback.showWarning("自提暂未配置，请先选择发货");
      this.setData({ deliveryType: "shipping" });
      return;
    }
    haptics.selection();
    this.setData({ deliveryType: e.detail.value });
  },

  onShippingInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`shippingAddress.${field}`]: e.detail.value });
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

  updateTotal() {
    const product = this.data.product;
    const quantity = Math.max(0, Number(this.data.quantity || 0));
    const total = product ? Number(product.price || 0) * quantity : 0;
    this.setData({ totalText: moneyText(total) });
  },

  addToCart() {
    if (this.data.addingCart || !this.data.product) return;
    haptics.medium();
    const quantity = Math.max(1, Number(this.data.quantity || 1));
    this.setData({ addingCart: true, quantity: String(quantity) });
    call("addToCart", {
      productId: this.data.id,
      quantity,
      idempotencyKey: generateIdempotencyKey("add_to_cart")
    }, { showLoading: false }).then((data) => {
      feedback.showSuccess("已加入购物车");
      haptics.success();
      upsertCartCacheItem(cartItemFromAddResult(data, this.data.product, quantity));
    }).catch((err) => {
      haptics.error();
      feedback.showError(err.message);
    })
      .finally(() => this.setData({ addingCart: false }));
  },

  toggleFavorite() {
    if (this.data.favoriteChanging || !this.data.product) return;
    const before = this.data.isFavorite;
    this.setData({ isFavorite: !before, favoriteChanging: true });
    call("toggleFavorite", { productId: this.data.id }, { showLoading: false })
      .then((data) => {
        this.setData({ isFavorite: Boolean(data.isFavorite) });
        feedback.showSuccess(data.isFavorite ? "已收藏" : "已取消收藏");
      })
      .catch((err) => {
        this.setData({ isFavorite: before });
        feedback.showError(err.message);
      })
      .finally(() => this.setData({ favoriteChanging: false }));
  },

  goCart() {
    wx.switchTab({ url: "/pages/cart/index" });
  },

  goShop() {
    wx.switchTab({ url: "/pages/index/index" });
  },

  findRecentSubmittedOrder(quantity) {
    return call("getOrders", { limit: 10 }, { showLoading: false })
      .then((data) => {
        const orders = data.orders || [];
        return orders.find((order) => matchesSubmittedProductOrder(order, this.data.id, quantity)) || null;
      });
  },

  goOrderDetail(order) {
    const submitScene = submitSceneFor(this.data.id);
    clearSubmitKey(submitScene);
    if (order && order._id) {
      wx.navigateTo({ url: `/pages/order/detail?id=${order._id}` });
      return;
    }
    wx.switchTab({ url: "/pages/order/list" });
  },

  retrySubmitOrder() {
    const quantity = Math.max(1, Number(this.data.quantity || 1));
    this.findRecentSubmittedOrder(quantity).then((order) => {
      if (order) {
        feedback.showInfo("已找到刚刚提交的订单");
        this.goOrderDetail(order);
        return;
      }
      const submitScene = submitSceneFor(this.data.id);
      clearSubmitKey(submitScene);
      this.submitOrder({ retry: true });
    }).catch((err) => {
      feedback.showError(err.message || "查询订单失败，请稍后再试");
    });
  },

  async submitOrder(options = {}) {
    const isRetry = Boolean(options && options.retry);
    if (this.data.submitting || !this.data.product) return;
    if (this.data.deliveryType === "self_pickup" && this.data.pickupInfo.isConfigured === false) {
      haptics.error();
      feedback.showWarning("自提暂未配置，请先选择发货");
      this.setData({ deliveryType: "shipping" });
      return;
    }
    const hasAddress = await this.ensureDeliveryAddress();
    if (!hasAddress) {
      haptics.error();
      return;
    }
    const quantity = Math.max(1, Number(this.data.quantity || 1));
    const phoneReady = await ensurePhoneBeforeOrder(`/pages/product/detail?id=${this.data.id}`);
    if (!phoneReady) {
      haptics.error();
      return;
    }
    haptics.medium();
    const confirmed = await feedback.confirmAction({
      title: isRetry ? "重新提交预订单" : "提交预订单",
      content: isRetry
        ? `确认订单列表里没有生成新订单后，重新提交 ${quantity} 件该商品？`
        : `确认提交 ${quantity} 件该商品？提交后将进入审核流程。`,
      confirmText: isRetry ? "重新提交" : "提交"
    });
    if (!confirmed) return;
    this.setData({ submitting: true, quantity: String(quantity) });
    const submitScene = submitSceneFor(this.data.id);
    const idempotencyKey = createSubmitKey(submitScene);
    logSubmitDebug("request", { idempotencyKey });
    call("createOrder", {
      productId: this.data.id,
      quantity,
      idempotencyKey,
      ...this.deliveryPayload()
    }).then((data) => {
      clearSubmitKey(submitScene);
      logSubmitDebug("success", {
        idempotencyKey,
        idempotencyStatus: data.idempotencyStatus,
        orderId: data.orderId
      });
      haptics.success();
      feedback.showSuccess(data.message || "已提交");
      markDirty("order");
      if (data.status === "auto_reviewing") {
        setTimeout(() => {
          call("autoReviewOrder", { orderId: data.orderId }, { showLoading: false }).catch(() => null);
        }, 5000);
      }
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/order/detail?id=${data.orderId}` });
      }, 800);
    }).catch((err) => {
      if (handlePhoneRequiredError(err, `/pages/product/detail?id=${this.data.id}`)) return;
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
            if (res.confirm) this.retrySubmitOrder();
            else if (res.cancel) wx.switchTab({ url: "/pages/order/list" });
          }
        });
        return;
      }
      clearSubmitKey(submitScene);
      logSubmitDebug("failed", { idempotencyKey, errorCode: err.code || "" });
      haptics.error();
      feedback.showError(err.message);
    })
      .finally(() => this.setData({ submitting: false }));
  },

  onUnload() {
    if (this._unsubscribeSync) this._unsubscribeSync();
    cleanupOrientation(this);
  }
});
