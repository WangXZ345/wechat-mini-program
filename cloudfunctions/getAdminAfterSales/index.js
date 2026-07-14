const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const result = await cloud.callFunction({
    name: "afterSales",
    data: { ...event, _callerOpenid: wxContext.OPENID || "", action: "getAdminAfterSales" }
  });
  return result.result || { ok: false, message: "getAdminAfterSales failed" };
};


