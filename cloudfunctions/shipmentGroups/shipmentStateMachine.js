"use strict";

const SHIPMENT_STATUSES = Object.freeze([
  "created",
  "pending_shipment",
  "shipped",
  "completed",
  "cancelled",
  "abnormal"
]);

const STATUS_SET = new Set(SHIPMENT_STATUSES);
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "abnormal"]);
const APPROVED_ORDER_STATUSES = new Set([
  "approved",
  "paid",
  "pending_payment_confirm",
  "partial_paid",
  "unpaid",
  "pending_shipment",
  "payment_confirmed",
  "approved_pending_payment"
]);
const ACTIVE_BINDING_STATUSES = new Set(["created", "pending_shipment", "shipped", "completed", "abnormal"]);

function command(definition) {
  return Object.freeze({
    ...definition,
    roles: Object.freeze(["super_admin", "customer_service"]),
    permissions: Object.freeze(definition.permissions.slice()),
    transitions: Object.freeze({ ...definition.transitions })
  });
}

const SHIPMENT_COMMANDS = Object.freeze({
  ship_single_order: command({
    entity: "order",
    permissions: ["shipment:ship", "order:ship"],
    transitions: { pending_shipment: "shipped" },
    requiresLogistics: true,
    requiresPayment: true
  }),
  add_orders_to_merge: command({
    entity: "orders",
    permissions: ["shipment:merge"],
    transitions: { pending_shipment: "created" },
    requiresMergeValidation: true,
    requiresPayment: true
  }),
  confirm_merge: command({
    entity: "shipment",
    permissions: ["shipment:merge"],
    transitions: { created: "pending_shipment" },
    requiresBinding: true
  }),
  edit_logistics: command({
    entity: "shipment_or_order",
    permissions: ["shipment:update"],
    transitions: { created: "pending_shipment", pending_shipment: "pending_shipment" },
    requiresBindingWhenShipment: true
  }),
  cancel_pending: command({
    entity: "shipment_or_order",
    permissions: ["shipment:cancel"],
    transitions: { created: "cancelled", pending_shipment: "cancelled" },
    requiresBindingWhenShipment: true
  }),
  confirm_shipment: command({
    entity: "shipment",
    permissions: ["shipment:ship"],
    transitions: { created: "shipped", pending_shipment: "shipped" },
    requiresLogistics: true,
    requiresPayment: true,
    requiresBinding: true
  }),
  complete_shipment: command({
    entity: "shipment_or_order",
    permissions: ["shipment:complete"],
    transitions: { shipped: "completed" },
    requiresBindingWhenShipment: true
  })
});

class ShipmentTransitionError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "ShipmentTransitionError";
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, statusCode = 400, details) {
  throw new ShipmentTransitionError(code, message, statusCode, details);
}

function cleanText(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function entityId(entity = {}) {
  return cleanText(entity._id || entity.id, 128);
}

function legacyStatus(entity) {
  if (entity.deliveryStatus === "shipped") return "shipped";
  if (entity.deliveryStatus === "completed") return "completed";
  if (entity.deliveryStatus === "after_sales") return "abnormal";
  if (entity.deliveryStatus && entity.deliveryStatus !== "waiting_shipping") return null;
  const orderStatus = cleanText(entity.status, 50);
  if (APPROVED_ORDER_STATUSES.has(orderStatus) || entity.deliveryStatus === "waiting_shipping") {
    return "pending_shipment";
  }
  return null;
}

function explicitLegacyStatus(entity) {
  if (entity.deliveryStatus === "shipped") return "shipped";
  if (entity.deliveryStatus === "completed") return "completed";
  if (entity.deliveryStatus === "after_sales") return "abnormal";
  return null;
}

function normalizeShipmentStatus(entity) {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    fail("SHIPMENT_STATUS_INVALID", "发货状态数据无效", 409);
  }
  const explicit = cleanText(entity.shippingStatus, 50);
  const legacy = legacyStatus(entity);
  if (explicit) {
    if (!STATUS_SET.has(explicit)) fail("SHIPMENT_STATUS_INVALID", "发货状态数据无效", 409);
    const strongLegacy = explicitLegacyStatus(entity);
    if (strongLegacy && strongLegacy !== explicit) fail("SHIPMENT_STATUS_INVALID", "发货状态数据冲突", 409);
    return explicit;
  }
  if (!legacy || !STATUS_SET.has(legacy)) fail("SHIPMENT_STATUS_INVALID", "发货状态数据无效", 409);
  return legacy;
}

