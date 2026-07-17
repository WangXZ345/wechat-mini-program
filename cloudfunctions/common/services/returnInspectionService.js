"use strict";

const crypto = require("crypto");

const RECEIVE_STATUSES = new Set(["waiting_return", "returned"]);
const INSPECT_STATUSES = new Set(["received", "inspecting"]);
const INSPECT_CONDITIONS = new Set(["sellable", "damaged", "defective", "missing", "opened", "unknown"]);
const INVENTORY_STOCK_STATUSES = new Set(["normal", "warning", "out_of_stock"]);
const MAX_INVENTORY_STOCK = 9_999_999;
const MAX_WARNING_STOCK = 99_999;
const RETURN_RESULT_EVIDENCE_KEYS = [
  "action",
  "afterSaleId",
  "afterSaleStatus",
  "businessKey",
  "operatorId",
  "restoredQuantity",
  "updatedAt",
  "version"
].sort();

class ReturnInspectionError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "ReturnInspectionError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 300) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function safeInventoryInteger(value, max) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= max;
}

function validateInventoryStateEvidence(evidence, { productId, quantity, code, message, fromLog = false }) {
  const beforeStock = fromLog ? evidence.beforeStock : evidence && evidence.beforeStock;
  const stock = fromLog ? evidence.afterStock : evidence && evidence.stock;
  const warningStock = evidence && evidence.warningStock;
  const stockStatus = fromLog ? evidence.stockStatusAfter : evidence && evidence.stockStatus;
  const isActive = fromLog ? evidence.isActiveAfter : evidence && evidence.isActive;
  const version = fromLog ? evidence.versionAfter : evidence && evidence.version;
  const invalid = [
    !evidence || typeof evidence !== "object" || Array.isArray(evidence),
    cleanString(evidence && evidence.productId, 128) !== productId,
    !safeInventoryInteger(beforeStock, MAX_INVENTORY_STOCK),
    !safeInventoryInteger(stock, MAX_INVENTORY_STOCK),
    !safeInventoryInteger(warningStock, MAX_WARNING_STOCK),
    !INVENTORY_STOCK_STATUSES.has(cleanString(stockStatus, 40)),
    typeof isActive !== "boolean",
    !safeInventoryInteger(version, Number.MAX_SAFE_INTEGER),
    !safeInventoryInteger(quantity, MAX_INVENTORY_STOCK),
    safeInventoryInteger(beforeStock, MAX_INVENTORY_STOCK)
      && safeInventoryInteger(stock, MAX_INVENTORY_STOCK)
      && stock - beforeStock !== quantity
  ];
  if (!fromLog) {
    invalid.push(
      typeof (evidence && evidence.changed) !== "boolean",
      typeof (evidence && evidence.reused) !== "boolean",
      evidence && evidence.reused === true && evidence.changed !== false
    );
  }
  if (invalid.some(Boolean)) {
    throw new ReturnInspectionError(code, message, fromLog ? 409 : 503);
  }
  return {
    productId,
    beforeStock,
    stock,
    warningStock,
    stockStatus,
    isActive,
    version
  };
}

function validateExistingInventoryLog(log, {
  businessKey,
  productId,
  quantity,
  afterSaleId,
  orderId
}) {
  const conflicts = [
    cleanString(log && log.businessKey, 180) !== businessKey,
    cleanString(log && log.productId, 128) !== productId,
    cleanString(log && log.sourceType, 80) !== "after_sale",
    cleanString(log && log.sourceId, 128) !== afterSaleId,
    cleanString(log && log.relatedOrderId, 128) !== orderId,
    cleanString(log && log.relatedAfterSaleId, 128) !== afterSaleId,
    !log || log.changeAmount !== quantity
  ];
  if (conflicts.some(Boolean)) {
    throw new ReturnInspectionError("INVENTORY_LOG_CONFLICT", "历史库存流水与本次回补不一致", 409);
  }
  const versionBefore = log && log.versionBefore;
  const versionAfter = log && log.versionAfter;
  if (!safeInventoryInteger(versionBefore, Number.MAX_SAFE_INTEGER)
    || !safeInventoryInteger(versionAfter, Number.MAX_SAFE_INTEGER)
    || versionBefore === Number.MAX_SAFE_INTEGER
    || versionAfter !== versionBefore + 1) {
    throw new ReturnInspectionError("INVENTORY_LOG_DATA_INVALID", "库存流水版本数据异常，暂不能继续验货", 409);
  }
  return validateInventoryStateEvidence(log, {
    productId,
    quantity,
    code: "INVENTORY_LOG_DATA_INVALID",
    message: "库存流水数据异常，暂不能继续验货",
    fromLog: true
  });
}

