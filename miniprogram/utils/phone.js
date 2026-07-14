const { call, feedback } = require("./api");

function isPhoneRequiredError(err) {
  const message = err && err.message || "";
  return err && (err.code === "PHONE_REQUIRED" || err.code === "PHONE_VERIFY_REQUIRED")
    || /PHONE_REQUIRED|PHONE_VERIFY_REQUIRED|绑定手机号|手机号验证/.test(message);
}

function bindPhoneUrl(returnUrl) {
  const target = returnUrl || currentPageUrl();
  return `/pages/profile/bind-phone?returnUrl=${encodeURIComponent(target)}`;
}

function currentPageUrl() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page) return "/pages/index/index";
  const route = `/${page.route}`;
  const options = page.options || {};
  const query = Object.keys(options)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(options[key])}`)
    .join("&");
  return query ? `${route}?${query}` : route;
}

function promptBindPhone(returnUrl) {
  return feedback.confirmAction({
    title: "需要绑定手机号",
    content: "为了方便商家确认订单和账款，请先绑定手机号。",
    confirmText: "去绑定"
  }).then((confirmed) => {
    if (!confirmed) return false;
    wx.navigateTo({ url: bindPhoneUrl(returnUrl) });
    return true;
  });
}

function ensurePhoneBeforeOrder(returnUrl) {
  return call("getMyProfile", {}, { showLoading: false }).then((data) => {
    const profile = data.profile || {};
    if (profile.phoneMasked) return true;
    return promptBindPhone(returnUrl).then(() => false);
  }).catch((err) => {
    if (handlePhoneRequiredError(err, returnUrl)) return false;
    throw err;
  });
}

function handlePhoneRequiredError(err, returnUrl) {
  if (!isPhoneRequiredError(err)) return false;
  promptBindPhone(returnUrl);
  return true;
}

module.exports = {
  isPhoneRequiredError,
  promptBindPhone,
  ensurePhoneBeforeOrder,
  handlePhoneRequiredError,
  bindPhoneUrl
};
