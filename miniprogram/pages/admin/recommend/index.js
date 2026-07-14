const { call, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");

Page({
  data: {
    sections: [],
    loading: false,
    savingKey: "",
    displayTypes: [
      { value: "horizontal", label: "横向滑动" },
      { value: "grid", label: "网格" }
    ]
  },

  onLoad() {
    ensureAdmin("home_recommend:view").then(() => this.load()).catch((err) => toast(err.message));
  },

  load() {
    this.setData({ loading: true });
    return call("getAdminRecommendSections", {}, { showLoading: false })
      .then((data) => {
        const sections = (data.sections || []).map((item) => ({
          ...item,
          maxItemsInput: String(item.maxItems || 8),
          sortIndexInput: String(item.sortIndex || 1),
          displayTypeIndex: item.displayType === "grid" ? 1 : 0
        }));
        this.setData({ sections });
      })
      .catch((err) => toast(err.message))
      .finally(() => this.setData({ loading: false }));
  },

  onFieldInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const key = e.currentTarget.dataset.key;
    this.setData({ [`sections[${index}].${key}`]: e.detail.value });
  },

  onEnabledChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const section = this.data.sections[index];
    const fn = e.detail.value ? "enableRecommendSection" : "disableRecommendSection";
    this.setData({ savingKey: section.sectionKey });
    call(fn, { sectionKey: section.sectionKey }, { showLoading: false })
      .then(() => {
        toast(e.detail.value ? "已启用" : "已停用");
        this.load();
      })
      .catch((err) => toast(err.message))
      .finally(() => this.setData({ savingKey: "" }));
  },

  onDisplayTypeChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const displayTypeIndex = Number(e.detail.value);
    this.setData({
      [`sections[${index}].displayTypeIndex`]: displayTypeIndex,
      [`sections[${index}].displayType`]: this.data.displayTypes[displayTypeIndex].value
    });
  },

  saveSection(e) {
    const index = Number(e.currentTarget.dataset.index);
    const section = this.data.sections[index];
    if (!section) return;
    this.setData({ savingKey: section.sectionKey });
    call("updateRecommendSection", {
      sectionKey: section.sectionKey,
      sectionTitle: section.sectionTitle,
      subtitle: section.subtitle,
      enabled: section.enabled,
      sortIndex: section.sortIndexInput,
      maxItems: section.maxItemsInput,
      displayType: section.displayType
    }, { showLoading: false })
      .then(() => {
        toast("已保存");
        this.load();
      })
      .catch((err) => toast(err.message))
      .finally(() => this.setData({ savingKey: "" }));
  },

  sortByCurrentInputs() {
    const sections = this.data.sections.map((item) => ({
      sectionKey: item.sectionKey,
      sortIndex: item.sortIndexInput
    }));
    call("sortRecommendSections", { sections }, { showLoading: false })
      .then(() => {
        toast("排序已保存");
        this.load();
      })
      .catch((err) => toast(err.message));
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  }
});