function validateInventoryMutationResult(result, { productId, quantity }) {
  return validateInventoryStateEvidence(result, {
    productId,
    quantity,
    code: "INVENTORY_MUTATION_RESULT_INVALID",
    message: "库存回补结果异常，未完成退货验货"
  });
}

function returnResultEvidence(result, { action, businessKey, operatorId }) {
  return {
    afterSaleId: result.afterSaleId,
    action,
    businessKey,
    operatorId,
    afterSaleStatus: result.afterSaleStatus,
    version: result.version,
    updatedAt: result.updatedAt,
    restoredQuantity: result.restoredQuantity
  };
}

function recoverResultFromEvidence(log, { action, afterSaleId, businessKey, operatorId, input }) {
  const evidence = log && log.resultData;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const keys = Object.keys(evidence).sort();
  if (keys.length !== RETURN_RESULT_EVIDENCE_KEYS.length
    || keys.some((key, index) => key !== RETURN_RESULT_EVIDENCE_KEYS[index])) {
    return null;
  }
  const updatedAt = evidence.updatedAt;
  const updatedDate = typeof updatedAt === "string" ? new Date(updatedAt) : null;
  const restoredQuantity = evidence.restoredQuantity;
  const allowedStatuses = action === "confirm_return_received"
    ? new Set(["received"])
    : new Set(["approved", "refund_pending"]);
  const invalid = [
    cleanString(log.businessKey, 180) !== businessKey,
    cleanString(log.action, 80) !== action,
    cleanString(log.afterSaleId, 128) !== afterSaleId,
    cleanString(log.operatorId, 128) !== operatorId,
    cleanString(evidence.businessKey, 180) !== businessKey,
    cleanString(evidence.action, 80) !== action,
    cleanString(evidence.afterSaleId, 128) !== afterSaleId,
    cleanString(evidence.operatorId, 128) !== operatorId,
    !allowedStatuses.has(cleanString(evidence.afterSaleStatus, 60)),
    !safeInventoryInteger(evidence.version, Number.MAX_SAFE_INTEGER) || evidence.version < 1,
    !updatedDate || !Number.isFinite(updatedDate.getTime()) || updatedDate.toISOString() !== updatedAt,
    !Number.isSafeInteger(restoredQuantity) || restoredQuantity < 0 || restoredQuantity > 100000,
    action === "confirm_return_received" && restoredQuantity !== 0,
    action === "inspect_return_items" && restoredQuantity !== input.restockQuantity
  ];
  if (invalid.some(Boolean)) return null;
  return {
    afterSaleId,
    afterSaleStatus: evidence.afterSaleStatus,
    version: evidence.version,
    updatedAt,
    restoredQuantity,
    affected: 0,
    reused: true
  };
}

function hasPermission(actor, permission) {
  return Boolean(actor
    && actor.status === "active"
    && actor.isActive !== false
    && (actor.role === "super_admin"
      || (Array.isArray(actor.permissions)
        && (actor.permissions.includes("*") || actor.permissions.includes(permission)))));
}

