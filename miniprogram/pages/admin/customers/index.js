const { call, moneyText, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");

const PAGE_SIZE = 20;

const RISK_TEXT = {
  normal: "正常",
  important: "重要客户",
  slow_pay: "付款慢",
  risk: "风险客户",
  blocked: "限制下单"
};

Page({
  data: {
    accounts: [],
    keyword: "",
    page: 1,
    pageSize: PAGE_SIZE,
    hasMore: false,
    loading: false,
    loadingMore: false
  },

  onLoad() {
    ensureAdmin("customer:view_basic").then((profile) => {
      if (profile.role === "finance") throw new Error("无权限访问客户管理");
      return this.load();
    }).catch((err) => toast(err.message));
  },

  onShow() {
    if (this.data.accounts.length) return;
    this.load({ reset: true });
  },

  shortNote(note) {
    const text = String(note || "").trim();
    return text.length > 20 ? `${text.slice(0, 20)}...` : text;
  },

  shapeAccounts(accounts = []) {
    return accounts.map((item) => ({
        ...item,
        riskText: RISK_TEXT[item.riskLevel] || RISK_TEXT.normal,
        hasAdminNote: Boolean(String(item.adminNote || item.adminRemark || "").trim()),
        adminNoteSummary: this.shortNote(item.adminNote || item.adminRemark),
        todayText: moneyText(item.todayOrderAmount),
        historyUnpaidText: moneyText(item.historyUnpaidAmount),
        unpaidText: moneyText(item.totalUnpaidAmount !== undefined ? item.totalUnpaidAmount : item.unpaidAmount),
        tagsText: (item.adminTags || []).join("、")
      }));
  },

  load(options = {}) {
    const reset = options.reset !== false;
    if (this.customerLoading) return this.customerLoading;
    if (!reset && !this.data.hasMore) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    this.setData(reset ? { loading: true } : { loadingMore: true });
    this.customerLoading = call("getAccountSummary", {
      admin: true,
      keyword: this.data.keyword,
      page,
      pageSize: PAGE_SIZE,
      limit: PAGE_SIZE
    }, { showLoading: false }).then((data) => {
      const nextAccounts = this.shapeAccounts(data.accounts || []);
      this.setData({
        accounts: reset ? nextAccounts : this.data.accounts.concat(nextAccounts),
        page,
        hasMore: Boolean(data.hasMore || nextAccounts.length >= PAGE_SIZE)
      });
    }).catch((err) => toast(err.message))
      .finally(() => {
        this.customerLoading = null;
        this.setData({ loading: false, loadingMore: false });
      });
    return this.customerLoading;
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  searchNow() {
    this.load({ reset: true });
  },

  onReachBottom() {
    this.load({ reset: false });
  },

  openDetail(e) {
    wx.navigateTo({ url: `/pages/admin/customers/detail?userId=${e.currentTarget.dataset.id}` });
  }
});
