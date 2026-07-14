const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission, hasPermission } = require("./auth");
const { canViewFullPhone, canViewMaskedPhone, canSearchByPhone, maskPhone } = require("./phone");
const { sanitizeOrderAddress } = require("./address");
const { createOrderQueryService } = require("./orderQueryService");
const {
  CUSTOMER_FILTER_LIMITS,
  normalizeSearchText,
  toDate,
  normalizeCustomerFilters,
  matchesCustomerFilters
} = require("./filtering");
const orderQueryService = createOrderQueryService({ db, command: _ });
const ORDER_SUMMARY_FIELDS = {
  _id: true,
  orderNo: true,
  status: true,
  paymentStatus: true,
  shippingStatus: true,
  deliveryStatus: true,
  totalAmount: true,
  itemCount: true,
  totalQuantity: true,
  quantity: true,
  productName: true,
  productImage: true,
  itemSummary: true,
  firstProductImage: true,
  shipmentDisplay: true,
  isMergedShipment: true,
  mergeShipmentId: true,
  mergeShipmentNo: true,
  mergeShipmentStatus: true,
  shippingCompany: true,
  expressCompany: true,
  trackingNo: true,
  expressNo: true,
  createdAt: true,
  updatedAt: true
};

async function isAdmin(openid) {
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  return res.data.length > 0;
}

function cleanFilters(input = {}) {
  return {
    startDate: input.startDate || "",
    endDate: input.endDate || "",
    orderStatus: input.orderStatus || "all",
    paymentStatus: input.paymentStatus || "all",
    deliveryType: input.deliveryType || "all",
    deliveryStatus: input.deliveryStatus || "all",
    customerKeyword: input.customerKeyword || "",
    productKeyword: input.productKeyword || "",
    includeCancelled: Boolean(input.includeCancelled)
  };
}

function buildWhere(event = {}) {
  const filters = cleanFilters(event.filters || {});
  const where = {};
  const start = toDate(filters.startDate);
  const end = toDate(filters.endDate);

  if (start && end) where.createdAt = _.gte(start).and(_.lte(end));
  else if (start) where.createdAt = _.gte(start);
  else if (end) where.createdAt = _.lte(end);

  if (filters.orderStatus && filters.orderStatus !== "all") {
    where.status = filters.orderStatus;
  } else if (event.status) {
    where.status = event.status;
  } else if (!filters.includeCancelled) {
    where.status = _.neq("cancelled");
  }

  if (filters.paymentStatus && filters.paymentStatus !== "all") where.paymentStatus = filters.paymentStatus;
  if (filters.deliveryType && filters.deliveryType !== "all") where.deliveryType = filters.deliveryType;
  if (filters.deliveryStatus && filters.deliveryStatus !== "all") where.deliveryStatus = filters.deliveryStatus;
  if (event.userOpenid) where.userOpenid = event.userOpenid;
  if (event.productId) where.productId = event.productId;
  return { where, filters };
}

function isCollectionNotExists(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.filter((value) => value !== undefined && value !== null && value !== "")));
}

function chunkValues(values = [], size = 20) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function queryByIn(collectionName, field, values, options = {}) {
  const unique = uniqueValues(values);
  if (!unique.length) return [];
  const chunks = chunkValues(unique, options.chunkSize || 20);
  try {
    const chunkResults = await mapWithConcurrency(chunks, options.concurrency || 5, async (chunk) => {
      const records = [];
      const pageSize = 100;
      let offset = 0;
      while (true) {
        const res = await db.collection(collectionName)
          .where({ [field]: _.in(chunk) })
          .skip(offset)
          .limit(pageSize)
          .get();
        const page = res.data || [];
        records.push(...page);
        if (page.length < pageSize) break;
        offset += page.length;
      }
      return records;
    });
    return chunkResults.flat();
  } catch (err) {
    if (options.ignoreAllErrors || (options.ignoreMissingCollection && isCollectionNotExists(err))) return [];
    throw err;
  }
}

async function getOrderItemsMap(orders = []) {
  const orderIds = uniqueValues(orders.map((order) => order._id));
  const records = await queryByIn("order_items", "orderId", orderIds, { ignoreMissingCollection: true });
  return records.reduce((map, item) => {
    if (!map[item.orderId]) map[item.orderId] = [];
    map[item.orderId].push(item);
    return map;
  }, {});
}

