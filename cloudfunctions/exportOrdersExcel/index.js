const cloud = require("wx-server-sdk");
const xlsx = require("xlsx");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");
const { canViewFullPhone, maskPhone } = require("./phone");
const { canExportAddress, maskedAddressSnapshot } = require("./address");

const MAX_ORDERS = 5000;
const MAX_DETAIL_ROWS = 20000;
const PAGE_SIZE = 100;
const IN_BATCH_SIZE = 20;

const SUMMARY_COLUMNS = [
  { title: "璁㈠崟缂栧彿", key: "orderNo" },
  { title: "涓嬪崟鏃堕棿", key: "createdAt" },
  { title: "瀹㈡埛鏄电О", key: "nickname" },
  { title: "客户手机号", key: "phone" },
  { title: "瀹㈡埛 OpenID", key: "openid" },
  { title: "itemCount", key: "itemCount" },
  { title: "totalQuantity", key: "totalQuantity" },
  { title: "totalAmount", key: "totalAmount" },
  { title: "浠婃棩鏂板閲戦", key: "todayOrderAmount" },
  { title: "鍘嗗彶鏈粯閲戦", key: "historicalUnpaidAmount" },
  { title: "鏈搴斾粯鎬婚", key: "payableAmount" },
  { title: "宸蹭粯閲戦", key: "paidAmount" },
  { title: "鏈粯閲戦", key: "unpaidAmount" },
  { title: "鏀粯鏂瑰紡", key: "paymentMethod" },
  { title: "paymentStatus", key: "paymentStatus" },
  { title: "status", key: "status" },
  { title: "瀹℃牳鏂瑰紡", key: "reviewType" },
  { title: "配送方式", key: "shippingType" },
  { title: "收货人", key: "receiverName" },
  { title: "收货手机号", key: "receiverPhone" },
  { title: "省市区", key: "regionText" },
  { title: "详细地址", key: "detailAddress" },
  { title: "完整地址", key: "fullAddress" },
  { title: "地址标签", key: "addressTag" },
  { title: "是否合并发货", key: "isMergedShipment" },
  { title: "合并发货单号", key: "mergeShipmentNo" },
  { title: "快递公司", key: "shippingCompany" },
  { title: "快递单号", key: "trackingNo" },
  { title: "发货状态", key: "shippingStatus" },
  { title: "发货时间", key: "shippedAt" },
  { title: "浠樻鎴浘", key: "paymentScreenshotUrl", link: true },
  { title: "adminRemark", key: "adminRemark" },
  { title: "瀹㈡埛澶囨敞", key: "customerRemark" },
  { title: "閫氳繃鏃堕棿", key: "approvedAt" },
  { title: "浠樻纭鏃堕棿", key: "paidMarkedAt" },
  { title: "鏇存柊鏃堕棿", key: "updatedAt" }
];

