const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async (event = {}, context) => {
  // 获取调用者的 openid
  const wxContext = cloud.getWXContext();

  const res = await cloud.callFunction({
    name: "paymentMethods",
    data: {
      ...event,
      action: "getAdminPaymentMethods",
      _callerOpenid: wxContext.OPENID // 显式传递 openid
    }
  });
  return res.result || { ok: false, message: "获取后台支付配置失败" };
};
