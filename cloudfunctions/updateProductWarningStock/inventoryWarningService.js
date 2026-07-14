const crypto = require("crypto");

const ACTION_TYPE = "update_warning_stock";
const REQUIRED_PERMISSION = "inventory:set_warning";
const SYNC_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class InventoryWarningError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "InventoryWarningError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
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
  if (!id || !role) throw new InventoryWarningError("INVALID_ACTOR", "管理员身份无效", 403);
  if (!hasPermission(actor, REQUIRED_PERMISSION)) {
    throw new InventoryWarningError("FORBIDDEN", "无权设置库存预警值", 403);
  }
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
    if (required) throw new InventoryWarningError("EXPECTED_VERSION_REQUIRED", "缺少数据版本，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InventoryWarningError("EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeExpectedWarningThreshold(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new InventoryWarningError(
        "EXPECTED_WARNING_THRESHOLD_REQUIRED",
        "缺少原库存预警值，请刷新后重试",
        400
      );
    }
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 99999) {
    throw new InventoryWarningError(
      "EXPECTED_WARNING_THRESHOLD_INVALID",
      "原库存预警值无效，请刷新后重试",
      400
    );
  }
  return value;
}

function normalizeInput(input = {}, requireExpectedVersion = true) {
  if (typeof input.productId !== "string") {
    throw new InventoryWarningError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  }
  const productId = cleanString(input.productId, 128);
  if (!productId) throw new InventoryWarningError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  const warningThreshold = input.warningThreshold;
  if (typeof warningThreshold !== "number"
    || !Number.isSafeInteger(warningThreshold)
    || warningThreshold < 0
    || warningThreshold > 99999) {
    throw new InventoryWarningError("WARNING_THRESHOLD_INVALID", "预警库存必须是 0 到 99999 的整数", 400);
  }
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== "string") {
    throw new InventoryWarningError("REASON_INVALID", "操作说明格式无效", 400);
  }
  return {
    productId,
    warningThreshold,
    expectedVersion: normalizeExpectedVersion(input.expectedVersion, requireExpectedVersion),
    expectedWarningThreshold: normalizeExpectedWarningThreshold(input.expectedWarningThreshold, requireExpectedVersion),
    reason: cleanString(input.reason, 120)
  };
}

function versionOf(product = {}) {
  const raw = product.version !== undefined ? product.version : product.dataVersion;
  if (raw === undefined || raw === null || raw === "") return 0;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new InventoryWarningError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  return version;
}

function warningThresholdOf(product = {}) {
  const raw = product.warningStock !== undefined && product.warningStock !== null
    ? product.warningStock
    : product.warningThreshold;
  if (raw === undefined || raw === null || raw === "") return 0;
  if ((typeof raw !== "number" && typeof raw !== "string")
    || (typeof raw === "string" && !raw.trim())) {
    throw new InventoryWarningError("DATA_WARNING_THRESHOLD_INVALID", "商品库存预警值异常，暂不能修改", 409);
  }
  const warningThreshold = Number(raw);
  if (!Number.isSafeInteger(warningThreshold) || warningThreshold < 0 || warningThreshold > 99999) {
    throw new InventoryWarningError("DATA_WARNING_THRESHOLD_INVALID", "商品库存预警值异常，暂不能修改", 409);
  }
  return warningThreshold;
}

function stockOf(product = {}) {
  if (typeof product.stock !== "number"
    || !Number.isSafeInteger(product.stock)
    || product.stock < 0) {
    throw new InventoryWarningError("DATA_STOCK_INVALID", "商品库存数据异常，暂不能修改", 409);
  }
  return product.stock;
}

function deterministicKey(prefix, value) {
  const digest = crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40);
  return `${prefix}:${digest}`;
}

function missingDocument(err) {
  return /DOCUMENT_NOT_EXIST|document not exist|not found|ResourceNotFound/i
    .test(String(err && err.message || err || ""));
}

