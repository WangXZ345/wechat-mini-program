const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async (event = {}) => {
  const res = await cloud.callFunction({ name: "paymentMethods", data: { ...event, action: "getEnabledPaymentMethods" } });
  return res.result || { ok: false, message: "获取支付方式失败" };
};
