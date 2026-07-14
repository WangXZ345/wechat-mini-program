const { initOrientation, cleanupOrientation } = require("../../../../utils/orientation");
const { call, toast } = require("../../../../utils/api");
const { getOrCreateSubmitKey, clearSubmitKey } = require("../../../../utils/idempotency");
const { ensureAdmin } = require("../../../../utils/auth");
const haptics = require("../../../../utils/haptics");

const ACTIONS = [
  { value: "update", label: "更新商品" },
  { value: "create", label: "新建商品" },
  { value: "ignore", label: "忽略" },
  { value: "error", label: "错误" }
];
const BATCH_SIZE = 20;
const MAX_RENDER_ITEMS = 120;
const PUBLIC_TAG_NAMES = ["新货", "瑕疵", "热销"];

function splitTags(value = "") {
  return String(value || "")
    .split(/[,，、\s\/;；|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    importRecordId: "",
    stockMode: "override",
    priceMode: "override",
    previewRecord: null,
    emptyMessage: "",
    renderNotice: "",
    items: [],
    actions: ACTIONS,
    importing: false,
    importProgress: "",
    previewSummary: {
      total: 0,
      selected: 0,
      skipped: 0
    }
  },

  onLoad(query) {
    initOrientation(this);
    this.setData({
      importRecordId: query.importRecordId || "",
      stockMode: query.stockMode || "override",
      priceMode: query.priceMode || "override"
    });
    ensureAdmin("inventory:import").then(() => this.load()).catch((err) => toast(err.message));
  },

  load() {
    if (!this.data.importRecordId) return this.loadLatestPreview();
    const cached = this.getCachedPreview();
    if (cached && cached.items && cached.items.length) {
      this.setData({
        stockMode: cached.stockMode || this.data.stockMode,
        priceMode: cached.priceMode || this.data.priceMode,
        previewRecord: cached.record || null
      });
      this.setItems(cached.items);
      return Promise.resolve();
    }
    return call("getImportDetail", { importRecordId: this.data.importRecordId })
      .then((data) => this.setItemsWithFallback(data.items || []))
      .catch((err) => toast(err.message));
  },

  getCachedPreview() {
    if (!this.data.importRecordId) return null;
    const key = `mergedImportPreview:${this.data.importRecordId}`;
    try {
      const app = getApp();
      const memoryCache = app.globalData && app.globalData[key];
      if (memoryCache) return memoryCache;
    } catch (err) {}
    try {
      return wx.getStorageSync(key);
    } catch (err) {
      return null;
    }
  },

  loadLatestPreview() {
    return call("getImportHistory")
      .then((data) => {
        const records = data.records || [];
        const record = records.find((item) => item.status === "parsed")
          || records.find((item) => item.status === "importing");
        if (!record) {
          toast("请先从库存导入页解析文件");
          wx.redirectTo({ url: "/pages/admin/import/index" });
          return null;
        }
        this.setData({
          importRecordId: record._id,
          stockMode: record.stockMode || this.data.stockMode,
          priceMode: record.priceMode || this.data.priceMode
        });
        return this.load();
      })
      .catch((err) => toast(err.message));
  },

  setItems(items) {
    const decorated = items.map((item) => this.decorateItem(item));
    this.allItems = decorated;
    const visibleItems = decorated.slice(0, MAX_RENDER_ITEMS);
    this.setData({
      items: visibleItems,
      emptyMessage: "",
      renderNotice: decorated.length > visibleItems.length
        ? `已解析 ${decorated.length} 行，为保证页面流畅仅展示前 ${visibleItems.length} 行；确认导入会按全部解析结果执行。`
        : "",
      previewSummary: this.summarizeItems(decorated)
    });
  },

  setItemsWithFallback(items) {
    this.setItems(items);
    if (!items.length) this.setData({ emptyMessage: "当前没有可预览的商品行，请返回重新选择库存表和报价表。" });
  },

  summarizeItems(items) {
    const total = items.length;
    const selected = items.filter((item) => item.selected !== false && item.action !== "ignore" && item.action !== "error").length;
    return {
      total,
      selected,
      skipped: total - selected
    };
  },

  decorateItem(item) {
    const actionIndex = Math.max(0, ACTIONS.findIndex((action) => action.value === item.action));
    const selected = item.selected !== false && item.action !== "error" && item.action !== "ignore";
    return {
      ...item,
      id: item._id || item.id || "",
      actionIndex,
      actionLabel: ACTIONS[actionIndex].label,
      selected
    };
  },

  onFieldInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const key = e.currentTarget.dataset.key;
    if (this.allItems && this.allItems[index]) {
      this.allItems[index][key] = e.detail.value;
    }
    this.setData({ [`items[${index}].${key}`]: e.detail.value });
  },

  onSelectedChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    items[index] = { ...items[index], selected: e.detail.value.length > 0 };
    if (this.allItems && this.allItems[index]) {
      this.allItems[index] = { ...this.allItems[index], selected: items[index].selected };
    }
    this.setData({
      [`items[${index}]`]: items[index],
      previewSummary: this.summarizeItems(this.allItems || items)
    });
  },

  onActionChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const actionIndex = Number(e.detail.value);
    const items = this.data.items.slice();
    items[index] = {
      ...items[index],
      actionIndex,
      action: ACTIONS[actionIndex].value,
      actionLabel: ACTIONS[actionIndex].label
    };
    if (this.allItems && this.allItems[index]) {
      this.allItems[index] = { ...this.allItems[index], ...items[index] };
    }
    this.setData({
      [`items[${index}]`]: items[index],
      previewSummary: this.summarizeItems(this.allItems || items)
    });
  },

  buildItems() {
    const sourceItems = this.allItems && this.allItems.length ? this.allItems : this.data.items;
    return sourceItems.map((item, index) => {
      const tags = splitTags(item.tagsText || (Array.isArray(item.tags) ? item.tags.join(" ") : item.tags || ""))
        .filter((tag) => PUBLIC_TAG_NAMES.includes(tag));
      return {
        rowNo: item.rowNo || index + 1,
        _id: item._id || item.id || "",
        rawInventoryName: item.rawInventoryName,
        rawPriceName: item.rawPriceName,
        finalName: item.finalName,
        baseName: item.finalName || item.baseName,
        brand: item.brand,
        category: item.category,
        specification: item.specification,
        productionDate: item.productionDate,
        stock: Number(item.stock),
        price: item.price === "" || item.price === null || item.price === undefined ? null : Number(item.price),
        productIndex: item.productIndex || "",
        skuCode: item.skuCode || "",
        tags,
        internalTags: splitTags(item.internalTagsText || (Array.isArray(item.internalTags) ? item.internalTags.join(" ") : item.internalTags || "")),
        isNew: item.isNew === true || tags.includes("新货"),
        isDefective: item.isDefective === true || tags.includes("瑕疵"),
        isHot: item.isHot === true || tags.includes("热销"),
        isFrequent: false,
        defectDescription: item.defectDescription || "",
        matchedProductId: item.matchedProductId,
        action: item.action,
        selected: item.selected,
        errorMessage: item.errorMessage || "",
        warningMessage: item.warningMessage || ""
      };
    });
  },

  splitBatches(items) {
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      batches.push(items.slice(i, i + BATCH_SIZE));
    }
    return batches;
  },

  runImportBatches(items) {
    const batches = this.splitBatches(items);
    const total = { successRows: 0, failedRows: 0, skippedRows: 0 };
    let chain = Promise.resolve();
    const submitKey = getOrCreateSubmitKey(`confirm_import_${this.data.importRecordId}`);

    batches.forEach((batch, index) => {
      chain = chain.then(() => {
        this.setData({
          importProgress: `正在导入 ${index + 1}/${batches.length}，已成功 ${total.successRows}，失败 ${total.failedRows}，跳过 ${total.skippedRows}`
        });
        return call("confirmMergedInventoryImport", {
          importRecordId: this.data.importRecordId,
          stockMode: this.data.stockMode,
          priceMode: this.data.priceMode,
          previewRecord: index === 0 ? this.data.previewRecord : null,
          items: batch,
          isFirstBatch: index === 0,
          isFinalBatch: index === batches.length - 1,
          idempotencyKey: `${submitKey}:${index}`
        }, { showLoading: false }).then((data) => {
          if (index === 0 && data.importRecordId && data.importRecordId !== this.data.importRecordId) {
            this.setData({ importRecordId: data.importRecordId });
          }
          total.successRows += Number(data.successRows || 0);
          total.failedRows += Number(data.failedRows || 0);
          total.skippedRows += Number(data.skippedRows || 0);
        });
      });
    });

    return chain.then(() => total);
  },

  confirmImport() {
    if (this.data.importing) return;
    haptics.warning();
    wx.showModal({
      title: "确认导入",
      content: "将写入商品、库存、价格和日志。同一导入记录不能重复提交。",
      success: (res) => {
        if (!res.confirm) return;
        const items = this.buildItems();
        this.setData({ importing: true, importProgress: "准备导入" });
        this.runImportBatches(items).then((data) => {
          clearSubmitKey(`confirm_import_${this.data.importRecordId}`);
          haptics.success();
          this.setData({ importing: false, importProgress: "" });
          try {
            const key = `mergedImportPreview:${this.data.importRecordId}`;
            const app = getApp();
            if (app.globalData) delete app.globalData[key];
            wx.removeStorageSync(key);
          } catch (err) {}
          wx.showModal({
            title: "导入完成",
            content: `成功 ${data.successRows} 行，失败 ${data.failedRows} 行，跳过 ${data.skippedRows || 0} 行`,
            showCancel: false,
            success: () => wx.navigateBack()
          });
        }).catch((err) => {
          if (err.code === "IDEMPOTENCY_KEY_CONFLICT") clearSubmitKey(`confirm_import_${this.data.importRecordId}`);
          haptics.error();
          this.setData({ importing: false });
          toast(err.message || "确认导入失败");
        });
      }
    });
  },

  backToImport() {
    wx.redirectTo({ url: "/pages/admin/import/index" });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});
