const MAX_SEARCH_KEYWORD_LENGTH = 30;

function toHalfWidth(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ");
}

function trimKeyword(keyword) {
  return toHalfWidth(keyword).replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_KEYWORD_LENGTH);
}

function normalizeKeyword(keyword) {
  return trimKeyword(keyword).toLowerCase().replace(/\s+/g, "");
}

function isValidSearchKeyword(keyword) {
  const text = trimKeyword(keyword);
  if (!text) return false;
  if (text.length > MAX_SEARCH_KEYWORD_LENGTH) return false;
  return /[\u4e00-\u9fa5a-zA-Z0-9]/.test(text);
}

function isSensitiveKeyword(keyword) {
  const text = trimKeyword(keyword);
  if (!text) return false;
  if (/^1[3-9]\d{9}$/.test(text.replace(/\s+/g, ""))) return true;
  if (/^\d{8,}$/.test(text.replace(/\s+/g, ""))) return true;
  return /(小区|街道|门牌|身份证|手机号|电话|地址)/.test(text);
}

function uniqueClean(values = []) {
  const list = Array.isArray(values) ? values : String(values || "").split(/[,，、\s/;；|]+/);
  return Array.from(new Set(list.map((item) => trimKeyword(item)).filter(Boolean)));
}

function buildSuggestionKeyword(product = {}) {
  const tags = uniqueClean(product.tags || []);
  const specs = [product.specification, product.productionDate].filter(Boolean);
  const mixed = [];
  if (product.brand && product.specification) mixed.push(`${product.brand} ${product.specification}`);
  return [
    { type: "product", keyword: product.name, productId: product._id },
    { type: "brand", keyword: product.brand },
    { type: "category", keyword: product.category },
    ...specs.map((keyword) => ({ type: "spec", keyword })),
    ...mixed.map((keyword) => ({ type: "spec", keyword })),
    ...tags.map((keyword) => ({ type: "tag", keyword }))
  ].map((item) => ({ ...item, keyword: trimKeyword(item.keyword) })).filter((item) => item.keyword);
}

module.exports = {
  MAX_SEARCH_KEYWORD_LENGTH,
  trimKeyword,
  normalizeKeyword,
  isValidSearchKeyword,
  isSensitiveKeyword,
  buildSuggestionKeyword
};
