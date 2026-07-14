const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async () => {
  const openid = cloud.getWXContext().OPENID;

  try {
    const res = await db.collection("carts").where({ userOpenid: openid }).limit(100).get();
    await Promise.all(res.data.map((item) => db.collection("carts").doc(item._id).remove()));
    return { ok: true, data: { removed: res.data.length } };
  } catch (err) {
    return { ok: false, message: err.message || "清空购物车失败" };
  }
};
