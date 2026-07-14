const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async (event = {}) => {
  const res = await cloud.callFunction({ name: "paymentMethods", data: { ...event, action: "enablePaymentMethod" } });
  return res.result || { ok: false, message: "启用支付方式失败" };
};