const DETAIL_COLUMNS = [
  { title: "璁㈠崟缂栧彿", key: "orderNo" },
  { title: "涓嬪崟鏃堕棿", key: "createdAt" },
  { title: "瀹㈡埛鏄电О", key: "nickname" },
  { title: "客户手机号", key: "phone" },
  { title: "瀹㈡埛 OpenID", key: "openid" },
  { title: "鍟嗗搧绱㈠紩", key: "productIndex" },
  { title: "SKU", key: "skuCode" },
  { title: "鍟嗗搧鍚嶇О", key: "productName" },
  { title: "瑙勬牸", key: "specification" },
  { title: "鐢熶骇鏃ユ湡", key: "productionDate" },
  { title: "涓嬪崟鏁伴噺", key: "quantity" },
  { title: "鍗曚环", key: "unitPrice" },
  { title: "灏忚閲戦", key: "itemTotalAmount" },
  { title: "orderTotalAmount", key: "orderTotalAmount" },
  { title: "鏀粯鏂瑰紡", key: "paymentMethod" },
  { title: "paymentStatus", key: "paymentStatus" },
  { title: "status", key: "status" },
  { title: "瀹℃牳鏂瑰紡", key: "reviewType" },
  { title: "配送方式", key: "shippingType" },
  { title: "收货人", key: "receiverName" },
  { title: "收货手机号", key: "receiverPhone" },
  { title: "省市区", key: "regionText" },
  { title: "详细地址", key: "detailAddress" },
  { title: "完整地址", key: "fullAddress" },
  { title: "地址标签", key: "addressTag" },
  { title: "是否合并发货", key: "isMergedShipment" },
  { title: "合并发货单号", key: "mergeShipmentNo" },
  { title: "快递公司", key: "shippingCompany" },
  { title: "快递单号", key: "trackingNo" },
  { title: "发货状态", key: "shippingStatus" },
  { title: "发货时间", key: "shippedAt" },
  { title: "stockCheckStatus", key: "stockCheckStatus" },
  { title: "adminRemark", key: "adminRemark" },
  { title: "瀹㈡埛澶囨敞", key: "customerRemark" },
  { title: "浠樻鎴浘", key: "paymentScreenshotUrl", link: true },
  { title: "閫氳繃鏃堕棿", key: "approvedAt" },
  { title: "浠樻纭鏃堕棿", key: "paidMarkedAt" }
];

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    if (!/exist|already|collection exists/i.test(err.message || "")) throw err;
  }
}

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return { operatorOpenid: openid, operatorId: res.data[0]._id };
}

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/[锛屻€併€傦紱;:锛殀/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asCents(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num);
}

function moneyText(cents) {
  return (asCents(cents) / 100).toFixed(2);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value.$date) return new Date(value.$date);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
  const date = toDate(value);
  if (!date) return "";
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ];
  return `${parts[0]}-${parts[1]}-${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`;
}

function compactFilters(input = {}) {
  return {
    startDate: clean(input.startDate),
    endDate: clean(input.endDate),
    orderStatus: clean(input.orderStatus || "all"),
    paymentStatus: clean(input.paymentStatus || "all"),
    customerKeyword: clean(input.customerKeyword),
    productKeyword: clean(input.productKeyword),
    includeCancelled: Boolean(input.includeCancelled)
  };
}

function validateFilters(filters) {
  const start = toDate(filters.startDate);
  const end = toDate(filters.endDate);
  if (filters.startDate && !start) throw new Error("开始日期格式错误");
  if (filters.endDate && !end) throw new Error("缁撴潫鏃ユ湡鏍煎紡閿欒");
  if (start && end && start.getTime() > end.getTime()) throw new Error("开始日期不能晚于结束日期");
}

