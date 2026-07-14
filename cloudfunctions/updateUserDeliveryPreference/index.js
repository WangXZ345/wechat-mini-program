const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeDeliveryType(value) {
  if (value === "self_pickup" || value === "shipping") return value;
  throw new Error("配送方式无效");
}

function normalizePhone(phone) {
  const value = cleanText(phone, 30);
  if (!/^1\d{10}$/.test(value) && !/^\+?\d[\d -]{5,28}$/.test(value)) {
    throw new Error("手机号格式错误");
  }
  return value;
}

function normalizeShippingAddress(input = {}) {
  const address = {
    receiverName: cleanText(input.receiverName, 50),
    receiverPhone: normalizePhone(input.receiverPhone),
    province: cleanText(input.province, 40),
    city: cleanText(input.city, 40),
    district: cleanText(input.district, 40),
    detailAddress: cleanText(input.detailAddress, 200),
    remark: cleanText(input.remark, 200)
  };
  if (!address.receiverName) throw new Error("请填写收货人姓名");
  if (!address.detailAddress) throw new Error("请填写详细地址");
  const regionText = cleanText(input.fullAddress, 300) || [
    address.province,
    address.city,
    address.district
  ].filter(Boolean).join("");
  address.fullAddress = regionText && address.detailAddress && regionText.includes(address.detailAddress)
    ? regionText
    : [regionText, address.detailAddress].filter(Boolean).join("");
  return address;
}

async function getOrCreateUser(openid) {
  const now = db.serverDate();
  const res = await db.collection("users").where({ openid }).limit(1).get();
  if (res.data[0]) return res.data[0];
  const created = await db.collection("users").add({
    data: { openid, nickname: "", phone: "", createdAt: now, updatedAt: now }
  });
  return { _id: created._id, openid };
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, message: "缺少用户身份" };

  try {
    const deliveryType = normalizeDeliveryType(event.deliveryType);
    const user = await getOrCreateUser(openid);
    const data = {
      defaultDeliveryType: deliveryType,
      updatedAt: db.serverDate()
    };
    if (deliveryType === "shipping") {
      data.lastShippingAddress = normalizeShippingAddress(event.shippingAddress || {});
    }
    await db.collection("users").doc(user._id).update({ data });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: err.message || "更新配送偏好失败" };
  }
};
