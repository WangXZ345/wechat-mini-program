const cloud = require("wx-server-sdk");
const xlsx = require("xlsx");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const {
  requireAnyPermission,
  requirePermission,
  hasPermission,
  logAdminOperation,
  ensureCollection
} = require("./auth");
const {
  addressSnapshot,
  maskedAddressSnapshot,
  canViewFullAddress,
  canExportAddress
} = require("./address");
const { maskPhone } = require("./phone");
const {
  runIdempotentAction,
  beginIdempotentAction,
  finishIdempotentAction,
  failIdempotentAction,
  idempotencyEarlyReturn,
  idempotencyErrorResponse,
  firstSuccessData
} = require("./idempotency");
const { createShipmentQueryService } = require("./shipmentQueryService");

const shipmentQueryService = createShipmentQueryService({ db, command: _ });

const ALLOWED_ORDER_STATUSES = [
  "approved",
  "paid",
  "pending_shipment",
  "payment_confirmed",
  "approved_pending_payment"
];
const BLOCKED_ORDER_STATUSES = [
  "pending_review",
  "pending_admin",
  "auto_reviewing",
  "rejected",
  "cancelled",
  "shipped",
  "completed",
  "after_sales"
];
const ACTIVE_MERGE_STATUSES = ["created", "pending_shipment", "shipped", "completed", "abnormal"];
const EDITABLE_STATUSES = ["created", "pending_shipment"];
const WRAPPER_ACTIONS = {
  checkMergeShipmentEligibility: "checkMergeShipmentEligibility",
  createMergeShipment: "createMergeShipment",
  getAdminShipmentGroups: "getAdminShipmentGroups",
  getShipmentGroupDetail: "getShipmentGroupDetail",
  updateShipmentInfo: "updateShipmentInfo",
  confirmShipment: "confirmShipment",
  cancelMergeShipment: "cancelMergeShipment",
  completeShipment: "completeShipment",
  exportShipmentPickingList: "exportShipmentPickingList"
};

function ok(data) {
  return { ok: true, data };
}

function fail(message, code) {
  return { ok: false, code: code || "", message };
}

function cleanText(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function normalizeOrderIds(value) {
  const list = Array.isArray(value) ? value : [];
  return Array.from(new Set(list.map((item) => cleanText(item, 80)).filter(Boolean)));
}

function cents(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num);
}

function quantity(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.round(num));
}