function isCollectionNotExists(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

function buildOrderWhere(filters) {
  const where = {};
  const start = toDate(filters.startDate);
  const end = toDate(filters.endDate);
  if (start && end) where.createdAt = _.gte(start).and(_.lte(end));
  else if (start) where.createdAt = _.gte(start);
  else if (end) where.createdAt = _.lte(end);

  if (filters.orderStatus && filters.orderStatus !== "all") {
    where.status = filters.orderStatus;
  } else if (!filters.includeCancelled) {
    where.status = _.neq("cancelled");
  }

  if (filters.paymentStatus && filters.paymentStatus !== "all") {
    where.paymentStatus = filters.paymentStatus;
  }

  return where;
}

async function getPaged(collection, where, orderByField, limitRows) {
  let skip = 0;
  let rows = [];
  while (rows.length <= limitRows) {
    let query = db.collection(collection).where(where);
    if (orderByField) query = query.orderBy(orderByField, "desc");
    const res = await query.skip(skip).limit(PAGE_SIZE).get();
    rows = rows.concat(res.data);
    if (res.data.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return rows;
}

function batches(list, size = IN_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
  return result;
}

function uniq(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

async function loadByIds(collection, ids) {
  const map = {};
  for (const group of batches(uniq(ids))) {
    try {
      const res = await db.collection(collection).where({ _id: _.in(group) }).limit(100).get();
      res.data.forEach((item) => {
        map[item._id] = item;
      });
    } catch (err) {
      if (isCollectionNotExists(err)) return map;
      throw err;
    }
  }
  return map;
}

async function loadUsers(orders) {
  const byId = await loadByIds("users", orders.map((order) => order.userId));
  const openids = uniq(orders.filter((order) => !byId[order.userId]).map((order) => order.userOpenid));
  for (const group of batches(openids)) {
    try {
      const res = await db.collection("users").where({ openid: _.in(group) }).limit(100).get();
      res.data.forEach((item) => {
        byId[item._id] = item;
        if (item.openid) byId[item.openid] = item;
      });
    } catch (err) {
      if (isCollectionNotExists(err)) return byId;
      throw err;
    }
  }
  return byId;
}

async function loadAccounts(userIds) {
  const map = {};
  for (const group of batches(uniq(userIds))) {
    try {
      const res = await db.collection("customer_accounts").where({ userId: _.in(group) }).limit(100).get();
      res.data.forEach((item) => {
        map[item.userId] = item;
      });
    } catch (err) {
      if (isCollectionNotExists(err)) return map;
      throw err;
    }
  }
  return map;
}

async function loadOrderItems(orderIds) {
  const map = {};
  for (const id of orderIds) map[id] = [];
  for (const group of batches(orderIds)) {
    try {
      const res = await db.collection("order_items").where({ orderId: _.in(group) }).limit(1000).get();
      res.data.forEach((item) => {
        if (!map[item.orderId]) map[item.orderId] = [];
        map[item.orderId].push(item);
      });
    } catch (err) {
      if (isCollectionNotExists(err)) return map;
      throw err;
    }
  }
  return map;
}

function oldOrderItem(order) {
  if (!order.productId && !order.productName) return null;
  return {
    orderId: order._id,
    productId: order.productId,
    productName: order.productName,
    specification: order.specification || "",
    productionDate: order.productionDate || "",
    productIndex: order.productIndex || "",
    skuCode: order.skuCode || "",
    quantity: order.quantity,
    unitPrice: order.unitPrice,
    totalAmount: order.totalAmount,
    stockCheckStatus: order.stockCheckStatus || "pending"
  };
}

function withFallbackItems(order, itemMap) {
  const items = itemMap[order._id] || [];
  if (items.length) return items;
  const legacy = oldOrderItem(order);
  return legacy ? [legacy] : [];
}

function enrichItem(item, productMap) {
  const product = productMap[item.productId] || {};
  return {
    ...item,
    productIndex: item.productIndex || product.productIndex || "",
    skuCode: item.skuCode || item.sku || product.skuCode || "",
    productName: item.productName || product.name || "",
    specification: item.specification || product.specification || "",
    productionDate: item.productionDate || product.productionDate || ""
  };
}

async function enrichOrders(orders) {
  const itemMap = await loadOrderItems(orders.map((order) => order._id));
  const allItems = [];
  orders.forEach((order) => {
    allItems.push(...withFallbackItems(order, itemMap));
  });
  const productMap = await loadByIds("products", allItems.map((item) => item.productId));
  const userMap = await loadUsers(orders);
  const accountMap = await loadAccounts(orders.map((order) => order.userId));

  return orders.map((order) => {
    const user = userMap[order.userId] || userMap[order.userOpenid] || {};
    const account = accountMap[order.userId] || {};
    const items = withFallbackItems(order, itemMap).map((item) => enrichItem(item, productMap));
    const totalQuantity = items.reduce((sum, item) => sum + asCents(item.quantity), 0);
    return {
      ...order,
      user,
      account,
      items,
      itemCount: order.itemCount || items.length,
      totalQuantity: order.totalQuantity || totalQuantity
    };
  });
}

function exportPhone(order, admin) {
  const user = order.user || {};
  const full = order.customerPhoneSnapshot || user.phoneNumber || user.phone || "";
  const masked = order.customerPhoneMasked || user.phoneMasked || maskPhone(full);
  return canViewFullPhone(admin) ? (full || masked) : masked;
}

function matchesCustomer(order, keyword, admin) {
  if (!keyword) return true;
  const user = order.user || {};
  const haystack = normalizeSearchText([
    user.nickname,
    canViewFullPhone(admin) ? (order.customerPhoneSnapshot || user.phoneNumber || user.phone || order.customerPhoneMasked || user.phoneMasked) : "",
    user.openid,
    order.userOpenid,
    order.userId
  ].filter(Boolean).join(" "));
  return haystack.includes(keyword);
}

function matchesProduct(order, keyword) {
  if (!keyword) return true;
  return order.items.some((item) => {
    const haystack = normalizeSearchText([
      item.productName,
      item.specification,
      item.productionDate,
      item.productIndex,
      item.skuCode,
      item.productId
    ].filter(Boolean).join(" "));
    return haystack.includes(keyword);
  });
}

function applyKeywordFilters(orders, filters, admin) {
  const customerKeyword = normalizeSearchText(filters.customerKeyword);
  const productKeyword = normalizeSearchText(filters.productKeyword);
  return orders.filter((order) => matchesCustomer(order, customerKeyword, admin) && matchesProduct(order, productKeyword));
}

function paidAmountOf(order) {
  if (order.paidAmount !== undefined && order.paidAmount !== null) return asCents(order.paidAmount);
  if (order.paymentStatus === "paid" || order.status === "paid") return asCents(order.totalAmount);
  return 0;
}

function shippingTypeText(order) {
  const type = order.shippingType || (order.deliveryType === "self_pickup" ? "pickup" : "delivery");
  return type === "pickup" ? "自提" : "发货";
}

function shippingStatusText(order) {
  const status = order.shippingStatus || order.deliveryStatus || "";
  const map = {
    pending_shipment: "待发货",
    waiting_shipping: "待发货",
    created: "待发货",
    shipped: "已发货",
    completed: "已完成",
    cancelled: "已取消",
    abnormal: "异常",
    after_sales: "售后中"
  };
  return map[status] || status;
}

function exportAddress(order, allowFullAddress) {
  if ((order.shippingType || "") === "pickup" || order.deliveryType === "self_pickup") {
    return {
      shippingType: shippingTypeText(order),
      receiverName: "",
      receiverPhone: "",
      regionText: "",
      detailAddress: "",
      fullAddress: "",
      addressTag: ""
    };
  }
  const full = order.shippingAddressSnapshot || order.shippingAddress || {};
  const masked = order.shippingAddressMasked || maskedAddressSnapshot(full);
  const address = allowFullAddress ? full : masked;
  return {
    shippingType: shippingTypeText(order),
    receiverName: address.receiverName || "",
    receiverPhone: allowFullAddress ? (address.receiverPhone || "") : (address.receiverPhoneMasked || ""),
    regionText: address.regionText || "",
    detailAddress: allowFullAddress ? (address.detailAddress || "") : (address.detailAddressMasked || ""),
    fullAddress: allowFullAddress ? (address.fullAddress || "") : (address.fullAddressMasked || ""),
    addressTag: address.addressTag || ""
  };
}

function summaryRows(orders, allowFullAddress, admin) {
  return orders.map((order) => {
    const account = order.account || {};
    const totalAmount = asCents(order.totalAmount);
    const paidAmount = paidAmountOf(order);
    const payableAmount = order.payableAmount !== undefined ? asCents(order.payableAmount) : totalAmount;
    const address = exportAddress(order, allowFullAddress);
    return {
      orderNo: order.orderNo,
      createdAt: formatDate(order.createdAt),
      nickname: order.user && order.user.nickname,
      phone: exportPhone(order, admin),
      openid: (order.user && order.user.openid) || order.userOpenid,
      itemCount: order.itemCount,
      totalQuantity: order.totalQuantity,
      totalAmount: moneyText(totalAmount),
      todayOrderAmount: moneyText(order.todayOrderAmount !== undefined ? order.todayOrderAmount : account.todayOrderAmount),
      historicalUnpaidAmount: moneyText(order.historicalUnpaidAmount !== undefined ? order.historicalUnpaidAmount : account.unpaidAmount),
      payableAmount: moneyText(payableAmount),
      paidAmount: moneyText(paidAmount),
      unpaidAmount: moneyText(order.unpaidAmount !== undefined ? order.unpaidAmount : Math.max(payableAmount - paidAmount, 0)),
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      status: order.status,
      reviewType: order.reviewType,
      ...address,
      isMergedShipment: order.isMergedShipment ? "是" : "否",
      mergeShipmentNo: order.mergeShipmentNo || "",
      shippingCompany: order.shippingCompany || order.expressCompany || "",
      trackingNo: order.trackingNo || order.expressNo || "",
      shippingStatus: shippingStatusText(order),
      shippedAt: formatDate(order.shippedAt),
      paymentScreenshotUrl: order.paymentScreenshotUrl,
      adminRemark: order.adminRemark,
      customerRemark: order.customerRemark,
      approvedAt: formatDate(order.approvedAt),
      paidMarkedAt: formatDate(order.paidMarkedAt),
      updatedAt: formatDate(order.updatedAt)
    };
  });
}

function detailRows(orders, allowFullAddress, admin) {
  const rows = [];
  orders.forEach((order) => {
    const address = exportAddress(order, allowFullAddress);
    order.items.forEach((item) => {
      rows.push({
        orderNo: order.orderNo,
        createdAt: formatDate(order.createdAt),
        nickname: order.user && order.user.nickname,
        phone: exportPhone(order, admin),
        openid: (order.user && order.user.openid) || order.userOpenid,
        productIndex: item.productIndex,
        skuCode: item.skuCode,
        productName: item.productName,
        specification: item.specification,
        productionDate: item.productionDate,
        quantity: item.quantity,
        unitPrice: moneyText(item.unitPrice),
        itemTotalAmount: moneyText(item.totalAmount),
        orderTotalAmount: moneyText(order.totalAmount),
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        status: order.status,
        reviewType: order.reviewType,
        ...address,
        isMergedShipment: order.isMergedShipment ? "是" : "否",
        mergeShipmentNo: order.mergeShipmentNo || "",
        shippingCompany: order.shippingCompany || order.expressCompany || "",
        trackingNo: order.trackingNo || order.expressNo || "",
        shippingStatus: shippingStatusText(order),
        shippedAt: formatDate(order.shippedAt),
        stockCheckStatus: item.stockCheckStatus,
        adminRemark: order.adminRemark,
        customerRemark: order.customerRemark,
        paymentScreenshotUrl: order.paymentScreenshotUrl,
        approvedAt: formatDate(order.approvedAt),
        paidMarkedAt: formatDate(order.paidMarkedAt)
      });
    });
  });
  return rows;
}

function buildWorkbook(rows, columns) {
  const aoa = [columns.map((column) => column.title)];
  rows.forEach((row) => {
    aoa.push(columns.map((column) => clean(row[column.key])));
  });

  const worksheet = xlsx.utils.aoa_to_sheet(aoa);
  worksheet["!cols"] = columns.map((column) => ({ wch: column.link ? 36 : Math.max(12, column.title.length + 6) }));

  columns.forEach((column, colIndex) => {
    if (!column.link) return;
    rows.forEach((row, rowIndex) => {
      const url = clean(row[column.key]);
      if (!url) return;
      const address = xlsx.utils.encode_cell({ r: rowIndex + 1, c: colIndex });
      if (worksheet[address]) {
        worksheet[address].l = { Target: url };
        worksheet[address].s = { font: { color: { rgb: "0563C1" }, underline: true } };
      }
    });
  });

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "璁㈠崟瀵煎嚭");
  return workbook;
}

function timestampParts(date = new Date()) {
  return {
    year: date.getFullYear(),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(date.getDate()).padStart(2, "0"),
    time: [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
      "_",
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0")
    ].join("")
  };
}

function buildFileName(exportType) {
  const label = exportType === "detail" ? "detail" : "summary";
  return `orders_${label}_${timestampParts().time}.xlsx`;
}

function buildCloudPath(fileName) {
  const stamp = timestampParts();
  return `exports/orders/${stamp.year}-${stamp.month}/${stamp.day}/${fileName}`;
}

async function getFileUrl(fileID) {
  const res = await cloud.getTempFileURL({ fileList: [fileID] });
  const file = res.fileList && res.fileList[0];
  if (!file || !file.tempFileURL) throw new Error("鏂囦欢閾炬帴鐢熸垚澶辫触");
  return file.tempFileURL;
}

async function writeExportRecord(record) {
  await ensureCollection("export_records");
  await db.collection("export_records").add({
    data: {
      ...record,
      createdAt: db.serverDate()
    }
  });
}

exports.main = async (event = {}) => {
  const filters = compactFilters(event.filters || {});
  const exportType = event.exportType === "detail" ? "detail" : "summary";
  let operator = { operatorId: "", operatorOpenid: cloud.getWXContext().OPENID || "" };
  let fileName = buildFileName(exportType);

  try {
    validateFilters(filters);
    const permissionAdmin = await requirePermission("order:export");
    const allowFullAddress = canExportAddress(permissionAdmin);
    operator = { operatorId: permissionAdmin._id || permissionAdmin.id, operatorOpenid: permissionAdmin.openid };

    const rawOrders = await getPaged("orders", buildOrderWhere(filters), "createdAt", MAX_ORDERS);
    if (rawOrders.length > MAX_ORDERS) throw new Error("瀵煎嚭鏁版嵁杩囧锛岃缂╁皬绛涢€夎寖鍥村悗閲嶈瘯");

    const enriched = await enrichOrders(rawOrders);
    const orders = applyKeywordFilters(enriched, filters, permissionAdmin);
    if (!orders.length) throw new Error("娌℃湁绗﹀悎鏉′欢鐨勮鍗曞彲瀵煎嚭");

    let rows = exportType === "detail"
      ? detailRows(orders, allowFullAddress, permissionAdmin)
      : summaryRows(orders, allowFullAddress, permissionAdmin);
    if (exportType === "detail" && rows.length > MAX_DETAIL_ROWS) {
      throw new Error("瀵煎嚭鏁版嵁杩囧锛岃缂╁皬绛涢€夎寖鍥村悗閲嶈瘯");
    }

    const columns = exportType === "detail" ? DETAIL_COLUMNS : SUMMARY_COLUMNS;
    const workbook = buildWorkbook(rows, columns);
    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
    const fileID = (await cloud.uploadFile({
      cloudPath: buildCloudPath(fileName),
      fileContent: buffer
    })).fileID;
    const fileUrl = await getFileUrl(fileID);

    const data = {
      success: true,
      fileID,
      fileUrl,
      fileName,
      totalOrders: orders.length,
      totalRows: rows.length
    };
    await writeExportRecord({
      exportType,
      fileName,
      fileID,
      fileUrl,
      filters,
      totalOrders: orders.length,
      totalRows: rows.length,
      operatorId: operator.operatorId,
      operatorOpenid: operator.operatorOpenid,
      status: "success",
      errorMessage: ""
    });

    return ok(data);
  } catch (err) {
    const message = err.message || "瀵煎嚭璁㈠崟 Excel 澶辫触";
    try {
      await writeExportRecord({
        exportType,
        fileName,
        fileID: "",
        fileUrl: "",
        filters,
        totalOrders: 0,
        totalRows: 0,
        operatorId: operator.operatorId,
        operatorOpenid: operator.operatorOpenid,
        status: "failed",
        errorMessage: message
      });
    } catch (recordErr) {
      console.error("write export_records failed", recordErr);
    }
    return fail(message);
  }
};

