const crypto = require("crypto");

const ORDER_STATUS_VALUES = new Set([
  "pending_system", "pending_admin", "auto_reviewing", "approved_pending_payment", "pending_payment_confirm",
  "paid", "unpaid", "partial_paid", "abnormal", "pending_shipment", "shipped", "completed",
  "rejected", "cancelled", "refunded"
]);
const MAX_WEB_LIST_ORDER_ITEMS = 2000;
const MAX_WEB_DETAIL_ORDER_ITEMS = 500;
const MAX_LEGACY_SEARCH_ORDERS = 1000;
const MAX_LEGACY_SEARCH_ORDER_ITEMS = 5000;
const LEGACY_PUBLIC_SENSITIVE_FIELDS = new Set([
  "adminNote", "adminNoteSummary", "adminNoteUpdatedAt", "adminNoteUpdatedBy", "adminNoteUpdatedByOpenid",
  "adminTags", "customerAdminTags", "customerAdminNoteSummary", "customerRiskLevel", "riskLevel", "riskLevelSnapshot",
  "orderSource", "adminRemark", "customerRemark", "shipmentRemark", "internalNotes", "content", "authorId", "authorRole", "authorName", "internalTags", "defectDescription",
  "idempotencyKey", "idempotencyActionType", "submitIdempotencyKey", "idempotencyRequestHash", "requestHash",
  "cartSubmitHash", "cartItemIds", "selectedCartItemIds",
  "customerPhoneSnapshot", "customerPhoneDisplay", "phone", "phoneNumber", "mobile", "fullPhone", "receiverPhone", "contactPhone",
  "openid", "_openid", "operatorOpenid", "operatorId",
  "shippingAddressSnapshot", "shippingAddress", "shippingAddressMasked", "detailAddress", "fullAddress",
  "paymentScreenshotUrl", "paymentScreenshotUrls", "paymentFileID", "paymentProof", "paymentProofs", "latestPaymentRecordId",
  "wechatPayTransactionId", "wechatPayOutTradeNo", "transactionNo", "transactionId", "outTradeNo",
  "account", "customerAccount", "supplier", "supplierId", "supplierName", "supplierCode",
  "cost", "costPrice", "costAmount", "purchasePrice", "profit", "profitAmount", "margin"
]);

class OrderQueryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "OrderQueryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanText(value, max = 240) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function safeInteger(value, fallback = 0) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function dateIso(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hasPermission(principal, permission) {
  if (!principal || principal.status === "disabled" || principal.status === "inactive" || principal.isActive === false) return false;
  return principal.role === "super_admin"
    || (Array.isArray(principal.permissions) && (principal.permissions.includes("*") || principal.permissions.includes(permission)));
}

function maskPhone(value) {
  const digits = cleanText(value, 40).replace(/\D/g, "").slice(-11);
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return digits ? "***" : "";
}

function maskName(value) {
  const text = cleanText(value, 80);
  if (!text) return "客户";
  return text.length === 1 ? `${text}*` : `${text.slice(0, 1)}${"*".repeat(Math.min(3, text.length - 1))}`;
}

function maskAddressText(value) {
  const text = cleanText(value, 360);
  if (!text) return "";
  return text.length <= 4 ? `${text.slice(0, 1)}**` : `${text.slice(0, Math.ceil(text.length / 2))}**`;
}

function sanitizeLegacyPublicValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeLegacyPublicValue);
  if (!value || typeof value !== "object" || value instanceof Date || typeof value.toDate === "function") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const clean = {};
  for (const [key, nested] of Object.entries(value)) {
    if (LEGACY_PUBLIC_SENSITIVE_FIELDS.has(key)) continue;
    if (/openid$/i.test(key)) continue;
    if (!/phoneMasked$/i.test(key) && /(?:phone|mobile)(?:number|snapshot|display)?$/i.test(key)) continue;
    if (/^(?:internalTags?|supplier|cost|purchasePrice|profit|margin)/i.test(key)) continue;
    if (/(?:riskLevel|riskReason|blockedReason)/i.test(key)) continue;
    if (/(?:paymentScreenshot|paymentProof|paymentFile|paymentRecordId|wechatPayTransaction|outTradeNo|tradeNo|transactionId|transactionNo)/i.test(key)) continue;
    if (/phoneMasked$/i.test(key)) clean[key] = maskPhone(nested);
    else clean[key] = sanitizeLegacyPublicValue(nested);
  }
  return clean;
}

