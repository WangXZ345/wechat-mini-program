function decodeXml(text = "") {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function normalizeText(text = "") {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDocxLinesFromXml(xml = "") {
  const paragraphs = xml.match(/<w:p[\s\S]*?<\/w:p>/g) || [];
  return paragraphs
    .map((paragraph) => {
      const parts = [];
      const prepared = paragraph.replace(/<w:tab\s*\/>/g, " ");
      const textRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
      let match;
      while ((match = textRe.exec(prepared))) {
        parts.push(decodeXml(match[1]));
      }
      return normalizeText(parts.join(""));
    })
    .filter(Boolean);
}

async function extractDocxLines(buffer) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = zip.file("word/document.xml");
  if (!documentXml) throw new Error("报价单不是有效的 Word 文档");
  return extractDocxLinesFromXml(await documentXml.async("string"));
}

function parsePriceToCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

function parseQuoteLines(lines = []) {
  const entries = [];
  const priceLineRe = /^(.*?\S)\s+(\d+(?:\.\d{1,2})?)\s*$/;
  lines.forEach((line, index) => {
    const text = normalizeText(line);
    const match = text.match(priceLineRe);
    if (!match) return;
    const priceCents = parsePriceToCents(match[2]);
    const name = normalizeText(match[1]);
    if (!name || !Number.isInteger(priceCents)) return;
    entries.push({
      name,
      priceCents,
      sourceLine: text,
      lineNo: index + 1,
      normalizedName: normalizeForMatch(name)
    });
  });
  return entries;
}

async function parseQuoteDocx(buffer) {
  const lines = await extractDocxLines(buffer);
  return parseQuoteLines(lines);
}

function normalizeForMatch(value = "") {
  let text = normalizeText(value).toLowerCase();
  text = text
    .replace(/(?:20)?\d{2}\s*年\s*\d{1,2}\s*月?/g, " ")
    .replace(/(?:20)?\d{2}\s*年/g, " ")
    .replace(/批号尾数\s*\d+/g, " ")
    .replace(/新日期|日期/g, " ")
    .replace(/毫升/g, "ml");
  text = text
    .replace(/^[a-z]\s*\d+(?:\s*-\s*\d+)*\s*/i, " ")
    .replace(/(?:20)?\d{2}\s*年\s*\d{1,2}\s*月?/g, " ")
    .replace(/(?:20)?\d{2}\s*年/g, " ")
    .replace(/\b\d{2}\.\d{1,2}\b/g, " ")
    .replace(/批号尾数\s*\d+/g, " ")
    .replace(/新日期|日期/g, " ")
    .replace(/毫升/g, "ml");

  return text
    .split("")
    .filter((ch) => /[a-z0-9]/i.test(ch) || /[\u4e00-\u9fff]/.test(ch))
    .join("");
}

function bigrams(value) {
  const chars = String(value || "");
  const result = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    result.push(chars.slice(i, i + 2));
  }
  return result;
}

function matchTokens(value) {
  const text = String(value || "");
  const tokens = new Set();
  (text.match(/\d+(?:\.\d+)?[a-z]*/gi) || []).forEach((token) => tokens.add(token));
  bigrams(text).forEach((token) => tokens.add(token));
  for (let i = 0; i < text.length - 2; i += 1) {
    tokens.add(text.slice(i, i + 3));
  }
  return Array.from(tokens).filter((token) => token.length >= 2);
}

function createMatchIndex(records = [], normalizeRecord) {
  const items = records
    .map((record, index) => {
      const normalizedName = normalizeRecord(record);
      return {
        record,
        index,
        normalizedName,
        tokens: matchTokens(normalizedName)
      };
    })
    .filter((item) => item.normalizedName);
  const byToken = {};
  items.forEach((item, itemPosition) => {
    item.tokens.forEach((token) => {
      if (!byToken[token]) byToken[token] = [];
      byToken[token].push(itemPosition);
    });
  });
  return { records, items, byToken };
}

function getCandidateItems(index, targets = [], limit = 80) {
  if (!index || !index.items || !index.items.length) return [];
  const scoreByIndex = {};
  targets.forEach((target) => {
    matchTokens(target).forEach((token) => {
      (index.byToken[token] || []).forEach((itemIndex) => {
        scoreByIndex[itemIndex] = (scoreByIndex[itemIndex] || 0) + 1;
      });
    });
  });

  const ranked = Object.keys(scoreByIndex)
    .map((key) => ({ item: index.items[Number(key)], hits: scoreByIndex[key] }))
    .filter((entry) => entry.item)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((entry) => entry.item);

  if (ranked.length) return ranked;
  return index.items.slice(0, Math.min(limit, index.items.length));
}

function overlapCount(a, b) {
  const map = new Map();
  a.forEach((item) => map.set(item, (map.get(item) || 0) + 1));
  let count = 0;
  b.forEach((item) => {
    const current = map.get(item) || 0;
    if (current > 0) {
      count += 1;
      map.set(item, current - 1);
    }
  });
  return count;
}

function numberScore(a, b) {
  const aNums = new Set(String(a || "").match(/\d+(?:\.\d+)?/g) || []);
  const bNums = new Set(String(b || "").match(/\d+(?:\.\d+)?/g) || []);
  const union = new Set([...aNums, ...bNums]);
  if (!union.size) return 0.5;
  let same = 0;
  union.forEach((num) => {
    if (aNums.has(num) && bNums.has(num)) same += 1;
  });
  return same / union.size;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const short = a.length <= b.length ? a : b;
  const long = a.length > b.length ? a : b;
  if (short && long.includes(short)) {
    return Math.min(0.98, short.length / long.length + 0.18);
  }

  const charsA = a.split("");
  const charsB = b.split("");
  const charDice = (2 * overlapCount(charsA, charsB)) / (charsA.length + charsB.length);
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  const bigramDice = bigramsA.length && bigramsB.length
    ? (2 * overlapCount(bigramsA, bigramsB)) / (bigramsA.length + bigramsB.length)
    : 0;

  return (0.62 * charDice) + (0.28 * bigramDice) + (0.10 * numberScore(a, b));
}

function createQuoteMatcher(quoteEntries = []) {
  return createMatchIndex(quoteEntries, (entry) => entry.normalizedName || normalizeForMatch(entry.name));
}

function matchQuotePrice(item = {}, quoteSource = []) {
  const quoteIndex = Array.isArray(quoteSource) ? createQuoteMatcher(quoteSource) : quoteSource;
  if (!quoteIndex || !quoteIndex.items || !quoteIndex.items.length) return null;
  const targets = [
    item.rawName,
    [item.baseName, item.specification].filter(Boolean).join(" "),
    item.baseName
  ].map(normalizeForMatch).filter(Boolean);
  if (!targets.length) return null;

  const scored = getCandidateItems(quoteIndex, targets)
    .map((entry) => ({
      entry: entry.record,
      score: Math.max(...targets.map((target) => similarity(target, entry.normalizedName)))
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const secondScore = scored[1] ? scored[1].score : 0;
  if (!best || best.score < 0.72 || best.score - secondScore < 0.04) return null;

  return {
    price: best.entry.priceCents,
    quoteMatchedName: best.entry.name,
    quoteMatchScore: Number(best.score.toFixed(2)),
    quoteSourceLine: best.entry.sourceLine,
    quoteLineNo: best.entry.lineNo
  };
}

module.exports = {
  extractDocxLinesFromXml,
  parseQuoteLines,
  parseQuoteDocx,
  normalizeForMatch,
  similarity,
  createMatchIndex,
  getCandidateItems,
  createQuoteMatcher,
  matchQuotePrice
};
