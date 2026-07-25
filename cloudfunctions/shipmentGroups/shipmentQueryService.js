const WEB_SHIPMENT_STATUSES = new Set([
  "created", "pending_shipment", "shipped", "completed", "cancelled", "abnormal"
]);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const WEB_ROLES = new Set(["customer_service", "finance", "super_admin"]);
const LEGACY_ROLES = new Set(["customer_service", "finance", "procurement", "super_admin"]);

class ShipmentQueryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ShipmentQueryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanText(value, max = 240) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function safeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function dateIso(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function explicitPermission(actor, permission) {
  return Boolean(actor && Array.isArray(actor.permissions)
    && (actor.permissions.includes("*") || actor.permissions.includes(permission)));
}

function isActive(actor) {
  return Boolean(actor && actor.isActive !== false && actor.status !== "disabled" && actor.status !== "inactive");
}

function assertShipmentView(actor, webOnly = true) {
  const allowedRole = (webOnly ? WEB_ROLES : LEGACY_ROLES).has(actor && actor.role);
  if (!isActive(actor) || !allowedRole || !explicitPermission(actor, "shipment:view")) {
    throw new ShipmentQueryError("FORBIDDEN", "无权查看合并发货单", 403);
  }
}

function maskPhone(value) {
  const digits = cleanText(value, 40).replace(/\D/g, "").slice(-11);
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return digits ? "***" : "";
}

function maskName(value) {
  const text = cleanText(value, 80);
  if (!text) return "客户";
  if (text.length === 1) return `${text}*`;
  return `${text.slice(0, 1)}${"*".repeat(Math.min(3, text.length - 1))}`;
}

function maskTracking(value) {
  const text = cleanText(value, 120).replace(/\s+/g, "");
  if (!text) return "";
  if (text.length <= 4) return `${text.slice(0, 1)}***`;
  const prefix = text.slice(0, Math.min(2, text.length - 4));
  return `${prefix}${"*".repeat(Math.max(4, text.length - prefix.length - 4))}${text.slice(-4)}`;
}

function maskAddressText(value) {
  const text = cleanText(value, 360);
  if (!text) return "";
  if (text.length <= 4) return `${text.slice(0, 1)}**`;
  return `${text.slice(0, Math.ceil(text.length / 2))}**`;
}

function decimalDigitToAscii(character) {
  const code = character.codePointAt(0);
  if (code >= 0x30 && code <= 0x39) return String(code - 0x30);
  if (code >= 0xFF10 && code <= 0xFF19) return String(code - 0xFF10);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06F0 && code <= 0x06F9) return String(code - 0x06F0);
  return "";
}

function extractPhoneDigits(value, max = 100) {
  return Array.from(cleanText(value, max), decimalDigitToAscii).join("");
}

function maskCustomerPhone(value) {
  const extracted = extractPhoneDigits(value, 100);
  const digits = extracted.length === 13 && extracted.startsWith("86") ? extracted.slice(2) : extracted;
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return digits ? "***" : "";
}

function scrubPhones(value, max = 500) {
  const digit = "0-9\\uFF10-\\uFF19\\u0660-\\u0669\\u06F0-\\u06F9";
  const one = "1\\uFF11\\u0661\\u06F1";
  const threeToNine = "3-9\\uFF13-\\uFF19\\u0663-\\u0669\\u06F3-\\u06F9";
  const eight = "8\\uFF18\\u0668\\u06F8";
  const six = "6\\uFF16\\u0666\\u06F6";
  const separator = "[\\s.,:_|\\-()/\\\\\\u00b7\\u2010-\\u2015\\u3002\\u200B-\\u200D\\u2060\\uFEFF]*";
  const mobile = `[${one}]${separator}[${threeToNine}](?:${separator}[${digit}]){9}`;
  const country = `(?:[+\\uFF0B]${separator})?[${eight}]${separator}[${six}]${separator}`;
  const candidate = new RegExp(`(?<![${digit}])(?:${country})?${mobile}(?![${digit}])`, "gu");
  return cleanText(value, max).replace(candidate, (phone) => maskCustomerPhone(phone));
}

