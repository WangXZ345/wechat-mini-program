const cloud = require("wx-server-sdk");
const { buildStockAlertMessage, getStockStatus, normalizeWarningStock } = require("./stockAlert");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const MAX_PAGE_SIZE = 100;
const { requirePermission } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return openid;
}

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function matchesKeyword(product, keyword) {
  if (!keyword) return true;
  const text = normalizeSearchText([
    product.name,
    product.productIndex,
    product.skuCode,
    product.specification,
    product.productionDate
  ].filter(Boolean).join(" "));
  return text.includes(keyword);
}

function statusRank(status) {
  if (status === "out_of_stock") return 0;
  if (status === "warning") return 1;
  return 2;
}

async function getProductsForRequest() {
  const pageSize = 100;
  const maxRows = 5000;
  let skip = 0;
  let products = [];
  while (skip < maxRows) {
    const res = await db.collection("products")
      .where({})
      .orderBy("updatedAt", "desc")
      .skip(skip)
      .limit(pageSize)
      .get();
    products = products.concat(res.data);
    if (res.data.length < pageSize) break;
    skip += pageSize;
  }
  return products.filter((product) => product.isDeleted !== true);
}

function shape(product) {
  const warningStock = normalizeWarningStock(product.warningStock);
  const stock = Number(product.stock || 0);
  const stockStatus = product.stockStatus || getStockStatus(stock, warningStock);
  return {
    productId: product._id,
    productIndex: product.productIndex || "",
    skuCode: product.skuCode || "",
    name: product.name || "",
    imageUrl: product.imageUrl || "",
    specification: product.specification || "",
    productionDate: product.productionDate || "",
    stock,
    warningStock,
    stockStatus,
    statusText: stockStatus === "out_of_stock" ? "out_of_stock" : (stockStatus === "warning" ? "warning" : "normal"),
    isActive: product.isActive !== false,
    autoHideWhenOutOfStock: product.autoHideWhenOutOfStock === true,
    updatedAt: product.updatedAt || null,
    message: stockStatus === "normal" ? "搴撳瓨姝ｅ父" : buildStockAlertMessage({ ...product, stock, warningStock })
  };
}

exports.main = async (event = {}) => {
  try {
    await requirePermission("inventory:view");
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const status = ["warning", "out_of_stock", "normal", "all", "all_products"].includes(event.status) ? event.status : "all";
    const keyword = normalizeSearchText(event.keyword || "");
    const displayAllProducts = status === "all_products" || Boolean(keyword);
    const products = await getProductsForRequest();
    const filtered = products
      .map(shape)
      .filter((item) => {
        if (status === "all") return displayAllProducts || item.stockStatus !== "normal";
        if (status === "all_products") return true;
        return item.stockStatus === status;
      })
      .filter((item) => matchesKeyword(item, keyword))
      .sort((a, b) => {
        const statusDiff = statusRank(a.stockStatus) - statusRank(b.stockStatus);
        if (statusDiff) return statusDiff;
        const stockDiff = Number(a.stock || 0) - Number(b.stock || 0);
        if (stockDiff) return stockDiff;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      });

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const list = filtered.slice(start, start + pageSize);
    const summarySource = products.map(shape);
    const summary = {
      warningCount: summarySource.filter((item) => item.stockStatus === "warning").length,
      outOfStockCount: summarySource.filter((item) => item.stockStatus === "out_of_stock").length,
      total
    };

    return { ok: true, data: { list, total, page, pageSize, hasMore: start + pageSize < total, summary } };
  } catch (err) {
    return { ok: false, message: err.message || "鑾峰彇搴撳瓨棰勮澶辫触" };
  }
};

