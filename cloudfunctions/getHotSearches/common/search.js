const MAX_SEARCH_KEYWORD_LENGTH = 30;

function toHalfWidth(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ");
}

function trimKeyword(keyword) {
  return toHalfWidth(keyword).replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_KEYWORD_LENGTH);
}

function isSensitiveKeyword(keyword) {
  const text = trimKeyword(keyword);
  if (!text) return false;
  if (/^1[3-9]\d{9}$/.test(text.replace(/\s+/g, ""))) return true;
  if (/^\d{8,}$/.test(text.replace(/\s+/g, ""))) return true;
  return /(小区|街道|门牌|身份证|手机号|电话|地址)/.test(text);
}

module.exports = {
  trimKeyword,
  isSensitiveKeyword
};
