const JSZip = require("jszip");
const {
  normalizeText,
  extractSpecification,
  extractProductionDate,
  extractStock,
  extractPrice,
  parsePriceToCents,
  cleanBaseName,
  extractBrand,
  inferCategory
} = require("./productNormalize");

let xlsx;

const NAME_HEADERS = ["商品名称", "品名", "产品名称", "货品名称", "名称", "商品", "productname", "product_name", "name"];
const STOCK_HEADERS = ["库存", "库存数量", "数量", "主辅数量", "现货", "可售库存", "stock", "quantity", "qty"];
const PRICE_HEADERS = ["售价", "报价", "单价", "批发价", "客户价", "价格", "price", "saleprice", "wholesaleprice"];
const BRAND_HEADERS = ["品牌", "brand"];
const CATEGORY_HEADERS = ["品类", "分类", "类别", "category"];
const SPEC_HEADERS = ["规格", "容量", "毫升", "克重", "specification", "spec"];
const DATE_HEADERS = ["生产日期", "日期", "批次", "productiondate", "batchdate"];
const INDEX_HEADERS = ["商品编号", "商品索引", "索引", "sku", "skucode", "productindex", "编码"];
const TAG_HEADERS = ["标签", "商品标签", "前台标签", "tags"];
const INTERNAL_TAG_HEADERS = ["内部标签", "后台标签", "internaltags", "internal_tags"];
const DEFECT_DESCRIPTION_HEADERS = ["瑕疵说明", "瑕疵备注", "瑕疵描述", "defectdescription"];
const FLAG_HEADERS = {
  isNew: ["新货", "是否新货"],
  isDefective: ["瑕疵", "是否瑕疵"],
  isHot: ["热销", "是否热销"]
};
const PUBLIC_TAGS = ["新货", "瑕疵", "热销"];

function fileTypeOf(fileName = "", fileID = "") {
  const source = String(fileName || fileID || "").toLowerCase();
  const match = source.match(/\.([^.?]+)(?:\?|$)/);
  return match ? match[1] : "";
}

function normalizeHeader(value) {
  return normalizeText(value).replace(/\s+/g, "").toLowerCase();
}

function findHeader(headers, candidates) {
  const set = new Set(candidates.map(normalizeHeader));
  return headers.find((header) => set.has(normalizeHeader(header)));
}

function detectHeaderMap(headers, fileRole = "inventory") {
  return {
    name: findHeader(headers, NAME_HEADERS),
    stock: findHeader(headers, STOCK_HEADERS),
    price: findHeader(headers, PRICE_HEADERS),
    brand: findHeader(headers, BRAND_HEADERS),
    category: findHeader(headers, CATEGORY_HEADERS),
    specification: findHeader(headers, SPEC_HEADERS),
    productionDate: findHeader(headers, DATE_HEADERS),
    productIndex: findHeader(headers, INDEX_HEADERS),
    skuCode: findHeader(headers, ["sku", "skucode", "sku_code"]),
    tags: findHeader(headers, TAG_HEADERS),
    internalTags: findHeader(headers, INTERNAL_TAG_HEADERS),
    defectDescription: findHeader(headers, DEFECT_DESCRIPTION_HEADERS),
    isNew: findHeader(headers, FLAG_HEADERS.isNew),
    isDefective: findHeader(headers, FLAG_HEADERS.isDefective),
    isHot: findHeader(headers, FLAG_HEADERS.isHot),
    fileRole
  };
}

function scoreHeaderRow(row = [], fileRole) {
  const headers = row.map((value) => normalizeHeader(value)).filter(Boolean);
  const map = detectHeaderMap(headers, fileRole);
  let score = 0;
  if (map.name) score += 4;
  if (fileRole === "inventory" && map.stock) score += 4;
  if (fileRole === "price" && map.price) score += 4;
  if (map.specification) score += 1;
  if (map.productIndex || map.skuCode) score += 1;
  return score;
}