function normalizeWebListQuery(query = {}) {
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  const status = cleanText(query.status, 40);
  if (status && !WEB_SHIPMENT_STATUSES.has(status)) {
    throw new ShipmentQueryError("SHIPMENT_QUERY_INVALID", "合并发货单状态筛选无效", 400);
  }
  return {
    pageSize,
    status,
    search: cleanText(query.search, 100),
    cursor: cleanText(query.cursor, 4096)
  };
}

function encodeCursor(row, normalized) {
  const updatedAt = dateIso(row.updatedAt);
  const id = cleanText(row._id || row.id, 128);
  if (!updatedAt || !id) return null;
  return Buffer.from(JSON.stringify({
    v: 1,
    updatedAt,
    id,
    status: normalized.status,
    search: normalized.search
  }), "utf8").toString("base64url");
}

function decodeCursor(value, normalized) {
  if (!value) return null;
  try {
    if (value.length > 4096) throw new Error("oversized");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const updatedAt = dateIso(parsed.updatedAt);
    const id = cleanText(parsed.id, 128);
    if (parsed.v !== 1 || !updatedAt || !id || parsed.status !== normalized.status || parsed.search !== normalized.search) {
      throw new Error("invalid");
    }
    return { updatedAt: new Date(updatedAt), id };
  } catch (error) {
    throw new ShipmentQueryError("SHIPMENT_CURSOR_INVALID", "合并发货单分页游标无效或与筛选条件不一致", 400);
  }
}

function combine(command, conditions) {
  const usable = conditions.filter(Boolean);
  if (!usable.length) return null;
  return usable.length === 1 ? usable[0] : command.and(usable);
}

function cursorWhere(command, cursor) {
  if (!cursor) return null;
  return command.or([
    { updatedAt: command.lt(cursor.updatedAt) },
    command.and([{ updatedAt: cursor.updatedAt }, { _id: command.lt(cursor.id) }])
  ]);
}

function listProjection(group, actor) {
  const phone = maskPhone(group.customerPhoneMasked || group.customerPhoneSnapshot || "");
  const projected = {
    id: cleanText(group._id || group.id, 128),
    shipmentNo: cleanText(group.shipmentNo, 120),
    status: WEB_SHIPMENT_STATUSES.has(group.shippingStatus) ? group.shippingStatus : "abnormal",
    orderCount: Math.max(0, safeInteger(group.orderCount, Array.isArray(group.orderIds) ? group.orderIds.length : 0)),
    totalItemCount: Math.max(0, safeInteger(group.totalItemCount, safeInteger(group.totalQuantity, 0))),
    customerMasked: [maskName(group.customerName), phone].filter(Boolean).join(" "),
    carrier: cleanText(group.shippingCompany, 80),
    trackingMasked: maskTracking(group.trackingNo || (Array.isArray(group.trackingNoList) ? group.trackingNoList[0] : "")),
    addressConsistent: group.addressConsistent !== false,
    orderNosPreview: Array.isArray(group.orderNos) ? group.orderNos.map((value) => cleanText(value, 120)).filter(Boolean).slice(0, 3) : [],
    createdAt: dateIso(group.createdAt),
    updatedAt: dateIso(group.updatedAt),
    shippedAt: dateIso(group.shippedAt),
    completedAt: dateIso(group.completedAt),
    version: Math.max(0, safeInteger(group.version, 0))
  };
  if (explicitPermission(actor, "dashboard:view_sales")) {
    projected.totalOrderAmountCents = Math.max(0, safeInteger(group.totalOrderAmount, safeInteger(group.totalAmount, 0)));
  }
  return projected;
}

function customerMasked(group) {
  const phone = maskPhone(group.customerPhoneMasked || group.customerPhoneSnapshot || "");
  return [maskName(group.customerName), phone].filter(Boolean).join(" ");
}

