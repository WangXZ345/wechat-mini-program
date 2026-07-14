const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) return;
    if (/createCollection is not a function/i.test(message)) return;
    throw err;
  }
}

async function getUser(openid) {
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
  const productId = String(event.productId || "").trim();
  if (!productId) return fail("缺少商品 ID");

  try {
    await ensureCollection("user_favorites");
    const existing = await db.collection("user_favorites")
      .where({ userOpenid: openid, productId })
      .limit(20)
      .get();

    if (existing.data[0]) {
      await Promise.all(existing.data.map((item) => {
        return db.collection("user_favorites").doc(item._id).remove();
      }));
      return ok({ success: true, isFavorite: false });
    }

    const product = (await db.collection("products").doc(productId).get()).data;
    if (!product || product.isDeleted === true) return fail("商品不存在");
    if (product.isActive === false) return fail("商品已下架，不能新增收藏");

    const user = await getUser(openid);
    const now = db.serverDate();
    const created = await db.collection("user_favorites").add({
      data: {
        userId: user._id || "",
        userOpenid: openid,
        productId,
        productNameSnapshot: product.name || "",
        productImageSnapshot: product.imageUrl || "",
        priceSnapshot: Number(product.price || 0),
        specificationSnapshot: product.specification || "",
        productionDateSnapshot: product.productionDate || "",
        createdAt: now,
        updatedAt: now
      }
    });

    return ok({ success: true, isFavorite: true, favoriteId: created._id });
  } catch (err) {
    return fail(err.message || "更新收藏失败");
  }
};