function assertActor(actor, metadata) {
  const actorId = actor && cleanText(actor.id || actor._id || actor.openid, 128);
  const role = actor && cleanText(actor.role, 50);
  if (!actorId || !role || actor.status !== "active" || actor.isActive === false) {
    fail("INVALID_ACTOR", "管理员身份无效", 403);
  }
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (!metadata.roles.includes(role)) fail("FORBIDDEN", "无权执行发货操作", 403);
  const matched = metadata.permissions.find((permission) => permissions.includes(permission));
  if (!matched) fail("FORBIDDEN", "无权执行发货操作", 403);
  return { id: actorId, permission: matched };
}

function assertExpectedVersion(value) {
  if (value === undefined || value === null || value === "") {
    fail("EXPECTED_VERSION_REQUIRED", "缺少发货数据版本，请刷新后重试", 400);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("EXPECTED_VERSION_INVALID", "发货数据版本无效，请刷新后重试", 400);
  }
  return value;
}

function versionOf(entity) {
  const value = entity && (entity.version === undefined || entity.version === null || entity.version === "")
    ? 0
    : entity && entity.version;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("DATA_VERSION_CONFLICT", "发货数据版本冲突，请刷新后重试", 409);
  }
  return value;
}

function primaryEntity(input, metadata) {
  if (metadata.entity === "order") return input.order;
  if (metadata.entity === "orders") return input.shipment || (Array.isArray(input.orders) ? input.orders[0] : null);
  if (metadata.entity === "shipment") return input.shipment;
  return input.shipment || input.order;
}

function isApprovedOrder(order) {
  const status = cleanText(order && order.status, 50);
  return APPROVED_ORDER_STATUSES.has(status)
    || (order && order.deliveryStatus === "waiting_shipping");
}

function assertPayment(order, settings = {}) {
  if (!isApprovedOrder(order)) fail("SHIPMENT_ORDER_NOT_APPROVED", "订单尚未完成审核", 409);
  if (settings.requirePaidBeforeShipment === false) return;
  const paymentStatus = order.paymentStatus === "partial" ? "partial_paid" : order.paymentStatus;
  if (paymentStatus === "paid") return;
  if (paymentStatus === "partial_paid" && settings.allowPartialPaidShipment === true) return;
  fail("SHIPMENT_PAYMENT_REQUIRED", "订单付款状态不允许发货", 409);
}

function deliveryTypeOf(order = {}) {
  if (order.shippingType === "pickup" || order.deliveryType === "self_pickup") return "pickup";
  return "delivery";
}

function customerOpenid(order = {}) {
  return cleanText(order.userOpenid || order.openid, 128);
}

function addressKey(order = {}) {
  const address = order.shippingAddressSnapshot || order.shippingAddress;
  if (!address || typeof address !== "object") return "";
  return [
    address.receiverName,
    address.receiverPhone,
    address.receiverPhoneMasked,
    address.regionText,
    address.detailAddress,
    address.fullAddress,
    address.addressTag
  ].map((value) => cleanText(value, 300)).join("|");
}

function assertUniqueOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    fail("SHIPMENT_BINDING_INCONSISTENT", "发货单关联订单数据不一致", 409);
  }
  const ids = orders.map(entityId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    fail("SHIPMENT_ORDER_DUPLICATE", "订单列表包含重复或无效记录", 409);
  }
  return ids;
}

function assertSameCustomer(orders) {
  const userIds = orders.map((order) => cleanText(order && order.userId, 128));
  if (userIds.every(Boolean) && new Set(userIds).size === 1) return;
  const openids = orders.map(customerOpenid);
  if (openids.every(Boolean) && new Set(openids).size === 1) return;
  fail("SHIPMENT_CUSTOMER_MISMATCH", "合并发货订单不属于同一客户", 409);
}

function assertMergeCandidates(orders, settings) {
  assertUniqueOrders(orders);
  assertSameCustomer(orders);
  for (const order of orders) {
    if (deliveryTypeOf(order) === "pickup") fail("SHIPMENT_PICKUP_NOT_ALLOWED", "自提订单不能合并发货", 409);
    const bindingId = cleanText(order.mergeShipmentId || order.shipmentGroupId, 128);
    if (bindingId && cleanText(order.mergeShipmentStatus, 50) !== "cancelled") {
      fail("SHIPMENT_ALREADY_BOUND", "订单已绑定有效发货单", 409);
    }
  }
  if (settings.allowMergeDifferentAddress !== true) {
    const addresses = orders.map(addressKey);
    const nonEmpty = addresses.filter(Boolean);
    if (nonEmpty.length !== 0 && (nonEmpty.length !== addresses.length || new Set(nonEmpty).size !== 1)) {
      fail("SHIPMENT_ADDRESS_MISMATCH", "订单收货地址不一致", 409);
    }
  }
}

