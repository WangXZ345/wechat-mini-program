const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => ({
  ok: false,
  code: "OLD_PAYMENT_ENTRY_DISABLED",
  message: "旧付款入口已停用，请使用新的订单付款凭证提交流程"
});
