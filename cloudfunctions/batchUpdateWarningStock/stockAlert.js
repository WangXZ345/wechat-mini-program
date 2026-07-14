const DEFAULT_WARNING_STOCK = 10;
const MAX_WARNING_STOCK = 99999;

function toNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeWarningStock(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_WARNING_STOCK;
  const num = Number(value);
  if (!Number.isInteger(num)) throw new Error("预警库存必须是整数");
  if (num < 0) throw new Error("预警库存不能小于 0");
  if (num > MAX_WARNING_STOCK) throw new Error("预警库存不能超过 99999");
  return num;
}

function getStockStatus(stock, warningStock) {
  const safeStock = toNumber(stock, 0);
  const safeWarningStock = normalizeWarningStock(warningStock);
  if (safeStock <= 0) return "out_of_stock";
  if (safeStock <= safeWarningStock) return "warning";
  return "normal";
}

function buildStockAlertMessage(product = {}) {
  const name = product.name || product.productName || "未命名商品";
  const spec = product.specification ? ` ${product.specification}` : "";
  if (toNumber(product.stock, 0) <= 0) return `${name}${spec}，库存为 0`;
  return `${name}${spec}，仅剩 ${product.stock} 件`;
}

function shouldAutoHideProduct(stock, autoHideWhenOutOfStock) {
  return toNumber(stock, 0) <= 0 && autoHideWhenOutOfStock === true;
}

function buildStockStatusUpdate(product = {}, overrides = {}) {
  const stock = toNumber(overrides.stock !== undefined ? overrides.stock : product.stock, 0);
  const warningStock = normalizeWarningStock(
    overrides.warningStock !== undefined ? overrides.warningStock : product.warningStock
  );
  const autoHideWhenOutOfStock = overrides.autoHideWhenOutOfStock !== undefined
    ? overrides.autoHideWhenOutOfStock === true
    : product.autoHideWhenOutOfStock === true;
  const stockStatus = getStockStatus(stock, warningStock);
  const data = {
    stock,
    warningStock,
    stockStatus,
    autoHideWhenOutOfStock,
    lastStockCheckAt: overrides.now,
    updatedAt: overrides.now
  };
  if (shouldAutoHideProduct(stock, autoHideWhenOutOfStock)) data.isActive = false;
  return data;
}

async function syncStockAlertRecord(ctx, productId, product = {}, stockStatus, operatorId = "system") {
  const { db, store } = ctx;
  if (!productId) return;
  const records = store.collection("stock_alert_records");
  const active = await records.where({ productId, status: "active" }).limit(20).get();
  const now = db.serverDate();

  if (stockStatus === "warning" || stockStatus === "out_of_stock") {
    const payload = {
      productId,
      productIndex: product.productIndex || "",
      productName: product.name || product.productName || "",
      specification: product.specification || "",
      productionDate: product.productionDate || "",
      stock: toNumber(product.stock, 0),
      warningStock: normalizeWarningStock(product.warningStock),
      alertType: stockStatus,
      status: "active",
      lastTriggeredAt: now,
      updatedAt: now
    };
    if (active.data && active.data[0]) {
      await records.doc(active.data[0]._id).update({ data: payload });
      return;
    }
    await records.add({
      data: {
        ...payload,
        firstTriggeredAt: now,
        resolvedAt: null,
        resolvedBy: "",
        createdAt: now
      }
    });
    return;
  }

  await Promise.all((active.data || []).map((record) => records.doc(record._id).update({
    data: {
      status: "resolved",
      resolvedAt: now,
      resolvedBy: operatorId,
      updatedAt: now
    }
  })));
}

module.exports = {
  DEFAULT_WARNING_STOCK,
  MAX_WARNING_STOCK,
  getStockStatus,
  normalizeWarningStock,
  buildStockAlertMessage,
  shouldAutoHideProduct,
  buildStockStatusUpdate,
  syncStockAlertRecord
};
