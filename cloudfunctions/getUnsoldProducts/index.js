const cloud = require("wx-server-sdk");
const xlsx = require("xlsx");
const stockAlert = require("./stockAlert");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requireAnyPermission, requirePermission } = require("./auth");
const idempotency = require("./idempotency");
const { createProductStatusService } = require("./productStatusService");
const { createInventoryMutationService } = require("./inventoryMutationService");

const productStatusService = createProductStatusService({ db, idempotency });
const inventoryMutationService = createInventoryMutationService({ db, idempotency, stockAlert });

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const DB_PAGE_SIZE = 100;
const IN_BATCH_SIZE = 20;
const MAX_PRODUCT_SCAN = 5000;
const MAX_ORDER_SCAN = 10000;
const MAX_EXPORT_ROWS = 5000;
const CHINA_OFFSET = 8 * 60 * 60 * 1000;

const EFFECTIVE_ORDER_STATUSES = [
  "approved_pending_payment",
  "pending_payment_confirm",
  "paid",
  "partial_paid",
  "shipped",
  "completed"
];

const EFFECTIVE_DELIVERY_STATUSES = ["shipped", "completed"];
const EXCLUDED_ORDER_STATUSES = [
  "pending_system",
  "auto_reviewing",
  "pending_admin",
  "rejected",
  "cancelled",
  "unapproved",
  "refunded"
];
const EXCLUDED_PAYMENT_STATUSES = ["refunded"];

const SORTS = {
  stock_desc: { sortBy: "stock", sortOrder: "desc" },
  productionDate_asc: { sortBy: "productionDate", sortOrder: "asc" },
  price_desc: { sortBy: "price", sortOrder: "desc" },
  lastSoldAt_asc: { sortBy: "lastSoldAt", sortOrder: "asc" },
  createdAt_asc: { sortBy: "createdAt", sortOrder: "asc" }
};

const EXPORT_COLUMNS = [
  { title: "productIndex", key: "productIndex" },
  { title: "skuCode", key: "skuCode" },
  { title: "name", key: "name" },
  { title: "category", key: "category" },
  { title: "specification", key: "specification" },
  { title: "productionDate", key: "productionDate" },
  { title: "stock", key: "stock" },
  { title: "priceText", key: "priceText" },
  { title: "activeText", key: "activeText" },
  { title: "lastSoldAtText", key: "lastSoldAtText" },
  { title: "sales7d", key: "sales7d" },
  { title: "sales30d", key: "sales30d" },
  { title: "unsoldDaysText", key: "unsoldDaysText" },
  { title: "remark", key: "remark" },
];

function ok(data) {
  return { ok: true, data };
}

function fail(message, code, data) {
  return {
    ok: false,
    ...(code ? { code } : {}),
    message,
    ...(data ? { data } : {})
  };
}

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return { openid, adminId: res.data[0]._id };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) {
      const notSupported = /createCollection is not a function/i.test(message);
      if (notSupported) return;
      throw err;
    }
  }
}

function isCollectionNotExists(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/(20\d{2})\s*[\u5e74./-]\s*(\d{1,2})\s*(?:\u6708)?/g, (all, year, month) => `${year}-${String(month).padStart(2, "0")}`)
    .replace(/milliliter/g, "ml")
    .replace(/(\d+(?:\.\d+)?)\s*m\s*l\b/g, "$1ml")
    .replace(/[锛屻€併€傦紱;:锛殀/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildProductSearchText(product = {}) {
  const keywords = Array.isArray(product.keywords) ? product.keywords.join(" ") : product.keywords || "";
  return normalizeSearchText([
    product.name,
    product.baseName,
    product.specification,
    product.productionDate,
    product.description,
    keywords,
    product.productIndex,
    product.skuCode,
    product.category
  ].filter(Boolean).join(" "));
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value.$date) return new Date(value.$date);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function shanghaiDayParts(date = new Date()) {
  const shifted = new Date(date.getTime() + CHINA_OFFSET);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate()
  };
}

function startOfShanghaiDay(date = new Date(), dayOffset = 0) {
  const parts = shanghaiDayParts(date);
  return new Date(Date.UTC(parts.year, parts.month, parts.day + dayOffset, 0, 0, 0, 0) - CHINA_OFFSET);
}

function endOfShanghaiDay(date = new Date()) {
  const startNext = startOfShanghaiDay(date, 1);
  return new Date(startNext.getTime() - 1);
}

function parseDateOnlyStart(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0) - CHINA_OFFSET);
  }
  return toDate(text);
}