function normalizeInspectionActor(actor = {}, action) {
  const id = cleanString(actor.id || actor._id || actor.openid, 128);
  const role = cleanString(actor.role, 50);
  if (!id || !role || actor.status !== "active" || actor.isActive === false) {
    throw new ReturnInspectionError("INVALID_ACTOR", "管理员身份无效", 403);
  }
  if (!["customer_service", "super_admin"].includes(role)) {
    throw new ReturnInspectionError("FORBIDDEN", "当前角色不能执行退货验收", 403);
  }
  const permission = action === "inspect" ? "after_sale:inspect" : "after_sale:receive_return";
  if (!hasPermission(actor, permission)) {
    throw new ReturnInspectionError("FORBIDDEN", "无权执行退货验收操作", 403);
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

function normalizeExpectedVersion(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ReturnInspectionError("EXPECTED_VERSION_REQUIRED", "缺少售后单版本，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ReturnInspectionError("EXPECTED_VERSION_INVALID", "售后单版本无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeExpectedUpdatedAt(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ReturnInspectionError("EXPECTED_UPDATED_AT_REQUIRED", "缺少售后单更新时间，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ReturnInspectionError("EXPECTED_UPDATED_AT_INVALID", "售后单更新时间无效", 400);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ReturnInspectionError("EXPECTED_UPDATED_AT_INVALID", "售后单更新时间无效", 400);
  }
  return value;
}

function normalizeInspectionInput(input = {}, options = {}) {
  const strict = options.strict === true;
  const action = cleanString(input.action, 20);
  if (!["receive", "inspect"].includes(action)) {
    throw new ReturnInspectionError("ACTION_INVALID", "退货验收操作无效", 400);
  }
  const allowed = action === "receive"
    ? new Set(["action", "afterSaleId", "expectedStatus", "expectedVersion", "expectedUpdatedAt", "remark"])
    : new Set([
      "action", "afterSaleId", "expectedStatus", "expectedVersion", "expectedUpdatedAt",
      "itemCondition", "canRestock", "restockQuantity", "inspectionRemark", "remark"
    ]);
  if (strict) {
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown) throw new ReturnInspectionError("UNKNOWN_FIELD", "退货验收请求包含未知字段", 400, { field: unknown });
  }
  const afterSaleId = cleanString(input.afterSaleId || input.id, 128);
  if (!afterSaleId) throw new ReturnInspectionError("AFTER_SALE_ID_REQUIRED", "缺少售后单 ID", 400);
  const expectedStatus = cleanString(input.expectedStatus, 60);
  const requiredStatuses = action === "receive" ? RECEIVE_STATUSES : INSPECT_STATUSES;
  if (strict && !requiredStatuses.has(expectedStatus)) {
    throw new ReturnInspectionError(
      expectedStatus ? "EXPECTED_STATUS_INVALID" : "EXPECTED_STATUS_REQUIRED",
      expectedStatus ? "售后单当前状态无效" : "缺少售后单当前状态，请刷新后重试",
      400
    );
  }
  if (!strict && expectedStatus && !requiredStatuses.has(expectedStatus)) {
    throw new ReturnInspectionError("EXPECTED_STATUS_INVALID", "售后单当前状态无效", 400);
  }
  const normalized = {
    action,
    afterSaleId,
    expectedStatus: expectedStatus || undefined,
    expectedVersion: normalizeExpectedVersion(input.expectedVersion, strict),
    expectedUpdatedAt: normalizeExpectedUpdatedAt(input.expectedUpdatedAt, strict),
    remark: cleanString(input.remark, 300)
  };
  if (action === "receive") return normalized;

  const itemCondition = cleanString(input.itemCondition, 40);
  if (strict && !itemCondition) {
    throw new ReturnInspectionError("ITEM_CONDITION_REQUIRED", "缺少退货商品状态", 400);
  }
  const legacyItemCondition = itemCondition || "unknown";
  if (!INSPECT_CONDITIONS.has(legacyItemCondition)) {
    throw new ReturnInspectionError("ITEM_CONDITION_INVALID", "退货商品状态无效", 400);
  }
  if (typeof input.canRestock !== "boolean") {
    throw new ReturnInspectionError("RESTOCK_FLAG_INVALID", "是否恢复库存格式无效", 400);
  }
  if (!Number.isSafeInteger(input.restockQuantity) || input.restockQuantity < 0 || input.restockQuantity > 100000) {
    throw new ReturnInspectionError("RESTOCK_QUANTITY_INVALID", "恢复库存数量无效", 400);
  }
  if (!input.canRestock && input.restockQuantity !== 0) {
    if (strict) {
      throw new ReturnInspectionError("RESTOCK_QUANTITY_INVALID", "不恢复库存时数量必须为 0", 400);
    }
    input.restockQuantity = 0;
  }
  if (strict && input.canRestock && input.restockQuantity <= 0) {
    throw new ReturnInspectionError("RESTOCK_QUANTITY_INVALID", "恢复库存时数量必须大于 0", 400);
  }
  if (input.canRestock && legacyItemCondition !== "sellable") {
    throw new ReturnInspectionError("RESTOCK_CONDITION_INVALID", "不可售退货不能恢复普通库存", 400);
  }
  normalized.itemCondition = legacyItemCondition;
  normalized.canRestock = input.canRestock;
  normalized.restockQuantity = input.restockQuantity;
  normalized.inspectionRemark = cleanString(input.inspectionRemark || input.remark, 300);
  return normalized;
}

function nextInspectionStatus(afterSale = {}) {
  const amount = afterSale.approvedRefundAmount === undefined || afterSale.approvedRefundAmount === null
    ? 0
    : afterSale.approvedRefundAmount;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    throw new ReturnInspectionError("DATA_REFUND_AMOUNT_INVALID", "审批退款金额数据异常，暂不能验货", 409);
  }
  return amount > 0 ? "refund_pending" : "approved";
}

function versionOf(row = {}) {
  const version = row.version === undefined || row.version === null || row.version === "" ? 0 : row.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new ReturnInspectionError("DATA_VERSION_INVALID", "售后单版本数据异常，暂不能验收", 409);
  }
  return version;
}

function sameInstant(left, right) {
  const leftDate = left instanceof Date ? left : new Date(left);
  const rightDate = right instanceof Date ? right : new Date(right);
  return Number.isFinite(leftDate.getTime())
    && Number.isFinite(rightDate.getTime())
    && leftDate.getTime() === rightDate.getTime();
}

function assertSnapshot(afterSale, input, statuses) {
  const currentVersion = versionOf(afterSale);
  if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
    throw new ReturnInspectionError("DATA_VERSION_CONFLICT", "售后单已变化，请刷新后重试", 409);
  }
  if (input.expectedUpdatedAt !== undefined && !sameInstant(input.expectedUpdatedAt, afterSale.updatedAt)) {
    throw new ReturnInspectionError("DATA_VERSION_CONFLICT", "售后单已变化，请刷新后重试", 409);
  }
  const currentStatus = cleanString(afterSale.afterSaleStatus || afterSale.status, 60);
  if (input.expectedStatus !== undefined && input.expectedStatus !== currentStatus) {
    throw new ReturnInspectionError("DATA_VERSION_CONFLICT", "售后单状态已变化，请刷新后重试", 409);
  }
  if (!statuses.has(currentStatus)) {
    throw new ReturnInspectionError("AFTER_SALE_STATUS_INVALID", "当前售后状态不能执行该验收操作", 409);
  }
  return { currentVersion, currentStatus };
}

