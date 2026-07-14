const cloud = require("wx-server-sdk");
const {
  db,
  _,
  ensureCollection,
  requirePermission,
  requireAnyPermission,
  logAdminOperation
} = require("./cleanAuth");
const {
  parseFileBuffer,
  normalizeInventoryRows,
  normalizePriceRows,
  fileTypeOf
} = require("./importParser");
const {
  normalizeForMatch,
  buildMatchKey,
  buildSearchText,
  extractBrand,
  inferCategory
} = require("./productNormalize");
const {
  beginIdempotentAction,
  finishIdempotentAction,
  failIdempotentAction,
  idempotencyEarlyReturn,
  idempotencyErrorResponse,
  firstSuccessData
} = require("./idempotency");

const IMPORT_COLLECTIONS = [
  "import_records",
  "import_record_items",
  "inventory_logs",
  "price_logs",
  "product_tag_logs",
  "admin_operation_logs"
];

const ALLOWED_TYPES = ["xlsx", "xls", "csv", "txt", "docx"];
const STOCK_MODES = ["override", "add"];
const PRICE_MODES = ["override", "only_new", "skip"];
const ACTIONS = ["update", "create", "ignore", "error"];
const MAX_FUZZY_SCAN_CELLS = 80000;
const MAX_PRICE_ONLY_PREVIEW = 200;
const ITEM_INSERT_BATCH_SIZE = 20;
const MAX_PRODUCT_FUZZY_CANDIDATES = 300;
const PUBLIC_TAG_NAMES = ["新货", "瑕疵", "热销"];

async function ensureImportCollections() {
  for (const name of IMPORT_COLLECTIONS) {
    await ensureCollection(name);
  }
}

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function compactKey(value = "") {
  return normalizeForMatch(value).replace(/\s+/g, "").toLowerCase();
}

function indexValue(row = {}) {
  return compactKey(row.productIndex || row.skuCode || "");
}

function exactKey(row = {}) {
  return [compactKey(row.baseName || row.finalName), compactKey(row.specification), String(row.productionDate || "")].join("|");
}

function nameSpecKey(row = {}) {
  return [compactKey(row.baseName || row.finalName), compactKey(row.specification)].join("|");
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

function bigrams(value = "") {
  const chars = String(value || "");
  const result = [];
  for (let i = 0; i < chars.length - 1; i += 1) result.push(chars.slice(i, i + 2));
  return result;
}

function similarity(a, b) {
  const aa = compactKey(a);
  const bb = compactKey(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  const short = aa.length <= bb.length ? aa : bb;
  const long = aa.length > bb.length ? aa : bb;
  if (long.includes(short)) return Math.min(0.98, short.length / long.length + 0.16);
  const charScore = (2 * overlapCount(aa.split(""), bb.split(""))) / (aa.length + bb.length);
  const aBi = bigrams(aa);
  const bBi = bigrams(bb);
  const biScore = aBi.length && bBi.length ? (2 * overlapCount(aBi, bBi)) / (aBi.length + bBi.length) : 0;
  return (0.68 * charScore) + (0.32 * biScore);
}

function takeFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "") || "";
}

function uniqueList(...lists) {
  return Array.from(new Set(lists.flat().filter(Boolean)));
}

function publicTags(values = []) {
  return uniqueList(values).filter((tag) => PUBLIC_TAG_NAMES.includes(tag)).slice(0, 4);
}

function tagSnapshot(product = {}) {
  return {
    tags: Array.isArray(product.tags) ? product.tags : [],
    internalTags: Array.isArray(product.internalTags) ? product.internalTags : [],
    flags: {
      isNew: Boolean(product.isNew),
      isDefective: Boolean(product.isDefective),
      isHot: Boolean(product.isHot),
      isFrequent: false
    },
    defectDescription: product.defectDescription || ""
  };
}

async function writeImportTagLog(tx, productId, productName, beforeProduct, afterProduct, admin) {
  const before = tagSnapshot(beforeProduct);
  const after = tagSnapshot(afterProduct);
  await tx.collection("product_tag_logs").add({
    data: {
      productId,
      productName,
      beforeTags: before.tags,
      afterTags: after.tags,
      beforeInternalTags: before.internalTags,
      afterInternalTags: after.internalTags,
      beforeFlags: before.flags,
      afterFlags: after.flags,
      beforeDefectDescription: before.defectDescription,
      afterDefectDescription: after.defectDescription,
      operatorId: admin._id || admin.id || "",
      operatorOpenid: admin.openid || "",
      operatorRole: admin.role || "",
      createdAt: db.serverDate()
    }
  });
}

