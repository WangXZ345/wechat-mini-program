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
const { requirePermission } = require("./auth");
const {
  beginIdempotentAction,
  finishIdempotentAction,
  failIdempotentAction,
  idempotencyEarlyReturn,
  idempotencyErrorResponse,
  firstSuccessData
} = require("./idempotency");

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

async function loadPreviewItems(record) {
  if (!record || !record.previewFileID) return [];
  const file = await cloud.downloadFile({ fileID: record.previewFileID });
  const text = file.fileContent.toString("utf8");
  const items = JSON.parse(text);
  return Array.isArray(items) ? items : [];
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

async function findExactProduct(tx, item) {
  const res = await tx.collection("products").where({
    name: item.baseName,
    specification: item.specification,
    productionDate: item.productionDate
  }).limit(2).get();
  return res.data.filter((product) => product.isDeleted !== true);
}

async function addImportItem(tx, importRecordId, item, extra) {
  await tx.collection("import_record_items").add({
    data: {
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
    let isFirstBatch = event.isFirstBatch !== false;
    let isFinalBatch = event.isFinalBatch !== false;
    let items = Array.isArray(event.items) ? event.items : [];
    let nextOffset = 0;
    let hasMore = false;

    if (importRecordId && (serverBatch || !items.length)) {
      const record = (await db.collection("import_records").doc(importRecordId).get()).data;
      if (!record) return fail("导入记录不存在");
      if (record.status === "imported") return fail("导入记录已确认");
      const allItems = await loadPreviewItems(record);
      const safeOffset = Math.max(0, Number(offset || 0));
      const safeBatchSize = Math.min(50, Math.max(1, Number(batchSize || 20)));
      items = allItems.slice(safeOffset, safeOffset + safeBatchSize);
      nextOffset = safeOffset + items.length;
      hasMore = nextOffset < allItems.length;
      isFirstBatch = safeOffset === 0;
      isFinalBatch = !hasMore;
    }
    if (!importRecordId) return fail("缺少导入记录 ID");
    if (!["override", "add"].includes(mode)) return fail("导入模式无效");
    if (!items.length) return fail("没有可导入的明细");

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

      for (const rawItem of items) {
        if (rawItem.selected === false || rawItem.action === "ignore") {
          await addImportItem(tx, importRecordId, rawItem, {
            action: "ignore",
            selected: false,
            errorMessage: rawItem.errorMessage || ""
          });
          skippedRows += 1;
          continue;
        }

        try {
          const item = normalizeItem(rawItem);
          if (item.action === "update") {
            if (!item.matchedProductId) throw new Error("缺少要更新的商品 ID");
            const product = (await tx.collection("products").doc(item.matchedProductId).get()).data;
            if (!product) throw new Error("匹配商品不存在");
            if (product.isDeleted === true) throw new Error("匹配商品已删除，请重新解析库存文件");
            if (String(product.specification || "") !== item.specification) throw new Error("规格不一致，不能更新库存");
            if (String(product.productionDate || "") !== item.productionDate) throw new Error("生产日期不一致，不能更新库存");
            const isQuoteOnly = item.source === "quote";
            const beforeStock = Number(product.stock || 0);
            const beforePrice = Number(product.price || 0);
            const afterStock = isQuoteOnly ? beforeStock : (mode === "add" ? beforeStock + item.stock : item.stock);
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
              const businessKey = `import_inventory:${importRecordId}:${item.matchedProductId}`;
              const existingInventoryLog = await tx.collection("inventory_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
              if (existingInventoryLog.data && existingInventoryLog.data[0]) {
                await addImportItem(tx, importRecordId, item, {
                  action: "update",
                  selected: true,
                  finalProductId: item.matchedProductId,
                  errorMessage: ""
                });
                successRows += 1;
                continue;
              }
              await syncStockAlertRecord({ db, store: tx }, item.matchedProductId, { ...product, ...productUpdate }, productUpdate.stockStatus, operatorId);
              await tx.collection("inventory_logs").add({
                data: {
                  businessKey,
                  sourceType: "import",
                  sourceId: importRecordId,
                  idempotencyKey: event.idempotencyKey || "",
                  productId: item.matchedProductId,
                  beforeStock,
                  afterStock,
                  changeAmount: afterStock - beforeStock,
                  reason: mode === "add" ? "import_add" : "import_override",
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
            continue;
          }

          if (item.action === "create") {
            const isQuoteOnly = item.source === "quote";
            const exact = await findExactProduct(tx, item);
            if (exact.length) throw new Error("相同商品已存在，请使用更新方式");
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
            const created = await tx.collection("products").add({
              data: productData
            });
            if (!isQuoteOnly) {
              const businessKey = `import_inventory:${importRecordId}:${created._id}`;
              await syncStockAlertRecord({ db, store: tx }, created._id, productData, productData.stockStatus, operatorId);
              await tx.collection("inventory_logs").add({
                data: {
                  businessKey,
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
          }
        } catch (err) {
          failedRows += 1;
          await addImportItem(tx, importRecordId, rawItem, {
            action: "error",
            selected: false,
            errorMessage: err.message || "导入失败"
          });
        }
      }

      const updateData = {
        mode,
        status: isFinalBatch ? "imported" : "importing",
        importedAt: isFinalBatch ? db.serverDate() : null
      };
      if (isFirstBatch) {
        updateData.successRows = successRows;
        updateData.failedRows = failedRows;
        updateData.skippedRows = skippedRows;
      } else {
        updateData.successRows = _.inc(successRows);
        updateData.failedRows = _.inc(failedRows);
        updateData.skippedRows = _.inc(skippedRows);
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
    return fail(err.message || "确认导入失败");
  }
};

