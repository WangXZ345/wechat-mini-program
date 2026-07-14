const { call, toast } = require("../../utils/api");
const { ensureAdmin } = require("../../utils/auth");

Page({
  data: {
    text: "",
    pickup: {
      pickupLocation: "",
      pickupTimeNote: "",
      pickupContact: "",
      pickupPhone: "",
      pickupRemark: ""
    },
    mergeSettings: {
      enableMergeShipment: true,
      allowMergeDifferentAddress: false,
      allowPartialPaidShipment: false,
      requirePaidBeforeShipment: true,
      maxOrdersPerMergeShipment: 50,
      maxItemsPerMergeShipment: 500,
      defaultShippingCompany: "",
      allowCancelMergeShipmentBeforeShipped: true
    }
  },

  onLoad() {
    ensureAdmin("system:settings").then(() => this.load()).catch((err) => toast(err.message));
  },

  load() {
    return call("getSettings").then((settings) => {
      const pickup = settings.pickupSettings || {};
      const system = settings.systemSettings || {};
      this.setData({
        text: settings.paymentMethods.join("\n"),
        pickup: {
          pickupLocation: pickup.pickupLocation || "",
          pickupTimeNote: pickup.pickupTimeNote || "",
          pickupContact: pickup.pickupContact || "",
          pickupPhone: pickup.pickupPhone || "",
          pickupRemark: pickup.pickupRemark || ""
        },
        mergeSettings: {
          enableMergeShipment: system.enableMergeShipment !== false,
          allowMergeDifferentAddress: system.allowMergeDifferentAddress === true,
          allowPartialPaidShipment: system.allowPartialPaidShipment === true,
          requirePaidBeforeShipment: system.requirePaidBeforeShipment !== false,
          maxOrdersPerMergeShipment: system.maxOrdersPerMergeShipment || 50,
          maxItemsPerMergeShipment: system.maxItemsPerMergeShipment || 500,
          defaultShippingCompany: system.defaultShippingCompany || "",
          allowCancelMergeShipmentBeforeShipped: system.allowCancelMergeShipmentBeforeShipped !== false
        }
      });
    }).catch((err) => toast(err.message));
  },

  onInput(e) {
    this.setData({ text: e.detail.value });
  },

  onPickupInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`pickup.${field}`]: e.detail.value });
  },

  onMergeInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`mergeSettings.${field}`]: e.detail.value });
  },

  onMergeSwitch(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`mergeSettings.${field}`]: e.detail.value });
  },

  save() {
    const paymentMethods = this.data.text.split("\n").map((item) => item.trim()).filter(Boolean);
    call("updateSettings", { paymentMethods }).then(() => {
      toast("支付配置已保存");
    }).catch((err) => toast(err.message));
  },

  savePickup() {
    const paymentMethods = this.data.text.split("\n").map((item) => item.trim()).filter(Boolean);
    call("updateSettings", {
      paymentMethods,
      pickupSettings: this.data.pickup
    }).then(() => {
      toast("自提配置已保存");
    }).catch((err) => toast(err.message));
  },

  saveMergeSettings() {
    const paymentMethods = this.data.text.split("\n").map((item) => item.trim()).filter(Boolean);
    call("updateSettings", {
      paymentMethods,
      systemSettings: this.data.mergeSettings
    }).then(() => {
      toast("合并发货配置已保存");
      this.load();
    }).catch((err) => toast(err.message));
  }
});
