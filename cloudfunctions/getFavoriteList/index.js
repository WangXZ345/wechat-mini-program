const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const MAX_PAGE_SIZE = 50;

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

async function safeGetProduct(productId) {
  try {
    return (await db.collection("products").doc(productId).get()).data || null;
  } catch (err) {
    return null;
  }
}

function productStatus(product) {
  if (!product || product.isDeleted === true) return { unavailable: true, unavailableReason: "商品不存在" };
  if (product.isActive === false) return { unavailable: true, unavailableReason: "商品已下架" };
  if (Number(product.price || 0) <= 0) return { unavailable: true, unavailableReason: "价格异常" };
  return { unavailable: false, unavailableReason: "" };
}

function buildFavoriteItem(favorite, product) {
  const status = productStatus(product);
  const current = product || {};
  return {
    favoriteId: favorite._id,
    productId: favorite.productId,
    name: current.name || favorite.productNameSnapshot || "",
    imageUrl: current.imageUrl || favorite.productImageSnapshot || "",
    brand: current.brand || "",
    category: current.category || "",
    specification: current.specification || favorite.specificationSnapshot || "",
    productionDate: current.productionDate || favorite.productionDateSnapshot || "",
    price: product ? Number(current.price || 0) : Number(favorite.priceSnapshot || 0),
    isActive: product ? current.isActive !== false : false,
    isNew: Boolean(current.isNew),
    isSpecial: Boolean(current.isSpecial || current.isOnSale),
    isWholesale: current.isWholesale !== false,
    unavailable: status.unavailable,
    unavailableReason: status.unavailableReason,
    isFavorite: true,
    createdAt: favorite.createdAt || null
  };
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  const page = Math.max(1, parseInt(event.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(event.pageSize, 10) || 20));
  const skip = (page - 1) * pageSize;

  try {
    const res = await db.collection("user_favorites")
      .where({ userOpenid: openid })
      .orderBy("createdAt", "desc")
      .skip(skip)
      .limit(pageSize + 1)
      .get();

    const rows = res.data || [];
    const pageRows = rows.slice(0, pageSize);
    const list = [];
    for (const favorite of pageRows) {
      const product = await safeGetProduct(favorite.productId);
      list.push(buildFavoriteItem(favorite, product));
    }

    return ok({
      list,
      page,
      pageSize,
      hasMore: rows.length > pageSize
    });
  } catch (err) {
    if (isMissingCollection(err)) {
      return ok({ list: [], page, pageSize, hasMore: false });
    }
    return fail(err.message || "获取收藏列表失败");
  }
};
