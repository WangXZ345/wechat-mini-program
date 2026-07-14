function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatMoney(fen) {
  const value = Number(fen || 0) / 100;
  const sign = value < 0 ? "-" : "";
  const fixed = Math.abs(value).toFixed(2);
  const parts = fixed.split(".");
  const integer = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}￥${integer}.${parts[1]}`;
}

function formatMoneyPlain(fen) {
  return formatMoney(fen).replace("￥", "");
}

function formatDate(value) {
  const date = toDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return "";
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatProductionDate(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}$/.test(text) || /^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return formatDate(value);
}

function formatCount(count) {
  const value = Number(count || 0);
  return Number.isFinite(value) ? String(value) : "0";
}

module.exports = {
  formatMoney,
  formatMoneyPlain,
  formatDate,
  formatDateTime,
  formatProductionDate,
  formatCount
};
