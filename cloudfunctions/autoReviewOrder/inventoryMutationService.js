const crypto = require("crypto");

const ACTION_TYPE = "adjust_inventory";
const REQUIRED_PERMISSION = "inventory:update";
const MAX_STOCK = 9_999_999;
const SYNC_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class InventoryMutationError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "InventoryMutationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function deterministicKey(prefix, value) {
  const digest = crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40);
  return `${prefix}:${digest}`;
}

function hasPermission(actor, permission) {
  if (!actor || actor.status !== "active" || actor.isActive === false) return false;
  if (actor.role === "super_admin") return true;
  return actor.role === "procurement"
    && Array.isArray(actor.permissions)
    && (actor.permissions.includes("*") || actor.permissions.includes(permission));
}

function normalizeActor(actor = {}) {
  const id = cleanString(actor.id || actor._id || actor.openid, 128);
  const role = cleanString(actor.role, 50);
  if (!id || !role) throw new InventoryMutationError("INVALID_ACTOR", "管理员身份无效", 403);
  if (!hasPermission(actor, REQUIRED_PERMISSION)) {
    throw new InventoryMutationError("FORBIDDEN", "无权调整库存", 403);
  }
  return {
    id,
    openid: cleanString(actor.openid, 128),
    role,
    permissions: Array.isArray(actor.permissions) ? actor.permissions.slice() : [],
    status: "active",
    isActive: true,
    sourceClient: actor.sourceClient === "miniprogram" ? "miniprogram" : "admin_web"
  };
}

function safeInteger(value, code, message, { min = 0, max = MAX_STOCK } = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InventoryMutationError(code, message, 400);
  }
  return value;
}

function normalizeExpectedStock(value, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new InventoryMutationError("EXPECTED_STOCK_REQUIRED", "缺少当前库存，请刷新后重试", 400);
    return undefined;
  }
  return safeInteger(value, "EXPECTED_STOCK_INVALID", "当前库存无效，请刷新后重试");
}

function normalizeExpectedVersion(value, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new InventoryMutationError("EXPECTED_VERSION_REQUIRED", "缺少数据版本，请刷新后重试", 400);
    return undefined;
  }
  return safeInteger(value, "EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", { max: Number.MAX_SAFE_INTEGER });
}

function normalizeInput(input = {}, options = {}) {
  const productId = typeof input.productId === "string" ? cleanString(input.productId, 128) : "";
  if (!productId) throw new InventoryMutationError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  const mode = input.mode;
  if (!['set', 'delta'].includes(mode)) throw new InventoryMutationError("INVENTORY_MODE_INVALID", "库存调整方式无效", 400);
  if (input.reason !== undefined && typeof input.reason !== "string") {
    throw new InventoryMutationError("REASON_INVALID", "调整原因格式无效", 400);
  }
  const reason = cleanString(input.reason, 120);
  if (options.requireReason !== false && !reason) throw new InventoryMutationError("REASON_REQUIRED", "请填写调整原因", 400);
  const normalized = {
    productId,
    mode,
    expectedStock: normalizeExpectedStock(input.expectedStock, options.requireExpectedStock !== false),
    expectedVersion: normalizeExpectedVersion(input.expectedVersion, options.requireExpectedVersion !== false),
    reason
  };
  if (mode === "set") {
    if (input.delta !== undefined) throw new InventoryMutationError("INVENTORY_FIELDS_CONFLICT", "库存调整字段冲突", 400);
    normalized.targetStock = safeInteger(input.targetStock, "TARGET_STOCK_INVALID", "目标库存必须是 0 到 9999999 的整数");
  } else {
    if (input.targetStock !== undefined) throw new InventoryMutationError("INVENTORY_FIELDS_CONFLICT", "库存调整字段冲突", 400);
    normalized.delta = safeInteger(input.delta, "DELTA_INVALID", "库存变化量必须是非零整数", { min: -MAX_STOCK, max: MAX_STOCK });
    if (normalized.delta === 0) throw new InventoryMutationError("DELTA_INVALID", "库存变化量不能为 0", 400);
  }
  return normalized;
}

function stockOf(product = {}) {
  if (typeof product.stock !== "number" || !Number.isSafeInteger(product.stock) || product.stock < 0 || product.stock > MAX_STOCK) {
    throw new InventoryMutationError("DATA_STOCK_INVALID", "商品库存数据异常，暂不能修改", 409);
  }
  return product.stock;
}

function versionOf(product = {}) {
  const raw = product.version !== undefined ? product.version : product.dataVersion;
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new InventoryMutationError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  return raw;
}

