const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ALLOWED_RANGES = Object.freeze({ "7d": 7, "30d": 30, "90d": 90 });

const EFFECTIVE_ORDER_STATUSES = new Set([
  "approved_pending_payment",
  "pending_payment_confirm",
  "paid",
  "partial_paid",
  "partial_refunded",
  "shipped",
  "completed"
]);
const EFFECTIVE_PAYMENT_STATUSES = new Set(["paid", "partial", "partial_paid", "pending_confirm"]);
const INVALID_ORDER_STATUSES = new Set([
  "rejected",
  "cancelled",
  "canceled",
  "refunded",
  "full_refunded",
  "refund_completed",
  "void",
  "closed"
]);
const FULL_REFUND_STATUSES = new Set(["full_refunded", "refunded", "refund_completed"]);

const DEFAULT_QUERY_LIMITS = Object.freeze({
  orders: Object.freeze({ pageSize: 100, maxRows: 20000, maxQueries: 201 }),
  orderItems: Object.freeze({ pageSize: 100, batchSize: 20, maxRows: 100000, maxQueries: 1201 }),
  priceLogs: Object.freeze({ pageSize: 100, maxRows: 50000, maxQueries: 501 }),
  inventoryLogs: Object.freeze({ pageSize: 100, maxRows: 50000, maxQueries: 501 }),
  products: Object.freeze({ batchSize: 20, maxRows: 20000, maxQueries: 1000 })
});

const ORDER_PROJECTION = Object.freeze({
  _id: true,
  createdAt: true,
  status: true,
  orderStatus: true,
  paymentStatus: true,
  refundStatus: true,
  afterSaleStatus: true,
  shippingStatus: true,
  deliveryStatus: true,
  productId: true,
  productName: true,
  name: true,
  sku: true,
  productCode: true,
  skuCode: true,
  productIndex: true,
  quantity: true,
  count: true,
  unitPrice: true,
  price: true,
  subtotal: true,
  totalAmount: true,
  amount: true,
  "items._id": true,
  "items.productId": true,
  "items.productName": true,
  "items.name": true,
  "items.sku": true,
  "items.productCode": true,
  "items.skuCode": true,
  "items.productIndex": true,
  "items.quantity": true,
  "items.count": true,
  "items.unitPrice": true,
  "items.price": true,
  "items.subtotal": true,
  "items.totalAmount": true,
  "items.amount": true
});

const ORDER_ITEM_PROJECTION = Object.freeze({
  _id: true,
  orderId: true,
  productId: true,
  productName: true,
  name: true,
  sku: true,
  productCode: true,
  skuCode: true,
  productIndex: true,
  quantity: true,
  count: true,
  unitPrice: true,
  price: true,
  subtotal: true,
  totalAmount: true,
  amount: true,
  createdAt: true
});

const PRICE_LOG_PROJECTION = Object.freeze({
  _id: true,
  productId: true,
  afterPrice: true,
  newPrice: true,
  price: true,
  beforePrice: true,
  createdAt: true
});

const INVENTORY_LOG_PROJECTION = Object.freeze({
  _id: true,
  businessKey: true,
  productId: true,
  beforeStock: true,
  afterStock: true,
  changeAmount: true,
  createdAt: true
});

const PRODUCT_PROJECTION = Object.freeze({
  _id: true,
  name: true,
  productName: true,
  brand: true,
  category: true,
  specification: true,
  sku: true,
  productCode: true,
  skuCode: true,
  productIndex: true,
  price: true,
  priceCents: true,
  stock: true,
  imageUrl: true,
  tags: true,
  isDeleted: true
});

class ProductAnalyticsError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "ProductAnalyticsError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new ProductAnalyticsError(code, message, statusCode);
}

function dataInvalid(message = "商品分析源数据无效") {
  fail("ANALYTICS_DATA_INVALID", message, 422);
}

function sourceUnavailable(message = "商品分析数据源暂不可用") {
  fail("ANALYTICS_SOURCE_UNAVAILABLE", message, 503);
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value && typeof value === "object" && value.$date !== undefined) return toDate(value.$date);
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requiredDate(value, field) {
  const date = toDate(value);
  if (!date) dataInvalid(`${field} 无效`);
  return date;
}

function startOfShanghaiDay(date, dayOffset = 0) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + dayOffset
  ) - SHANGHAI_OFFSET_MS);
}

function parseShanghaiDateOnly(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(utc - SHANGHAI_OFFSET_MS);
}

