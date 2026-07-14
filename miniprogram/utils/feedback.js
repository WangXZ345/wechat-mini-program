const clickLocks = {};

function normalizeMessage(message, fallback) {
  return message || fallback || "操作完成";
}

function showToast(message, icon) {
  wx.showToast({
    title: normalizeMessage(message, "操作完成"),
    icon,
    duration: 1800
  });
}

function showSuccess(message) {
  showToast(message || "操作成功", "success");
}

function showError(message) {
  showToast(message || "操作失败，请重试", "none");
}

function showWarning(message) {
  showToast(message || "请检查后再试", "none");
}

function showInfo(message) {
  showToast(message || "请稍候", "none");
}

function showLoading(message) {
  wx.showLoading({
    title: message || "加载中",
    mask: true
  });
}

function hideLoading() {
  wx.hideLoading();
}

function confirmAction(options = {}) {
  return new Promise((resolve) => {
    wx.showModal({
      title: options.title || "确认操作",
      content: options.content || "确认继续执行该操作？",
      confirmText: options.confirmText || "确认",
      cancelText: options.cancelText || "取消",
      confirmColor: options.confirmColor || "#B99C74",
      success: (res) => resolve(Boolean(res.confirm)),
      fail: () => resolve(false)
    });
  });
}

function withLoading(fn, message) {
  showLoading(message);
  return Promise.resolve()
    .then(fn)
    .finally(() => hideLoading());
}

function preventDoubleClick(key, duration = 1200) {
  const now = Date.now();
  if (clickLocks[key] && clickLocks[key] > now) return true;
  clickLocks[key] = now + duration;
  setTimeout(() => {
    if (clickLocks[key] <= Date.now()) delete clickLocks[key];
  }, duration + 50);
  return false;
}

module.exports = {
  showSuccess,
  showError,
  showWarning,
  showInfo,
  showLoading,
  hideLoading,
  confirmAction,
  withLoading,
  preventDoubleClick
};
