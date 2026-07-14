const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission, hasPermission } = require("./auth");

const DEFAULT_WARNING_STOCK = 10;
const CACHE_TTL = 0;
const CHINA_OFFSET = 8 * 60 * 60 * 1000;
const DB_PAGE_SIZE = 100;
const MAX_RECENT_ORDERS = 3000;
const MAX_PRODUCTS = 3000;
const MAX_ACCOUNTS = 1000;
const IN_BATCH_SIZE = 20;

const RANGE_DAYS = {
  today: 1,
  "3d": 3,
  "7d": 7,
  "30d": 30
};

const EFFECTIVE_ORDER_STATUSES = [
  "auto_reviewing",
  "pending_admin",
  "approved_pending_payment",
  "pending_payment_confirm",
  "paid",
  "unpaid",
  "partial_paid",
  "abnormal",
  "shipped",
  "completed"
];

const INVALID_ORDER_STATUSES = [
  "rejected",
  "cancelled",
  "refunded"
];

const UNPAID_PAYMENT_STATUSES = [
  "none",
  "unpaid",
  "pending_confirm",
  "partial",
  "partial_paid",
  "abnormal"
];

let cached = {
  key: "",
  expiresAt: 0,
  data: null
};

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return { openid, adminId: res.data[0]._id };
}

function isCollectionNotExists(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

async function safeCount(collection, where = {}) {
  try {
    const res = await db.collection(collection).where(where).count();
    return Number(res.total || 0);
  } catch (err) {
    if (isCollectionNotExists(err)) return 0;
    throw err;
  }
}

async function safeQuery(collection, where = {}, options = {}) {
  try {
    let query = db.collection(collection).where(where || {});
    if (options.orderBy) query = query.orderBy(options.orderBy, options.orderDirection || "desc");
    if (options.skip) query = query.skip(options.skip);
    return (await query.limit(options.limit || DB_PAGE_SIZE).get()).data || [];
  } catch (err) {
    if (isCollectionNotExists(err)) return [];
    throw err;
  }
}

async function getPaged(collection, where = {}, maxRows = DB_PAGE_SIZE, orderBy = "", orderDirection = "desc") {
  let rows = [];
  let skip = 0;
  while (rows.length < maxRows) {
    const page = await safeQuery(collection, where, {
      orderBy,
      orderDirection,
      skip,
      limit: Math.min(DB_PAGE_SIZE, maxRows - rows.length)
    });
    rows = rows.concat(page);
    if (page.length < DB_PAGE_SIZE) break;
    skip += DB_PAGE_SIZE;
  }
  return rows;
}

function batches(list, size = IN_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
  return result;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value.$date) return new Date(value.$date);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function shanghaiParts(date = new Date()) {
  const shifted = new Date(date.getTime() + CHINA_OFFSET);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate()
  };
}

function startOfShanghaiDay(date = new Date(), dayOffset = 0) {
  const parts = shanghaiParts(date);
  return new Date(Date.UTC(parts.year, parts.month, parts.day + dayOffset, 0, 0, 0, 0) - CHINA_OFFSET);
}

function formatShanghaiDate(value) {
  const date = toDate(value);
  if (!date) return "";
  const shifted = new Date(date.getTime() + CHINA_OFFSET);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function formatShanghaiDateTime(value) {
  const date = toDate(value);
  if (!date) return "";
  const shifted = new Date(date.getTime() + CHINA_OFFSET);
  return `${formatShanghaiDate(date)} ${[
    String(shifted.getUTCHours()).padStart(2, "0"),
    String(shifted.getUTCMinutes()).padStart(2, "0")
  ].join(":")}`;
}

function parseDateOnly(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return toDate(text);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0) - CHINA_OFFSET);
}

function getRange(event = {}) {
  const range = RANGE_DAYS[event.range] ? event.range : "today";
  const days = RANGE_DAYS[range];
  const now = new Date();
  return {
    range,
    days,
    start: startOfShanghaiDay(now, -(days - 1)),
    todayStart: startOfShanghaiDay(now),
    tomorrowStart: startOfShanghaiDay(now, 1),
    end: now
  };
}

function dateRangeWhere(start, end) {
  return { createdAt: _.gte(start).and(_.lt(end)) };
}

function cents(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number);
}

function orderTotal(order = {}) {
  return cents(order.totalAmount !== undefined ? order.totalAmount : order.amount);
}

