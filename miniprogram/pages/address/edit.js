const { call, feedback, toast } = require("../../utils/api");
const { ensureLogin } = require("../../utils/auth");

const EMPTY_FORM = {
  receiverName: "",
  receiverPhone: "",
  region: [],
  province: "",
  city: "",
  district: "",
  regionText: "",
  detailAddress: "",
  addressTag: "",
  isDefault: false
};

function normalizeForm(address = {}) {
  const region = Array.isArray(address.region) && address.region.length
    ? address.region
    : [address.province, address.city, address.district].filter(Boolean);
  return {
    ...EMPTY_FORM,
    ...address,
    region,
    regionText: address.regionText || region.join(" ")
  };
}

Page({
  data: {
    id: "",
    selectMode: false,
    form: { ...EMPTY_FORM },
    loading: false,
    saving: false
  },

  onLoad(options = {}) {
    this.setData({
      id: options.id || "",
      selectMode: options.select === "1"
    });
    ensureLogin()
      .then(() => this.data.id ? this.loadAddress() : null)
      .catch((err) => toast(err.message));
  },

  loadAddress() {
    this.setData({ loading: true });
    return call("getMyAddresses", {}, { showLoading: false })
      .then((data) => {
        const address = (data.addresses || []).find((item) => item._id === this.data.id);
        if (!address) throw new Error("收货地址不存在");
        this.setData({ form: normalizeForm(address) });
      })
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ loading: false }));
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onDefaultChange(e) {
    this.setData({ "form.isDefault": e.detail.value });
  },

  onRegionChange(e) {
    const region = e.detail.value || [];
    this.setData({
      "form.region": region,
      "form.province": region[0] || "",
      "form.city": region[1] || "",
      "form.district": region[2] || "",
      "form.regionText": region.join(" ")
    });
  },

  validate() {
    const form = this.data.form;
    if (!form.receiverName.trim()) return "请填写收货人";
    if (!/^1\d{10}$/.test(String(form.receiverPhone || "").trim())) return "请输入正确手机号";
    if (!form.regionText.trim()) return "请选择省市区";
    if (!form.detailAddress.trim()) return "请填写详细地址";
    if (form.detailAddress.trim().length < 5) return "详细地址至少 5 个字";
    if (String(form.addressTag || "").trim().length > 10) return "地址标签最多 10 个字";
    return "";
  },

  payload() {
    const form = this.data.form;
    return {
      receiverName: form.receiverName,
      receiverPhone: form.receiverPhone,
      region: form.region,
      province: form.province,
      city: form.city,
      district: form.district,
      regionText: form.regionText,
      detailAddress: form.detailAddress,
      addressTag: form.addressTag,
      isDefault: form.isDefault
    };
  },

  saveAddress() {
    if (this.data.saving) return;
    const message = this.validate();
    if (message) {
      feedback.showWarning(message);
      return;
    }
    this.setData({ saving: true });
    const name = this.data.id ? "updateMyAddress" : "addMyAddress";
    const data = this.data.id ? { addressId: this.data.id, ...this.payload() } : this.payload();
    call(name, data)
      .then((result) => {
        feedback.showSuccess("收货地址已保存");
        if (this.data.selectMode && result.address) {
          wx.setStorageSync("selectedShippingAddress", result.address);
        }
        const pages = getCurrentPages();
        const prev = pages[pages.length - 2];
        const delta = this.data.selectMode && prev && prev.route === "pages/address/list" ? 2 : 1;
        setTimeout(() => wx.navigateBack({ delta }), 500);
      })
      .catch((err) => feedback.showError(err.message))
      .finally(() => this.setData({ saving: false }));
  },

  async deleteAddress() {
    if (!this.data.id) return;
    const confirmed = await feedback.confirmAction({
      title: "删除收货地址",
      content: "确认删除该收货地址吗？删除后不会影响历史订单。",
      confirmText: "删除",
      confirmColor: "#9A2D2D"
    });
    if (!confirmed) return;
    call("deleteMyAddress", { addressId: this.data.id })
      .then(() => {
        feedback.showSuccess("已删除");
        setTimeout(() => wx.navigateBack(), 500);
      })
      .catch((err) => feedback.showError(err.message));
  },

  setDefault() {
    if (!this.data.id) {
      this.setData({ "form.isDefault": true });
      return;
    }
    call("setDefaultAddress", { addressId: this.data.id })
      .then((result) => {
        feedback.showSuccess("已设为默认地址");
        if (result.address) this.setData({ form: normalizeForm(result.address) });
      })
      .catch((err) => feedback.showError(err.message));
  }
});
