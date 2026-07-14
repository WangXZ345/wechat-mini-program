const cloud = require("wx-server-sdk");
const xlsx = require("xlsx");
const { parseInventoryLine, cleanBaseName, extractProductionDate, extractSpecification } = require("./utils/parseProductName");
const { normalizeWarningStock, getStockStatus } = require("./stockAlert");
const {
  parseQuoteDocx,
  matchQuotePrice,
  normalizeForMatch,
  similarity: quoteSimilarity,
  createMatchIndex,
  getCandidateItems,
  createQuoteMatcher
} = require("./utils/quotePrice");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");
const NAME_HEADERS = ["商品名称", "商品名", "名称", "品名", "货品名称", "产品名称", "name", "productname", "product_name"];
const STOCK_HEADERS = ["主辅数量", "库存", "库存数量", "数量", "现货", "主数量", "stock", "quantity", "qty"];
const PRICE_HEADERS = ["价格", "售价", "单价", "金额", "price", "unitprice", "amount"];
const PRICE_CENTS_HEADERS = ["价格分", "售价分", "pricecents", "pricecent"];
const PRODUCT_INDEX_HEADERS = ["商品编号", "商品索引", "索引", "编码", "productindex", "product_index"];
const SKU_HEADERS = ["sku", "skucode", "sku_code"];
const WARNING_STOCK_HEADERS = ["预警库存", "最低库存", "最低预警库存", "库存预警", "安全库存", "warningstock", "minstock", "alertstock", "safestock"];

NAME_HEADERS.push("商品名称", "商品名", "名称", "品名", "货品名称", "产品名称");
STOCK_HEADERS.push("主辅数量", "库存", "库存数量", "数量", "现货", "主数量");
PRICE_HEADERS.push("价格", "售价", "单价", "金额");
PRICE_CENTS_HEADERS.push("价格分", "售价分");
PRODUCT_INDEX_HEADERS.push("商品编号", "商品索引", "索引", "编码");
WARNING_STOCK_HEADERS.push("预警库存", "最低库存", "最低预警库存", "库存预警", "安全库存");

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("无管理员权限");
  return openid;
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    if (!/exist|already|collection exists/i.test(err.message || "")) throw err;
  }
}

async function savePreviewFile(importRecordId, items) {
  const cloudPath = `inventory-import/previews/${importRecordId}.json`;
  const upload = await cloud.uploadFile({
    cloudPath,
    fileContent: Buffer.from(JSON.stringify(items), "utf8")
  });
  return {
    previewFileID: upload.fileID,
    previewCloudPath: cloudPath
  };
}

function fileTypeOf(fileName = "", fileID = "") {
  const source = String(fileName || fileID).toLowerCase();
  const match = source.match(/\.([^.?]+)(?:\?|$)/);
  return match ? match[1] : "";
}

function normalizeHeader(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function findHeader(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeHeader);
  return headers.find((header) => normalizedCandidates.includes(normalizeHeader(header)));
}

function parseStockValue(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim().replace(/,/g, "");
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.0+$/.test(text)) return Number(text);
  const stockWithUnit = text.match(/-?\d+(?:\.0+)?/);
  if (stockWithUnit) return Number(stockWithUnit[0]);
  return parseInventoryLine(text).stock;
}

function parsePriceValue(value, isCents = false) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return isCents ? Math.round(value) : Math.round(value * 100);
  }
  const text = String(value).trim().replace(/[$,\s]/g, "");
  if (!text) return null;
  const num = Number(text);
  if (!Number.isFinite(num) || num < 0) return null;
  return isCents ? Math.round(num) : Math.round(num * 100);
}

function parseWarningStockValue(value) {
  return normalizeWarningStock(value);
}

