const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const EMPTY_SETTINGS = {
  pickupLocation: "",
  pickupTimeNote: "",
  pickupContact: "",
  pickupPhone: "",
  pickupRemark: ""
};

exports.main = async () => {
  try {
    const res = await db.collection("pickup_settings").doc("default").get().catch(() => null);
    const settings = res && res.data ? res.data : EMPTY_SETTINGS;
    return {
      ok: true,
      data: {
        ...EMPTY_SETTINGS,
        ...settings,
        isConfigured: Boolean(settings.pickupLocation && settings.pickupContact && settings.pickupPhone)
      }
    };
  } catch (err) {
    return { ok: false, message: err.message || "获取自提配置失败" };
  }
};
