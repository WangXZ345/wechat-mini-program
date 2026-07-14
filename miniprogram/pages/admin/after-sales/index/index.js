const { initOrientation, cleanupOrientation } = require("../../../../utils/orientation");
const { call, moneyText, feedback } = require("../../../../utils/api");
const { ensureAdmin } = require("../../../../utils/auth");
const { AFTER_SALE_TYPE_TEXT, AFTER_SALE_STATUS_TEXT, REFUND_STATUS_TEXT } = require("../../../../utils/status");

const STATUS_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "待人工审核", value: "pending_review" },
  { label: "已通过", value: "approved" },
  { label: "已拒绝", value: "rejected" },
  { label: "待退货", value: "waiting_return" },
  { label: "客户已退回", value: "returned" },
  { label: "待验货", value: "received" },
  { label: "待退款", value: "refund_pending" },
  { label: "已退款", value: "refunded" },
  { label: "已完成", value: "completed" },
  { label: "异常", value: "abnormal" }
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
    afterSales: [],
    exportResult: null
  },

  onLoad() {
    initOrientation(this);
    ensureAdmin("after_sale:view").then(() => this.load()).catch((err) => feedback.showError(err.message));
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
    this.setData({ loading: !this.data.afterSales.length });
    return call("getAdminAfterSales", {
      status: status.value,
      keyword: this.data.keyword.trim()
    }, { showLoading: false }).then((data) => {
      const rows = (data.afterSales || []).map((item) => ({
        ...item,
        typeText: AFTER_SALE_TYPE_TEXT[item.afterSaleType] || item.afterSaleType,
        statusText: AFTER_SALE_STATUS_TEXT[item.afterSaleStatus] || item.afterSaleStatus,
        refundText: REFUND_STATUS_TEXT[item.refundStatus] || item.refundStatus,
        requestedText: moneyText(item.requestedRefundAmount),
        approvedText: moneyText(item.approvedRefundAmount),
        createdAtText: formatDate(item.createdAt),
        needReview: item.afterSaleStatus === "pending_review",
        highRiskReason: ["quality_issue", "damaged", "defective"].includes(item.afterSaleReason)
      }));
      this.setData({ afterSales: rows });
    }).catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ loading: false }));
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/admin/after-sales/detail/index?id=${e.currentTarget.dataset.id}` });
  },

  goRefunds() {
    wx.navigateTo({ url: "/pages/admin/refunds/index/index" });
  },

  exportExcel() {
    if (this.data.exporting) return;
    this.setData({ exporting: true, exportResult: null });
    call("exportAfterSalesExcel", { exportType: "after_sales" }, { loadingText: "生成 Excel" })
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