function parseDateOnlyEnd(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1, 0, 0, 0, 0) - CHINA_OFFSET - 1);
  }
  return toDate(text);
}

function normalizeRange(event = {}) {
  const now = new Date();
  const rangeType = event.rangeType || "today";
  if (rangeType === "today") {
    return { rangeType, start: startOfShanghaiDay(now), end: now };
  }
  if (rangeType === "3days") {
    return { rangeType, start: startOfShanghaiDay(now, -2), end: now };
  }
  if (rangeType === "7days") {
    return { rangeType, start: startOfShanghaiDay(now, -6), end: now };
  }
  if (rangeType === "custom") {
    const start = parseDateOnlyStart(event.startDate);
    const end = parseDateOnlyEnd(event.endDate);
    if (!start || !end) throw new Error("璇烽€夋嫨寮€濮嬫棩鏈熷拰缁撴潫鏃ユ湡");
    throw new Error("Invalid operation");
    return { rangeType, start, end };
  }
  throw new Error("Invalid operation");
}

function clampPage(value) {
  return Math.max(1, parseInt(value, 10) || 1);
}

function clampPageSize(value, max = MAX_PAGE_SIZE) {
  return Math.min(max, Math.max(1, parseInt(value, 10) || DEFAULT_PAGE_SIZE));
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function rangeCommand(min, max) {
  if (min !== null && max !== null) return _.gte(min).and(_.lte(max));
  if (min !== null) return _.gte(min);
  if (max !== null) return _.lte(max);
  return null;
}

function buildProductWhere(filters = {}) {
  const where = {};
  if (filters.category) where.category = String(filters.category).trim();
  if (filters.isActive === true || filters.isActive === false) where.isActive = filters.isActive;

  const stockCommand = rangeCommand(numberOrNull(filters.minStock), numberOrNull(filters.maxStock));
  if (stockCommand) where.stock = stockCommand;

  const priceCommand = rangeCommand(numberOrNull(filters.minPrice), numberOrNull(filters.maxPrice));
  if (priceCommand) where.price = priceCommand;

  const productionStart = String(filters.productionDateStart || "").trim();
  const productionEnd = String(filters.productionDateEnd || "").trim();
  if (productionStart && productionEnd) where.productionDate = _.gte(productionStart).and(_.lte(productionEnd));
  else if (productionStart) where.productionDate = _.gte(productionStart);
  else if (productionEnd) where.productionDate = _.lte(productionEnd);
  return where;
}

async function getPaged(collection, where, maxRows = MAX_PRODUCT_SCAN, orderField = "", orderDirection = "desc") {
  let skip = 0;
  let rows = [];
  while (rows.length < maxRows) {
    let query = db.collection(collection).where(where || {});
    if (orderField) query = query.orderBy(orderField, orderDirection);
    const res = await query.skip(skip).limit(DB_PAGE_SIZE).get();
    rows = rows.concat(res.data);
    if (res.data.length < DB_PAGE_SIZE) break;
    skip += DB_PAGE_SIZE;
  }
  return rows.slice(0, maxRows);
}

function batches(list, size = IN_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
  return result;
}

function unique(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function orderSaleTime(order) {
  return toDate(order.approvedAt) || toDate(order.createdAt);
}

function effectiveOrder(order) {
  if (EXCLUDED_ORDER_STATUSES.includes(order.status) || EXCLUDED_PAYMENT_STATUSES.includes(order.paymentStatus)) return false;
  return EFFECTIVE_ORDER_STATUSES.includes(order.status) || EFFECTIVE_DELIVERY_STATUSES.includes(order.deliveryStatus);
}

async function queryEffectiveOrdersByField(field, start, end) {
  const statusWhere = { status: _.in(EFFECTIVE_ORDER_STATUSES) };
  statusWhere[field] = _.gte(start).and(_.lte(end));
  const deliveryWhere = { deliveryStatus: _.in(EFFECTIVE_DELIVERY_STATUSES) };
  deliveryWhere[field] = _.gte(start).and(_.lte(end));

  const [byStatus, byDelivery] = await Promise.all([
    getPaged("orders", statusWhere, MAX_ORDER_SCAN, field, "desc"),
    getPaged("orders", deliveryWhere, MAX_ORDER_SCAN, field, "desc")
  ]);
  return byStatus.concat(byDelivery);
}

async function loadEffectiveOrders(start, end) {
  const orderMap = {};
  const approvedAtOrders = await queryEffectiveOrdersByField("approvedAt", start, end);
  const createdAtOrders = await queryEffectiveOrdersByField("createdAt", start, end);

  approvedAtOrders.concat(createdAtOrders).forEach((order) => {
    if (!effectiveOrder(order)) return;
    const saleTime = orderSaleTime(order);
    if (!saleTime || saleTime.getTime() < start.getTime() || saleTime.getTime() > end.getTime()) return;
    orderMap[order._id] = order;
  });
  return Object.values(orderMap);
}

async function loadOrderItems(orderIds, orderMap = {}) {
  const itemMap = {};
  orderIds.forEach((id) => {
    itemMap[id] = [];
  });
  for (const group of batches(orderIds)) {
    try {
      const res = await db.collection("order_items").where({ orderId: _.in(group) }).limit(1000).get();
      res.data.forEach((item) => {
        if (!itemMap[item.orderId]) itemMap[item.orderId] = [];
        itemMap[item.orderId].push(item);
      });
    } catch (err) {
      if (isCollectionNotExists(err)) return itemMap;
      throw err;
    }
  }

  Object.keys(itemMap).forEach((orderId) => {
    if (itemMap[orderId].length) return;
    const order = orderMap[orderId];
    if (order && order.productId) {
      itemMap[orderId].push({
        orderId,
        productId: order.productId,
        productName: order.productName,
        quantity: order.quantity,
        unitPrice: order.unitPrice,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt
      });
    }
  });
  return itemMap;
}

async function loadEffectiveSaleRows(start, end) {
  const orders = await loadEffectiveOrders(start, end);
  const orderMap = {};
  orders.forEach((order) => {
    orderMap[order._id] = order;
  });
  const itemMap = await loadOrderItems(Object.keys(orderMap), orderMap);
  const rows = [];
  orders.forEach((order) => {
    const saleTime = orderSaleTime(order);
    (itemMap[order._id] || []).forEach((item) => {
      if (!item.productId) return;
      rows.push({ order, item, saleTime });
    });
  });
  return rows;
}

async function loadProducts(filters = {}) {
  const products = await getPaged("products", buildProductWhere(filters), MAX_PRODUCT_SCAN, "updatedAt", "desc");
  const keyword = normalizeSearchText(filters.keyword);
  const productIndex = normalizeSearchText(filters.productIndex);
  const skuCode = normalizeSearchText(filters.skuCode);

  return products.filter((product) => {
    if (product.isDeleted === true) return false;
    if (productIndex && normalizeSearchText(product.productIndex) !== productIndex) return false;
    if (skuCode && normalizeSearchText(product.skuCode) !== skuCode) return false;
    if (!keyword) return true;
    const searchText = product.searchText || buildProductSearchText(product);
    return normalizeSearchText(searchText).includes(keyword);
  });
}

function salesWindows(now = new Date()) {
  return {
    sevenStart: startOfShanghaiDay(now, -6),
    thirtyStart: startOfShanghaiDay(now, -29),
    end: now
  };
}

async function buildSalesStats(products, now = new Date()) {
  const ids = new Set(products.map((product) => product._id));
  const stats = {};
  products.forEach((product) => {
    const productLastSoldAt = toDate(product.lastSoldAt);
    stats[product._id] = {
      sales7d: Number(product.sales7d || 0),
      sales30d: Number(product.sales30d || 0),
      lastSoldAt: productLastSoldAt || null
    };
  });

  const windows = salesWindows(now);
  const rows = await loadEffectiveSaleRows(windows.thirtyStart, windows.end);
  rows.forEach(({ item, saleTime }) => {
    if (!ids.has(item.productId)) return;
    const quantity = Number(item.quantity || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const row = stats[item.productId] || { sales7d: 0, sales30d: 0, lastSoldAt: null };
    row.sales30d += quantity;
    if (saleTime.getTime() >= windows.sevenStart.getTime()) row.sales7d += quantity;
    if (!row.lastSoldAt || saleTime.getTime() > row.lastSoldAt.getTime()) row.lastSoldAt = saleTime;
    stats[item.productId] = row;
  });
  return stats;
}

function dateValue(value, emptyLow = true) {
  const date = toDate(value) || parseDateOnlyStart(value);
  if (date) return date.getTime();
  return emptyLow ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}

function sortProducts(products, sortBy, sortOrder) {
  const preset = SORTS[sortBy] || {};
  const field = preset.sortBy || sortBy || "stock";
  const direction = preset.sortOrder || sortOrder || "desc";
  const multiplier = direction === "asc" ? 1 : -1;

  const list = products.slice();
  list.sort((a, b) => {
    let left;
    let right;
    if (field === "productionDate") {
      left = dateValue(a.productionDate, true);
      right = dateValue(b.productionDate, true);
    } else if (field === "lastSoldAt" || field === "createdAt" || field === "updatedAt") {
      left = dateValue(a[field], true);
      right = dateValue(b[field], true);
    } else {
      left = Number(a[field] || 0);
      right = Number(b[field] || 0);
    }
    if (left === right) return normalizeSearchText(a.name).localeCompare(normalizeSearchText(b.name));
    return left > right ? multiplier : -multiplier;
  });
  return list;
}

function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return "";
  const shifted = new Date(date.getTime() + CHINA_OFFSET);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-") + " " + [
    String(shifted.getUTCHours()).padStart(2, "0"),
    String(shifted.getUTCMinutes()).padStart(2, "0")
  ].join(":");
}

function moneyText(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function daysSince(date, now = new Date()) {
  const parsed = toDate(date) || parseDateOnlyStart(date);
  if (!parsed) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 86400000));
}

