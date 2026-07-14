const crypto = require("crypto");

const ACTION_TYPE = "update_product_price";
const REQUIRED_PERMISSION = "product:update_price";
const SYNC_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class ProductPriceError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "ProductPriceError";
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
  if (!id || !role) throw new ProductPriceError("INVALID_ACTOR", "管理员身份无效", 403);
  if (!hasPermission(actor, REQUIRED_PERMISSION)) {
    throw new ProductPriceError("FORBIDDEN", "无权修改商品售价", 403);
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
    if (required) throw new ProductPriceError("EXPECTED_VERSION_REQUIRED", "缺少数据版本，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProductPriceError("EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeExpectedPrice(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ProductPriceError("EXPECTED_PRICE_REQUIRED", "缺少当前售价，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProductPriceError("EXPECTED_PRICE_INVALID", "当前售价无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeInput(input = {}, requireExpectedVersion = true) {
  if (typeof input.productId !== "string") {
    throw new ProductPriceError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  }
  const productId = cleanString(input.productId, 128);
  if (!productId) throw new ProductPriceError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  if (typeof input.newPriceCents !== "number"
    || !Number.isSafeInteger(input.newPriceCents)
    || input.newPriceCents < 0) {
    throw new ProductPriceError("PRICE_INVALID", "售价必须是非负整数分", 400);
  }
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== "string") {
    throw new ProductPriceError("REASON_INVALID", "操作说明格式无效", 400);
  }
  return {
    productId,
    newPriceCents: input.newPriceCents,
    expectedPriceCents: normalizeExpectedPrice(input.expectedPriceCents, requireExpectedVersion),
    expectedVersion: normalizeExpectedVersion(input.expectedVersion, requireExpectedVersion),
    reason: cleanString(input.reason, 120)
  };
}

function versionOf(product = {}) {
  const raw = product.version !== undefined ? product.version : product.dataVersion;
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ProductPriceError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  return raw;
}

function priceOf(product = {}) {
  const raw = product.price;
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ProductPriceError("DATA_PRICE_INVALID", "商品售价数据异常，暂不能修改", 409);
  }
  return raw;
}

function deterministicKey(prefix, value) {
  const digest = crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40);
  return `${prefix}:${digest}`;
}

function missingDocument(error) {
  return /DOCUMENT_NOT_EXIST|document not exist|not found|ResourceNotFound/i
    .test(String(error && error.message || error || ""));
}

function idempotencyFailure(result) {
  const code = cleanString(result && result.code, 80) || "IDEMPOTENCY_FAILED";
  const statusCode = ["IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400;
  return new ProductPriceError(code, cleanString(result && result.message, 240) || "幂等校验失败", statusCode, result && result.data);
}

function resultFromProduct(productId, product, beforePrice, overrides = {}) {
  return {
    productId,
    beforePrice,
    afterPrice: priceOf(product),
    isActive: product.isActive !== false,
    status: cleanString(product.status, 40),
    version: overrides.version === undefined ? versionOf(product) : overrides.version,
    updatedAt: overrides.updatedAt === undefined ? product.updatedAt || null : overrides.updatedAt,
    changed: overrides.changed !== false,
    reused: overrides.reused === true
  };
}

function resultFromExistingLog(productId, product, log, requestedPrice) {
  const beforePrice = priceOf({ price: log.beforePrice });
  const afterPrice = priceOf({ price: log.afterPrice });
  if (afterPrice !== requestedPrice) {
    throw new ProductPriceError("IDEMPOTENCY_KEY_CONFLICT", "操作凭证已用于其他售价", 409);
  }
  const versionAfter = log.versionAfter === undefined ? versionOf(product) : log.versionAfter;
  if (typeof versionAfter !== "number" || !Number.isSafeInteger(versionAfter) || versionAfter < 0) {
    throw new ProductPriceError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  return resultFromProduct(productId, { ...product, price: afterPrice }, beforePrice, {
    version: versionAfter,
    updatedAt: log.createdAt || product.updatedAt || null,
    changed: false,
    reused: true
  });
}

function createProductPriceService({ db, idempotency, now = () => new Date(), randomId = () => crypto.randomUUID() } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("product price service requires db.runTransaction");
  if (!idempotency
    || typeof idempotency.runIdempotentAction !== "function"
    || typeof idempotency.assertIdempotencyKey !== "function"
    || typeof idempotency.ensureCollection !== "function") {
    throw new Error("product price service requires idempotency helpers");
  }

  async function ensureCollections() {
    await idempotency.ensureCollection(db, "price_logs");
    await idempotency.ensureCollection(db, "sync_events");
  }

  async function recoverCommittedResult({ actor, input, operationId }) {
    const businessKey = deterministicKey("product_price", `${actor.id}:${operationId}:${input.productId}`);
    let product;
    try {
      product = (await db.collection("products").doc(input.productId).get()).data;
    } catch (error) {
      if (!missingDocument(error)) throw error;
    }
    if (!product || product.isDeleted === true) return null;
    const existingLog = await db.collection("price_logs").where({ businessKey }).limit(1).get();
    if (!existingLog.data || !existingLog.data[0]) return null;
    return resultFromExistingLog(input.productId, product, existingLog.data[0], input.newPriceCents);
  }

  async function execute({ actor, input, idempotencyKey, operationId }) {
    const businessKey = deterministicKey("product_price", `${actor.id}:${operationId}:${input.productId}`);
    return db.runTransaction(async (tx) => {
      let product;
      try {
        product = (await tx.collection("products").doc(input.productId).get()).data;
      } catch (error) {
        if (!missingDocument(error)) throw error;
      }
      if (!product || product.isDeleted === true) {
        throw new ProductPriceError("PRODUCT_NOT_FOUND", "商品不存在", 404);
      }

      const existingLog = await tx.collection("price_logs").where({ businessKey }).limit(1).get();
      if (existingLog.data && existingLog.data[0]) {
        return resultFromExistingLog(input.productId, product, existingLog.data[0], input.newPriceCents);
      }

      const currentVersion = versionOf(product);
      const currentPrice = priceOf(product);
      const versionConflict = input.expectedVersion !== undefined && input.expectedVersion !== currentVersion;
      const priceConflict = input.expectedPriceCents !== undefined && input.expectedPriceCents !== currentPrice;
      if (versionConflict || priceConflict) {
        throw new ProductPriceError(
          "DATA_VERSION_CONFLICT",
          "记录已变化，请刷新后重新确认",
          409,
          {
            expectedVersion: input.expectedVersion,
            currentVersion,
            expectedPriceCents: input.expectedPriceCents,
            currentPriceCents: currentPrice,
            conflictFields: [
              ...(versionConflict ? ["version"] : []),
              ...(priceConflict ? ["price"] : [])
            ]
          }
        );
      }

      if (currentPrice === input.newPriceCents) {
        return resultFromProduct(input.productId, product, currentPrice, { changed: false });
      }

      const timestamp = db.serverDate();
      const nextVersion = currentVersion + 1;
      const updateData = {
        price: input.newPriceCents,
        priceUpdatedAt: timestamp,
        priceUpdatedBy: actor.openid || actor.id,
        updatedAt: timestamp,
        version: nextVersion
      };
      const nextProduct = { ...product, ...updateData };

      await tx.collection("products").doc(input.productId).update({ data: updateData });
      await tx.collection("price_logs").add({
        data: {
          businessKey,
          sourceType: "manual",
          sourceId: operationId,
          idempotencyKey: idempotencyKey || "",
          productId: input.productId,
          productIndex: product.productIndex || "",
          productName: product.name || "",
          beforePrice: currentPrice,
          afterPrice: input.newPriceCents,
          changeType: "set",
          changeValue: input.newPriceCents,
          operatorId: actor.id,
          operatorOpenid: actor.openid,
          operatorRole: actor.role,
          sourceClient: actor.sourceClient,
          reason: input.reason,
          versionBefore: currentVersion,
          versionAfter: nextVersion,
          createdAt: timestamp
        }
      });
      await tx.collection("sync_events").add({
        data: {
          eventId: deterministicKey("product_price_event", businessKey),
          eventType: "product.price_updated",
          entityType: "product",
          entityId: input.productId,
          action: "change_price",
          version: nextVersion,
          changedFields: ["price", "updatedAt", "version"],
          actorType: "admin",
          actorRole: actor.role,
          sourceClient: actor.sourceClient,
          businessKey,
          audience: "public",
          isPublic: true,
          audienceRoles: ["procurement", "super_admin"],
          createdAt: timestamp,
          expiresAt: new Date(now().getTime() + SYNC_EVENT_TTL_MS)
        }
      });

      return resultFromProduct(input.productId, nextProduct, currentPrice);
    });
  }

  async function setPrice(command = {}) {
    const actor = normalizeActor(command.actor);
    const legacyMode = command.requireExpectedVersion === false;
    const input = normalizeInput(command.input, !legacyMode);
    const rawKey = cleanString(command.idempotencyKey, 200);

    if (!rawKey) {
      if (!legacyMode || command.allowMissingIdempotencyKey !== true) {
        try {
          idempotency.assertIdempotencyKey(rawKey);
        } catch (error) {
          throw new ProductPriceError(error.code || "IDEMPOTENCY_KEY_REQUIRED", error.message || "缺少操作凭证", 400);
        }
      }
      await ensureCollections();
      return execute({
        actor,
        input,
        idempotencyKey: "",
        operationId: `legacy_${cleanString(randomId(), 80)}`
      });
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.assertIdempotencyKey(rawKey);
    } catch (error) {
      throw new ProductPriceError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
    }
    await ensureCollections();
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
        newPriceCents: input.newPriceCents,
        expectedPriceCents: input.expectedPriceCents,
        expectedVersion: input.expectedVersion,
        reason: input.reason
      },
      recoverProcessingResult: () => recoverCommittedResult({
        actor,
        input,
        operationId: idempotencyKey
      })
    }, () => execute({
      actor,
      input,
      idempotencyKey,
      operationId: idempotencyKey
    }));
    if (!outcome || outcome.ok !== true) throw idempotencyFailure(outcome);
    return outcome.data;
  }

  return { setPrice };
}

module.exports = {
  ACTION_TYPE,
  REQUIRED_PERMISSION,
  SYNC_EVENT_TTL_MS,
  ProductPriceError,
  createProductPriceService,
  normalizeActor,
  normalizeInput,
  versionOf,
  priceOf
};
