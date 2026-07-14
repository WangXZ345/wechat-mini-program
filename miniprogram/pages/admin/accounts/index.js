const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const { call, moneyText, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");

const FILTERS = [
  { label: "全部客户", value: "all" },
  { label: "有未付款", value: "unpaid" },
  { label: "今日有下单", value: "today" },
  { label: "待确认付款", value: "pending" },
  { label: "付款异常", value: "abnormal" },
  { label: "风险客户", value: "risk" },
  { label: "已结清", value: "settled" }
];

const SORTS = [
  { label: "未付金额高到低", value: "unpaid" },
  { label: "今日新增高到低", value: "today" },
  { label: "最近下单", value: "lastOrder" },
  { label: "最近付款", value: "lastPayment" },
  { label: "异常次数", value: "abnormal" }
];

const RISK_TEXT = {
  normal: "正常",
  watch: "关注",
  risky: "风险",
  blocked: "禁止下单"
};

function dateText(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function normalizeAccount(item) {
  const totalOrderAmount = item.totalOrderAmount !== undefined ? item.totalOrderAmount : item.totalReceivableAmount;
  const totalPaidAmount = item.totalPaidAmount !== undefined ? item.totalPaidAmount : item.paidAmount;
  const totalUnpaidAmount = item.totalUnpaidAmount !== undefined ? item.totalUnpaidAmount : item.unpaidAmount;
  return {
    ...item,
    title: item.nickname || item.phoneDisplay || item.phoneMasked || item.userOpenid || item.userId || "未命名客户",
    totalOrderText: moneyText(totalOrderAmount),
    totalPaidText: moneyText(totalPaidAmount),
    totalUnpaidText: moneyText(totalUnpaidAmount),
    todayText: moneyText(item.todayOrderAmount),
    historyText: moneyText(item.historyUnpaidAmount),
    pendingText: moneyText(item.pendingConfirmAmount),
    riskText: RISK_TEXT[item.riskLevel || "normal"] || item.riskLevel,
    settledText: item.isSettled ? "已结清" : "未结清",
    lastOrderText: dateText(item.lastOrderAt),
    lastPaymentText: dateText(item.lastPaymentAt)
  };
}

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    filters: FILTERS,
    sorts: SORTS,
    filterIndex: 0,
    sortIndex: 0,
    selectedFilterLabel: FILTERS[0].label,
    selectedSortLabel: SORTS[0].label,
    keyword: "",
    accounts: [],
    loading: false,
    initialized: false
  },

  onLoad() {
    initOrientation(this);
    ensureAdmin("customer:view_account").then(() => this.load()).catch((err) => toast(err.message));
  },

  onShow() {
    if (!this.data.initialized) return;
    if (Date.now() - Number(this.accountLastFetchAt || 0) > 30000) {
      this.load({ silent: true });
    }
  },

  load(options = {}) {
    if (this.accountLoading && !options.force) return this.accountLoading;
    const filter = FILTERS[this.data.filterIndex].value;
    const sortBy = SORTS[this.data.sortIndex].value;
    const params = {
      filter,
      sortBy,
      keyword: this.data.keyword.trim()
    };
    this.setData({ loading: !options.silent });
    this.accountLoading = call("adminListCustomerAccounts", params, { showLoading: false }).catch((err) => {
      const message = err && err.message ? err.message : "";
      if (!/FunctionName|FUNCTION_NOT_FOUND|could not be found/i.test(message)) throw err;
      return call("getAccountSummary", { admin: true, ...params }, { showLoading: false });
    }).then((data) => {
      this.accountLastFetchAt = Date.now();
      this.setData({
        accounts: (data.accounts || []).map(normalizeAccount),
        initialized: true
      });
    }).catch((err) => toast(err.message))
      .finally(() => {
        this.accountLoading = null;
        this.setData({ loading: false });
      });
    return this.accountLoading;
  },

  onFilterChange(e) {
    const index = Number(e.detail.value);
    this.setData({
      filterIndex: index,
      selectedFilterLabel: FILTERS[index].label
    }, () => this.load());
  },

  onSortChange(e) {
    const index = Number(e.detail.value);
    this.setData({
      sortIndex: index,
      selectedSortLabel: SORTS[index].label
    }, () => this.load());
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  search() {
    this.load();
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/admin/accounts/detail?id=${e.currentTarget.dataset.id}` });
  },

  recalc(e) {
    const item = this.data.accounts.find((account) => account._id === e.currentTarget.dataset.id);
    if (!item) return;
    call("recalculateCustomerAccount", {
      userId: item.userId,
      userOpenid: item.userOpenid
    }).then(() => {
      toast("已重算");
      this.load();
    }).catch((err) => toast(err.message));
  },

  markRisk(e) {
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ["正常", "关注", "风险", "禁止下单"],
      success: (res) => {
        const value = ["normal", "watch", "risky", "blocked"][res.tapIndex];
        call("updateCustomerRiskLevel", { accountId: id, riskLevel: value }).then(() => {
          toast("已更新");
          this.load();
        }).catch((err) => toast(err.message));
      }
    });
  },

  markSettled(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "标记为已结清",
      content: "请填写结清备注",
      editable: true,
      placeholderText: "例如：线下对账已结清",
      success: (res) => {
        if (!res.confirm) return;
        call("markCustomerSettled", { accountId: id, remark: res.content || "" }).then(() => {
          toast("已结清");
          this.load();
        }).catch((err) => toast(err.message));
      }
    });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