function maskedAddress(group) {
  const source = group.shippingAddressSnapshot || group.shippingAddress || group.shippingAddressMasked || {};
  const compatibility = group.shippingAddressMasked || {};
  const detail = source.detailAddress || compatibility.detailAddressMasked || "";
  const regionText = cleanText(source.regionText || compatibility.regionText, 160);
  const detailAddressMasked = maskAddressText(detail);
  return {
    receiverName: maskName(source.receiverName || compatibility.receiverName),
    receiverPhoneMasked: maskPhone(source.receiverPhone || source.receiverPhoneMasked || compatibility.receiverPhoneMasked),
    regionText,
    detailAddressMasked,
    fullAddressMasked: [regionText, detailAddressMasked].filter(Boolean).join(" ")
  };
}

function fullAddress(group) {
  const source = group.shippingAddressSnapshot || group.shippingAddress || {};
  const regionText = cleanText(source.regionText, 160);
  const detailAddress = cleanText(source.detailAddress, 200);
  return {
    receiverName: cleanText(source.receiverName, 80),
    receiverPhoneMasked: maskPhone(source.receiverPhone || source.receiverPhoneMasked),
    regionText,
    detailAddress,
    fullAddress: cleanText(source.fullAddress || [regionText, detailAddress].filter(Boolean).join(" "), 360)
  };
}

function canViewFullTracking(actor) {
  return actor.role === "super_admin"
    || explicitPermission(actor, "shipment:update")
    || explicitPermission(actor, "shipment:ship");
}

function canViewOperationalNotes(actor) {
  return actor.role === "super_admin"
    || ["shipment:update", "shipment:ship", "shipment:cancel", "shipment:complete"]
      .some((permission) => explicitPermission(actor, permission));
}

function shippingStatusOf(order) {
  if (order.shippingStatus) return cleanText(order.shippingStatus, 60);
  if (["shipped", "completed", "abnormal"].includes(order.deliveryStatus)) return order.deliveryStatus;
  return "pending_shipment";
}

function orderProjection(order, actor) {
  const projected = {
    id: cleanText(order._id || order.id, 128),
    orderNo: cleanText(order.orderNo, 120),
    status: cleanText(order.status, 60),
    paymentStatus: cleanText(order.paymentStatus, 60),
    shippingStatus: shippingStatusOf(order),
    createdAt: dateIso(order.createdAt)
  };
  if (explicitPermission(actor, "dashboard:view_sales")) {
    projected.totalAmountCents = Math.max(0, safeInteger(order.totalAmount, 0));
  }
  return projected;
}

function aggregateItemSummary(items, orderMap) {
  const summaries = new Map();
  for (const item of items) {
    const fields = {
      productId: cleanText(item.productId, 128),
      productName: cleanText(item.productName, 160),
      brand: cleanText(item.brand, 80),
      category: cleanText(item.category, 80),
      specification: cleanText(item.specification, 120),
      productionDate: cleanText(item.productionDate, 40)
    };
    const key = JSON.stringify(fields);
    if (!summaries.has(key)) summaries.set(key, { ...fields, totalQuantity: 0, orderNos: [] });
    const summary = summaries.get(key);
    summary.totalQuantity += Math.max(0, safeInteger(item.quantity, 0));
    const relatedOrder = orderMap.get(item.orderId);
    const orderNo = cleanText(item.orderNo || (relatedOrder && relatedOrder.orderNo), 120);
    if (orderNo && !summary.orderNos.includes(orderNo)) summary.orderNos.push(orderNo);
  }
  return Array.from(summaries.values());
}

function logProjection(log, includeRemark) {
  const projected = {
    id: cleanText(log._id || log.id, 128),
    action: cleanText(log.action, 80),
    operatorRole: cleanText(log.operatorRole || log.operatorRoleSnapshot, 60),
    createdAt: dateIso(log.createdAt)
  };
  if (includeRemark && log.remark) projected.remark = scrubPhones(log.remark, 500);
  return projected;
}