function categoryAveragePrices(products) {
  const groups = {};
  products.forEach((product) => {
    const category = product.category || "uncategorized";
    if (!groups[category]) groups[category] = { total: 0, count: 0 };
    groups[category].total += Number(product.price || 0);
    groups[category].count += 1;
  });
  const averages = {};
  Object.keys(groups).forEach((category) => {
    averages[category] = groups[category].count ? groups[category].total / groups[category].count : 0;
  });
  return averages;
}

function reminderFor(product, averages) {
  const messages = [];
  const productionAge = daysSince(product.productionDate);
  if (Number(product.stock || 0) >= 50 && Number(product.sales7d || 0) === 0) {
    messages.push("High stock and no sales in 7 days");
  }
  if (productionAge !== null && productionAge >= 90 && Number(product.sales7d || 0) === 0) {
    messages.push("Old production date and no recent sales");
  }
  const avg = averages[product.category || "uncategorized"];
  if (avg && Number(product.price || 0) > avg && Number(product.sales7d || 0) === 0) {
    messages.push("Price is above category average and no recent sales");
  }
  return messages;
}

function shapeProduct(product, stats, averages, now = new Date()) {
  const rowStats = stats[product._id] || {};
  const lastSoldAt = rowStats.lastSoldAt || toDate(product.lastSoldAt);
  const unsoldDays = lastSoldAt ? daysSince(lastSoldAt, now) : daysSince(product.createdAt, now);
  const shaped = {
    productId: product._id,
    _id: product._id,
    productIndex: product.productIndex || "",
    skuCode: product.skuCode || "",
    name: product.name || "",
    imageUrl: product.imageUrl || "",
    category: product.category || "",
    specification: product.specification || "",
    productionDate: product.productionDate || "",
    stock: Number(product.stock || 0),
    price: Number(product.price || 0),
    priceText: moneyText(product.price),
    isActive: product.isActive !== false,
    activeText: product.isActive === false ? "no" : "yes",
    lastSoldAt,
    lastSoldAtText: lastSoldAt ? formatDateTime(lastSoldAt) : "浠庢湭鍞嚭",
    sales7d: Number(rowStats.sales7d || 0),
    sales30d: Number(rowStats.sales30d || 0),
    unsoldDays,
    unsoldDaysText: unsoldDays === null ? "" : String(unsoldDays),
    unsoldWatch: Boolean(product.unsoldWatch),
    clearanceTag: Boolean(product.clearanceTag),
    createdAt: product.createdAt || null,
    updatedAt: product.updatedAt || null
  };
  const rawVersion = product.version !== undefined ? product.version : product.dataVersion;
  shaped.version = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion >= 0
    ? rawVersion
    : 0;
  shaped.reminders = reminderFor(shaped, averages);
  shaped.remark = shaped.reminders.join(" ");
  return shaped;
}

