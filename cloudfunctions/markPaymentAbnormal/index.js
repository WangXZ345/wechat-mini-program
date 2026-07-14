const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const result = await cloud.callFunction({
    name: "adminUpdatePayment",
    data: { ...event, paymentStatus: "abnormal" }
  });
  return result.result || { ok: false, message: "标记付款异常失败" };
};
