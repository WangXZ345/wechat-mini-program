const cloud = require("wx-server-sdk");

const {
  buildStockStatusUpdate,
  normalizeWarningStock,
  syncStockAlertRecord
} = require("./stockAlert");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const ACTIONS = ["update", "create", "ignore", "error"];
const PROCESSED_ROW_SCAN_PAGE_SIZE = 500;
const PROCESSED_ROW_SCAN_MAX_ROWS = 10000;
const { requirePermission } = require("./auth");
const {
  beginIdempotentAction,
  finishIdempotentAction,
  failIdempotentAction,
  idempotencyEarlyReturn,
  idempotencyErrorResponse,
  firstSuccessData
} = require("./idempotency");
const {
  buildInventoryImportManifestHash,
  buildInventoryImportProof,
  normalizeProofText,
  productMatchesInventoryIdentity,
  scanInventoryProducts,
  samePreviewRowIdentity
} = require("./common/inventoryImportProof");

function ok(data) {
  return { ok: true, data };
}

function fail(message, code = "") {
  return code ? { ok: false, code, message } : { ok: false, message };
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

async function loadPreviewItems(record) {
  if (!record || !record.previewFileID) return [];
  const file = await cloud.downloadFile({ fileID: record.previewFileID });
  const text = file.fileContent.toString("utf8");
  const items = JSON.parse(text);
  return Array.isArray(items) ? items : [];
}

function previewConflict(message = "库存导入预览已失效，请重新解析库存文件") {
  const err = new Error(message);
  err.code = "INVENTORY_IMPORT_PREVIEW_CONFLICT";
  return err;
}

function importModeConflict(message = "库存导入模式与已开始处理的模式不一致") {
  const err = new Error(message);
  err.code = "INVENTORY_IMPORT_MODE_CONFLICT";
  return err;
}

function processedRowsTruncated(message = "已处理导入行超过安全扫描上限，无法确认导入完成状态") {
  const err = new Error(message);
  err.code = "INVENTORY_IMPORT_PROCESSED_ROWS_TRUNCATED";
  return err;
}

function indexPreviewItems(items = []) {
  const index = new Map();
  for (const item of items) {
    const rowNo = Number(item && item.rowNo || 0);
    if (!Number.isInteger(rowNo) || rowNo <= 0 || index.has(rowNo)) {
      if (rowNo > 0) index.set(rowNo, null);
      continue;
    }
    index.set(rowNo, item);
  }
  return index;
}

function manifestRowNumberSet(items = []) {
  const rowNos = new Set();
  for (const item of items) {
    const rowNo = Number(item && item.rowNo || 0);
    if (!Number.isInteger(rowNo) || rowNo <= 0 || rowNos.has(rowNo)) {
      throw previewConflict("库存导入预览包含无效或重复行号，请重新解析库存文件");
    }
    rowNos.add(rowNo);
  }
  return rowNos;
}

function assertPreviewRequestIdentityTypes(rawItem) {
  for (const field of ["productIndex", "skuCode"]) {
    if (!rawItem || typeof rawItem[field] !== "string") {
      throw previewConflict("库存导入商品索引和货号必须保持文本类型，请重新加载预览");
    }
  }
}

function assertClientPreviewBinding({ rawItem, manifestVerified, storedPreviewItem }) {
  if (!storedPreviewItem) {
    throw previewConflict("库存导入预览行不存在或重复，请重新解析库存文件");
  }
  const comparable = rawItem.action === "ignore"
    ? { ...rawItem, action: storedPreviewItem.action }
    : rawItem;
  if (!samePreviewRowIdentity(comparable, storedPreviewItem)) {
    throw previewConflict("库存导入预览行与确认内容不一致，请重新解析库存文件");
  }
  if (!manifestVerified) {
    throw previewConflict("旧库存预览缺少服务端摘要，不能授权写入商品，请重新解析库存文件");
  }

  const storedProof = normalizeProofText(storedPreviewItem.previewProof);
  if (!storedProof) {
    throw previewConflict("库存导入预览缺少可验证证明，请重新解析库存文件");
  }
  const requestProof = normalizeProofText(rawItem.previewProof);
  if (requestProof && requestProof !== storedProof) {
    throw previewConflict("库存导入预览证明不匹配，请重新解析库存文件");
  }
}

function assertStoredPreviewBinding({
  importRecordId,
  rawItem,
  currentProduct,
  manifestVerified,
  storedPreviewItem
}) {
  if (!storedPreviewItem) {
    throw previewConflict("库存导入预览行不存在或重复，请重新解析库存文件");
  }
  if (!samePreviewRowIdentity(rawItem, storedPreviewItem)) {
    throw previewConflict("库存导入预览行与确认内容不一致，请重新解析库存文件");
  }
  if (!manifestVerified) {
    throw previewConflict("旧库存预览缺少服务端摘要，不能授权写入商品，请重新解析库存文件");
  }

  const requestProof = normalizeProofText(rawItem.previewProof);
  const storedProof = normalizeProofText(storedPreviewItem.previewProof);
  if (!storedProof) {
    throw previewConflict("库存导入预览缺少可验证证明，请重新解析库存文件");
  }
  if (requestProof && (!storedProof || requestProof !== storedProof)) {
    throw previewConflict("库存导入预览证明不匹配，请重新解析库存文件");
  }
  if (!storedProof) return false;

  const currentProof = buildInventoryImportProof(importRecordId, storedPreviewItem, currentProduct);
  if (currentProof !== storedProof) {
    throw previewConflict("匹配商品身份已变化，请重新解析库存文件");
  }
  return true;
}

function assertSkippedPreviewBinding(rawItem, storedPreviewItem) {
  if (!storedPreviewItem) {
    throw previewConflict("库存导入预览行不存在或重复，请重新解析库存文件");
  }
  const comparable = rawItem.action === "ignore"
    ? { ...rawItem, action: storedPreviewItem.action }
    : rawItem;
  if (!samePreviewRowIdentity(comparable, storedPreviewItem)) {
    throw previewConflict("库存导入预览行与跳过内容不一致，请重新解析库存文件");
  }
}

function assertUniqueRequestRows(items) {
  const seen = new Set();
  for (const item of items) {
    const rowNo = Number(item && item.rowNo || 0);
    if (!Number.isInteger(rowNo) || rowNo <= 0 || seen.has(rowNo)) {
      throw previewConflict("确认请求包含无效或重复的预览行，请重新加载预览");
    }
    seen.add(rowNo);
  }
}

function importRowBusinessKey(importRecordId, rowNo) {
  return `import_row:${importRecordId}:row:${Number(rowNo || 0)}`;
}

function inventoryRowBusinessKey(importRecordId, rowNo) {
  return `import_inventory:${importRecordId}:row:${Number(rowNo || 0)}`;
}

function normalizePrice(value) {
  if (value === undefined || value === null || value === "") return null;
  const price = Number(value);
  if (!Number.isInteger(price) || price < 0) throw new Error("价格必须是非负整数，单位为分");
  return price;
}

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/(20\d{2})\s*[年./-]\s*(\d{1,2})\s*(?:月)?/g, (all, year, month) => `${year}-${String(month).padStart(2, "0")}`)
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