async function buildUnsoldList(event = {}, options = {}) {
  const range = normalizeRange(event);
  const products = await loadProducts(event);
  const salesStats = await buildSalesStats(products);
  const averages = categoryAveragePrices(products);
  const saleRows = await loadEffectiveSaleRows(range.start, range.end);
  const soldIds = new Set(saleRows.map((row) => row.item.productId).filter(Boolean));
  const shaped = products
    .filter((product) => !soldIds.has(product._id))
    .map((product) => shapeProduct(product, salesStats, averages));
  const sorted = sortProducts(shaped, event.sortBy || "stock", event.sortOrder || "desc");

  const page = clampPage(event.page);
  const pageSize = options.exportMode ? Math.min(MAX_EXPORT_ROWS, Math.max(1, parseInt(event.pageSize, 10) || MAX_EXPORT_ROWS)) : clampPageSize(event.pageSize);
  const start = options.exportMode ? 0 : (page - 1) * pageSize;
  const list = sorted.slice(start, start + pageSize);
  return {
    list,
    total: sorted.length,
    page,
    pageSize,
    hasMore: start + pageSize < sorted.length,
    range: {
      startDate: formatDateTime(range.start),
      endDate: formatDateTime(range.end)
    }
  };
}

async function summaryCounts(event = {}) {
  const base = { ...event };
  delete base.page;
  delete base.pageSize;
  const [today, three, seven, highStockSeven] = await Promise.all([
    buildUnsoldList({ ...base, rangeType: "today", pageSize: 1 }),
    buildUnsoldList({ ...base, rangeType: "3days", pageSize: 1 }),
    buildUnsoldList({ ...base, rangeType: "7days", pageSize: 1 }),
    buildUnsoldList({ ...base, rangeType: "7days", minStock: 50, pageSize: 1 })
  ]);
  return {
    todayUnsoldCount: today.total,
    threeDaysUnsoldCount: three.total,
    sevenDaysUnsoldCount: seven.total,
    highStockSevenDaysUnsoldCount: highStockSeven.total
  };
}

