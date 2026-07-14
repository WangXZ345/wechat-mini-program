const cloud = require("wx-server-sdk");

const { buildStockAlertMessage, getStockStatus, normalizeWarningStock } = require("./stockAlert");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission, hasPermission } = require("./auth");
const { createProductAnalytics } = require("./productAnalytics");

const getProductAnalytics = createProductAnalytics({ cloud, db, _ });

async function count(collection, where = {}) {
  const res = await db.collection(collection).where(where).count();
  return res.total;
}

async function getAllProducts() {
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

function shapeStockAlert(product) {
  const warningStock = normalizeWarningStock(product.warningStock);
  const stock = Number(product.stock || 0);
  const stockStatus = product.stockStatus || getStockStatus(stock, warningStock);
  return {
    ...product,
    stock,
    warningStock,
    stockStatus,
    statusText: stockStatus === "out_of_stock" ? "已缺货" : (stockStatus === "warning" ? "低库存" : "库存正常"),
    message: stockStatus === "normal" ? "库存正常" : buildStockAlertMessage({ ...product, stock, warningStock })
  };
}

function sortStockAlerts(a, b) {
  const rank = { out_of_stock: 0, warning: 1, normal: 2 };
  const rankDiff = (rank[a.stockStatus] || 2) - (rank[b.stockStatus] || 2);
  if (rankDiff) return rankDiff;
  return Number(a.stock || 0) - Number(b.stock || 0);
}

exports.main = async (event = {}) => {
  try {
    if (event.action === "getProductAnalytics") {
      return { ok: true, data: await getProductAnalytics(event) };
    }

    const admin = await requirePermission("dashboard:view_basic");
    const canViewInventory = hasPermission(admin, "dashboard:view_inventory");
    const products = canViewInventory ? await getAllProducts() : [];
    const stockAlerts = products
      .map(shapeStockAlert)
      .filter((item) => item.stockStatus === "warning" || item.stockStatus === "out_of_stock")
      .sort(sortStockAlerts);
    const zeroStockPricedProducts = products.filter((item) => (
      item.isActive === true
      && Number(item.stock || 0) <= 0
      && Number(item.price || 0) > 0
    )).length;
    const stats = {
      products: await count("products", { isActive: true }),
      zeroStockPricedProducts,
      pendingAdminOrders: hasPermission(admin, "order:view") ? await count("orders", { status: "pending_admin" }) : 0,
      pendingPaymentConfirm: hasPermission(admin, "dashboard:view_finance") ? await count("orders", { status: "pending_payment_confirm" }) : 0,
      unpaidOrders: hasPermission(admin, "dashboard:view_finance") ? await count("orders", { paymentStatus: _.in(["none", "pending_confirm", "unpaid", "partial", "abnormal"]) }) : 0,
      stockWarningProducts: stockAlerts.filter((item) => item.stockStatus === "warning").length,
      outOfStockProducts: stockAlerts.filter((item) => item.stockStatus === "out_of_stock").length
    };
    const notifications = await db.collection("admin_notifications").where({ isRead: false }).orderBy("createdAt", "desc").limit(20).get();

    return { ok: true, data: { stats, stockAlerts: stockAlerts.slice(0, 5), notifications: notifications.data } };
  } catch (err) {
    return { ok: false, message: err.message || "获取后台数据失败" };
  }
};