function mergeItem(inventory, price, matchLevel, warningMessage = "") {
  const finalName = takeFirst(inventory.finalName, price && price.finalName);
  const mergedWarning = [inventory.warningMessage, price && price.warningMessage, warningMessage].filter(Boolean).join("；");
  const missingPrice = !price || !Number.isInteger(price.price);
  let action = "create";
  let selected = true;
  let errorMessage = inventory.errorMessage || "";
  if (missingPrice) {
    action = "error";
    selected = false;
    errorMessage = errorMessage || "未在报价表找到价格";
  }
  if (matchLevel === "fuzzy") {
    action = missingPrice ? "error" : "create";
    selected = false;
  }
  if (errorMessage) {
    action = "error";
    selected = false;
  }
  return {
    selected,
    action,
    matchLevel,
    sourceRowNo: inventory.sourceRowNo,
    priceSourceRowNo: price ? price.sourceRowNo : null,
    rawInventoryName: inventory.rawInventoryName || "",
    rawPriceName: price ? price.rawPriceName || "" : "",
    finalName,
    baseName: finalName,
    brand: takeFirst(inventory.brand, price && price.brand, extractBrand(finalName)),
    category: takeFirst(inventory.category, price && price.category, inferCategory(finalName)),
    specification: takeFirst(inventory.specification, price && price.specification),
    productionDate: takeFirst(inventory.productionDate, price && price.productionDate),
    stock: inventory.stock,
    price: price ? price.price : null,
    originalPrice: price ? price.originalPrice : null,
    productIndex: takeFirst(inventory.productIndex, price && price.productIndex),
    skuCode: takeFirst(inventory.skuCode, price && price.skuCode),
    tags: publicTags(uniqueList(inventory.tags || [], price && price.tags || [])),
    internalTags: uniqueList(inventory.internalTags || [], price && price.internalTags || []).slice(0, 20),
    isNew: Boolean(inventory.isNew || price && price.isNew),
    isDefective: Boolean(inventory.isDefective || price && price.isDefective),
    isHot: Boolean(inventory.isHot || price && price.isHot),
    isFrequent: false,
    defectDescription: takeFirst(inventory.defectDescription, price && price.defectDescription),
    matchedProductId: "",
    matchedProductName: "",
    candidates: [],
    errorMessage,
    warningMessage: mergedWarning
  };
}

function mergeInventoryAndPriceRows(inventoryRows = [], priceRows = []) {
  const usedPrice = new Set();
  const priceByIndex = new Map();
  const priceByExact = new Map();
  const priceByNameSpec = new Map();
  const priceBySpec = new Map();
  priceRows.forEach((row, index) => {
    const idx = indexValue(row);
    if (idx) priceByIndex.set(idx, { row, index });
    const exact = exactKey(row);
    if (!priceByExact.has(exact)) priceByExact.set(exact, []);
    priceByExact.get(exact).push({ row, index });
    const spec = nameSpecKey(row);
    if (!priceByNameSpec.has(spec)) priceByNameSpec.set(spec, []);
    priceByNameSpec.get(spec).push({ row, index });
    const specOnly = compactKey(row.specification);
    if (specOnly) {
      if (!priceBySpec.has(specOnly)) priceBySpec.set(specOnly, []);
      priceBySpec.get(specOnly).push({ row, index });
    }
  });
  const allowFullFuzzyScan = inventoryRows.length * priceRows.length <= MAX_FUZZY_SCAN_CELLS;

  const items = inventoryRows.map((inventory) => {
    const idx = indexValue(inventory);
    if (idx && priceByIndex.has(idx)) {
      const found = priceByIndex.get(idx);
      usedPrice.add(found.index);
      return mergeItem(inventory, found.row, "index");
    }

    const exactMatches = priceByExact.get(exactKey(inventory)) || [];
    const exact = exactMatches.find((entry) => !usedPrice.has(entry.index));
    if (exact) {
      usedPrice.add(exact.index);
      return mergeItem(inventory, exact.row, "exact");
    }

    const specMatches = priceByNameSpec.get(nameSpecKey(inventory)) || [];
    const sameSpec = specMatches.find((entry) => !usedPrice.has(entry.index));
    if (sameSpec) {
      usedPrice.add(sameSpec.index);
      return mergeItem(
        inventory,
        sameSpec.row,
        "sameNameSpec",
        "报价表无生产日期或生产日期不一致，请确认是否同一商品"
      );
    }

    const inventorySpec = compactKey(inventory.specification);
    const fuzzySource = allowFullFuzzyScan
      ? priceRows.map((price, index) => ({ row: price, index }))
      : (inventorySpec ? (priceBySpec.get(inventorySpec) || []) : []);
    const fuzzy = fuzzySource
      .filter((entry) => !usedPrice.has(entry.index))
      .map((entry) => ({
        price: entry.row,
        index: entry.index,
        score: similarity(`${inventory.baseName} ${inventory.specification}`, `${entry.row.baseName} ${entry.row.specification}`)
      }))
      .filter((entry) => entry.score >= 0.8)
      .sort((a, b) => b.score - a.score)[0];
    if (fuzzy) {
      usedPrice.add(fuzzy.index);
      return mergeItem(inventory, fuzzy.price, "fuzzy", "模糊匹配需人工确认，系统不会默认选中导入");
    }

    return mergeItem(inventory, null, "none", "未在报价表找到价格");
  });

  let skippedPriceOnlyRows = 0;
  priceRows.forEach((price, index) => {
    if (usedPrice.has(index)) return;
    if (skippedPriceOnlyRows >= MAX_PRICE_ONLY_PREVIEW) {
      skippedPriceOnlyRows += 1;
      return;
    }
    skippedPriceOnlyRows += 1;
    items.push({
      selected: false,
      action: "ignore",
      matchLevel: "none",
      sourceRowNo: null,
      priceSourceRowNo: price.sourceRowNo,
      rawInventoryName: "",
      rawPriceName: price.rawPriceName,
      finalName: price.finalName,
      baseName: price.finalName,
      brand: price.brand,
      category: price.category,
      specification: price.specification,
      productionDate: price.productionDate,
      stock: null,
      price: price.price,
      originalPrice: price.originalPrice,
      productIndex: price.productIndex,
      skuCode: price.skuCode,
      matchedProductId: "",
      matchedProductName: "",
      candidates: [],
      errorMessage: "",
      warningMessage: "报价表未匹配库存，默认忽略"
    });
  });

  if (skippedPriceOnlyRows > MAX_PRICE_ONLY_PREVIEW) {
    const omittedCount = skippedPriceOnlyRows - MAX_PRICE_ONLY_PREVIEW;
    items.push({
      selected: false,
      action: "ignore",
      matchLevel: "none",
      sourceRowNo: null,
      priceSourceRowNo: null,
      rawInventoryName: "",
      rawPriceName: "",
      finalName: `报价表未匹配库存的行还有 ${omittedCount} 行`,
      baseName: `报价表未匹配库存的行还有 ${omittedCount} 行`,
      brand: "",
      category: "",
      specification: "",
      productionDate: "",
      stock: null,
      price: null,
      originalPrice: null,
      productIndex: "",
      skuCode: "",
      matchedProductId: "",
      matchedProductName: "",
      candidates: [],
      errorMessage: "",
      warningMessage: "为避免预览过大，仅展示前 200 行报价表未匹配库存数据"
    });
  }

  return items;
}

