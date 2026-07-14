const cloud = require("wx-server-sdk");
const {
  buildStockStatusUpdate,
  normalizeWarningStock,
  syncStockAlertRecord
} = require("./stockAlert");
const {
  runIdempotentAction,
  idempotencyErrorResponse
} = require("./idempotency");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const MAX_BATCH = 200;
const { requirePermission } = require("./auth");

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) throw err;
  }
}

async function applyBatchWarningStock(event, operatorId, productIds, warningStock, batchOperationId) {
  await ensureCollection("stock_alert_records");

  let successCount = 0;
  const failures = [];
  for (const productId of productIds) {
    try {
      await db.runTransaction(async (tx) => {
        const product = (await tx.collection("products").doc(productId).get()).data;
        if (!product) throw new Error("PRODUCT_NOT_FOUND");

        const businessKey = `batch_warning_stock:${batchOperationId}:${productId}`;
        const logRes = await tx.collection("inventory_logs").where({ businessKey }).limit(1).get();
        if (logRes.data && logRes.data[0]) return;

        const now = db.serverDate();
        const updateData = buildStockStatusUpdate(product, {
          warningStock,
          autoHideWhenOutOfStock: event.autoHideWhenOutOfStock,
          now
        });
        const nextProduct = { ...product, ...updateData };

        await tx.collection("products").doc(productId).update({ data: updateData });
        await syncStockAlertRecord({ db, store: tx }, productId, nextProduct, updateData.stockStatus, operatorId);
        await tx.collection("inventory_logs").add({
          data: {
            productId,
            beforeStock: Number(product.stock || 0),
            afterStock: Number(product.stock || 0),
            changeAmount: 0,
            reason: "batch_update_warning_stock",
            relatedOrderId: "",
            operatorId,
            stockStatusBefore: product.stockStatus || "",
            stockStatusAfter: updateData.stockStatus,
            warningStock,
            triggeredAlert: updateData.stockStatus === "warning" || updateData.stockStatus === "out_of_stock",
            businessKey,
            sourceType: "batch_warning_stock",
            sourceId: batchOperationId,
            idempotencyKey: event.idempotencyKey || "",
            createdAt: now
          }
        });
      });
      successCount += 1;
    } catch (err) {
      failures.push({ productId, reason: err.message || "UPDATE_FAILED" });
    }
  }

  return {
    batchOperationId,
    successCount,
    failedCount: failures.length,
    failures
  };
}

exports.main = async (event = {}) => {
  try {
    const admin = await requirePermission("inventory:set_warning");
    const operatorId = admin.openid;
    const productIds = Array.from(new Set(Array.isArray(event.productIds) ? event.productIds.filter(Boolean) : []));
    if (!productIds.length) return { ok: false, message: "PRODUCT_IDS_REQUIRED" };
    if (productIds.length > MAX_BATCH) return { ok: false, message: `MAX_BATCH_${MAX_BATCH}` };

    const warningStock = normalizeWarningStock(event.warningStock);
    const batchOperationId = String(event.batchOperationId || event.idempotencyKey || "").trim();

    return await runIdempotentAction({
      db,
      actionType: "batch_update_warning_stock",
      idempotencyKey: event.idempotencyKey,
      operatorType: "admin",
      operatorIdentity: operatorId,
      adminId: operatorId,
      scope: "products",
      scopeId: batchOperationId,
      ttlSeconds: 7 * 24 * 60 * 60,
      payload: {
        batchOperationId,
        productIds,
        warningStock,
        autoHideWhenOutOfStock: event.autoHideWhenOutOfStock === true
      }
    }, () => applyBatchWarningStock(event, operatorId, productIds, warningStock, batchOperationId));
  } catch (err) {
    return idempotencyErrorResponse(err) || { ok: false, message: err.message || "BATCH_UPDATE_WARNING_STOCK_FAILED" };
  }
};