function generatedProductIndex(importRecordId, rowNo) {
  return `P${String(rowNo || 0).padStart(6, "0")}-${String(importRecordId || "").slice(-6)}`;
}

function normalizeItem(input) {
  const action = input.action === "ignore" ? "ignore" : input.action;
  const stock = Number(input.stock);
  const price = normalizePrice(input.price);
  const warningStock = normalizeWarningStock(input.warningStock);
  const baseName = String(input.baseName || "").trim();
  if (!ACTIONS.includes(action)) throw new Error("处理方式无效");
  if (action === "ignore") return { ...input, action, price };
  if (action === "error") throw new Error(input.errorMessage || "解析失败，不能导入");
  if (!baseName) throw new Error("商品名称为空");
  if (!Number.isInteger(stock)) throw new Error("库存不是整数");
  if (stock < 0) throw new Error("库存不能小于 0");
  return {
    rowNo: Number(input.rowNo || 0),
    rawName: String(input.rawName || baseName),
    baseName,
    specification: String(input.specification || "").trim(),
    productionDate: String(input.productionDate || "").trim(),
    productIndex: String(input.productIndex || "").trim(),
    skuCode: String(input.skuCode || "").trim(),
    stock,
    warningStock,
    price,
    matchedProductId: String(input.matchedProductId || ""),
    source: input.source === "quote" ? "quote" : "inventory",
    action
  };
}

function findStrictProductMatches(products, item) {
  return products.filter((product) => productMatchesInventoryIdentity(product, item));
}