function formatShanghaiDate(value) {
  const date = requiredDate(value, "createdAt");
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function normalizeRange(input = {}, options = {}) {
  const now = requiredDate(options.now || new Date(), "now");
  const explicit = input.range !== undefined;
  const range = explicit ? input.range : "30d";
  if (options.allowCustom && range === "custom") {
    const start = parseShanghaiDateOnly(input.startDate);
    const inclusiveEnd = parseShanghaiDateOnly(input.endDate);
    if (!start || !inclusiveEnd) fail("ANALYTICS_RANGE_INVALID", "自定义日期范围无效", 400);
    const end = startOfShanghaiDay(inclusiveEnd, 1);
    const days = Math.round((end.getTime() - start.getTime()) / DAY_MS);
    if (days <= 0 || days > 90) fail("ANALYTICS_RANGE_INVALID", "自定义日期范围必须为 1 到 90 天", 400);
    return {
      range,
      days,
      start,
      end,
      previousStart: new Date(start.getTime() - days * DAY_MS),
      previousEnd: start
    };
  }
  if (typeof range !== "string" || !Object.hasOwn(ALLOWED_RANGES, range)) {
    fail("ANALYTICS_RANGE_INVALID", "分析范围仅支持 7d、30d 或 90d", 400);
  }
  const days = ALLOWED_RANGES[range];
  const end = startOfShanghaiDay(now, 1);
  const start = new Date(end.getTime() - days * DAY_MS);
  return {
    range,
    days,
    start,
    end,
    previousStart: new Date(start.getTime() - days * DAY_MS),
    previousEnd: start
  };
}

function nonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeText(value, maxLength = 160) {
  return nonEmptyString(value).slice(0, maxLength);
}

function requireSafeInteger(value, field, options = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) dataInvalid(`${field} 必须是安全整数`);
  if (options.positive && value <= 0) dataInvalid(`${field} 必须大于 0`);
  if (options.nonNegative && value < 0) dataInvalid(`${field} 不能为负数`);
  return value;
}

function optionalNonNegativeInteger(value, field) {
  if (value === undefined || value === null) return null;
  return requireSafeInteger(value, field, { nonNegative: true });
}

function safeAdd(left, right, field) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) dataInvalid(`${field} 累计超出安全整数范围`);
  return result;
}

function safeMultiply(left, right, field) {
  const result = left * right;
  if (!Number.isSafeInteger(result)) dataInvalid(`${field} 超出安全整数范围`);
  return result;
}

function safeDifference(left, right, field) {
  const result = left - right;
  if (!Number.isSafeInteger(result)) dataInvalid(`${field} 超出安全整数范围`);
  return result;
}

function productSku(value = {}) {
  return safeText(value.sku || value.productCode || value.skuCode || value.productIndex, 80);
}

function isEffectiveOrder(order = {}) {
  const status = safeText(order.status || order.orderStatus, 60);
  const paymentStatus = safeText(order.paymentStatus, 60);
  const refundStatus = safeText(order.refundStatus || order.afterSaleStatus, 60);
  if (INVALID_ORDER_STATUSES.has(status)) return false;
  if (paymentStatus === "refunded" || FULL_REFUND_STATUSES.has(refundStatus)) return false;
  return EFFECTIVE_ORDER_STATUSES.has(status)
    || EFFECTIVE_PAYMENT_STATUSES.has(paymentStatus)
    || new Set(["shipped", "delivered", "completed"]).has(safeText(order.shippingStatus || order.deliveryStatus, 60));
}

function mergeLimits(overrides = {}) {
  const merged = {};
  for (const [key, value] of Object.entries(DEFAULT_QUERY_LIMITS)) {
    merged[key] = { ...value, ...(overrides[key] || {}) };
    for (const field of Object.keys(merged[key])) {
      if (!Number.isSafeInteger(merged[key][field]) || merged[key][field] <= 0) {
        throw new TypeError(`Invalid analytics query limit: ${key}.${field}`);
      }
    }
  }
  return merged;
}

function commandAnd(command, conditions) {
  const filtered = conditions.filter(Boolean);
  if (filtered.length === 1) return filtered[0];
  return command.and(filtered);
}

function cursorCondition(command, cursor, end) {
  if (!cursor) return null;
  const laterDate = end
    ? command.gt(cursor.createdAt).and(command.lt(end))
    : command.gt(cursor.createdAt);
  return command.or([
    { createdAt: laterDate },
    { createdAt: cursor.createdAt, _id: command.gt(cursor.id) }
  ]);
}

function dateRangeCondition(command, start, end) {
  return { createdAt: command.gte(start).and(command.lt(end)) };
}

