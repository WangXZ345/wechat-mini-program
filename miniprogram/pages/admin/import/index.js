const { initOrientation, cleanupOrientation } = require("../../../utils/orientation");
const { call, toast } = require("../../../utils/api");
const { ensureAdmin } = require("../../../utils/auth");
const {
  parseFileBuffer,
  normalizeInventoryRows,
  normalizePriceRows
} = require("../../../utils/importParser");
const { mergeInventoryAndPriceRows } = require("../../../utils/mergedImportClient");
const haptics = require("../../../utils/haptics");

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    file: null,
    priceFile: null,
    parsing: false,
    parseMessage: "",
    stockMode: "override",
    priceMode: "override",
    stockModeOptions: [
      { value: "override", label: "覆盖库存" },
      { value: "add", label: "增加库存" }
    ],
    priceModeOptions: [
      { value: "override", label: "覆盖价格" },
      { value: "only_new", label: "只给新商品写入价格" },
      { value: "skip", label: "不修改价格" }
    ]
  },

  onLoad() {
    initOrientation(this);
    ensureAdmin("inventory:import").catch((err) => toast(err.message));
  },

  chooseFile() {
    haptics.medium();
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["xlsx", "csv", "txt"],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (file) this.setData({ file });
      },
      fail: () => toast("选择文件失败")
    });
  },

  choosePriceFile() {
    haptics.medium();
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["xlsx", "csv", "txt", "docx"],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (file) this.setData({ priceFile: file });
      },
      fail: () => toast("选择报价表失败")
    });
  },

  onStockModeChange(e) {
    const index = Number(e.detail.value);
    this.setData({ stockMode: this.data.stockModeOptions[index].value });
  },

  onPriceModeChange(e) {
    const index = Number(e.detail.value);
    this.setData({ priceMode: this.data.priceModeOptions[index].value });
  },

  getFileExtension(fileName = "") {
    const match = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "xlsx";
  },

  buildCloudPath(fileName = "") {
    const extension = this.getFileExtension(fileName);
    const random = Math.random().toString(36).slice(2, 8);
    return `inventory-import/${Date.now()}-${random}.${extension}`;
  },

  uploadWithRetry(options, retries = 2) {
    return wx.cloud.uploadFile(options).catch((err) => {
      if (retries <= 0) throw err;
      return new Promise((resolve) => setTimeout(resolve, 800))
        .then(() => this.uploadWithRetry(options, retries - 1));
    });
  },

  readLocalFile(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        success: (res) => resolve(res.data),
        fail: reject
      });
    });
  },

  buildPreviewItem(item, index) {
    const copy = { ...item, rowNo: item.rowNo || index + 1 };
    if (!copy.candidates || !copy.candidates.length) delete copy.candidates;
    return copy;
  },

  savePreviewCache(importRecordId, payload) {
    const key = `mergedImportPreview:${importRecordId}`;
    try {
      const app = getApp();
      app.globalData = app.globalData || {};
      app.globalData[key] = payload;
    } catch (err) {}
    try {
      wx.setStorageSync(key, payload);
    } catch (err) {}
  },

  parseFile() {
    if (this.data.parsing) return;
    const file = this.data.file;
    if (!file) {
      toast("请先选择库存表");
      return;
    }
    const priceFile = this.data.priceFile;
    if (!priceFile) {
      toast("请先选择报价表");
      return;
    }

    this.setData({ parsing: true, parseMessage: "正在读取并解析文件" });
    wx.showLoading({ title: "解析中", mask: true });
    const inventoryFileName = file.name || "inventory.xlsx";
    const priceFileName = priceFile.name || "price.docx";

    Promise.all([
      this.readLocalFile(file.path),
      this.readLocalFile(priceFile.path)
    ])
      .then(async ([inventoryBuffer, priceBuffer]) => {
        const inventoryParsed = await parseFileBuffer(inventoryBuffer, inventoryFileName, "inventory");
        const priceParsed = await parseFileBuffer(priceBuffer, priceFileName, "price");
        const inventoryRows = normalizeInventoryRows(inventoryParsed);
        const priceRows = normalizePriceRows(priceParsed);
        const items = mergeInventoryAndPriceRows(inventoryRows, priceRows)
          .map((item, index) => this.buildPreviewItem(item, index));
        const failedRows = items.filter((item) => item.action === "error").length;
        const skippedRows = items.filter((item) => item.action === "ignore" || item.selected === false).length;
        return {
          importRecordId: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          inventoryFileName,
          priceFileName,
          inventoryFileType: inventoryParsed.fileType,
          priceFileType: priceParsed.fileType,
          totalInventoryRows: inventoryRows.length,
          totalPriceRows: priceRows.length,
          mergedRows: items.length,
          failedRows,
          skippedRows,
          clientPreviewMode: true,
          pureClientPreview: true,
          items
        };
      })
      .then((data) => {
        if (!data.importRecordId) {
          toast("解析完成但没有生成导入记录，请重试。");
          return;
        }
        if (data.items && data.items.length) {
          this.savePreviewCache(data.importRecordId, {
            record: data,
            items: data.items,
            stockMode: this.data.stockMode,
            priceMode: this.data.priceMode,
            savedAt: Date.now()
          });
        }
        this.setData({ parseMessage: `解析完成，预览 ${data.mergedRows || 0} 行` });
        const url = `/pages/admin/import/preview/index?importRecordId=${data.importRecordId}&stockMode=${this.data.stockMode}&priceMode=${this.data.priceMode}`;
        wx.navigateTo({
          url,
          fail: () => wx.redirectTo({ url })
        });
      })
      .catch((err) => {
        const message = err.message || "";
        if (/socket|network|TLS|uploadFile|SignatureDoesNotMatch|status\s*403/i.test(message)) {
          toast("上传到云存储失败，请重试或换一个简单文件名。");
          return;
        }
        this.setData({ parseMessage: message || "解析失败" });
        toast(message || "解析失败");
      })
      .finally(() => {
        this.setData({ parsing: false });
        wx.hideLoading();
      });
  },

  goHistory() {
    wx.navigateTo({ url: "/pages/admin/import/history/index" });
  },

  onUnload() {
    cleanupOrientation(this);
  }
});

