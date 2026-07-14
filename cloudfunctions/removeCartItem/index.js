const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID;
  const cartItemId = event.cartItemId;
  if (!cartItemId) return { ok: false, message: "缺少购物车商品 ID" };

  try {
    const cart = (await db.collection("carts").doc(cartItemId).get()).data;
    if (!cart || cart.userOpenid !== openid) return { ok: false, message: "购物车商品不存在" };
    await db.collection("carts").doc(cartItemId).remove();
    return { ok: true, data: { cartItemId } };
  } catch (err) {
    return { ok: false, message: err.message || "删除购物车商品失败" };
  }
};