function rowsFromAoA(aoa = [], fileRole) {
  let headerIndex = 0;
  let bestScore = -1;
  aoa.slice(0, 12).forEach((row, index) => {
    const score = scoreHeaderRow(row, fileRole);
    if (score > bestScore) {
      bestScore = score;
      headerIndex = index;
    }
  });
  const headers = (aoa[headerIndex] || []).map((value, index) => normalizeText(value || `column_${index + 1}`));
  const map = detectHeaderMap(headers, fileRole);
  const rows = aoa.slice(headerIndex + 1)
    .map((row, index) => {
      const record = { rowNo: headerIndex + index + 2 };
      headers.forEach((header, colIndex) => {
        record[header] = row[colIndex];
      });
      return record;
    })
    .filter((row) => headers.some((header) => row[header] !== undefined && row[header] !== null && String(row[header]).trim() !== ""));
  return { rows, headers, headerMap: map, headerRowNo: headerIndex + 1 };
}

function chooseSheet(workbook, fileRole) {
  let best = null;
  workbook.SheetNames.forEach((sheetName) => {
    const aoa = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" });
    const score = Math.max(...aoa.slice(0, 12).map((row) => scoreHeaderRow(row, fileRole)), 0);
    if (!best || score > best.score) best = { sheetName, aoa, score };
  });
  return best;
}

function parseExcelFile(buffer, fileRole = "inventory") {
  xlsx = getXlsx();
  const workbook = xlsx.read(buffer, { type: "buffer", cellDates: false });
  const chosen = chooseSheet(workbook, fileRole);
  if (!chosen || !chosen.aoa.length) throw new Error("Excel 文件没有可解析的数据");
  return { ...rowsFromAoA(chosen.aoa, fileRole), sheetName: chosen.sheetName };
}

function getXlsx() {
  if (!xlsx) xlsx = require("xlsx");
  return xlsx;
}

function columnIndexFromCellRef(ref = "") {
  const letters = String(ref).replace(/[^A-Z]/gi, "").toUpperCase();
  let index = 0;
  for (let i = 0; i < letters.length; i += 1) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(index - 1, 0);
}

