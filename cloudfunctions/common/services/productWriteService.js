const crypto = require("crypto");
const {
  createInventoryMutationPlan,
  normalizeExpectedStock,
  writeInventoryMutationEffects
} = require("./inventoryMutationService");

const CREATE_ACTION = "create_product";
const EDIT_ACTION = "edit_product_metadata";
const LEGACY_UPDATE_ACTION = "legacy_update_product";
const CREATE_PERMISSION = "product:create";
const UPDATE_PERMISSION = "product:update";
const SYNC_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRODUCT_INDEX_COUNTER_ID = "product_index";
const PUBLIC_TAGS = new Set(["新货", "瑕疵", "热销"]);
const METADATA_FIELDS = Object.freeze([
  "name",
  "baseName",
  "imageUrl",
  "specification",
  "productionDate",
  "description",
  "productIndex",
  "skuCode",
  "keywords"
]);

class ProductWriteError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "ProductWriteError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function checkedString(value, field, max, required = false, requiredCode = "FIELD_REQUIRED") {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new ProductWriteError("FIELD_TYPE_INVALID", `${field}格式无效`, 400, { field });
  }
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (required && !raw) {
    const message = requiredCode === "PRODUCT_NAME_REQUIRED" ? "商品名称不能为空" : requiredCode === "PRODUCT_ID_REQUIRED" ? "缺少商品 ID" : `${field}不能为空`;
    throw new ProductWriteError(requiredCode, message, 400);
  }
  if (raw.length > max) throw new ProductWriteError("FIELD_TOO_LONG", `${field}内容过长`, 400, { field, max });
  return raw;
}

function hasPermission(actor, permission) {
  if (!actor || actor.status !== "active" || actor.isActive === false) return false;
  if (actor.role === "super_admin") return true;
  return actor.role === "procurement"
    && Array.isArray(actor.permissions)
    && (actor.permissions.includes("*") || actor.permissions.includes(permission));
}

function normalizeActor(actor = {}, permission) {
  const id = cleanString(actor.id || actor._id || actor.openid, 128);
  const role = cleanString(actor.role, 50);
  if (!id || !role) throw new ProductWriteError("INVALID_ACTOR", "管理员身份无效", 403);
  if (!hasPermission(actor, permission)) throw new ProductWriteError("FORBIDDEN", "无权维护商品资料", 403);
  return {
    id,
    openid: cleanString(actor.openid, 128),
    role,
    permissions: Array.isArray(actor.permissions) ? actor.permissions.slice() : [],
    sourceClient: actor.sourceClient === "miniprogram" ? "miniprogram" : "admin_web"
  };
}

function normalizeExpectedVersion(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ProductWriteError("EXPECTED_VERSION_REQUIRED", "缺少数据版本，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProductWriteError("EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
  }
  return value;
}

function versionOf(product = {}) {
  const raw = product.version !== undefined ? product.version : product.dataVersion;
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ProductWriteError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  return raw;
}

function normalizeInteger(value, field, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    const code = field === "price" ? "PRICE_INVALID" : field === "stock" ? "STOCK_INVALID" : "WARNING_STOCK_INVALID";
    const message = field === "price" ? "售价必须是非负整数分" : field === "stock" ? "库存必须是非负整数" : "预警库存必须是 0 到 99999 的整数";
    throw new ProductWriteError(code, message, 400);
  }
  return value;
}

function normalizeKeywords(value, maxCount = 50) {
  if (value !== undefined && value !== null && !Array.isArray(value) && typeof value !== "string") {
    throw new ProductWriteError("KEYWORDS_INVALID", "关键词格式无效", 400);
  }
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,，、\s]+/);
  const values = Array.from(new Set(raw.map((item) => String(item || "").trim()).filter(Boolean)));
  if (values.length > maxCount || values.some((item) => item.length > 40)) {
    throw new ProductWriteError("KEYWORDS_INVALID", `关键词最多 ${maxCount} 个，单个最多 40 个字`, 400);
  }
  return values;
}

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
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
  return normalizeSearchText([
    product.name,
    product.baseName,
    product.brand,
    product.category,
    product.specification,
    product.productionDate,
    product.description,
    product.productIndex,
    product.skuCode,
    Array.isArray(product.keywords) ? product.keywords.join(" ") : product.keywords,
    Array.isArray(product.tags) ? product.tags.join(" ") : ""
  ].filter(Boolean).join(" "));
}