function assertShipmentBinding(shipment, orders) {
  const shipmentId = entityId(shipment);
  if (!shipmentId) fail("SHIPMENT_BINDING_INCONSISTENT", "发货单标识无效", 409);
  let orderIds;
  try {
    orderIds = assertUniqueOrders(orders);
  } catch (error) {
    if (error && error.code === "SHIPMENT_ORDER_DUPLICATE") {
      fail("SHIPMENT_BINDING_INCONSISTENT", "发货单关联订单数据不一致", 409);
    }
    throw error;
  }
  const boundIds = Array.isArray(shipment.orderIds) ? shipment.orderIds.map((id) => cleanText(id, 128)) : [];
  if (boundIds.some((id) => !id) || new Set(boundIds).size !== boundIds.length
    || boundIds.length !== orderIds.length || boundIds.some((id) => !orderIds.includes(id))) {
    fail("SHIPMENT_BINDING_INCONSISTENT", "发货单关联订单数据不一致", 409);
  }
  assertSameCustomer([shipment, ...orders]);
  for (const order of orders) {
    const mergeId = cleanText(order.mergeShipmentId, 128);
    const groupId = cleanText(order.shipmentGroupId, 128);
    if ((mergeId && groupId && mergeId !== groupId) || (!mergeId && !groupId) || (mergeId || groupId) !== shipmentId) {
      fail("SHIPMENT_BINDING_INCONSISTENT", "订单发货单绑定不一致", 409);
    }
  }
}

function assertLogistics(logistics = {}) {
  if (!cleanText(logistics.shippingCompany, 80) || !cleanText(logistics.trackingNo, 120)) {
    fail("SHIPMENT_LOGISTICS_REQUIRED", "请填写完整物流信息", 400);
  }
}

