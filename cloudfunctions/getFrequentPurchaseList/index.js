const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const MAX_PAGE_SIZE = 50;
const SORT_FIELDS = ["purchaseCount", "totalQuantity", "lastPurchasedAt"];

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

async function getFavoriteSet(openid, productIds) {
  if (!productIds.length) return {};
  try {
    const res = await db.collection("user_favorites")
      .where({ userOpenid: openid, productId: _.in(productIds) })
      .limit(productIds.length)
      .get();
    return (res.data || []).reduce((map, item) => {
      map[item.productId] = true;
      return map;
    }, {});
  } catch (err) {
    if (isMissingCollection(err)) return {};
    throw err;
  }
}

function productStatus(product) {
  if (!product || product.isDeleted === true) return { unavailable: true, unavailableReason: "商品不存在" };
  if (product.isActive === false) return { unavailable: true, unavailableReason: "商品已下架" };
  if (Number(product.price || 0) <= 0) return { unavailable: true, unavailableReason: "价格异常" };
  return { unavailable: false, unavailableReason: "" };
}

function buildFrequentItem(stat, product, favoriteMap) {
  const status = productStatus(product);
  const current = product || {};
  return {
    statId: stat._id,
    productId: stat.productId,
    name: current.name || stat.productNameSnapshot || "",
    imageUrl: current.imageUrl || stat.productImageSnapshot || "",
    brand: current.brand || "",
    category: current.category || "",
    specification: current.specification || stat.specificationSnapshot || "",
    productionDate: current.productionDate || stat.productionDateSnapshot || "",
    price: product ? Number(current.price || 0) : 0,
    purchaseCount: Number(stat.purchaseCount || 0),
    totalQuantity: Number(stat.totalQuantity || 0),
    totalAmount: Number(stat.totalAmount || 0),
    lastPurchasedAt: stat.lastPurchasedAt || null,
    firstPurchasedAt: stat.firstPurchasedAt || null,
    isFavorite: Boolean(favoriteMap[stat.productId]),
    unavailable: status.unavailable,
    unavailableReason: status.unavailableReason
  };
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  const sortBy = SORT_FIELDS.includes(event.sortBy) ? event.sortBy : "purchaseCount";
  const page = Math.max(1, parseInt(event.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(event.pageSize, 10) || 20));
  const skip = (page - 1) * pageSize;

  try {
    let query = db.collection("user_product_purchase_stats")
      .where({ userOpenid: openid })
      .orderBy(sortBy, "desc");
    if (sortBy !== "purchaseCount") query = query.orderBy("purchaseCount", "desc");
    if (sortBy !== "totalQuantity") query = query.orderBy("totalQuantity", "desc");
    if (sortBy !== "lastPurchasedAt") query = query.orderBy("lastPurchasedAt", "desc");

    const res = await query.skip(skip).limit(pageSize + 1).get();
    const rows = res.data || [];
    const pageRows = rows.slice(0, pageSize);
    const favoriteMap = await getFavoriteSet(openid, pageRows.map((item) => item.productId).filter(Boolean));
    const list = [];
    for (const stat of pageRows) {
      const product = await safeGetProduct(stat.productId);
      list.push(buildFrequentItem(stat, product, favoriteMap));
    }

    return ok({
      list,
      page,
      pageSize,
      sortBy,
      hasMore: rows.length > pageSize
    });
  } catch (err) {
    if (isMissingCollection(err)) {
      return ok({ list: [], page, pageSize, sortBy, hasMore: false });
    }
    return fail(err.message || "获取常购清单失败");
  }
};