function normalizeRiskLevel(value) {
  if (value === "watch") return "important";
  if (value === "risky") return "risk";
  return ["normal", "important", "risk", "blocked"].includes(value) ? value : "normal";
}

function isMissingCollection(error) {
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(String(error && error.message || error || ""));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function chunks(values, size = 20) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function normalizeSearchText(value) {
  return cleanText(value, 300)
    .replace(/[\uFF01-\uFF5E]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/[，、。；;:：|/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortText(value, max = 20) {
  const text = cleanText(value, max + 1);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function stableFilterHash(filters) {
  return crypto.createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 24);
}

function encodeCursor(row, filterHash) {
  const createdAt = dateIso(row.createdAt);
  const id = cleanText(row._id || row.id, 128);
  if (!createdAt || !id) return null;
  return Buffer.from(JSON.stringify({ v: 1, createdAt, id, filterHash }), "utf8").toString("base64url");
}

function decodeCursor(value, expectedFilterHash) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cleanText(value, 4096), "base64url").toString("utf8"));
    const createdAt = dateIso(parsed.createdAt);
    const id = cleanText(parsed.id, 128);
    if (parsed.v !== 1 || !createdAt || !id || parsed.filterHash !== expectedFilterHash) throw new Error("invalid");
    return { createdAt: new Date(createdAt), id };
  } catch (error) {
    throw new OrderQueryError("INVALID_CURSOR", "订单分页游标无效或与当前筛选条件不一致", 400);
  }
}

function normalizeDateFilter(value, name) {
  if (value === undefined || value === null || value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new OrderQueryError("INVALID_DATE_FILTER", `${name} 格式无效`, 400);
  return date.toISOString();
}

function normalizeWebFilters(input = {}) {
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(input.pageSize || input.limit, 10) || 20));
  const status = cleanText(input.status, 60);
  if (status && !ORDER_STATUS_VALUES.has(status)) throw new OrderQueryError("INVALID_ORDER_STATUS", "订单状态筛选无效", 400);
  const filters = {
    search: cleanText(input.search, 100),
    status,
    paymentStatus: cleanText(input.paymentStatus, 60),
    deliveryType: cleanText(input.deliveryType, 60),
    deliveryStatus: cleanText(input.deliveryStatus, 60),
    startDate: normalizeDateFilter(input.startDate, "startDate"),
    endDate: normalizeDateFilter(input.endDate, "endDate")
  };
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    throw new OrderQueryError("INVALID_DATE_RANGE", "开始时间不能晚于结束时间", 400);
  }
  return { pageSize, filters };
}

