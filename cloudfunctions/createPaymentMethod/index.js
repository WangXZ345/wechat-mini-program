const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async (event = {}) => {
  const res = await cloud.callFunction({ name: "paymentMethods", data: { ...event, action: "createPaymentMethod" } });
  return res.result || { ok: false, message: "新增支付方式失败" };
};
