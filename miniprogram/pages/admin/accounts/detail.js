const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const { call, moneyText, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");
const { ORDER_STATUS_TEXT, PAYMENT_STATUS_TEXT } = require("../../../utils/status");

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
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function accountView(account) {
  return {
    ...account,
    title: account.nickname || account.phoneDisplay || account.phoneMasked || account.userOpenid || account.userId || "未命名客户",
    totalOrderText: moneyText(account.totalOrderAmount || account.totalReceivableAmount),
    totalPaidText: moneyText(account.totalPaidAmount || account.paidAmount),
    totalUnpaidText: moneyText(account.totalUnpaidAmount || account.unpaidAmount),
    todayText: moneyText(account.todayOrderAmount),
    historyText: moneyText(account.historyUnpaidAmount),
    pendingText: moneyText(account.pendingConfirmAmount),
    abnormalText: moneyText(account.abnormalAmount),
    riskText: RISK_TEXT[account.riskLevel || "normal"] || account.riskLevel
  };
}

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    id: "",
    account: null,
    orders: [],
    payments: [],
    logs: [],
    exportResult: null
  },

  onLoad(options) {
    initOrientation(this);
    this.setData({ id: options.id || "" });
    ensureAdmin("customer:view_account").then(() => this.load()).catch((err) => toast(err.message));
  },

  load() {
    return call("adminGetCustomerAccountDetail", { accountId: this.data.id }).then((data) => {
      this.setData({
        account: accountView(data.account),
        orders: data.orders.map((order) => ({
          ...order,
          totalText: moneyText(order.totalAmount),
          paidText: moneyText(order.paidAmount),
          unpaidText: moneyText(order.unpaidAmount),
          statusText: ORDER_STATUS_TEXT[order.status] || order.status,
          paymentText: PAYMENT_STATUS_TEXT[order.paymentStatus] || order.paymentStatus,
          createdText: dateText(order.createdAt)
        })),
        payments: data.paymentRecords.map((row) => ({
          ...row,
          orderText: row.orderId,
          orderAmountText: moneyText(row.orderAmount),
          paidText: moneyText(row.paidAmount),
          unpaidText: moneyText(row.unpaidAmount),
          confirmedText: dateText(row.confirmedAt || row.createdAt)
        })),
        logs: data.accountLogs.map((row) => ({
          ...row,
          createdText: dateText(row.createdAt),
          changeText: moneyText(row.changeAmount)
        }))
      });
    }).catch((err) => toast(err.message));
  },

  updateRemark() {
    wx.showModal({
      title: "管理员备注",
      editable: true,
      placeholderText: "输入备注",
      content: this.data.account.adminRemark || "",
      success: (res) => {
        if (!res.confirm) return;
        call("updateCustomerRemark", {
          accountId: this.data.account._id,
          adminRemark: res.content || ""
        }).then(() => {
          toast("已保存");
          this.load();
        }).catch((err) => toast(err.message));
      }
    });
  },

  updateRisk() {
    wx.showActionSheet({
      itemList: ["正常", "关注", "风险", "禁止下单"],
      success: (res) => {
        const riskLevel = ["normal", "watch", "risky", "blocked"][res.tapIndex];
        call("updateCustomerRiskLevel", { accountId: this.data.account._id, riskLevel }).then(() => {
          toast("已更新");
          this.load();
        }).catch((err) => toast(err.message));
      }
    });
  },

  markSettled() {
    wx.showModal({
      title: "标记为已结清",
      content: "请填写结清备注",
      editable: true,
      placeholderText: "例如：已线下结清",
      success: (res) => {
        if (!res.confirm) return;
        call("markCustomerSettled", {
          accountId: this.data.account._id,
          remark: res.content || ""
        }).then(() => {
          toast("已结清");
          this.load();
        }).catch((err) => toast(err.message));
      }
    });
  },

  recalc() {
    call("recalculateCustomerAccount", {
      userId: this.data.account.userId,
      userOpenid: this.data.account.userOpenid
    }).then(() => {
      toast("已重算");
      this.load();
    }).catch((err) => toast(err.message));
  },

  exportStatement() {
    call("exportCustomerStatement", {
      accountId: this.data.account._id
    }).then((data) => {
      this.setData({ exportResult: data });
      toast("导出成功");
    }).catch((err) => toast(err.message));
  },

  openExportFile() {
    const fileID = this.data.exportResult && this.data.exportResult.fileID;
    if (!fileID) return toast("暂无文件");
    wx.cloud.downloadFile({ fileID })
      .then((res) => wx.openDocument({ filePath: res.tempFilePath, showMenu: true }))
      .catch((err) => toast(err.message || "打开文件失败"));
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