function paidAmount(order = {}) {
  if (order.paymentStatus === "paid" || order.status === "paid") {
    return cents(order.paidAmount || orderTotal(order));
  }
  return cents(order.paidAmount);
}

function unpaidAmount(order = {}) {
  const total = orderTotal(order);
  if (order.paymentStatus === "paid" || order.status === "paid") return 0;
  if (order.paymentStatus === "partial" || order.paymentStatus === "partial_paid" || order.status === "partial_paid") {
    return Math.max(0, total - paidAmount(order));
  }
  if (order.unpaidAmount !== undefined) return Math.max(0, cents(order.unpaidAmount));
  return total;
}

function isEffectiveOrder(order = {}) {
  if (INVALID_ORDER_STATUSES.includes(order.status)) return false;
  if (order.paymentStatus === "refunded") return false;
  return EFFECTIVE_ORDER_STATUSES.includes(order.status) || UNPAID_PAYMENT_STATUSES.includes(order.paymentStatus);
}

function isPendingReview(order = {}) {
  return order.status === "pending_admin" || order.status === "寰呯鐞嗗憳瀹℃牳";
}

function isPendingPaymentConfirm(order = {}) {
  return order.status === "pending_payment_confirm" || order.paymentStatus === "pending_confirm";
}

function isPendingDelivery(order = {}) {
  return order.deliveryStatus === "waiting_shipping" || order.deliveryStatus === "pending_shipping";
}

function daysSince(value, now = new Date()) {
  const date = toDate(value) || parseDateOnly(value);
  if (!date) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86400000));
}

function daysUntil(value, now = new Date()) {
  const date = toDate(value) || parseDateOnly(value);
  if (!date) return null;
  return Math.ceil((date.getTime() - now.getTime()) / 86400000);
}

function activeProduct(product = {}) {
  return product.isActive !== false;
}

function warningStock(product = {}) {
  const value = product.warningStock;
  if (value !== undefined && value !== null && value !== "") return Number(value);
  return DEFAULT_WARNING_STOCK;
}

function productName(product = {}, fallback = {}) {
  return product.name || fallback.productName || fallback.name || "Product deleted";
}

function productSpec(product = {}, fallback = {}) {
  return product.specification || fallback.specification || "";
}

function productProductionDate(product = {}, fallback = {}) {
  return product.productionDate || fallback.productionDate || "";
}

async function loadOrdersByIds(ids) {
  const map = {};
  for (const group of batches(ids)) {
    const rows = await safeQuery("orders", { _id: _.in(group) }, { limit: 100 });
    rows.forEach((order) => {
      map[order._id] = order;
    });
  }
  return map;
}

async function loadProductsByIds(ids) {
  const map = {};
  for (const group of batches(ids)) {
    const rows = await safeQuery("products", { _id: _.in(group) }, { limit: 100 });
    rows.forEach((product) => {
      map[product._id] = product;
    });
  }
  return map;
}

async function loadOrdersInRange(start, end) {
  const orders = await getPaged("orders", dateRangeWhere(start, end), MAX_RECENT_ORDERS, "createdAt", "desc");
  return orders.filter(isEffectiveOrder);
}

async function loadItemsForOrders(orders) {
  const orderMap = {};
  const itemMap = {};
  orders.forEach((order) => {
    orderMap[order._id] = order;
    itemMap[order._id] = [];
  });

  for (const group of batches(Object.keys(orderMap))) {
    const rows = await safeQuery("order_items", { orderId: _.in(group) }, { limit: 1000 });
    rows.forEach((item) => {
      if (!itemMap[item.orderId]) itemMap[item.orderId] = [];
      itemMap[item.orderId].push(item);
    });
  }

  orders.forEach((order) => {
    if (itemMap[order._id] && itemMap[order._id].length) return;
    if (!order.productId) return;
    itemMap[order._id] = [{
      orderId: order._id,
      productId: order.productId,
      productName: order.productName,
      specification: order.specification || "",
      productionDate: order.productionDate || "",
      quantity: order.quantity || 1,
      unitPrice: order.unitPrice || 0,
      totalAmount: order.totalAmount || 0,
      createdAt: order.createdAt
    }];
  });

  return itemMap;
}