function warningStockOf(product = {}) {
  const raw = product.warningStock === undefined || product.warningStock === null || product.warningStock === "" ? 10 : product.warningStock;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > 99_999) {
    throw new InventoryMutationError("DATA_WARNING_STOCK_INVALID", "商品库存预警数据异常，暂不能修改", 409);
  }
  return raw;
}

function missingDocument(error) {
  return /DOCUMENT_NOT_EXIST|document not exist|not found|ResourceNotFound/i.test(String(error && error.message || error || ""));
}

function createInventoryMutationPlan(product = {}, input = {}, stockAlert) {
  if (!stockAlert || typeof stockAlert.buildStockStatusUpdate !== "function") throw new Error("stock alert helper is required");
  const beforeStock = stockOf(product);
  const currentVersion = versionOf(product);
  const conflictFields = [];
  if (input.expectedStock !== undefined && input.expectedStock !== beforeStock) conflictFields.push("stock");
  if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) conflictFields.push("version");
  if (conflictFields.length) {
    throw new InventoryMutationError("DATA_VERSION_CONFLICT", "库存已变化，请刷新后重新确认", 409, {
      expectedStock: input.expectedStock,
      currentStock: beforeStock,
      expectedVersion: input.expectedVersion,
      currentVersion,
      conflictFields
    });
  }
  const afterStock = input.mode === "delta" ? beforeStock + input.delta : input.targetStock;
  if (!Number.isSafeInteger(afterStock) || afterStock < 0 || afterStock > MAX_STOCK) {
    throw new InventoryMutationError("AFTER_STOCK_INVALID", "调整后库存必须在 0 到 9999999 之间", 409, { currentStock: beforeStock });
  }
  const warningStock = warningStockOf(product);
  const changed = afterStock !== beforeStock;
  return { beforeStock, afterStock, changeAmount: afterStock - beforeStock, warningStock, currentVersion, changed };
}

function resultFromProduct(productId, product = {}, overrides = {}) {
  return {
    productId,
    beforeStock: overrides.beforeStock === undefined ? stockOf(product) : overrides.beforeStock,
    stock: stockOf(product),
    warningStock: warningStockOf(product),
    stockStatus: cleanString(product.stockStatus, 40),
    isActive: product.isActive !== false,
    version: versionOf(product),
    updatedAt: product.updatedAt || null,
    changed: overrides.changed !== false,
    reused: overrides.reused === true
  };
}

function resultFromInventoryLog(log = {}, overrides = {}) {
  const productId = cleanString(log.productId, 128);
  const beforeStock = safeInteger(log.beforeStock, "DATA_STOCK_INVALID", "库存流水数据异常，暂不能恢复操作结果", { max: MAX_STOCK });
  const stock = safeInteger(log.afterStock, "DATA_STOCK_INVALID", "库存流水数据异常，暂不能恢复操作结果", { max: MAX_STOCK });
  const version = safeInteger(log.versionAfter, "DATA_VERSION_INVALID", "库存流水版本异常，暂不能恢复操作结果", { max: Number.MAX_SAFE_INTEGER });
  const stockStatus = cleanString(log.stockStatusAfter, 40);
  if (!productId || !["normal", "warning", "out_of_stock"].includes(stockStatus) || typeof log.isActiveAfter !== "boolean") {
    throw new InventoryMutationError("INVENTORY_LOG_INVALID", "库存流水数据异常，暂不能恢复操作结果", 409);
  }
  return {
    productId,
    beforeStock,
    stock,
    warningStock: safeInteger(log.warningStock, "DATA_WARNING_STOCK_INVALID", "库存流水预警数据异常，暂不能恢复操作结果", { max: 99_999 }),
    stockStatus,
    isActive: log.isActiveAfter,
    version,
    updatedAt: log.createdAt || null,
    changed: overrides.changed !== false,
    reused: overrides.reused === true
  };
}

function validateInventoryReplay(logs, input = {}, context = {}) {
  if (!Array.isArray(logs) || logs.length === 0) return null;
  if (logs.length > 1) {
    throw new InventoryMutationError("INVENTORY_LOG_DUPLICATE", "库存业务流水重复，暂不能继续操作", 409);
  }
  const log = logs[0];
  const expectedChange = input.mode === "delta" ? input.delta : context.expectedChangeAmount;
  const conflicts = [
    cleanString(log.businessKey, 180) !== cleanString(context.businessKey, 180),
    cleanString(log.productId, 128) !== cleanString(input.productId, 128),
    cleanString(log.sourceType, 80) !== cleanString(context.sourceType || ACTION_TYPE, 80),
    cleanString(log.sourceId, 128) !== cleanString(context.sourceId, 128),
    cleanString(log.relatedOrderId, 128) !== cleanString(context.relatedOrderId, 128),
    expectedChange !== undefined && log.changeAmount !== expectedChange
  ];
  if (conflicts.some(Boolean)) {
    throw new InventoryMutationError("INVENTORY_LOG_CONFLICT", "历史库存流水与本次操作不一致", 409);
  }
  return log;
}

