const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const result = await cloud.callFunction({
    name: "adminUpdatePayment",
    data: {
      ...event,
      paymentStatus: event.paymentStatus || (event.isPartial ? "partial_paid" : "paid")
    }
  });
  return result.result || { ok: false, message: "确认付款失败" };
};
