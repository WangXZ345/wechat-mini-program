const BRAND_ALIASES = [
  ["雅诗兰黛", ["雅诗兰黛", "estee lauder", "el"]],
  ["兰蔻", ["兰蔻", "lancome"]],
  ["香奈儿", ["香奈儿", "chanel"]],
  ["迪奥", ["迪奥", "dior"]],
  ["古驰", ["古驰", "gucci"]],
  ["圣罗兰", ["圣罗兰", "ysl", "yves saint laurent"]],
  ["爱马仕", ["爱马仕", "hermes"]],
  ["范思哲", ["范思哲", "versace"]],
  ["普拉达", ["普拉达", "prada"]],
  ["SK-II", ["sk-ii", "skii", "sk2", "神仙水"]],
  ["娇兰", ["娇兰", "guerlain"]],
  ["倩碧", ["倩碧", "clinique"]],
  ["海蓝之谜", ["海蓝之谜", "lamer", "la mer"]],
  ["资生堂", ["资生堂", "shiseido"]]
];

function toHalfWidth(text = "") {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ");
}

function normalizeText(text = "") {
  return toHalfWidth(text)
    .replace(/\u00a0/g, " ")
    .replace(/[，、。；;:：|/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\b毫升\b/gi, "ml")
    .replace(/毫升/g, "ml")
    .replace(/克/g, "g")
    .replace(/(\d+(?:\.\d+)?)\s*m\s*l\b/gi, "$1ml")
    .replace(/(\d+(?:\.\d+)?)\s*g\b/gi, "$1g")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForMatch(text = "") {
  return normalizeText(text)
    .toLowerCase()
    .replace(/生产日期|日期|库存|数量|现货|报价|价格|售价|批发价|客户价|主辅数量/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year)) return "";
  return String(year < 100 ? 2000 + year : year);
}

function extractSpecification(text = "") {
  const source = normalizeText(text);
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(ml|g)\b/i,
    /(\d+(?:\.\d+)?)\s*(片装|片|支装|支|瓶装|瓶|套装|套)\b/i,
    /(\d{2,3})\s*(?=淡香|浓香|edt|edp)/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      const unit = match[2] ? match[2].toLowerCase() : "ml";
      return { value: `${match[1]}${unit}`, raw: match[0] };
    }
  }
  return { value: "", raw: "" };
}

function extractProductionDate(text = "") {
  const source = normalizeText(text);
  const full = source.match(/((?:20)?\d{2})\s*(?:年|-|\/|\.)\s*(\d{1,2})\s*(?:月|-|\/|\.)\s*(\d{1,2})\s*(?:日)?/);
  if (full) {
    const year = normalizeYear(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { value: `${year}-${pad2(month)}-${pad2(day)}`, raw: full[0], warning: "" };
    }
  }

  const ym = source.match(/((?:20)?\d{2})\s*(?:年|-|\/|\.)\s*(\d{1,2})\s*(?:月)?/);
  if (ym) {
    const year = normalizeYear(ym[1]);
    const month = Number(ym[2]);
    if (month >= 1 && month <= 12) {
      return { value: `${year}-${pad2(month)}`, raw: ym[0], warning: "" };
    }
  }

  const compact = source.match(/\b((?:20)?\d{2})(0[1-9]|1[0-2])\b/);
  if (compact) {
    return {
      value: `${normalizeYear(compact[1])}-${compact[2]}`,
      raw: compact[0],
      warning: compact[1].length === 2 ? "识别到两位年份，请确认生产日期" : ""
    };
  }

  const yearOnly = source.match(/\b((?:20)?\d{2})\s*年\b/);
  if (yearOnly) {
    return {
      value: normalizeYear(yearOnly[1]),
      raw: yearOnly[0],
      warning: "只识别到年份，请在预览页确认生产月份"
    };
  }

  return { value: "", raw: "", warning: "" };
}