function nowDate() {
  return new Date();
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function normalizePaymentStatus(status) {
  if (status === "partial") return "partial_paid";
  return status || "none";
}

function isPaidOrder(order, settings) {
  const status = normalizePaymentStatus(order.paymentStatus || order.status);
  if (!settings.requirePaidBeforeShipment) return true;
  if (status === "paid") return true;
  if (["partial", "partial_paid"].includes(status) && settings.allowPartialPaidShipment) return true;
  return false;
}

function deliveryTypeOf(order) {
  if (order.shippingType === "pickup") return "pickup";
  if (order.shippingType === "delivery") return "delivery";
  if (order.deliveryType === "self_pickup") return "pickup";
  if (order.deliveryType === "shipping") return "delivery";
  return "delivery";
}

function shippingStatusOf(order) {
  return order.shippingStatus || (
    order.deliveryStatus === "shipped" ? "shipped"
      : order.deliveryStatus === "completed" ? "completed"
        : order.deliveryStatus === "after_sales" ? "abnormal"
          : "pending_shipment"
  );
}

function canMergeStatus(order) {
  const status = order.status || "";
  if (BLOCKED_ORDER_STATUSES.includes(status)) return false;
  if (ALLOWED_ORDER_STATUSES.includes(status)) return true;
  return order.paymentStatus === "paid" || order.deliveryStatus === "waiting_shipping";
}

function customerKey(order) {
  return order.userId || order.userOpenid || order.openid || "";
}

function customerOpenid(order) {
  return order.userOpenid || order.openid || "";
}

function sameCustomerOrders(orders = []) {
  if (orders.length <= 1) return true;
  const userIds = orders.map((order) => order.userId || "").filter(Boolean);
  if (userIds.length === orders.length && userIds.every((id) => id === userIds[0])) return true;
  const openids = orders.map((order) => customerOpenid(order)).filter(Boolean);
  return openids.length === orders.length && openids.every((openid) => openid === openids[0]);
}

function publicCustomerName(order) {
  const user = order.user || {};
  return cleanText(order.customerName || user.nickname || user.name || order.userOpenid || order.userId || "客户", 80);
}

function phoneMasked(order) {
  return order.customerPhoneMasked
    || maskPhone(order.customerPhoneSnapshot || (order.user && (order.user.phoneNumber || order.user.phone)) || "");
}

function fullAddressOf(order) {
  return order.shippingAddressSnapshot || order.shippingAddress || {};
}

function comparableAddress(order) {
  const address = fullAddressOf(order);
  return [
    address.receiverName,
    address.receiverPhone,
    address.receiverPhoneMasked,
    address.regionText,
    address.detailAddress,
    address.fullAddress,
    address.addressTag
  ].map((item) => cleanText(item, 200)).join("|");
}

function mergeSettings(data = {}) {
  return {
    enableMergeShipment: data.enableMergeShipment !== false,
    allowMergeDifferentAddress: data.allowMergeDifferentAddress === true,
    allowPartialPaidShipment: data.allowPartialPaidShipment === true,
    requirePaidBeforeShipment: data.requirePaidBeforeShipment !== false,
    maxOrdersPerMergeShipment: Math.max(1, Number(data.maxOrdersPerMergeShipment || 50)),
    maxItemsPerMergeShipment: Math.max(1, Number(data.maxItemsPerMergeShipment || 500)),
    defaultShippingCompany: cleanText(data.defaultShippingCompany, 80),
    allowCancelMergeShipmentBeforeShipped: data.allowCancelMergeShipmentBeforeShipped !== false
  };
}

async function getMergeSettings() {
  const res = await db.collection("settings").doc("system_settings").get().catch(() => null);
  return mergeSettings(res && res.data ? res.data : {});
}

async function ensureShipmentCollections() {
  await Promise.all([
    ensureCollection("shipment_groups"),
    ensureCollection("shipment_group_items"),
    ensureCollection("shipment_logs"),
    ensureCollection("admin_operation_logs")
  ]);
}

function isMissingCollection(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

function batches(list, size = 20) {
  const result = [];
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
  return result;
}

async function loadOrdersByIds(orderIds) {
  const map = {};
  for (const ids of batches(orderIds)) {
    const res = await db.collection("orders").where({ _id: _.in(ids) }).limit(100).get();
    (res.data || []).forEach((order) => {
      map[order._id] = order;
    });
  }
  return orderIds.map((id) => map[id]).filter(Boolean);
}

async function loadOrderItems(orderIds, orderMap = {}) {
  const map = {};
  orderIds.forEach((id) => { map[id] = []; });
  for (const ids of batches(orderIds)) {
    try {
      const res = await db.collection("order_items").where({ orderId: _.in(ids) }).limit(1000).get();
      (res.data || []).forEach((item) => {
        if (!map[item.orderId]) map[item.orderId] = [];
        map[item.orderId].push(item);
      });
    } catch (err) {
      if (!isMissingCollection(err)) throw err;
    }
  }
  orderIds.forEach((id) => {
    if (map[id] && map[id].length) return;
    const order = orderMap[id];
    if (!order || (!order.productId && !order.productName)) return;
    map[id] = [{
      orderId: id,
      orderNo: order.orderNo || "",
      productId: order.productId || "",
      productName: order.productName || "",
      brand: order.brand || "",
      category: order.category || "",
      specification: order.specification || "",
      productionDate: order.productionDate || "",
      quantity: order.quantity || 0,
      unitPrice: order.unitPrice || 0,
      totalAmount: order.totalAmount || 0,
      imageUrl: order.productImage || order.imageUrl || "",
      tags: order.tags || []
    }];
  });
  return map;
}

function itemKey(item) {
  return [
    item.productId,
    item.productName,
    item.specification,
    item.productionDate,
    item.brand,
    item.category
  ].map((part) => cleanText(part, 120)).join("|");
}

function normalizeShipmentItem(item, order, shipmentGroupId = "", shipmentNo = "") {
  const count = quantity(item.quantity);
  const price = cents(item.unitPrice);
  return {
    shipmentGroupId,
    shipmentNo,
    orderId: order._id,
    orderNo: order.orderNo || "",
    productId: cleanText(item.productId, 80),
    productName: cleanText(item.productName || order.productName, 160),
    brand: cleanText(item.brand || order.brand, 80),
    category: cleanText(item.category || order.category, 80),
    specification: cleanText(item.specification || order.specification, 120),
    productionDate: cleanText(item.productionDate || order.productionDate, 80),
    quantity: count,
    unitPrice: price,
    subtotal: cents(item.totalAmount !== undefined ? item.totalAmount : price * count),
    imageUrl: cleanText(item.productImage || item.imageUrl || "", 500),
    tags: Array.isArray(item.tags) ? item.tags : [],
    createdAt: db.serverDate()
  };
}

function aggregateItems(orders, itemMap) {
  const grouped = {};
  const snapshots = [];
  orders.forEach((order) => {
    const items = itemMap[order._id] || [];
    items.forEach((raw) => {
      const item = normalizeShipmentItem(raw, order);
      snapshots.push(item);
      const key = itemKey(item);
      if (!grouped[key]) {
        grouped[key] = {
          productId: item.productId,
          productName: item.productName,
          brand: item.brand,
          category: item.category,
          specification: item.specification,
          productionDate: item.productionDate,
          quantity: 0,
          totalQuantity: 0,
          orderNos: [],
          orderIds: [],
          imageUrl: item.imageUrl,
          tags: item.tags
        };
      }
      grouped[key].quantity += item.quantity;
      grouped[key].totalQuantity += item.quantity;
      if (!grouped[key].orderNos.includes(item.orderNo)) grouped[key].orderNos.push(item.orderNo);
      if (!grouped[key].orderIds.includes(item.orderId)) grouped[key].orderIds.push(item.orderId);
    });
  });
  return {
    items: snapshots,
    itemSummary: Object.values(grouped),
    totalItemCount: snapshots.reduce((sum, item) => sum + item.quantity, 0),
    totalProductCount: Object.keys(grouped).length
  };
}

function reasonMessage(code) {
  const map = {
    ORDER_NOT_FOUND: "订单不存在",
    NOT_SAME_CUSTOMER: "所选订单不属于同一客户",
    PICKUP_ORDER_NOT_ALLOWED: "自提订单不能合并发货",
    ORDER_NOT_PAID: "存在未完成付款订单，默认不允许发货",
    ORDER_ALREADY_SHIPPED: "订单已发货或已完成",
    ORDER_ALREADY_IN_MERGE_SHIPMENT: "订单已属于其他合并发货单",
    ORDER_STATUS_NOT_ALLOWED: "订单状态不允许发货",
    ADDRESS_NOT_MATCH: "所选订单收货地址不一致，默认不允许合并发货",
    EXCEED_MAX_ORDERS: "超过单次最大合并订单数",
    EXCEED_MAX_ITEMS: "超过单次最大商品件数",
    MERGE_SHIPMENT_DISABLED: "合并发货功能未启用"
  };
  return map[code] || code;
}

async function buildEligibility(event = {}, admin) {
  const orderIds = normalizeOrderIds(event.orderIds);
  const settings = await getMergeSettings();
  const results = [];
  const failureCodes = [];
  const addFailure = (code) => {
    if (!failureCodes.includes(code)) failureCodes.push(code);
  };

  if (!settings.enableMergeShipment) addFailure("MERGE_SHIPMENT_DISABLED");
  if (!orderIds.length) throw new Error("请选择订单");
  if (orderIds.length > settings.maxOrdersPerMergeShipment) addFailure("EXCEED_MAX_ORDERS");

  const orders = await loadOrdersByIds(orderIds);
  const orderMap = {};
  orders.forEach((order) => { orderMap[order._id] = order; });
  const itemMap = await loadOrderItems(orderIds, orderMap);
  const aggregate = aggregateItems(orders, itemMap);
  if (aggregate.totalItemCount > settings.maxItemsPerMergeShipment) addFailure("EXCEED_MAX_ITEMS");

  const firstCustomer = orders[0] ? customerKey(orders[0]) : "";
  const firstAddress = orders[0] ? comparableAddress(orders[0]) : "";
  const addressConsistent = orders.length <= 1 || orders.every((order) => comparableAddress(order) === firstAddress);
  const sameCustomer = sameCustomerOrders(orders);

  orderIds.forEach((id) => {
    const order = orderMap[id];
    const reasons = [];
    if (!order) reasons.push("ORDER_NOT_FOUND");
    if (order) {
      if (!sameCustomer) reasons.push("NOT_SAME_CUSTOMER");
      if (deliveryTypeOf(order) === "pickup") reasons.push("PICKUP_ORDER_NOT_ALLOWED");
      if (!canMergeStatus(order)) reasons.push("ORDER_STATUS_NOT_ALLOWED");
      if (!isPaidOrder(order, settings)) reasons.push("ORDER_NOT_PAID");
      if (["shipped", "completed"].includes(shippingStatusOf(order)) || ["shipped", "completed"].includes(order.deliveryStatus)) {
        reasons.push("ORDER_ALREADY_SHIPPED");
      }
      if (order.mergeShipmentId && order.mergeShipmentStatus !== "cancelled") {
        reasons.push("ORDER_ALREADY_IN_MERGE_SHIPMENT");
      }
      if (!addressConsistent && !settings.allowMergeDifferentAddress) reasons.push("ADDRESS_NOT_MATCH");
    }
    reasons.forEach(addFailure);
    results.push({
      orderId: id,
      orderNo: order && order.orderNo || "",
      valid: !reasons.length,
      reasons,
      reasonMessages: reasons.map(reasonMessage)
    });
  });

  if (!sameCustomer) addFailure("NOT_SAME_CUSTOMER");
  if (!addressConsistent && !settings.allowMergeDifferentAddress) addFailure("ADDRESS_NOT_MATCH");

  const first = orders[0] || {};
  const address = addressSnapshot(fullAddressOf(first));
  const maskedAddress = maskedAddressSnapshot(address);
  const totalOrderAmount = orders.reduce((sum, order) => sum + cents(order.totalAmount), 0);
  const totalPaidAmount = orders.reduce((sum, order) => {
    if (order.paidAmount !== undefined && order.paidAmount !== null) return sum + cents(order.paidAmount);
    return sum + (normalizePaymentStatus(order.paymentStatus) === "paid" ? cents(order.totalAmount) : 0);
  }, 0);
  const summary = {
    customerName: publicCustomerName(first),
    customerPhoneMasked: phoneMasked(first),
    userId: first.userId || "",
    openid: first.userOpenid || first.openid || "",
    orderIds: orders.map((order) => order._id),
    orderNos: orders.map((order) => order.orderNo || ""),
    orderCount: orders.length,
    totalItemCount: aggregate.totalItemCount,
    totalProductCount: aggregate.totalProductCount,
    totalOrderAmount,
    totalPaidAmount,
    totalUnpaidAmount: Math.max(totalOrderAmount - totalPaidAmount, 0),
    shippingType: "delivery",
    shippingAddressSnapshot: canViewFullAddress(admin) ? address : null,
    shippingAddressMasked: maskedAddress,
    addressConsistent,
    itemSummary: aggregate.itemSummary,
    orders: orders.map((order) => ({
      orderId: order._id,
      orderNo: order.orderNo || "",
      createdAt: order.createdAt || null,
      status: order.status || "",
      paymentStatus: order.paymentStatus || "",
      totalAmount: cents(order.totalAmount),
      shippingStatus: shippingStatusOf(order)
    })),
    settings
  };

  return {
    canMerge: failureCodes.length === 0,
    failureCodes,
    failureMessages: failureCodes.map(reasonMessage),
    orderResults: results,
    addressConsistent,
    summary,
    itemSummary: aggregate.itemSummary,
    rawOrders: orders,
    rawItems: aggregate.items
  };
}

async function checkMergeShipmentEligibility(event = {}) {
  const admin = await requireAnyPermission(["shipment:merge", "order:ship"]);
  const result = await buildEligibility(event, admin);
  delete result.rawOrders;
  delete result.rawItems;
  return result;
}

async function nextShipmentNo(tx) {
  const d = nowDate();
  const dateText = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const counterId = `merge_shipment_${dateText}`;
  try {
    await tx.collection("counters").doc(counterId).update({
      data: {
        value: _.inc(1),
        updatedAt: db.serverDate()
      }
    });
  } catch (err) {
    await tx.collection("counters").doc(counterId).set({
      data: {
        value: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  }
  const counter = (await tx.collection("counters").doc(counterId).get()).data || {};
  return `MS${dateText}${String(counter.value || 1).padStart(4, "0")}`;
}

async function writeShipmentLog(store, payload) {
  if (payload.businessKey) {
    const existing = await store.collection("shipment_logs").where({ businessKey: payload.businessKey }).limit(1).get().catch(() => ({ data: [] }));
    if (existing.data && existing.data[0]) return false;
  }
  await store.collection("shipment_logs").add({
    data: {
      businessKey: payload.businessKey || "",
      sourceType: "shipment",
      sourceId: payload.shipmentGroupId || "",
      idempotencyKey: payload.idempotencyKey || "",
      shipmentGroupId: payload.shipmentGroupId || "",
      shipmentNo: payload.shipmentNo || "",
      orderIds: payload.orderIds || [],
      action: payload.action,
      beforeData: payload.beforeData || null,
      afterData: payload.afterData || null,
      operatorId: payload.operator && (payload.operator._id || payload.operator.id) || "",
      operatorOpenid: payload.operator && payload.operator.openid || cloud.getWXContext().OPENID,
      operatorRole: payload.operator && payload.operator.role || "",
      remark: payload.remark || "",
      createdAt: db.serverDate()
    }
  });
  return true;
}

function maskShipmentForLog(group = {}) {
  return {
    shipmentNo: group.shipmentNo || "",
    orderIds: group.orderIds || [],
    orderNos: group.orderNos || [],
    shippingStatus: group.shippingStatus || "",
    shippingCompany: group.shippingCompany || "",
    trackingNo: group.trackingNo || "",
    customerName: group.customerName || "",
    customerPhoneMasked: group.customerPhoneMasked || "",
    shippingAddressMasked: group.shippingAddressMasked || null,
    addressConsistent: group.addressConsistent === true,
    adminRemark: group.adminRemark || ""
  };
}

async function createMergeShipment(event = {}) {
  const admin = await requirePermission("shipment:merge");
  await ensureShipmentCollections();
  await ensureCollection("counters");
  const orderIds = normalizeOrderIds(event.orderIds);
  return runIdempotentAction({
    db,
    actionType: "create_merge_shipment",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "shipment",
    scopeId: orderIds.slice().sort().join("|"),
    openid: admin.openid,
    adminId: admin._id || admin.id || "",
    payload: { orderIds: orderIds.slice().sort(), adminRemark: cleanText(event.adminRemark, 500) }
  }, async () => {
  const eligibility = await buildEligibility(event, admin);
  if (!eligibility.canMerge) {
    const err = new Error(eligibility.failureMessages.join("；") || "订单不能合并发货");
    err.data = eligibility;
    throw err;
  }
  const adminRemark = cleanText(event.adminRemark, 500);

  const result = await db.runTransaction(async (tx) => {
    const existing = await tx.collection("shipment_groups")
      .where({ idempotencyKey: orderIds.slice().sort().join("|"), shippingStatus: _.in(ACTIVE_MERGE_STATUSES) })
      .limit(1)
      .get();
    if (existing.data[0]) {
      return {
        shipmentGroupId: existing.data[0]._id,
        shipmentNo: existing.data[0].shipmentNo,
        reused: true
      };
    }

    for (const id of orderIds) {
      const current = (await tx.collection("orders").doc(id).get()).data;
      if (!current) throw new Error("订单不存在");
      if (current.mergeShipmentId && current.mergeShipmentStatus !== "cancelled") throw new Error("订单已属于其他合并发货单");
      if (["shipped", "completed"].includes(shippingStatusOf(current)) || ["shipped", "completed"].includes(current.deliveryStatus)) {
        throw new Error("订单已发货或已完成");
      }
    }

    const shipmentNo = await nextShipmentNo(tx);
    const summary = eligibility.summary;
    const firstAddress = summary.shippingAddressSnapshot || eligibility.rawOrders[0].shippingAddressSnapshot || eligibility.rawOrders[0].shippingAddress || {};
    const maskedAddress = summary.shippingAddressMasked || maskedAddressSnapshot(firstAddress);
    const created = await tx.collection("shipment_groups").add({
      data: {
        shipmentNo,
        idempotencyKey: orderIds.slice().sort().join("|"),
        userId: summary.userId,
        openid: summary.openid,
        customerName: summary.customerName,
        customerPhoneMasked: summary.customerPhoneMasked,
        orderIds,
        orderNos: summary.orderNos,
        orderCount: summary.orderCount,
        totalItemCount: summary.totalItemCount,
        totalProductCount: summary.totalProductCount,
        totalOrderAmount: summary.totalOrderAmount,
        totalPaidAmount: summary.totalPaidAmount,
        totalUnpaidAmount: summary.totalUnpaidAmount,
        shippingType: "delivery",
        shippingAddressSnapshot: addressSnapshot(firstAddress),
        shippingAddressMasked: maskedAddress,
        addressConsistent: summary.addressConsistent,
        shippingCompany: summary.settings.defaultShippingCompany || "",
        trackingNo: "",
        trackingNoList: [],
        shippingStatus: summary.settings.defaultShippingCompany ? "pending_shipment" : "created",
        shippedAt: null,
        completedAt: null,
        cancelledAt: null,
        cancelledBy: "",
        cancelReason: "",
        shippedBy: "",
        createdBy: admin._id || admin.id || "",
        updatedBy: admin._id || admin.id || "",
        adminRemark,
        shipmentImages: [],
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });

    for (const raw of eligibility.rawItems) {
      await tx.collection("shipment_group_items").add({
        data: {
          ...raw,
          shipmentGroupId: created._id,
          shipmentNo
        }
      });
    }

    for (const order of eligibility.rawOrders) {
      await tx.collection("orders").doc(order._id).update({
        data: {
          mergeShipmentId: created._id,
          mergeShipmentNo: shipmentNo,
          isMergedShipment: true,
          mergeShipmentStatus: "created",
          shippingStatus: "pending_shipment",
          shipmentRemark: adminRemark,
          shipmentUpdatedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }

    await writeShipmentLog(tx, {
      businessKey: `shipment_create:${orderIds.slice().sort().join("|")}`,
      idempotencyKey: event.idempotencyKey || "",
      shipmentGroupId: created._id,
      shipmentNo,
      orderIds,
      action: "create",
      afterData: { shipmentNo, orderIds, orderNos: summary.orderNos, shippingStatus: "created" },
      operator: admin,
      remark: adminRemark
    });

    return { shipmentGroupId: created._id, shipmentNo, reused: false };
  });

  await logAdminOperation({
    operator: admin,
    action: "shipment:create",
    resourceType: "shipment_group",
    resourceId: result.shipmentGroupId,
    beforeData: null,
    afterData: result,
    description: result.reused ? "Reuse existing merge shipment" : "Create merge shipment"
  });
  return result;
  }).then((res) => {
    if (!res.ok) {
      const err = new Error(res.message || "创建合并发货失败");
      err.code = res.code;
      throw err;
    }
    return res.data;
  });
}

async function getAdminShipmentGroups(event = {}) {
  const admin = await requirePermission("shipment:view");
  return shipmentQueryService.listLegacyShipmentGroups({
    actor: admin,
    query: {
      keyword: event.keyword,
      status: event.status,
      page: event.page,
      pageSize: event.pageSize
    }
  });
}

async function getShipmentGroup(shipmentGroupId) {
  const id = cleanText(shipmentGroupId || "", 80);
  if (!id) throw new Error("缺少合并发货单 ID");
  const group = (await db.collection("shipment_groups").doc(id).get()).data;
  if (!group) throw new Error("合并发货单不存在");
  return group;
}

async function getShipmentGroupDetail(event = {}) {
  const admin = await requirePermission("shipment:view");
  return shipmentQueryService.getLegacyShipmentGroupDetail({
    actor: admin,
    id: event.shipmentGroupId
  });
}

async function updateShipmentInfo(event = {}) {
  const admin = await requireAnyPermission(["shipment:update", "shipment:ship"]);
  await ensureShipmentCollections();
  const group = await getShipmentGroup(event.shipmentGroupId);
  if (!EDITABLE_STATUSES.includes(group.shippingStatus)) throw new Error("当前发货单状态不能修改物流");
  const shippingCompany = cleanText(event.shippingCompany, 80);
  const trackingNo = cleanText(event.trackingNo, 120);
  const adminRemark = cleanText(event.adminRemark, 500);
  const shipmentImages = Array.isArray(event.shipmentImages)
    ? event.shipmentImages.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 9)
    : [];
  const patch = {
    shippingCompany,
    trackingNo,
    trackingNoList: trackingNo ? [trackingNo] : [],
    adminRemark,
    shipmentImages,
    shippingStatus: shippingCompany || trackingNo ? "pending_shipment" : group.shippingStatus,
    updatedBy: admin._id || admin.id || "",
    updatedAt: db.serverDate()
  };
  await db.collection("shipment_groups").doc(group._id).update({ data: patch });
  await writeShipmentLog(db, {
    shipmentGroupId: group._id,
    shipmentNo: group.shipmentNo,
    orderIds: group.orderIds || [],
    action: "update",
    beforeData: maskShipmentForLog(group),
    afterData: { ...maskShipmentForLog(group), ...patch, updatedAt: undefined },
    operator: admin,
    remark: adminRemark
  });
  await logAdminOperation({
    operator: admin,
    action: "shipment:update",
    resourceType: "shipment_group",
    resourceId: group._id,
    beforeData: maskShipmentForLog(group),
    afterData: { ...maskShipmentForLog(group), ...patch, updatedAt: undefined },
    description: "Update shipment logistics"
  });
  return { shipmentGroupId: group._id, shipmentNo: group.shipmentNo, shippingStatus: patch.shippingStatus };
}

async function confirmShipment(event = {}) {
  const admin = await requirePermission("shipment:ship");
  await ensureShipmentCollections();
  const shippingCompany = cleanText(event.shippingCompany, 80);
  const trackingNo = cleanText(event.trackingNo, 120);
  const adminRemark = cleanText(event.adminRemark, 500);
  if (!shippingCompany) throw new Error("请填写快递公司");
  if (!trackingNo) throw new Error("请填写快递单号");
  let begin = await beginIdempotentAction({
    db,
    actionType: "confirm_shipment",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "shipment",
    scopeId: event.shipmentGroupId,
    openid: admin.openid,
    adminId: admin._id || admin.id || "",
    payload: { shipmentGroupId: event.shipmentGroupId, shippingCompany, trackingNo, adminRemark }
  });
  const early = idempotencyEarlyReturn(begin);
  if (early) {
    if (early.ok) return early.data;
    const err = new Error(early.message);
    err.code = early.code;
    throw err;
  }
  try {
  const group = await getShipmentGroup(event.shipmentGroupId);
  if (group.shippingStatus === "shipped" || group.shippingStatus === "completed") {
    const reused = firstSuccessData({ shipmentGroupId: group._id, shipmentNo: group.shipmentNo, shippingStatus: group.shippingStatus, reused: true });
    await finishIdempotentAction(db, begin.recordId, { data: reused });
    return reused;
  }
  if (!EDITABLE_STATUSES.includes(group.shippingStatus)) throw new Error("当前发货单状态不能确认发货");
  const shippedBy = admin._id || admin.id || "";
  await db.runTransaction(async (tx) => {
    await tx.collection("shipment_groups").doc(group._id).update({
      data: {
        shippingCompany,
        trackingNo,
        trackingNoList: [trackingNo],
        shippingStatus: "shipped",
        shippedAt: db.serverDate(),
        shippedBy,
        updatedBy: shippedBy,
        adminRemark,
        updatedAt: db.serverDate()
      }
    });
    for (const orderId of group.orderIds || []) {
      await tx.collection("orders").doc(orderId).update({
        data: {
          shippingStatus: "shipped",
          deliveryStatus: "shipped",
          shippingCompany,
          trackingNo,
          expressCompany: shippingCompany,
          expressNo: trackingNo,
          shippedAt: db.serverDate(),
          shippedBy,
          mergeShipmentStatus: "shipped",
          shipmentRemark: adminRemark,
          shipmentUpdatedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
    await writeShipmentLog(tx, {
      businessKey: `shipment_confirm:${group._id}`,
      idempotencyKey: event.idempotencyKey || "",
      shipmentGroupId: group._id,
      shipmentNo: group.shipmentNo,
      orderIds: group.orderIds || [],
      action: "ship",
      beforeData: maskShipmentForLog(group),
      afterData: {
        shipmentNo: group.shipmentNo,
        orderIds: group.orderIds || [],
        shippingStatus: "shipped",
        shippingCompany,
        trackingNo
      },
      operator: admin,
      remark: adminRemark
    });
  });
  await logAdminOperation({
    operator: admin,
    action: "shipment:ship",
    resourceType: "shipment_group",
    resourceId: group._id,
    beforeData: maskShipmentForLog(group),
    afterData: { shipmentNo: group.shipmentNo, shippingStatus: "shipped", shippingCompany, trackingNo },
    description: "Confirm merge shipment"
  });
  const finalResult = firstSuccessData({ shipmentGroupId: group._id, shipmentNo: group.shipmentNo, shippingStatus: "shipped" });
  await finishIdempotentAction(db, begin.recordId, { data: finalResult });
  return finalResult;
  } catch (err) {
    await failIdempotentAction(db, begin.recordId, err);
    throw err;
  }
}

async function cancelMergeShipment(event = {}) {
  const admin = await requirePermission("shipment:cancel");
  await ensureShipmentCollections();
  let begin = await beginIdempotentAction({
    db,
    actionType: "cancel_merge_shipment",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "shipment",
    scopeId: event.shipmentGroupId,
    openid: admin.openid,
    adminId: admin._id || admin.id || "",
    payload: { shipmentGroupId: event.shipmentGroupId, cancelReason: cleanText(event.cancelReason, 300) }
  });
  const early = idempotencyEarlyReturn(begin);
  if (early) {
    if (early.ok) return early.data;
    const err = new Error(early.message);
    err.code = early.code;
    throw err;
  }
  try {
  const group = await getShipmentGroup(event.shipmentGroupId);
  if (group.shippingStatus === "cancelled") {
    const reused = firstSuccessData({ shipmentGroupId: group._id, shipmentNo: group.shipmentNo, shippingStatus: "cancelled", reused: true });
    await finishIdempotentAction(db, begin.recordId, { data: reused });
    return reused;
  }
  if (!EDITABLE_STATUSES.includes(group.shippingStatus)) throw new Error("已发货的合并发货单不能取消");
  const settings = await getMergeSettings();
  if (!settings.allowCancelMergeShipmentBeforeShipped) throw new Error("系统设置不允许取消合并发货单");
  const cancelReason = cleanText(event.cancelReason, 300);
  if (!cancelReason) throw new Error("请填写取消原因");
  await db.runTransaction(async (tx) => {
    await tx.collection("shipment_groups").doc(group._id).update({
      data: {
        shippingStatus: "cancelled",
        cancelledAt: db.serverDate(),
        cancelledBy: admin._id || admin.id || "",
        cancelReason,
        updatedBy: admin._id || admin.id || "",
        updatedAt: db.serverDate()
      }
    });
    for (const orderId of group.orderIds || []) {
      await tx.collection("orders").doc(orderId).update({
        data: {
          mergeShipmentId: null,
          mergeShipmentNo: null,
          isMergedShipment: false,
          mergeShipmentStatus: "cancelled",
          shippingStatus: "pending_shipment",
          shipmentRemark: "",
          shipmentUpdatedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
    await writeShipmentLog(tx, {
      businessKey: `shipment_cancel:${group._id}`,
      idempotencyKey: event.idempotencyKey || "",
      shipmentGroupId: group._id,
      shipmentNo: group.shipmentNo,
      orderIds: group.orderIds || [],
      action: "cancel",
      beforeData: maskShipmentForLog(group),
      afterData: { shipmentNo: group.shipmentNo, shippingStatus: "cancelled", cancelReason },
      operator: admin,
      remark: cancelReason
    });
  });
  await logAdminOperation({
    operator: admin,
    action: "shipment:cancel",
    resourceType: "shipment_group",
    resourceId: group._id,
    beforeData: maskShipmentForLog(group),
    afterData: { shipmentNo: group.shipmentNo, shippingStatus: "cancelled", cancelReason },
    description: "Cancel merge shipment"
  });
  const finalResult = firstSuccessData({ shipmentGroupId: group._id, shipmentNo: group.shipmentNo, shippingStatus: "cancelled" });
  await finishIdempotentAction(db, begin.recordId, { data: finalResult });
  return finalResult;
  } catch (err) {
    await failIdempotentAction(db, begin.recordId, err);
    throw err;
  }
}

async function completeShipment(event = {}) {
  const admin = await requirePermission("shipment:complete");
  await ensureShipmentCollections();
  let begin = await beginIdempotentAction({
    db,
    actionType: "complete_shipment",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "shipment",
    scopeId: event.shipmentGroupId,
    openid: admin.openid,
    adminId: admin._id || admin.id || "",
    payload: { shipmentGroupId: event.shipmentGroupId, remark: cleanText(event.remark, 300) }
  });
  const early = idempotencyEarlyReturn(begin);
  if (early) {
    if (early.ok) return early.data;
    const err = new Error(early.message);
    err.code = early.code;
    throw err;
  }
  try {
  const group = await getShipmentGroup(event.shipmentGroupId);
  if (group.shippingStatus === "completed") {
    const reused = firstSuccessData({ shipmentGroupId: group._id, shipmentNo: group.shipmentNo, shippingStatus: "completed", reused: true });
    await finishIdempotentAction(db, begin.recordId, { data: reused });
    return reused;
  }
  if (group.shippingStatus !== "shipped") throw new Error("只有已发货的合并发货单可以标记完成");
  await db.runTransaction(async (tx) => {
    await tx.collection("shipment_groups").doc(group._id).update({
      data: {
        shippingStatus: "completed",
        completedAt: db.serverDate(),
        updatedBy: admin._id || admin.id || "",
        updatedAt: db.serverDate()
      }
    });
    for (const orderId of group.orderIds || []) {
      await tx.collection("orders").doc(orderId).update({
        data: {
          shippingStatus: "completed",
          deliveryStatus: "completed",
          completedAt: db.serverDate(),
          mergeShipmentStatus: "completed",
          shipmentUpdatedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
    await writeShipmentLog(tx, {
      businessKey: `shipment_complete:${group._id}`,
      idempotencyKey: event.idempotencyKey || "",
      shipmentGroupId: group._id,
      shipmentNo: group.shipmentNo,
      orderIds: group.orderIds || [],
      action: "complete",
      beforeData: maskShipmentForLog(group),
      afterData: { shipmentNo: group.shipmentNo, shippingStatus: "completed" },
      operator: admin,
      remark: cleanText(event.remark, 300)
    });
  });
  await logAdminOperation({
    operator: admin,
    action: "shipment:complete",
    resourceType: "shipment_group",
    resourceId: group._id,
    beforeData: maskShipmentForLog(group),
    afterData: { shipmentNo: group.shipmentNo, shippingStatus: "completed" },
    description: "Complete merge shipment"
  });
  const finalResult = firstSuccessData({ shipmentGroupId: group._id, shipmentNo: group.shipmentNo, shippingStatus: "completed" });
  await finishIdempotentAction(db, begin.recordId, { data: finalResult });
  return finalResult;
  } catch (err) {
    await failIdempotentAction(db, begin.recordId, err);
    throw err;
  }
}

function buildWorkbook(rows, columns, sheetName) {
  const aoa = [columns.map((column) => column.title)];
  rows.forEach((row) => {
    aoa.push(columns.map((column) => row[column.key] === undefined || row[column.key] === null ? "" : String(row[column.key])));
  });
  const worksheet = xlsx.utils.aoa_to_sheet(aoa);
  worksheet["!cols"] = columns.map((column) => ({ wch: Math.max(12, column.title.length + 6) }));
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
  return workbook;
}

function exportFileName(group) {
  return `merge_shipment_${group.shipmentNo || formatDate(nowDate())}.xlsx`;
}

function exportPath(fileName) {
  const stamp = formatDate(nowDate());
  return `exports/shipments/${stamp.slice(0, 6)}/${stamp.slice(6, 8)}/${fileName}`;
}

async function tempUrl(fileID) {
  const res = await cloud.getTempFileURL({ fileList: [fileID] });
  const file = res.fileList && res.fileList[0];
  if (!file || !file.tempFileURL) throw new Error("文件链接生成失败");
  return file.tempFileURL;
}

async function exportShipmentPickingList(event = {}) {
  const admin = await requirePermission("shipment:export");
  await ensureShipmentCollections();
  const group = await getShipmentGroup(event.shipmentGroupId);
  const allowFullAddress = canExportAddress(admin) || hasPermission(admin, "shipment:view_address_full");
  const address = allowFullAddress ? (group.shippingAddressSnapshot || {}) : (group.shippingAddressMasked || {});
  const receiverPhone = allowFullAddress ? (address.receiverPhone || "") : (address.receiverPhoneMasked || "");
  const fullAddress = allowFullAddress
    ? (address.fullAddress || [address.regionText, address.detailAddress].filter(Boolean).join(" "))
    : (address.fullAddressMasked || [address.regionText, address.detailAddressMasked].filter(Boolean).join(" "));
  const items = (await db.collection("shipment_group_items").where({ shipmentGroupId: group._id }).limit(1000).get()).data || [];
  const rows = items.map((item) => ({
    shipmentNo: group.shipmentNo,
    orderNo: item.orderNo,
    customerName: group.customerName,
    receiverName: address.receiverName || "",
    receiverPhone,
    fullAddress,
    productName: item.productName,
    brand: item.brand,
    specification: item.specification,
    productionDate: item.productionDate,
    quantity: item.quantity,
    shippingCompany: group.shippingCompany,
    trackingNo: group.trackingNo,
    shippedAt: formatDateTime(group.shippedAt),
    shippedBy: group.shippedBy || "",
    adminRemark: group.adminRemark || ""
  }));
  if (!rows.length) throw new Error("没有可导出的拣货明细");
  const columns = [
    { title: "合并发货单号", key: "shipmentNo" },
    { title: "订单编号", key: "orderNo" },
    { title: "客户", key: "customerName" },
    { title: "收货人", key: "receiverName" },
    { title: "手机号", key: "receiverPhone" },
    { title: "地址", key: "fullAddress" },
    { title: "商品名称", key: "productName" },
    { title: "品牌", key: "brand" },
    { title: "规格", key: "specification" },
    { title: "生产日期", key: "productionDate" },
    { title: "数量", key: "quantity" },
    { title: "快递公司", key: "shippingCompany" },
    { title: "快递单号", key: "trackingNo" },
    { title: "发货时间", key: "shippedAt" },
    { title: "发货人", key: "shippedBy" },
    { title: "备注", key: "adminRemark" }
  ];
  const workbook = buildWorkbook(rows, columns, "合并发货拣货单");
  const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
  const fileName = exportFileName(group);
  const fileID = (await cloud.uploadFile({ cloudPath: exportPath(fileName), fileContent: buffer })).fileID;
  const fileUrl = await tempUrl(fileID);
  await logAdminOperation({
    operator: admin,
    action: "shipment:export",
    resourceType: "shipment_group",
    resourceId: group._id,
    beforeData: null,
    afterData: { shipmentNo: group.shipmentNo, totalRows: rows.length },
    description: "Export merge shipment picking list"
  });
  return { fileID, fileUrl, fileName, totalRows: rows.length };
}

const handlers = {
  checkMergeShipmentEligibility,
  createMergeShipment,
  getAdminShipmentGroups,
  getShipmentGroupDetail,
  updateShipmentInfo,
  confirmShipment,
  cancelMergeShipment,
  completeShipment,
  exportShipmentPickingList
};

exports.main = async (event = {}) => {
  const action = event.action || WRAPPER_ACTIONS[event._functionName] || "";
  const handler = handlers[action];
  if (!handler) return fail("未知合并发货操作");
  try {
    return ok(await handler(event));
  } catch (err) {
    const idempotencyError = idempotencyErrorResponse(err);
    if (idempotencyError) return idempotencyError;
    return fail(err.message || "合并发货操作失败", err.code);
  }
};
