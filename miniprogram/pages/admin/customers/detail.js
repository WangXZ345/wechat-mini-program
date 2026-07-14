const { call, moneyText, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");
const { ORDER_STATUS_TEXT, PAYMENT_STATUS_TEXT } = require("../../../utils/status");

const RISK_OPTIONS = [
  { label: "正常", value: "normal" },
  { label: "重要客户", value: "important" },
  { label: "付款慢", value: "slow_pay" },
  { label: "风险客户", value: "risk" },
  { label: "限制下单", value: "blocked" }
];

const PRESET_TAGS = ["老客户", "大客户", "付款慢", "优先发货", "需要顺丰", "需要人工确认", "价格敏感", "风险客户"];

Page({
  data: {
    userId: "",
    user: {},
    account: {},
    orders: [],
    noteLogs: [],
    phoneLogs: [],
    adminNote: "",
    tagInput: "",
    adminTags: [],
    riskOptions: RISK_OPTIONS,
    riskIndex: 0,
    selectedRiskLabel: RISK_OPTIONS[0].label,
    presetTags: PRESET_TAGS,
    saving: false
  },

  onLoad(options) {
    this.setData({ userId: options.userId || "" });
    ensureAdmin("customer:view_basic").then((profile) => {
      if (profile.role === "finance") throw new Error("无权限访问客户管理");
      return this.load();
    }).catch((err) => toast(err.message));
  },

  formatDate(value) {
    if (!value) return "暂无";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "暂无";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  },

  load() {
    return call("getAdminCustomerDetail", { userId: this.data.userId }).then((data) => {
      const account = data.account || {};
      const riskIndex = Math.max(0, RISK_OPTIONS.findIndex((item) => item.value === (account.riskLevel || "normal")));
      const orders = (data.orders || []).map((order) => ({
        ...order,
        statusText: ORDER_STATUS_TEXT[order.status] || order.status,
        paymentText: PAYMENT_STATUS_TEXT[order.paymentStatus] || order.paymentStatus || "未提交",
        totalText: moneyText(order.totalAmount),
        createdAtText: this.formatDate(order.createdAt)
      }));
      const noteLogs = (data.noteLogs || []).map((log) => ({
        ...log,
        createdAtText: this.formatDate(log.createdAt),
        afterTagsText: Array.isArray(log.afterTags) && log.afterTags.length ? log.afterTags.join("、") : "无"
      }));
      const phoneLogs = (data.phoneLogs || []).map((log) => ({
        ...log,
        createdAtText: this.formatDate(log.createdAt),
        verifiedText: log.afterPhoneVerified ? "已验证" : "未验证"
      }));
      this.setData({
        user: data.user || {},
        account: {
          ...account,
          todayText: moneyText(account.todayOrderAmount),
          totalText: moneyText(account.totalReceivableAmount || account.totalOrderAmount),
          paidText: moneyText(account.paidAmount || account.totalPaidAmount),
          unpaidText: moneyText(account.unpaidAmount || account.totalUnpaidAmount),
          historyUnpaidText: moneyText(account.historyUnpaidAmount)
        },
        orders,
        noteLogs,
        phoneLogs,
        adminNote: account.adminNote || account.adminRemark || "",
        adminTags: account.adminTags || [],
        tagInput: (account.adminTags || []).join("，"),
        riskIndex,
        selectedRiskLabel: RISK_OPTIONS[riskIndex].label
      });
    }).catch((err) => toast(err.message));
  },

  onNoteInput(e) {
    this.setData({ adminNote: e.detail.value || "" });
  },

  onTagInput(e) {
    const tagInput = e.detail.value || "";
    this.setData({ tagInput, adminTags: this.parseTags(tagInput) });
  },

  parseTags(text) {
    return Array.from(new Set(String(text || "").split(/[,\n，、]/).map((item) => item.trim()).filter(Boolean)));
  },

  addPresetTag(e) {
    const tag = e.currentTarget.dataset.tag;
    const tags = Array.from(new Set([...(this.data.adminTags || []), tag]));
    this.setData({ adminTags: tags, tagInput: tags.join("，") });
  },

  removeTag(e) {
    const tag = e.currentTarget.dataset.tag;
    const tags = (this.data.adminTags || []).filter((item) => item !== tag);
    this.setData({ adminTags: tags, tagInput: tags.join("，") });
  },

  onRiskChange(e) {
    const riskIndex = Number(e.detail.value);
    this.setData({ riskIndex, selectedRiskLabel: RISK_OPTIONS[riskIndex].label });
  },

  save() {
    if (this.data.saving) return;
    const adminNote = String(this.data.adminNote || "").trim();
    const adminTags = this.parseTags(this.data.tagInput);
    const riskLevel = (this.data.riskOptions[this.data.riskIndex] || this.data.riskOptions[0]).value;
    if (adminNote.length > 1000) return toast("客户备注最多 1000 字");
    if (adminTags.length > 20) return toast("客户标签最多 20 个");
    if (adminTags.some((tag) => tag.length > 10)) return toast("单个标签最多 10 字");
    this.setData({ saving: true });
    call("updateCustomerAdminNote", {
      userId: this.data.userId,
      adminNote,
      adminTags,
      riskLevel
    }).then((data) => {
      toast(data.unchanged ? "未修改" : "备注已保存");
      this.load();
    }).catch((err) => toast(err.message))
      .finally(() => this.setData({ saving: false }));
  },

  clearNote() {
    if (!String(this.data.adminNote || "").trim()) return toast("暂无备注可清空");
    wx.showModal({
      title: "清空备注",
      content: "确定清空该客户的后台备注吗？",
      confirmText: "清空",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ adminNote: "" }, () => this.save());
      }
    });
  }
});
