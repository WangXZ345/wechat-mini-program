"use strict";

const CUSTOMER_FILTER_LIMITS = Object.freeze({ keyword: 64, statuses: 10, batch: 50, scan: 500 });
const ORDER_STAGE_VALUES = new Set(["all", "review", "payment", "confirm", "shipping", "done"]);
const PAYMENT_FILTER_GROUPS = Object.freeze({
  unpaid: ["", "none", "unpaid"],
  pending_confirm: ["pending_confirm"],
  partial_paid: ["partial", "partial_paid"],
  paid: ["paid"],
  abnormal: ["abnormal"],
  refunded: ["refunded"]
});
const DELIVERY_FILTER_VALUES = new Set([
  "pending",
  "waiting_pickup",
  "picked_up",
  "waiting_shipping",
  "shipped",
  "completed",
  "after_sales"
]);

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/[，、。；;:：|/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function invalidCustomerFilter(message) {
  const error = new Error(message);
  error.code = "INVALID_ORDER_FILTERS";
  return error;
}

function uniqueLimited(values, allowed, label) {
  const input = Array.isArray(values) ? values : [];
  if (input.length > CUSTOMER_FILTER_LIMITS.statuses) {
    throw invalidCustomerFilter(`${label}最多选择 ${CUSTOMER_FILTER_LIMITS.statuses} 项`);
  }
  return Array.from(new Set(input.filter((value) => allowed.has(value))));
}

function parseCustomerFilterDate(value, label) {
  if (!value) return null;
  const parsed = toDate(value);
  if (!parsed || Number.isNaN(parsed.getTime())) throw invalidCustomerFilter(`${label}无效`);
  return parsed;
}

function normalizeCustomerFilters(input = {}) {
  const rawKeyword = String(input.keyword || "").trim();
  if (rawKeyword.length > CUSTOMER_FILTER_LIMITS.keyword) {
    throw invalidCustomerFilter(`关键词不能超过 ${CUSTOMER_FILTER_LIMITS.keyword} 个字符`);
  }
  const startDate = parseCustomerFilterDate(input.startDate, "开始日期");
  const endDate = parseCustomerFilterDate(input.endDate, "结束日期");
  if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
    throw invalidCustomerFilter("开始日期不能晚于结束日期");
  }
  const requestedStage = String(input.orderStage || "all");
  return {
    orderStage: ORDER_STAGE_VALUES.has(requestedStage) ? requestedStage : "all",
    startDate,
    endDate,
    includeCancelled: input.includeCancelled === true,
    paymentStatuses: uniqueLimited(input.paymentStatuses, new Set(Object.keys(PAYMENT_FILTER_GROUPS)), "付款状态"),
    deliveryStatuses: uniqueLimited(input.deliveryStatuses, DELIVERY_FILTER_VALUES, "配送状态"),
    keyword: normalizeSearchText(rawKeyword)
  };
}

function normalizeDeliveryStatus(order = {}) {
  const raw = (order.shipmentDisplay && order.shipmentDisplay.shippingStatus)
    || order.shippingStatus
    || order.deliveryStatus
    || "pending";
  if (raw === "abnormal" && order.deliveryStatus === "after_sales") return "after_sales";
  if (["created", "pending_shipment", "waiting_shipping"].includes(raw)) return "waiting_shipping";
  if (raw === "abnormal") return "abnormal";
  return DELIVERY_FILTER_VALUES.has(raw) ? raw : "pending";
}

function deriveOrderStage(order = {}) {
  const status = order.status || "";
  const paymentStatus = order.paymentStatus || "";
  const shippingStatus = normalizeDeliveryStatus(order);
  if (["pending_system", "auto_reviewing", "pending_admin"].includes(status)) return "review";
  if (["approved_pending_payment", "unpaid"].includes(status) || ["none", "unpaid"].includes(paymentStatus)) return "payment";
  if (status === "pending_payment_confirm" || ["pending_confirm", "partial", "partial_paid", "abnormal"].includes(paymentStatus)) return "confirm";
  if (["waiting_shipping", "shipped"].includes(shippingStatus) || status === "paid") return "shipping";
  if (status === "completed" || shippingStatus === "completed") return "done";
  return "all";
}

function matchesCustomerFilters(order = {}, itemSummary = null, filters = normalizeCustomerFilters()) {
  if (order.status === "cancelled" && filters.includeCancelled !== true) return false;
  if (filters.orderStage !== "all" && deriveOrderStage(order) !== filters.orderStage) return false;
  if (filters.paymentStatuses.length) {
    const raw = order.paymentStatus || "";
    if (!filters.paymentStatuses.some((group) => PAYMENT_FILTER_GROUPS[group].includes(raw))) return false;
  }
  if (filters.deliveryStatuses.length && !filters.deliveryStatuses.includes(normalizeDeliveryStatus(order))) return false;
  if (filters.keyword) {
    const productNames = ((itemSummary && itemSummary.items) || []).map((item) => item.productName || "");
    const text = normalizeSearchText([order.orderNo || "", order.productName || "", ...productNames].join(" "));
    if (!text.includes(filters.keyword)) return false;
  }
  return true;
}

module.exports = {
  CUSTOMER_FILTER_LIMITS,
  normalizeSearchText,
  toDate,
  normalizeCustomerFilters,
  normalizeDeliveryStatus,
  deriveOrderStage,
  matchesCustomerFilters
};