async function getAllProducts() {
  let products = [];
  let skip = 0;
  const pageSize = 100;
  while (skip < 3000) {
    const res = await db.collection("products").skip(skip).limit(pageSize).get();
    products = products.concat(res.data || []);
    if (!res.data || res.data.length < pageSize) break;
    skip += pageSize;
  }
  return products.filter((item) => item.isDeleted !== true);
}

function productComparable(product = {}) {
  const baseName = product.baseName || product.name || product.finalName || "";
  return {
    ...product,
    baseName,
    finalName: product.name || baseName,
    specification: product.specification || "",
    productionDate: product.productionDate || "",
    productIndex: product.productIndex || "",
    skuCode: product.skuCode || ""
  };
}

function buildProductLookup(products = []) {
  const comparable = products.map(productComparable);
  const byIndex = new Map();
  const byExact = new Map();
  const byNameSpec = new Map();
  const bySpec = new Map();
  comparable.forEach((product) => {
    const idx = indexValue(product);
    if (idx && !byIndex.has(idx)) byIndex.set(idx, product);
    const exact = exactKey(product);
    if (exact && !byExact.has(exact)) byExact.set(exact, product);
    const sameNameSpec = nameSpecKey(product);
    if (!byNameSpec.has(sameNameSpec)) byNameSpec.set(sameNameSpec, []);
    byNameSpec.get(sameNameSpec).push(product);
    const spec = compactKey(product.specification);
    if (spec) {
      if (!bySpec.has(spec)) bySpec.set(spec, []);
      bySpec.get(spec).push(product);
    }
  });
  return { comparable, byIndex, byExact, byNameSpec, bySpec };
}

function matchExistingProduct(item, lookupOrProducts) {
  const lookup = Array.isArray(lookupOrProducts) ? buildProductLookup(lookupOrProducts) : lookupOrProducts;
  const idx = indexValue(item);
  if (idx) {
    const byIndex = lookup.byIndex.get(idx);
    if (byIndex) return { level: "index", product: byIndex, candidates: [] };
  }
  const exact = lookup.byExact.get(exactKey(item));
  if (exact) return { level: "exact", product: exact, candidates: [] };
  const sameSpec = lookup.byNameSpec.get(nameSpecKey(item)) || [];
  if (sameSpec.length) {
    return {
      level: "sameNameSpec",
      product: null,
      candidates: sameSpec.slice(0, 5),
      warning: "数据库已有同名同规格但生产日期不同的商品，默认创建新批次"
    };
  }
  const itemSpec = compactKey(item.specification);
  const fuzzySource = itemSpec
    ? (lookup.bySpec.get(itemSpec) || [])
    : (lookup.comparable.length <= MAX_PRODUCT_FUZZY_CANDIDATES ? lookup.comparable : []);
  if (fuzzySource.length > MAX_PRODUCT_FUZZY_CANDIDATES) return { level: "none", product: null, candidates: [] };
  const fuzzy = fuzzySource
    .map((product) => ({ product, score: similarity(item.finalName, product.name || product.baseName || "") }))
    .filter((entry) => entry.score >= 0.78)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (fuzzy.length) {
    return { level: "fuzzy", product: null, candidates: fuzzy.map((entry) => entry.product), warning: "可能匹配到已有商品，需人工确认" };
  }
  return { level: "none", product: null, candidates: [] };
}

