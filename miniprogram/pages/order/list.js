const { call, moneyText, toast, feedback } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin } = require("../../utils/auth");
const { ORDER_STATUS_TEXT, getStatusMeta, orderStatusMap, paymentStatusMap } = require("../../utils/status");
const { syncTabBar } = require("../../utils/tabbar");
const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const sync = require("../../utils/sync");
const { staggerClass } = require("../../utils/motion");
const haptics = require("../../utils/haptics");
const {
  clearDirty,
  isDirty
} = require("../../utils/performanceCache");
const {
  PAGE_SIZE,
  TIME_PRESETS,
  PAYMENT_FILTER_OPTIONS,
  DELIVERY_FILTER_OPTIONS,
  emptyDetailedFilters,
  validateDetailedFilters,
  buildCustomerOrderQuery,
  deriveAppliedFilterSummary,
  dedupeOrders
} = require("./orderFilters");

const MIN_ORDER_FETCH_INTERVAL = 1000;
const ORDER_REFRESH_INTERVAL = 30 * 1000;
const ORDER_FILTERS = [
  { value: "all", label: "全部" },
  { value: "review", label: "待审核" },
  { value: "payment", label: "待付款" },
  { value: "confirm", label: "待确认" },
  { value: "shipping", label: "配送中" },
  { value: "done", label: "已完成" }
];

function deriveOrderFilter(item = {}) {
  const status = item.status || "";
  const paymentStatus = item.paymentStatus || "";
  const shippingStatus = (item.shipmentDisplay && item.shipmentDisplay.shippingStatus)
    || item.shippingStatus
    || item.deliveryStatus
    || "";
  if (["pending_system", "auto_reviewing", "pending_admin"].includes(status)) return "review";
  if (["approved_pending_payment", "unpaid"].includes(status) || ["none", "unpaid"].includes(paymentStatus)) return "payment";
  if (status === "pending_payment_confirm" || ["pending_confirm", "partial", "partial_paid", "abnormal"].includes(paymentStatus)) return "confirm";
  if (["waiting_shipping", "pending_shipment", "shipped"].includes(shippingStatus) || status === "paid") return "shipping";
  if (["completed"].includes(status) || shippingStatus === "completed") return "done";
  return "all";
}

function deriveNextStep(item = {}, orderFilter = "all", statusMeta = {}, paymentMeta = {}) {
  const status = item.status || "";
  if (["rejected", "cancelled"].includes(status)) {
    return {
      nextStepTitle: statusMeta.label || "订单已处理",
      nextStepHint: statusMeta.description || "进入详情查看处理记录",
      nextStepClass: "next-step-muted"
    };
  }
  if (item.paymentStatus === "refunded") {
    return {
      nextStepTitle: paymentMeta.label || "已退款",
      nextStepHint: paymentMeta.description || "进入详情查看退款记录",
      nextStepClass: "next-step-muted"
    };
  }
  const copyByFilter = {
    review: {
      nextStepTitle: "等待商家审核",
      nextStepHint: "通过后会进入付款与配货流程",
      nextStepClass: "next-step-review"
    },
    payment: {
      nextStepTitle: "待提交付款",
      nextStepHint: "进入详情查看付款方式与要求",
      nextStepClass: "next-step-payment"
    },
    confirm: {
      nextStepTitle: "等待付款确认",
      nextStepHint: "商家确认后会继续安排配送",
      nextStepClass: "next-step-confirm"
    },
    shipping: {
      nextStepTitle: "等待配送进度",
      nextStepHint: "发货、自提或完成信息会同步到详情",
      nextStepClass: "next-step-shipping"
    },
    done: {
      nextStepTitle: "订单已完成",
      nextStepHint: "可进入详情查看商品与履约记录",
      nextStepClass: "next-step-done"
    }
  };
  return copyByFilter[orderFilter] || {
    nextStepTitle: statusMeta.label || "查看订单进度",
    nextStepHint: statusMeta.description || paymentMeta.description || "进入详情查看完整进度",
    nextStepClass: "next-step-all"
  };
}

