"use strict";

const PAGE_SIZE = 10;
const TIME_PRESET_VALUES = new Set(["all", "today", "7d", "30d", "custom"]);

const TIME_PRESETS = Object.freeze([
  { value: "all", label: "全部" },
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "custom", label: "自定义" }
]);

const PAYMENT_FILTER_OPTIONS = Object.freeze([
  { value: "unpaid", label: "未付款" },
  { value: "pending_confirm", label: "待确认" },
  { value: "partial_paid", label: "部分付款" },
  { value: "paid", label: "已付款" },
  { value: "abnormal", label: "付款异常" },
  { value: "refunded", label: "已退款" }
]);

const DELIVERY_FILTER_OPTIONS = Object.freeze([
  { value: "pending", label: "待处理" },
  { value: "waiting_pickup", label: "待自提" },
  { value: "picked_up", label: "已自提" },
  { value: "waiting_shipping", label: "待发货" },
  { value: "shipped", label: "已发货" },
  { value: "completed", label: "已完成" },
  { value: "after_sales", label: "售后中" }
]);

function emptyDetailedFilters() {
  return {
    timePreset: "all",
    startDate: "",
    endDate: "",
    paymentStatuses: [],
    deliveryStatuses: []
  };
}

function parseLocalDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ""));
  if (!match) throw new Error("日期无效");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error("日期无效");
  }
  return { year, month, day };
}

function localDateIso(text, endOfDay) {
  const { year, month, day } = parseLocalDate(text);
  return new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0
  ).toISOString();
}

function presetRange(preset, now = new Date()) {
  if (!TIME_PRESET_VALUES.has(preset)) throw new Error("时间范围无效");
  if (preset === "all" || preset === "custom") return { startDate: "", endDate: "" };
  const days = preset === "today" ? 0 : preset === "7d" ? 6 : 29;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function validateDetailedFilters(filters = emptyDetailedFilters()) {
  if (!TIME_PRESET_VALUES.has(filters.timePreset)) throw new Error("时间范围无效");
  if (filters.timePreset !== "custom") return true;
  if (!filters.startDate || !filters.endDate) throw new Error("请选择完整的开始和结束日期");
  const startDate = localDateIso(filters.startDate, false);
  const endDate = localDateIso(filters.endDate, true);
  if (startDate > endDate) throw new Error("开始日期不能晚于结束日期");
  return true;
}

function buildCustomerOrderQuery(data, cursor = "") {
  const appliedFilters = data.appliedFilters || emptyDetailedFilters();
  validateDetailedFilters(appliedFilters);
  const range = appliedFilters.timePreset === "custom"
    ? {
      startDate: localDateIso(appliedFilters.startDate, false),
      endDate: localDateIso(appliedFilters.endDate, true)
    }
    : presetRange(appliedFilters.timePreset);
  return {
    summaryOnly: true,
    pageSize: PAGE_SIZE,
    cursor: cursor || "",
    filters: {
      orderStage: data.activeOrderFilter || "all",
      startDate: range.startDate,
      endDate: range.endDate,
      paymentStatuses: Array.isArray(appliedFilters.paymentStatuses) ? appliedFilters.paymentStatuses.slice() : [],
      deliveryStatuses: Array.isArray(appliedFilters.deliveryStatuses) ? appliedFilters.deliveryStatuses.slice() : [],
      keyword: String(data.searchKeyword || "").trim()
    }
  };
}

function deriveAppliedFilterSummary(filters = emptyDetailedFilters()) {
  const paymentStatuses = Array.isArray(filters.paymentStatuses) ? filters.paymentStatuses : [];
  const deliveryStatuses = Array.isArray(filters.deliveryStatuses) ? filters.deliveryStatuses : [];
  const chips = [];
  if (filters.timePreset !== "all") {
    const preset = TIME_PRESETS.find((item) => item.value === filters.timePreset);
    const label = filters.timePreset === "custom"
      ? `${filters.startDate} 至 ${filters.endDate}`
      : (preset && preset.label) || "时间";
    chips.push({ key: "time", label });
  }
  if (paymentStatuses.length) {
    const selected = PAYMENT_FILTER_OPTIONS.find((item) => item.value === paymentStatuses[0]);
    const label = paymentStatuses.length === 1 ? (selected && selected.label) : `付款 ${paymentStatuses.length} 项`;
    chips.push({ key: "payment", label: label || "付款状态" });
  }
  if (deliveryStatuses.length) {
    const selected = DELIVERY_FILTER_OPTIONS.find((item) => item.value === deliveryStatuses[0]);
    const label = deliveryStatuses.length === 1 ? (selected && selected.label) : `配送 ${deliveryStatuses.length} 项`;
    chips.push({ key: "delivery", label: label || "配送状态" });
  }
  return {
    activeFilterChips: chips,
    activeFilterCount: (filters.timePreset === "all" ? 0 : 1) + paymentStatuses.length + deliveryStatuses.length
  };
}

function dedupeOrders(orders = []) {
  const map = new Map();
  const anonymous = [];
  orders.forEach((order) => {
    const key = order && (order._id || order.orderId);
    if (key) map.set(key, order);
    else anonymous.push(order);
  });
  return Array.from(map.values()).concat(anonymous);
}

module.exports = {
  PAGE_SIZE,
  TIME_PRESETS,
  PAYMENT_FILTER_OPTIONS,
  DELIVERY_FILTER_OPTIONS,
  emptyDetailedFilters,
  localDateIso,
  presetRange,
  validateDetailedFilters,
  buildCustomerOrderQuery,
  deriveAppliedFilterSummary,
  dedupeOrders
};