function buildWorkbook(rows) {
  const aoa = [EXPORT_COLUMNS.map((column) => column.title)];
  rows.forEach((row) => {
    aoa.push(EXPORT_COLUMNS.map((column) => row[column.key] === undefined || row[column.key] === null ? "" : String(row[column.key])));
  });
  const worksheet = xlsx.utils.aoa_to_sheet(aoa);
  worksheet["!cols"] = EXPORT_COLUMNS.map((column) => ({ wch: Math.max(12, column.title.length + 6) }));
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "鏈敭鍟嗗搧");
  return workbook;
}

function todayStamp() {
  const parts = shanghaiDayParts();
  return `${parts.year}${String(parts.month + 1).padStart(2, "0")}${String(parts.day).padStart(2, "0")}`;
}

function exportCloudPath(fileName) {
  const parts = shanghaiDayParts();
  return `exports/unsold-products/${parts.year}-${String(parts.month + 1).padStart(2, "0")}/${fileName}`;
}

async function tempUrl(fileID) {
  const res = await cloud.getTempFileURL({ fileList: [fileID] });
  const file = res.fileList && res.fileList[0];
  if (!file || !file.tempFileURL) throw new Error("鏂囦欢閾炬帴鐢熸垚澶辫触");
  return file.tempFileURL;
}