function firstXmlText(xml = "", tagName = "") {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`);
  const match = String(xml).match(re);
  return match ? decodeXml(match[1]) : "";
}

function allXmlTexts(xml = "", tagName = "") {
  const values = [];
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "g");
  let match;
  while ((match = re.exec(String(xml)))) values.push(decodeXml(match[1]));
  return values;
}

async function parseSharedStrings(zip) {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) return [];
  const xml = await file.async("string");
  const items = xml.match(/<si[\s\S]*?<\/si>/g) || [];
  return items.map((item) => allXmlTexts(item, "t").join(""));
}

function parseWorksheetRows(xml = "", sharedStrings = []) {
  const rows = [];
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(String(xml)))) {
    const cells = [];
    const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] || "";
      const body = cellMatch[2] || "";
      const ref = (attrs.match(/\sr="([^"]+)"/) || [])[1] || "";
      const type = (attrs.match(/\st="([^"]+)"/) || [])[1] || "";
      const colIndex = columnIndexFromCellRef(ref) || cells.length;
      let value = "";
      if (type === "s") {
        const index = Number(firstXmlText(body, "v"));
        value = Number.isInteger(index) ? (sharedStrings[index] || "") : "";
      } else if (type === "inlineStr") {
        value = allXmlTexts(body, "t").join("");
      } else {
        value = firstXmlText(body, "v");
      }
      cells[colIndex] = normalizeText(value);
    }
    rows.push(cells.map((cell) => (cell === undefined ? "" : cell)));
  }
  return rows;
}

async function parseXlsxFile(buffer, fileRole = "inventory") {
  const zip = await JSZip.loadAsync(buffer);
  const sharedStrings = await parseSharedStrings(zip);
  const sheetFiles = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number((a.match(/sheet(\d+)/i) || [0, 0])[1]) - Number((b.match(/sheet(\d+)/i) || [0, 0])[1]));
  if (!sheetFiles.length) throw new Error("Excel 文件没有可解析的数据");

  let best = null;
  for (const sheetFile of sheetFiles) {
    const xml = await zip.file(sheetFile).async("string");
    const aoa = parseWorksheetRows(xml, sharedStrings);
    const score = Math.max(...aoa.slice(0, 12).map((row) => scoreHeaderRow(row, fileRole)), 0);
    if (!best || score > best.score) best = { sheetName: sheetFile.replace(/^xl\/worksheets\//, ""), aoa, score };
  }
  if (!best || !best.aoa.length) throw new Error("Excel 文件没有可解析的数据");
  return { ...rowsFromAoA(best.aoa, fileRole), sheetName: best.sheetName };
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function parseCsvFile(buffer, fileRole = "inventory") {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const aoa = text.split(/\r?\n/).filter((line) => line.trim()).map(parseCsvLine);
  return rowsFromAoA(aoa, fileRole);
}

function parseTxtFile(buffer, fileRole = "inventory") {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
  const rows = text.split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .map((line, index) => ({ rowNo: index + 1, rawLine: line }));
  return { rows, headers: ["rawLine"], headerMap: {}, headerRowNo: 0 };
}

function decodeXml(text = "") {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

async function parseDocxFile(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = zip.file("word/document.xml");
  if (!documentXml) throw new Error("Word 文件无效");
  const xml = await documentXml.async("string");
  const paragraphs = xml.match(/<w:p[\s\S]*?<\/w:p>/g) || [];
  const rows = paragraphs.map((paragraph, index) => {
    const textParts = [];
    const prepared = paragraph.replace(/<w:tab\s*\/>/g, " ");
    const textRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let match;
    while ((match = textRe.exec(prepared))) textParts.push(decodeXml(match[1]));
    return { rowNo: index + 1, rawLine: normalizeText(textParts.join("")) };
  }).filter((row) => row.rawLine);
  return { rows, headers: ["rawLine"], headerMap: {}, headerRowNo: 0 };
}

async function parseFileBuffer(buffer, fileName, fileRole) {
  const type = fileTypeOf(fileName);
  if (type === "xlsx") return { fileType: type, ...(await parseXlsxFile(buffer, fileRole)) };
  if (type === "xls") return { fileType: type, ...parseExcelFile(buffer, fileRole) };
  if (type === "csv") return { fileType: type, ...parseCsvFile(buffer, fileRole) };
  if (type === "txt") return { fileType: type, ...parseTxtFile(buffer, fileRole) };
  if (type === "docx") return { fileType: type, ...(await parseDocxFile(buffer)) };
  throw new Error(`不支持的文件格式：${type || "未知"}`);
}

function valueByHeader(row, header) {
  if (!header) return "";
  return row[header];
}

function splitTags(value = "") {
  return Array.from(new Set(String(value || "")
    .split(/[,，、\s\/;；|]+/)
    .map((item) => normalizeText(item))
    .filter(Boolean)));
}

function truthy(value) {
  const text = normalizeText(value).toLowerCase();
  return ["1", "true", "yes", "y", "是", "有", "√", "✓"].includes(text);
}

function extractTagFields(row, map = {}) {
  const rawTags = splitTags(valueByHeader(row, map.tags));
  const tags = rawTags.filter((tag) => PUBLIC_TAGS.includes(tag));
  const internalTags = splitTags(valueByHeader(row, map.internalTags)).concat(rawTags.filter((tag) => !PUBLIC_TAGS.includes(tag)));
  const flags = {
    isNew: truthy(valueByHeader(row, map.isNew)) || tags.includes("新货"),
    isDefective: truthy(valueByHeader(row, map.isDefective)) || tags.includes("瑕疵"),
    isHot: truthy(valueByHeader(row, map.isHot)) || tags.includes("热销")
  };
  [
    [flags.isNew, "新货"],
    [flags.isDefective, "瑕疵"],
    [flags.isHot, "热销"]
  ].forEach(([enabled, tag]) => {
    if (enabled && !tags.includes(tag)) tags.push(tag);
  });
  return {
    tags: tags.slice(0, 4),
    internalTags: Array.from(new Set(internalTags)).slice(0, 20),
    defectDescription: normalizeText(valueByHeader(row, map.defectDescription)),
    ...flags
  };
}

function normalizeInventoryRows(parseResult) {
  const map = parseResult.headerMap || {};
  return (parseResult.rows || []).map((row, index) => {
    const rawName = normalizeText(valueByHeader(row, map.name) || row.rawLine || "");
    const stockSource = valueByHeader(row, map.stock);
    const specSource = valueByHeader(row, map.specification);
    const dateSource = valueByHeader(row, map.productionDate);
    const stockParsed = stockSource !== undefined && stockSource !== ""
      ? extractStock(String(stockSource))
      : extractStock(rawName);
    const spec = normalizeText(specSource || "") || extractSpecification(rawName).value;
    const date = normalizeText(dateSource || "") || extractProductionDate(rawName).value;
    const dateWarning = extractProductionDate(rawName).warning;
    const baseName = cleanBaseName(rawName);
    const stock = typeof stockSource === "number" ? stockSource : stockParsed.value;
    let errorMessage = "";
    if (!rawName) errorMessage = "商品名称为空";
    else if (!baseName) errorMessage = "商品名称清洗后为空";
    else if (!Number.isInteger(Number(stock))) errorMessage = "库存不是整数";
    else if (Number(stock) < 0) errorMessage = "库存不能小于 0";
    return {
      sourceRowNo: row.rowNo || index + 1,
      rawInventoryName: rawName,
      finalName: baseName,
      baseName,
      brand: normalizeText(valueByHeader(row, map.brand)) || extractBrand(rawName),
      category: normalizeText(valueByHeader(row, map.category)) || inferCategory(rawName),
      specification: spec,
      productionDate: date,
      stock: Number.isInteger(Number(stock)) ? Number(stock) : null,
      productIndex: normalizeText(valueByHeader(row, map.productIndex)),
      skuCode: normalizeText(valueByHeader(row, map.skuCode)),
      ...extractTagFields(row, map),
      warningMessage: dateWarning || "",
      errorMessage
    };
  });
}

function normalizePriceRows(parseResult) {
  const map = parseResult.headerMap || {};
  return (parseResult.rows || []).map((row, index) => {
    const rawName = normalizeText(valueByHeader(row, map.name) || row.rawLine || "");
    const priceValue = valueByHeader(row, map.price);
    const price = priceValue !== undefined && priceValue !== ""
      ? parsePriceToCents(priceValue)
      : extractPrice(rawName).value;
    const baseName = cleanBaseName(rawName);
    const dateInfo = extractProductionDate(rawName);
    let errorMessage = "";
    if (!rawName) errorMessage = "报价商品名称为空";
    else if (!baseName) errorMessage = "报价商品名称清洗后为空";
    else if (!Number.isInteger(price)) errorMessage = "无法识别价格";
    else if (price < 0) errorMessage = "价格不能小于 0";
    return {
      sourceRowNo: row.rowNo || index + 1,
      rawPriceName: rawName,
      finalName: baseName,
      baseName,
      brand: normalizeText(valueByHeader(row, map.brand)) || extractBrand(rawName),
      category: normalizeText(valueByHeader(row, map.category)) || inferCategory(rawName),
      specification: normalizeText(valueByHeader(row, map.specification)) || extractSpecification(rawName).value,
      productionDate: normalizeText(valueByHeader(row, map.productionDate)) || dateInfo.value,
      price,
      originalPrice: null,
      productIndex: normalizeText(valueByHeader(row, map.productIndex)),
      skuCode: normalizeText(valueByHeader(row, map.skuCode)),
      ...extractTagFields(row, map),
      warningMessage: dateInfo.warning || "",
      errorMessage
    };
  });
}

module.exports = {
  fileTypeOf,
  parseExcelFile,
  parseCsvFile,
  parseTxtFile,
  parseDocxFile,
  detectHeaderMap,
  parseFileBuffer,
  normalizeInventoryRows,
  normalizePriceRows
};