async function getProductsMap(itemMap = {}, orders = []) {
  const productIds = uniqueValues([
    ...Object.values(itemMap).flat().map((item) => item.productId),
    ...orders.map((order) => order.productId)
  ]);
  const products = await queryByIn("products", "_id", productIds, { ignoreAllErrors: true });
  return products.reduce((map, product) => {
    if (product && product._id) map[product._id] = product;
    return map;
  }, {});
}

async function getUsersMaps(orders = []) {
  const userIds = uniqueValues(orders.map((order) => order.userId));
  const openids = uniqueValues(orders.map((order) => order.userOpenid));
  const [usersByIdRecords, usersByOpenidRecords] = await Promise.all([
    queryByIn("users", "_id", userIds, { ignoreAllErrors: true }),
    queryByIn("users", "openid", openids, { ignoreMissingCollection: true })
  ]);
  const byId = {};
  const byOpenid = {};
  [...usersByIdRecords, ...usersByOpenidRecords].forEach((user) => {
    if (user && user._id && !byId[user._id]) byId[user._id] = user;
    if (user && user.openid && !byOpenid[user.openid]) byOpenid[user.openid] = user;
  });
  return { byId, byOpenid };
}

async function getCustomerAccountMaps(orders = []) {
  const userIds = uniqueValues(orders.map((order) => order.userId));
  const openids = uniqueValues(orders.map((order) => order.userOpenid));
  const [accountsByIdRecords, accountsByOpenidRecords] = await Promise.all([
    queryByIn("customer_accounts", "userId", userIds, { ignoreMissingCollection: true }),
    queryByIn("customer_accounts", "userOpenid", openids, { ignoreMissingCollection: true })
  ]);
  const byUserId = {};
  const byOpenid = {};
  [...accountsByIdRecords, ...accountsByOpenidRecords].forEach((account) => {
    if (account && account.userId && !byUserId[account.userId]) byUserId[account.userId] = account;
    if (account && account.userOpenid && !byOpenid[account.userOpenid]) byOpenid[account.userOpenid] = account;
  });
  return { byUserId, byOpenid };
}

function attachItems(order, admin, itemMap = {}, productMap = {}) {
  let items = itemMap[order._id] || [];
  if (!items.length && order.productId) {
    items = [{
      productId: order.productId,
      productName: order.productName,
      productImage: order.productImage || "",
      specification: order.specification || "",
      productionDate: order.productionDate || "",
      quantity: order.quantity,
      unitPrice: order.unitPrice,
      totalAmount: order.totalAmount,
      stockCheckStatus: "pending"
    }];
  }

  if (admin) {
    items = items.map((item) => {
      const product = productMap[item.productId] || null;
      if (!product) return { ...item, currentStock: null };
      return {
        ...item,
        currentStock: Number(product.stock || 0),
        productIndex: item.productIndex || product.productIndex || "",
        skuCode: item.skuCode || item.sku || product.skuCode || ""
      };
    });
  }

  const totalQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  return {
    ...order,
    items,
    itemCount: order.itemCount || items.length,
    totalQuantity,
    itemSummary: items.length > 1 ? `${items[0].productName} 等 ${items.length} 件商品` : (items[0] && items[0].productName) || order.productName
  };
}

function attachUser(order, userMaps = {}) {
  const user = (userMaps.byId && userMaps.byId[order.userId])
    || (userMaps.byOpenid && userMaps.byOpenid[order.userOpenid])
    || null;
  return { ...order, user };
}

function attachAdminCustomerFlags(order, accountMaps = {}) {
  const account = (accountMaps.byUserId && accountMaps.byUserId[order.userId])
    || (accountMaps.byOpenid && accountMaps.byOpenid[order.userOpenid])
    || null;
  const riskLevel = normalizeRiskLevel((account && account.riskLevel) || order.riskLevelSnapshot || "normal");
  return {
    ...order,
    customerRiskLevel: riskLevel,
    customerAdminTags: (account && account.adminTags) || [],
    customerAdminNoteSummary: summaryText(account && (account.adminNote || account.adminRemark)),
    adminNoteSummary: summaryText(order.adminNote)
  };
}

function normalizeRiskLevel(value) {
  if (value === "watch") return "important";
  if (value === "risky") return "risk";
  return value || "normal";
}

