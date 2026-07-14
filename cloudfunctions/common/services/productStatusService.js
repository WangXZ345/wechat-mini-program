const crypto = require("crypto");

const ACTION_TYPE = "set_product_status";
const BATCH_ACTION_TYPE = "set_product_status_many";
const BATCH_MAX_ITEMS = 100;
const BATCH_CONCURRENCY = 5;
const REQUIRED_PERMISSION = "product:update_status";
const SYNC_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class ProductStatusError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "ProductStatusError";
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
  if (!id || !role) throw new ProductStatusError("INVALID_ACTOR", "管理员身份无效", 403);
  if (!hasPermission(actor, REQUIRED_PERMISSION)) {
    throw new ProductStatusError("FORBIDDEN", "无权修改商品上下架状态", 403);
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
    if (required) throw new ProductStatusError("EXPECTED_VERSION_REQUIRED", "缺少数据版本，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProductStatusError("EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeExpectedIsActive(value, required) {
  if (value === undefined || value === null) {
    if (required) throw new ProductStatusError("EXPECTED_STATUS_REQUIRED", "缺少当前上下架状态，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ProductStatusError("EXPECTED_STATUS_INVALID", "当前上下架状态无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeInput(input = {}, requireExpectedVersion = true) {
  if (typeof input.productId !== "string") {
    throw new ProductStatusError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  }
  const productId = cleanString(input.productId, 128);
  if (!productId) throw new ProductStatusError("PRODUCT_ID_REQUIRED", "缺少商品 ID", 400);
  if (typeof input.isActive !== "boolean") {
    throw new ProductStatusError("STATUS_INVALID", "上下架状态必须是布尔值", 400);
  }
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== "string") {
    throw new ProductStatusError("REASON_INVALID", "操作说明格式无效", 400);
  }
  return {
    productId,
    isActive: input.isActive,
    expectedIsActive: normalizeExpectedIsActive(input.expectedIsActive, requireExpectedVersion),
    expectedVersion: normalizeExpectedVersion(input.expectedVersion, requireExpectedVersion),
    reason: cleanString(input.reason, 120)
  };
}

function normalizeManyInput(input = {}, requireExpectedVersion = true) {
  if (input.isActive !== true) {
    throw new ProductStatusError("STATUS_INVALID", "批量操作仅支持上架商品", 400);
  }
  if (!Array.isArray(input.items)) {
    throw new ProductStatusError("BATCH_ITEMS_REQUIRED", "请选择要上架的商品", 400);
  }
  if (input.items.length > BATCH_MAX_ITEMS) {
    throw new ProductStatusError("BATCH_LIMIT_EXCEEDED", `一次最多上架 ${BATCH_MAX_ITEMS} 个商品`, 400);
  }
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== "string") {
    throw new ProductStatusError("REASON_INVALID", "操作说明格式无效", 400);
  }

  const itemsById = new Map();
  for (const item of input.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string") {
      throw new ProductStatusError("PRODUCT_ID_REQUIRED", "批量商品项缺少商品 ID", 400);
    }
    const id = cleanString(item.id, 128);
    if (!id || item.id.trim().length > 128) {
      throw new ProductStatusError("PRODUCT_ID_REQUIRED", "批量商品项缺少商品 ID", 400);
    }
    const normalized = {
      id,
      expectedIsActive: normalizeExpectedIsActive(item.expectedIsActive, requireExpectedVersion),
      expectedVersion: normalizeExpectedVersion(item.expectedVersion, requireExpectedVersion)
    };
    const existing = itemsById.get(id);
    if (existing) {
      if (existing.expectedIsActive !== normalized.expectedIsActive
        || existing.expectedVersion !== normalized.expectedVersion) {
        throw new ProductStatusError("BATCH_ITEM_CONFLICT", "同一商品包含冲突的数据快照", 400);
      }
      continue;
    }
    itemsById.set(id, normalized);
  }

  const items = Array.from(itemsById.values());
  if (!items.length) {
    throw new ProductStatusError("BATCH_ITEMS_REQUIRED", "请选择要上架的商品", 400);
  }
  if (items.length > BATCH_MAX_ITEMS) {
    throw new ProductStatusError("BATCH_LIMIT_EXCEEDED", `一次最多上架 ${BATCH_MAX_ITEMS} 个商品`, 400);
  }
  return {
    isActive: true,
    items,
    reason: cleanString(input.reason, 120)
  };
}

function versionOf(product = {}) {
  const raw = product.version !== undefined ? product.version : product.dataVersion;
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ProductStatusError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  return raw;
}

function activeOf(product = {}) {
  if (product.isActive === undefined) return true;
  if (typeof product.isActive !== "boolean") {
    throw new ProductStatusError("DATA_STATUS_INVALID", "商品上下架状态异常，暂不能修改", 409);
  }
  return product.isActive;
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
  return new ProductStatusError(code, cleanString(result && result.message, 240) || "幂等校验失败", statusCode, result && result.data);
}

function safeFailureCode(error) {
  const code = cleanString(error && error.code, 80);
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : "PRODUCT_STATUS_UPDATE_FAILED";
}

function isStableItemFailure(error) {
  return [
    "PRODUCT_NOT_FOUND",
    "DATA_VERSION_CONFLICT",
    "DATA_STATUS_INVALID",
    "DATA_VERSION_INVALID"
  ].includes(cleanString(error && error.code, 80));
}

function batchChildKey(actorId, operationId, productId) {
  return deterministicKey("product_status_child", `${actorId}:${operationId}:${productId}`);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => run()));
  return results;
}