function deterministicEventId(value) {
  return `after_sale_inspection:${crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40)}`;
}

function defaultSnapshot(row = {}) {
  return {
    afterSaleNo: cleanString(row.afterSaleNo || row.caseNo, 100),
    orderId: cleanString(row.orderId, 128),
    orderNo: cleanString(row.orderNo, 100),
    afterSaleStatus: cleanString(row.afterSaleStatus || row.status, 60),
    refundStatus: cleanString(row.refundStatus, 40),
    approvedRefundAmount: typeof row.approvedRefundAmount === "number" ? row.approvedRefundAmount : 0,
    actualRefundAmount: typeof row.actualRefundAmount === "number" ? row.actualRefundAmount : 0
  };
}

async function defaultGetAfterSaleById(store, afterSaleId) {
  const result = await store.collection("after_sales").doc(afterSaleId).get();
  if (!result || !result.data) throw new ReturnInspectionError("AFTER_SALE_NOT_FOUND", "售后单不存在", 404);
  return result.data;
}

async function defaultWriteAfterSaleLog(store, {
  afterSale,
  action,
  beforeData,
  afterData,
  operator,
  remark,
  businessKey,
  resultData = {}
}) {
  const resultEvidence = resultData.afterSaleId ? {
    afterSaleId: resultData.afterSaleId,
    action: resultData.action,
    businessKey: resultData.businessKey,
    operatorId: resultData.operatorId,
    afterSaleStatus: resultData.afterSaleStatus,
    version: resultData.version,
    updatedAt: resultData.updatedAt,
    restoredQuantity: resultData.restoredQuantity
  } : null;
  await store.collection("after_sale_logs").add({
    data: {
      afterSaleId: cleanString(afterSale._id || afterSale.id, 128),
      afterSaleNo: cleanString(afterSale.afterSaleNo || afterSale.caseNo, 100),
      orderId: cleanString(afterSale.orderId, 128),
      orderNo: cleanString(afterSale.orderNo, 100),
      action: cleanString(action, 80),
      beforeData: defaultSnapshot(beforeData),
      afterData: defaultSnapshot(afterData),
      operatorType: "admin",
      operatorId: cleanString(operator && (operator.id || operator._id), 128),
      operatorRole: cleanString(operator && operator.role, 50),
      businessKey: cleanString(businessKey, 180),
      remark: cleanString(remark, 300),
      ...(resultEvidence ? { resultData: resultEvidence } : {}),
      createdAt: afterData && afterData.updatedAt || new Date()
    }
  });
}