function shipmentDetailProjection(group, orders, itemSummary, actor) {
  const tracking = cleanText(group.trackingNo || (Array.isArray(group.trackingNoList) ? group.trackingNoList[0] : ""), 120);
  const projected = {
    id: cleanText(group._id || group.id, 128),
    shipmentNo: cleanText(group.shipmentNo, 120),
    status: WEB_SHIPMENT_STATUSES.has(group.shippingStatus) ? group.shippingStatus : "abnormal",
    version: Math.max(0, safeInteger(group.version, 0)),
    orderCount: Math.max(0, safeInteger(group.orderCount, Array.isArray(group.orderIds) ? group.orderIds.length : orders.length)),
    totalItemCount: Math.max(0, safeInteger(group.totalItemCount, safeInteger(group.totalQuantity, 0))),
    totalProductCount: Math.max(0, safeInteger(group.totalProductCount, itemSummary.length)),
    customerMasked: customerMasked(group),
    carrier: cleanText(group.shippingCompany, 80),
    addressConsistent: group.addressConsistent !== false,
    createdAt: dateIso(group.createdAt),
    updatedAt: dateIso(group.updatedAt),
    shippedAt: dateIso(group.shippedAt),
    completedAt: dateIso(group.completedAt),
    cancelledAt: dateIso(group.cancelledAt)
  };
  if (explicitPermission(actor, "shipment:view_address_full")) projected.shippingAddress = fullAddress(group);
  else projected.shippingAddressMasked = maskedAddress(group);
  if (canViewFullTracking(actor)) projected.trackingNo = tracking;
  else projected.trackingMasked = maskTracking(tracking);
  if (explicitPermission(actor, "dashboard:view_sales")) {
    const total = Math.max(0, safeInteger(group.totalOrderAmount, orders.reduce((sum, order) => sum + Math.max(0, safeInteger(order.totalAmount, 0)), 0)));
    const paid = Math.max(0, safeInteger(group.totalPaidAmount, orders.reduce((sum, order) => {
      return order.paymentStatus === "paid" ? sum + Math.max(0, safeInteger(order.totalAmount, 0)) : sum;
    }, 0)));
    projected.totalOrderAmountCents = total;
    projected.totalPaidAmountCents = paid;
    projected.totalUnpaidAmountCents = Math.max(0, safeInteger(group.totalUnpaidAmount, total - paid));
  }
  if (canViewOperationalNotes(actor)) {
    if (group.adminRemark) projected.adminRemark = scrubPhones(group.adminRemark, 500);
    if (group.cancelReason) projected.cancelReason = scrubPhones(group.cancelReason, 300);
  }
  return projected;
}

const LEGACY_GROUP_SAFE_FIELDS = [
  "_id", "id", "shipmentNo", "customerName", "orderIds", "orderNos", "orderCount",
  "totalItemCount", "totalQuantity", "totalProductCount", "totalOrderAmount", "totalPaidAmount",
  "totalUnpaidAmount", "shippingType", "addressConsistent", "shippingCompany", "trackingNo",
  "trackingNoList", "shippingStatus", "shippedAt", "completedAt", "cancelledAt", "cancelReason",
  "adminRemark", "shipmentImages", "createdAt", "updatedAt", "version"
];