function assertShipmentTransition(input = {}) {
  const metadata = SHIPMENT_COMMANDS[input.command];
  if (!metadata) fail("SHIPMENT_COMMAND_INVALID", "发货操作无效", 400);
  const actorResult = assertActor(input.actor, metadata);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  if (metadata.entity === "orders" && !entityId(input.shipment)) {
    fail("SHIPMENT_BINDING_INCONSISTENT", "缺少有效的合并发货单标识", 409);
  }
  const target = primaryEntity(input, metadata);
  if (!target || !entityId(target)) fail("SHIPMENT_BINDING_INCONSISTENT", "发货目标数据无效", 409);
  const currentVersion = versionOf(target);
  if (expectedVersion !== currentVersion) fail("DATA_VERSION_CONFLICT", "发货数据版本冲突，请刷新后重试", 409);
  const fromStatus = metadata.entity === "orders"
    ? normalizeShipmentStatus(input.orders && input.orders[0])
    : normalizeShipmentStatus(target);
  if (TERMINAL_STATUSES.has(fromStatus) || !Object.hasOwn(metadata.transitions, fromStatus)) {
    fail("SHIPMENT_TRANSITION_NOT_ALLOWED", "当前发货状态不允许执行此操作", 409);
  }
  const orders = Array.isArray(input.orders) ? input.orders : input.order ? [input.order] : [];
  if (metadata.entity === "orders") {
    assertMergeCandidates(orders, input.settings || {});
    for (const order of orders) {
      if (versionOf(order) !== expectedVersion) fail("DATA_VERSION_CONFLICT", "订单数据版本冲突，请刷新后重试", 409);
      if (normalizeShipmentStatus(order) !== fromStatus) fail("SHIPMENT_TRANSITION_NOT_ALLOWED", "订单发货状态不一致", 409);
    }
  }
  if (metadata.requiresBinding || (metadata.requiresBindingWhenShipment && input.shipment)) {
    assertShipmentBinding(input.shipment, orders);
    for (const order of orders) {
      if (versionOf(order) !== expectedVersion) fail("DATA_VERSION_CONFLICT", "订单数据版本冲突，请刷新后重试", 409);
    }
  }
  const synchronizedOrderStatus = {
    confirm_merge: "pending_shipment",
    cancel_pending: input.shipment ? "pending_shipment" : null,
    confirm_shipment: "pending_shipment",
    complete_shipment: input.shipment ? "shipped" : null
  }[input.command];
  if (synchronizedOrderStatus && orders.some((order) => normalizeShipmentStatus(order) !== synchronizedOrderStatus)) {
    fail("SHIPMENT_TRANSITION_NOT_ALLOWED", "关联订单发货状态不允许执行此操作", 409);
  }
  if (metadata.requiresPayment) for (const order of orders) assertPayment(order, input.settings || {});
  if (metadata.requiresLogistics) assertLogistics(input.logistics);
  return Object.freeze({
    fromStatus,
    toStatus: metadata.transitions[fromStatus],
    requiredPermission: actorResult.permission,
    actorId: actorResult.id,
    currentVersion
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function logisticsPatch(logistics = {}) {
  const patch = {};
  const shippingCompany = cleanText(logistics.shippingCompany, 80);
  const trackingNo = cleanText(logistics.trackingNo, 120);
  if (shippingCompany) patch.shippingCompany = shippingCompany;
  if (trackingNo) {
    patch.trackingNo = trackingNo;
    patch.trackingNoList = [trackingNo];
  }
  return patch;
}

function orderPatch(order, patch) {
  return { orderId: entityId(order), patch: { ...patch, version: versionOf(order) + 1 } };
}

function buildPatches(input, assertion) {
  const orders = Array.isArray(input.orders) ? input.orders : input.order ? [input.order] : [];
  const common = { updatedBy: assertion.actorId };
  let shipmentPatch = {};
  let orderPatches = [];
  switch (input.command) {
    case "ship_single_order":
      orderPatches = [orderPatch(input.order, { ...common, ...logisticsPatch(input.logistics), shippingStatus: "shipped", deliveryStatus: "shipped" })];
      break;
    case "add_orders_to_merge": {
      const shipmentId = entityId(input.shipment);
      shipmentPatch = { ...common, shippingStatus: "created", version: assertion.currentVersion + 1 };
      orderPatches = orders.map((order) => orderPatch(order, {
        ...common,
        shippingStatus: "pending_shipment",
        mergeShipmentId: shipmentId,
        shipmentGroupId: shipmentId,
        isMergedShipment: true,
        mergeShipmentStatus: "created"
      }));
      break;
    }
    case "confirm_merge":
      shipmentPatch = { ...common, shippingStatus: "pending_shipment", version: assertion.currentVersion + 1 };
      orderPatches = orders.map((order) => orderPatch(order, { ...common, shippingStatus: "pending_shipment", mergeShipmentStatus: "pending_shipment" }));
      break;
    case "edit_logistics": {
      const patch = { ...common, ...logisticsPatch(input.logistics), shippingStatus: assertion.toStatus };
      if (input.shipment) shipmentPatch = { ...patch, version: assertion.currentVersion + 1 };
      else orderPatches = [orderPatch(input.order, patch)];
      break;
    }
    case "cancel_pending":
      if (input.shipment) {
        shipmentPatch = { ...common, shippingStatus: "cancelled", version: assertion.currentVersion + 1 };
        orderPatches = orders.map((order) => orderPatch(order, {
          ...common,
          shippingStatus: "pending_shipment",
          mergeShipmentId: null,
          shipmentGroupId: null,
          isMergedShipment: false,
          mergeShipmentStatus: "cancelled"
        }));
      } else {
        orderPatches = [orderPatch(input.order, { ...common, shippingStatus: "cancelled" })];
      }
      break;
    case "confirm_shipment":
      shipmentPatch = { ...common, ...logisticsPatch(input.logistics), shippingStatus: "shipped", version: assertion.currentVersion + 1 };
      orderPatches = orders.map((order) => orderPatch(order, {
        ...common,
        ...logisticsPatch(input.logistics),
        shippingStatus: "shipped",
        deliveryStatus: "shipped",
        mergeShipmentStatus: "shipped"
      }));
      break;
    case "complete_shipment":
      if (input.shipment) {
        shipmentPatch = { ...common, shippingStatus: "completed", version: assertion.currentVersion + 1 };
        orderPatches = orders.map((order) => orderPatch(order, {
          ...common,
          shippingStatus: "completed",
          deliveryStatus: "completed",
          mergeShipmentStatus: "completed"
        }));
      } else {
        orderPatches = [orderPatch(input.order, { ...common, shippingStatus: "completed", deliveryStatus: "completed" })];
      }
      break;
    default:
      fail("SHIPMENT_COMMAND_INVALID", "发货操作无效", 400);
  }
  return { shipmentPatch, orderPatches };
}

function assertSafeKeys(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/stock|inventory|amount|account|payment|price|debt|balance/i.test(key)) {
      fail("SHIPMENT_PLAN_INVALID", "发货事务计划包含禁止字段", 500);
    }
    assertSafeKeys(child);
  }
}

function planShipmentTransition(input = {}) {
  const assertion = assertShipmentTransition(input);
  const patches = buildPatches(input, assertion);
  const plan = {
    fromStatus: assertion.fromStatus,
    toStatus: assertion.toStatus,
    requiredPermission: assertion.requiredPermission,
    shipmentPatch: patches.shipmentPatch,
    orderPatches: patches.orderPatches
  };
  assertSafeKeys(plan);
  return deepFreeze(plan);
}

module.exports = {
  ShipmentTransitionError,
  SHIPMENT_COMMANDS,
  SHIPMENT_STATUSES,
  normalizeShipmentStatus,
  assertShipmentTransition,
  planShipmentTransition
};
