const { call, toast } = require("../../utils/api");
const { ensureAdmin, profileHasAnyPermission } = require("../../utils/auth");
const { isFullAccessRole } = require("../../utils/role");
const haptics = require("../../utils/haptics");

const MENU_DEFS = [
  { text: "订单管理", url: "/pages/admin/orders", permissions: ["order:view"], roles: ["customer_service", "finance"] },
  { text: "付款审核", url: "/pages/admin/orders?paymentStatus=pending_confirm", permissions: ["payment:confirm", "dashboard:view_finance"], roles: ["finance"] },
  { text: "客户账款", url: "/pages/admin/accounts/index", permissions: ["customer:view_account", "dashboard:view_finance"], roles: ["finance"] },
  { text: "售后管理", url: "/pages/admin/after-sales/index/index", permissions: ["after_sale:view"], roles: ["customer_service", "finance"] },
  { text: "退款管理", url: "/pages/admin/refunds/index/index", permissions: ["refund:view"], roles: ["finance"] },
  { text: "发货管理", url: "/pages/admin/delivery/index", permissions: ["shipment:ship", "order:ship"], roles: ["customer_service"] },
  { text: "客户管理", url: "/pages/admin/customers/index", permissions: ["customer:view_basic", "customer:edit_remark"], roles: ["customer_service"] },
  { text: "商品管理", url: "/pages/admin/products", permissions: ["product:view"] },
  { text: "商品数据分析", url: "/pages/admin/product-analytics/index", permissions: ["product:analytics:view", "dashboard:view_product"] },
  { text: "库存管理", url: "/pages/admin/inventory", permissions: ["inventory:view"] },
  { text: "库存预警", url: "/pages/admin/stock-alerts/index", permissions: ["inventory:view", "inventory:set_warning"] },
  { text: "库存导入", url: "/pages/admin/import/index", permissions: ["inventory:import"] },
  { text: "未售商品分析", url: "/pages/admin/unsold/index", permissions: ["dashboard:view_inventory", "product:view"] },
  { text: "推荐区管理", url: "/pages/admin/recommend/index", permissions: ["home_recommend:view", "home_recommend:manage"] },
  { text: "支付配置", url: "/pages/admin/payment-methods/index", permissions: ["system:payment_methods", "payment:config", "payment_method:view"], roles: ["finance"] },
  { text: "管理员管理", url: "/pages/admin/admins/index", permissions: ["admin:view"] },
  { text: "业务配置", url: "/pages/admin/settings", permissions: ["system:settings"] }
];
Page({
  data: {
    stats: {},
    stockAlerts: [],
    unsoldSummary: {},
    checkingStockAlerts: false,
    adminProfile: null,
    menuItems: []
  },

  onLoad() {
    ensureAdmin("dashboard:view_basic").then((profile) => {
      this.applyMenu(profile);
      return this.load();
    }).catch((err) => toast(err.message));
  },

  onShow() {
    if (!this.data.adminProfile) return;
    this.load({ silent: Boolean(Object.keys(this.data.stats || {}).length) });
  },

  applyMenu(profile) {
    const menuItems = (isFullAccessRole(profile && profile.role) || profile && profile.showAllAdminMenus)
      ? MENU_DEFS
      : MENU_DEFS.filter((item) => {
        if (item.roles && item.roles.indexOf(profile && profile.role) === -1) return false;
        return profileHasAnyPermission(profile, item.permissions);
      });
    this.setData({ adminProfile: profile, menuItems });
  },

  load(options = {}) {
    if (this.dashboardLoading && !options.force) return this.dashboardLoading;
    this.dashboardLoading = call("adminDashboard", {}, { showLoading: false }).then((data) => {
      const state = { stats: data.stats, stockAlerts: data.stockAlerts || [] };
      this.setData(state);
      return call("getUnsoldProducts", { rangeType: "today", pageSize: 1 })
        .then((unsoldData) => {
          this.setData({ unsoldSummary: unsoldData.summary || {} });
        })
        .catch(() => {
          this.setData({ unsoldSummary: {} });
        });
    }).catch((err) => toast(err.message))
      .finally(() => {
        this.dashboardLoading = null;
      });
    return this.dashboardLoading;
  },

  go(e) {
    haptics.selection();
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  checkStockAlerts() {
    if (this.data.checkingStockAlerts) return;
    this.setData({ checkingStockAlerts: true });
    call("updateStockAlertStatus", { checkAll: true, limit: 10 }).then((data) => {
      const more = data.hasMore ? "，还有商品未检查，可进入库存预警页继续" : "";
      toast(`已检查 ${data.successCount || 0} 个商品${more}`);
      this.load();
    }).catch((err) => toast(err.message))
      .finally(() => this.setData({ checkingStockAlerts: false }));
  },

  onPullDownRefresh() {
    this.load({ silent: false }).finally(() => {
      wx.stopPullDownRefresh();
    });
  }
});
