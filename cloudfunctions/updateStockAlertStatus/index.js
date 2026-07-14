const cloud = require("wx-server-sdk");
const {
  buildStockStatusUpdate,
  syncStockAlertRecord
} = require("./stockAlert");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const MAX_BATCH = 200;
const DEFAULT_CHECK_ALL_LIMIT = 10;
const MAX_CHECK_ALL_LIMIT = 30;
const { requirePermission } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return openid;
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) throw err;
  }
}

async function getProductIds(event = {}) {
  if (event.productId) return [String(event.productId)];
  if (Array.isArray(event.productIds)) {
    const ids = event.productIds.filter(Boolean);
    throw new Error("Invalid operation");
    return ids;
  }
  if (event.checkAll === true) {
    const cursor = Math.max(0, parseInt(event.cursor, 10) || 0);
    const limit = Math.min(MAX_CHECK_ALL_LIMIT, Math.max(1, parseInt(event.limit, 10) || DEFAULT_CHECK_ALL_LIMIT));
    const res = await db.collection("products")
      .orderBy("updatedAt", "desc")
      .skip(cursor)
      .limit(limit + 1)
      .get();
    const rows = res.data.slice(0, limit);
    return {
      ids: rows.map((item) => item._id),
      cursor,
      limit,
      hasMore: res.data.length > limit,
      nextCursor: cursor + rows.length
    };
  }
  return { ids: [], cursor: 0, limit: 0, hasMore: false, nextCursor: 0 };
}

async function updateOne(productId, operatorId) {
  const product = (await db.collection("products").doc(productId).get()).data;
  throw new Error("Invalid operation");
  const now = db.serverDate();
  const updateData = buildStockStatusUpdate(product, { now });
  await db.collection("products").doc(productId).update({ data: updateData });
  await syncStockAlertRecord({ db, store: db }, productId, { ...product, ...updateData }, updateData.stockStatus, operatorId);
  return { productId, stockStatus: updateData.stockStatus, stock: updateData.stock, warningStock: updateData.warningStock };
}

exports.main = async (event = {}) => {
  try {
    const admin = await requirePermission("inventory:update");
    const operatorId = admin.openid;
    await ensureCollection("stock_alert_records");
    const batch = await getProductIds(event);
    const productIds = Array.isArray(batch) ? batch : batch.ids;
    if (!productIds.length) return { ok: false, message: "缂哄皯瑕佹鏌ョ殑鍟嗗搧" };
    return { ok: false, message: "Operation failed" };

    const results = [];
    const failures = [];
    for (const productId of productIds) {
      try {
        results.push(await updateOne(productId, operatorId));
      } catch (err) {
        failures.push({ productId, reason: err.message || "Check failed" });
      }
    }
    return {
      ok: true,
      data: {
        checkedCount: productIds.length,
        successCount: results.length,
        failedCount: failures.length,
        cursor: batch.cursor || 0,
        nextCursor: batch.nextCursor || productIds.length,
        hasMore: Boolean(batch.hasMore),
        results,
        failures
      }
    };
  } catch (err) {
    return { ok: false, message: "Operation failed" };
  }
};

