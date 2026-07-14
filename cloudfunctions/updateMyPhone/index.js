const cloud = require("wx-server-sdk");
const { normalizePhone, maskPhone } = require("./common/phone");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function fail(message, code) {
  return { ok: false, code, message };
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail("登录状态无效，请重新进入小程序", "LOGIN_REQUIRED");

  try {
    const phoneNumber = normalizePhone(event.phoneNumber);
    const res = await db.collection("users").where({ openid }).limit(1).get();
    const user = res.data[0] || null;
    const beforePhone = user && (user.phoneNumber || user.phone || "");
    if (beforePhone && beforePhone !== phoneNumber && event.confirmChange !== true) {
      return fail(
        `确认将手机号从 ${maskPhone(beforePhone)} 更换为 ${maskPhone(phoneNumber)}？`,
        "PHONE_CHANGE_CONFIRM_REQUIRED"
      );
    }

    const result = await cloud.callFunction({
      name: "bindPhoneManual",
      data: { phoneNumber }
    });
    return result.result || fail("更换手机号失败");
  } catch (err) {
    return fail(err.message || "更换手机号失败");
  }
};