function summarizeOrders(orders) {
  return orders.reduce((summary, order) => {
    summary.orderCount += 1;
    summary.salesAmount += orderTotal(order);
    summary.paidAmount += paidAmount(order);
    summary.unpaidAmount += unpaidAmount(order);
    return summary;
  }, { orderCount: 0, salesAmount: 0, paidAmount: 0, unpaidAmount: 0 });
}

function buildSalesTrend(orders, rangeInfo) {
  const buckets = {};
  const days = Math.min(Math.max(rangeInfo.days, 1), 30);
  for (let offset = -(days - 1); offset <= 0; offset += 1) {
    const date = formatShanghaiDate(startOfShanghaiDay(rangeInfo.end, offset));
    buckets[date] = { date, orderCount: 0, salesAmount: 0, paidAmount: 0, unpaidAmount: 0 };
  }
  orders.forEach((order) => {
    const date = formatShanghaiDate(order.createdAt);
    if (!buckets[date]) return;
    buckets[date].orderCount += 1;
    buckets[date].salesAmount += orderTotal(order);
    buckets[date].paidAmount += paidAmount(order);
    buckets[date].unpaidAmount += unpaidAmount(order);
  });
  return Object.keys(buckets).sort().map((date) => buckets[date]);
}

async function buildTopSellingProducts(orders, itemMap) {
  const sales = {};
  orders.forEach((order) => {
    (itemMap[order._id] || []).forEach((item) => {
      const productId = item.productId || "";
      if (!productId) return;
      if (!sales[productId]) {
        sales[productId] = {
          productId,
          productName: item.productName || "",
          specification: item.specification || "",
          productionDate: item.productionDate || "",
          soldQuantity: 0,
          salesAmount: 0,
          currentStock: 0
        };
      }
      sales[productId].soldQuantity += Number(item.quantity || 0);
      sales[productId].salesAmount += cents(item.totalAmount || (Number(item.quantity || 0) * Number(item.unitPrice || 0)));
    });
  });

  const rows = Object.values(sales).sort((a, b) => b.soldQuantity - a.soldQuantity || b.salesAmount - a.salesAmount).slice(0, 10);
  const productMap = await loadProductsByIds(rows.map((item) => item.productId));
  return rows.map((item) => {
    const product = productMap[item.productId] || {};
    return {
      ...item,
      productName: productName(product, item),
      specification: productSpec(product, item),
      productionDate: productProductionDate(product, item),
      currentStock: Number(product.stock || 0)
    };
  });
}

async function loadProductRows() {
  const products = await getPaged("products", {}, MAX_PRODUCTS, "updatedAt", "desc");
  return products.filter((product) => product.isDeleted !== true);
}

function buildLowStockProducts(products) {
  return products
    .filter((product) => Number(product.stock || 0) <= warningStock(product))
    .sort((a, b) => Number(a.stock || 0) - Number(b.stock || 0))
    .slice(0, 10)
    .map((product) => ({
      productId: product._id,
      productName: product.name || "",
      specification: product.specification || "",
      productionDate: product.productionDate || "",
      stock: Number(product.stock || 0),
      warningStock: warningStock(product),
      isActive: activeProduct(product),
      isOutOfStock: Number(product.stock || 0) <= 0
    }));
}

function buildExpiringProducts(products) {
  const now = new Date();
  return products
    .map((product) => {
      const expiryDays = daysUntil(product.expiryDate, now);
      const productionAgeDays = daysSince(product.productionDate, now);
      let reason = "";
      let level = "normal";
      if (expiryDays !== null && expiryDays >= 0 && expiryDays <= 90) {
        reason = expiryDays <= 30 ? "涓ラ噸涓存湡" : "涓存湡";
        level = expiryDays <= 30 ? "danger" : "warning";
      } else if (expiryDays === null && productionAgeDays !== null && productionAgeDays >= 540) {
        reason = "鐢熶骇鏃ユ湡杈冩棭";
        level = "warning";
      }
      if (!reason) return null;
      return {
        productId: product._id,
        productName: product.name || "",
        specification: product.specification || "",
        productionDate: product.productionDate || "",
        expiryDate: product.expiryDate || "",
        stock: Number(product.stock || 0),
        daysToExpiry: expiryDays,
        reason,
        level
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const left = a.daysToExpiry === null ? 99999 : a.daysToExpiry;
      const right = b.daysToExpiry === null ? 99999 : b.daysToExpiry;
      return left - right;
    })
    .slice(0, 10);
}

async function buildSlowMovingProducts(products, orders, itemMap, rangeInfo) {
  const soldInRange = new Set();
  const lastSold = {};

  orders.forEach((order) => {
    const saleTime = toDate(order.approvedAt) || toDate(order.createdAt);
    (itemMap[order._id] || []).forEach((item) => {
      if (!item.productId) return;
      soldInRange.add(item.productId);
      if (saleTime && (!lastSold[item.productId] || saleTime.getTime() > lastSold[item.productId].getTime())) {
        lastSold[item.productId] = saleTime;
      }
    });
  });

  return products
    .filter((product) => activeProduct(product) && Number(product.stock || 0) > 0 && !soldInRange.has(product._id))
    .sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0))
    .slice(0, 10)
    .map((product) => {
      const latest = lastSold[product._id] || toDate(product.lastSoldAt);
      return {
        productId: product._id,
        productName: product.name || "",
        specification: product.specification || "",
        productionDate: product.productionDate || "",
        currentStock: Number(product.stock || 0),
        lastSoldAt: latest ? formatShanghaiDateTime(latest) : "No sales record",
        daysWithoutSale: latest ? daysSince(latest, rangeInfo.end) : null,
        suggestion: "闄嶄环 / 涓嬫灦 / 浼樺厛鎺ㄨ崘"
      };
    });
}

