const { initOrientation, cleanupOrientation } = require("../../../../utils/orientation");
const { call, moneyText, feedback } = require("../../../../utils/api");
const { ensureAdmin } = require("../../../../utils/auth");
const { REFUND_STATUS_TEXT } = require("../../../../utils/status");

const STATUS_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "待退款", value: "pending" },
  { label: "处理中", value: "processing" },
  { label: "已退款", value: "refunded" },
  { label: "退款失败", value: "failed" },
  { label: "已拒绝", value: "rejected" },
  { label: "已取消", value: "cancelled" }
];

function formatDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    loading: false,
    exporting: false,
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    keyword: "",
    refunds: [],
    exportResult: null
  },

  onLoad() {
    initOrientation(this);
    ensureAdmin("refund:view").then(() => this.load()).catch((err) => feedback.showError(err.message));
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  onStatusChange(e) {
    this.setData({ statusIndex: Number(e.detail.value || 0) }, () => this.load());
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  load() {
    const status = this.data.statusOptions[this.data.statusIndex] || STATUS_OPTIONS[0];
    this.setData({ loading: !this.data.refunds.length });
    return call("getAdminRefunds", {
      status: status.value,
      keyword: this.data.keyword.trim()
    }, { showLoading: false }).then((data) => {
      const rows = (data.refunds || []).map((item) => ({
        ...item,
        refundText: REFUND_STATUS_TEXT[item.refundStatus] || item.refundStatus,
        amountText: moneyText(item.refundAmount),
        createdAtText: formatDate(item.createdAt),
        confirmedAtText: formatDate(item.confirmedAt)
      }));
      this.setData({ refunds: rows });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ loading: false }));
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/admin/refunds/detail/index?id=${e.currentTarget.dataset.id}` });
  },

  exportExcel() {
    if (this.data.exporting) return;
    this.setData({ exporting: true, exportResult: null });
    call("exportAfterSalesExcel", { exportType: "refunds" }, { loadingText: "生成 Excel" })
      .then((data) => {
        this.setData({ exportResult: data });
        feedback.showSuccess("导出成功");
      })
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ exporting: false }));
  },

  copyExportLink() {
    const url = this.data.exportResult && this.data.exportResult.fileUrl;
    if (!url) return feedback.showWarning("暂无导出链接");
    wx.setClipboardData({ data: url });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
