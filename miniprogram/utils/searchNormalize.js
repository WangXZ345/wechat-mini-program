function toHalfWidth(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ");
}

function normalizeDateText(text) {
  return text
    .replace(/(20\d{2})\s*[年./-]\s*(\d{1,2})\s*(?:月)?/g, (all, year, month) => `${year}-${String(month).padStart(2, "0")}`)
    .replace(/(20\d{2})-(\d{1,2})-(\d{1,2})/g, (all, year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

function normalizeSearchText(text) {
  return normalizeDateText(toHalfWidth(text))
    .toLowerCase()
    .replace(/毫升/g, "ml")
    .replace(/(\d+(?:\.\d+)?)\s*m\s*l\b/g, "$1ml")
    .replace(/[，、。；;:：|/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildProductSearchText(product = {}) {
  const keywords = Array.isArray(product.keywords) ? product.keywords.join(" ") : product.keywords || "";
  return normalizeSearchText([
    product.name,
    product.baseName,
    product.specification,
    product.productionDate,
    product.description,
    keywords,
    product.productIndex,
    product.skuCode
  ].filter(Boolean).join(" "));
}

module.exports = {
  normalizeSearchText,
  buildProductSearchText
};