async function buildUnpaidCustomersFromAccounts() {
  const accounts = await getPaged("customer_accounts", {}, MAX_ACCOUNTS, "updatedAt", "desc");
  if (!accounts.length) return { list: [], totalAmount: 0, count: 0, hasAccounts: false };

  const unpaidRows = accounts
    .map((account) => {
      const unpaid = cents(account.totalUnpaidAmount !== undefined ? account.totalUnpaidAmount : account.unpaidAmount);
      const lastOrderAt = toDate(account.lastOrderAt);
      const lastPaidAt = toDate(account.lastPaymentAt || account.lastPaidAt);
      return {
        userId: account.userId || account.userOpenid || "",
        nickname: account.nickname || account.phone || "Unnamed customer",
        openid: account.userOpenid || "",
        unpaidAmount: unpaid,
        lastOrderAt: formatShanghaiDateTime(lastOrderAt),
        lastPaidAt: formatShanghaiDateTime(lastPaidAt),
        unpaidDays: lastPaidAt ? daysSince(lastPaidAt) : (lastOrderAt ? daysSince(lastOrderAt) : null),
        remark: account.adminNote || account.adminRemark || account.customerRemark || ""
      };
    })
    .filter((item) => item.unpaidAmount > 0);

  const totalAmount = unpaidRows.reduce((sum, item) => sum + item.unpaidAmount, 0);
  unpaidRows.sort((a, b) => b.unpaidAmount - a.unpaidAmount);
  return {
    list: unpaidRows.slice(0, 10),
    totalAmount,
    count: unpaidRows.length,
    hasAccounts: true
  };
}

function buildUnpaidCustomersFromOrders(orders) {
  const map = {};
  orders.forEach((order) => {
    const amount = unpaidAmount(order);
    if (amount <= 0) return;
    const key = order.userId || order.userOpenid || "unknown";
    if (!map[key]) {
      map[key] = {
        userId: order.userId || order.userOpenid || "",
        nickname: order.nickname || order.userName || "Unnamed customer",
        openid: order.userOpenid || "",
        unpaidAmount: 0,
        lastOrderAtRaw: null,
        lastPaidAtRaw: null,
        remark: order.customerRemark || ""
      };
    }
    map[key].unpaidAmount += amount;
    const createdAt = toDate(order.createdAt);
    const paidAt = toDate(order.paymentConfirmedAt || order.paidMarkedAt);
    if (createdAt && (!map[key].lastOrderAtRaw || createdAt.getTime() > map[key].lastOrderAtRaw.getTime())) map[key].lastOrderAtRaw = createdAt;
    if (paidAt && (!map[key].lastPaidAtRaw || paidAt.getTime() > map[key].lastPaidAtRaw.getTime())) map[key].lastPaidAtRaw = paidAt;
  });

  const rows = Object.values(map).map((item) => ({
    userId: item.userId,
    nickname: item.nickname,
    openid: item.openid,
    unpaidAmount: item.unpaidAmount,
    lastOrderAt: formatShanghaiDateTime(item.lastOrderAtRaw),
    lastPaidAt: formatShanghaiDateTime(item.lastPaidAtRaw),
    unpaidDays: item.lastPaidAtRaw ? daysSince(item.lastPaidAtRaw) : (item.lastOrderAtRaw ? daysSince(item.lastOrderAtRaw) : null),
    remark: item.remark
  })).sort((a, b) => b.unpaidAmount - a.unpaidAmount);

  return {
    list: rows.slice(0, 10),
    totalAmount: rows.reduce((sum, item) => sum + item.unpaidAmount, 0),
    count: rows.length,
    hasAccounts: false
  };
}

