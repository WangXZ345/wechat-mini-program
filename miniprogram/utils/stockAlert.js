const DEFAULT_WARNING_STOCK = 10;
const MAX_WARNING_STOCK = 99999;

function normalizeWarningStock(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_WARNING_STOCK;
  const num = Number(value);
  if (!Number.isInteger(num)) throw new Error("预警库存必须是整数");
  if (num < 0) throw new Error("预警库存不能小于 0");
  if (num > MAX_WARNING_STOCK) throw new Error("预警库存不能超过 99999");
  return num;
}

function getStockStatus(stock, warningStock) {
  const safeStock = Number(stock || 0);
  const safeWarningStock = normalizeWarningStock(warningStock);
  if (safeStock <= 0) return "out_of_stock";
  if (safeStock <= safeWarningStock) return "warning";
  return "normal";
}

function buildStockAlertMessage(product = {}) {
  const name = product.name || product.productName || "未命名商品";
  const spec = product.specification ? ` ${product.specification}` : "";
  if (Number(product.stock || 0) <= 0) return `${name}${spec}，库存为 0`;
  return `${name}${spec}，仅剩 ${product.stock} 件`;
}

function shouldAutoHideProduct(stock, autoHideWhenOutOfStock) {
  return Number(stock || 0) <= 0 && autoHideWhenOutOfStock === true;
}

module.exports = {
  getStockStatus,
  normalizeWarningStock,
  buildStockAlertMessage,
  shouldAutoHideProduct
};
