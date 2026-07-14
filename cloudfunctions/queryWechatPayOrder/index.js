const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async (event = {}) => {
  const res = await cloud.callFunction({ name: "paymentMethods", data: { ...event, action: "queryWechatPayOrder" } });
  return res.result || { ok: false, message: "查询微信支付订单失败" };
};
