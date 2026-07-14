const cloud = require("wx-server-sdk");

const {
  syncStockAlertRecord
} = require("./stockAlert");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission, logAdminOperation } = require("./auth");
const idempotency = require("./idempotency");
const { createProductStatusService } = require("./productStatusService");
const { createStatusHandler, createBulkActivateHandler } = require("./statusHandler");
const { createProductWriteService } = require("./productWriteService");
const { createProductWriteHandler } = require("./productWriteHandler");
const CLEAR_CONFIRM_TEXT = "CLEAR_ALL_INVENTORY";

const productStatusService = createProductStatusService({ db, idempotency });
const productWriteService = createProductWriteService({ db, idempotency, stockAlert: { syncStockAlertRecord } });
const handleProductWrite = createProductWriteHandler({ service: productWriteService });
const handleProductStatus = createStatusHandler({ requirePermission, service: productStatusService });
const handleBulkActivate = createBulkActivateHandler({ requirePermission, service: productStatusService });

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) throw err;
  }
}

function isMissingCollection(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

async function clearAllInventory(admin) {
  await ensureCollection("inventory_logs");

  const query = { isDeleted: _.neq(true) };
  const count = await db.collection("products").where(query).count();
  const products = await db.collection("products").where(query).limit(1000).get();
  const deletedCount = Number(count.total || products.data.length);
  const totalBeforeStock = products.data.reduce((sum, product) => sum + Number(product.stock || 0), 0);

  if (deletedCount > 0) {
    await db.collection("products").where(query).update({
      data: {
        isDeleted: true,
        deletedAt: db.serverDate(),
        deletedBy: admin.openid,
        isActive: false,
        stock: 0,
        stockStatus: "out_of_stock",
        searchText: "",
        updatedAt: db.serverDate()
      }
    });

    try {
      await db.collection("stock_alert_records").where({ status: "active" }).update({
        data: {
          status: "resolved",
          resolvedAt: db.serverDate(),
          resolvedBy: admin.openid,
          resolveReason: "inventory_clear_all",
          updatedAt: db.serverDate()
        }
      });
    } catch (err) {
      if (!isMissingCollection(err)) throw err;
    }
  }

  await db.collection("inventory_logs").add({
    data: {
      productId: "ALL",
      beforeStock: totalBeforeStock,
      afterStock: 0,
      changeAmount: -totalBeforeStock,
      reason: "inventory_clear_all",
      relatedOrderId: "",
      operatorId: admin.openid,
      affectedProductCount: deletedCount,
      stockStatusBefore: "",
      stockStatusAfter: "deleted",
      warningStock: null,
      triggeredAlert: false,
      createdAt: db.serverDate()
    }
  });

  await logAdminOperation({
    operator: admin,
    action: "inventory_clear_all",
    resourceType: "products",
    resourceId: "all",
    beforeData: { productCount: deletedCount, totalStock: totalBeforeStock },
    afterData: { productCount: 0, totalStock: 0 },
    description: "Clear all inventory products before re-import"
  });

  return { deletedCount, totalBeforeStock };
}

exports.main = async (event) => {
  const { action, productId } = event;

  try {
    if (action === "delete") return handleProductStatus(event);
    if (action === "bulkActivate") return handleBulkActivate(event);
    const requiredPermission = {
      create: "product:create",
      update: "product:update",
      clearAllInventory: "inventory:delete_all"
    }[action];
    if (!requiredPermission) return { ok: false, message: "未知操作" };
    const admin = await requirePermission(requiredPermission);
    await ensureCollection("stock_alert_records");
    await ensureCollection("price_logs");
    if (action === "clearAllInventory") {
      if (event.confirmText !== CLEAR_CONFIRM_TEXT) return { ok: false, message: "缺少清空库存确认" };
      const result = await clearAllInventory(admin);
      return { ok: true, data: result };
    }

    if (action === "create") {
      return handleProductWrite(event, admin);
    }

    if (!productId) return { ok: false, message: "缺少商品 ID" };
    if (action === "update") {
      return handleProductWrite(event, admin);
    }

    return { ok: false, message: "未知操作" };
  } catch (err) {
    return { ok: false, message: err.message || "商品操作失败" };
  }
};

