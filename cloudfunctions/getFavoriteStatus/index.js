const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function ok(data) {
  return { ok: true, data };
}

function isMissingCollection(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  const productId = String(event.productId || "").trim();
  if (!productId) return { ok: false, message: "缺少商品 ID" };

  try {
    const res = await db.collection("user_favorites")
      .where({ userOpenid: openid, productId })
      .limit(1)
      .get();
    return ok({ isFavorite: Boolean(res.data[0]) });
  } catch (err) {
    if (isMissingCollection(err)) return ok({ isFavorite: false });
    return { ok: false, message: err.message || "获取收藏状态失败" };
  }
};