Page({
  data: {
    orders: [],
    page: 1,
    pageSize: PAGE_SIZE,
    hasMore: false,
    loading: false,
    loadingMore: false,
    initialized: false,
    loadError: "",
    orderFilters: ORDER_FILTERS,
    activeOrderFilter: "all",
    searchInput: "",
    searchKeyword: "",
    filterDrawerVisible: false,
    timePresets: TIME_PRESETS,
    paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
    deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
    draftFilters: emptyDetailedFilters(),
    appliedFilters: emptyDetailedFilters(),
    activeFilterCount: 0,
    activeFilterChips: [],
    nextCursor: "",
    searchingOlderOrders: false,
    showContinueOlderSearch: false,
    visibleOrders: [],
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false
  },

  onLoad() {
    this._orderInitializing = true;
    initOrientation(this);
    this._unsubscribeSync = sync.subscribe(this, ["order", "payment", "shipment", "after_sale", "refund"], () => {
      this.loadOrders({ reset: true, force: true, silent: true });
    });
    ensureLogin({ showLoading: false })
      .then(() => ensureFrontendAccess())
      .then(() => {
        return this.loadOrders({ reset: true, force: true });
      })
      .catch((err) => {
        this.setData({ loading: false, initialized: true });
        toast(err.message);
      })
      .finally(() => {
        this._orderInitializing = false;
      });
  },

  onShow() {
    syncTabBar(this, 2);
    if (this._orderInitializing) return;
    const shouldReset = this._resetFiltersOnNextShow === true;
    this._resetFiltersOnNextShow = false;
    if (shouldReset) {
      this.invalidateOrderRequests();
      this.setData({
        activeOrderFilter: "all",
        searchInput: "",
        searchKeyword: "",
        filterDrawerVisible: false,
        draftFilters: emptyDetailedFilters(),
        appliedFilters: emptyDetailedFilters(),
        activeFilterCount: 0,
        activeFilterChips: [],
        nextCursor: "",
        showContinueOlderSearch: false,
        paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
        deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: false }))
      });
    }
    return ensureLogin({ showLoading: false })
      .then(() => ensureFrontendAccess())
      .then(() => {
        if (shouldReset) return this.loadOrders({ reset: true, force: true });
        const elapsed = Date.now() - Number(this.orderLastFetchAt || 0);
        if (isDirty("order") || !this.data.initialized || elapsed >= ORDER_REFRESH_INTERVAL) {
          return this.loadOrders({ reset: true, silent: this.data.orders.length > 0 });
        }
        return null;
      })
      .catch(() => null);
  },

  onHide() {
    this.setFilterDrawerTabBarHidden(false);
    this._resetFiltersOnNextShow = true;
  },

  onUnload() {
    this.setFilterDrawerTabBarHidden(false);
    if (this._unsubscribeSync) this._unsubscribeSync();
    cleanupOrientation(this);
  },

  shapeOrders(orders = []) {
    return orders.map((item, index) => {
        const statusMeta = getStatusMeta(orderStatusMap, item.status, ORDER_STATUS_TEXT[item.status] || item.status);
        const paymentMeta = getStatusMeta(paymentStatusMap, item.paymentStatus, item.paymentStatus);
        const shipment = item.shipmentDisplay || {};
        const orderFilter = deriveOrderFilter(item);
        const nextStep = deriveNextStep(item, orderFilter, statusMeta, paymentMeta);
        return {
          ...item,
          displayName: item.itemSummary || item.productName,
          statusText: statusMeta.label,
          statusClass: statusMeta.className,
          paymentText: paymentMeta.label,
          paymentClass: paymentMeta.className,
          isPaid: item.status === "paid" || item.paymentStatus === "paid",
          orderFilter,
          ...nextStep,
          showMergedShipment: shipment.isMergedShipment === true,
          shipmentStatusText: this.shipmentStatusText(shipment.shippingStatus || item.shippingStatus || item.deliveryStatus),
          shippingCompanyDisplay: shipment.shippingCompany || item.shippingCompany || item.expressCompany || "",
          trackingNoDisplay: shipment.trackingNo || item.trackingNo || item.expressNo || "",
          totalText: moneyText(item.totalAmount),
          motionClass: staggerClass(index)
        };
      });
  },

  shouldSkipFetch(options = {}) {
    if (options.force || isDirty("order")) return false;
    if (this.orderLoading) return true;
    const elapsed = Date.now() - Number(this.orderLastFetchAt || 0);
    if (elapsed > 0 && elapsed < MIN_ORDER_FETCH_INTERVAL) return true;
    if (options.reset !== false && this.data.initialized && elapsed > 0 && elapsed < ORDER_REFRESH_INTERVAL) return true;
    return false;
  },

  invalidateOrderRequests() {
    this._orderRequestGeneration = Number(this._orderRequestGeneration || 0) + 1;
    return this._orderRequestGeneration;
  },

  loadOrders(options = {}) {
    const reset = options.reset !== false;
    if (this.orderLoading) {
      if (options.force) {
        this.invalidateOrderRequests();
        this._pendingOrderLoadOptions = { ...options };
      }
      return this.orderLoading;
    }
    if (this.shouldSkipFetch(options)) return Promise.resolve();
    if (!reset && !this.data.hasMore) return Promise.resolve();
    if (options.force) this.invalidateOrderRequests();
    this._pendingOrderLoadOptions = { ...options };
    this.orderLoading = new Promise((resolve) => {
      this._resolveOrderLoading = resolve;
    });
    this.processNextOrderLoad();
    return this.orderLoading;
  },

  processNextOrderLoad() {
    const options = this._pendingOrderLoadOptions;
    this._pendingOrderLoadOptions = null;
    if (!options) {
      const resolve = this._resolveOrderLoading;
      this._resolveOrderLoading = null;
      this.orderLoading = null;
      this.setData({ loading: false, loadingMore: false, initialized: true, searchingOlderOrders: false });
      if (resolve) resolve();
      return;
    }
    const generation = Number(this._orderRequestGeneration || 0);
    let request;
    try {
      request = this.executeOrderLoad(options, generation);
    } catch (error) {
      this.handleOrderLoadError(error, generation);
      request = Promise.resolve();
    }
    Promise.resolve(request).finally(() => this.processNextOrderLoad());
  },

  executeOrderLoad(options, generation) {
    const reset = options.reset !== false;
    if (!reset && !this.data.hasMore) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    const payload = buildCustomerOrderQuery(this.data, reset ? "" : this.data.nextCursor);
    const showSkeleton = reset && !options.silent && !this.data.orders.length;
    this.setData(reset
      ? { loading: showSkeleton, loadError: "", showContinueOlderSearch: false, searchingOlderOrders: false }
      : { loadingMore: true, loadError: "", showContinueOlderSearch: false, searchingOlderOrders: false });
    this.orderLastFetchAt = Date.now();
    return this.fetchFilteredPage(payload, 2, generation).then((data) => {
      if (generation !== Number(this._orderRequestGeneration || 0)) return;
      const nextOrders = this.shapeOrders(data.orders || []);
      const orders = dedupeOrders(reset ? nextOrders : this.data.orders.concat(nextOrders));
      const state = {
        orders,
        visibleOrders: orders,
        page,
        pageSize: PAGE_SIZE,
        nextCursor: data.nextCursor || "",
        hasMore: Boolean(data.hasMore),
        showContinueOlderSearch: !nextOrders.length && Boolean(data.hasMore),
        searchingOlderOrders: false
      };
      this.setData(state);
      if (reset) clearDirty("order");
    }).catch((err) => this.handleOrderLoadError(err, generation));
  },

  handleOrderLoadError(err, generation) {
    if (generation !== Number(this._orderRequestGeneration || 0)) return;
    this.orderLastFetchAt = 0;
    const message = err.message || "订单加载失败";
    this.setData({ loadError: message });
    feedback.showError(message);
  },

  fetchFilteredPage(payload, remainingAutoContinues = 2, generation = Number(this._orderRequestGeneration || 0)) {
    return call("getOrders", payload, { showLoading: false }).then((data) => {
      const rows = data.orders || [];
      const isCurrent = generation === Number(this._orderRequestGeneration || 0);
      if (isCurrent && !rows.length && data.hasMore && data.nextCursor && remainingAutoContinues > 0) {
        this.setData({ searchingOlderOrders: true });
        return this.fetchFilteredPage({ ...payload, cursor: data.nextCursor }, remainingAutoContinues - 1, generation);
      }
      return data;
    });
  },

  selectOrderFilter(e) {
    const filter = e.currentTarget.dataset.filter || "all";
    if (filter === this.data.activeOrderFilter) return Promise.resolve();
    haptics.selection();
    return new Promise((resolve) => {
      this.setData({ activeOrderFilter: filter }, () => {
        Promise.resolve(this.loadOrders({ reset: true, force: true })).finally(resolve);
      });
    });
  },

  onSearchInput(e) {
    this.setData({ searchInput: e.detail.value || "" });
  },

  submitSearch() {
    this.setData({ searchKeyword: String(this.data.searchInput || "").trim() });
    return this.loadOrders({ reset: true, force: true });
  },

  setFilterDrawerTabBarHidden(hidden) {
    let tabBar = null;
    try {
      tabBar = typeof this.getTabBar === "function" ? this.getTabBar() : null;
    } catch (error) {
      tabBar = null;
    }
    if (!tabBar || typeof tabBar.setData !== "function") return;

    if (hidden) {
      if (this._filterDrawerTabBarVisibilityCaptured !== true) {
        this._filterDrawerTabBarVisibilityCaptured = true;
        this._filterDrawerTabBarPreviousVisible = !tabBar.data || tabBar.data.visible !== false;
      }
      tabBar.setData({ visible: false });
      return;
    }

    if (this._filterDrawerTabBarVisibilityCaptured !== true) return;
    const visible = this._filterDrawerTabBarPreviousVisible !== false;
    this._filterDrawerTabBarVisibilityCaptured = false;
    this._filterDrawerTabBarPreviousVisible = undefined;
    tabBar.setData({ visible });
  },

  openFilterDrawer() {
    const draft = JSON.parse(JSON.stringify(this.data.appliedFilters));
    this.setFilterDrawerTabBarHidden(true);
    this.setData({
      filterDrawerVisible: true,
      draftFilters: draft,
      paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: draft.paymentStatuses.includes(item.value) })),
      deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: draft.deliveryStatuses.includes(item.value) }))
    });
  },

  closeFilterDrawer() {
    this.setData({ filterDrawerVisible: false });
    this.setFilterDrawerTabBarHidden(false);
  },

  toggleFilterValue(key, value, optionsKey, sourceOptions) {
    const selected = new Set(this.data.draftFilters[key]);
    if (selected.has(value)) selected.delete(value);
    else selected.add(value);
    const values = Array.from(selected);
    this.setData({
      [`draftFilters.${key}`]: values,
      [optionsKey]: sourceOptions.map((item) => ({ ...item, selected: values.includes(item.value) }))
    });
  },

  togglePaymentStatus(e) {
    this.toggleFilterValue("paymentStatuses", e.currentTarget.dataset.value, "paymentFilterOptions", PAYMENT_FILTER_OPTIONS);
  },

  toggleDeliveryStatus(e) {
    this.toggleFilterValue("deliveryStatuses", e.currentTarget.dataset.value, "deliveryFilterOptions", DELIVERY_FILTER_OPTIONS);
  },

  selectTimePreset(e) {
    this.setData({ "draftFilters.timePreset": e.currentTarget.dataset.value || "all" });
  },

  onCustomStartDateChange(e) {
    this.setData({ "draftFilters.startDate": e.detail.value || "" });
  },

  onCustomEndDateChange(e) {
    this.setData({ "draftFilters.endDate": e.detail.value || "" });
  },

  resetDraftFilters() {
    const draft = emptyDetailedFilters();
    this.setData({
      draftFilters: draft,
      paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
      deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: false }))
    });
  },

  applyDraftFilters() {
    try {
      validateDetailedFilters(this.data.draftFilters);
    } catch (error) {
      toast(error.message);
      return Promise.resolve();
    }
    const applied = JSON.parse(JSON.stringify(this.data.draftFilters));
    this.setData({ filterDrawerVisible: false, appliedFilters: applied });
    this.setFilterDrawerTabBarHidden(false);
    this.updateAppliedFilterSummary();
    return this.loadOrders({ reset: true, force: true });
  },

  updateAppliedFilterSummary() {
    this.setData(deriveAppliedFilterSummary(this.data.appliedFilters));
  },

  clearAllFilters() {
    this.setData({
      activeOrderFilter: "all",
      searchInput: "",
      searchKeyword: "",
      draftFilters: emptyDetailedFilters(),
      appliedFilters: emptyDetailedFilters(),
      activeFilterCount: 0,
      activeFilterChips: [],
      paymentFilterOptions: PAYMENT_FILTER_OPTIONS.map((item) => ({ ...item, selected: false })),
      deliveryFilterOptions: DELIVERY_FILTER_OPTIONS.map((item) => ({ ...item, selected: false }))
    });
    return this.loadOrders({ reset: true, force: true });
  },

  continueOlderSearch() {
    this.setData({ showContinueOlderSearch: false });
    return this.loadOrders({ reset: false, force: true });
  },

  noop() {},

  refreshOrders() {
    return this.loadOrders({ reset: true, force: true });
  },

  onReachBottom() {

    this.loadOrders({ reset: false });
  },

  onPullDownRefresh() {
    this.loadOrders({ reset: true, force: true }).finally(() => wx.stopPullDownRefresh());
  },

  goDetail(e) {
    haptics.selection();
    wx.navigateTo({ url: `/pages/order/detail?id=${e.currentTarget.dataset.id}` });
  },

  shipmentStatusText(status) {
    const map = {
      created: "待发货",
      pending_shipment: "待发货",
      waiting_shipping: "待发货",
      shipped: "已发货",
      completed: "已完成",
      cancelled: "已取消",
      abnormal: "异常"
    };
    return map[status] || status || "待处理";
  }
});
