const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requireAnyPermission } = require("./auth");

const CHINA_OFFSET = 8 * 60 * 60 * 1000;
const DB_PAGE_SIZE = 100;
const MAX_ROWS = 5000;
const IN_BATCH_SIZE = 20;
const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90
};

const EFFECTIVE_ORDER_STATUSES = [
  "approved_pending_payment",
  "pending_payment_confirm",
  "paid",
  "partial_paid",
  "shipped",
  "completed"
];

const EFFECTIVE_PAYMENT_STATUSES = [
  "paid",
  "partial",
  "partial_paid",
  "pending_confirm"
];

const INVALID_ORDER_STATUSES = [
  "rejected",
  "cancelled",
  "canceled",
  "refunded",
  "void",
  "closed"
];

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

async function safeQuery(collection, where = {}, options = {}) {
  try {
    let query = db.collection(collection).where(where || {});
    if (options.orderBy) query = query.orderBy(options.orderBy, options.orderDirection || "desc");
    if (options.skip) query = query.skip(options.skip);
    return (await query.limit(options.limit || DB_PAGE_SIZE).get()).data || [];
  } catch (err) {
    if (isMissingCollection(err)) return [];
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

function parseDateOnly(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0) - CHINA_OFFSET);
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

function cents(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number);
}

function normalizeRange(event = {}) {
  const range = RANGE_DAYS[event.range] ? event.range : (event.range === "custom" ? "custom" : "30d");
  if (range !== "custom") {
    const days = RANGE_DAYS[range];
    const now = new Date();
    return {
      range,
      days,
      start: startOfShanghaiDay(now, -(days - 1)),
      end: startOfShanghaiDay(now, 1)
    };
  }

  const start = parseDateOnly(event.startDate);
  const endDate = parseDateOnly(event.endDate);
  if (!start || !endDate) throw new Error("自定义日期范围无效");
  const end = startOfShanghaiDay(endDate, 1);
  const days = Math.ceil((end.getTime() - start.getTime()) / 86400000);
  if (days <= 0) throw new Error("结束日期必须晚于开始日期");
  if (days > 90) throw new Error("自定义日期范围最多支持 90 天");
  return { range, days, start, end };
}

function dateRangeWhere(start, end) {
  return { createdAt: _.gte(start).and(_.lt(end)) };
}

function isEffectiveOrder(order = {}) {
  const status = order.status || order.orderStatus || "";
  const paymentStatus = order.paymentStatus || "";
  const refundStatus = order.refundStatus || order.afterSaleStatus || "";
  if (INVALID_ORDER_STATUSES.includes(status)) return false;
  if (paymentStatus === "refunded") return false;
  if (["full_refunded", "refunded", "refund_completed"].includes(refundStatus)) return false;
  return EFFECTIVE_ORDER_STATUSES.includes(status)
    || EFFECTIVE_PAYMENT_STATUSES.includes(paymentStatus)
    || ["shipped", "delivered", "completed"].includes(order.shippingStatus || order.deliveryStatus || "");
}

function emptyBuckets(rangeInfo) {
  const buckets = {};
  for (let offset = 0; offset < rangeInfo.days; offset += 1) {
    const date = formatShanghaiDate(startOfShanghaiDay(rangeInfo.start, offset));
    buckets[date] = {
      date,
      quantity: 0,
      amount: 0,
      orderIds: new Set(),
      prices: []
    };
  }
  return buckets;
}

async function loadOrdersByIds(ids) {
  const map = {};
  for (const group of batches(Array.from(new Set(ids.filter(Boolean))))) {
    const rows = await safeQuery("orders", { _id: _.in(group) }, { limit: 100 });
    rows.forEach((order) => {
      map[order._id] = order;
    });
  }
  return map;
}

async function loadOrdersInRange(start, end) {
  const rows = await getPaged("orders", dateRangeWhere(start, end), MAX_ROWS, "createdAt", "desc");
  return rows.filter(isEffectiveOrder);
}

