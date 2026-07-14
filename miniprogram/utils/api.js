const feedback = require("./feedback");
const { formatMoneyPlain } = require("./format");

const PAYMENT_METHOD_ACTIONS = {
  getEnabledPaymentMethods: "getEnabledPaymentMethods",
  selectOrderPaymentMethod: "selectOrderPaymentMethod",
  submitOfflinePaymentProof: "submitOfflinePaymentProof",
  createWechatPayOrder: "createWechatPayOrder",
  queryWechatPayOrder: "queryWechatPayOrder",
  getAdminPaymentMethods: "getAdminPaymentMethods",
  createPaymentMethod: "createPaymentMethod",
  updatePaymentMethod: "updatePaymentMethod",
  uploadPaymentQrCode: "uploadPaymentQrCode",
  enablePaymentMethod: "enablePaymentMethod",
  disablePaymentMethod: "disablePaymentMethod",
  deletePaymentMethod: "deletePaymentMethod"
};

const AFTER_SALE_ACTIONS = {
  createAfterSaleRequest: "createAfterSaleRequest",
  getMyAfterSales: "getMyAfterSales",
  getMyAfterSaleDetail: "getMyAfterSaleDetail",
  submitReturnLogistics: "submitReturnLogistics",
  getAdminAfterSales: "getAdminAfterSales",
  getAdminAfterSaleDetail: "getAdminAfterSaleDetail",
  reviewAfterSale: "reviewAfterSale",
  confirmReturnReceived: "confirmReturnReceived",
  inspectReturnItems: "inspectReturnItems",
  createRefundRecord: "createRefundRecord",
  processOfflineRefund: "processOfflineRefund",
  createWechatPayRefund: "createWechatPayRefund",
  handleWechatRefundNotify: "handleWechatRefundNotify",
  rejectRefund: "rejectRefund",
  completeAfterSale: "completeAfterSale",
  getAdminRefunds: "getAdminRefunds",
  getAdminRefundDetail: "getAdminRefundDetail",
  exportAfterSalesExcel: "exportAfterSalesExcel"
};

const ADMIN_DASHBOARD_ACTIONS = {
  getProductAnalytics: "getProductAnalytics"
};

function isFunctionNotFound(err) {
  const message = String((err && (err.errMsg || err.message)) || err || "");
  return (err && err.errCode === -501000)
    || /FUNCTION_NOT_FOUND|functionName parameter could not be found/i.test(message);
}

function callCloudFunction(name, data) {
  const adminDashboardAction = ADMIN_DASHBOARD_ACTIONS[name];
  if (adminDashboardAction) {
    return wx.cloud.callFunction({
      name: "adminDashboard",
      data: {
        ...data,
        action: adminDashboardAction
      }
    });
  }

  const afterSaleAction = AFTER_SALE_ACTIONS[name];
  if (afterSaleAction) {
    return wx.cloud.callFunction({
      name: "afterSales",
      data: {
        ...data,
        action: afterSaleAction
      }
    }).catch((err) => {
      if (!isFunctionNotFound(err)) throw err;
      return wx.cloud.callFunction({ name, data });
    });
  }

  return wx.cloud.callFunction({ name, data }).catch((err) => {
    const action = PAYMENT_METHOD_ACTIONS[name];
    if (action && isFunctionNotFound(err)) {
      return wx.cloud.callFunction({
        name: "paymentMethods",
        data: {
          ...data,
          action
        }
      });
    }
    if (!afterSaleAction || !isFunctionNotFound(err)) throw err;
    return wx.cloud.callFunction({
      name: "afterSales",
      data: {
        ...data,
        action: afterSaleAction
      }
    });
  });
}

function isAdminPageRoute() {
  try {
    const pages = getCurrentPages();
    const current = pages && pages[pages.length - 1];
    const route = current && current.route || "";
    return route.indexOf("pages/admin/") === 0;
  } catch (err) {
    return false;
  }
}

function call(name, data = {}, options = {}) {
  const showLoading = options.showLoading !== undefined
    ? options.showLoading !== false
    : (options.loadingText ? true : !isAdminPageRoute());
  if (showLoading) feedback.showLoading(options.loadingText || "加载中");
  return callCloudFunction(name, data)
    .then((res) => {
      const result = res.result || {};
      if (!result.ok) {
        const error = new Error(result.message || `${name} request failed`);
        error.code = result.code || "";
        throw error;
      }
      return result.data;
    })
    .catch((err) => {
      const message = err && err.message ? err.message : "Request failed";
      const error = new Error(`${name}: ${message}`);
      error.code = err && err.code || "";
      throw error;
    })
    .finally(() => {
      if (showLoading) feedback.hideLoading();
    });
}

function moneyText(cents) {
  return formatMoneyPlain(cents);
}

function toast(title) {
  feedback.showInfo(title);
}

module.exports = {
  call,
  moneyText,
  toast,
  feedback
};