function summaryText(value, maxLength = 20) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function stripAdminFields(order) {
  const blockedKeys = [
    "adminNote",
    "adminNoteSummary",
    "adminNoteUpdatedAt",
    "adminNoteUpdatedBy",
    "adminNoteUpdatedByOpenid",
    "adminTags",
    "customerAdminTags",
    "customerAdminNoteSummary",
    "customerRiskLevel",
    "riskLevel",
    "riskLevelSnapshot",
    "idempotencyKey",
    "idempotencyActionType",
    "submitIdempotencyKey",
    "idempotencyRequestHash",
    "requestHash",
    "cartSubmitHash",
    "cartItemIds",
    "selectedCartItemIds",
    "orderSource",
    "customerPhoneSnapshot",
    "adminRemark",
    "customerRemark",
    "shipmentRemark"
  ];
  const clean = { ...order };
  blockedKeys.forEach((key) => delete clean[key]);
  if (clean.user) {
    const user = { ...clean.user };
    blockedKeys.forEach((key) => delete user[key]);
    clean.user = user;
  }
  return clean;
}

function attachShipmentDisplay(order) {
  const shippingStatus = order.shippingStatus || (
    order.deliveryStatus === "shipped" ? "shipped"
      : order.deliveryStatus === "completed" ? "completed"
        : order.deliveryStatus === "after_sales" ? "abnormal"
          : ""
  );
  const isMergedShipment = order.isMergedShipment === true
    && !!order.mergeShipmentId
    && order.mergeShipmentStatus !== "cancelled";
  return {
    ...order,
    isMergedShipment,
    mergeShipmentStatus: isMergedShipment ? (order.mergeShipmentStatus || shippingStatus || "created") : (order.mergeShipmentStatus || ""),
    shippingStatus,
    shippingCompany: order.shippingCompany || order.expressCompany || "",
    trackingNo: order.trackingNo || order.expressNo || "",
    shipmentDisplay: {
      isMergedShipment,
      mergeShipmentId: isMergedShipment ? order.mergeShipmentId : "",
      mergeShipmentNo: isMergedShipment ? (order.mergeShipmentNo || "") : "",
      mergeShipmentStatus: isMergedShipment ? (order.mergeShipmentStatus || shippingStatus || "created") : "",
      shippingStatus,
      shippingCompany: order.shippingCompany || order.expressCompany || "",
      trackingNo: order.trackingNo || order.expressNo || "",
      shippedAt: order.shippedAt || null
    }
  };
}

function stripPaymentFields(order) {
  const clean = { ...order };
  delete clean.paymentScreenshotUrl;
  delete clean.paymentScreenshotUrls;
  delete clean.paymentFileID;
  delete clean.latestPaymentRecordId;
  delete clean.wechatPayTransactionId;
  delete clean.wechatPayOutTradeNo;
  if (!clean.hasUnpaid) {
    clean.hasUnpaid = Number(clean.unpaidAmount || 0) > 0 || ["unpaid", "partial_paid", "pending_confirm", "abnormal"].includes(clean.paymentStatus);
  }
  delete clean.paidAmount;
  delete clean.unpaidAmount;
  delete clean.payableAmount;
  delete clean.historicalUnpaidAmount;
  delete clean.todayOrderAmount;
  if (clean.account) delete clean.account;
  return clean;
}

function firstImageFromOrder(order = {}) {
  if (order.firstProductImage) return order.firstProductImage;
  if (order.productImage) return order.productImage;
  const items = Array.isArray(order.items) ? order.items : [];
  return items[0] && (items[0].productImage || items[0].imageUrl) || "";
}

async function getOrderItemSummaryMap(orders = []) {
  const itemMap = await getOrderItemsMap(orders);
  return Object.entries(itemMap).reduce((map, [orderId, items]) => {
    map[orderId] = {
      items,
      itemCount: items.length,
      totalQuantity: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
    };
    return map;
  }, {});
}

