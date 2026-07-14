const SPEC_RE = /(\d+(?:\.\d+)?)\s*(ml|毫升|g|克)/i;
const STOCK_PATTERNS = [
  /(?:库存|数量|现货)\s*[:：]?\s*(-?\d+)/i,
  /(?:^|\s)x\s*(-?\d+)(?:\s|$)/i,
  /(-?\d+)\s*(?:瓶|件|盒|个|支|套|包)(?:\s|$)/i
];

function normalizeText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .replace(/[()（）【】[\]{}]/g, " ")
    .replace(/[，、。；;：:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year)) return "";
  return year < 100 ? String(2000 + year) : String(year);
}

function validMonth(month) {
  const n = Number(month);
  return Number.isInteger(n) && n >= 1 && n <= 12;
}

function validDay(day) {
  const n = Number(day);
  return Number.isInteger(n) && n >= 1 && n <= 31;
}

function extractSpecification(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(SPEC_RE);
  if (!match) return { value: "", raw: "" };
  const unit = match[2].toLowerCase() === "ml" || match[2] === "毫升" ? "ml" : "g";
  return { value: `${match[1]}${unit}`, raw: match[0] };
}

function extractProductionDate(text) {
  const normalized = normalizeText(text);
  const prefix = "(?:生产日期|生产日|日期|效期|批次)?\\s*";
  const ymd = new RegExp(`${prefix}((?:20)?\\d{2})\\s*(?:年|[-/.])?\\s*(\\d{1,2})\\s*月?(?:\\s*(?:日|[-/.])?\\s*(\\d{1,2})\\s*日?)?`);
  const match = normalized.match(ymd);
  if (!match || !validMonth(match[2])) return { value: "", raw: "" };
  const year = normalizeYear(match[1]);
  if (match[3] && validDay(match[3])) {
    return { value: `${year}-${pad2(match[2])}-${pad2(match[3])}`, raw: match[0] };
  }
  return { value: `${year}-${pad2(match[2])}`, raw: match[0] };
}

function extractStock(text) {
  const normalized = normalizeText(text);
  for (const pattern of STOCK_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) return { value: Number(match[1]), raw: match[0] };
  }
  const trailing = normalized.match(/(?:^|\s)(-?\d+)\s*$/);
  if (trailing) return { value: Number(trailing[1]), raw: trailing[0] };
  return { value: null, raw: "" };
}

function cleanBaseName(text) {
  let cleaned = normalizeText(text);
  const spec = extractSpecification(cleaned);
  const date = extractProductionDate(cleaned);
  const stock = extractStock(cleaned);

  [spec.raw, date.raw, stock.raw].filter(Boolean).forEach((part) => {
    cleaned = cleaned.replace(part, " ");
  });

  cleaned = cleaned
    .replace(/^[a-z]\s*\d+(?:\s*-\s*\d+)*\s*/i, " ")
    .replace(/(?:生产日期|生产日|日期|效期|批次|库存|数量|现货)\s*[:：]?/g, " ")
    .replace(/(?:20)?\d{2}\s*年\s*\d{1,2}\s*月?/g, " ")
    .replace(/(?:20)?\d{2}\s*年/g, " ")
    .replace(/批号尾数\s*\d+/g, " ")
    .replace(/新日期/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned;
}

function parseInventoryLine(line) {
  const rawName = normalizeText(line);
  const stock = extractStock(rawName);
  const spec = extractSpecification(rawName);
  const date = extractProductionDate(rawName);
  const baseName = cleanBaseName(rawName);
  let errorMessage = "";

  if (!rawName) errorMessage = "空行";
  else if (!baseName) errorMessage = "商品名称为空";
  else if (stock.value === null) errorMessage = "无法识别库存";
  else if (!Number.isInteger(stock.value)) errorMessage = "库存不是整数";
  else if (stock.value < 0) errorMessage = "库存不能小于 0";

  return {
    rawName,
    baseName,
    specification: spec.value,
    productionDate: date.value,
    stock: stock.value,
    errorMessage
  };
}

module.exports = {
  normalizeText,
  extractSpecification,
  extractProductionDate,
  extractStock,
  cleanBaseName,
  parseInventoryLine
};