async function defaultWriteAdminOperation(store, { admin, action, resourceType, resourceId, beforeData, afterData, description, businessKey }) {
  await store.collection("admin_operation_logs").add({
    data: {
      operatorId: cleanString(admin && (admin.id || admin._id), 128),
      operatorRole: cleanString(admin && admin.role, 50),
      action: cleanString(action, 100),
      resourceType: cleanString(resourceType, 80),
      resourceId: cleanString(resourceId, 128),
      businessKey: cleanString(businessKey, 180),
      beforeData: beforeData || null,
      afterData: afterData || null,
      description: cleanString(description, 300),
      createdAt: afterData && afterData.updatedAt || new Date()
    }
  });
}

function createReturnInspectionService({
  db,
  idempotency,
  now = () => new Date(),
  getAfterSaleById = defaultGetAfterSaleById,
  writeAfterSaleLog = defaultWriteAfterSaleLog,
  writeAdminOperation = defaultWriteAdminOperation,
  snapshot = defaultSnapshot,
  ownerKeyFor,
  syncOwnerPepper = "",
  incrementInventory,
  applyInventoryMutationInTransaction,
  stockAlert
} = {}) {
  if (!db || typeof db.runTransaction !== "function") {
    throw new Error("return inspection service requires db");
  }
  if (!idempotency || typeof idempotency.runIdempotentAction !== "function") {
    throw new Error("return inspection service requires idempotency helpers");
  }
  if (typeof applyInventoryMutationInTransaction !== "function" && typeof incrementInventory !== "function") {
    throw new Error("return inspection service requires inventory mutation adapter");
  }

  async function ensureCollections() {
    if (typeof idempotency.ensureCollection !== "function") return;
    for (const name of ["after_sales", "orders", "inventory_logs", "after_sale_logs", "admin_operation_logs", "sync_events"]) {
      await idempotency.ensureCollection(db, name);
    }
  }

  function ownerKey(afterSale) {
    if (typeof ownerKeyFor !== "function") return "";
    return cleanString(ownerKeyFor(
      afterSale.openid || afterSale.userOpenid || afterSale.userId,
      syncOwnerPepper
    ), 128);
  }

  async function writeSyncEvent(tx, { afterSale, actor, action, next, operationId, timestamp }) {
    if (typeof ownerKeyFor !== "function") return;
    const owner = ownerKey(afterSale);
    if (!owner) throw new ReturnInspectionError("SYNC_OWNER_CONFIG_REQUIRED", "售后同步安全配置不完整", 503);
    await tx.collection("sync_events").add({
      data: {
        eventId: deterministicEventId(`${operationId}:${afterSale._id}:${action}`),
        eventType: action === "receive" ? "after_sale.return_received" : "after_sale.inspected",
        entityType: "after_sale",
        entityId: cleanString(afterSale._id || afterSale.id, 128),
        action,
        version: versionOf(next),
        changedFields: action === "receive"
          ? ["afterSaleStatus", "returnLogistics", "version", "updatedAt"]
          : ["afterSaleStatus", "inspectionResult", "version", "updatedAt"],
        actorType: "admin",
        actorRole: actor.role,
        sourceClient: actor.sourceClient,
        businessKey: operationId,
        audience: "owner",
        ownerKey: owner,
        createdAt: timestamp,
        expiresAt: new Date(timestamp.getTime() + 7 * 24 * 60 * 60 * 1000)
      }
    });
  }

  async function executeReceive({ actor, input, operationId }) {
    return db.runTransaction(async (tx) => {
      const afterSale = await getAfterSaleById(tx, input.afterSaleId);
      const { currentVersion } = assertSnapshot(afterSale, input, RECEIVE_STATUSES);
      const timestamp = now();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
        throw new ReturnInspectionError("CLOCK_INVALID", "退货验收时间源无效", 503);
      }
      const next = {
        ...afterSale,
        afterSaleStatus: "received",
        version: currentVersion + 1,
        returnLogistics: {
          ...(afterSale.returnLogistics || {}),
          receivedAt: timestamp
        },
        updatedAt: timestamp
      };
      await tx.collection("after_sales").doc(afterSale._id).update({
        data: {
          afterSaleStatus: "received",
          version: next.version,
          returnLogistics: next.returnLogistics,
          updatedAt: timestamp
        }
      });
      await tx.collection("orders").doc(afterSale.orderId).update({
        data: { afterSaleStatus: "received", updatedAt: timestamp }
      });
      const result = {
        afterSaleId: cleanString(afterSale._id || afterSale.id, 128),
        afterSaleStatus: "received",
        version: next.version,
        updatedAt: timestamp.toISOString(),
        restoredQuantity: 0,
        affected: 1
      };
      await writeAfterSaleLog(tx, {
        afterSale,
        action: "confirm_return_received",
        beforeData: afterSale,
        afterData: next,
        operator: actor,
        remark: input.remark || "后台确认收到退货",
        businessKey: operationId,
        resultData: returnResultEvidence(result, {
          action: "confirm_return_received",
          businessKey: operationId,
          operatorId: actor.id
        })
      });
      await writeAdminOperation(tx, {
        admin: actor,
        action: "after_sale:receive_return",
        resourceType: "after_sale",
        resourceId: afterSale._id,
        beforeData: snapshot(afterSale),
        afterData: snapshot(next),
        businessKey: operationId,
        description: "确认收到退货"
      });
      await writeSyncEvent(tx, {
        afterSale,
        actor,
        action: "receive",
        next,
        operationId,
        timestamp
      });
      return result;
    });
  }

  async function executeInspect({ actor, input, operationId, idempotencyKey }) {
    return db.runTransaction(async (tx) => {
      const afterSale = await getAfterSaleById(tx, input.afterSaleId);
      const { currentVersion } = assertSnapshot(afterSale, input, INSPECT_STATUSES);
      const groupedItems = new Map();
      let availableQuantity = 0;
      for (const item of Array.isArray(afterSale.returnItems) ? afterSale.returnItems : []) {
        const productId = cleanString(item && item.productId, 128);
        const quantity = item && item.returnQuantity;
        if (!productId || !Number.isSafeInteger(quantity) || quantity <= 0) {
          throw new ReturnInspectionError("RETURN_ITEM_DATA_INVALID", "退货商品数量数据异常，暂不能验货", 409);
        }
        const groupedQuantity = (groupedItems.get(productId) || 0) + quantity;
        const nextAvailableQuantity = availableQuantity + quantity;
        if (!Number.isSafeInteger(groupedQuantity) || !Number.isSafeInteger(nextAvailableQuantity)) {
          throw new ReturnInspectionError("RETURN_ITEM_DATA_INVALID", "退货商品数量数据异常，暂不能验货", 409);
        }
        groupedItems.set(productId, groupedQuantity);
        availableQuantity = nextAvailableQuantity;
      }
      if (input.canRestock && input.restockQuantity > availableQuantity) {
        throw new ReturnInspectionError("RESTOCK_QUANTITY_EXCEEDED", "恢复库存数量超过退货数量", 409);
      }
      let restoredQuantity = 0;
      if (input.canRestock && input.restockQuantity > 0) {
        let remaining = input.restockQuantity;
        for (const [productId, availableForProduct] of groupedItems) {
          if (remaining <= 0) break;
          const quantity = Math.min(availableForProduct, remaining);
          const businessKey = `after_sale_restock:${afterSale._id}:${productId}`;
          let existing;
          try {
            existing = await tx.collection("inventory_logs").where({ businessKey }).limit(2).get();
          } catch (error) {
            throw new ReturnInspectionError("INVENTORY_LOG_READ_FAILED", "库存流水校验失败，未执行退货回补", 503, {
              cause: cleanString(error && error.code, 80)
            });
          }
          if (!existing || !Array.isArray(existing.data)) {
            throw new ReturnInspectionError("INVENTORY_LOG_DATA_INVALID", "库存流水数据异常，暂不能继续验货", 503);
          }
          const existingRows = existing.data;
          if (existingRows.length > 1) {
            throw new ReturnInspectionError("INVENTORY_LOG_DUPLICATE", "库存业务流水重复，暂不能继续验货", 409);
          }
          if (existingRows[0]) {
            validateExistingInventoryLog(existingRows[0], {
              businessKey,
              productId,
              quantity,
              afterSaleId: cleanString(afterSale._id || afterSale.id, 128),
              orderId: cleanString(afterSale.orderId, 128)
            });
            restoredQuantity += quantity;
            remaining -= quantity;
            continue;
          }
          if (typeof applyInventoryMutationInTransaction === "function") {
            const product = (await tx.collection("products").doc(productId).get()).data;
            if (!product) throw new ReturnInspectionError("PRODUCT_NOT_FOUND", "退货商品不存在", 409);
            const mutationResult = await applyInventoryMutationInTransaction({
              db,
              store: tx,
              stockAlert,
              input: {
                productId,
                mode: "delta",
                delta: quantity,
                expectedStock: product.stock,
                expectedVersion: product.version === undefined ? 0 : product.version
              },
              actor,
              context: {
                businessKey,
                sourceType: "after_sale",
                sourceId: afterSale._id,
                relatedOrderId: afterSale.orderId,
                relatedAfterSaleId: afterSale._id,
                idempotencyKey,
                reasonCode: "after_sale_return_restock",
                operationReason: "退货验货恢复库存",
                writeAudit: false,
                writeSync: true,
                now: now()
              }
            });
            validateInventoryMutationResult(mutationResult, { productId, quantity });
          } else if (typeof incrementInventory === "function") {
            await incrementInventory({
              tx,
              productId,
              quantity,
              afterSale,
              actor,
              idempotencyKey,
              businessKey
            });
          } else {
            throw new Error("return inspection service requires inventory mutation adapter");
          }
          restoredQuantity += quantity;
          remaining -= quantity;
        }
      }
      const timestamp = now();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
        throw new ReturnInspectionError("CLOCK_INVALID", "退货验货时间源无效", 503);
      }
      const nextStatus = nextInspectionStatus(afterSale);
      const inspectionResult = {
        received: true,
        itemCondition: input.itemCondition,
        canRestock: input.canRestock,
        restockQuantity: restoredQuantity,
        inspectionRemark: input.inspectionRemark,
        inspectedBy: actor.id,
        inspectedAt: timestamp
      };
      const next = {
        ...afterSale,
        afterSaleStatus: nextStatus,
        version: currentVersion + 1,
        inspectionResult,
        updatedAt: timestamp
      };
      await tx.collection("after_sales").doc(afterSale._id).update({
        data: {
          afterSaleStatus: nextStatus,
          version: next.version,
          inspectionResult,
          updatedAt: timestamp
        }
      });
      await tx.collection("orders").doc(afterSale.orderId).update({
        data: { afterSaleStatus: nextStatus, updatedAt: timestamp }
      });
      const result = {
        afterSaleId: cleanString(afterSale._id || afterSale.id, 128),
        afterSaleStatus: nextStatus,
        version: next.version,
        updatedAt: timestamp.toISOString(),
        restoredQuantity,
        affected: 1
      };
      await writeAfterSaleLog(tx, {
        afterSale,
        action: "inspect_return_items",
        beforeData: afterSale,
        afterData: next,
        operator: actor,
        remark: input.inspectionRemark || (input.canRestock ? `验货完成，恢复库存 ${restoredQuantity} 件` : "验货完成，未恢复普通库存"),
        businessKey: operationId,
        resultData: returnResultEvidence(result, {
          action: "inspect_return_items",
          businessKey: operationId,
          operatorId: actor.id
        })
      });
      await writeAdminOperation(tx, {
        admin: actor,
        action: "after_sale:inspect",
        resourceType: "after_sale",
        resourceId: afterSale._id,
        beforeData: snapshot(afterSale),
        afterData: snapshot(next),
        businessKey: operationId,
        description: "验货售后商品"
      });
      await writeSyncEvent(tx, {
        afterSale,
        actor,
        action: "inspect",
        next,
        operationId,
        timestamp
      });
      return result;
    });
  }

  async function run(action, command = {}) {
    const input = normalizeInspectionInput(command.input || {}, { strict: command.strict !== false });
    const actor = normalizeInspectionActor(command.actor, input.action);
    const idempotencyKey = idempotency.assertIdempotencyKey(command.idempotencyKey);
    await ensureCollections();
    const operationId = idempotencyKey;
    const actionLog = input.action === "receive" ? "confirm_return_received" : "inspect_return_items";
    async function recoverCommittedResult() {
      try {
        const logs = await db.collection("after_sale_logs")
          .where({ businessKey: operationId, action: actionLog })
          .limit(2)
          .get();
        if (!logs || !Array.isArray(logs.data) || logs.data.length !== 1) return null;
        const log = logs.data[0];
        return recoverResultFromEvidence(log, {
          action: actionLog,
          afterSaleId: input.afterSaleId,
          businessKey: operationId,
          operatorId: actor.id,
          input
        });
      } catch {
        return null;
      }
    }
    const result = await idempotency.runIdempotentAction({
      db,
      actionType: `after_sale_${input.action === "receive" ? "receive_return" : "inspect_return"}`,
      idempotencyKey,
      operatorIdentity: actor.id,
      operatorType: "admin",
      scope: "after_sale",
      scopeId: input.afterSaleId,
      openid: actor.openid,
      adminId: actor.id,
      payload: input,
      recoverProcessingResult: recoverCommittedResult
    }, async () => input.action === "receive"
      ? executeReceive({ actor, input, operationId })
      : executeInspect({ actor, input, operationId, idempotencyKey }));
    if (!result || result.ok !== true || !result.data) {
      const error = new ReturnInspectionError(
        result && result.code || "IDEMPOTENCY_NOT_EXECUTABLE",
        result && result.message || "退货验收操作不可执行",
        409
      );
      throw error;
    }
    return {
      ...result.data,
      affected: result.data.duplicate === true ? 0 : result.data.affected,
      reused: result.data.reused === true || result.data.duplicate === true
    };
  }

  return {
    confirmReturnReceived(command) {
      return run("receive", command);
    },
    inspectReturnItems(command) {
      return run("inspect", command);
    }
  };
}

module.exports = {
  ReturnInspectionError,
  normalizeInspectionActor,
  normalizeInspectionInput,
  nextInspectionStatus,
  createReturnInspectionService
};