function summarizeOrder(order = {}, itemSummary = null) {
  const items = itemSummary && itemSummary.items || (Array.isArray(order.items) ? order.items : []);
  const firstItem = items[0] || {};
  const firstProductName = firstItem.productName || order.productName || order.itemSummary || "";
  const itemCount = Number(order.itemCount || (itemSummary && itemSummary.itemCount) || (items.length || 1));
  const totalQuantity = Number(order.totalQuantity || order.quantity || (itemSummary && itemSummary.totalQuantity) || items.reduce((sum, item) => sum + Number(item.quantity || 0), 0));
  return {
    _id: order._id,
    orderId: order._id,
    orderNo: order.orderNo || "",
    status: order.status || "",
    paymentStatus: order.paymentStatus || "",
    shippingStatus: order.shippingStatus || order.deliveryStatus || "",
    deliveryStatus: order.deliveryStatus || "",
    totalAmount: Number(order.totalAmount || 0),
    itemCount,
    totalQuantity,
    firstProductName,
    firstProductImage: firstImageFromOrder({ ...order, items }),
    itemSummary: order.itemSummary || (itemCount > 1 ? `${firstProductName} 等 ${itemCount} 件商品` : firstProductName),
    productName: order.productName || firstProductName,
    shipmentDisplay: order.shipmentDisplay || null,
    isMergedShipment: order.isMergedShipment === true,
    mergeShipmentId: order.mergeShipmentId || "",
    mergeShipmentNo: order.mergeShipmentNo || "",
    mergeShipmentStatus: order.mergeShipmentStatus || "",
    shippingCompany: order.shippingCompany || order.expressCompany || "",
    trackingNo: order.trackingNo || order.expressNo || "",
    createdAt: order.createdAt || null,
    updatedAt: order.updatedAt || order.createdAt || null
  };
}

function applyAdminDataScope(order, admin) {
  if (!admin || admin.role === "super_admin") return order;
  let clean = { ...order };
  if (!hasPermission(admin, "payment:view_screenshot")) {
    clean = stripPaymentFields(clean);
  }
  if (!hasPermission(admin, "customer:view_account")) {
    delete clean.account;
    delete clean.customerAccount;
    delete clean.totalUnpaidAmount;
    delete clean.historyUnpaidAmount;
  }
  return clean;
}

function attachAdminPhone(order, admin) {
  if (!canViewMaskedPhone(admin)) return order;
  const full = order.customerPhoneSnapshot
    || (order.user && (order.user.phoneNumber || order.user.phone))
    || "";
  const masked = order.customerPhoneMasked || maskPhone(full);
  const phonePatch = {
    customerPhoneDisplay: canViewFullPhone(admin) ? (full || masked) : masked,
    customerPhoneMasked: masked,
    customerPhoneVerifiedAt: order.customerPhoneVerifiedAt || null,
    customerPhoneBindMethod: order.customerPhoneBindMethod || ""
  };
  if (!canViewFullPhone(admin)) {
    const clean = { ...order, ...phonePatch };
    delete clean.customerPhoneSnapshot;
    return clean;
  }
  return { ...order, ...phonePatch };
}

function filterByKeywords(orders, filters, admin) {
  const customerKeyword = normalizeSearchText(filters.customerKeyword);
  const productKeyword = normalizeSearchText(filters.productKeyword);
  if (!customerKeyword && !productKeyword) return orders;

  const matched = [];
  for (const order of orders) {
    const withUser = order;
    if (customerKeyword) {
      const user = withUser.user || {};
      const customerText = normalizeSearchText([
        user.nickname,
        canSearchByPhone(admin) ? (user.phoneNumber || user.phone || withUser.customerPhoneSnapshot || withUser.customerPhoneMasked) : "",
        user.openid,
        withUser.userOpenid,
        withUser.userId
      ].filter(Boolean).join(" "));
      if (!customerText.includes(customerKeyword)) continue;
    }

    if (productKeyword) {
      const productMatched = (withUser.items || []).some((item) => {
        const text = normalizeSearchText([
          item.productName,
          item.specification,
          item.productionDate,
          item.productIndex,
          item.skuCode,
          item.productId
        ].filter(Boolean).join(" "));
        return text.includes(productKeyword);
      });
      if (!productMatched) continue;
    }

    matched.push(withUser);
  }
  return matched;
}

function invalidCustomerCursor() {
  const error = new Error("分页游标无效");
  error.code = "INVALID_ORDER_FILTERS";
  return error;
}

function encodeCustomerCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64");
}

function decodeCustomerCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8"));
    if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error("invalid offset");
    return parsed.offset;
  } catch (error) {
    throw invalidCustomerCursor();
  }
}