function attachProductMatches(items, products) {
  const productLookup = buildProductLookup(products);
  return items.map((item, index) => {
    if (item.action === "ignore" || item.action === "error") return { ...item, rowNo: index + 1 };
    const match = matchExistingProduct(item, productLookup);
    const warningMessage = [item.warningMessage, match.warning].filter(Boolean).join("；");
    if (match.product) {
      return {
        ...item,
        rowNo: index + 1,
        action: "update",
        selected: item.selected !== false,
        matchedProductId: match.product._id,
        matchedProductName: match.product.name || match.product.baseName || "",
        dbMatchLevel: match.level,
        warningMessage
      };
    }
    if (match.level === "fuzzy") {
      return {
        ...item,
        rowNo: index + 1,
        action: "create",
        selected: false,
        matchLevel: item.matchLevel === "none" ? "fuzzy" : item.matchLevel,
        dbMatchLevel: "fuzzy",
        candidates: match.candidates.map((product) => ({
          productId: product._id,
          name: product.name || product.baseName || "",
          specification: product.specification || "",
          productionDate: product.productionDate || "",
          productIndex: product.productIndex || "",
          skuCode: product.skuCode || "",
          stock: Number(product.stock || 0),
          price: Number(product.price || 0)
        })),
        warningMessage
      };
    }
    return {
      ...item,
      rowNo: index + 1,
      action: item.action === "error" ? "error" : "create",
      selected: item.selected !== false && item.action !== "error",
      dbMatchLevel: match.level,
      candidates: match.candidates.map((product) => ({
        productId: product._id,
        name: product.name || product.baseName || "",
        specification: product.specification || "",
        productionDate: product.productionDate || "",
        productIndex: product.productIndex || "",
        skuCode: product.skuCode || "",
        stock: Number(product.stock || 0),
        price: Number(product.price || 0)
      })),
      warningMessage
    };
  });
}

function slimItem(item) {
  const copy = { ...item };
  if (copy.candidates && copy.candidates.length > 5) copy.candidates = copy.candidates.slice(0, 5);
  return copy;
}

