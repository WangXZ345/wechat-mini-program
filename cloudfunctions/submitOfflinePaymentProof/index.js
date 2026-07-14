const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const res = await cloud.callFunction({
    name: "paymentMethods",
    data: { ...event, action: "submitOfflinePaymentProof", _callerOpenid: wxContext.OPENID }
  });
  return res.result || { ok: false, message: "提交付款凭证失败" };
};