async function loadItemsFromOrders(productId, orders) {
  const orderIds = orders.map((order) => order._id).filter(Boolean);
  const rows = [];
  for (const group of batches(orderIds)) {
    const page = await safeQuery("order_items", { orderId: _.in(group) }, { limit: 1000 });
    page.forEach((item) => {
      if (item.productId === productId) rows.push(item);
    });
  }
  orders.forEach((order) => {
    if (order.productId !== productId) return;
    if (rows.some((item) => item.orderId === order._id && item.productId === productId)) return;
    rows.push({
      orderId: order._id,
      productId,
      quantity: order.quantity || 1,
      unitPrice: order.unitPrice || 0,
      totalAmount: order.totalAmount || 0,
      createdAt: order.createdAt
    });
  });
  return { rows, orderMap: orders.reduce((map, order) => ({ ...map, [order._id]: order }), {}) };
}

async function loadProductItems(productId, rangeInfo) {
  const directRows = await getPaged("order_items", {
    productId,
    ...dateRangeWhere(rangeInfo.start, rangeInfo.end)
  }, MAX_ROWS, "createdAt", "desc");

  if (directRows.length) {
    const orderMap = await loadOrdersByIds(directRows.map((item) => item.orderId));
    return {
      rows: directRows.filter((item) => isEffectiveOrder(orderMap[item.orderId] || {})),
      orderMap
    };
  }

  const orders = await loadOrdersInRange(rangeInfo.start, rangeInfo.end);
  return loadItemsFromOrders(productId, orders);
}

function itemQuantity(item = {}) {
  const quantity = Number(item.quantity || item.count || 0);
  return Number.isFinite(quantity) ? quantity : 0;
}

function itemAmount(item = {}, quantity) {
  if (item.subtotal !== undefined) return cents(item.subtotal);
  if (item.totalAmount !== undefined) return cents(item.totalAmount);
  if (item.amount !== undefined) return cents(item.amount);
  return cents(Number(item.unitPrice || item.price || 0) * quantity);
}

function itemUnitPrice(item = {}, quantity, amount) {
  const price = Number(item.unitPrice !== undefined ? item.unitPrice : item.price);
  if (Number.isFinite(price) && price >= 0) return Math.round(price);
  return quantity > 0 ? Math.round(amount / quantity) : 0;
}

function buildSales(productId, rangeInfo, rows, orderMap) {
  const buckets = emptyBuckets(rangeInfo);
  const allPrices = [];
  const orderIds = new Set();
  let totalQuantity = 0;
  let totalAmount = 0;

  rows.forEach((item) => {
    if (item.productId !== productId) return;
    const order = orderMap[item.orderId] || {};
    const date = formatShanghaiDate(item.createdAt || order.approvedAt || order.createdAt);
    if (!buckets[date]) return;
    const quantity = itemQuantity(item);
    if (quantity <= 0) return;
    const amount = itemAmount(item, quantity);
    const unitPrice = itemUnitPrice(item, quantity, amount);
    buckets[date].quantity += quantity;
    buckets[date].amount += amount;
    buckets[date].orderIds.add(item.orderId || order._id || "");
    buckets[date].prices.push(unitPrice);
    allPrices.push(unitPrice);
    totalQuantity += quantity;
    totalAmount += amount;
    if (item.orderId || order._id) orderIds.add(item.orderId || order._id);
  });

  const salesTrend = Object.keys(buckets).sort().map((date) => ({
    date,
    quantity: buckets[date].quantity,
    amount: buckets[date].amount,
    orderCount: Array.from(buckets[date].orderIds).filter(Boolean).length
  }));
  const dealPriceTrend = Object.keys(buckets).sort().map((date) => {
    const bucket = buckets[date];
    const avgPrice = bucket.quantity > 0 ? Math.round(bucket.amount / bucket.quantity) : 0;
    return {
      date,
      avgPrice,
      maxPrice: bucket.prices.length ? Math.max(...bucket.prices) : 0,
      minPrice: bucket.prices.length ? Math.min(...bucket.prices) : 0
    };
  });

  return {
    summary: {
      totalQuantity,
      totalAmount,
      orderCount: orderIds.size,
      avgDealPrice: totalQuantity > 0 ? Math.round(totalAmount / totalQuantity) : 0,
      maxDealPrice: allPrices.length ? Math.max(...allPrices) : 0,
      minDealPrice: allPrices.length ? Math.min(...allPrices) : 0
    },
    salesTrend,
    dealPriceTrend
  };
}