function normalizeMetadata(input = {}, options = {}) {
  const requireName = options.requireName !== false;
  const strict = options.strict === true;
  const name = checkedString(input.name, "商品名称", 160, requireName, "PRODUCT_NAME_REQUIRED");
  return {
    name,
    baseName: checkedString(input.baseName, "商品基础名称", 160) || name,
    imageUrl: checkedString(input.imageUrl, "商品图片地址", strict ? 500 : 1000),
    specification: checkedString(input.specification, "商品规格", strict ? 120 : 160),
    productionDate: checkedString(input.productionDate, "生产日期", 40),
    description: checkedString(input.description, "商品说明", strict ? 1000 : 2000),
    productIndex: checkedString(input.productIndex, "商品索引", 80),
    skuCode: checkedString(input.skuCode, "货号编码", 80),
    keywords: normalizeKeywords(input.keywords, strict ? 20 : 50)
  };
}

function normalizePublicTags(value) {
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    throw new ProductWriteError("PUBLIC_TAGS_INVALID", "公开标签格式无效", 400);
  }
  const tags = Array.from(new Set((value || []).map((item) => String(item || "").trim()).filter(Boolean)));
  if (tags.some((tag) => !PUBLIC_TAGS.has(tag))) throw new ProductWriteError("PUBLIC_TAGS_INVALID", "公开标签包含非法值", 400);
  return tags;
}

function normalizeInternalTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,，、\s/;；|]+/);
  const tags = Array.from(new Set(raw.map((item) => String(item || "").trim()).filter(Boolean)));
  if (tags.length > 20 || tags.some((tag) => tag.length > 10)) {
    throw new ProductWriteError("INTERNAL_TAGS_INVALID", "内部标签最多 20 个，单个最多 10 个字", 400);
  }
  return tags;
}

function normalizeCreateInput(input = {}, legacy = false) {
  const metadata = normalizeMetadata(input, { strict: !legacy });
  const rawPrice = legacy ? Number(input.price) : input.priceCents;
  const rawStock = legacy ? Number(input.stock) : input.stock;
  const rawWarning = input.warningStock === undefined || input.warningStock === "" ? 10 : Number(input.warningStock);
  const tags = normalizePublicTags(input.publicTags === undefined ? input.tags : input.publicTags);
  const flags = {
    isNew: tags.includes("新货"),
    isDefective: tags.includes("瑕疵"),
    isHot: tags.includes("热销"),
    isFrequent: false
  };
  if (legacy) {
    for (const [flag, tag] of [["isNew", "新货"], ["isDefective", "瑕疵"], ["isHot", "热销"]]) {
      if (input[flag] === true && !tags.includes(tag)) tags.push(tag);
      if (input[flag] === false) {
        const index = tags.indexOf(tag);
        if (index >= 0) tags.splice(index, 1);
      }
    }
    flags.isNew = tags.includes("新货");
    flags.isDefective = tags.includes("瑕疵");
    flags.isHot = tags.includes("热销");
  }
  return {
    ...metadata,
    price: normalizeInteger(rawPrice, "price"),
    stock: normalizeInteger(rawStock, "stock", legacy ? Number.MAX_SAFE_INTEGER : 9999999),
    warningStock: normalizeInteger(rawWarning, "warningStock", 99999),
    autoHideWhenOutOfStock: input.autoHideWhenOutOfStock === true,
    isActive: input.isActive !== false,
    tags,
    internalTags: legacy ? normalizeInternalTags(input.internalTags) : [],
    ...flags,
    defectDescription: legacy ? checkedString(input.defectDescription, "瑕疵说明", 1000) : "",
    reason: checkedString(input.reason, "操作说明", 120)
  };
}