function createCloudBaseProductAnalyticsRepository({ db, command }) {
  if (!db || !command) throw new TypeError("db and command are required");

  async function queryPage(collectionName, where, projection, limit) {
    let query = db.collection(collectionName).where(where).field(projection);
    query = query.orderBy("createdAt", "asc").orderBy("_id", "asc").limit(limit);
    const result = await query.get();
    return result && Array.isArray(result.data) ? result.data : [];
  }

  return {
    async getProduct(productId) {
      const result = await db.collection("products")
        .where({ _id: productId })
        .field(PRODUCT_PROJECTION)
        .limit(1)
        .get();
      return result && Array.isArray(result.data) ? result.data[0] || null : null;
    },

    async getProductsByIds(productIds) {
      if (!productIds.length) return [];
      const result = await db.collection("products")
        .where({ _id: command.in(productIds) })
        .field(PRODUCT_PROJECTION)
        .limit(productIds.length)
        .get();
      return result && Array.isArray(result.data) ? result.data : [];
    },

    scanOrdersPage({ start, end, cursor, limit }) {
      return queryPage("orders", commandAnd(command, [
        dateRangeCondition(command, start, end),
        cursorCondition(command, cursor, end)
      ]), ORDER_PROJECTION, limit);
    },

    scanOrderItemsPage({ orderIds, cursor, limit }) {
      return queryPage("order_items", commandAnd(command, [
        { orderId: command.in(orderIds) },
        cursorCondition(command, cursor)
      ]), ORDER_ITEM_PROJECTION, limit);
    },

    scanPriceLogsPage({ start, end, productId, cursor, limit }) {
      return queryPage("price_logs", commandAnd(command, [
        productId ? { productId } : null,
        dateRangeCondition(command, start, end),
        cursorCondition(command, cursor, end)
      ]), PRICE_LOG_PROJECTION, limit);
    },

    scanInventoryLogsPage({ start, end, productId, cursor, limit }) {
      return queryPage("inventory_logs", commandAnd(command, [
        productId ? { productId } : null,
        dateRangeCondition(command, start, end),
        cursorCondition(command, cursor, end)
      ]), INVENTORY_LOG_PROJECTION, limit);
    }
  };
}

function cursorFor(row, sourceName) {
  const id = nonEmptyString(row && row._id);
  if (!id) dataInvalid(`${sourceName}._id 无效`);
  return { createdAt: requiredDate(row.createdAt, `${sourceName}.createdAt`), id };
}

function cursorAdvanced(previous, next) {
  if (!previous) return true;
  const previousTime = previous.createdAt.getTime();
  const nextTime = next.createdAt.getTime();
  return nextTime > previousTime || (nextTime === previousTime && next.id > previous.id);
}

async function callRepository(sourceName, callback) {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof ProductAnalyticsError) throw error;
    sourceUnavailable(`${sourceName} 数据源暂不可用`);
  }
}

async function scanPages({ sourceName, pageMethod, baseArgs, limit, counter }) {
  let cursor = null;
  const rows = [];
  while (true) {
    if (counter.queries >= limit.maxQueries) sourceUnavailable(`${sourceName} 查询次数达到安全上限`);
    if (counter.rows >= limit.maxRows) sourceUnavailable(`${sourceName} 扫描行数达到安全上限`);
    const pageLimit = Math.min(limit.pageSize, limit.maxRows - counter.rows);
    const page = await callRepository(sourceName, () => pageMethod({ ...baseArgs, cursor, limit: pageLimit }));
    counter.queries += 1;
    if (!Array.isArray(page) || page.length > pageLimit) sourceUnavailable(`${sourceName} 返回结构无效`);
    if (!page.length) break;
    const nextCursor = cursorFor(page[page.length - 1], sourceName);
    if (!cursorAdvanced(cursor, nextCursor)) sourceUnavailable(`${sourceName} 游标未前进`);
    rows.push(...page);
    counter.rows += page.length;
    if (counter.rows >= limit.maxRows) sourceUnavailable(`${sourceName} 扫描行数达到安全上限`);
    cursor = nextCursor;
    if (page.length < pageLimit) break;
  }
  return rows;
}

function batches(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function uniqueById(rows, sourceName) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const id = nonEmptyString(row && row._id);
    if (!id) dataInvalid(`${sourceName}._id 无效`);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(row);
  }
  return result;
}

function itemQuantity(item) {
  const value = item.quantity !== undefined ? item.quantity : item.count;
  return requireSafeInteger(value, "order_items.quantity", { positive: true });
}