function resultFromProduct(productId, product, beforeIsActive, overrides = {}) {
  const isActive = activeOf(product);
  return {
    productId,
    beforeIsActive,
    afterIsActive: isActive,
    isActive,
    status: cleanString(product.status, 40),
    version: overrides.version === undefined ? versionOf(product) : overrides.version,
    updatedAt: overrides.updatedAt === undefined ? product.updatedAt || null : overrides.updatedAt,
    changed: overrides.changed !== false,
    reused: overrides.reused === true
  };
}

function resultFromExistingLog(productId, product, log, requestedIsActive) {
  const beforeIsActive = log.beforeIsActive;
  const afterIsActive = log.afterIsActive;
  if (typeof beforeIsActive !== "boolean" || typeof afterIsActive !== "boolean") {
    throw new ProductStatusError("DATA_STATUS_INVALID", "商品上下架日志异常，暂不能修改", 409);
  }
  if (afterIsActive !== requestedIsActive) {
    throw new ProductStatusError("IDEMPOTENCY_KEY_CONFLICT", "操作凭证已用于其他上下架状态", 409);
  }
  const versionAfter = log.versionAfter === undefined ? versionOf(product) : log.versionAfter;
  if (typeof versionAfter !== "number" || !Number.isSafeInteger(versionAfter) || versionAfter < 0) {
    throw new ProductStatusError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  return resultFromProduct(productId, { ...product, isActive: afterIsActive }, beforeIsActive, {
    version: versionAfter,
    updatedAt: log.createdAt || product.updatedAt || null,
    changed: false,
    reused: true
  });
}

function createProductStatusService({ db, idempotency, now = () => new Date(), randomId = () => crypto.randomUUID() } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("product status service requires db.runTransaction");
  if (!idempotency
    || typeof idempotency.runIdempotentAction !== "function"
    || typeof idempotency.assertIdempotencyKey !== "function"
    || typeof idempotency.ensureCollection !== "function") {
    throw new Error("product status service requires idempotency helpers");
  }

  async function ensureCollections() {
    await idempotency.ensureCollection(db, "admin_operation_logs");
    await idempotency.ensureCollection(db, "sync_events");
  }

  async function recoverCommittedResult({ actor, input, operationId }) {
    const businessKey = deterministicKey("product_status", `${actor.id}:${operationId}:${input.productId}`);
    let product;
    try {
      product = (await db.collection("products").doc(input.productId).get()).data;
    } catch (error) {
      if (!missingDocument(error)) throw error;
    }
    if (!product || product.isDeleted === true) return null;
    const existingLog = await db.collection("admin_operation_logs").where({ businessKey }).limit(1).get();
    if (!existingLog.data || !existingLog.data[0]) return null;
    return resultFromExistingLog(input.productId, product, existingLog.data[0], input.isActive);
  }

  async function execute({ actor, input, idempotencyKey, operationId }) {
    const businessKey = deterministicKey("product_status", `${actor.id}:${operationId}:${input.productId}`);
    return db.runTransaction(async (tx) => {
      let product;
      try {
        product = (await tx.collection("products").doc(input.productId).get()).data;
      } catch (error) {
        if (!missingDocument(error)) throw error;
      }
      if (!product || product.isDeleted === true) {
        throw new ProductStatusError("PRODUCT_NOT_FOUND", "商品不存在", 404);
      }

      const existingLog = await tx.collection("admin_operation_logs").where({ businessKey }).limit(1).get();
      if (existingLog.data && existingLog.data[0]) {
        return resultFromExistingLog(input.productId, product, existingLog.data[0], input.isActive);
      }

      const currentVersion = versionOf(product);
      const currentIsActive = activeOf(product);
      const versionConflict = input.expectedVersion !== undefined && input.expectedVersion !== currentVersion;
      const statusConflict = input.expectedIsActive !== undefined && input.expectedIsActive !== currentIsActive;
      if (versionConflict || statusConflict) {
        throw new ProductStatusError(
          "DATA_VERSION_CONFLICT",
          "记录已变化，请刷新后重新确认",
          409,
          {
            expectedVersion: input.expectedVersion,
            currentVersion,
            expectedIsActive: input.expectedIsActive,
            currentIsActive,
            conflictFields: [
              ...(versionConflict ? ["version"] : []),
              ...(statusConflict ? ["isActive"] : [])
            ]
          }
        );
      }

      if (currentIsActive === input.isActive) {
        return resultFromProduct(input.productId, product, currentIsActive, { changed: false });
      }

      const timestamp = db.serverDate();
      const nextVersion = currentVersion + 1;
      const updateData = {
        isActive: input.isActive,
        updatedAt: timestamp,
        version: nextVersion
      };
      const nextProduct = { ...product, ...updateData };
      const action = input.isActive ? "activate" : "deactivate";
      const description = input.isActive ? "商品已上架" : "商品已下架";

      await tx.collection("products").doc(input.productId).update({ data: updateData });
      await tx.collection("admin_operation_logs").add({
        data: {
          businessKey,
          sourceId: operationId,
          idempotencyKey: idempotencyKey || "",
          action: "set_product_status",
          resourceType: "product",
          resourceId: input.productId,
          productId: input.productId,
          productIndex: product.productIndex || "",
          productName: product.name || "",
          beforeIsActive: currentIsActive,
          afterIsActive: input.isActive,
          beforeData: { isActive: currentIsActive, version: currentVersion },
          afterData: { isActive: input.isActive, version: nextVersion },
          operatorId: actor.id,
          operatorOpenid: actor.openid,
          operatorRole: actor.role,
          sourceClient: actor.sourceClient,
          reason: input.reason,
          versionBefore: currentVersion,
          versionAfter: nextVersion,
          description,
          publicSummary: description,
          status: "success",
          createdAt: timestamp
        }
      });
      await tx.collection("sync_events").add({
        data: {
          eventId: deterministicKey("product_status_event", businessKey),
          eventType: "product.status_updated",
          entityType: "product",
          entityId: input.productId,
          action,
          version: nextVersion,
          changedFields: ["isActive", "updatedAt", "version"],
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

      return resultFromProduct(input.productId, nextProduct, currentIsActive);
    });
  }

  async function setStatus(command = {}) {
    const actor = normalizeActor(command.actor);
    const legacyMode = command.requireExpectedVersion === false;
    const input = normalizeInput(command.input, !legacyMode);
    const rawKey = cleanString(command.idempotencyKey, 200);

    if (!rawKey) {
      if (!legacyMode || command.allowMissingIdempotencyKey !== true) {
        try {
          idempotency.assertIdempotencyKey(rawKey);
        } catch (error) {
          throw new ProductStatusError(error.code || "IDEMPOTENCY_KEY_REQUIRED", error.message || "缺少操作凭证", 400);
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
      throw new ProductStatusError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
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
        isActive: input.isActive,
        expectedIsActive: input.expectedIsActive,
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

  async function executeMany({ rawActor, actor, input, operationId }) {
    let fatalError = null;
    const outcomes = await mapWithConcurrency(input.items, BATCH_CONCURRENCY, async (item) => {
      if (fatalError) return { ok: false, skipped: true };
      try {
        const result = await setStatus({
          actor: rawActor,
          input: {
            productId: item.id,
            isActive: true,
            expectedIsActive: item.expectedIsActive,
            expectedVersion: item.expectedVersion,
            reason: input.reason
          },
          idempotencyKey: batchChildKey(actor.id, operationId, item.id),
          requireExpectedVersion: item.expectedVersion !== undefined
        });
        return { ok: true, result };
      } catch (error) {
        if (isStableItemFailure(error)) return { ok: false, code: safeFailureCode(error) };
        fatalError = fatalError || error;
        return { ok: false, fatal: true };
      }
    });

    if (fatalError) throw fatalError;
    return summarizeMany(input.items, outcomes);
  }

  function summarizeMany(items, outcomes) {
    let changedCount = 0;
    let unchangedCount = 0;
    const failures = [];
    outcomes.forEach((outcome, index) => {
      if (!outcome.ok) {
        failures.push({ id: items[index].id, code: outcome.code });
      } else if (outcome.result && (outcome.result.changed === true || outcome.result.reused === true)) {
        changedCount += 1;
      } else {
        unchangedCount += 1;
      }
    });
    return {
      changedCount,
      unchangedCount,
      failedCount: failures.length,
      failures
    };
  }

  async function recoverManyCompletedResult({ actor, input, operationId }) {
    const outcomes = await mapWithConcurrency(input.items, BATCH_CONCURRENCY, async (item) => {
      const childOperationId = batchChildKey(actor.id, operationId, item.id);
      const childInput = {
        productId: item.id,
        isActive: true,
        expectedIsActive: item.expectedIsActive,
        expectedVersion: item.expectedVersion,
        reason: input.reason
      };
      const recovered = await recoverCommittedResult({ actor, input: childInput, operationId: childOperationId });
      if (recovered) return { ok: true, result: recovered };

      let product;
      try {
        product = (await db.collection("products").doc(item.id).get()).data;
      } catch (error) {
        if (!missingDocument(error)) throw error;
      }
      if (!product || product.isDeleted === true) {
        return { ok: false, code: "PRODUCT_NOT_FOUND" };
      }
      let currentIsActive;
      let currentVersion;
      try {
        currentIsActive = activeOf(product);
        currentVersion = versionOf(product);
      } catch (error) {
        if (isStableItemFailure(error)) return { ok: false, code: safeFailureCode(error) };
        throw error;
      }
      if (item.expectedIsActive === undefined || item.expectedVersion === undefined) return null;
      const exactExpectedState = currentIsActive === item.expectedIsActive
        && currentVersion === item.expectedVersion;
      if (exactExpectedState && item.expectedIsActive === true) {
        return {
          ok: true,
          result: resultFromProduct(item.id, product, true, { changed: false })
        };
      }
      if (exactExpectedState) return null;
      return { ok: false, code: "DATA_VERSION_CONFLICT" };
    });
    if (outcomes.some((outcome) => !outcome
      || (outcome.ok !== true && !(outcome.ok === false && typeof outcome.code === "string")))) {
      return null;
    }
    return summarizeMany(input.items, outcomes);
  }

  async function setManyStatuses(command = {}) {
    const rawActor = command.actor;
    const actor = normalizeActor(rawActor);
    const legacyMode = command.requireExpectedVersion === false;
    const input = normalizeManyInput(command.input, !legacyMode);
    const rawKey = cleanString(command.idempotencyKey, 200);

    if (!rawKey) {
      if (!legacyMode || command.allowMissingIdempotencyKey !== true) {
        try {
          idempotency.assertIdempotencyKey(rawKey);
        } catch (error) {
          throw new ProductStatusError(error.code || "IDEMPOTENCY_KEY_REQUIRED", error.message || "缺少操作凭证", 400);
        }
      }
      return executeMany({
        rawActor,
        actor,
        input,
        operationId: `legacy_batch_${cleanString(randomId(), 80)}`
      });
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.assertIdempotencyKey(rawKey);
    } catch (error) {
      throw new ProductStatusError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
    }
    const outcome = await idempotency.runIdempotentAction({
      db,
      actionType: BATCH_ACTION_TYPE,
      idempotencyKey,
      operatorIdentity: actor.id,
      operatorType: "admin",
      scope: "products",
      scopeId: "batch-enable",
      openid: actor.openid,
      adminId: actor.id,
      ttlSeconds: 7 * 24 * 60 * 60,
      payload: input,
      recoverProcessingResult: () => recoverManyCompletedResult({
        actor,
        input,
        operationId: idempotencyKey
      })
    }, () => executeMany({
      rawActor,
      actor,
      input,
      operationId: idempotencyKey
    }));
    if (!outcome || outcome.ok !== true) throw idempotencyFailure(outcome);
    return outcome.data;
  }

  return { setStatus, setManyStatuses };
}

module.exports = {
  ACTION_TYPE,
  BATCH_ACTION_TYPE,
  BATCH_MAX_ITEMS,
  BATCH_CONCURRENCY,
  REQUIRED_PERMISSION,
  SYNC_EVENT_TTL_MS,
  ProductStatusError,
  createProductStatusService,
  normalizeActor,
  normalizeInput,
  normalizeManyInput,
  versionOf,
  activeOf
};
