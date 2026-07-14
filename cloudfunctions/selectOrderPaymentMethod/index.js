const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async (event = {}) => {
  const res = await cloud.callFunction({ name: "paymentMethods", data: { ...event, action: "selectOrderPaymentMethod" } });
  return res.result || { ok: false, message: "选择支付方式失败" };
};
