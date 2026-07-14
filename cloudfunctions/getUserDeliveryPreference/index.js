const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function ok(data) {
  return { ok: true, data };
}

function fallbackAddress() {
  return {
    receiverName: "",
    receiverPhone: "",
    province: "",
    city: "",
    district: "",
    detailAddress: "",
    fullAddress: "",
    remark: ""
  };
}

async function getDefaultDeliveryType() {
  try {
    const res = await db.collection("settings").doc("delivery_defaults").get();
    const value = res.data && res.data.defaultDeliveryType;
    return value === "self_pickup" ? "self_pickup" : "shipping";
  } catch (err) {
    return "shipping";
  }
}

exports.main = async () => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, message: "Missing user identity" };

  try {
    const defaultType = await getDefaultDeliveryType();
    const res = await db.collection("users").where({ openid }).limit(1).get();
    const user = res.data[0] || {};
    const savedType = user.defaultDeliveryType;
    return ok({
      defaultDeliveryType: savedType === "self_pickup" || savedType === "shipping" ? savedType : defaultType,
      lastShippingAddress: user.lastShippingAddress || fallbackAddress()
    });
  } catch (err) {
    return { ok: false, message: err.message || "Get delivery preference failed" };
  }
};