function normalizeMetadataUpdateInput(input = {}, requireExpectedVersion = true) {
  const productId = checkedString(input.productId, "商品 ID", 128, true, "PRODUCT_ID_REQUIRED");
  const metadata = {};
  for (const field of METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (field === "keywords") metadata.keywords = normalizeKeywords(input.keywords, 20);
    else if (field === "name") metadata.name = checkedString(input.name, "商品名称", 160, true, "PRODUCT_NAME_REQUIRED");
    else {
      const labels = {
        baseName: "商品基础名称", imageUrl: "商品图片地址", specification: "商品规格", productionDate: "生产日期",
        description: "商品说明", productIndex: "商品索引", skuCode: "货号编码"
      };
      const limits = { baseName: 160, imageUrl: 500, specification: 120, productionDate: 40, description: 1000, productIndex: 80, skuCode: 80 };
      metadata[field] = checkedString(input[field], labels[field], limits[field]);
      if (field === "productIndex" && !metadata[field]) {
        throw new ProductWriteError("PRODUCT_INDEX_REQUIRED", "商品索引不能为空", 400);
      }
    }
  }
  return {
    productId,
    ...metadata,
    expectedVersion: normalizeExpectedVersion(input.expectedVersion, requireExpectedVersion),
    reason: checkedString(input.reason, "操作说明", 120)
  };
}

function normalizeLegacyFullInput(input = {}) {
  const productId = checkedString(input.productId, "商品 ID", 128, true, "PRODUCT_ID_REQUIRED");
  let expectedStock;
  try {
    expectedStock = normalizeExpectedStock(input.expectedStock, false);
  } catch (error) {
    throw new ProductWriteError(error.code || "EXPECTED_STOCK_INVALID", error.message || "当前库存无效，请刷新后重试", error.statusCode || 400, error.details);
  }
  return {
    productId,
    ...normalizeCreateInput(input.product || {}, true),
    expectedVersion: normalizeExpectedVersion(input.expectedVersion, false),
    expectedStock,
    reason: checkedString(input.reason, "操作说明", 120)
  };
}

function stockStatus(stock, warningStock) {
  if (stock <= 0) return "out_of_stock";
  return stock <= warningStock ? "warning" : "normal";
}

function missingDocument(error) {
  return /DOCUMENT_NOT_EXIST|document not exist|not found|ResourceNotFound/i.test(String(error && error.message || error || ""));
}

function deterministicKey(prefix, value) {
  const digest = crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40);
  return `${prefix}:${digest}`;
}

function indexValue(sequence) {
  return `P${String(sequence).padStart(6, "0")}`;
}

async function assertIndexAvailable(store, productIndex, productId = "") {
  const duplicate = await store.collection("products").where({ productIndex }).limit(20).get();
  if ((duplicate.data || []).some((item) => item._id !== productId)) {
    throw new ProductWriteError("PRODUCT_INDEX_DUPLICATE", "商品索引重复", 409);
  }
}

async function allocateProductIndex(store, requested) {
  if (requested) {
    await assertIndexAvailable(store, requested);
    return requested;
  }
  const counter = store.collection("system_counters").doc(PRODUCT_INDEX_COUNTER_ID);
  let row = null;
  try {
    row = (await counter.get()).data;
  } catch (error) {
    if (!missingDocument(error)) throw error;
  }
  let sequence = row && Number.isSafeInteger(row.value) && row.value >= 0 ? row.value : 0;
  let candidate = "";
  do {
    sequence += 1;
    candidate = indexValue(sequence);
    const duplicate = await store.collection("products").where({ productIndex: candidate }).limit(1).get();
    if (!duplicate.data || duplicate.data.length === 0) break;
  } while (sequence < 999999999);
  if (!candidate) throw new ProductWriteError("PRODUCT_INDEX_EXHAUSTED", "无法分配商品索引", 500);
  await counter.set({ data: { value: sequence, updatedAt: new Date() } });
  return candidate;
}

function comparableValue(value) {
  return Array.isArray(value) ? JSON.stringify(value) : value === undefined || value === null ? "" : value;
}

function changedFields(before, after, fields) {
  return fields.filter((field) => comparableValue(before[field]) !== comparableValue(after[field]));
}

function safeMetadata(product = {}) {
  return Object.fromEntries(METADATA_FIELDS.map((field) => [field, product[field] === undefined ? (field === "keywords" ? [] : "") : product[field]]));
}

function safeTagSnapshot(product = {}) {
  return {
    tags: normalizePublicTags(product.tags || []),
    internalTags: normalizeInternalTags(product.internalTags || []),
    flags: {
      isNew: Boolean(product.isNew),
      isDefective: Boolean(product.isDefective),
      isHot: Boolean(product.isHot),
      isFrequent: Boolean(product.isFrequent)
    },
    defectDescription: cleanString(product.defectDescription, 1000)
  };
}