function extractStock(text = "") {
  const source = normalizeText(text);
  const patterns = [
    /(?:库存|数量|现货|主辅数量)\s*[:：]?\s*(-?\d+)/i,
    /(?:^|\s)x\s*(-?\d+)(?:\s|$)/i,
    /(?:^|\s)\*\s*(-?\d+)(?:\s|$)/,
    /(-?\d+)\s*(?:个|件|瓶|支|盒|套|包)\s*$/i,
    /(?:^|\s)(-?\d+)\s*$/
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return { value: Number(match[1]), raw: match[0] };
  }
  return { value: null, raw: "" };
}

function parsePriceToCents(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value * 100);
  }
  const text = normalizeText(value).replace(/[￥¥$,]/g, "");
  const match = text.match(/(?:价格|报价|售价|批发价|客户价|单价)?\s*(-?\d+(?:\.\d{1,2})?)\s*$/);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

function extractPrice(text = "") {
  const source = normalizeText(text).replace(/[￥¥$,]/g, "");
  const explicit = source.match(/(?:价格|报价|售价|批发价|客户价|单价)\s*[:：]?\s*(-?\d+(?:\.\d{1,2})?)\b/i);
  const trailing = source.match(/\s(-?\d+(?:\.\d{1,2})?)\s*$/);
  const match = explicit || trailing;
  if (!match) return { value: null, raw: "" };
  const cents = parsePriceToCents(match[1]);
  return { value: cents, raw: match[0] };
}

function cleanBaseName(text = "") {
  let cleaned = normalizeForMatch(text);
  const spec = extractSpecification(cleaned);
  const date = extractProductionDate(cleaned);
  const stock = extractStock(cleaned);
  const price = extractPrice(cleaned);
  [spec.raw, date.raw, stock.raw, price.raw].filter(Boolean).forEach((part) => {
    cleaned = cleaned.replace(part, " ");
  });
  return cleaned
    .replace(/^[a-z]\s*\d+(?:\s*-\s*\d+)*\s*/i, " ")
    .replace(/生产日期|日期|库存|数量|现货|报价|价格|售价|主辅数量/g, " ")
    .replace(/批号尾数\s*\d+/g, " ")
    .replace(/批号|尾数/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBrand(text = "") {
  const normalized = normalizeForMatch(text).toLowerCase().replace(/\s+/g, "");
  for (const [brand, aliases] of BRAND_ALIASES) {
    if (aliases.some((alias) => normalized.includes(alias.toLowerCase().replace(/\s+/g, "")))) return brand;
  }
  return "";
}

function inferCategory(text = "") {
  const value = normalizeForMatch(text);
  if (/香水|淡香|浓香|edt|edp/i.test(value)) return "香水";
  if (/面霜|乳液|精华|水|爽肤|粉水|蓝水|洁面|眼霜|口红|粉底|唇膏/.test(value)) return "护肤/美妆";
  return "";
}

function buildMatchKey(product = {}) {
  const index = String(product.productIndex || product.skuCode || "").trim().toLowerCase();
  if (index) return `idx:${index}`;
  const baseName = normalizeForMatch(product.baseName || product.finalName || product.name || "");
  const spec = normalizeForMatch(product.specification || "");
  const date = String(product.productionDate || "").trim();
  return [baseName, spec, date].filter(Boolean).join("|");
}

function buildSearchText(product = {}) {
  return normalizeForMatch([
    product.name,
    product.finalName,
    product.baseName,
    product.brand,
    product.category,
    product.specification,
    product.productionDate,
    product.productIndex,
    product.skuCode,
    Array.isArray(product.keywords) ? product.keywords.join(" ") : product.keywords
  ].filter(Boolean).join(" "));
}

module.exports = {
  normalizeText,
  normalizeForMatch,
  extractSpecification,
  extractProductionDate,
  extractStock,
  extractPrice,
  parsePriceToCents,
  cleanBaseName,
  extractBrand,
  inferCategory,
  buildMatchKey,
  buildSearchText
};