function buildCustomerWhere(openid, filters) {
  const where = { userOpenid: openid };
  if (filters.startDate && filters.endDate) {
    where.createdAt = _.gte(filters.startDate).and(_.lte(filters.endDate));
  } else if (filters.startDate) {
    where.createdAt = _.gte(filters.startDate);
  } else if (filters.endDate) {
    where.createdAt = _.lte(filters.endDate);
  }
  return where;
}

async function shapeCustomerSummaryBatch(rows) {
  const itemSummaryMap = await getOrderItemSummaryMap(rows);
  return rows.map((rawOrder) => {
    let safeOrder = attachShipmentDisplay(rawOrder);
    safeOrder = stripAdminFields(safeOrder);
    safeOrder = sanitizeOrderAddress(safeOrder);
    return {
      order: summarizeOrder(safeOrder, itemSummaryMap[rawOrder._id]),
      itemSummary: itemSummaryMap[rawOrder._id] || { items: [] }
    };
  });
}

async function queryFilteredCustomerOrders(openid, event, pageSize) {
  const filters = normalizeCustomerFilters(event.filters || {});
  const where = buildCustomerWhere(openid, filters);
  let offset = decodeCustomerCursor(event.cursor);
  let scanned = 0;
  const orders = [];
  let hasMore = true;

  while (orders.length < pageSize && scanned < CUSTOMER_FILTER_LIMITS.scan && hasMore) {
    const remaining = CUSTOMER_FILTER_LIMITS.scan - scanned;
    const batchSize = Math.min(CUSTOMER_FILTER_LIMITS.batch, remaining);
    const response = await db.collection("orders")
      .where(where)
      .field(ORDER_SUMMARY_FIELDS)
      .orderBy("createdAt", "desc")
      .skip(offset)
      .limit(batchSize + 1)
      .get();
    const sourceRows = response.data || [];
    const rows = sourceRows.slice(0, batchSize);
    const shapedRows = await shapeCustomerSummaryBatch(rows);
    const batchHasMore = sourceRows.length > batchSize;
    let consumed = 0;

    for (const shaped of shapedRows) {
      consumed += 1;
      scanned += 1;
      if (matchesCustomerFilters(shaped.order, shaped.itemSummary, filters)) orders.push(shaped.order);
      if (orders.length >= pageSize || scanned >= CUSTOMER_FILTER_LIMITS.scan) break;
    }

    offset += consumed;
    const leftInBatch = consumed < rows.length;
    hasMore = leftInBatch || batchHasMore;
    if (!rows.length) hasMore = false;
  }

  return {
    orders,
    page: 1,
    pageSize,
    hasMore,
    nextCursor: hasMore ? encodeCustomerCursor(offset) : ""
  };
}

function isCustomerFilteredRequest(event = {}) {
  return event.admin !== true && !event.orderId && (Boolean(event.cursor) || Boolean(event.filters));
}

function parsePageSize(event = {}) {
  const hasPageSize = event.pageSize !== undefined && event.pageSize !== null && event.pageSize !== "";
  const parsed = Number(hasPageSize ? event.pageSize : event.limit);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  try {
    let admin = null;
    if (event.admin === true) {
      admin = await requirePermission("order:view");
    }
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = parsePageSize(event);
    if (isCustomerFilteredRequest(event)) {
      const data = await queryFilteredCustomerOrders(openid, event, pageSize);
      return { ok: true, data: { ...data, isAdmin: false } };
    }
    const summaryOnly = event.summaryOnly === true;
    const filters = cleanFilters(event.filters || {});
    if (event.status && (!filters.orderStatus || filters.orderStatus === "all")) filters.orderStatus = event.status;
    const result = await orderQueryService.listLegacyOrders({
      principal: admin,
      userOpenid: openid,
      requestedUserOpenid: admin ? event.userOpenid : "",
      filters,
      page,
      pageSize,
      orderId: event.orderId,
      productId: event.productId,
      summaryOnly
    });

    return {
      ok: true,
      data: {
        orders: result.orders,
        isAdmin: !!admin,
        page,
        pageSize,
        hasMore: result.hasMore
      }
    };
  } catch (err) {
    return { ok: false, message: err.message || "获取订单失败" };
  }
};