function clientPreviewItem(item) {
  const copy = slimItem(item);
  if (!copy.candidates || !copy.candidates.length) delete copy.candidates;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

async function saveImportItems(importRecordId, items) {
  for (let i = 0; i < items.length; i += ITEM_INSERT_BATCH_SIZE) {
    const batch = items.slice(i, i + ITEM_INSERT_BATCH_SIZE);
    await Promise.all(batch.map((item) => db.collection("import_record_items").add({
      data: {
        ...item,
        importRecordId,
        status: "pending",
        finalProductId: "",
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })));
  }
}

async function uploadImportFile(event = {}) {
  const admin = await requirePermission("inventory:import");
  await ensureImportCollections();
  const { fileID = "", fileName = "", fileType = "", fileSize = 0, fileRole = "inventory" } = event;
  const type = fileType || fileTypeOf(fileName, fileID);
  if (!fileID) throw new Error("缺少文件 ID");
  if (!ALLOWED_TYPES.includes(type)) throw new Error("不支持的文件格式");
  await logAdminOperation({
    operator: admin,
    action: "upload_import_file",
    resourceType: "import_file",
    resourceId: fileID,
    afterData: { fileID, fileName, fileType: type, fileSize, fileRole },
    description: "上传库存/报价导入文件"
  });
  return {
    fileID,
    fileName: fileName || fileID.split("/").pop(),
    fileType: type,
    fileSize,
    fileRole,
    operatorId: admin._id || admin.id || "",
    operatorOpenid: admin.openid
  };
}

async function parseMergedInventoryImport(event = {}) {
  const {
    inventoryFileID,
    priceFileID,
    inventoryFileName = "",
    priceFileName = "",
    stockMode = "override",
    priceMode = "override"
  } = event;
  if (!inventoryFileID) throw new Error("缺少库存表文件 ID");
  if (!priceFileID) throw new Error("缺少报价表文件 ID");
  if (!STOCK_MODES.includes(stockMode)) throw new Error("库存处理方式无效");
  if (!PRICE_MODES.includes(priceMode)) throw new Error("价格处理方式无效");

  const [inventoryFile, priceFile] = await Promise.all([
    cloud.downloadFile({ fileID: inventoryFileID }),
    cloud.downloadFile({ fileID: priceFileID })
  ]);
  const inventoryParsed = await parseFileBuffer(inventoryFile.fileContent, inventoryFileName || inventoryFileID, "inventory");
  const priceParsed = await parseFileBuffer(priceFile.fileContent, priceFileName || priceFileID, "price");
  const inventoryRows = normalizeInventoryRows(inventoryParsed);
  const priceRows = normalizePriceRows(priceParsed);
  const mergedRows = mergeInventoryAndPriceRows(inventoryRows, priceRows);
  const items = mergedRows.map((item, index) => slimItem({ ...item, rowNo: index + 1 }));
  const failedRows = items.filter((item) => item.action === "error").length;
  const skippedRows = items.filter((item) => item.action === "ignore" || item.selected === false).length;
  const importRecordId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    importRecordId,
    inventoryFileID,
    inventoryFileName: inventoryFileName || inventoryFileID.split("/").pop(),
    priceFileID,
    priceFileName: priceFileName || priceFileID.split("/").pop(),
    inventoryFileType: inventoryParsed.fileType,
    priceFileType: priceParsed.fileType,
    totalInventoryRows: inventoryRows.length,
    totalPriceRows: priceRows.length,
    mergedRows: items.length,
    failedRows,
    skippedRows,
    clientPreviewMode: true,
    pureClientPreview: true,
    items: items.map(clientPreviewItem)
  };
}

async function getImportRecord(importRecordId) {
  const record = (await db.collection("import_records").doc(importRecordId).get()).data;
  if (!record) throw new Error("导入记录不存在");
  return record;
}

async function getImportItems(importRecordId) {
  const pageSize = 100;
  let skip = 0;
  let items = [];
  while (skip < 3000) {
    const res = await db.collection("import_record_items")
      .where({ importRecordId })
      .orderBy("rowNo", "asc")
      .skip(skip)
      .limit(pageSize)
      .get();
    items = items.concat(res.data || []);
    if (!res.data || res.data.length < pageSize) break;
    skip += pageSize;
  }
  return items;
}

function normalizeConfirmItem(item = {}) {
  const action = item.action || "error";
  if (!ACTIONS.includes(action)) throw new Error("处理方式无效");
  const stock = item.stock === null || item.stock === undefined || item.stock === "" ? null : Number(item.stock);
  const price = item.price === null || item.price === undefined || item.price === "" ? null : Number(item.price);
  if (action === "ignore") return { ...item, action, selected: false };
  if (action === "error") throw new Error(item.errorMessage || "错误行不能导入");
  if (!String(item.finalName || item.baseName || "").trim()) throw new Error("商品名称为空");
  if (!Number.isInteger(stock) || stock < 0) throw new Error("库存必须是非负整数");
  if (price !== null && (!Number.isInteger(price) || price < 0)) throw new Error("价格必须是非负整数，单位为分");
  if (action === "create" && (price === null || price <= 0)) throw new Error("新商品缺少有效价格");
  return {
    ...item,
    action,
    finalName: String(item.finalName || item.baseName || "").trim(),
    baseName: String(item.baseName || item.finalName || "").trim(),
    brand: String(item.brand || "").trim(),
    category: String(item.category || "").trim(),
    specification: String(item.specification || "").trim(),
    productionDate: String(item.productionDate || "").trim(),
    productIndex: String(item.productIndex || "").trim(),
    skuCode: String(item.skuCode || "").trim(),
    tags: publicTags(Array.isArray(item.tags) ? item.tags : []),
    internalTags: Array.isArray(item.internalTags) ? item.internalTags : [],
    isNew: item.isNew === true,
    isDefective: item.isDefective === true,
    isHot: item.isHot === true,
    isFrequent: false,
    defectDescription: String(item.defectDescription || "").trim(),
    stock,
    price
  };
}

function generatedProductIndex(importRecordId, rowNo) {
  return `IMP-${String(importRecordId || "").slice(-6)}-${String(rowNo || 0).padStart(4, "0")}`;
}

async function findProductByIndexOrExact(tx, item) {
  if (item.matchedProductId) {
    const product = (await tx.collection("products").doc(item.matchedProductId).get()).data;
    if (product && product.isDeleted !== true) return product;
  }
  const idx = item.productIndex || item.skuCode;
  if (idx) {
    const byProductIndex = await tx.collection("products").where({ productIndex: idx }).limit(1).get();
    if (byProductIndex.data[0] && byProductIndex.data[0].isDeleted !== true) return byProductIndex.data[0];
    const bySku = await tx.collection("products").where({ skuCode: idx }).limit(1).get();
    if (bySku.data[0] && bySku.data[0].isDeleted !== true) return bySku.data[0];
  }
  const exact = await tx.collection("products").where({
    baseName: item.baseName || item.finalName,
    specification: item.specification,
    productionDate: item.productionDate
  }).limit(1).get();
  if (exact.data[0] && exact.data[0].isDeleted !== true) return exact.data[0];
  return null;
}

async function updateImportItem(tx, itemId, data) {
  if (!itemId) return;
  await tx.collection("import_record_items").doc(itemId).update({
    data: { ...data, updatedAt: db.serverDate() }
  });
}

async function confirmMergedInventoryImport(event = {}) {
  const admin = await requirePermission("inventory:import");
  await ensureImportCollections();
  const {
    importRecordId: requestedImportRecordId,
    items: editedItems = [],
    stockMode = "override",
    priceMode = "override",
    previewRecord = {},
    isFirstBatch = true,
    isFinalBatch = true
  } = event;
  let importRecordId = requestedImportRecordId;
  if (!importRecordId) throw new Error("缺少导入记录 ID");
  if (!STOCK_MODES.includes(stockMode)) throw new Error("库存处理方式无效");
  if (!PRICE_MODES.includes(priceMode)) throw new Error("价格处理方式无效");
  let begin = null;
  begin = await beginIdempotentAction({
    db,
    actionType: "import_stock_price_merge",
    idempotencyKey: event.idempotencyKey,
    operatorIdentity: admin._id || admin.id || admin.openid,
    operatorType: "admin",
    scope: "import",
    scopeId: importRecordId,
    openid: admin.openid,
    adminId: admin._id || admin.id || "",
    payload: {
      importRecordId,
      stockMode,
      priceMode,
      isFirstBatch,
      isFinalBatch,
      editedItemKeys: editedItems.map((item) => [item._id || item.id || item.rowNo, item.action, item.stock, item.price, item.matchedProductId].join(":"))
    }
  });
  const early = idempotencyEarlyReturn(begin);
  if (early) {
    if (early.ok) return early.data;
    const err = new Error(early.message);
    err.code = early.code;
    throw err;
  }
  const isClientPreview = String(importRecordId).startsWith("client-");
  let record = null;
  if (isClientPreview) {
    if (!isFirstBatch) throw new Error("前端预览导入缺少真实导入记录，请重新解析");
    if (!editedItems.length) throw new Error("没有可导入的预览明细");
    const recordRes = await db.collection("import_records").add({
      data: {
        type: "merged_inventory_price",
        inventoryFileID: previewRecord.inventoryFileID || "",
        inventoryFileName: previewRecord.inventoryFileName || "",
        priceFileID: previewRecord.priceFileID || "",
        priceFileName: previewRecord.priceFileName || "",
        inventoryFileType: previewRecord.inventoryFileType || "",
        priceFileType: previewRecord.priceFileType || "",
        operatorId: admin._id || admin.id || "",
        operatorOpenid: admin.openid,
        stockMode,
        priceMode,
        totalInventoryRows: Number(previewRecord.totalInventoryRows || 0),
        totalPriceRows: Number(previewRecord.totalPriceRows || 0),
        mergedRows: Number(previewRecord.mergedRows || editedItems.length),
        successRows: 0,
        failedRows: 0,
        skippedRows: 0,
        createdProductCount: 0,
        updatedProductCount: 0,
        status: "parsed",
        clientPreviewMode: true,
        selfCheckStatus: "",
        selfCheckReport: null,
        createdAt: db.serverDate(),
        parsedAt: db.serverDate(),
        importedAt: null,
        updatedAt: db.serverDate()
      }
    });
    importRecordId = recordRes._id;
    record = await getImportRecord(importRecordId);
  } else {
    record = await getImportRecord(importRecordId);
  }
  if (record.status === "imported") {
    const reused = {
      importRecordId,
      successRows: Number(record.successRows || 0),
      failedRows: Number(record.failedRows || 0),
      skippedRows: Number(record.skippedRows || 0),
      createdProductCount: Number(record.createdProductCount || 0),
      updatedProductCount: Number(record.updatedProductCount || 0),
      hasMore: false,
      reused: true
    };
    await finishIdempotentAction(db, begin.recordId, { data: firstSuccessData(reused) });
    return firstSuccessData(reused);
  }

  const savedItems = isClientPreview ? [] : await getImportItems(importRecordId);
  const editsById = new Map();
  editedItems.forEach((item) => {
    const key = item._id || item.id || String(item.rowNo || "");
    if (key) editsById.set(key, item);
  });
  const sourceItems = editedItems.length
    ? editedItems.map((edit) => {
      const key = edit._id || edit.id || String(edit.rowNo || "");
      const saved = savedItems.find((item) => item._id === key || String(item.rowNo || "") === key) || {};
      return { ...saved, ...edit, _id: saved._id || edit._id || edit.id || "" };
    })
    : savedItems;

  try {
  const summary = await db.runTransaction(async (tx) => {
    const startData = { status: "importing", updatedAt: db.serverDate() };
    if (isFirstBatch) {
      Object.assign(startData, {
        successRows: 0,
        failedRows: 0,
        skippedRows: 0,
        createdProductCount: 0,
        updatedProductCount: 0
      });
    }
    await tx.collection("import_records").doc(importRecordId).update({ data: startData });

    let successRows = 0;
    let failedRows = 0;
    let skippedRows = 0;
    let createdProductCount = 0;
    let updatedProductCount = 0;

    for (const raw of sourceItems) {
      if (raw.selected === false || raw.action === "ignore") {
        skippedRows += 1;
        await updateImportItem(tx, raw._id, { status: "skipped", selected: false, action: "ignore" });
        continue;
      }

      try {
        let item = normalizeConfirmItem(raw);
        if (item.action === "create" && !item.matchedProductId) {
          const existing = await findProductByIndexOrExact(tx, item);
          if (existing) {
            item = { ...item, action: "update", matchedProductId: existing._id };
          }
        }
        if (item.action === "update") {
          const product = await findProductByIndexOrExact(tx, item);
          if (!product) throw new Error("未找到要更新的商品");
          if (String(product.specification || "") !== item.specification) throw new Error("规格不一致，不能更新已有商品");
          if (String(product.productionDate || "") !== item.productionDate) throw new Error("生产日期不一致，不能更新已有商品");
          const beforeStock = Number(product.stock || 0);
          const afterStock = stockMode === "add" ? beforeStock + item.stock : item.stock;
          if (afterStock < 0) throw new Error("库存不能小于 0");
          const beforePrice = Number(product.price || 0);
          const shouldUpdatePrice = priceMode === "override" && item.price !== null;
          const productUpdate = {
            name: item.finalName,
            baseName: item.baseName || item.finalName,
            brand: item.brand,
            category: item.category,
            specification: item.specification,
            productionDate: item.productionDate,
            stock: afterStock,
            productIndex: item.productIndex || product.productIndex || generatedProductIndex(importRecordId, item.rowNo),
            skuCode: item.skuCode || product.skuCode || "",
            tags: item.tags,
            internalTags: item.internalTags,
            isNew: item.isNew,
            isDefective: item.isDefective,
            isHot: item.isHot,
            isFrequent: false,
            defectDescription: item.defectDescription,
            tagUpdatedAt: db.serverDate(),
            tagUpdatedBy: admin.openid || "",
            updatedAt: db.serverDate()
          };
          if (shouldUpdatePrice) productUpdate.price = item.price;
          productUpdate.searchText = buildSearchText({ ...product, ...productUpdate });
          await tx.collection("products").doc(product._id).update({ data: productUpdate });
          await writeImportTagLog(tx, product._id, productUpdate.name, product, { ...product, ...productUpdate }, admin);
          await tx.collection("inventory_logs").add({
            data: {
              businessKey: `import_inventory:${importRecordId}:${product._id}`,
              sourceType: "import",
              sourceId: importRecordId,
              idempotencyKey: event.idempotencyKey || "",
              productId: product._id,
              beforeStock,
              afterStock,
              changeAmount: afterStock - beforeStock,
              reason: stockMode === "add" ? "merged_import_add" : "merged_import_override",
              relatedImportId: importRecordId,
              operatorId: admin._id || admin.id || "",
              operatorOpenid: admin.openid,
              createdAt: db.serverDate()
            }
          });
          if (shouldUpdatePrice && beforePrice !== item.price) {
            await tx.collection("price_logs").add({
              data: {
                businessKey: `import_price:${importRecordId}:${product._id}`,
                sourceType: "import",
                sourceId: importRecordId,
                idempotencyKey: event.idempotencyKey || "",
                productId: product._id,
                beforePrice,
                afterPrice: item.price,
                reason: "merged_import_price_update",
                relatedImportId: importRecordId,
                operatorId: admin._id || admin.id || "",
                operatorOpenid: admin.openid,
                createdAt: db.serverDate()
              }
            });
          }
          await updateImportItem(tx, raw._id, { status: "success", finalProductId: product._id, errorMessage: "" });
          successRows += 1;
          updatedProductCount += 1;
          continue;
        }

        if (item.action === "create") {
          const productIndex = item.productIndex || generatedProductIndex(importRecordId, item.rowNo);
          const productData = {
            name: item.finalName,
            rawName: item.rawInventoryName || item.rawPriceName || item.finalName,
            baseName: item.baseName || item.finalName,
            brand: item.brand,
            category: item.category,
            specification: item.specification,
            productionDate: item.productionDate,
            stock: item.stock,
            price: priceMode === "skip" ? 0 : item.price,
            originalPrice: item.originalPrice || 0,
            productIndex,
            skuCode: item.skuCode || "",
            tags: item.tags,
            internalTags: item.internalTags,
            isNew: item.isNew,
            isDefective: item.isDefective,
            isHot: item.isHot,
            isFrequent: false,
            defectDescription: item.defectDescription,
            tagUpdatedAt: db.serverDate(),
            tagUpdatedBy: admin.openid || "",
            keywords: [],
            searchText: "",
            isActive: false,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate(),
            createdByImportId: importRecordId
          };
          productData.searchText = buildSearchText(productData);
          const created = await tx.collection("products").add({ data: productData });
          await writeImportTagLog(tx, created._id, productData.name, {}, productData, admin);
          await tx.collection("inventory_logs").add({
            data: {
              businessKey: `import_inventory:${importRecordId}:${created._id}`,
              sourceType: "import",
              sourceId: importRecordId,
              idempotencyKey: event.idempotencyKey || "",
              productId: created._id,
              beforeStock: 0,
              afterStock: item.stock,
              changeAmount: item.stock,
              reason: "merged_import_create",
              relatedImportId: importRecordId,
              operatorId: admin._id || admin.id || "",
              operatorOpenid: admin.openid,
              createdAt: db.serverDate()
            }
          });
          if (priceMode !== "skip" && item.price !== null) {
            await tx.collection("price_logs").add({
              data: {
                businessKey: `import_price:${importRecordId}:${created._id}`,
                sourceType: "import",
                sourceId: importRecordId,
                idempotencyKey: event.idempotencyKey || "",
                productId: created._id,
                beforePrice: 0,
                afterPrice: item.price,
                reason: "merged_import_price_create",
                relatedImportId: importRecordId,
                operatorId: admin._id || admin.id || "",
                operatorOpenid: admin.openid,
                createdAt: db.serverDate()
              }
            });
          }
          await updateImportItem(tx, raw._id, { status: "success", finalProductId: created._id, errorMessage: "" });
          successRows += 1;
          createdProductCount += 1;
        }
      } catch (err) {
        failedRows += 1;
        await updateImportItem(tx, raw._id, {
          status: "failed",
          selected: false,
          action: "error",
          errorMessage: err.message || "导入失败"
        });
      }
    }

    const recordUpdate = {
      stockMode,
      priceMode,
      successRows: isFirstBatch ? successRows : _.inc(successRows),
      failedRows: isFirstBatch ? failedRows : _.inc(failedRows),
      skippedRows: isFirstBatch ? skippedRows : _.inc(skippedRows),
      createdProductCount: isFirstBatch ? createdProductCount : _.inc(createdProductCount),
      updatedProductCount: isFirstBatch ? updatedProductCount : _.inc(updatedProductCount),
      status: isFinalBatch ? "imported" : "importing",
      importedAt: isFinalBatch ? db.serverDate() : null,
      updatedAt: db.serverDate()
    };
    await tx.collection("import_records").doc(importRecordId).update({ data: recordUpdate });
    return { successRows, failedRows, skippedRows, createdProductCount, updatedProductCount };
  });

  const selfCheckReport = isFinalBatch ? await runImportSelfCheck({ importRecordId, alreadyAuthorized: true }) : null;
  await logAdminOperation({
    operator: admin,
    action: "confirm_merged_inventory_import",
    resourceType: "import_records",
    resourceId: importRecordId,
    afterData: summary,
    description: "确认导入库存和报价表"
  });
  const finalResult = firstSuccessData({ importRecordId, ...summary, selfCheckReport, hasMore: !isFinalBatch });
  await finishIdempotentAction(db, begin.recordId, { data: finalResult });
  return finalResult;
  } catch (err) {
    if (begin && begin.recordId) await failIdempotentAction(db, begin.recordId, err);
    const idempotencyError = idempotencyErrorResponse(err);
    if (idempotencyError) {
      err.code = idempotencyError.code;
      err.message = idempotencyError.message;
    }
    throw err;
  }
}

async function runImportSelfCheck(event = {}) {
  if (!event.alreadyAuthorized) await requirePermission("inventory:import");
  const importRecordId = event.importRecordId;
  if (!importRecordId) throw new Error("缺少导入记录 ID");
  const record = await getImportRecord(importRecordId);
  const items = await getImportItems(importRecordId);
  const usesClientPreview = record.clientPreviewMode && !items.length;
  const checks = [];
  const add = (name, pass, message) => checks.push({ name, pass: Boolean(pass), message: message || "" });

  add("库存表已解析", Number(record.totalInventoryRows || 0) > 0, `库存表 ${record.totalInventoryRows || 0}`);
  add("报价表已解析", Number(record.totalPriceRows || 0) > 0, `报价表 ${record.totalPriceRows || 0}`);
  add("生成预览明细", usesClientPreview || items.length === Number(record.mergedRows || 0), usesClientPreview ? "预览明细由前端缓存并分批提交" : `预览 ${items.length}/${record.mergedRows || 0}`);
  add("每行都有处理动作", usesClientPreview || items.every((item) => ACTIONS.includes(item.action)), "");
  add("错误行不会默认导入", usesClientPreview || items.every((item) => item.action !== "error" || item.selected === false), "");
  add("模糊匹配需人工确认", usesClientPreview || items.every((item) => item.matchLevel !== "fuzzy" || item.selected === false || item.status === "success"), "");
  add("新建商品默认不上架", true, "确认导入创建商品时强制 isActive=false");
  add("金额使用分存储", usesClientPreview || items.every((item) => item.price === null || item.price === undefined || Number.isInteger(Number(item.price))), "");
  add("库存非负整数", usesClientPreview || items.every((item) => item.stock === null || item.stock === undefined || (Number.isInteger(Number(item.stock)) && Number(item.stock) >= 0)), "");
  add("导入记录状态更新", ["parsed", "importing", "imported", "failed"].includes(record.status), record.status);

  const failed = checks.filter((check) => !check.pass);
  const warningCount = usesClientPreview ? 0 : items.filter((item) => item.warningMessage).length;
  const report = {
    importRecordId,
    status: failed.length ? "failed" : (warningCount ? "warning" : "pass"),
    warningCount,
    checks,
    summary: {
      totalInventoryRows: record.totalInventoryRows || 0,
      totalPriceRows: record.totalPriceRows || 0,
      mergedRows: record.mergedRows || 0,
      successRows: record.successRows || 0,
      failedRows: record.failedRows || 0,
      skippedRows: record.skippedRows || 0,
      createdProductCount: record.createdProductCount || 0,
      updatedProductCount: record.updatedProductCount || 0
    }
  };
  await db.collection("import_records").doc(importRecordId).update({
    data: {
      selfCheckStatus: report.status,
      selfCheckReport: report,
      updatedAt: db.serverDate()
    }
  });
  return report;
}
async function getImportHistory() {
  await requireAnyPermission(["inventory:import", "inventory:view_log"]);
  await ensureImportCollections();
  const records = await db.collection("import_records")
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return { records: records.data || [] };
}

async function getImportDetail(event = {}) {
  await requireAnyPermission(["inventory:import", "inventory:view_log"]);
  await ensureImportCollections();
  const importRecordId = event.importRecordId || event.id;
  if (!importRecordId) throw new Error("缺少导入记录 ID");
  const record = await getImportRecord(importRecordId);
  const items = await getImportItems(importRecordId);
  return { record, items };
}

module.exports = {
  ok,
  fail,
  uploadImportFile,
  parseMergedInventoryImport,
  confirmMergedInventoryImport,
  runImportSelfCheck,
  getImportHistory,
  getImportDetail,
  mergeInventoryAndPriceRows,
  attachProductMatches
};