function normalizeRow(row, index) {
  const rawName = String(row.rawName || row.name || "").trim();
  const baseName = cleanBaseName(rawName);
  const spec = extractSpecification(rawName);
  const date = extractProductionDate(rawName);
  const stock = parseStockValue(row.stock);
  const price = parsePriceValue(row.price, row.priceIsCents);
  let warningStock = 10;
  let errorMessage = "";
  try {
    warningStock = parseWarningStockValue(row.warningStock);
  } catch (err) {
    errorMessage = err.message || "预警库存无效";
  }

  if (!rawName) errorMessage = "商品名称为空";
  else if (!baseName) errorMessage = "商品名称为空";
  else if (!Number.isInteger(stock)) errorMessage = "库存不是整数";
  else if (stock < 0) errorMessage = "库存不能小于 0";

  return {
    rowNo: index + 1,
    rawName,
    baseName,
    specification: spec.value,
    productionDate: date.value,
    productIndex: String(row.productIndex || "").trim(),
    skuCode: String(row.skuCode || "").trim(),
    stock: Number.isInteger(stock) ? stock : null,
    warningStock,
    stockStatusAfterImport: Number.isInteger(stock) ? getStockStatus(stock, warningStock) : "",
    price: Number.isInteger(price) ? price : null,
    source: row.source || "inventory",
    quoteMatchedName: row.quoteMatchedName || "",
    quoteMatchScore: row.quoteMatchScore || 0,
    quoteSourceLine: row.quoteSourceLine || "",
    errorMessage
  };
}

function parseExcel(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer", cellDates: false });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(firstSheet, { defval: "" });
  if (!rows.length) throw new Error("Excel 文件没有可解析的行");

  const headers = Object.keys(rows[0]);
  const nameHeader = findHeader(headers, NAME_HEADERS);
  const stockHeader = findHeader(headers, STOCK_HEADERS);
  const priceCentsHeader = findHeader(headers, PRICE_CENTS_HEADERS);
  const priceHeader = priceCentsHeader || findHeader(headers, PRICE_HEADERS);
  const productIndexHeader = findHeader(headers, PRODUCT_INDEX_HEADERS);
  const skuHeader = findHeader(headers, SKU_HEADERS);
  const warningStockHeader = findHeader(headers, WARNING_STOCK_HEADERS);
  if (!nameHeader) throw new Error("Excel 没有识别到商品名称列");
  if (!stockHeader) throw new Error("Excel 没有识别到库存列");

  return rows.map((row, index) => normalizeRow({
    rawName: row[nameHeader],
    productIndex: productIndexHeader ? row[productIndexHeader] : "",
    skuCode: skuHeader ? row[skuHeader] : "",
    stock: row[stockHeader],
    warningStock: warningStockHeader ? row[warningStockHeader] : "",
    price: priceHeader ? row[priceHeader] : "",
    priceIsCents: Boolean(priceCentsHeader)
  }, index));
}

function parseTxt(buffer) {
  return buffer.toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => normalizeRow({ rowNo: index + 1, price: null, productIndex: "", skuCode: "", ...parseInventoryLine(line) }, index));
}

function inventoryMatchText(row) {
  return normalizeForMatch([
    row.rawName,
    row.baseName,
    row.specification
  ].filter(Boolean).join(" "));
}

function createInventoryMatcher(rows) {
  return createMatchIndex(rows, inventoryMatchText);
}

function hasSimilarInventoryRow(entry, inventoryIndex) {
  const quoteName = entry.normalizedName || normalizeForMatch(entry.name);
  return getCandidateItems(inventoryIndex, [quoteName], 50)
    .some((item) => quoteSimilarity(item.normalizedName, quoteName) >= 0.66);
}

function buildQuoteOnlyRows(rows, quoteEntries, inventoryIndex) {
  if (!quoteEntries.length) return [];
  const nextIndex = rows.length;
  return quoteEntries
    .filter((entry) => !hasSimilarInventoryRow(entry, inventoryIndex))
    .map((entry, index) => normalizeRow({
      rawName: entry.name,
      productIndex: "",
      skuCode: "",
      stock: 0,
      warningStock: "",
      price: entry.priceCents,
      priceIsCents: true,
      source: "quote",
      quoteMatchedName: entry.name,
      quoteMatchScore: 1,
      quoteSourceLine: entry.sourceLine
    }, nextIndex + index));
}