function resultFromProduct(productId, product, overrides = {}) {
  return {
    productId,
    productIndex: cleanString(product.productIndex, 80),
    metadata: safeMetadata(product),
    price: product.price,
    stock: product.stock,
    warningStock: product.warningStock,
    stockStatus: cleanString(product.stockStatus, 40),
    isActive: product.isActive !== false,
    tags: normalizePublicTags(product.tags || []),
    version: overrides.version === undefined ? versionOf(product) : overrides.version,
    updatedAt: overrides.updatedAt === undefined ? product.updatedAt || null : overrides.updatedAt,
    changed: overrides.changed !== false,
    reused: overrides.reused === true
  };
}

function idempotencyFailure(result) {
  const code = cleanString(result && result.code, 80) || "IDEMPOTENCY_FAILED";
  const statusCode = ["IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400;
  return new ProductWriteError(code, cleanString(result && result.message, 240) || "幂等校验失败", statusCode, result && result.data);
}

function createProductWriteService({ db, idempotency, stockAlert, now = () => new Date(), randomId = () => crypto.randomUUID() } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("product write service requires db.runTransaction");
  if (!idempotency || typeof idempotency.runIdempotentAction !== "function" || typeof idempotency.assertIdempotencyKey !== "function" || typeof idempotency.ensureCollection !== "function") {
    throw new Error("product write service requires idempotency helpers");
  }
  if (!stockAlert || typeof stockAlert.syncStockAlertRecord !== "function") throw new Error("product write service requires stock alert helper");

  async function ensureCollections() {
    for (const name of ["system_counters", "inventory_logs", "price_logs", "product_tag_logs", "stock_alert_records", "admin_operation_logs", "sync_events"]) {
      await idempotency.ensureCollection(db, name);
    }
  }

  async function writeAudit(tx, data) {
    await tx.collection("admin_operation_logs").add({ data });
  }

  async function writeSync(tx, data) {
    await tx.collection("sync_events").add({ data: { ...data, expiresAt: new Date(now().getTime() + SYNC_EVENT_TTL_MS) } });
  }

  async function writeTagLog(tx, { productId, productName, before, after, actor, timestamp, businessKey, operationId, idempotencyKey }) {
    await tx.collection("product_tag_logs").add({ data: {
      businessKey,
      sourceType: "product_write",
      sourceId: operationId,
      idempotencyKey: idempotencyKey || "",
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
      operatorId: actor.id,
      operatorOpenid: actor.openid,
      operatorRole: actor.role,
      sourceClient: actor.sourceClient,
      createdAt: timestamp
    } });
  }

  async function executeCreate({ actor, input, idempotencyKey, operationId }) {
    const businessKey = deterministicKey("product_create", `${actor.id}:${operationId}`);
    return db.runTransaction(async (tx) => {
      const existing = await tx.collection("admin_operation_logs").where({ businessKey }).limit(1).get();
      if (existing.data && existing.data[0]) {
        const productId = cleanString(existing.data[0].resourceId, 128);
        const product = (await tx.collection("products").doc(productId).get()).data;
        return resultFromProduct(productId, product, { changed: false, reused: true });
      }
      const timestamp = db.serverDate();
      const productIndex = await allocateProductIndex(tx, input.productIndex);
      const effectiveIsActive = input.stock <= 0 && input.autoHideWhenOutOfStock ? false : input.isActive;
      const data = {
        ...safeMetadata({ ...input, productIndex }),
        price: input.price,
        stock: input.stock,
        warningStock: input.warningStock,
        stockStatus: stockStatus(input.stock, input.warningStock),
        autoHideWhenOutOfStock: input.autoHideWhenOutOfStock,
        isActive: effectiveIsActive,
        tags: input.tags,
        internalTags: input.internalTags,
        isNew: input.tags.includes("新货"),
        isDefective: input.tags.includes("瑕疵"),
        isHot: input.tags.includes("热销"),
        isFrequent: false,
        defectDescription: input.defectDescription,
        tagUpdatedAt: timestamp,
        tagUpdatedBy: actor.openid || actor.id,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastStockCheckAt: timestamp
      };
      data.searchText = buildProductSearchText(data);
      const created = await tx.collection("products").add({ data });
      const productId = created._id;
      await tx.collection("inventory_logs").add({ data: {
        businessKey: `${businessKey}:inventory`, sourceType: "product_create", sourceId: operationId, idempotencyKey: idempotencyKey || "",
        productId, beforeStock: 0, afterStock: data.stock, changeAmount: data.stock, reason: "admin_adjust", operationReason: input.reason,
        relatedOrderId: "", operatorId: actor.id, operatorOpenid: actor.openid, operatorRole: actor.role, sourceClient: actor.sourceClient,
        stockStatusBefore: "out_of_stock", stockStatusAfter: data.stockStatus, warningStock: data.warningStock,
        versionBefore: 0, versionAfter: 1, triggeredAlert: ["warning", "out_of_stock"].includes(data.stockStatus), createdAt: timestamp
      } });
      if (data.price > 0) {
        await tx.collection("price_logs").add({ data: {
          businessKey: `${businessKey}:price`, sourceType: "manual", sourceId: operationId, idempotencyKey: idempotencyKey || "",
          productId, productIndex, productName: data.name, beforePrice: 0, afterPrice: data.price, changeType: "create", changeValue: data.price,
          operatorId: actor.id, operatorOpenid: actor.openid, operatorRole: actor.role, sourceClient: actor.sourceClient,
          reason: input.reason || "admin_product_create", versionBefore: 0, versionAfter: 1, createdAt: timestamp
        } });
      }
      const initialTags = safeTagSnapshot(data);
      if (initialTags.tags.length || initialTags.internalTags.length || initialTags.defectDescription) {
        await writeTagLog(tx, {
          productId,
          productName: data.name,
          before: safeTagSnapshot({}),
          after: initialTags,
          actor,
          timestamp,
          businessKey: `${businessKey}:tags`,
          operationId,
          idempotencyKey
        });
      }
      await stockAlert.syncStockAlertRecord({ db, store: tx }, productId, data, data.stockStatus, actor.id);
      await writeAudit(tx, {
        businessKey, operatorId: actor.id, operatorOpenid: actor.openid, operatorRole: actor.role,
        action: "product_create", resourceType: "products", resourceId: productId, beforeData: null,
        afterData: { ...safeMetadata(data), price: data.price, stock: data.stock, warningStock: data.warningStock, isActive: data.isActive, tags: data.tags, version: 1 },
        description: input.reason || "Create product", sourceClient: actor.sourceClient, createdAt: timestamp
      });
      await writeSync(tx, {
        eventId: deterministicKey("product_create_event", businessKey), eventType: "product.created", entityType: "product", entityId: productId,
        action: "create", version: 1, changedFields: [...METADATA_FIELDS, "price", "stock", "warningStock", "stockStatus", "isActive", "tags", "version"],
        actorType: "admin", actorRole: actor.role, sourceClient: actor.sourceClient, businessKey, audience: "public", isPublic: true,
        audienceRoles: ["procurement", "super_admin"], createdAt: timestamp
      });
      return resultFromProduct(productId, data);
    });
  }

  async function executeMetadataUpdate({ actor, input, idempotencyKey, operationId }) {
    const businessKey = deterministicKey("product_metadata", `${actor.id}:${operationId}:${input.productId}`);
    return db.runTransaction(async (tx) => {
      let product;
      try { product = (await tx.collection("products").doc(input.productId).get()).data; } catch (error) { if (!missingDocument(error)) throw error; }
      if (!product || product.isDeleted === true) throw new ProductWriteError("PRODUCT_NOT_FOUND", "商品不存在", 404);
      const existing = await tx.collection("admin_operation_logs").where({ businessKey }).limit(1).get();
      if (existing.data && existing.data[0]) return resultFromProduct(input.productId, product, { changed: false, reused: true });
      const currentVersion = versionOf(product);
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new ProductWriteError("DATA_VERSION_CONFLICT", "记录已变化，请刷新后重新确认", 409, { expectedVersion: input.expectedVersion, currentVersion });
      }
      const patch = Object.fromEntries(METADATA_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(input, field)).map((field) => [field, input[field]]));
      const mergedMetadata = { ...safeMetadata(product), ...patch };
      if (!mergedMetadata.name) throw new ProductWriteError("PRODUCT_NAME_REQUIRED", "商品名称不能为空", 400);
      if (Object.prototype.hasOwnProperty.call(patch, "productIndex") && patch.productIndex !== product.productIndex) {
        await assertIndexAvailable(tx, patch.productIndex, input.productId);
      }
      const fields = changedFields(product, patch, Object.keys(patch));
      if (!fields.length) return resultFromProduct(input.productId, product, { changed: false });
      const timestamp = db.serverDate();
      const nextVersion = currentVersion + 1;
      const updateData = { ...patch, updatedAt: timestamp, version: nextVersion };
      updateData.searchText = buildProductSearchText({ ...product, ...updateData });
      await tx.collection("products").doc(input.productId).update({ data: updateData });
      await writeAudit(tx, {
        businessKey, operatorId: actor.id, operatorOpenid: actor.openid, operatorRole: actor.role,
        action: "product_metadata_update", resourceType: "products", resourceId: input.productId,
        beforeData: { ...safeMetadata(product), version: currentVersion }, afterData: { ...mergedMetadata, version: nextVersion },
        description: input.reason || "Update product metadata", sourceClient: actor.sourceClient, createdAt: timestamp
      });
      await writeSync(tx, {
        eventId: deterministicKey("product_metadata_event", businessKey), eventType: "product.metadata_updated", entityType: "product", entityId: input.productId,
        action: "edit", version: nextVersion, changedFields: [...fields, "searchText", "updatedAt", "version"], actorType: "admin",
        actorRole: actor.role, sourceClient: actor.sourceClient, businessKey, audience: "public", isPublic: true,
        audienceRoles: ["procurement", "super_admin"], createdAt: timestamp
      });
      return resultFromProduct(input.productId, { ...product, ...updateData });
    });
  }

  async function recoverCommittedResult({ actor, input, operationId, prefix }) {
    const businessKey = deterministicKey(prefix, `${actor.id}:${operationId}${input.productId ? `:${input.productId}` : ""}`);
    const logs = await db.collection("admin_operation_logs").where({ businessKey }).limit(1).get();
    const log = logs.data && logs.data[0];
    if (!log || !log.resourceId) return null;
    let product;
    try { product = (await db.collection("products").doc(log.resourceId).get()).data; } catch (error) { if (!missingDocument(error)) throw error; }
    if (!product || product.isDeleted === true) return null;
    return resultFromProduct(log.resourceId, product, { changed: false, reused: true });
  }

  async function executeLegacyFullUpdate({ actor, input, idempotencyKey, operationId }) {
    const businessKey = deterministicKey("product_legacy_update", `${actor.id}:${operationId}:${input.productId}`);
    return db.runTransaction(async (tx) => {
      let product;
      try { product = (await tx.collection("products").doc(input.productId).get()).data; } catch (error) { if (!missingDocument(error)) throw error; }
      if (!product || product.isDeleted === true) throw new ProductWriteError("PRODUCT_NOT_FOUND", "商品不存在", 404);
      const currentVersion = versionOf(product);
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) throw new ProductWriteError("DATA_VERSION_CONFLICT", "记录已变化，请刷新后重新确认", 409);
      const currentStock = Number(product.stock);
      if (!Number.isSafeInteger(currentStock) || currentStock < 0) throw new ProductWriteError("DATA_STOCK_INVALID", "商品库存数据异常，暂不能修改", 409);
      if (input.expectedStock === undefined && input.stock !== currentStock) {
        throw new ProductWriteError("EXPECTED_STOCK_REQUIRED", "库存可能已变化，请刷新后再调整库存", 409);
      }
      if (input.expectedStock !== undefined && input.expectedStock !== currentStock) {
        throw new ProductWriteError("DATA_VERSION_CONFLICT", "库存已变化，请刷新后重新确认", 409, {
          expectedStock: input.expectedStock,
          currentStock,
          expectedVersion: input.expectedVersion,
          currentVersion,
          conflictFields: ["stock"]
        });
      }
      let inventoryPlan;
      try {
        inventoryPlan = createInventoryMutationPlan(
          { ...product, warningStock: input.warningStock, autoHideWhenOutOfStock: input.autoHideWhenOutOfStock },
          { mode: "set", targetStock: input.stock, expectedStock: input.expectedStock, expectedVersion: input.expectedVersion },
          stockAlert
        );
      } catch (error) {
        throw new ProductWriteError(error.code || "INVENTORY_MUTATION_FAILED", error.message || "库存调整失败", error.statusCode || 400, error.details);
      }
      if (input.productIndex !== product.productIndex) await assertIndexAvailable(tx, input.productIndex, input.productId);
      const timestamp = db.serverDate();
      const effectiveIsActive = input.stock <= 0 && input.autoHideWhenOutOfStock ? false : input.isActive;
      const candidate = {
        ...safeMetadata(input), price: input.price, stock: input.stock, warningStock: input.warningStock,
        stockStatus: stockStatus(input.stock, input.warningStock), autoHideWhenOutOfStock: input.autoHideWhenOutOfStock,
        isActive: effectiveIsActive, tags: input.tags, internalTags: input.internalTags,
        isNew: input.tags.includes("新货"), isDefective: input.tags.includes("瑕疵"), isHot: input.tags.includes("热销"),
        isFrequent: false, defectDescription: input.defectDescription
      };
      const ownedFields = [...METADATA_FIELDS, "price", "stock", "warningStock", "stockStatus", "autoHideWhenOutOfStock", "isActive", "tags", "internalTags", "isNew", "isDefective", "isHot", "isFrequent", "defectDescription"];
      const fields = changedFields(product, candidate, ownedFields);
      if (!fields.length) return resultFromProduct(input.productId, product, { changed: false });
      const nextVersion = currentVersion + 1;
      const tagFields = ["tags", "internalTags", "isNew", "isDefective", "isHot", "isFrequent", "defectDescription"];
      const tagChanged = fields.some((field) => tagFields.includes(field));
      const updateData = { ...candidate, updatedAt: timestamp, lastStockCheckAt: timestamp, version: nextVersion };
      if (tagChanged) {
        updateData.tagUpdatedAt = timestamp;
        updateData.tagUpdatedBy = actor.openid || actor.id;
      }
      updateData.searchText = buildProductSearchText({ ...product, ...updateData });
      await tx.collection("products").doc(input.productId).update({ data: updateData });
      if (Number(product.price || 0) !== candidate.price) await tx.collection("price_logs").add({ data: {
        businessKey: `${businessKey}:price`, sourceType: "manual", sourceId: operationId, idempotencyKey: idempotencyKey || "", productId: input.productId,
        productIndex: candidate.productIndex, productName: candidate.name, beforePrice: Number(product.price || 0), afterPrice: candidate.price,
        changeType: "set", changeValue: candidate.price, operatorId: actor.id, operatorOpenid: actor.openid, operatorRole: actor.role,
        sourceClient: actor.sourceClient, reason: input.reason || "admin_product_update", versionBefore: currentVersion, versionAfter: nextVersion, createdAt: timestamp
      } });
      if (inventoryPlan.changed) {
        await writeInventoryMutationEffects({
          db,
          store: tx,
          stockAlert,
          productId: input.productId,
          productBefore: product,
          productAfter: { ...product, ...updateData },
          plan: inventoryPlan,
          actor,
          context: {
            businessKey: `${businessKey}:inventory`,
            sourceType: "legacy_product_update",
            sourceId: operationId,
            idempotencyKey: idempotencyKey || "",
            reasonCode: "admin_adjust",
            operationReason: input.reason,
            mode: "set",
            writeAudit: false,
            writeSync: false
          },
          timestamp,
          versionBefore: currentVersion,
          versionAfter: nextVersion
        });
      }
      if (tagChanged) {
        await writeTagLog(tx, {
          productId: input.productId,
          productName: candidate.name,
          before: safeTagSnapshot(product),
          after: safeTagSnapshot(candidate),
          actor,
          timestamp,
          businessKey: `${businessKey}:tags`,
          operationId,
          idempotencyKey
        });
      }
      if (!inventoryPlan.changed) {
        await stockAlert.syncStockAlertRecord({ db, store: tx }, input.productId, { ...product, ...updateData }, candidate.stockStatus, actor.id);
      }
      await writeAudit(tx, {
        businessKey, operatorId: actor.id, operatorOpenid: actor.openid, operatorRole: actor.role, action: "product_legacy_update",
        resourceType: "products", resourceId: input.productId, beforeData: { ...safeMetadata(product), version: currentVersion },
        afterData: { ...safeMetadata(candidate), version: nextVersion }, description: input.reason || "Update product from miniprogram",
        sourceClient: actor.sourceClient, createdAt: timestamp
      });
      const internalOnlyFields = new Set(["internalTags", "defectDescription", "isFrequent"]);
      const publicChangedFields = fields.filter((field) => !internalOnlyFields.has(field));
      const publicChanged = publicChangedFields.length > 0;
      await writeSync(tx, {
        eventId: deterministicKey("product_legacy_event", businessKey), eventType: "product.updated", entityType: "product", entityId: input.productId,
        action: "update", version: nextVersion,
        changedFields: publicChanged ? [...publicChangedFields, "searchText", "updatedAt", "version"] : ["updatedAt", "version"],
        actorType: "admin", actorRole: actor.role, sourceClient: actor.sourceClient, businessKey,
        audience: publicChanged ? "public" : "admin", isPublic: publicChanged,
        audienceRoles: ["procurement", "super_admin"], createdAt: timestamp
      });
      return resultFromProduct(input.productId, { ...product, ...updateData });
    });
  }

  async function run(command, config) {
    const actor = normalizeActor(command.actor, config.permission);
    const input = config.normalize(command);
    const legacyMode = config.legacy === true;
    const rawKey = cleanString(command.idempotencyKey, 200);
    await ensureCollections();
    if (!rawKey) {
      if (!legacyMode || command.allowMissingIdempotencyKey !== true) {
        try { idempotency.assertIdempotencyKey(rawKey); } catch (error) { throw new ProductWriteError(error.code || "IDEMPOTENCY_KEY_REQUIRED", error.message || "缺少操作凭证", 400); }
      }
      return config.execute({ actor, input, idempotencyKey: "", operationId: `legacy_${cleanString(randomId(), 80)}` });
    }
    let idempotencyKey;
    try { idempotencyKey = idempotency.assertIdempotencyKey(rawKey); } catch (error) { throw new ProductWriteError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400); }
    const outcome = await idempotency.runIdempotentAction({
      db, actionType: config.actionType, idempotencyKey, operatorIdentity: actor.id, operatorType: "admin", scope: "product",
      scopeId: input.productId || "create", openid: actor.openid, adminId: actor.id, ttlSeconds: 7 * 24 * 60 * 60,
      payload: input,
      recoverProcessingResult: () => recoverCommittedResult({ actor, input, operationId: idempotencyKey, prefix: config.recoveryPrefix })
    }, () => config.execute({ actor, input, idempotencyKey, operationId: idempotencyKey }));
    if (!outcome || outcome.ok !== true) throw idempotencyFailure(outcome);
    return outcome.data;
  }

  return {
    createProduct(command = {}) {
      return run(command, { actionType: CREATE_ACTION, recoveryPrefix: "product_create", permission: CREATE_PERMISSION, normalize: (value) => normalizeCreateInput(value.input || {}, value.legacy === true), execute: executeCreate, legacy: command.legacy === true });
    },
    updateProductMetadata(command = {}) {
      return run(command, { actionType: EDIT_ACTION, recoveryPrefix: "product_metadata", permission: UPDATE_PERMISSION, normalize: (value) => normalizeMetadataUpdateInput(value.input || {}, value.requireExpectedVersion !== false), execute: executeMetadataUpdate, legacy: command.requireExpectedVersion === false });
    },
    updateLegacyFull(command = {}) {
      return run(command, { actionType: LEGACY_UPDATE_ACTION, recoveryPrefix: "product_legacy_update", permission: UPDATE_PERMISSION, normalize: (value) => normalizeLegacyFullInput(value.input || {}), execute: executeLegacyFullUpdate, legacy: true });
    }
  };
}

module.exports = {
  CREATE_ACTION,
  EDIT_ACTION,
  LEGACY_UPDATE_ACTION,
  METADATA_FIELDS,
  ProductWriteError,
  createProductWriteService,
  normalizeActor,
  normalizeCreateInput,
  normalizeMetadataUpdateInput,
  normalizeLegacyFullInput,
  buildProductSearchText,
  versionOf
};