function logPrice(log = {}) {
  const value = log.afterPrice !== undefined ? log.afterPrice
    : (log.newPrice !== undefined ? log.newPrice : log.price);
  const price = cents(value);
  return price >= 0 ? price : 0;
}

async function loadPriceTrend(productId, rangeInfo, currentPrice) {
  const rows = await getPaged("price_logs", {
    productId,
    ...dateRangeWhere(rangeInfo.start, rangeInfo.end)
  }, MAX_ROWS, "createdAt", "asc");

  const trend = rows
    .filter((row) => toDate(row.createdAt))
    .map((row) => ({
      date: formatShanghaiDate(row.createdAt),
      price: logPrice(row),
      source: row.sourceType || row.changeType || "price_logs"
    }))
    .filter((row) => row.price > 0);

  if (trend.length) {
    const todayStart = startOfShanghaiDay(new Date());
    const todayInRange = todayStart.getTime() >= rangeInfo.start.getTime() && todayStart.getTime() < rangeInfo.end.getTime();
    const today = formatShanghaiDate(todayStart);
    const last = trend[trend.length - 1];
    if (todayInRange && (last.date !== today || last.price !== currentPrice)) {
      trend.push({ date: today, price: currentPrice, source: "current_product" });
    }
  }
  return trend;
}

function shapeProduct(product = {}) {
  return {
    productId: product._id || product.id || "",
    name: product.name || "",
    brand: product.brand || "",
    category: product.category || "",
    specification: product.specification || "",
    currentPrice: cents(product.price),
    currentStock: Number(product.stock || 0),
    imageUrl: product.imageUrl || "",
    tags: Array.isArray(product.tags) ? product.tags : []
  };
}

exports.main = async (event = {}) => {
  try {
    await requireAnyPermission(["product:analytics:view", "dashboard:view_product"]);
    const productId = String(event.productId || "").trim();
    if (!productId) return fail("缺少商品 ID");

    const rangeInfo = normalizeRange(event);
    const product = (await db.collection("products").doc(productId).get()).data;
    if (!product || product.isDeleted === true) return fail("商品不存在或已删除");

    const { rows, orderMap } = await loadProductItems(productId, rangeInfo);
    const sales = buildSales(productId, rangeInfo, rows, orderMap);
    const shapedProduct = shapeProduct(product);
    const listPriceTrend = await loadPriceTrend(productId, rangeInfo, shapedProduct.currentPrice);
    const noPriceLogs = listPriceTrend.length === 0;

    return ok({
      range: {
        value: rangeInfo.range,
        days: rangeInfo.days,
        startDate: formatShanghaiDate(rangeInfo.start),
        endDate: formatShanghaiDate(startOfShanghaiDay(rangeInfo.end, -1))
      },
      product: shapedProduct,
      summary: {
        ...sales.summary,
        currentPrice: shapedProduct.currentPrice
      },
      salesTrend: sales.salesTrend,
      dealPriceTrend: sales.dealPriceTrend,
      listPriceTrend,
      message: noPriceLogs ? "历史报价变动记录不足，当前仅展示成交均价；报价变化将从本次功能上线后开始记录。" : ""
    });
  } catch (err) {
    return fail(err.message || "获取商品分析失败");
  }
};