function sanitizeLegacyGroup(group, actor) {
  const clean = {};
  for (const field of LEGACY_GROUP_SAFE_FIELDS) {
    if (Object.hasOwn(group, field)) clean[field] = group[field];
  }
  const fullAddressAllowed = actor.role === "super_admin"
    || explicitPermission(actor, "shipment:view_address_full")
    || explicitPermission(actor, "customer:view_address_full");
  const maskedAllowed = fullAddressAllowed
    || explicitPermission(actor, "shipment:view_address_masked")
    || explicitPermission(actor, "customer:view_address_masked");
  const remaskedAddress = maskedAddress(group);
  clean.customerPhoneMasked = maskPhone(group.customerPhoneMasked || group.customerPhoneSnapshot || "");
  clean.shippingAddressMasked = maskedAllowed ? remaskedAddress : null;
  if (fullAddressAllowed) {
    clean.shippingAddressSnapshot = group.shippingAddressSnapshot || null;
    clean.shippingAddress = group.shippingAddressSnapshot || null;
  }
  else {
    clean.shippingAddressSnapshot = null;
    clean.shippingAddress = clean.shippingAddressMasked;
  }
  if ((actor.role === "super_admin" || explicitPermission(actor, "customer:view_phone_full"))
    && Object.hasOwn(group, "customerPhoneSnapshot")) {
    clean.customerPhoneSnapshot = cleanText(group.customerPhoneSnapshot, 40);
  }
  return clean;
}

function legacyKeywordText(group) {
  return [
    group.shipmentNo,
    Array.isArray(group.orderNos) ? group.orderNos.join(" ") : "",
    group.customerName,
    group.customerPhoneMasked,
    group.shippingCompany,
    group.trackingNo
  ].map((value) => cleanText(value, 1000)).join(" ").toLowerCase();
}

function legacyItemSummary(items, orderMap) {
  const grouped = new Map();
  for (const item of items) {
    const fields = {
      productId: cleanText(item.productId, 128),
      productName: cleanText(item.productName, 160),
      brand: cleanText(item.brand, 80),
      category: cleanText(item.category, 80),
      specification: cleanText(item.specification, 120),
      productionDate: cleanText(item.productionDate, 80)
    };
    const key = JSON.stringify(fields);
    if (!grouped.has(key)) {
      grouped.set(key, {
        ...fields,
        quantity: 0,
        totalQuantity: 0,
        orderNos: [],
        orderIds: [],
        imageUrl: cleanText(item.imageUrl || item.productImage, 500),
        tags: Array.isArray(item.tags) ? item.tags : []
      });
    }
    const summary = grouped.get(key);
    const count = Math.max(0, safeInteger(item.quantity, 0));
    summary.quantity += count;
    summary.totalQuantity += count;
    const order = orderMap.get(item.orderId);
    const orderNo = cleanText(item.orderNo || (order && order.orderNo), 120);
    if (orderNo && !summary.orderNos.includes(orderNo)) summary.orderNos.push(orderNo);
    const orderId = cleanText(item.orderId, 128);
    if (orderId && !summary.orderIds.includes(orderId)) summary.orderIds.push(orderId);
  }
  return Array.from(grouped.values());
}

function readFailure(error) {
  if (error instanceof ShipmentQueryError) return error;
  return new ShipmentQueryError("SHIPMENT_READ_FAILED", "合并发货单读取失败，请稍后重试", 503);
}

