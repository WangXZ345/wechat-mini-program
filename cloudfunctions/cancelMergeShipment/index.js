const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const result = await cloud.callFunction({
    name: "shipmentGroups",
    data: { ...event, action: "cancelMergeShipment" }
  });
  return result.result || { ok: false, message: "取消合并发货单失败" };
};