function idempotencyFailure(result) {
  const code = cleanString(result && result.code, 80) || "IDEMPOTENCY_FAILED";
  const statusCode = ["IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400;
  return new InventoryWarningError(code, cleanString(result && result.message, 240) || "幂等校验失败", statusCode, result && result.data);
}

function resultFromProduct(productId, product, overrides = {}) {
  return {
    productId,
    stock: stockOf(product),
    warningStock: warningThresholdOf(product),
    stockStatus: cleanString(product.stockStatus, 40),
    autoHideWhenOutOfStock: product.autoHideWhenOutOfStock === true,
    isActive: product.isActive !== false,
    version: versionOf(product),
    changed: overrides.changed !== false,
    reused: overrides.reused === true
  };
}

function createInventoryWarningService({ db, stockAlert, idempotency, now = () => new Date(), randomId = () => crypto.randomUUID() } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("inventory warning service requires db.runTransaction");
  if (!stockAlert || typeof stockAlert.buildStockStatusUpdate !== "function" || typeof stockAlert.syncStockAlertRecord !== "function") {
    throw new Error("inventory warning service requires stockAlert helpers");
  }
  if (!idempotency || typeof idempotency.runIdempotentAction !== "function" || typeof idempotency.assertIdempotencyKey !== "function") {
    throw new Error("inventory warning service requires idempotency helpers");
  }

  async function execute({ actor, input, idempotencyKey, operationId, legacyAutoHideWhenOutOfStock }) {
    const businessKey = deterministicKey("warning_stock", `${actor.id}:${operationId}:${input.productId}`);
    return db.runTransaction(async (tx) => {
      let product;
      try {
        product = (await tx.collection("products").doc(input.productId).get()).data;
      } catch (err) {
        if (!missingDocument(err)) throw err;
      }
      if (!product || product.isDeleted === true) {
        throw new InventoryWarningError("PRODUCT_NOT_FOUND", "商品不存在", 404);
      }

      const currentStock = stockOf(product);

      const existingLog = await tx.collection("inventory_logs").where({ businessKey }).limit(1).get();
      if (existingLog.data && existingLog.data[0]) {
        return resultFromProduct(input.productId, product, { reused: true, changed: false });
      }

      const currentVersion = versionOf(product);
      const currentWarningThreshold = warningThresholdOf(product);
      const versionConflict = input.expectedVersion !== undefined && input.expectedVersion !== currentVersion;
      const warningConflict = input.expectedWarningThreshold !== undefined
        && input.expectedWarningThreshold !== currentWarningThreshold;
      if (versionConflict || warningConflict) {
        throw new InventoryWarningError(
          "DATA_VERSION_CONFLICT",
          "记录已变化，请刷新后重新确认",
          409,
          {
            expectedVersion: input.expectedVersion,
            currentVersion,
            expectedWarningThreshold: input.expectedWarningThreshold,
            currentWarningThreshold,
            conflictFields: [
              ...(versionConflict ? ["version"] : []),
              ...(warningConflict ? ["warningThreshold"] : [])
            ]
          }
        );
      }

      const timestamp = db.serverDate();
      const nextVersion = currentVersion + 1;
      const overrides = {
        stock: currentStock,
        warningStock: input.warningThreshold,
        now: timestamp
      };
      if (typeof legacyAutoHideWhenOutOfStock === "boolean") {
        overrides.autoHideWhenOutOfStock = legacyAutoHideWhenOutOfStock;
      }
      const statusUpdate = stockAlert.buildStockStatusUpdate(product, overrides);
      const updateData = {
        warningStock: statusUpdate.warningStock,
        stockStatus: statusUpdate.stockStatus,
        autoHideWhenOutOfStock: statusUpdate.autoHideWhenOutOfStock,
        lastStockCheckAt: statusUpdate.lastStockCheckAt,
        updatedAt: statusUpdate.updatedAt,
        version: nextVersion,
        warningStockUpdatedAt: timestamp
      };
      if (statusUpdate.isActive === false) updateData.isActive = false;
      const nextProduct = { ...product, ...updateData };

      await tx.collection("products").doc(input.productId).update({ data: updateData });
      await stockAlert.syncStockAlertRecord(
        { db, store: tx },
        input.productId,
        nextProduct,
        updateData.stockStatus,
        actor.id
      );
      await tx.collection("inventory_logs").add({
        data: {
          businessKey,
          sourceType: ACTION_TYPE,
          sourceId: operationId,
          idempotencyKey: idempotencyKey || "",
          productId: input.productId,
          beforeStock: currentStock,
          afterStock: currentStock,
          changeAmount: 0,
          reason: ACTION_TYPE,
          operationReason: input.reason,
          relatedOrderId: "",
          operatorId: actor.id,
          operatorOpenid: actor.openid,
          operatorRole: actor.role,
          sourceClient: actor.sourceClient,
          stockStatusBefore: cleanString(product.stockStatus, 40),
          stockStatusAfter: updateData.stockStatus,
          warningStockBefore: currentWarningThreshold,
          warningStock: input.warningThreshold,
          versionBefore: currentVersion,
          versionAfter: nextVersion,
          triggeredAlert: updateData.stockStatus === "warning" || updateData.stockStatus === "out_of_stock",
          createdAt: timestamp
        }
      });
      await tx.collection("sync_events").add({
        data: {
          eventId: deterministicKey("inventory_warning", businessKey),
          eventType: "inventory.warning_updated",
          entityType: "inventory",
          entityId: input.productId,
          action: "set_warning",
          version: nextVersion,
          changedFields: ["warningStock", "stockStatus", "updatedAt", "version"],
          actorType: "admin",
          actorRole: actor.role,
          sourceClient: actor.sourceClient,
          businessKey,
          audienceRoles: ["procurement", "super_admin"],
          createdAt: timestamp,
          expiresAt: new Date(now().getTime() + SYNC_EVENT_TTL_MS)
        }
      });

      return resultFromProduct(input.productId, nextProduct);
    });
  }

  async function setWarningStock(command = {}) {
    const actor = normalizeActor(command.actor);
    const legacyMode = command.requireExpectedVersion === false;
    const input = normalizeInput(command.input, !legacyMode);
    const rawKey = cleanString(command.idempotencyKey, 200);
    const legacyAutoHideWhenOutOfStock = legacyMode && typeof command.legacyAutoHideWhenOutOfStock === "boolean"
      ? command.legacyAutoHideWhenOutOfStock
      : undefined;

    if (!rawKey) {
      if (!legacyMode || command.allowMissingIdempotencyKey !== true) {
        try {
          idempotency.assertIdempotencyKey(rawKey);
        } catch (err) {
          throw new InventoryWarningError(err.code || "IDEMPOTENCY_KEY_REQUIRED", err.message || "缺少操作凭证", 400);
        }
      }
      return execute({
        actor,
        input,
        idempotencyKey: "",
        operationId: `legacy_${cleanString(randomId(), 80)}`,
        legacyAutoHideWhenOutOfStock
      });
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.assertIdempotencyKey(rawKey);
    } catch (err) {
      throw new InventoryWarningError(err.code || "IDEMPOTENCY_KEY_INVALID", err.message || "操作凭证无效", 400);
    }
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
      payload: {
        productId: input.productId,
        warningThreshold: input.warningThreshold,
        expectedVersion: input.expectedVersion,
        expectedWarningThreshold: input.expectedWarningThreshold,
        reason: input.reason,
        legacyAutoHideWhenOutOfStock
      }
    }, () => execute({
      actor,
      input,
      idempotencyKey,
      operationId: idempotencyKey,
      legacyAutoHideWhenOutOfStock
    }));
    if (!outcome || outcome.ok !== true) throw idempotencyFailure(outcome);
    return outcome.data;
  }

  return { setWarningStock };
}

module.exports = {
  ACTION_TYPE,
  REQUIRED_PERMISSION,
  InventoryWarningError,
  createInventoryWarningService,
  normalizeActor,
  normalizeInput,
  versionOf,
  warningThresholdOf
};