function createShipmentQueryService({ db, command }) {
  if (!db || !command) throw new Error("shipment query service requires db and command");

  async function searchCondition(search) {
    if (!search) return null;
    let orders;
    try {
      const result = await db.collection("orders").where({ orderNo: search }).limit(101).get();
      orders = Array.isArray(result.data) ? result.data : [];
    } catch (error) {
      throw readFailure(error);
    }
    if (orders.length > 100) throw new ShipmentQueryError("SHIPMENT_READ_FAILED", "合并发货单读取失败，请稍后重试", 503);
    const groupIds = Array.from(new Set(orders.map((order) => cleanText(order.mergeShipmentId || order.shipmentGroupId, 128)).filter(Boolean)));
    const shipmentNos = Array.from(new Set(orders.map((order) => cleanText(order.mergeShipmentNo, 120)).filter(Boolean)));
    const conditions = [
      { shipmentNo: search },
      { trackingNo: search },
      { trackingNoList: search }
    ];
    if (groupIds.length) conditions.push({ _id: command.in(groupIds) });
    if (shipmentNos.length) conditions.push({ shipmentNo: command.in(shipmentNos) });
    return command.or(conditions);
  }

  async function listWebShipments({ actor, query = {} } = {}) {
    assertShipmentView(actor, true);
    const normalized = normalizeWebListQuery(query);
    const cursor = decodeCursor(normalized.cursor, normalized);
    try {
      const where = combine(command, [
        normalized.status ? { shippingStatus: normalized.status } : null,
        await searchCondition(normalized.search),
        cursorWhere(command, cursor)
      ]);
      let request = db.collection("shipment_groups");
      if (where) request = request.where(where);
      const response = await request
        .orderBy("updatedAt", "desc")
        .orderBy("_id", "desc")
        .limit(normalized.pageSize + 1)
        .get();
      const rows = Array.isArray(response.data) ? response.data : [];
      const hasMore = rows.length > normalized.pageSize;
      const pageRows = rows.slice(0, normalized.pageSize);
      return {
        items: pageRows.map((row) => listProjection(row, actor)),
        pageSize: normalized.pageSize,
        hasMore,
        nextCursor: hasMore && pageRows.length ? encodeCursor(pageRows[pageRows.length - 1], normalized) : null
      };
    } catch (error) {
      throw readFailure(error);
    }
  }

  async function getWebShipment({ actor, id } = {}) {
    assertShipmentView(actor, true);
    const shipmentId = cleanText(id, 128);
    if (!shipmentId) throw new ShipmentQueryError("SHIPMENT_QUERY_INVALID", "缺少合并发货单 ID", 400);
    try {
      const group = (await db.collection("shipment_groups").doc(shipmentId).get()).data;
      if (!group) throw new ShipmentQueryError("SHIPMENT_NOT_FOUND", "合并发货单不存在", 404);
      const orderIds = Array.isArray(group.orderIds)
        ? Array.from(new Set(group.orderIds.map((value) => cleanText(value, 128)).filter(Boolean)))
        : [];
      if (orderIds.length > 100) {
        throw new ShipmentQueryError("SHIPMENT_RELATED_ROWS_LIMIT_EXCEEDED", "关联数据量超出安全上限", 503);
      }
      const [ordersResponse, itemsResponse, logsResponse] = await Promise.all([
        orderIds.length
          ? db.collection("orders").where({ _id: command.in(orderIds) }).limit(101).get()
          : Promise.resolve({ data: [] }),
        db.collection("shipment_group_items").where({ shipmentGroupId: shipmentId }).limit(501).get(),
        db.collection("shipment_logs").where({ shipmentGroupId: shipmentId }).orderBy("createdAt", "desc").limit(101).get()
      ]);
      const orders = Array.isArray(ordersResponse.data) ? ordersResponse.data : [];
      const items = Array.isArray(itemsResponse.data) ? itemsResponse.data : [];
      const logs = Array.isArray(logsResponse.data) ? logsResponse.data : [];
      if (orders.length > 100 || items.length > 500) {
        throw new ShipmentQueryError("SHIPMENT_RELATED_ROWS_LIMIT_EXCEEDED", "关联数据量超出安全上限", 503);
      }
      const orderMap = new Map(orders.map((order) => [order._id, order]));
      const itemSummary = aggregateItemSummary(items, orderMap);
      const missingOrders = orderIds.some((orderId) => !orderMap.has(orderId));
      return {
        shipment: shipmentDetailProjection(group, orders, itemSummary, actor),
        orders: orderIds.map((orderId) => orderMap.get(orderId)).filter(Boolean).map((order) => orderProjection(order, actor)),
        itemSummary,
        logs: logs.slice(0, 100).map((log) => logProjection(log, canViewOperationalNotes(actor))),
        logsHasMore: logs.length > 100,
        relatedDataStatus: missingOrders ? "partial" : "complete",
        warnings: missingOrders ? ["部分关联订单缺失，数据可能不完整"] : []
      };
    } catch (error) {
      throw readFailure(error);
    }
  }

  async function listLegacyShipmentGroups({ actor, query = {} } = {}) {
    assertShipmentView(actor, false);
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
    const status = cleanText(query.status, 40);
    const keyword = cleanText(query.keyword, 80).toLowerCase();
    try {
      let request = db.collection("shipment_groups");
      if (status && status !== "all") request = request.where({ shippingStatus: status });
      const scanLimit = keyword ? Math.min(500, page * pageSize + 200) : pageSize;
      request = request.orderBy("createdAt", "desc");
      if (!keyword) request = request.skip((page - 1) * pageSize);
      const response = await request.limit(scanLimit).get();
      let groups = Array.isArray(response.data) ? response.data : [];
      if (keyword) {
        groups = groups.filter((shipmentGroup) => legacyKeywordText(shipmentGroup).includes(keyword))
          .slice((page - 1) * pageSize, page * pageSize);
      }
      return {
        groups: groups.map((shipmentGroup) => sanitizeLegacyGroup(shipmentGroup, actor)),
        page,
        pageSize,
        hasMore: groups.length === pageSize
      };
    } catch (error) {
      throw readFailure(error);
    }
  }

  async function getLegacyShipmentGroupDetail({ actor, id } = {}) {
    assertShipmentView(actor, false);
    const shipmentId = cleanText(id, 128);
    if (!shipmentId) throw new ShipmentQueryError("SHIPMENT_QUERY_INVALID", "缺少合并发货单 ID", 400);
    try {
      const group = (await db.collection("shipment_groups").doc(shipmentId).get()).data;
      if (!group) throw new ShipmentQueryError("SHIPMENT_NOT_FOUND", "合并发货单不存在", 404);
      const orderIds = Array.isArray(group.orderIds)
        ? Array.from(new Set(group.orderIds.map((value) => cleanText(value, 128)).filter(Boolean)))
        : [];
      if (orderIds.length > 100) {
        throw new ShipmentQueryError("SHIPMENT_RELATED_ROWS_LIMIT_EXCEEDED", "关联数据量超出安全上限", 503);
      }
      const [ordersResponse, itemsResponse, logsResponse] = await Promise.all([
        orderIds.length
          ? db.collection("orders").where({ _id: command.in(orderIds) }).limit(101).get()
          : Promise.resolve({ data: [] }),
        db.collection("shipment_group_items").where({ shipmentGroupId: shipmentId }).limit(501).get(),
        db.collection("shipment_logs").where({ shipmentGroupId: shipmentId }).orderBy("createdAt", "desc").limit(101).get()
      ]);
      const orders = Array.isArray(ordersResponse.data) ? ordersResponse.data : [];
      const items = Array.isArray(itemsResponse.data) ? itemsResponse.data : [];
      const logs = Array.isArray(logsResponse.data) ? logsResponse.data : [];
      if (orders.length > 100 || items.length > 500) {
        throw new ShipmentQueryError("SHIPMENT_RELATED_ROWS_LIMIT_EXCEEDED", "关联数据量超出安全上限", 503);
      }
      const orderMap = new Map(orders.map((order) => [order._id, order]));
      return {
        shipmentGroup: sanitizeLegacyGroup(group, actor),
        orders: orderIds.map((orderId) => orderMap.get(orderId)).filter(Boolean).map((order) => ({
          orderId: order._id,
          orderNo: order.orderNo || "",
          status: order.status || "",
          paymentStatus: order.paymentStatus || "",
          shippingStatus: shippingStatusOf(order),
          totalAmount: Math.max(0, safeInteger(order.totalAmount, 0)),
          createdAt: order.createdAt || null
        })),
        items,
        itemSummary: legacyItemSummary(items, orderMap),
        logs: logs.slice(0, 100)
      };
    } catch (error) {
      throw readFailure(error);
    }
  }

  return { listWebShipments, getWebShipment, listLegacyShipmentGroups, getLegacyShipmentGroupDetail };
}

module.exports = {
  ShipmentQueryError,
  WEB_SHIPMENT_STATUSES,
  createShipmentQueryService
};