async function buildInsufficientStockOrders() {
  const rows = await safeQuery("order_items", { stockCheckStatus: "insufficient" }, { limit: 10, orderBy: "createdAt", orderDirection: "desc" });
  const orderMap = await loadOrdersByIds(rows.map((item) => item.orderId).filter(Boolean));
  return rows.map((item) => {
    const order = orderMap[item.orderId] || {};
    return {
      orderId: item.orderId || "",
      orderNo: order.orderNo || "",
      productName: item.productName || order.productName || "",
      quantity: Number(item.quantity || 0),
      createdAt: formatShanghaiDateTime(order.createdAt || item.createdAt)
    };
  });
}

function shapeOrderTodo(order) {
  return {
    orderId: order._id,
    orderNo: order.orderNo || "",
    status: order.status || "",
    paymentStatus: order.paymentStatus || "",
    totalAmount: orderTotal(order),
    createdAt: formatShanghaiDateTime(order.createdAt)
  };
}

async function buildDashboard(event = {}, admin = {}) {
  const rangeInfo = getRange(event);
  const canViewSales = hasPermission(admin, "dashboard:view_sales") || hasPermission(admin, "dashboard:view_finance");
  const canViewFinance = hasPermission(admin, "dashboard:view_finance") || hasPermission(admin, "customer:view_account");
  const canViewOrderSummary = hasPermission(admin, "order:view");
  const canViewDeliverySummary = hasPermission(admin, "shipment:view") || hasPermission(admin, "order:ship");
  const canViewInventory = hasPermission(admin, "dashboard:view_inventory") || hasPermission(admin, "inventory:view");
  const canViewProducts = hasPermission(admin, "product:view");
  const canConfirmPayment = hasPermission(admin, "payment:confirm");
  const [todayOrders, rangeOrders] = await Promise.all([
    loadOrdersInRange(rangeInfo.todayStart, rangeInfo.tomorrowStart),
    loadOrdersInRange(rangeInfo.start, rangeInfo.end)
  ]);
  const todaySummary = summarizeOrders(todayOrders);
  const rangeSummary = summarizeOrders(rangeOrders);

  const dashboardDependencies = await Promise.all([
    (canViewSales || canViewInventory) ? loadItemsForOrders(rangeOrders) : {},
    Promise.all([
      getPaged("orders", { status: _.in(["pending_admin", "寰呯鐞嗗憳瀹℃牳"]) }, 50, "createdAt", "desc"),
      canConfirmPayment || canViewFinance ? getPaged("orders", { status: _.in(["pending_payment_confirm"]) }, 50, "createdAt", "desc") : [],
      canConfirmPayment || canViewFinance ? getPaged("orders", { paymentStatus: "pending_confirm" }, 50, "createdAt", "desc") : [],
      getPaged("orders", { deliveryStatus: "waiting_shipping" }, 50, "createdAt", "desc")
    ]),
    (canViewProducts || canViewInventory) ? loadProductRows() : [],
    canViewFinance ? buildUnpaidCustomersFromAccounts() : { list: [], totalAmount: 0, count: 0, hasAccounts: true },
    canViewInventory ? buildInsufficientStockOrders() : []
  ]);
  const itemMap = dashboardDependencies[0];
  const [pendingReviewOrders, pendingPaymentStatusOrders, pendingPaymentPaymentOrders, pendingDeliveryOrders] = dashboardDependencies[1];
  const products = dashboardDependencies[2];
  const unpaidFromAccounts = dashboardDependencies[3];
  const insufficientStockOrders = dashboardDependencies[4];

  const pendingPaymentMap = {};
  pendingPaymentStatusOrders.concat(pendingPaymentPaymentOrders).forEach((order) => {
    pendingPaymentMap[order._id] = order;
  });
  const pendingPaymentOrders = Object.values(pendingPaymentMap);

  const lowStockProducts = canViewInventory ? buildLowStockProducts(products) : [];
  const expiringProducts = canViewInventory ? buildExpiringProducts(products) : [];
  const productCount = canViewProducts ? products.length : 0;
  const activeProductCount = canViewProducts ? products.filter(activeProduct).length : 0;
  const lowStockProductCount = canViewInventory ? products.filter((product) => Number(product.stock || 0) <= warningStock(product)).length : 0;
  const outOfStockProductCount = canViewInventory ? products.filter((product) => Number(product.stock || 0) <= 0).length : 0;

  const unpaidData = unpaidFromAccounts.hasAccounts
    ? unpaidFromAccounts
    : buildUnpaidCustomersFromOrders(await getPaged("orders", { paymentStatus: _.in(UNPAID_PAYMENT_STATUSES) }, MAX_RECENT_ORDERS, "createdAt", "desc"));

  const [topSellingProducts, slowMovingProducts] = await Promise.all([
    (canViewSales && canViewProducts) ? buildTopSellingProducts(rangeOrders, itemMap) : [],
    canViewInventory ? buildSlowMovingProducts(products, rangeOrders, itemMap, rangeInfo) : []
  ]);

  return {
    range: {
      value: rangeInfo.range,
      days: rangeInfo.days,
      startDate: formatShanghaiDate(rangeInfo.start),
      endDate: formatShanghaiDate(rangeInfo.end)
    },
    updatedAt: formatShanghaiDateTime(new Date()),
    summary: {
      todayOrderCount: canViewOrderSummary ? todaySummary.orderCount : 0,
      todaySalesAmount: canViewSales ? todaySummary.salesAmount : 0,
      todayPaidAmount: canViewFinance ? todaySummary.paidAmount : 0,
      todayUnpaidAmount: canViewFinance ? todaySummary.unpaidAmount : 0,
      rangeOrderCount: canViewOrderSummary ? rangeSummary.orderCount : 0,
      rangeSalesAmount: canViewSales ? rangeSummary.salesAmount : 0,
      rangePaidAmount: canViewFinance ? rangeSummary.paidAmount : 0,
      rangeUnpaidAmount: canViewFinance ? rangeSummary.unpaidAmount : 0,
      pendingReviewOrderCount: canViewOrderSummary ? pendingReviewOrders.filter(isPendingReview).length : 0,
      pendingPaymentConfirmCount: (canViewFinance || canConfirmPayment) ? pendingPaymentOrders.filter(isPendingPaymentConfirm).length : 0,
      pendingDeliveryOrderCount: canViewDeliverySummary ? pendingDeliveryOrders.filter(isPendingDelivery).length : 0,
      productCount,
      activeProductCount,
      lowStockProductCount,
      outOfStockProductCount,
      expiringProductCount: expiringProducts.length,
      overdueCustomerCount: canViewFinance ? unpaidData.count : 0,
      totalUnpaidAmount: canViewFinance ? unpaidData.totalAmount : 0
    },
    todoList: {
      pendingReviewOrders: canViewOrderSummary ? pendingReviewOrders.slice(0, 10).map(shapeOrderTodo) : [],
      insufficientStockOrders,
      pendingPaymentOrders: (canViewFinance || canConfirmPayment) ? pendingPaymentOrders.slice(0, 10).map(shapeOrderTodo) : [],
      lowStockProducts,
      expiringProducts,
      overdueCustomers: canViewFinance ? unpaidData.list : []
    },
    salesTrend: canViewSales ? buildSalesTrend(rangeOrders, rangeInfo) : [],
    topSellingProducts,
    slowMovingProducts,
    lowStockProducts,
    unpaidCustomers: unpaidData.list
  };
}

exports.main = async (event = {}) => {
  try {
    const admin = await requirePermission("dashboard:view_basic");
    const range = RANGE_DAYS[event.range] ? event.range : "today";
    const timezone = event.timezone || "Asia/Shanghai";
    const cacheKey = `${range}|${timezone}`;
    const now = Date.now();
    if (cached.key === cacheKey && cached.expiresAt > now && cached.data) return ok(cached.data);

    const data = await buildDashboard({ ...event, range, timezone }, admin);
    cached = {
      key: cacheKey,
      expiresAt: now + CACHE_TTL,
      data
    };
    return ok(data);
  } catch (err) {
    return fail(err.message || "鑾峰彇鍚庡彴棣栭〉鏁版嵁澶辫触");
  }
};

