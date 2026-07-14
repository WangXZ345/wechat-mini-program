const { initOrientation, cleanupOrientation } = require("../../utils/orientation");
const { call, toast } = require("../../utils/api");
const { ensureAdmin } = require("../../utils/auth");
const haptics = require("../../utils/haptics");

const CLEAR_CONFIRM_TEXT = "CLEAR_ALL_INVENTORY";
const CLEAR_DELAY_SECONDS = 5;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function confirmModal(options) {
  return new Promise((resolve) => {
    wx.showModal({
      ...options,
      success: (res) => resolve(Boolean(res.confirm)),
      fail: () => resolve(false)
    });
  });
}

Page({
  data: {
    screenWidth: 0,
    screenHeight: 0,
    isLandscape: false,
    isWideScreen: false,
    products: [],
    logs: [],
    loading: true,
    initialized: false,
    canClearInventory: false,
    clearingInventory: false,
    clearCountdown: 0
  },

  onLoad() {
    initOrientation(this);
    ensureAdmin("inventory:view").then((profile) => {
      const canClearInventory = profile.role === "super_admin" ||
        (Array.isArray(profile.permissions) && profile.permissions.includes("inventory:delete_all"));
      this.setData({ canClearInventory });
      return this.load();
    }).catch((err) => {
      this.setData({ loading: false, initialized: true });
      toast(err.message);
    });
  },

  load() {
    if (this.inventoryLoading) return this.inventoryLoading;
    this.setData({ loading: !this.data.initialized });
    this.inventoryLoading = Promise.all([
      call("getProducts", { onlyActive: false }, { showLoading: false }),
      call("getInventoryLogs", {}, { showLoading: false })
    ]).then(([productsData, logsData]) => {
      this.setData({
        products: productsData.products,
        logs: logsData.logs,
        initialized: true
      });
    }).catch((err) => toast(err.message))
      .finally(() => {
        this.inventoryLoading = null;
        this.setData({ loading: false, initialized: true });
      });
    return this.inventoryLoading;
  },

  startClearDelay() {
    clearInterval(this.clearTimer);
    this.setData({ clearCountdown: CLEAR_DELAY_SECONDS });
    this.clearTimer = setInterval(() => {
      const next = Math.max(0, Number(this.data.clearCountdown || 0) - 1);
      this.setData({ clearCountdown: next });
      if (next <= 0) clearInterval(this.clearTimer);
    }, 1000);
    return wait(CLEAR_DELAY_SECONDS * 1000);
  },

  clearAllInventory() {
    if (this.data.clearingInventory) return;
    haptics.warning();
    confirmModal({
      title: "清空当前库存",
      content: "将删除当前所有商品库存数据，并下架这些商品。导入新库存时不会再匹配这些旧商品。是否继续？",
      confirmText: "继续",
      confirmColor: "#9A2D2D"
    }).then((firstConfirmed) => {
      if (!firstConfirmed) return Promise.reject(new Error("cancelled"));
      this.setData({ clearingInventory: true });
      return this.startClearDelay();
    }).then(() => confirmModal({
      title: "再次确认",
      content: "最后确认：删除后当前商品列表会被清空，此操作不能在小程序内撤回。",
      confirmText: "确认删除",
      confirmColor: "#9A2D2D"
    })).then((secondConfirmed) => {
      if (!secondConfirmed) return Promise.reject(new Error("cancelled"));
      return call("manageProduct", {
        action: "clearAllInventory",
        confirmText: CLEAR_CONFIRM_TEXT,
        clientDelaySeconds: CLEAR_DELAY_SECONDS
      });
    }).then((data) => {
      toast(`已清理 ${data.deletedCount || 0} 个商品`);
      this.load();
    }).catch((err) => {
      if (err.message !== "cancelled") toast(err.message);
    }).finally(() => {
      clearInterval(this.clearTimer);
      this.setData({ clearingInventory: false, clearCountdown: 0 });
    });
  },

  onUnload() {
    clearInterval(this.clearTimer);
    cleanupOrientation(this);
  }
});