async function findExistingImportItem(tx, importRecordId, rowNo, businessKey) {
  const byKey = await tx.collection("import_record_items").where({ businessKey }).limit(1).get();
  if (byKey.data && byKey.data[0]) return byKey.data[0];
  const legacy = await tx.collection("import_record_items").where({
    importRecordId,
    rowNo: Number(rowNo || 0)
  }).limit(1).get();
  return legacy.data && legacy.data[0] || null;
}

async function findExistingInventoryLog(tx, businessKey, legacyBusinessKey) {
  const byRow = await tx.collection("inventory_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
  if (byRow.data && byRow.data[0]) return byRow.data[0];
  if (!legacyBusinessKey) return null;
  const legacy = await tx.collection("inventory_logs").where({ businessKey: legacyBusinessKey }).limit(1).get().catch(() => ({ data: [] }));
  return legacy.data && legacy.data[0] || null;
}

function assertInventoryLogBinding({
  log,
  businessKey,
  legacyBusinessKey,
  importRecordId,
  item,
  mode,
  storedPreviewItems = []
}) {
  const actualKey = normalizeProofText(log && log.businessKey);
  const isRowKey = actualKey === businessKey;
  const isLegacyKey = Boolean(legacyBusinessKey) && actualKey === legacyBusinessKey;
  const beforeStock = log && log.beforeStock;
  const afterStock = log && log.afterStock;
  const changeAmount = log && log.changeAmount;
  const expectedReason = item.action === "create"
    ? "import_create"
    : mode === "add" ? "import_add" : "import_override";
  const rowNo = Number(item.rowNo || 0);

  if (!isRowKey && !isLegacyKey) {
    throw previewConflict("库存日志业务键与预览行不一致，请人工核对后重新解析");
  }
  if (
    normalizeProofText(log.sourceType) !== "import" ||
    normalizeProofText(log.sourceId) !== normalizeProofText(importRecordId) ||
    normalizeProofText(log.relatedImportId) !== normalizeProofText(importRecordId) ||
    (item.action === "create"
      ? !normalizeProofText(log.productId)
      : normalizeProofText(log.productId) !== normalizeProofText(item.matchedProductId))
  ) {
    throw previewConflict("库存日志归属与预览行不一致，请人工核对后重新解析");
  }
  if (
    (isRowKey && (!Number.isInteger(log.rowNo) || log.rowNo !== rowNo)) ||
    (isLegacyKey && log.rowNo !== undefined && log.rowNo !== null && log.rowNo !== "" &&
      (!Number.isInteger(log.rowNo) || log.rowNo !== rowNo))
  ) {
    throw previewConflict("库存日志行号与预览行不一致，请人工核对后重新解析");
  }
  if (isLegacyKey && (log.rowNo === undefined || log.rowNo === null || log.rowNo === "")) {
    const productRows = storedPreviewItems.filter((previewItem) =>
      normalizeProofText(previewItem && previewItem.matchedProductId) === normalizeProofText(item.matchedProductId)
    );
    if (productRows.length !== 1 || Number(productRows[0] && productRows[0].rowNo || 0) !== rowNo) {
      throw previewConflict("旧库存日志无法唯一归属到预览行，请人工核对后重新解析");
    }
  }
  if (
    !Number.isInteger(beforeStock) ||
    !Number.isInteger(afterStock) ||
    !Number.isInteger(changeAmount) ||
    afterStock - beforeStock !== changeAmount ||
    normalizeProofText(log.reason) !== expectedReason
  ) {
    throw previewConflict("库存日志变更量与预览行不一致，请人工核对后重新解析");
  }
  if (item.action === "create") {
    if (beforeStock !== 0 || afterStock !== item.stock || changeAmount !== item.stock) {
      throw previewConflict("库存日志新建数量与预览行不一致，请人工核对后重新解析");
    }
  } else if (mode === "add") {
    if (changeAmount !== item.stock) {
      throw previewConflict("库存日志增量与预览行不一致，请人工核对后重新解析");
    }
  } else if (afterStock !== item.stock) {
    throw previewConflict("库存日志覆盖数量与预览行不一致，请人工核对后重新解析");
  }
}

async function scanProcessedImportRowNos(tx, importRecordId) {
  const rowNos = new Set();
  let offset = 0;
  while (offset < PROCESSED_ROW_SCAN_MAX_ROWS) {
    const limit = Math.min(PROCESSED_ROW_SCAN_PAGE_SIZE, PROCESSED_ROW_SCAN_MAX_ROWS - offset);
    const result = await tx.collection("import_record_items")
      .where({ importRecordId })
      .orderBy("_id", "asc")
      .skip(offset)
      .limit(limit)
      .get();
    const page = Array.isArray(result && result.data) ? result.data : [];
    for (const item of page) {
      const rowNo = Number(item && item.rowNo || 0);
      if (Number.isInteger(rowNo) && rowNo > 0 && ACTIONS.includes(item.action)) {
        rowNos.add(rowNo);
      }
    }
    if (page.length < limit) return { rowNos, truncated: false };
    offset += page.length;
  }
  return { rowNos, truncated: true };
}

async function addImportItem(tx, importRecordId, item, extra) {
  const businessKey = importRowBusinessKey(importRecordId, item.rowNo);
  await tx.collection("import_record_items").add({
    data: {
      businessKey,
      importRecordId,
      rowNo: Number(item.rowNo || 0),
      rawName: item.rawName || "",
      baseName: item.baseName || "",
      specification: item.specification || "",
      productionDate: item.productionDate || "",
      productIndex: item.productIndex || "",
      skuCode: item.skuCode || "",
      stock: Number.isInteger(Number(item.stock)) ? Number(item.stock) : null,
      price: Number.isInteger(Number(item.price)) ? Number(item.price) : null,
      warningStock: normalizeWarningStock(item.warningStock),
      stockStatusAfterImport: item.stockStatusAfterImport || "",
      matchedProductId: item.matchedProductId || "",
      source: item.source || "inventory",
      quoteMatchedName: item.quoteMatchedName || "",
      quoteMatchScore: Number(item.quoteMatchScore || 0),
      quoteSourceLine: item.quoteSourceLine || "",
      action: item.action || "error",
      errorMessage: item.errorMessage || "",
      selected: item.selected !== false,
      finalProductId: "",
      ...extra,
      createdAt: db.serverDate()
    }
  });
}

exports.main = async (event) => {
  let begin = null;
  try {
    const admin = await requirePermission("inventory:import");
    const operatorId = admin.openid;
    await ensureCollection("import_records");
    await ensureCollection("import_record_items");
    await ensureCollection("stock_alert_records");
    await ensureCollection("price_logs");

    const { importRecordId, mode = "override", offset = 0, batchSize = 20, serverBatch = false } = event;
    if (!importRecordId) return fail("缺少导入记录 ID");
    if (!["override", "add"].includes(mode)) return fail("导入模式无效");

    const previewRecord = (await db.collection("import_records").doc(importRecordId).get()).data;
    if (!previewRecord) return fail("导入记录不存在");
    const previewFileID = normalizeProofText(previewRecord.previewFileID);
    const previewManifestHash = normalizeProofText(previewRecord.previewManifestHash);
    let storedPreviewItems;
    try {
      storedPreviewItems = await loadPreviewItems(previewRecord);
    } catch (err) {
      if (previewManifestHash) {
        throw previewConflict("库存导入预览内容无法验证，请重新解析库存文件");
      }
      throw err;
    }
    if (previewManifestHash && !previewFileID) {
      throw previewConflict("库存导入预览摘要缺少对应文件，请重新解析库存文件");
    }
    const manifestVerified = Boolean(previewManifestHash);
    if (manifestVerified && buildInventoryImportManifestHash(storedPreviewItems) !== previewManifestHash) {
      throw previewConflict("库存导入预览内容已变化，请重新解析库存文件");
    }
    const previewItemIndex = indexPreviewItems(storedPreviewItems);
    const manifestRowNos = manifestVerified ? manifestRowNumberSet(storedPreviewItems) : new Set();

    let isFirstBatch = event.isFirstBatch !== false;
    let isFinalBatch = event.isFinalBatch !== false;
    let items = Array.isArray(event.items) ? event.items : [];
    const usesServerItems = serverBatch || !items.length;
    let nextOffset = 0;
    let hasMore = false;

    if (usesServerItems) {
      const safeOffset = Math.max(0, Number(offset || 0));
      const safeBatchSize = Math.min(50, Math.max(1, Number(batchSize || 20)));
      items = storedPreviewItems.slice(safeOffset, safeOffset + safeBatchSize);
      nextOffset = safeOffset + items.length;
      hasMore = nextOffset < storedPreviewItems.length;
      isFirstBatch = safeOffset === 0;
      isFinalBatch = !hasMore;
    }
    if (!items.length && previewRecord.status !== "imported") return fail("没有可导入的明细");
    if (!usesServerItems) {
      for (const item of items) assertPreviewRequestIdentityTypes(item);
    }
    assertUniqueRequestRows(items);
    if (!usesServerItems) {
      for (const item of items) {
        assertClientPreviewBinding({
          rawItem: item,
          manifestVerified,
          storedPreviewItem: previewItemIndex.get(Number(item && item.rowNo || 0))
        });
      }
    }

    begin = await beginIdempotentAction({
      db,
      actionType: "import_inventory",
      idempotencyKey: event.idempotencyKey,
      operatorIdentity: admin._id || admin.id || admin.openid,
      operatorType: "admin",
      scope: "import",
      scopeId: importRecordId,
      openid: admin.openid,
      adminId: admin._id || admin.id || "",
      payload: {
        importRecordId,
        mode,
        itemKeys: items.map((item) => [item.rowNo, item.matchedProductId, item.action, item.stock, item.price].join(":")),
        isFirstBatch,
        isFinalBatch
      }
    });
    const early = idempotencyEarlyReturn(begin);
    if (early) return early;

    const result = await db.runTransaction(async (tx) => {
      const record = (await tx.collection("import_records").doc(importRecordId).get()).data;
      if (!record) throw new Error("导入记录不存在");
      if (
        normalizeProofText(record.previewFileID) !== previewFileID ||
        normalizeProofText(record.previewManifestHash) !== previewManifestHash
      ) {
        throw previewConflict("库存导入预览文件或摘要已变化，请重新解析库存文件");
      }
      const storedMode = ["override", "add"].includes(record.mode) ? record.mode : "";
      if (storedMode && storedMode !== mode) {
        throw importModeConflict();
      }
      const effectiveMode = storedMode || mode;
      if (record.status === "imported") {
        return {
          successRows: Number(record.successRows || 0),
          failedRows: Number(record.failedRows || 0),
          skippedRows: Number(record.skippedRows || 0),
          nextOffset,
          hasMore: false,
          reused: true
        };
      }

      let successRows = 0;
      let failedRows = 0;
      let skippedRows = 0;
      let committedSuccessRows = 0;
      let committedFailedRows = 0;
      let committedSkippedRows = 0;
      let transactionProducts = null;
      const processedRowNosThisTransaction = new Set();

      const loadTransactionProducts = async () => {
        if (transactionProducts) return transactionProducts;
        const scan = await scanInventoryProducts(tx.collection("products"));
        if (scan.truncated) {
          throw previewConflict("商品数量超过安全扫描上限，无法确认唯一匹配，请重新整理商品后重试");
        }
        transactionProducts = scan.products.filter((product) => product.isDeleted !== true);
        return transactionProducts;
      };

      for (const rawItem of items) {
        const rowNo = Number(rawItem && rawItem.rowNo || 0);
        const storedPreviewItem = previewItemIndex.get(rowNo);
        const rowItemBusinessKey = importRowBusinessKey(importRecordId, rowNo);
        const existingImportItem = await findExistingImportItem(tx, importRecordId, rowNo, rowItemBusinessKey);
        if (rawItem.selected === false || rawItem.action === "ignore") {
          assertSkippedPreviewBinding(rawItem, storedPreviewItem);
          if (existingImportItem) {
            skippedRows += 1;
            processedRowNosThisTransaction.add(rowNo);
            continue;
          }
          await addImportItem(tx, importRecordId, rawItem, {
            action: "ignore",
            selected: false,
            errorMessage: rawItem.errorMessage || ""
          });
          skippedRows += 1;
          committedSkippedRows += 1;
          processedRowNosThisTransaction.add(rowNo);
          continue;
        }

        let rowWriteStarted = false;
        try {
          const item = normalizeItem(rawItem);
          if (item.action === "update") {
            if (!item.matchedProductId) throw new Error("缺少要更新的商品 ID");
            const isQuoteOnly = item.source === "quote";
            const product = (await tx.collection("products").doc(item.matchedProductId).get()).data;
            if (!product || product.isDeleted === true) {
              throw previewConflict("匹配商品不存在或已删除，请重新解析库存文件");
            }
            assertStoredPreviewBinding({
              importRecordId,
              rawItem,
              currentProduct: product,
              manifestVerified,
              storedPreviewItem
            });
            const strictMatches = findStrictProductMatches(await loadTransactionProducts(), item);
            if (strictMatches.length !== 1 || String(strictMatches[0]._id || "") !== item.matchedProductId) {
              throw previewConflict("匹配商品不再唯一或身份已变化，请重新解析库存文件");
            }
            if (existingImportItem && existingImportItem.action === "error") {
              failedRows += 1;
              processedRowNosThisTransaction.add(item.rowNo);
              continue;
            }
            const businessKey = inventoryRowBusinessKey(importRecordId, item.rowNo);
            if (!isQuoteOnly) {
              const legacyBusinessKey = `import_inventory:${importRecordId}:${item.matchedProductId}`;
              const existingInventoryLog = await findExistingInventoryLog(
                tx,
                businessKey,
                legacyBusinessKey
              );
              if (existingInventoryLog) {
                assertInventoryLogBinding({
                  log: existingInventoryLog,
                  businessKey,
                  legacyBusinessKey,
                  importRecordId,
                  item,
                  mode: effectiveMode,
                  storedPreviewItems
                });
                if (!existingImportItem) {
                  await addImportItem(tx, importRecordId, item, {
                    action: "update",
                    selected: true,
                    finalProductId: item.matchedProductId,
                    errorMessage: ""
                  });
                }
                successRows += 1;
                processedRowNosThisTransaction.add(item.rowNo);
                continue;
              }
              if (existingImportItem) {
                throw previewConflict("导入行已有结果但缺少库存日志，请人工核对后重新解析");
              }
            } else if (existingImportItem) {
              successRows += 1;
              processedRowNosThisTransaction.add(item.rowNo);
              continue;
            }
            const beforeStock = Number(product.stock || 0);
            const beforePrice = Number(product.price || 0);
            const afterStock = isQuoteOnly ? beforeStock : (effectiveMode === "add" ? beforeStock + item.stock : item.stock);
            if (afterStock < 0) throw new Error("库存不能小于 0");
            const warningStock = rawItem.warningStock === undefined || rawItem.warningStock === null || rawItem.warningStock === ""
              ? normalizeWarningStock(product.warningStock)
              : normalizeWarningStock(rawItem.warningStock);
            const productUpdate = isQuoteOnly
              ? {
                productIndex: item.productIndex || product.productIndex || generatedProductIndex(importRecordId, item.rowNo),
                skuCode: item.skuCode || product.skuCode || "",
                updatedAt: db.serverDate()
              }
              : {
                ...buildStockStatusUpdate(product, {
                  stock: afterStock,
                  warningStock,
                  autoHideWhenOutOfStock: product.autoHideWhenOutOfStock,
                  now: db.serverDate()
                }),
                productIndex: item.productIndex || product.productIndex || generatedProductIndex(importRecordId, item.rowNo),
                skuCode: item.skuCode || product.skuCode || ""
              };
            if (item.price !== null) productUpdate.price = item.price;
            if (isQuoteOnly && item.price !== null && item.price > 0) productUpdate.isActive = true;
            productUpdate.searchText = buildProductSearchText({ ...product, ...productUpdate });
            rowWriteStarted = true;
            await tx.collection("products").doc(item.matchedProductId).update({ data: productUpdate });
            if (item.price !== null && beforePrice !== item.price) {
              const priceBusinessKey = `import_price:${importRecordId}:${item.matchedProductId}`;
              const existingPriceLog = await tx.collection("price_logs").where({ businessKey: priceBusinessKey }).limit(1).get().catch(() => ({ data: [] }));
              if (!existingPriceLog.data || !existingPriceLog.data[0]) {
                await tx.collection("price_logs").add({
                  data: {
                    businessKey: priceBusinessKey,
                    sourceType: isQuoteOnly ? "quote_import" : "inventory_import",
                    sourceId: importRecordId,
                    idempotencyKey: event.idempotencyKey || "",
                    productId: item.matchedProductId,
                    productIndex: productUpdate.productIndex || product.productIndex || "",
                    productName: product.name || item.baseName || "",
                    beforePrice,
                    afterPrice: item.price,
                    changeType: "set",
                    changeValue: item.price,
                    operatorId,
                    operatorOpenid: operatorId,
                    operatorRole: admin.role || "",
                    reason: isQuoteOnly ? "quote_import_price_update" : "inventory_import_price_update",
                    createdAt: db.serverDate()
                  }
                });
              }
            }
            if (!isQuoteOnly) {
              await syncStockAlertRecord({ db, store: tx }, item.matchedProductId, { ...product, ...productUpdate }, productUpdate.stockStatus, operatorId);
              await tx.collection("inventory_logs").add({
                data: {
                  businessKey,
                  rowNo: item.rowNo,
                  sourceType: "import",
                  sourceId: importRecordId,
                  idempotencyKey: event.idempotencyKey || "",
                  productId: item.matchedProductId,
                  beforeStock,
                  afterStock,
                  changeAmount: afterStock - beforeStock,
                  reason: effectiveMode === "add" ? "import_add" : "import_override",
                  relatedImportId: importRecordId,
                  operatorId,
                  stockStatusBefore: product.stockStatus || "",
                  stockStatusAfter: productUpdate.stockStatus,
                  warningStock,
                  triggeredAlert: productUpdate.stockStatus === "warning" || productUpdate.stockStatus === "out_of_stock",
                  createdAt: db.serverDate()
                }
              });
            }
            await addImportItem(tx, importRecordId, item, {
              action: "update",
              selected: true,
              finalProductId: item.matchedProductId,
              errorMessage: ""
            });
            successRows += 1;
            committedSuccessRows += 1;
            processedRowNosThisTransaction.add(item.rowNo);
            continue;
          }

          if (item.action === "create") {
            const isQuoteOnly = item.source === "quote";
            assertStoredPreviewBinding({
              importRecordId,
              rawItem,
              currentProduct: null,
              manifestVerified,
              storedPreviewItem
            });
            const products = await loadTransactionProducts();
            const exact = findStrictProductMatches(products, item);
            if (existingImportItem && existingImportItem.action === "error") {
              if (exact.length) {
                throw previewConflict("相同商品已存在，预览匹配结果已变化，请重新解析库存文件");
              }
              failedRows += 1;
              processedRowNosThisTransaction.add(item.rowNo);
              continue;
            }
            const businessKey = inventoryRowBusinessKey(importRecordId, item.rowNo);
            if (!isQuoteOnly) {
              const existingInventoryLog = await findExistingInventoryLog(tx, businessKey, "");
              if (existingInventoryLog) {
                assertInventoryLogBinding({
                  log: existingInventoryLog,
                  businessKey,
                  legacyBusinessKey: "",
                  importRecordId,
                  item,
                  mode: effectiveMode
                });
                const finalProductId = normalizeProofText(existingInventoryLog.productId);
                const strictMatches = findStrictProductMatches(products, item);
                if (strictMatches.length !== 1 || normalizeProofText(strictMatches[0]._id) !== finalProductId) {
                  throw previewConflict("已新建商品不再唯一或身份已变化，请人工核对后重新解析");
                }
                if (!existingImportItem) {
                  await addImportItem(tx, importRecordId, item, {
                    action: "create",
                    selected: true,
                    finalProductId,
                    errorMessage: ""
                  });
                }
                successRows += 1;
                processedRowNosThisTransaction.add(item.rowNo);
                continue;
              }
              if (existingImportItem) {
                throw previewConflict("导入行已有结果但缺少库存日志，请人工核对后重新解析");
              }
            } else if (existingImportItem) {
              successRows += 1;
              processedRowNosThisTransaction.add(item.rowNo);
              continue;
            }
            if (exact.length) throw previewConflict("相同商品已存在，预览匹配结果已变化，请重新解析库存文件");
            const productIndex = item.productIndex || generatedProductIndex(importRecordId, item.rowNo);
            const productData = {
              name: item.baseName,
              baseName: item.baseName,
              rawName: item.rawName,
              imageUrl: "",
              specification: item.specification,
              productionDate: item.productionDate,
              productIndex,
              skuCode: item.skuCode,
              keywords: [],
              stock: item.stock,
              warningStock: item.warningStock,
              price: item.price === null ? 0 : item.price,
              description: "",
              isActive: item.price !== null && item.price > 0,
              autoHideWhenOutOfStock: false,
              createdAt: db.serverDate(),
              updatedAt: db.serverDate()
            };
            Object.assign(productData, buildStockStatusUpdate(productData, {
              stock: item.stock,
              warningStock: item.warningStock,
              autoHideWhenOutOfStock: false,
              now: productData.updatedAt
            }));
            productData.searchText = buildProductSearchText(productData);
            rowWriteStarted = true;
            const created = await tx.collection("products").add({
              data: productData
            });
            products.push({ _id: created._id, ...productData });
            if (!isQuoteOnly) {
              await syncStockAlertRecord({ db, store: tx }, created._id, productData, productData.stockStatus, operatorId);
              await tx.collection("inventory_logs").add({
                data: {
                  businessKey,
                  rowNo: item.rowNo,
                  sourceType: "import",
                  sourceId: importRecordId,
                  idempotencyKey: event.idempotencyKey || "",
                  productId: created._id,
                  beforeStock: 0,
                  afterStock: item.stock,
                  changeAmount: item.stock,
                  reason: "import_create",
                  relatedImportId: importRecordId,
                  operatorId,
                  stockStatusBefore: "out_of_stock",
                  stockStatusAfter: productData.stockStatus,
                  warningStock: productData.warningStock,
                  triggeredAlert: productData.stockStatus === "warning" || productData.stockStatus === "out_of_stock",
                  createdAt: db.serverDate()
                }
              });
            }
            if (item.price !== null && item.price > 0) {
              await tx.collection("price_logs").add({
                data: {
                  businessKey: `import_price:${importRecordId}:${created._id}`,
                  sourceType: isQuoteOnly ? "quote_import" : "inventory_import",
                  sourceId: importRecordId,
                  idempotencyKey: event.idempotencyKey || "",
                  productId: created._id,
                  productIndex,
                  productName: productData.name || "",
                  beforePrice: 0,
                  afterPrice: item.price,
                  changeType: "create",
                  changeValue: item.price,
                  operatorId,
                  operatorOpenid: operatorId,
                  operatorRole: admin.role || "",
                  reason: isQuoteOnly ? "quote_import_price_create" : "inventory_import_price_create",
                  createdAt: db.serverDate()
                }
              });
            }
            await addImportItem(tx, importRecordId, item, {
              action: "create",
              selected: true,
              finalProductId: created._id,
              errorMessage: ""
            });
            successRows += 1;
            committedSuccessRows += 1;
            processedRowNosThisTransaction.add(item.rowNo);
          }
        } catch (err) {
          if (err && err.code === "INVENTORY_IMPORT_PREVIEW_CONFLICT") throw err;
          if (rowWriteStarted) throw err;
          failedRows += 1;
          await addImportItem(tx, importRecordId, rawItem, {
            action: "error",
            selected: false,
            errorMessage: err.message || "导入失败"
          });
          committedFailedRows += 1;
          processedRowNosThisTransaction.add(Number(rawItem && rawItem.rowNo || 0));
        }
      }

      let importComplete = false;
      if (manifestVerified) {
        const processedScan = await scanProcessedImportRowNos(tx, importRecordId);
        if (processedScan.truncated) throw processedRowsTruncated();
        for (const rowNo of processedRowNosThisTransaction) processedScan.rowNos.add(rowNo);
        importComplete = Array.from(manifestRowNos).every((rowNo) => processedScan.rowNos.has(rowNo));
      }
      const updateData = {
        mode: effectiveMode,
        status: importComplete ? "imported" : "importing",
        importedAt: importComplete ? db.serverDate() : null
      };
      if (isFirstBatch && record.status === "parsed") {
        updateData.successRows = committedSuccessRows;
        updateData.failedRows = committedFailedRows;
        updateData.skippedRows = committedSkippedRows;
      } else {
        updateData.successRows = _.inc(committedSuccessRows);
        updateData.failedRows = _.inc(committedFailedRows);
        updateData.skippedRows = _.inc(committedSkippedRows);
      }

      await tx.collection("import_records").doc(importRecordId).update({ data: updateData });
      return { successRows, failedRows, skippedRows, nextOffset, hasMore };
    });

    await finishIdempotentAction(db, begin.recordId, { data: firstSuccessData({ importRecordId, ...result }) });
    return ok(firstSuccessData({ importRecordId, ...result }));
  } catch (err) {
    if (begin && begin.recordId) await failIdempotentAction(db, begin.recordId, err);
    const idempotencyError = idempotencyErrorResponse(err);
    if (idempotencyError) return idempotencyError;
    return fail(err.message || "确认导入失败", err.code || "");
  }
};

