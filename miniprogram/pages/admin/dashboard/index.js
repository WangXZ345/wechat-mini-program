const { call, toast, feedback } = require("../../../utils/api");
const { ensureAdmin, profileHasAnyPermission } = require("../../../utils/auth");
const { isFullAccessRole } = require("../../../utils/role");
const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const haptics = require("../../../utils/haptics");

const RANGE_OPTIONS = [
  { label: "今日", value: "today" },
  { label: "近 3 日", value: "3d" },
  { label: "近 7 日", value: "7d" },
  { label: "近 30 日", value: "30d" }
];
Page({
  data: {
    rangeOptions: RANGE_OPTIONS,
    rangeIndex: 0,
    range: "today",
    loading: false,
    initialized: false,
    errorMessage: "",
    updatedAt: "",
    summaryCards: [],
    summaryMetricCards: [],
    quickActionCards: [],
    todoItems: [],
    adminMenus: [],
    adminMenuGroups: [],
    salesTrend: [],
    topSellingProducts: [],
    slowMovingProducts: [],
    lowStockProducts: [],
    unpaidCustomers: [],
    productActions: [],
    adminProfile: null,
    showProductSection: false,
    showTodoItems: false,
    showSalesTrend: false,
    showTopSellingProducts: false,
    showInventorySections: false,
    showCustomerAccountInsights: false,
    isLandscape: false,
    isWideScreen: false,
    screenWidth: 0,
    screenHeight: 0
  },

  onLoad() {
    initOrientation(this);
    ensureAdmin("dashboard:view_basic")
      .then((profile) => {
        this.setData({ adminProfile: profile });
        return this.load({ profile });
      })
      .catch((err) => {
        this.setData({ errorMessage: err.message || "无管理员权限" });
        feedback.showError(err.message || "无管理员权限");
      });
  },

  onPullDownRefresh() {
    this.load({ force: true }).finally(() => wx.stopPullDownRefresh());
  },

  onRangeChange(e) {
    this.switchRange(Number(e.detail.value || 0));
  },

  onRangeChipTap(e) {
    this.switchRange(Number(e.currentTarget.dataset.index || 0));
  },

  switchRange(rangeIndex) {
    if (rangeIndex === this.data.rangeIndex) return;
    const option = RANGE_OPTIONS[rangeIndex] || RANGE_OPTIONS[0];
    const cached = this.getDashboardRangeCache(option.value);
    this.setData({ rangeIndex, range: option.value, ...(cached || {}) }, () => {
      this.load({ force: true, silent: Boolean(cached) });
    });
  },

  getDashboardRangeCache(range) {
    const cache = this.dashboardRangeCache || {};
    return cache[range] || null;
  },

  setDashboardRangeCache(range, data) {
    if (!range || !data) return;
    if (!this.dashboardRangeCache) this.dashboardRangeCache = Object.create(null);
    this.dashboardRangeCache[range] = data;
  },

  load(options = {}) {
    if (this.dashboardLoading && !options.force) return this.dashboardLoading;
    const requestId = Number(this.dashboardRequestId || 0) + 1;
    const requestRange = this.data.range;
    this.dashboardRequestId = requestId;
    this.setData({ loading: !options.silent, errorMessage: "" });
    const task = call("getAdminDashboardStats", {
      range: requestRange,
      timezone: "Asia/Shanghai"
    }, { showLoading: false }).then((data) => {
      if (requestId !== this.dashboardRequestId || requestRange !== this.data.range) return;
      const shaped = this.shapeDashboard(data || {}, options.profile || this.data.adminProfile);
      const nextState = { ...shaped, initialized: true };
      this.setDashboardRangeCache(requestRange, nextState);
      this.setData(nextState);
    }).catch((err) => {
      if (requestId !== this.dashboardRequestId) return;
      const message = err.message || "加载后台数据失败";
      this.setData({ errorMessage: message });
      feedback.showError(message);
    }).finally(() => {
      if (requestId === this.dashboardRequestId) this.setData({ loading: false });
      if (this.dashboardLoading === task) this.dashboardLoading = null;
    });
    this.dashboardLoading = task;
    return task;
  },

  retry() {
    this.load({ force: true });
  },

  go(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    haptics.selection();
    wx.navigateTo({ url });
  },

  buildAdminMenus(profile) {
    const menus = [
      { label: "订单管理", hint: "查看、审核和处理订单", url: "/pages/admin/orders", permissions: ["order:view"], roles: ["customer_service", "finance"] },
      { label: "付款审核", hint: "确认付款截图和付款状态", url: "/pages/admin/orders?paymentStatus=pending_confirm", permissions: ["payment:confirm", "dashboard:view_finance"], roles: ["finance"] },
      { label: "客户账款", hint: "客户欠款、对账和账款明细", url: "/pages/admin/accounts/index", permissions: ["customer:view_account", "dashboard:view_finance"], roles: ["finance"] },
      { label: "售后管理", hint: "查看和审核售后申请", url: "/pages/admin/after-sales/index/index", permissions: ["after_sale:view"], roles: ["customer_service", "finance"] },
      { label: "退款管理", hint: "查看和处理退款记录", url: "/pages/admin/refunds/index/index", permissions: ["refund:view"], roles: ["finance"] },
      { label: "发货管理", hint: "发货、合并发货和物流处理", url: "/pages/admin/delivery/index", permissions: ["shipment:ship", "order:ship"], roles: ["customer_service"] },
      { label: "客户管理", hint: "客户资料、备注和标签", url: "/pages/admin/customers/index", permissions: ["customer:view_basic", "customer:edit_remark"], roles: ["customer_service"] },
      { label: "商品管理", hint: "商品资料、价格和上下架", url: "/pages/admin/products", permissions: ["product:view"] },
      { label: "商品数据分析", hint: "查看单品销量、成交均价和报价趋势", url: "/pages/admin/product-analytics/index", permissions: ["product:analytics:view", "dashboard:view_product"] },
      { label: "库存管理", hint: "库存调整和库存日志", url: "/pages/admin/inventory", permissions: ["inventory:view"] },
      { label: "库存导入", hint: "批量导入库存和报价", url: "/pages/admin/import/index", permissions: ["inventory:import"] },
      { label: "库存预警", hint: "低库存、缺货和预警值", url: "/pages/admin/stock-alerts/index", permissions: ["inventory:view", "dashboard:view_inventory"] },
      { label: "热销分析", hint: "销售趋势和商品排行", url: "/pages/admin/dashboard/index", permissions: ["dashboard:view_sales"] },
      { label: "滞销分析", hint: "长期未售商品处理", url: "/pages/admin/unsold/index", permissions: ["dashboard:view_inventory", "product:view"] },
      { label: "推荐区管理", hint: "首页推荐区配置", url: "/pages/admin/recommend/index", permissions: ["home_recommend:view", "home_recommend:manage"] },
      { label: "商品标签管理", hint: "商品标签批量维护", url: "/pages/admin/products?tab=tags", permissions: ["product:tag:view", "product:tag:update"] },
      { label: "支付配置", hint: "付款方式、二维码和银行卡", url: "/pages/admin/payment-methods/index", permissions: ["system:payment_methods", "payment:config", "payment_method:view"], roles: ["finance"] },
      { label: "管理员管理", hint: "管理员账号和角色", url: "/pages/admin/admins/index", permissions: ["admin:view"] },
      { label: "系统设置", hint: "业务配置和基础设置", url: "/pages/admin/settings", permissions: ["system:settings"] }
    ];
    if (isFullAccessRole(profile && profile.role) || profile && profile.showAllAdminMenus) return menus;
    const role = profile && profile.role;
    return menus.filter((item) => {
      if (item.roles && item.roles.indexOf(role) === -1) return false;
      return this.hasAnyPermission(item.permissions, profile);
    });
  },

  groupAdminMenus(menus = []) {
    const groups = [
      { title: "订单履约", hint: "审核、发货、售后和客户处理", keywords: ["订单", "售后", "发货", "客户管理"], items: [] },
      { title: "商品库存", hint: "商品资料、库存、导入和推荐配置", keywords: ["商品", "库存", "导入", "热销", "滞销", "推荐"], items: [] },
      { title: "财务账款", hint: "付款审核、退款、客户账款和支付配置", keywords: ["付款", "账款", "退款", "支付"], items: [] },
      { title: "系统配置", hint: "管理员账号和业务基础设置", keywords: ["管理员", "系统设置"], items: [] }
    ];
    (menus || []).forEach((menu) => {
      const target = groups.find((group) => group.keywords.some((keyword) => String(menu.label || "").indexOf(keyword) > -1));
      (target || groups[0]).items.push(menu);
    });
    return groups.filter((group) => group.items.length);
  },

  shapeDashboard(data, profile = this.data.adminProfile) {
    const summary = data.summary || {};
    const todoList = data.todoList || {};
    const range = data.range || {};
    const rangeValue = range.value || this.data.range || "today";
    const hasRangeSummary = summary.rangeOrderCount !== undefined;
    const metricLabel = hasRangeSummary || rangeValue === "today" ? this.rangeLabel(rangeValue) : "今日";
    const orderRangeUrl = this.orderRangeUrl(rangeValue);
    const shaped = {
      updatedAt: data.updatedAt || "",
      adminMenus: this.buildAdminMenus(profile),
      summaryCards: [
        this.card(`${metricLabel}订单数`, hasRangeSummary ? summary.rangeOrderCount : summary.todayOrderCount, "单", orderRangeUrl, false, false, ["order:view"]),
        this.card(`${metricLabel}销售额`, hasRangeSummary ? summary.rangeSalesAmount : summary.todaySalesAmount, "", orderRangeUrl, true, false, ["dashboard:view_sales", "dashboard:view_finance"]),
        this.card(`${metricLabel}已付款`, hasRangeSummary ? summary.rangePaidAmount : summary.todayPaidAmount, "", "/pages/admin/accounts/index", true, false, ["customer:view_account", "dashboard:view_finance"]),
        this.card(`${metricLabel}未付款`, hasRangeSummary ? summary.rangeUnpaidAmount : summary.todayUnpaidAmount, "", "/pages/admin/accounts/index", true, true, ["customer:view_account", "dashboard:view_finance"]),
        this.card("商品管理", summary.activeProductCount || summary.productCount || 0, "个", "/pages/admin/products"),
        this.actionCard("售后管理", "处理", "/pages/admin/after-sales/index/index", ["after_sale:view"]),
        this.actionCard("退款记录", "查看", "/pages/admin/refunds/index/index", ["refund:view"]),
        this.actionCard("支付配置", "管理", "/pages/admin/payment-methods/index", ["system:payment_methods", "payment:config", "payment_method:view"]),
        this.actionCard("推荐配置", "设置", "/pages/admin/recommend/index", ["home_recommend:view", "home_recommend:manage"]),
        this.card("待审核订单", summary.pendingReviewOrderCount, "单", "/pages/admin/orders?status=pending_admin", false, true, ["order:view", "order:review"]),
        this.card("待确认付款", summary.pendingPaymentConfirmCount, "单", "/pages/admin/orders?paymentStatus=pending_confirm", false, true, ["payment:confirm", "dashboard:view_finance"]),
        this.card("库存预警商品", summary.lowStockProductCount, "个", "/pages/admin/stock-alerts/index", false, true),
        this.card("历史未付金额", summary.totalUnpaidAmount, "", "/pages/admin/accounts/index", true, true, ["customer:view_account", "dashboard:view_finance"])
      ],
      todoItems: [
        this.todo("待审核订单", summary.pendingReviewOrderCount, "单", "/pages/admin/orders?status=pending_admin", "需要管理员审核", true, ["order:view", "order:review"]),
        this.todo("库存不足订单", (todoList.insufficientStockOrders || []).length, "单", "/pages/admin/orders?stock=insufficient", "检查库存后再处理", true),
        this.todo("待确认付款截图", summary.pendingPaymentConfirmCount, "单", "/pages/admin/orders?paymentStatus=pending_confirm", "核对付款截图", true, ["payment:confirm", "dashboard:view_finance"]),
        this.todoAction("售后管理", "进入", "/pages/admin/after-sales/index/index", "人工审核售后申请", ["after_sale:view"]),
        this.todoAction("退款记录", "进入", "/pages/admin/refunds/index/index", "财务处理已审核退款", ["refund:view"]),
        this.todo("待发货订单", summary.pendingDeliveryOrderCount, "单", "/pages/admin/delivery/index", "付款后等待发货", false, ["shipment:ship", "order:ship"]),
        this.todoAction("支付配置", "进入", "/pages/admin/payment-methods/index", "维护收款码和银行卡", ["system:payment_methods", "payment:config", "payment_method:view"]),
        this.todoAction("推荐配置", "进入", "/pages/admin/recommend/index", "管理首页 4 个推荐区", ["home_recommend:view", "home_recommend:manage"]),
        this.todo("库存预警商品", summary.lowStockProductCount, "个", "/pages/admin/stock-alerts/index", "低于预警库存", true),
        this.todo("临期商品", summary.expiringProductCount, "个", "/pages/admin/products?filter=expiring", "按生产日期或效期提醒"),
        this.todo("长期未付款客户", summary.overdueCustomerCount, "人", "/pages/admin/accounts/index?filter=unpaid", "按欠款金额排序", true, ["customer:view_account", "dashboard:view_finance"])
      ],
      productActions: [
        this.productAction("商品管理", "新建、编辑、上下架和搜索商品", "/pages/admin/products", "primary"),
        this.productAction("商品数据分析", "查看单品销量、成交均价和报价趋势", "/pages/admin/product-analytics/index", "", ["product:analytics:view", "dashboard:view_product"]),
        this.productAction("新增商品", "录入商品名称、价格、库存和标签", "/pages/admin/products?action=create"),
        this.productAction("库存预警", "查看低库存和缺货商品", "/pages/admin/products?stock=warning"),
        this.productAction("临期商品", "按效期或生产日期筛选提醒", "/pages/admin/products?filter=expiring", summary.expiringProductCount > 0 ? "warning" : "")
      ],
      salesTrend: (data.salesTrend || []).map((item) => ({
        ...item,
        salesAmountText: this.money(item.salesAmount),
        paidAmountText: this.money(item.paidAmount),
        unpaidAmountText: this.money(item.unpaidAmount)
      })),
      topSellingProducts: (data.topSellingProducts || []).map((item) => ({
        ...item,
        salesAmountText: this.money(item.salesAmount),
        soldQuantityText: this.integer(item.soldQuantity),
        currentStockText: this.integer(item.currentStock)
      })),
      slowMovingProducts: (data.slowMovingProducts || []).map((item) => ({
        ...item,
        currentStockText: this.integer(item.currentStock),
        daysWithoutSaleText: item.daysWithoutSale === null || item.daysWithoutSale === undefined ? "无法计算" : `${item.daysWithoutSale} 天`
      })),
      lowStockProducts: (data.lowStockProducts || []).map((item) => ({
        ...item,
        stockText: this.integer(item.stock),
        warningStockText: this.integer(item.warningStock),
        activeText: item.isActive ? "上架" : "下架",
        stockTag: item.isOutOfStock ? "已售罄" : "低库存"
      })),
      unpaidCustomers: (data.unpaidCustomers || []).map((item) => ({
        ...item,
        displayUserId: this.maskUserIdentifier(item.openid || item.userId),
        remarkSummary: this.summarizeRemark(item.remark),
        unpaidAmountText: this.money(item.unpaidAmount),
        unpaidDaysText: item.unpaidDays === null || item.unpaidDays === undefined ? "暂无" : `${item.unpaidDays} 天`
      }))
    };

    return this.applyPermissionVisibility(shaped, profile);
  },

  hasAnyPermission(permissions, profile = this.data.adminProfile) {
    return profileHasAnyPermission(profile, permissions || []);
  },

  applyPermissionVisibility(shaped, profile) {
    const byPermissionOrUrl = (items, rules) => (items || []).filter((item) => {
      if (item.permissions && item.permissions.length) {
        return this.hasAnyPermission(item.permissions, profile);
      }
      if (item.isMoney && !canSales && !canCustomerAccount) return false;
      const url = String(item.url || "");
      const matched = rules.find((rule) => url.indexOf(rule.prefix) === 0);
      return !matched || this.hasAnyPermission(matched.permissions, profile);
    });
    const canSales = this.hasAnyPermission(["dashboard:view_sales", "dashboard:view_finance"], profile);
    const canProduct = this.hasAnyPermission(["product:view"], profile);
    const canInventory = this.hasAnyPermission(["inventory:view", "dashboard:view_inventory"], profile);
    const canCustomerAccount = this.hasAnyPermission(["customer:view_account", "dashboard:view_finance"], profile);
    const routeRules = [
      { prefix: "/pages/admin/product-analytics", permissions: ["product:analytics:view", "dashboard:view_product"] },
      { prefix: "/pages/admin/products?action=create", permissions: ["product:create"] },
      { prefix: "/pages/admin/products?stock=warning", permissions: ["inventory:view", "dashboard:view_inventory"] },
      { prefix: "/pages/admin/products?filter=expiring", permissions: ["inventory:view", "dashboard:view_inventory"] },
      { prefix: "/pages/admin/products", permissions: ["product:view"] },
      { prefix: "/pages/admin/stock-alerts", permissions: ["inventory:view", "dashboard:view_inventory"] },
      { prefix: "/pages/admin/recommend", permissions: ["home_recommend:view", "home_recommend:manage"] },
      { prefix: "/pages/admin/payment-methods", permissions: ["system:payment_methods", "payment:config", "payment_method:view"] },
      { prefix: "/pages/admin/refunds", permissions: ["refund:view"] },
      { prefix: "/pages/admin/accounts", permissions: ["customer:view_account", "dashboard:view_finance"] },
      { prefix: "/pages/admin/delivery", permissions: ["shipment:ship", "order:ship"] },
      { prefix: "/pages/admin/orders?paymentStatus=pending_confirm", permissions: ["payment:confirm", "dashboard:view_finance"] },
      { prefix: "/pages/admin/orders?stock=insufficient", permissions: ["inventory:view", "dashboard:view_inventory"] }
    ];
    const productActions = byPermissionOrUrl(shaped.productActions, routeRules);
    const todoItems = byPermissionOrUrl(shaped.todoItems, routeRules);

    const permittedSummaryCards = byPermissionOrUrl(shaped.summaryCards, routeRules);
    const adminMenus = shaped.adminMenus || [];

    return {
      ...shaped,
      adminMenus,
      adminMenuGroups: this.groupAdminMenus(adminMenus),
      summaryCards: permittedSummaryCards,
      summaryMetricCards: permittedSummaryCards.filter((item) => !item.isAction),
      quickActionCards: permittedSummaryCards.filter((item) => item.isAction),
      todoItems,
      productActions,
      showProductSection: productActions.length > 0,
      showTodoItems: todoItems.length > 0,
      showSalesTrend: canSales,
      showTopSellingProducts: canSales && canProduct,
      showInventorySections: canInventory,
      showCustomerAccountInsights: canCustomerAccount,
      salesTrend: canSales ? shaped.salesTrend : [],
      topSellingProducts: canSales && canProduct ? shaped.topSellingProducts : [],
      slowMovingProducts: canInventory ? shaped.slowMovingProducts : [],
      lowStockProducts: canInventory ? shaped.lowStockProducts : [],
      unpaidCustomers: canCustomerAccount ? shaped.unpaidCustomers : []
    };
  },

  card(label, value, unit, url, isMoney = false, warning = false, permissions = []) {
    const number = Number(value || 0);
    return {
      label,
      valueText: isMoney ? this.money(number) : this.integer(number),
      unit,
      url,
      isMoney,
      warning: warning && number > 0,
      permissions
    };
  },

  actionCard(label, valueText, url, permissions = []) {
    return {
      label,
      valueText,
      unit: "",
      url,
      warning: false,
      isAction: true,
      permissions
    };
  },

  todo(label, value, unit, url, hint, warning = false, permissions = []) {
    const number = Number(value || 0);
    return {
      label,
      valueText: this.integer(number),
      unit,
      url,
      hint,
      warning: warning && number > 0,
      permissions
    };
  },

  todoAction(label, valueText, url, hint, permissions = []) {
    return {
      label,
      valueText,
      unit: "",
      url,
      hint,
      warning: false,
      isAction: true,
      permissions
    };
  },

  productAction(label, hint, url, type = "", permissions = []) {
    return { label, hint, url, type, permissions };
  },

  rangeLabel(value) {
    const option = RANGE_OPTIONS.find((item) => item.value === value);
    return option ? option.label : "今日";
  },

  orderRangeUrl(value) {
    const dateMap = {
      today: "today",
      "3d": "last3days",
      "7d": "last7days",
      "30d": "last30days"
    };
    return `/pages/admin/orders?date=${dateMap[value] || "today"}`;
  },

  integer(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return "0";
    return String(Math.round(number));
  },

  money(cents) {
    const number = Number(cents || 0);
    return `￥${(number / 100).toFixed(2)}`;
  },

  maskUserIdentifier(value) {
    const text = String(value || "").trim();
    if (!text) return "无用户 ID";
    if (text.length <= 8) return `${text.slice(0, 2)}****`;
    return `${text.slice(0, 4)}****${text.slice(-4)}`;
  },

  summarizeRemark(value) {
    const text = String(value || "").trim().replace(/\s+/g, " ");
    if (!text) return "";
    return text.length > 18 ? `${text.slice(0, 18)}...` : text;
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