function itemAmount(item, quantity) {
  const raw = item.subtotal !== undefined ? item.subtotal
    : item.totalAmount !== undefined ? item.totalAmount
      : item.amount;
  if (raw !== undefined) return requireSafeInteger(raw, "order_items.totalAmount", { nonNegative: true });
  const price = item.unitPrice !== undefined ? item.unitPrice : item.price;
  const unitPrice = requireSafeInteger(price, "order_items.unitPrice", { nonNegative: true });
  return safeMultiply(unitPrice, quantity, "order_items.totalAmount");
}

function itemUnitPrice(item, quantity, amount) {
  const raw = item.unitPrice !== undefined ? item.unitPrice : item.price;
  if (raw !== undefined) return requireSafeInteger(raw, "order_items.unitPrice", { nonNegative: true });
  const average = amount / quantity;
  if (!Number.isFinite(average)) dataInvalid("order_items.unitPrice 无效");
  return Math.round(average);
}

function normalizedSaleItem(item, order) {
  const productId = safeText(item.productId, 128);
  if (!productId) dataInvalid("order_items.productId 无效");
  const quantity = itemQuantity(item);
  const amount = itemAmount(item, quantity);
  const unitPrice = itemUnitPrice(item, quantity, amount);
  return {
    productId,
    productName: safeText(item.productName || item.name || order.productName || order.name, 160),
    sku: productSku(item) || productSku(order),
    quantity,
    amount,
    unitPrice
  };
}

function fallbackItems(order) {
  if (order.items !== undefined && !Array.isArray(order.items)) dataInvalid("orders.items 无效");
  if (Array.isArray(order.items) && order.items.length) return order.items;
  if (safeText(order.productId, 128)) return [{
    productId: order.productId,
    productName: order.productName || order.name,
    sku: order.sku,
    productCode: order.productCode,
    skuCode: order.skuCode,
    productIndex: order.productIndex,
    quantity: order.quantity !== undefined ? order.quantity : order.count,
    unitPrice: order.unitPrice !== undefined ? order.unitPrice : order.price,
    subtotal: order.subtotal,
    totalAmount: order.totalAmount,
    amount: order.amount
  }];
  dataInvalid("有效订单缺少商品明细");
}

function emptyPeriodAggregate(days, start) {
  const byDate = new Map();
  for (let offset = 0; offset < days; offset += 1) {
    const date = formatShanghaiDate(new Date(start.getTime() + offset * DAY_MS));
    byDate.set(date, { date, salesCount: 0, salesAmountCents: 0, orderIds: new Set() });
  }
  return {
    salesCount: 0,
    salesAmountCents: 0,
    orderIds: new Set(),
    saleEvents: 0,
    byDate,
    products: new Map()
  };
}

function productAggregate(map, item) {
  if (!map.has(item.productId)) {
    map.set(item.productId, {
      id: item.productId,
      name: item.productName,
      sku: item.sku,
      salesCount: 0,
      salesAmountCents: 0,
      orderIds: new Set(),
      minPrice: null,
      maxPrice: null,
      byDate: new Map()
    });
  }
  const value = map.get(item.productId);
  if (!value.name && item.productName) value.name = item.productName;
  if (!value.sku && item.sku) value.sku = item.sku;
  return value;
}

function addSale(aggregate, order, item) {
  const orderId = nonEmptyString(order._id);
  if (!orderId) dataInvalid("orders._id 无效");
  const date = formatShanghaiDate(order.createdAt);
  const bucket = aggregate.byDate.get(date);
  if (!bucket) dataInvalid("订单日期不在分析周期内");
  aggregate.salesCount = safeAdd(aggregate.salesCount, item.quantity, "销量");
  aggregate.salesAmountCents = safeAdd(aggregate.salesAmountCents, item.amount, "销售额");
  aggregate.orderIds.add(orderId);
  aggregate.saleEvents += 1;
  bucket.salesCount = safeAdd(bucket.salesCount, item.quantity, "日销量");
  bucket.salesAmountCents = safeAdd(bucket.salesAmountCents, item.amount, "日销售额");
  bucket.orderIds.add(orderId);
  const product = productAggregate(aggregate.products, item);
  product.salesCount = safeAdd(product.salesCount, item.quantity, "商品销量");
  product.salesAmountCents = safeAdd(product.salesAmountCents, item.amount, "商品销售额");
  product.orderIds.add(orderId);
  product.minPrice = product.minPrice === null ? item.unitPrice : Math.min(product.minPrice, item.unitPrice);
  product.maxPrice = product.maxPrice === null ? item.unitPrice : Math.max(product.maxPrice, item.unitPrice);
  if (!product.byDate.has(date)) {
    product.byDate.set(date, {
      date,
      quantity: 0,
      amount: 0,
      orderIds: new Set(),
      minPrice: null,
      maxPrice: null
    });
  }
  const productDay = product.byDate.get(date);
  productDay.quantity = safeAdd(productDay.quantity, item.quantity, "商品日销量");
  productDay.amount = safeAdd(productDay.amount, item.amount, "商品日销售额");
  productDay.orderIds.add(orderId);
  productDay.minPrice = productDay.minPrice === null ? item.unitPrice : Math.min(productDay.minPrice, item.unitPrice);
  productDay.maxPrice = productDay.maxPrice === null ? item.unitPrice : Math.max(productDay.maxPrice, item.unitPrice);
}

