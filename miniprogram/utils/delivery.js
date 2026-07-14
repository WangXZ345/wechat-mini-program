const DELIVERY_TYPE_TEXT = {
  self_pickup: "到店自提",
  shipping: "快递配送"
};

const DELIVERY_STATUS_TEXT = {
  pending: "待处理",
  waiting_pickup: "待自提",
  picked_up: "已自提",
  waiting_shipping: "待发货",
  shipped: "已发货",
  completed: "已完成",
  after_sales: "售后中"
};

const DELIVERY_TYPE_OPTIONS = [
  { label: "快递配送", value: "shipping" },
  { label: "到店自提", value: "self_pickup" }
];

const EMPTY_SHIPPING_ADDRESS = {
  receiverName: "",
  receiverPhone: "",
  province: "",
  city: "",
  district: "",
  detailAddress: "",
  fullAddress: "",
  remark: ""
};

function buildFullAddress(address = {}) {
  return [
    address.province,
    address.city,
    address.district,
    address.detailAddress
  ].filter(Boolean).join("");
}

function formatDateTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + " " + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0")
  ].join(":");
}

function normalizeShippingAddress(address = {}) {
  const next = {
    ...EMPTY_SHIPPING_ADDRESS,
    ...address
  };
  next.fullAddress = next.fullAddress || buildFullAddress(next);
  return next;
}

module.exports = {
  DELIVERY_TYPE_TEXT,
  DELIVERY_STATUS_TEXT,
  DELIVERY_TYPE_OPTIONS,
  EMPTY_SHIPPING_ADDRESS,
  buildFullAddress,
  formatDateTime,
  normalizeShippingAddress
};
