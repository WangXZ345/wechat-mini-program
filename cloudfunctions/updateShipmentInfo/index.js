const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const result = await cloud.callFunction({
    name: "shipmentGroups",
    data: { ...event, action: "updateShipmentInfo" }
  });
  return result.result || { ok: false, message: "更新物流信息失败" };
};