function percentageChange(current, previous) {
  if (previous === 0) return null;
  const value = ((current - previous) / previous) * 100;
  return Number(value.toFixed(1));
}

function weightedAverage(amount, quantity) {
  if (!quantity) return null;
  const value = amount / quantity;
  if (!Number.isFinite(value)) dataInvalid("成交均价无效");
  return Math.round(value);
}

function priceFromLog(log) {
  const raw = log.afterPrice !== undefined ? log.afterPrice
    : log.newPrice !== undefined ? log.newPrice
      : log.price;
  if (raw === undefined) dataInvalid("price_logs 缺少有效报价字段");
  return requireSafeInteger(raw, "price_logs.price", { nonNegative: true });
}

function inventoryDelta(log) {
  const hasBefore = log.beforeStock !== undefined && log.beforeStock !== null;
  const hasAfter = log.afterStock !== undefined && log.afterStock !== null;
  if (hasBefore) requireSafeInteger(log.beforeStock, "inventory_logs.beforeStock", { nonNegative: true });
  if (hasAfter) requireSafeInteger(log.afterStock, "inventory_logs.afterStock", { nonNegative: true });
  if (hasBefore && hasAfter) {
    const derived = safeDifference(log.afterStock, log.beforeStock, "inventory_logs.changeAmount");
    if (log.changeAmount !== undefined && log.changeAmount !== null) {
      const explicit = requireSafeInteger(log.changeAmount, "inventory_logs.changeAmount");
      if (explicit !== derived) dataInvalid("inventory_logs 库存变化字段不一致");
    }
    return derived;
  }
  return requireSafeInteger(log.changeAmount, "inventory_logs.changeAmount");
}

function currentProductPrice(product, required = false) {
  const value = product && (product.price !== undefined ? product.price : product.priceCents);
  if (value === undefined || value === null) {
    if (required) dataInvalid("products.price 缺失");
    return null;
  }
  return requireSafeInteger(value, "products.price", { nonNegative: true });
}

function currentProductStock(product) {
  const value = product && product.stock;
  if (value === undefined || value === null) return 0;
  return requireSafeInteger(value, "products.stock", { nonNegative: true });
}

function shapeProduct(product) {
  return {
    productId: safeText(product._id || product.id, 128),
    name: safeText(product.name || product.productName, 160),
    brand: safeText(product.brand, 100),
    category: safeText(product.category, 100),
    specification: safeText(product.specification, 160),
    currentPrice: currentProductPrice(product, true),
    currentStock: currentProductStock(product),
    imageUrl: safeText(product.imageUrl, 500),
    tags: Array.isArray(product.tags) ? product.tags.map((tag) => safeText(tag, 60)).filter(Boolean).slice(0, 30) : []
  };
}

