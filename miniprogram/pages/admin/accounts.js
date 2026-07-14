const { call, moneyText, toast } = require("../../utils/api");
const { ensureAdmin } = require("../../utils/auth");

Page({
  data: {
    accounts: []
  },

  onLoad() {
    ensureAdmin("customer:view_account").then(() => this.load()).catch((err) => toast(err.message));
  },

  load() {
    return call("getAccountSummary", { admin: true }).then((data) => {
      const accounts = data.accounts.map((item) => ({
        ...item,
        user: item.user || {},
        todayText: moneyText(item.todayOrderAmount),
        totalText: moneyText(item.totalReceivableAmount),
        paidText: moneyText(item.paidAmount),
        unpaidText: moneyText(item.unpaidAmount)
      }));
      this.setData({ accounts });
    }).catch((err) => toast(err.message));
  },

  markPaid(e) {
    call("updateCustomerAccount", {
      accountId: e.currentTarget.dataset.id,
      mark: "paid"
    }).then(() => {
      toast("已更新");
      this.load();
    }).catch((err) => toast(err.message));
  }
});