function createOrderQueryService({ db, command }) {
  if (!db || !command) throw new Error("order query service requires db and command");

  async function queryByIn(collectionName, field, values, options = {}) {
    const ids = unique(values);
    if (!ids.length) return [];
    try {
      const rows = [];
      for (const part of chunks(ids)) {
        let offset = 0;
        while (true) {
          const remaining = options.maxRows ? options.maxRows - rows.length : 100;
          const queryLimit = options.maxRows ? Math.min(100, remaining + 1) : 100;
          const result = await db.collection(collectionName).where({ [field]: command.in(part) }).skip(offset).limit(queryLimit).get();
          const page = Array.isArray(result.data) ? result.data : [];
          rows.push(...page);
          if (options.maxRows && rows.length > options.maxRows) {
            throw new OrderQueryError(options.limitCode || "RELATED_ROWS_LIMIT_EXCEEDED", options.limitMessage || "关联数据量超出安全上限", 503);
          }
          if (page.length < queryLimit) break;
          offset += page.length;
        }
      }
      return rows;
    } catch (error) {
      if (options.optional && isMissingCollection(error)) return [];
      throw error;
    }
  }

  function combine(conditions) {
    const usable = conditions.filter(Boolean);
    if (!usable.length) return null;
    return usable.length === 1 ? usable[0] : command.and(usable);
  }

  function buildFilterWhere(filters) {
    const conditions = [];
    if (filters.status) conditions.push({ status: filters.status });
    if (filters.paymentStatus) conditions.push({ paymentStatus: filters.paymentStatus });
    if (filters.deliveryType) conditions.push({ deliveryType: filters.deliveryType });
    if (filters.deliveryStatus) conditions.push(command.or([
      { deliveryStatus: filters.deliveryStatus },
      { shippingStatus: filters.deliveryStatus }
    ]));
    if (filters.startDate || filters.endDate) {
      if (filters.startDate && filters.endDate) {
        conditions.push({ createdAt: command.gte(new Date(filters.startDate)).and(command.lte(new Date(filters.endDate))) });
      } else if (filters.startDate) conditions.push({ createdAt: command.gte(new Date(filters.startDate)) });
      else conditions.push({ createdAt: command.lte(new Date(filters.endDate)) });
    }
    if (filters.search) {
      if (typeof db.RegExp !== "function") throw new OrderQueryError("ORDER_SEARCH_UNAVAILABLE", "当前环境不支持订单搜索", 503);
      const escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = db.RegExp({ regexp: escaped, options: "i" });
      conditions.push(command.or([{ orderNo: regex }, { customerPhoneMasked: regex }]));
    }
    return combine(conditions);
  }

  function cursorWhere(cursor) {
    if (!cursor) return null;
    return command.or([
      { createdAt: command.lt(cursor.createdAt) },
      command.and([{ createdAt: cursor.createdAt }, { _id: command.lt(cursor.id) }])
    ]);
  }

  async function relatedMaps(orders, includeAccounts = true, includeProducts = false, options = {}) {
    const orderIds = unique(orders.map((row) => row._id));
    const userIds = unique(orders.map((row) => row.userId));
    const openids = unique(orders.map((row) => row.userOpenid));
    const [items, usersById, usersByOpenid, accountsById, accountsByOpenid] = await Promise.all([
      queryByIn("order_items", "orderId", orderIds, {
        optional: true,
        maxRows: options.maxOrderItems || MAX_WEB_LIST_ORDER_ITEMS,
        limitCode: "ORDER_ITEMS_LIMIT_EXCEEDED",
        limitMessage: "订单商品明细数量超出安全上限"
      }),
      includeAccounts ? queryByIn("users", "_id", userIds, { optional: true }) : Promise.resolve([]),
      includeAccounts ? queryByIn("users", "openid", openids, { optional: true }) : Promise.resolve([]),
      includeAccounts ? queryByIn("customer_accounts", "userId", userIds, { optional: true }) : Promise.resolve([]),
      includeAccounts ? queryByIn("customer_accounts", "userOpenid", openids, { optional: true }) : Promise.resolve([])
    ]);
    const itemMap = {};
    for (const item of items) (itemMap[item.orderId] ||= []).push(item);
    const users = { byId: {}, byOpenid: {} };
    for (const user of [...usersById, ...usersByOpenid]) {
      if (user._id && !users.byId[user._id]) users.byId[user._id] = user;
      if (user.openid && !users.byOpenid[user.openid]) users.byOpenid[user.openid] = user;
    }
    const accounts = { byId: {}, byOpenid: {} };
    for (const account of [...accountsById, ...accountsByOpenid]) {
      if (account.userId && !accounts.byId[account.userId]) accounts.byId[account.userId] = account;
      if (account.userOpenid && !accounts.byOpenid[account.userOpenid]) accounts.byOpenid[account.userOpenid] = account;
    }
    const products = {};
    if (includeProducts) {
      const productIds = unique([
        ...items.map((item) => item.productId),
        ...orders.map((order) => order.productId)
      ]);
      for (const product of await queryByIn("products", "_id", productIds, { optional: true })) {
        if (product._id && !products[product._id]) products[product._id] = product;
      }
    }
    return { itemMap, users, accounts, products };
  }

  async function orderInternalNotes(orderId) {
    try {
      const response = await db.collection("note_logs").where({ targetType: "order", targetId: orderId })
        .orderBy("createdAt", "desc").limit(100).get();
      return (Array.isArray(response.data) ? response.data : []).map((row) => {
        const content = cleanText(row && (row.content || row.afterNote), 500);
        const createdAt = dateIso(row && row.createdAt);
        const id = cleanText(row && (row._id || row.id), 128);
        if (!content || !createdAt || !id) return null;
        return { id, content, authorId: cleanText(row.authorId || row.operatorId, 128), authorRole: cleanText(row.authorRole || row.operatorRole, 50), authorName: cleanText(row.authorName || row.operatorName, 80), createdAt };
      }).filter(Boolean);
    } catch (error) {
      if (isMissingCollection(error)) return [];
      throw new OrderQueryError("ORDER_READ_FAILED", "订单读取失败，请稍后重试", 503);
    }
  }

  function orderItems(order, itemMap, productMap = null) {
    const stored = itemMap[order._id] || [];
    if (stored.length) return productMap ? stored.map((item) => {
      const product = productMap[item.productId] || {};
      return {
        ...item,
        currentStock: Number.isFinite(Number(product.stock)) ? Number(product.stock) : null,
        productIndex: item.productIndex || product.productIndex || "",
        skuCode: item.skuCode || item.sku || product.skuCode || ""
      };
    }) : stored;
    if (!order.productId && !order.productName) return [];
    const fallback = {
      _id: `legacy:${order._id}`,
      orderId: order._id,
      productId: order.productId || "",
      productName: order.productName || "",
      productImage: order.productImage || "",
      specification: order.specification || "",
      productionDate: order.productionDate || "",
      quantity: order.quantity,
      unitPrice: order.unitPrice,
      totalAmount: order.totalAmount
    };
    if (productMap) {
      const product = productMap[fallback.productId] || {};
      fallback.currentStock = Number.isFinite(Number(product.stock)) ? Number(product.stock) : null;
      fallback.productIndex = product.productIndex || "";
      fallback.skuCode = product.skuCode || "";
    }
    return [fallback];
  }

  function customerContext(order, maps) {
    const user = maps.users.byId[order.userId] || maps.users.byOpenid[order.userOpenid] || {};
    const account = maps.accounts.byId[order.userId] || maps.accounts.byOpenid[order.userOpenid] || {};
    const nickname = cleanText(user.nickname || user.name || account.nickname || order.customerName, 80);
    const fullPhone = cleanText(order.customerPhoneSnapshot || user.phoneNumber || user.phone || account.phoneNumber || account.phone, 40);
    const phoneMasked = maskPhone(order.customerPhoneMasked || user.phoneMasked || account.phoneMasked || fullPhone);
    return { user, account, nickname, fullPhone, phoneMasked };
  }

  function safeItem(item, principal) {
    const result = {
      id: cleanText(item._id || item.id, 128),
      productId: cleanText(item.productId, 128),
      productName: cleanText(item.productName || item.name, 160),
      specification: cleanText(item.specification, 120),
      productionDate: cleanText(item.productionDate, 40),
      quantity: Math.max(0, safeInteger(item.quantity, 0))
    };
    if (hasPermission(principal, "dashboard:view_sales")) {
      if (typeof item.unitPrice === "number" && Number.isSafeInteger(item.unitPrice) && item.unitPrice >= 0) result.unitPriceCents = item.unitPrice;
      if (typeof item.totalAmount === "number" && Number.isSafeInteger(item.totalAmount) && item.totalAmount >= 0) result.totalAmountCents = item.totalAmount;
    }
    return result;
  }

  function safeAddress(order, principal) {
    const source = order.shippingAddressSnapshot || order.shippingAddress || order.shippingAddressMasked || {};
    if (!source || typeof source !== "object") return {};
    const regionText = cleanText(source.regionText || [source.province, source.city, source.district].filter(Boolean).join(" "), 160);
    const detail = cleanText(source.detailAddress || source.fullAddress, 200);
    const masked = {
      receiverName: maskName(source.receiverName),
      receiverPhoneMasked: maskPhone(source.receiverPhone || source.receiverPhoneMasked),
      regionText,
      detailAddressMasked: maskAddressText(detail || source.detailAddressMasked)
    };
    if (hasPermission(principal, "customer:view_address_full") || hasPermission(principal, "shipment:view_address_full")) {
      return { shippingAddress: {
        receiverName: cleanText(source.receiverName, 50),
        receiverPhone: cleanText(source.receiverPhone, 40),
        regionText,
        detailAddress: detail
      } };
    }
    if (hasPermission(principal, "customer:view_address_masked") || hasPermission(principal, "shipment:view_address_masked")) {
      return { shippingAddressMasked: masked };
    }
    return {};
  }

  function webProjection(order, maps, principal, detail = false) {
    const items = orderItems(order, maps.itemMap);
    const customer = customerContext(order, maps);
    const itemCount = Math.max(0, safeInteger(order.itemCount, items.length));
    const totalQuantity = Math.max(0, safeInteger(order.totalQuantity, items.reduce((sum, item) => sum + Math.max(0, safeInteger(item.quantity, 0)), 0)));
    const firstName = cleanText(items[0] && (items[0].productName || items[0].name) || order.productName, 160);
    const canViewMaskedPhone = hasPermission(principal, "customer:view_phone_masked")
      || hasPermission(principal, "customer:view_phone_full");
    const result = {
      id: cleanText(order._id || order.id, 128),
      orderNo: cleanText(order.orderNo, 100),
      customerMasked: [maskName(customer.nickname), canViewMaskedPhone ? customer.phoneMasked : ""].filter(Boolean).join(" / "),
      customerPhoneMasked: canViewMaskedPhone ? customer.phoneMasked : "",
      itemSummary: cleanText(order.itemSummary || (itemCount > 1 ? `${firstName} 等 ${itemCount} 件商品` : firstName), 240),
      itemCount,
      totalQuantity,
      status: cleanText(order.status, 60),
      paymentStatus: cleanText(order.paymentStatus, 60),
      deliveryStatus: cleanText(order.deliveryStatus || order.shippingStatus, 60),
      createdAt: dateIso(order.createdAt),
      updatedAt: dateIso(order.updatedAt || order.createdAt),
      version: Math.max(0, safeInteger(order.version ?? order.dataVersion, 0))
    };
    if (hasPermission(principal, "dashboard:view_sales") && typeof order.totalAmount === "number" && Number.isSafeInteger(order.totalAmount) && order.totalAmount >= 0) {
      result.totalAmountCents = order.totalAmount;
    }
    if (!detail) return result;
    result.items = items.map((item) => safeItem(item, principal));
    result.customer = {
      nameMasked: maskName(customer.nickname),
      phoneMasked: result.customerPhoneMasked
    };
    if (hasPermission(principal, "customer:view_phone_full")) result.customer.phone = customer.fullPhone || customer.phoneMasked;
    Object.assign(result, safeAddress(order, principal));
    if (hasPermission(principal, "order:edit_remark")) {
      result.adminRemark = cleanText(order.adminRemark || order.adminNote || order.orderAdminNote, 500);
    }
    if (hasPermission(principal, "order:review")) result.riskLevelSnapshot = normalizeRiskLevel(order.riskLevelSnapshot);
    return result;
  }

  async function listWebOrders({ principal, query = {} }) {
    if (!hasPermission(principal, "order:view")) throw new OrderQueryError("FORBIDDEN", "无权访问订单", 403);
    const { pageSize, filters } = normalizeWebFilters(query);
    const filterHash = stableFilterHash(filters);
    const cursor = decodeCursor(query.cursor, filterHash);
    const baseWhere = buildFilterWhere(filters);
    let countQuery = db.collection("orders");
    if (baseWhere) countQuery = countQuery.where(baseWhere);
    let totalResult;
    try {
      totalResult = await countQuery.count();
    } catch (error) {
      throw new OrderQueryError("ORDER_COUNT_FAILED", "订单计数失败，请稍后重试", 503);
    }
    if (!totalResult || !Number.isSafeInteger(totalResult.total) || totalResult.total < 0) {
      throw new OrderQueryError("ORDER_COUNT_INVALID", "订单计数结果无效", 503);
    }
    const where = combine([baseWhere, cursorWhere(cursor)]);
    let request = db.collection("orders");
    if (where) request = request.where(where);
    const response = await request.orderBy("createdAt", "desc").orderBy("_id", "desc").limit(pageSize + 1).get();
    const rawRows = Array.isArray(response.data) ? response.data : [];
    const hasMore = rawRows.length > pageSize;
    const rows = rawRows.slice(0, pageSize);
    const maps = await relatedMaps(rows, true, false, { maxOrderItems: MAX_WEB_LIST_ORDER_ITEMS });
    return {
      items: rows.map((row) => webProjection(row, maps, principal, false)),
      total: totalResult.total,
      page: Math.max(1, Number.parseInt(query.page, 10) || 1),
      pageSize,
      nextCursor: hasMore ? encodeCursor(rows[rows.length - 1], filterHash) : null
    };
  }

  async function getWebOrder({ principal, id }) {
    if (!hasPermission(principal, "order:view")) throw new OrderQueryError("FORBIDDEN", "无权访问订单", 403);
    const safeId = cleanText(id, 128);
    if (!safeId) throw new OrderQueryError("ORDER_ID_REQUIRED", "缺少订单 ID", 400);
    let order;
    try {
      const result = await db.collection("orders").doc(safeId).get();
      order = result && result.data;
    } catch (error) {
      throw new OrderQueryError("ORDER_READ_FAILED", "订单读取失败，请稍后重试", 503);
    }
    if (!order) throw new OrderQueryError("NOT_FOUND", "订单不存在", 404);
    const maps = await relatedMaps([order], true, false, { maxOrderItems: MAX_WEB_DETAIL_ORDER_ITEMS });
    const result = webProjection(order, maps, principal, true);
    if (hasPermission(principal, "order:edit_remark")) result.internalNotes = await orderInternalNotes(safeId);
    return result;
  }

  async function listLegacyOrders({ principal = null, userOpenid = "", filters = {}, page = 1, pageSize = 100, orderId = "", productId = "", requestedUserOpenid = "", summaryOnly = false }) {
    const admin = Boolean(principal);
    if (admin && !hasPermission(principal, "order:view")) throw new OrderQueryError("FORBIDDEN", "无权访问订单", 403);
    const whereParts = [];
    if (!admin) whereParts.push({ userOpenid: cleanText(userOpenid, 128) });
    else if (requestedUserOpenid) whereParts.push({ userOpenid: cleanText(requestedUserOpenid, 128) });
    if (orderId) whereParts.push({ _id: cleanText(orderId, 128) });
    if (productId) whereParts.push({ productId: cleanText(productId, 128) });
    if (admin) {
      if (filters.orderStatus && filters.orderStatus !== "all") whereParts.push({ status: cleanText(filters.orderStatus, 60) });
      else if (!filters.includeCancelled) whereParts.push({ status: command.neq("cancelled") });
      if (filters.paymentStatus && filters.paymentStatus !== "all") whereParts.push({ paymentStatus: cleanText(filters.paymentStatus, 60) });
      if (filters.deliveryType && filters.deliveryType !== "all") whereParts.push({ deliveryType: cleanText(filters.deliveryType, 60) });
      if (filters.deliveryStatus && filters.deliveryStatus !== "all") whereParts.push({ deliveryStatus: cleanText(filters.deliveryStatus, 60) });
      const start = filters.startDate ? new Date(filters.startDate) : null;
      const end = filters.endDate ? new Date(filters.endDate) : null;
      if (start && !Number.isNaN(start.getTime()) && end && !Number.isNaN(end.getTime())) {
        whereParts.push({ createdAt: command.gte(start).and(command.lte(end)) });
      } else if (start && !Number.isNaN(start.getTime())) whereParts.push({ createdAt: command.gte(start) });
      else if (end && !Number.isNaN(end.getTime())) whereParts.push({ createdAt: command.lte(end) });
    }
    const where = combine(whereParts);
    const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const limit = Math.max(1, Math.min(100, Number.parseInt(pageSize, 10) || 100));
    const skip = Math.max(0, (currentPage - 1) * limit);
    const customerKeyword = normalizeSearchText(filters.customerKeyword);
    const productKeyword = normalizeSearchText(filters.productKeyword);
    const searching = admin && Boolean(customerKeyword || productKeyword);
    let rows;
    let rawHasMore = false;
    if (searching) {
      rows = [];
      let scanOffset = 0;
      while (true) {
        const response = await db.collection("orders").where(where || {})
          .orderBy("createdAt", "desc").orderBy("_id", "desc")
          .skip(scanOffset).limit(100).get();
        const batch = Array.isArray(response.data) ? response.data : [];
        rows.push(...batch);
        if (rows.length > MAX_LEGACY_SEARCH_ORDERS) {
          throw new OrderQueryError("ORDER_SEARCH_SCAN_LIMIT_EXCEEDED", "订单搜索范围超出安全上限，请缩小筛选条件", 503);
        }
        if (batch.length < 100) break;
        scanOffset += batch.length;
      }
    } else {
      const response = await db.collection("orders").where(where || {})
        .orderBy("createdAt", "desc").orderBy("_id", "desc")
        .skip(skip).limit(limit + 1).get();
      const rawRows = Array.isArray(response.data) ? response.data : [];
      rawHasMore = rawRows.length > limit;
      rows = rawRows.slice(0, limit);
    }
    const maps = await relatedMaps(rows, admin, admin && !summaryOnly, {
      maxOrderItems: searching ? MAX_LEGACY_SEARCH_ORDER_ITEMS : MAX_WEB_LIST_ORDER_ITEMS
    });
    const adminBlocked = ["idempotencyKey", "idempotencyActionType", "submitIdempotencyKey", "idempotencyRequestHash", "requestHash", "cartSubmitHash", "cartItemIds", "selectedCartItemIds"];
    const publicBlocked = [
      "adminNote", "adminNoteSummary", "adminNoteUpdatedAt", "adminNoteUpdatedBy", "adminNoteUpdatedByOpenid",
      "adminTags", "customerAdminTags", "customerAdminNoteSummary", "customerRiskLevel", "riskLevel", "riskLevelSnapshot",
      "orderSource", "adminRemark", "customerRemark", "shipmentRemark", "customerPhoneSnapshot", ...adminBlocked
    ];
    const projected = [];
    for (const order of rows) {
      const itemRows = orderItems(order, maps.itemMap, admin && !summaryOnly ? maps.products : null);
      const customer = customerContext(order, maps);
      if (admin && customerKeyword) {
        const canSearchPhone = hasPermission(principal, "customer:search_by_phone") && hasPermission(principal, "customer:view_phone_full");
        const haystack = normalizeSearchText([
          customer.nickname,
          canSearchPhone ? customer.fullPhone : "",
          customer.user.openid,
          order.userOpenid,
          order.userId
        ].filter(Boolean).join(" "));
        if (!haystack.includes(customerKeyword)) continue;
      }
      if (admin && productKeyword) {
        const matches = itemRows.some((item) => normalizeSearchText([
          item.productName, item.name, item.specification, item.productionDate,
          item.productIndex, item.skuCode, item.productId
        ].filter(Boolean).join(" ")).includes(productKeyword));
        if (!matches) continue;
      }
      const totalQuantity = itemRows.reduce((sum, item) => sum + Math.max(0, safeInteger(item.quantity, 0)), 0);
      const itemCount = Math.max(0, safeInteger(order.itemCount, itemRows.length));
      const firstItem = itemRows[0] || {};
      const firstName = cleanText(firstItem.productName || firstItem.name || order.productName, 160);
      let legacy = {
        ...order,
        orderId: cleanText(order._id, 128),
        items: itemRows,
        itemCount,
        totalQuantity,
        itemSummary: cleanText(order.itemSummary || (itemCount > 1 ? `${firstName} 等 ${itemCount} 件商品` : firstName), 240),
        shippingStatus: cleanText(order.shippingStatus || order.deliveryStatus, 60),
        shippingCompany: cleanText(order.shippingCompany || order.expressCompany, 100),
        trackingNo: cleanText(order.trackingNo || order.expressNo, 120)
      };
      const merged = order.isMergedShipment === true && Boolean(order.mergeShipmentId) && order.mergeShipmentStatus !== "cancelled";
      legacy.isMergedShipment = merged;
      legacy.shipmentDisplay = {
        isMergedShipment: merged,
        mergeShipmentId: merged ? cleanText(order.mergeShipmentId, 128) : "",
        mergeShipmentNo: merged ? cleanText(order.mergeShipmentNo, 100) : "",
        mergeShipmentStatus: merged ? cleanText(order.mergeShipmentStatus || legacy.shippingStatus || "created", 60) : "",
        shippingStatus: legacy.shippingStatus,
        shippingCompany: legacy.shippingCompany,
        trackingNo: legacy.trackingNo,
        shippedAt: order.shippedAt || null
      };
      if (!admin) {
        if (legacy.customerPhoneMasked) legacy.customerPhoneMasked = maskPhone(legacy.customerPhoneMasked);
        if (legacy.user && typeof legacy.user === "object") {
          legacy.user = { ...legacy.user };
          for (const field of publicBlocked) delete legacy.user[field];
          for (const field of ["phone", "phoneNumber", "mobile", "openid", "_openid"]) delete legacy.user[field];
          if (legacy.user.phoneMasked) legacy.user.phoneMasked = maskPhone(legacy.user.phoneMasked);
        }
        const address = safeAddress(order, { role: "customer", status: "active", isActive: true, permissions: ["customer:view_address_masked"] });
        legacy = sanitizeLegacyPublicValue(legacy);
        if (address.shippingAddressMasked) {
          legacy.shippingAddressMasked = address.shippingAddressMasked;
          legacy.shippingAddress = address.shippingAddressMasked;
        }
      } else {
        for (const field of adminBlocked) delete legacy[field];
        legacy.user = {
          nickname: cleanText(customer.nickname, 80),
          phoneMasked: hasPermission(principal, "customer:view_phone_masked") || hasPermission(principal, "customer:view_phone_full") ? customer.phoneMasked : ""
        };
        legacy.customerPhoneMasked = legacy.user.phoneMasked;
        if (hasPermission(principal, "customer:view_phone_full")) {
          legacy.customerPhoneDisplay = customer.fullPhone || customer.phoneMasked;
          legacy.customerPhoneSnapshot = customer.fullPhone;
        } else {
          legacy.customerPhoneDisplay = legacy.customerPhoneMasked;
          delete legacy.customerPhoneSnapshot;
        }
        if (!hasPermission(principal, "dashboard:view_sales")) {
          delete legacy.totalAmount;
          legacy.items = legacy.items.map((item) => {
            const clean = { ...item };
            delete clean.unitPrice;
            delete clean.totalAmount;
            delete clean.price;
            delete clean.subtotal;
            return clean;
          });
        }
        if (hasPermission(principal, "order:review")) {
          legacy.riskLevelSnapshot = normalizeRiskLevel(order.riskLevelSnapshot);
          legacy.customerRiskLevel = normalizeRiskLevel(customer.account.riskLevel);
          legacy.customerAdminTags = Array.isArray(customer.account.adminTags) ? customer.account.adminTags.slice(0, 20).map((tag) => cleanText(tag, 40)) : [];
        } else {
          delete legacy.riskLevelSnapshot;
          delete legacy.customerRiskLevel;
          delete legacy.customerAdminTags;
        }
        if (hasPermission(principal, "order:edit_remark")) {
          legacy.customerAdminNoteSummary = shortText(customer.account.adminNote || customer.account.adminRemark);
          legacy.adminNoteSummary = shortText(order.adminNote || order.adminRemark);
        } else {
          delete legacy.adminNote;
          delete legacy.adminRemark;
          delete legacy.internalNotes;
          delete legacy.adminNoteUpdatedAt;
          delete legacy.adminNoteUpdatedBy;
          delete legacy.adminNoteUpdatedByOpenid;
          delete legacy.customerAdminNoteSummary;
          delete legacy.adminNoteSummary;
        }
        if (!hasPermission(principal, "payment:view_screenshot")) {
          for (const field of ["paymentScreenshotUrl", "paymentScreenshotUrls", "paymentFileID", "latestPaymentRecordId", "wechatPayTransactionId", "wechatPayOutTradeNo", "paidAmount", "unpaidAmount", "payableAmount", "historicalUnpaidAmount", "todayOrderAmount"]) delete legacy[field];
        }
        if (!hasPermission(principal, "customer:view_account")) {
          for (const field of ["account", "customerAccount", "totalUnpaidAmount", "historyUnpaidAmount"]) delete legacy[field];
        }
        delete legacy.shippingAddressSnapshot;
        delete legacy.shippingAddress;
        delete legacy.shippingAddressMasked;
        Object.assign(legacy, safeAddress(order, principal));
      }
      if (summaryOnly) {
        legacy = {
          _id: cleanText(order._id, 128), orderId: cleanText(order._id, 128), orderNo: cleanText(order.orderNo, 100),
          status: cleanText(order.status, 60), paymentStatus: cleanText(order.paymentStatus, 60),
          shippingStatus: legacy.shippingStatus, deliveryStatus: cleanText(order.deliveryStatus, 60),
          totalAmount: admin && !hasPermission(principal, "dashboard:view_sales") ? undefined : safeInteger(order.totalAmount, 0),
          itemCount, totalQuantity, firstProductName: firstName,
          firstProductImage: cleanText(firstItem.productImage || firstItem.imageUrl || order.firstProductImage || order.productImage, 500),
          itemSummary: legacy.itemSummary, shipmentDisplay: legacy.shipmentDisplay,
          isMergedShipment: merged, mergeShipmentId: cleanText(order.mergeShipmentId, 128), mergeShipmentNo: cleanText(order.mergeShipmentNo, 100),
          mergeShipmentStatus: cleanText(order.mergeShipmentStatus, 60), shippingCompany: legacy.shippingCompany, trackingNo: legacy.trackingNo,
          createdAt: order.createdAt || null, updatedAt: order.updatedAt || order.createdAt || null
        };
      }
      projected.push(Object.fromEntries(Object.entries(legacy).filter(([, value]) => value !== undefined)));
    }
    const pageOrders = searching ? projected.slice(skip, skip + limit) : projected;
    const hasMore = searching ? projected.length > skip + limit : rawHasMore;
    return { orders: pageOrders, pagination: { page: currentPage, pageSize: limit, hasMore }, hasMore };
  }

  return { listWebOrders, getWebOrder, listLegacyOrders };
}

module.exports = {
  ORDER_STATUS_VALUES,
  OrderQueryError,
  createOrderQueryService,
  decodeCursor,
  encodeCursor,
  hasPermission,
  maskPhone,
  normalizeWebFilters
};