function minimalInventoryReplayResult(log = {}) {
  const productId = cleanString(log.productId, 128);
  const beforeStock = safeInteger(log.beforeStock, "DATA_STOCK_INVALID", "库存流水数据异常，暂不能恢复操作结果", { max: MAX_STOCK });
  const stock = safeInteger(log.afterStock, "DATA_STOCK_INVALID", "库存流水数据异常，暂不能恢复操作结果", { max: MAX_STOCK });
  if (!productId || stock - beforeStock !== log.changeAmount) {
    throw new InventoryMutationError("INVENTORY_LOG_INVALID", "库存流水数据异常，暂不能恢复操作结果", 409);
  }
  return { productId, beforeStock, stock, changed: false, reused: true };
}

function normalizePrimitiveActor(actor = {}) {
  return {
    id: cleanString(actor.id || actor._id || actor.openid || "system", 128) || "system",
    openid: cleanString(actor.openid, 128),
    role: cleanString(actor.role || "system", 50),
    sourceClient: actor.sourceClient === "admin_web" || actor.sourceClient === "miniprogram" ? actor.sourceClient : "system"
  };
}

async function writeInventoryMutationEffects({ db, store, stockAlert, productId, productBefore, productAfter, plan, actor, context = {}, timestamp, versionBefore, versionAfter }) {
  const businessKey = cleanString(context.businessKey, 180);
  if (!businessKey) throw new Error("inventory mutation businessKey is required");
  const operator = normalizePrimitiveActor(actor);
  const sourceType = cleanString(context.sourceType || ACTION_TYPE, 80);
  const sourceId = cleanString(context.sourceId, 128);
  const reasonCode = cleanString(context.reasonCode || ACTION_TYPE, 80);
  await stockAlert.syncStockAlertRecord({ db, store }, productId, productAfter, productAfter.stockStatus, operator.id);
  await store.collection("inventory_logs").add({ data: {
    businessKey,
    sourceType,
    sourceId,
    idempotencyKey: cleanString(context.idempotencyKey, 200),
    productId,
    beforeStock: plan.beforeStock,
    afterStock: plan.afterStock,
    changeAmount: plan.changeAmount,
    changeMode: context.mode || "",
    reason: reasonCode,
    operationReason: cleanString(context.operationReason, 120),
    relatedOrderId: cleanString(context.relatedOrderId, 128),
    relatedAfterSaleId: cleanString(context.relatedAfterSaleId, 128),
    relatedImportId: cleanString(context.relatedImportId, 128),
    operatorId: operator.id,
    operatorOpenid: operator.openid,
    operatorRole: operator.role,
    sourceClient: operator.sourceClient,
    stockStatusBefore: cleanString(productBefore.stockStatus, 40),
    stockStatusAfter: cleanString(productAfter.stockStatus, 40),
    warningStock: plan.warningStock,
    versionBefore,
    versionAfter,
    triggeredAlert: ["warning", "out_of_stock"].includes(productAfter.stockStatus),
    isActiveBefore: productBefore.isActive !== false,
    isActiveAfter: productAfter.isActive !== false,
    createdAt: timestamp
  } });
  if (context.writeAudit !== false) {
    await store.collection("admin_operation_logs").add({ data: {
      businessKey: `${businessKey}:audit`,
      operatorId: operator.id,
      operatorOpenid: operator.openid,
      operatorRole: operator.role,
      action: "inventory_adjust",
      resourceType: "products",
      resourceId: productId,
      beforeData: { stock: plan.beforeStock, version: versionBefore },
      afterData: { stock: plan.afterStock, version: versionAfter },
      description: cleanString(context.operationReason, 120) || "Adjust inventory",
      sourceClient: operator.sourceClient,
      createdAt: timestamp
    } });
  }
  if (context.writeSync !== false) {
    const changedFields = ["stock", "stockStatus", "updatedAt", "version"];
    if ((productBefore.isActive !== false) !== (productAfter.isActive !== false)) changedFields.push("isActive");
    await store.collection("sync_events").add({ data: {
      eventId: deterministicKey("inventory_adjust_event", businessKey),
      eventType: "inventory.stock_adjusted",
      entityType: "inventory",
      entityId: productId,
      action: "adjust",
      version: versionAfter,
      changedFields,
      actorType: operator.role === "system" ? "system" : "admin",
      actorRole: operator.role,
      sourceClient: operator.sourceClient,
      businessKey,
      audience: "admin",
      isPublic: false,
      audienceRoles: ["procurement", "super_admin"],
      createdAt: timestamp,
      expiresAt: new Date((context.now || new Date()).getTime() + SYNC_EVENT_TTL_MS)
    } });
    if (productBefore.isActive !== false && productAfter.isActive === false) {
      await store.collection("sync_events").add({ data: {
        eventId: deterministicKey("product_availability_event", businessKey),
        eventType: "product.availability_changed",
        entityType: "product",
        entityId: productId,
        action: "availability_changed",
        version: versionAfter,
        changedFields: ["isActive", "updatedAt", "version"],
        actorType: operator.role === "system" ? "system" : "admin",
        actorRole: operator.role,
        sourceClient: operator.sourceClient,
        businessKey: `${businessKey}:public`,
        audience: "public",
        isPublic: true,
        createdAt: timestamp,
        expiresAt: new Date((context.now || new Date()).getTime() + SYNC_EVENT_TTL_MS)
      } });
    }
  }
}

