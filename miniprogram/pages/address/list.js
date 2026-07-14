const { call, feedback, toast } = require("../../utils/api");
const { ensureFrontendAccess, ensureLogin } = require("../../utils/auth");

function addressSummary(address = {}) {
  return [address.regionText, address.detailAddress].filter(Boolean).join(" ");
}

function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (/^1[3-9]\d{9}$/.test(digits)) {
    return `${digits.slice(0, 3)}****${digits.slice(7)}`;
  }
  return String(phone || "");
}

Page({
  data: {
    addresses: [],
    loading: false,
    selectMode: false
  },

  onLoad(options = {}) {
    this.setData({ selectMode: options.select === "1" });
    ensureLogin()
      .then(() => ensureFrontendAccess())
      .then(() => this.load())
      .catch((err) => toast(err.message));
  },

  onShow() {
    ensureFrontendAccess()
      .then(() => this.load())
      .catch(() => null);
  },

  load() {
    this.setData({ loading: !this.data.addresses.length });
    return call("getMyAddresses", {}, { showLoading: false })
      .then((data) => {
        const addresses = (data.addresses || []).map((item) => ({
          ...item,
          summary: addressSummary(item),
          receiverPhoneDisplay: item.receiverPhoneMasked || maskPhone(item.receiverPhone)
        }));
        this.setData({ addresses });
      })
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ loading: false }));
  },

  selectAddress(e) {
    if (!this.data.selectMode) return;
    const address = this.data.addresses.find((item) => item._id === e.currentTarget.dataset.id);
    if (!address) return;
    wx.setStorageSync("selectedShippingAddress", address);
    wx.navigateBack();
  },

  addAddress() {
    wx.navigateTo({ url: `/pages/address/edit?select=${this.data.selectMode ? "1" : "0"}` });
  },

  editAddress(e) {
    wx.navigateTo({ url: `/pages/address/edit?id=${e.currentTarget.dataset.id}&select=${this.data.selectMode ? "1" : "0"}` });
  },

  async deleteAddress(e) {
    const addressId = e.currentTarget.dataset.id;
    const confirmed = await feedback.confirmAction({
      title: "删除收货地址",
      content: "确认删除该收货地址吗？删除后不会影响历史订单。",
      confirmText: "删除",
      confirmColor: "#9A2D2D"
    });
    if (!confirmed) return;
    call("deleteMyAddress", { addressId })
      .then(() => {
        feedback.showSuccess("已删除");
        this.load();
      })
      .catch((err) => feedback.showError(err.message));
  },

  setDefault(e) {
    call("setDefaultAddress", { addressId: e.currentTarget.dataset.id })
      .then(() => {
        feedback.showSuccess("已设为默认地址");
        this.load();
      })
      .catch((err) => feedback.showError(err.message));
  },

  noop() {
  }
});