function normKey(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function similarity(a, b) {
  const aa = normKey(a);
  const bb = normKey(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  const short = aa.length <= bb.length ? aa : bb;
  const long = aa.length > bb.length ? aa : bb;
  if (long.includes(short)) return short.length / long.length;
  let same = 0;
  for (const ch of new Set(short.split(""))) {
    if (long.includes(ch)) same += 1;
  }
  return same / Math.max(long.length, 1);
}

function matchProduct(item, products) {
  const sameBase = products.filter((product) => normKey(product.name) === normKey(item.baseName));
  const exact = sameBase.find((product) =>
    normKey(product.specification) === normKey(item.specification) &&
    String(product.productionDate || "") === String(item.productionDate || "")
  );
  if (exact) return { level: "exact", product: exact, candidates: [] };

  const sameSpecDifferentDate = sameBase.filter((product) =>
    normKey(product.specification) === normKey(item.specification) &&
    String(product.productionDate || "") !== String(item.productionDate || "")
  );
  if (sameSpecDifferentDate.length === 1) {
    return { level: "sameNameSameSpecDifferentDate", product: sameSpecDifferentDate[0], candidates: sameSpecDifferentDate };
  }
  if (sameSpecDifferentDate.length > 1) return { level: "multiple", product: null, candidates: sameSpecDifferentDate };

  const fuzzy = products
    .map((product) => ({ product, score: similarity(item.baseName, product.name) }))
    .filter((entry) => entry.score >= 0.72)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.product);

  if (fuzzy.length === 1) return { level: "fuzzy", product: fuzzy[0], candidates: fuzzy };
  if (fuzzy.length > 1) return { level: "multiple", product: null, candidates: fuzzy };
  return { level: "none", product: null, candidates: [] };
}

async function getAllProducts() {
  const res = await db.collection("products").limit(1000).get();
  return res.data.filter((item) => item.isDeleted !== true);
}

function buildPreviewItems(rows, products, quoteEntries = []) {
  const usedQuoteLines = new Set();
  const quoteMatcher = createQuoteMatcher(quoteEntries);
  const inventoryMatcher = createInventoryMatcher(rows);
  return rows.map((row) => {
    const matched = row.errorMessage ? { level: "none", product: null, candidates: [] } : matchProduct(row, products);
    const quoteMatch = row.price === null && !row.errorMessage ? matchQuotePrice(row, quoteMatcher) : null;
    if (quoteMatch && quoteMatch.quoteLineNo) usedQuoteLines.add(quoteMatch.quoteLineNo);
    let action = "create";
    let errorMessage = row.errorMessage || "";
    let matchedProductId = matched.product ? matched.product._id : "";

    if (row.errorMessage) action = "error";
    else if (matched.level === "exact") action = "update";
    else if (matched.level === "sameNameSameSpecDifferentDate") {
      action = "create";
      errorMessage = "同名同规格但生产日期不同，将新建批次商品";
      matchedProductId = "";
    } else if (matched.level === "fuzzy" || matched.level === "multiple") {
      action = "error";
      errorMessage = matched.level === "multiple" ? "存在多个可能匹配，请确认" : "可能匹配到已有商品，请确认";
      matchedProductId = matched.product ? matched.product._id : "";
    }

    return {
      ...row,
      matchedProductId,
      matchedProductName: matched.product ? matched.product.name : "",
      matchLevel: matched.level,
      candidates: matched.candidates.map((product) => ({
        productId: product._id,
        name: product.name,
        specification: product.specification || "",
        productionDate: product.productionDate || "",
        productIndex: product.productIndex || "",
        skuCode: product.skuCode || "",
        stock: Number(product.stock || 0),
        warningStock: normalizeWarningStock(product.warningStock),
        stockStatus: product.stockStatus || getStockStatus(product.stock, product.warningStock),
        price: Number(product.price || 0)
      })),
      price: quoteMatch ? quoteMatch.price : row.price,
      quoteMatchedName: quoteMatch ? quoteMatch.quoteMatchedName : row.quoteMatchedName || "",
      quoteMatchScore: quoteMatch ? quoteMatch.quoteMatchScore : row.quoteMatchScore || 0,
      quoteSourceLine: quoteMatch ? quoteMatch.quoteSourceLine : row.quoteSourceLine || "",
      action,
      selected: action !== "error",
      errorMessage
    };
  }).concat(buildQuoteOnlyRows(rows, quoteEntries.filter((entry) => !usedQuoteLines.has(entry.lineNo)), inventoryMatcher).map((row) => {
    const matched = row.errorMessage ? { level: "none", product: null, candidates: [] } : matchProduct(row, products);
    let action = "create";
    let errorMessage = row.errorMessage || "";
    let matchedProductId = matched.product ? matched.product._id : "";

    if (row.errorMessage) action = "error";
    else if (matched.level === "exact") action = "update";
    else if (matched.level === "fuzzy" || matched.level === "multiple") {
      action = "error";
      errorMessage = matched.level === "multiple" ? "存在多个可能匹配，请确认" : "可能匹配到已有商品，请确认";
      matchedProductId = matched.product ? matched.product._id : "";
    }

    return {
      ...row,
      matchedProductId,
      matchedProductName: matched.product ? matched.product.name : "",
      matchLevel: matched.level === "none" ? "报价单新增" : matched.level,
      candidates: matched.candidates.map((product) => ({
        productId: product._id,
        name: product.name,
        specification: product.specification || "",
        productionDate: product.productionDate || "",
        productIndex: product.productIndex || "",
        skuCode: product.skuCode || "",
        stock: Number(product.stock || 0),
        warningStock: normalizeWarningStock(product.warningStock),
        stockStatus: product.stockStatus || getStockStatus(product.stock, product.warningStock),
        price: Number(product.price || 0)
      })),
      action,
      selected: action !== "error",
      errorMessage
    };
  }));
}

function slimPreviewItem(item) {
  return {
    rowNo: item.rowNo,
    rawName: item.rawName,
    baseName: item.baseName,
    specification: item.specification,
    productionDate: item.productionDate,
    productIndex: item.productIndex,
    skuCode: item.skuCode,
    stock: item.stock,
    warningStock: item.warningStock,
    stockStatusAfterImport: item.stockStatusAfterImport,
    price: item.price,
    source: item.source,
    quoteMatchedName: item.quoteMatchedName,
    quoteMatchScore: item.quoteMatchScore,
    quoteSourceLine: item.quoteSourceLine,
    matchedProductId: item.matchedProductId,
    matchedProductName: item.matchedProductName,
    matchLevel: item.matchLevel,
    action: item.action,
    selected: item.selected,
    errorMessage: item.errorMessage
  };
}

exports.main = async (event) => {
  try {
    const admin = await requirePermission("inventory:import");
    const operatorId = admin.openid;
    const { fileID, fileName = "", fileUrl = "", mode = "override", quoteFileID = "", quoteFileName = "" } = event;
    const fileType = fileTypeOf(fileName, fileID);
    if (!fileID) return fail("缺少文件 ID");
    if (!["xlsx", "xls", "txt"].includes(fileType)) return fail("不支持的文件格式");
    if (!["override", "add"].includes(mode)) return fail("导入模式无效");
    if (quoteFileID && fileTypeOf(quoteFileName, quoteFileID) !== "docx") return fail("报价单只支持 docx 文件");

    await ensureCollection("import_records");
    await ensureCollection("import_record_items");

    const file = await cloud.downloadFile({ fileID });
    const rows = fileType === "txt" ? parseTxt(file.fileContent) : parseExcel(file.fileContent);
    let quoteEntries = [];
    if (quoteFileID) {
      const quoteFile = await cloud.downloadFile({ fileID: quoteFileID });
      quoteEntries = await parseQuoteDocx(quoteFile.fileContent);
    }
    const products = await getAllProducts();
    const items = buildPreviewItems(rows, products, quoteEntries);
    const importRecord = await db.collection("import_records").add({
      data: {
        fileName: fileName || fileID.split("/").pop(),
        fileType,
        fileUrl,
        fileID,
        quoteFileID,
        quoteFileName,
        quotePriceRows: quoteEntries.length,
        operatorId,
        totalRows: items.length,
        successRows: 0,
        failedRows: items.filter((item) => item.action === "error").length,
        mode,
        status: "parsed",
        createdAt: db.serverDate(),
        importedAt: null
      }
    });
    const previewFile = await savePreviewFile(importRecord._id, items);
    await db.collection("import_records").doc(importRecord._id).update({
      data: previewFile
    });

    return ok({
      importRecordId: importRecord._id,
      totalRows: items.length,
      mode,
      ...previewFile
    });
  } catch (err) {
    return fail(err.message || "解析库存文件失败");
  }
};