async function exportUnsoldProducts(event, operator) {
  const data = await buildUnsoldList({ ...event, pageSize: MAX_EXPORT_ROWS }, { exportMode: true });
  if (!data.list.length) throw new Error("娌℃湁鍙鍑虹殑鏈敭鍟嗗搧");
  if (data.total > MAX_EXPORT_ROWS) throw new Error("瀵煎嚭鏁版嵁杩囧锛岃缂╁皬绛涢€夎寖鍥村悗閲嶈瘯");

  const fileName = `unsold-products-${todayStamp()}.xlsx`;
  const workbook = buildWorkbook(data.list);
  const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
  const fileID = (await cloud.uploadFile({
    cloudPath: exportCloudPath(fileName),
    fileContent: buffer
  })).fileID;
  const fileUrl = await tempUrl(fileID);

  await ensureCollection("export_records");
  await db.collection("export_records").add({
    data: {
      exportType: "unsold_products",
      fileName,
      fileID,
      fileUrl,
      filters: event,
      totalRows: data.list.length,
      operatorId: operator.adminId,
      operatorOpenid: operator.openid,
      status: "success",
      createdAt: db.serverDate()
    }
  });

  return {
    fileName,
    fileID,
    fileUrl,
    totalRows: data.list.length
  };
}

async function updateFlag(event = {}) {
  const productId = event.productId;
  if (!productId) throw new Error("缂哄皯鍟嗗搧 ID");
  const data = { updatedAt: db.serverDate() };
  if (event.flag === "unsoldWatch") data.unsoldWatch = Boolean(event.value);
  else if (event.flag === "clearanceTag") data.clearanceTag = Boolean(event.value);
  throw new Error("Invalid operation");
  await db.collection("products").doc(productId).update({ data });
  return { productId, flag: event.flag, value: Boolean(event.value) };
}

async function updateStock(event = {}, admin = {}) {
  const result = await inventoryMutationService.adjustInventory({
    actor: statusActor(admin),
    input: {
      productId: String(event.productId || "").trim(),
      mode: "set",
      targetStock: event.stock,
      expectedStock: event.expectedStock,
      expectedVersion: event.expectedVersion,
      reason: String(event.reason || "未售商品分析页调整库存").trim()
    },
    idempotencyKey: event.idempotencyKey,
    requireExpectedSnapshots: true,
    requireReason: true
  });
  return {
    productId: result.productId,
    stock: result.stock,
    version: result.version,
    ...(result.changed === false ? { unchanged: true } : {})
  };
}

function statusActor(admin = {}) {
  return {
    id: admin.openid || admin._id || admin.id || "",
    openid: admin.openid || "",
    role: admin.role || "",
    permissions: Array.isArray(admin.permissions) ? admin.permissions.slice() : [],
    status: admin.status || "active",
    isActive: admin.isActive !== false,
    sourceClient: "miniprogram"
  };
}

async function deactivateProduct(event = {}, admin = {}) {
  const productId = String(event.productId || "").trim();
  if (!productId) throw new Error("缺少商品 ID");
  const result = await productStatusService.setStatus({
    actor: statusActor(admin),
    input: {
      productId,
      isActive: false,
      expectedIsActive: event.expectedIsActive,
      expectedVersion: event.expectedVersion,
      reason: String(event.reason || "未售商品分析页下架").trim()
    },
    idempotencyKey: event.idempotencyKey,
    requireExpectedVersion: false,
    allowMissingIdempotencyKey: true
  });
  return {
    productId: result.productId,
    isActive: result.isActive,
    version: result.version,
    ...(result.changed === false ? { unchanged: true } : {})
  };
}

exports.main = async (event = {}) => {
  try {
    if (event.action === "deactivate") {
      const statusAdmin = await requirePermission("product:update_status");
      return ok(await deactivateProduct(event, statusAdmin));
    }
    if (event.action === "updateStock") {
      const inventoryAdmin = await requirePermission("inventory:update");
      return ok(await updateStock(event, inventoryAdmin));
    }
    const permissionAdmin = await requireAnyPermission(["dashboard:view_inventory", "product:view"]);
    const operator = { openid: permissionAdmin.openid, adminId: permissionAdmin._id || permissionAdmin.id };
    if (event.action === "updateFlag") return ok(await updateFlag(event));
    if (event.action === "export") return ok(await exportUnsoldProducts(event, operator));

    const data = await buildUnsoldList(event);
    const summary = await summaryCounts(event);
    return ok({
      ...data,
      summary: {
        ...summary,
        currentResultCount: data.total
      }
    });
  } catch (err) {
    return fail(err.message || "鏌ヨ鏈敭鍟嗗搧澶辫触", err.code, err.details);
  }
};

exports._test = { shapeProduct, statusActor };

