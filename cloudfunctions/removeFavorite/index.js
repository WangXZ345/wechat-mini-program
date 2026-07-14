const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function isMissingCollection(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  const productId = String(event.productId || "").trim();
  if (!productId) return fail("缺少商品 ID");

  try {
    const res = await db.collection("user_favorites")
      .where({ userOpenid: openid, productId })
      .limit(20)
      .get();
    await Promise.all((res.data || []).map((item) => {
      return db.collection("user_favorites").doc(item._id).remove();
    }));
    return ok({ success: true, isFavorite: false, removedCount: res.data.length });
  } catch (err) {
    if (isMissingCollection(err)) return ok({ success: true, isFavorite: false, removedCount: 0 });
    return fail(err.message || "取消收藏失败");
  }
};