function createProductAnalyticsQueryService(options = {}) {
  const repository = options.repository || createCloudBaseProductAnalyticsRepository({
    db: options.db,
    command: options.command || options._
  });
  const limits = mergeLimits(options.limits);
  const nowProvider = typeof options.now === "function" ? options.now : () => options.now || new Date();

  async function loadOrdersAndItems(rangeInfo, options = {}) {
    const orderCounter = { rows: 0, queries: 0 };
    const rawOrders = await scanPages({
      sourceName: "orders",
      pageMethod: repository.scanOrdersPage.bind(repository),
      baseArgs: {
        start: options.includePrevious === false ? rangeInfo.start : rangeInfo.previousStart,
        end: rangeInfo.end
      },
      limit: limits.orders,
      counter: orderCounter
    });
    const orders = uniqueById(rawOrders, "orders").filter(isEffectiveOrder);
    const itemCounter = { rows: 0, queries: 0 };
    const directItems = [];
    for (const orderIdBatch of batches(orders.map((order) => nonEmptyString(order._id)), limits.orderItems.batchSize)) {
      if (orderIdBatch.some((id) => !id)) dataInvalid("orders._id 无效");
      const rows = await scanPages({
        sourceName: "order_items",
        pageMethod: repository.scanOrderItemsPage.bind(repository),
        baseArgs: { orderIds: orderIdBatch },
        limit: limits.orderItems,
        counter: itemCounter
      });
      directItems.push(...rows);
    }
    const uniqueItems = uniqueById(directItems, "order_items");
    const byOrder = new Map();
    for (const item of uniqueItems) {
      const orderId = safeText(item.orderId, 128);
      if (!orderId) dataInvalid("order_items.orderId 无效");
      if (!byOrder.has(orderId)) byOrder.set(orderId, []);
      byOrder.get(orderId).push(item);
    }
    return { orders, byOrder, queryStats: { orders: orderCounter, orderItems: itemCounter } };
  }

  function aggregateSales(rangeInfo, orders, byOrder) {
    const current = emptyPeriodAggregate(rangeInfo.days, rangeInfo.start);
    const previous = emptyPeriodAggregate(rangeInfo.days, rangeInfo.previousStart);
    for (const order of orders) {
      const createdAt = requiredDate(order.createdAt, "orders.createdAt");
      const aggregate = createdAt >= rangeInfo.start && createdAt < rangeInfo.end
        ? current
        : createdAt >= rangeInfo.previousStart && createdAt < rangeInfo.previousEnd ? previous : null;
      if (!aggregate) continue;
      const orderId = nonEmptyString(order._id);
      const rawItems = byOrder.has(orderId) ? byOrder.get(orderId) : fallbackItems(order);
      for (const rawItem of rawItems) addSale(aggregate, order, normalizedSaleItem(rawItem, order));
    }
    return { current, previous };
  }

  async function loadEventLogs(rangeInfo, options = {}) {
    const priceCounter = { rows: 0, queries: 0 };
    const inventoryCounter = { rows: 0, queries: 0 };
    const productId = options.productId || "";
    const includeInventory = options.includeInventory !== false;
    const [rawPriceLogs, rawInventoryLogs] = await Promise.all([
      scanPages({
        sourceName: "price_logs",
        pageMethod: repository.scanPriceLogsPage.bind(repository),
        baseArgs: { start: rangeInfo.start, end: rangeInfo.end, productId },
        limit: limits.priceLogs,
        counter: priceCounter
      }),
      includeInventory ? scanPages({
        sourceName: "inventory_logs",
        pageMethod: repository.scanInventoryLogsPage.bind(repository),
        baseArgs: { start: rangeInfo.start, end: rangeInfo.end, productId },
        limit: limits.inventoryLogs,
        counter: inventoryCounter
      }) : Promise.resolve([])
    ]);
    const priceLogs = uniqueById(rawPriceLogs, "price_logs");
    for (const log of priceLogs) {
      if (!safeText(log.productId, 128)) dataInvalid("price_logs.productId 无效");
    }
    const inventorySignatures = new Map();
    const inventoryLogs = [];
    for (const log of rawInventoryLogs) {
      const id = nonEmptyString(log && log._id);
      if (!id) dataInvalid("inventory_logs._id 无效");
      const productId = safeText(log.productId, 128);
      if (!productId) dataInvalid("inventory_logs.productId 无效");
      const businessKey = safeText(log.businessKey, 200);
      const key = businessKey ? `business:${businessKey}` : `id:${id}`;
      const signature = JSON.stringify([
        productId,
        optionalNonNegativeInteger(log.beforeStock, "inventory_logs.beforeStock"),
        optionalNonNegativeInteger(log.afterStock, "inventory_logs.afterStock"),
        inventoryDelta(log)
      ]);
      if (inventorySignatures.has(key)) {
        if (inventorySignatures.get(key) !== signature) dataInvalid("inventory_logs 防重记录内容冲突");
        continue;
      }
      inventorySignatures.set(key, signature);
      inventoryLogs.push(log);
    }
    return {
      priceLogs,
      inventoryLogs,
      queryStats: { priceLogs: priceCounter, inventoryLogs: inventoryCounter }
    };
  }

  async function loadProducts(productIds) {
    const ids = Array.from(new Set(productIds.map((id) => safeText(id, 128)).filter(Boolean)));
    if (ids.length >= limits.products.maxRows) sourceUnavailable("products 扫描行数达到安全上限");
    const map = new Map();
    let queries = 0;
    let rows = 0;
    for (const group of batches(ids, limits.products.batchSize)) {
      if (queries >= limits.products.maxQueries) sourceUnavailable("products 查询次数达到安全上限");
      const page = await callRepository("products", () => repository.getProductsByIds(group));
      queries += 1;
      if (!Array.isArray(page) || page.length > group.length) sourceUnavailable("products 返回结构无效");
      rows += page.length;
      if (rows >= limits.products.maxRows) sourceUnavailable("products 扫描行数达到安全上限");
      for (const product of page) {
        const id = safeText(product && (product._id || product.id), 128);
        if (!id) dataInvalid("products._id 无效");
        if (!map.has(id) && product.isDeleted !== true) map.set(id, product);
      }
    }
    return { map, queryStats: { rows, queries } };
  }

  async function getProduct(productId) {
    const product = await callRepository("products", () => repository.getProduct(productId));
    if (!product || product.isDeleted === true) fail("PRODUCT_NOT_FOUND", "商品不存在或已删除", 404);
    return product;
  }

  function overviewSeries(rangeInfo, current, priceLogs, inventoryLogs) {
    const quoteByDate = new Map();
    for (const log of priceLogs) {
      const date = formatShanghaiDate(log.createdAt);
      if (!current.byDate.has(date)) dataInvalid("price_logs 日期不在分析周期内");
      const price = priceFromLog(log);
      if (!quoteByDate.has(date)) quoteByDate.set(date, { total: 0, count: 0 });
      const bucket = quoteByDate.get(date);
      bucket.total = safeAdd(bucket.total, price, "日报价");
      bucket.count = safeAdd(bucket.count, 1, "日报价条数");
    }
    const inventoryByDate = new Map();
    for (const log of inventoryLogs) {
      const date = formatShanghaiDate(log.createdAt);
      if (!current.byDate.has(date)) dataInvalid("inventory_logs 日期不在分析周期内");
      const next = safeAdd(inventoryByDate.get(date) || 0, inventoryDelta(log), "日库存净变化");
      inventoryByDate.set(date, next);
    }
    return Array.from(current.byDate.values()).map((bucket) => ({
      date: bucket.date,
      salesCount: bucket.salesCount,
      averagePriceCents: weightedAverage(bucket.salesAmountCents, bucket.salesCount),
      quotePriceCents: quoteByDate.has(bucket.date)
        ? weightedAverage(quoteByDate.get(bucket.date).total, quoteByDate.get(bucket.date).count)
        : null,
      inventoryChange: inventoryByDate.has(bucket.date) ? inventoryByDate.get(bucket.date) : 0
    }));
  }

  function overviewRanking(current, previous, productMap) {
    return Array.from(current.products.values())
      .filter((item) => item.salesCount > 0)
      .map((item) => {
        const previousItem = previous.products.get(item.id);
        const product = productMap.get(item.id);
        return {
          id: item.id,
          name: safeText(product && (product.name || product.productName), 160) || item.name || "未命名商品",
          sku: productSku(product || {}) || item.sku,
          salesCount: item.salesCount,
          averagePriceCents: weightedAverage(item.salesAmountCents, item.salesCount),
          currentPriceCents: currentProductPrice(product, false),
          change: percentageChange(item.salesCount, previousItem ? previousItem.salesCount : 0)
        };
      })
      .sort((left, right) => right.salesCount - left.salesCount || left.id.localeCompare(right.id))
      .slice(0, 20);
  }

  async function getOverview(input = {}) {
    const rangeInfo = normalizeRange(input, { now: nowProvider(), allowCustom: false });
    const { orders, byOrder } = await loadOrdersAndItems(rangeInfo);
    const sales = aggregateSales(rangeInfo, orders, byOrder);
    const events = await loadEventLogs(rangeInfo);
    const productIds = Array.from(sales.current.products.keys());
    const products = await loadProducts(productIds);
    const hasEvents = sales.current.saleEvents > 0 || events.priceLogs.length > 0 || events.inventoryLogs.length > 0;
    if (!hasEvents) {
      return {
        range: rangeInfo.range,
        status: "empty",
        message: "所选周期内没有真实成交、报价或库存变动记录",
        summary: {
          salesCount: 0,
          salesAmountCents: 0,
          orderCount: 0,
          averagePriceCents: null,
          changes: { salesCount: null, salesAmountCents: null, orderCount: null, averagePriceCents: null }
        },
        series: [],
        ranking: [],
        updatedAt: requiredDate(nowProvider(), "now").toISOString()
      };
    }
    const currentAverage = weightedAverage(sales.current.salesAmountCents, sales.current.salesCount);
    const previousAverage = weightedAverage(sales.previous.salesAmountCents, sales.previous.salesCount);
    const messages = ["销量和销售额按有效订单快照毛额统计；部分退款未冲减，全额退款订单已排除。"];
    if (!events.priceLogs.length) messages.push("所选周期内没有真实报价日志，未合成历史报价。");
    return {
      range: rangeInfo.range,
      status: "available",
      message: messages.join(" "),
      summary: {
        salesCount: sales.current.salesCount,
        salesAmountCents: sales.current.salesAmountCents,
        orderCount: sales.current.orderIds.size,
        averagePriceCents: currentAverage,
        changes: {
          salesCount: percentageChange(sales.current.salesCount, sales.previous.salesCount),
          salesAmountCents: percentageChange(sales.current.salesAmountCents, sales.previous.salesAmountCents),
          orderCount: percentageChange(sales.current.orderIds.size, sales.previous.orderIds.size),
          averagePriceCents: previousAverage === null || currentAverage === null
            ? null
            : percentageChange(currentAverage, previousAverage)
        }
      },
      series: overviewSeries(rangeInfo, sales.current, events.priceLogs, events.inventoryLogs),
      ranking: overviewRanking(sales.current, sales.previous, products.map),
      updatedAt: requiredDate(nowProvider(), "now").toISOString()
    };
  }

  async function getProductDetail(input = {}) {
    const productId = safeText(input.productId, 128);
    if (!productId) fail("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
    const rangeInfo = normalizeRange(input, { now: nowProvider(), allowCustom: true });
    const product = await getProduct(productId);
    const { orders, byOrder } = await loadOrdersAndItems(rangeInfo, { includePrevious: false });
    const sales = aggregateSales(rangeInfo, orders, byOrder);
    const events = await loadEventLogs(rangeInfo, { productId, includeInventory: false });
    const current = sales.current.products.get(productId) || {
      salesCount: 0,
      salesAmountCents: 0,
      orderIds: new Set(),
      minPrice: null,
      maxPrice: null,
      byDate: new Map()
    };
    const productBuckets = Array.from(sales.current.byDate.values()).map((bucket) => {
      const productDay = current.byDate && current.byDate.get(bucket.date);
      return productDay || {
        date: bucket.date,
        quantity: 0,
        amount: 0,
        orderIds: new Set(),
        minPrice: null,
        maxPrice: null
      };
    });
    const productPriceLogs = events.priceLogs.filter((log) => safeText(log.productId, 128) === productId);
    const listPriceTrend = productPriceLogs.map((log) => ({
      date: formatShanghaiDate(log.createdAt),
      price: priceFromLog(log),
      source: "price_logs"
    }));
    const shaped = shapeProduct(product);
    return {
      range: {
        value: rangeInfo.range,
        days: rangeInfo.days,
        startDate: formatShanghaiDate(rangeInfo.start),
        endDate: formatShanghaiDate(new Date(rangeInfo.end.getTime() - DAY_MS))
      },
      product: shaped,
      summary: {
        totalQuantity: current.salesCount,
        totalAmount: current.salesAmountCents,
        orderCount: current.orderIds.size,
        avgDealPrice: weightedAverage(current.salesAmountCents, current.salesCount) || 0,
        maxDealPrice: current.maxPrice === null || current.maxPrice === undefined ? 0 : current.maxPrice,
        minDealPrice: current.minPrice === null || current.minPrice === undefined ? 0 : current.minPrice,
        currentPrice: shaped.currentPrice
      },
      salesTrend: productBuckets.map((bucket) => ({
        date: bucket.date,
        quantity: bucket.quantity,
        amount: bucket.amount,
        orderCount: bucket.orderIds.size
      })),
      dealPriceTrend: productBuckets.map((bucket) => ({
        date: bucket.date,
        avgPrice: weightedAverage(bucket.amount, bucket.quantity) || 0,
        maxPrice: bucket.maxPrice === null ? 0 : bucket.maxPrice,
        minPrice: bucket.minPrice === null ? 0 : bucket.minPrice
      })),
      listPriceTrend,
      message: [
        "销量和销售额按有效订单快照毛额统计；部分退款未冲减，全额退款订单已排除。",
        listPriceTrend.length ? "" : "所选周期内没有真实报价日志，未合成当前价或历史报价。"
      ].filter(Boolean).join(" ")
    };
  }

  return { getOverview, getProductDetail };
}

module.exports = {
  ALLOWED_RANGES,
  DEFAULT_QUERY_LIMITS,
  EFFECTIVE_ORDER_STATUSES,
  EFFECTIVE_PAYMENT_STATUSES,
  INVALID_ORDER_STATUSES,
  ProductAnalyticsError,
  createCloudBaseProductAnalyticsRepository,
  createProductAnalyticsQueryService,
  formatShanghaiDate,
  isEffectiveOrder,
  normalizeRange,
  percentageChange,
  priceFromLog,
  inventoryDelta
};