async function applyInventoryMutationInTransaction({ db, store, stockAlert, input = {}, actor = {}, context = {} } = {}) {
  if (!db || typeof db.serverDate !== "function" || !store || typeof store.collection !== "function") {
    throw new Error("inventory transaction context is required");
  }
  if (!stockAlert || typeof stockAlert.buildStockStatusUpdate !== "function" || typeof stockAlert.syncStockAlertRecord !== "function") {
    throw new Error("stock alert helpers are required");
  }
  const businessKey = cleanString(context.businessKey, 180);
  if (!businessKey) throw new Error("inventory mutation businessKey is required");
  const existing = await store.collection("inventory_logs").where({ businessKey }).limit(2).get();
  const existingLog = validateInventoryReplay(existing.data || [], input, context);
  if (existingLog) {
    if (cleanString(context.sourceType, 80) === "order") return minimalInventoryReplayResult(existingLog);
    return resultFromInventoryLog(existingLog, { changed: false, reused: true });
  }
  let product;
  try { product = (await store.collection("products").doc(input.productId).get()).data; } catch (error) { if (!missingDocument(error)) throw error; }
  if (!product || product.isDeleted === true) throw new InventoryMutationError("PRODUCT_NOT_FOUND", "商品不存在", 404);
  const plan = createInventoryMutationPlan(product, input, stockAlert);
  if (!plan.changed) return resultFromProduct(input.productId, product, { changed: false, beforeStock: plan.beforeStock });
  const timestamp = db.serverDate();
  if (plan.currentVersion >= Number.MAX_SAFE_INTEGER) {
    throw new InventoryMutationError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  const nextVersion = plan.currentVersion + 1;
  const statusUpdate = stockAlert.buildStockStatusUpdate(product, { stock: plan.afterStock, warningStock: plan.warningStock, now: timestamp });
  const updateData = {
    stock: plan.afterStock,
    warningStock: plan.warningStock,
    stockStatus: statusUpdate.stockStatus,
    autoHideWhenOutOfStock: statusUpdate.autoHideWhenOutOfStock,
    lastStockCheckAt: statusUpdate.lastStockCheckAt,
    updatedAt: timestamp,
    version: nextVersion,
    lastStockChangeReason: cleanString(input.reason, 120)
  };
  if (statusUpdate.isActive === false) updateData.isActive = false;
  const nextProduct = { ...product, ...updateData };
  await store.collection("products").doc(input.productId).update({ data: updateData });
  await writeInventoryMutationEffects({
    db, store, stockAlert, productId: input.productId, productBefore: product, productAfter: nextProduct, plan, actor,
    context: { ...context, mode: input.mode, operationReason: input.reason, now: context.now || new Date() },
    timestamp, versionBefore: plan.currentVersion, versionAfter: nextVersion
  });
  return resultFromProduct(input.productId, nextProduct, { beforeStock: plan.beforeStock });
}

function idempotencyFailure(result) {
  const code = cleanString(result && result.code, 80) || "IDEMPOTENCY_FAILED";
  const statusCode = ["IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400;
  return new InventoryMutationError(code, cleanString(result && result.message, 240) || "幂等校验失败", statusCode, result && result.data);
}

function createInventoryMutationService({ db, stockAlert, idempotency, now = () => new Date(), randomId = () => crypto.randomUUID() } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("inventory mutation service requires db.runTransaction");
  if (!stockAlert || typeof stockAlert.buildStockStatusUpdate !== "function" || typeof stockAlert.syncStockAlertRecord !== "function") throw new Error("inventory mutation service requires stock alert helpers");
  if (!idempotency || typeof idempotency.assertIdempotencyKey !== "function" || typeof idempotency.runIdempotentAction !== "function" || typeof idempotency.ensureCollection !== "function") throw new Error("inventory mutation service requires idempotency helpers");

  async function ensureCollections() {
    for (const name of ["inventory_logs", "stock_alert_records", "admin_operation_logs", "sync_events"]) {
      await idempotency.ensureCollection(db, name);
    }
  }

  async function execute({ actor, input, idempotencyKey, operationId }) {
    const businessKey = deterministicKey("inventory_adjust", `${actor.id}:${operationId}:${input.productId}`);
    return db.runTransaction((tx) => applyInventoryMutationInTransaction({
      db, store: tx, stockAlert, input, actor,
      context: { businessKey, sourceType: ACTION_TYPE, sourceId: operationId, idempotencyKey, reasonCode: "admin_adjust", now: now() }
    }));
  }

  async function recoverCommittedResult({ actor, input, operationId }) {
    const businessKey = deterministicKey("inventory_adjust", `${actor.id}:${operationId}:${input.productId}`);
    const logs = await db.collection("inventory_logs").where({ businessKey }).limit(2).get();
    const existingLog = validateInventoryReplay(logs.data || [], input, {
      businessKey,
      sourceType: ACTION_TYPE,
      sourceId: operationId,
      relatedOrderId: ""
    });
    if (existingLog) return resultFromInventoryLog(existingLog, { changed: false, reused: true });
    let product;
    try { product = (await db.collection("products").doc(input.productId).get()).data; } catch (error) { if (!missingDocument(error)) throw error; }
    if (!product || product.isDeleted === true) return null;
    if (input.mode === "set"
      && input.targetStock === stockOf(product)
      && input.expectedStock === stockOf(product)
      && input.expectedVersion === versionOf(product)) {
      return resultFromProduct(input.productId, product, { changed: false, reused: true, beforeStock: input.expectedStock });
    }
    return null;
  }

  async function adjustInventory(command = {}) {
    const actor = normalizeActor(command.actor);
    const legacy = command.requireExpectedSnapshots === false;
    const input = normalizeInput(command.input, {
      requireExpectedStock: !legacy,
      requireExpectedVersion: !legacy,
      requireReason: command.requireReason !== false
    });
    await ensureCollections();
    const rawKey = cleanString(command.idempotencyKey, 200);
    if (!rawKey) {
      if (!legacy || command.allowMissingIdempotencyKey !== true) {
        try { idempotency.assertIdempotencyKey(rawKey); } catch (error) { throw new InventoryMutationError(error.code || "IDEMPOTENCY_KEY_REQUIRED", error.message || "缺少操作凭证", 400); }
      }
      return execute({ actor, input, idempotencyKey: "", operationId: `legacy_${cleanString(randomId(), 80)}` });
    }
    let idempotencyKey;
    try { idempotencyKey = idempotency.assertIdempotencyKey(rawKey); } catch (error) { throw new InventoryMutationError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400); }
    const outcome = await idempotency.runIdempotentAction({
      db,
      actionType: ACTION_TYPE,
      idempotencyKey,
      operatorIdentity: actor.id,
      operatorType: "admin",
      scope: "product",
      scopeId: input.productId,
      openid: actor.openid,
      adminId: actor.id,
      ttlSeconds: 7 * 24 * 60 * 60,
      payload: input,
      recoverProcessingResult: () => recoverCommittedResult({ actor, input, operationId: idempotencyKey })
    }, () => execute({ actor, input, idempotencyKey, operationId: idempotencyKey }));
    if (!outcome || outcome.ok !== true) throw idempotencyFailure(outcome);
    return outcome.data;
  }

  return { adjustInventory };
}

module.exports = {
  ACTION_TYPE,
  MAX_STOCK,
  InventoryMutationError,
  normalizeActor,
  normalizeInput,
  normalizeExpectedStock,
  stockOf,
  versionOf,
  warningStockOf,
  resultFromInventoryLog,
  validateInventoryReplay,
  minimalInventoryReplayResult,
  createInventoryMutationPlan,
  writeInventoryMutationEffects,
  applyInventoryMutationInTransaction,
  createInventoryMutationService
};
