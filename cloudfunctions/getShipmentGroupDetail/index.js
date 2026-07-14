const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const result = await cloud.callFunction({
    name: "shipmentGroups",
    data: { ...event, action: "getShipmentGroupDetail" }
  });
  return result.result || { ok: false, message: "获取合并发货详情失败" };
};
