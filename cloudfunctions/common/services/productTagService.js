const crypto = require("crypto");

const ACTION_TYPE = "set_many_public_product_tags";
const LEGACY_ACTION_TYPE = "batch_update_tags";
const BATCH_MAX_ITEMS = 100;
const LEGACY_BATCH_MAX_ITEMS = 200;
const BATCH_CONCURRENCY = 5;
const REQUIRED_PERMISSION = "product:tag:batch_update";
const SYNC_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_TAGS = Object.freeze(["新货", "瑕疵", "热销"]);
const TAG_FLAG = Object.freeze({
  "新货": "isNew",
  "瑕疵": "isDefective",
  "热销": "isHot"
});
const PUBLIC_INPUT_FIELDS = new Set(["scope", "tag", "present", "items", "reason"]);
const PUBLIC_ITEM_FIELDS = new Set(["id", "expectedVersion", "expectedPresent"]);
const LEGACY_FLAG_FIELDS = new Set(Object.values(TAG_FLAG));
const MAX_INTERNAL_TAGS = 20;
const MAX_TAG_LENGTH = 10;

class ProductTagError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "ProductTagError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueClean(values) {
  const list = Array.isArray(values)
    ? values
    : String(values === undefined || values === null ? "" : values).split(/[,，、\s/;；|]+/);
  return Array.from(new Set(list.map((item) => String(item || "").trim()).filter(Boolean)));
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
  if (!id || !role) throw new ProductTagError("INVALID_ACTOR", "管理员身份无效", 403);
  if (!hasPermission(actor, REQUIRED_PERMISSION)) {
    throw new ProductTagError("FORBIDDEN", "无权批量修改商品标签", 403);
  }
  return {
    id,
    openid: cleanString(actor.openid, 128),
    role,
    permissions: Array.isArray(actor.permissions) ? actor.permissions.slice() : [],
    sourceClient: actor.sourceClient === "miniprogram" ? "miniprogram" : "admin_web"
  };
}

function normalizeExpectedVersion(value, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ProductTagError("EXPECTED_VERSION_REQUIRED", "缺少数据版本，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProductTagError("EXPECTED_VERSION_INVALID", "数据版本无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeExpectedPresent(value, required = true) {
  if (value === undefined || value === null) {
    if (required) throw new ProductTagError("EXPECTED_PRESENT_REQUIRED", "缺少当前标签状态，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ProductTagError("EXPECTED_PRESENT_INVALID", "当前标签状态无效，请刷新后重试", 400);
  }
  return value;
}

function assertAllowedFields(value, allowed, code, message) {
  if (!isPlainObject(value)) throw new ProductTagError(code, message, 400);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ProductTagError(code, message, 400);
  }
}

function normalizeManyPublicInput(input = {}) {
  assertAllowedFields(input, PUBLIC_INPUT_FIELDS, "INVALID_REQUEST_BODY", "请求包含不允许的字段");
  if (input.scope !== "public") {
    throw new ProductTagError("TAG_SCOPE_INVALID", "仅支持修改公开商品标签", 400);
  }
  if (typeof input.tag !== "string" || !PUBLIC_TAGS.includes(input.tag.trim())) {
    throw new ProductTagError("PUBLIC_TAG_INVALID", "公开商品标签无效", 400);
  }
  if (typeof input.present !== "boolean") {
    throw new ProductTagError("TAG_PRESENT_INVALID", "标签目标状态必须是布尔值", 400);
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ProductTagError("BATCH_ITEMS_REQUIRED", "请至少选择一个商品", 400);
  }
  if (input.items.length > BATCH_MAX_ITEMS) {
    throw new ProductTagError("BATCH_LIMIT_EXCEEDED", `单次最多修改 ${BATCH_MAX_ITEMS} 个商品`, 400);
  }
  if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.trim().length > 120)) {
    throw new ProductTagError("REASON_INVALID", "操作说明格式无效", 400);
  }

  const itemsById = new Map();
  for (const rawItem of input.items) {
    assertAllowedFields(rawItem, PUBLIC_ITEM_FIELDS, "BATCH_ITEM_INVALID", "批量商品快照无效，请刷新后重试");
    if (typeof rawItem.id !== "string" || !rawItem.id.trim() || rawItem.id.trim().length > 128) {
      throw new ProductTagError("PRODUCT_ID_REQUIRED", "批量商品缺少有效 ID", 400);
    }
    const item = {
      id: rawItem.id.trim(),
      expectedVersion: normalizeExpectedVersion(rawItem.expectedVersion, true),
      expectedPresent: normalizeExpectedPresent(rawItem.expectedPresent, true)
    };
    const existing = itemsById.get(item.id);
    if (existing
      && (existing.expectedVersion !== item.expectedVersion
        || existing.expectedPresent !== item.expectedPresent)) {
      throw new ProductTagError("BATCH_ITEM_CONFLICT", "同一商品存在冲突快照，请刷新后重试", 400);
    }
    if (!existing) itemsById.set(item.id, item);
  }

  return {
    mode: "public",
    scope: "public",
    tag: input.tag.trim(),
    present: input.present,
    items: Array.from(itemsById.values()),
    reason: cleanString(input.reason, 120)
  };
}

function normalizePublicTagList(value, fieldName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ProductTagError("TAG_LIST_INVALID", `${fieldName} 格式无效`, 400);
  }
  const values = uniqueClean(value);
  if (values.some((tag) => !PUBLIC_TAGS.includes(tag))) {
    throw new ProductTagError("PUBLIC_TAG_INVALID", "公开商品标签无效", 400);
  }
  return PUBLIC_TAGS.filter((tag) => values.includes(tag));
}

function normalizeInternalTagList(value, fieldName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ProductTagError("INTERNAL_TAG_LIST_INVALID", `${fieldName} 格式无效`, 400);
  }
  const values = uniqueClean(value);
  if (values.length > MAX_INTERNAL_TAGS || values.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new ProductTagError("INTERNAL_TAG_INVALID", "内部标签最多 20 个，单个最多 10 个字", 400);
  }
  return values;
}

function normalizeLegacyFlags(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new ProductTagError("TAG_FLAGS_INVALID", "标签兼容状态格式无效", 400);
  if (Object.keys(value).some((key) => !LEGACY_FLAG_FIELDS.has(key))) {
    throw new ProductTagError("TAG_FLAGS_INVALID", "标签兼容状态包含不允许的字段", 400);
  }
  const flags = {};
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== "boolean") {
      throw new ProductTagError("TAG_FLAGS_INVALID", "标签兼容状态必须是布尔值", 400);
    }
    flags[key] = value[key];
  }
  return flags;
}

function normalizeManyLegacyInput(input = {}) {
  if (!Array.isArray(input.productIds) || input.productIds.length === 0) {
    throw new ProductTagError("BATCH_ITEMS_REQUIRED", "请选择要修改的商品", 400);
  }
  const productIds = Array.from(new Set(input.productIds.map((id) => cleanString(id, 128)).filter(Boolean)));
  if (!productIds.length) throw new ProductTagError("BATCH_ITEMS_REQUIRED", "请选择要修改的商品", 400);
  if (productIds.length > LEGACY_BATCH_MAX_ITEMS) {
    throw new ProductTagError("BATCH_LIMIT_EXCEEDED", `批量修改一次最多 ${LEGACY_BATCH_MAX_ITEMS} 个商品`, 400);
  }

  const addTags = normalizePublicTagList(input.addTags, "addTags");
  const removeTags = normalizePublicTagList(input.removeTags, "removeTags");
  const addInternalTags = normalizeInternalTagList(input.addInternalTags, "addInternalTags");
  const removeInternalTags = normalizeInternalTagList(input.removeInternalTags, "removeInternalTags");
  if (addTags.some((tag) => removeTags.includes(tag))) {
    throw new ProductTagError("TAG_OPERATION_CONFLICT", "同一公开标签不能同时添加和移除", 400);
  }
  if (addInternalTags.some((tag) => removeInternalTags.includes(tag))) {
    throw new ProductTagError("TAG_OPERATION_CONFLICT", "同一内部标签不能同时添加和移除", 400);
  }
  const setFlags = normalizeLegacyFlags(input.setFlags);
  if (input.defectDescription !== undefined && typeof input.defectDescription !== "string") {
    throw new ProductTagError("DEFECT_DESCRIPTION_INVALID", "瑕疵说明格式无效", 400);
  }
  if (input.reason !== undefined && typeof input.reason !== "string") {
    throw new ProductTagError("REASON_INVALID", "操作说明格式无效", 400);
  }

  return {
    mode: "legacy",
    items: productIds.map((id) => ({ id })),
    addTags,
    removeTags,
    addInternalTags,
    removeInternalTags,
    setFlags,
    hasDefectDescription: Object.prototype.hasOwnProperty.call(input, "defectDescription"),
    defectDescription: cleanString(input.defectDescription, 500),
    reason: cleanString(input.reason, 120)
  };
}

function versionOf(product = {}) {
  const raw = product.version !== undefined ? product.version : product.dataVersion;
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ProductTagError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  return raw;
}

function publicTagsOf(product = {}) {
  const tags = new Set();
  const stored = Array.isArray(product.tags) ? product.tags : [];
  stored.forEach((tag) => {
    const normalized = cleanString(tag, MAX_TAG_LENGTH);
    if (PUBLIC_TAGS.includes(normalized)) tags.add(normalized);
  });
  PUBLIC_TAGS.forEach((tag) => {
    if (product[TAG_FLAG[tag]] === true) tags.add(tag);
  });
  return PUBLIC_TAGS.filter((tag) => tags.has(tag));
}

function internalTagsOf(product = {}) {
  const tags = uniqueClean(product.internalTags || []);
  if (tags.length > MAX_INTERNAL_TAGS || tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new ProductTagError("DATA_INTERNAL_TAGS_INVALID", "商品内部标签数据异常，暂不能修改", 409);
  }
  return tags;
}

function publicTagPresent(product, tag) {
  return publicTagsOf(product).includes(tag);
}

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
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

function applyOperation(product, input) {
  const beforeTags = publicTagsOf(product);
  const tagSet = new Set(beforeTags);
  const beforeInternalTags = input.mode === "legacy" ? internalTagsOf(product) : product.internalTags;
  const internalTagSet = input.mode === "legacy" ? new Set(beforeInternalTags) : null;

  if (input.mode === "public") {
    if (input.present) tagSet.add(input.tag);
    else tagSet.delete(input.tag);
  } else {
    input.addTags.forEach((tag) => tagSet.add(tag));
    input.removeTags.forEach((tag) => tagSet.delete(tag));
    Object.entries(input.setFlags).forEach(([flag, present]) => {
      const tag = PUBLIC_TAGS.find((candidate) => TAG_FLAG[candidate] === flag);
      if (present) tagSet.add(tag);
      else tagSet.delete(tag);
    });
    input.addInternalTags.forEach((tag) => internalTagSet.add(tag));
    input.removeInternalTags.forEach((tag) => internalTagSet.delete(tag));
  }

  const tags = PUBLIC_TAGS.filter((tag) => tagSet.has(tag));
  const internalTags = input.mode === "legacy" ? Array.from(internalTagSet) : product.internalTags;
  if (input.mode === "legacy"
    && (internalTags.length > MAX_INTERNAL_TAGS || internalTags.some((tag) => tag.length > MAX_TAG_LENGTH))) {
    throw new ProductTagError("DATA_INTERNAL_TAGS_INVALID", "商品内部标签数据异常，暂不能修改", 409);
  }
  const defectDescription = input.mode === "legacy" && input.hasDefectDescription
    ? input.defectDescription
    : input.mode === "legacy"
      ? cleanString(product.defectDescription, 500)
      : product.defectDescription;
  const after = {
    tags,
    internalTags,
    isNew: tags.includes("新货"),
    isDefective: tags.includes("瑕疵"),
    isHot: tags.includes("热销"),
    isFrequent: input.mode === "legacy" ? false : product.isFrequent,
    defectDescription
  };
  const before = {
    tags: beforeTags,
    internalTags: beforeInternalTags,
    isNew: product.isNew === true,
    isDefective: product.isDefective === true,
    isHot: product.isHot === true,
    isFrequent: input.mode === "legacy" ? product.isFrequent === true : product.isFrequent,
    defectDescription: input.mode === "legacy"
      ? cleanString(product.defectDescription, 500)
      : product.defectDescription
  };
  const publicChanged = !sameArray(before.tags, after.tags)
    || before.isNew !== after.isNew
    || before.isDefective !== after.isDefective
    || before.isHot !== after.isHot
    || (input.mode === "legacy" && before.isFrequent !== after.isFrequent)
    || (input.mode === "legacy" && before.defectDescription !== after.defectDescription);
  const internalChanged = input.mode === "legacy" && !sameArray(before.internalTags, after.internalTags);
  return {
    before,
    after,
    changed: publicChanged || internalChanged,
    publicChanged,
    internalChanged,
    warning: after.isDefective && !cleanString(after.defectDescription, 500)
  };
}

function deterministicKey(prefix, value) {
  const digest = crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40);
  return `${prefix}:${digest}`;
}

function operationDigest(input) {
  const payload = input.mode === "public"
    ? { mode: input.mode, tag: input.tag, present: input.present }
    : {
      mode: input.mode,
      addTags: input.addTags,
      removeTags: input.removeTags,
      addInternalTags: input.addInternalTags,
      removeInternalTags: input.removeInternalTags,
      setFlags: input.setFlags,
      hasDefectDescription: input.hasDefectDescription,
      defectDescription: input.defectDescription
    };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function missingDocument(error) {
  return /DOCUMENT_NOT_EXIST|document not exist|not found|ResourceNotFound/i
    .test(String(error && error.message || error || ""));
}

function idempotencyFailure(result) {
  const code = cleanString(result && result.code, 80) || "IDEMPOTENCY_FAILED";
  const statusCode = ["IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400;
  return new ProductTagError(code, cleanString(result && result.message, 240) || "幂等校验失败", statusCode);
}

function safeFailureCode(error) {
  const code = cleanString(error && error.code, 80);
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : "PRODUCT_TAG_UPDATE_FAILED";
}

function isStableItemFailure(error) {
  return [
    "PRODUCT_NOT_FOUND",
    "DATA_VERSION_CONFLICT",
    "DATA_VERSION_INVALID",
    "DATA_INTERNAL_TAGS_INVALID"
  ].includes(cleanString(error && error.code, 80));
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

function resultFromExistingLog(productId, product, log, input) {
  if (log.operationDigest !== operationDigest(input)) {
    throw new ProductTagError("IDEMPOTENCY_KEY_CONFLICT", "操作凭证已用于其他标签修改", 409);
  }
  const versionAfter = log.versionAfter;
  if (typeof versionAfter !== "number" || !Number.isSafeInteger(versionAfter) || versionAfter < 0) {
    throw new ProductTagError("DATA_VERSION_INVALID", "商品数据版本异常，暂不能修改", 409);
  }
  return {
    productId,
    version: versionAfter,
    updatedAt: log.createdAt || product.updatedAt || null,
    changed: false,
    reused: true,
    warning: log.warningMissingDefectDescription === true
  };
}

function summarizeMany(items, outcomes) {
  let changedCount = 0;
  let unchangedCount = 0;
  let warningCount = 0;
  const failures = [];
  outcomes.forEach((outcome, index) => {
    if (!outcome || outcome.ok !== true) {
      failures.push({ id: items[index].id, code: outcome && outcome.code || "PRODUCT_TAG_UPDATE_FAILED" });
      return;
    }
    if (outcome.result && outcome.result.warning === true) warningCount += 1;
    if (outcome.result && (outcome.result.changed === true || outcome.result.reused === true)) changedCount += 1;
    else unchangedCount += 1;
  });
  return { changedCount, unchangedCount, failedCount: failures.length, warningCount, failures };
}

function legacyIdempotencyPayload(input) {
  const internalPayload = JSON.stringify({
    addInternalTags: input.addInternalTags,
    removeInternalTags: input.removeInternalTags
  });
  return {
    productIds: input.items.map((item) => item.id),
    addTags: input.addTags,
    removeTags: input.removeTags,
    internalTagsDigest: crypto.createHash("sha256").update(internalPayload).digest("hex"),
    internalTagOperationCount: input.addInternalTags.length + input.removeInternalTags.length,
    setFlags: input.setFlags,
    hasDefectDescription: input.hasDefectDescription,
    defectDescription: input.defectDescription,
    reason: input.reason
  };
}

function createProductTagService({ db, idempotency, now = () => new Date() } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("product tag service requires db.runTransaction");
  if (!idempotency
    || typeof idempotency.runIdempotentAction !== "function"
    || typeof idempotency.assertIdempotencyKey !== "function"
    || typeof idempotency.ensureCollection !== "function") {
    throw new Error("product tag service requires idempotency helpers");
  }

  async function ensureCollections() {
    await idempotency.ensureCollection(db, "product_tag_logs");
    await idempotency.ensureCollection(db, "admin_operation_logs");
    await idempotency.ensureCollection(db, "sync_events");
  }

  async function getProduct(database, productId) {
    try {
      return (await database.collection("products").doc(productId).get()).data;
    } catch (error) {
      if (!missingDocument(error)) throw error;
      return null;
    }
  }

  async function executeItem({ actor, input, item, idempotencyKey, operationId }) {
    const businessKey = deterministicKey("product_tag", `${actor.id}:${operationId}:${item.id}`);
    return db.runTransaction(async (tx) => {
      const product = await getProduct(tx, item.id);
      if (!product || product.isDeleted === true) {
        throw new ProductTagError("PRODUCT_NOT_FOUND", "商品不存在", 404);
      }

      const existingLog = await tx.collection("product_tag_logs").where({ businessKey }).limit(1).get();
      if (existingLog.data && existingLog.data[0]) {
        return resultFromExistingLog(item.id, product, existingLog.data[0], input);
      }

      const currentVersion = versionOf(product);
      const currentPresent = input.mode === "public" ? publicTagPresent(product, input.tag) : undefined;
      const versionConflict = item.expectedVersion !== undefined && item.expectedVersion !== currentVersion;
      const presentConflict = item.expectedPresent !== undefined && item.expectedPresent !== currentPresent;
      if (versionConflict || presentConflict) {
        throw new ProductTagError("DATA_VERSION_CONFLICT", "记录已变化，请刷新后重新确认", 409, {
          conflictFields: [
            ...(versionConflict ? ["version"] : []),
            ...(presentConflict ? ["present"] : [])
          ]
        });
      }

      const operation = applyOperation(product, input);
      if (!operation.changed) {
        return {
          productId: item.id,
          version: currentVersion,
          updatedAt: product.updatedAt || null,
          changed: false,
          reused: false,
          warning: operation.warning
        };
      }

      const timestamp = db.serverDate();
      const nextVersion = currentVersion + 1;
      const updateData = {
        ...(input.mode === "public" ? {
          tags: operation.after.tags,
          isNew: operation.after.isNew,
          isDefective: operation.after.isDefective,
          isHot: operation.after.isHot
        } : operation.after),
        tagUpdatedAt: timestamp,
        tagUpdatedBy: actor.openid || actor.id,
        updatedAt: timestamp,
        version: nextVersion
      };
      updateData.searchText = buildProductSearchText({ ...product, ...updateData });
      const publicSummary = input.mode === "public" ? "商品公开标签已更新" : "商品标签已更新";

      await tx.collection("products").doc(item.id).update({ data: updateData });
      await tx.collection("product_tag_logs").add({
        data: {
          businessKey,
          sourceType: input.mode === "public" ? "admin_web_public_tag" : "batch_tag",
          sourceId: operationId,
          idempotencyKey,
          operationDigest: operationDigest(input),
          productId: item.id,
          productIndex: product.productIndex || "",
          productName: product.name || "",
          beforeTags: operation.before.tags,
          afterTags: operation.after.tags,
          beforeInternalTags: operation.before.internalTags,
          afterInternalTags: operation.after.internalTags,
          beforeFlags: {
            isNew: operation.before.isNew,
            isDefective: operation.before.isDefective,
            isHot: operation.before.isHot,
            isFrequent: operation.before.isFrequent
          },
          afterFlags: {
            isNew: operation.after.isNew,
            isDefective: operation.after.isDefective,
            isHot: operation.after.isHot,
            isFrequent: operation.after.isFrequent
          },
          beforeDefectDescription: operation.before.defectDescription,
          afterDefectDescription: operation.after.defectDescription,
          versionBefore: currentVersion,
          versionAfter: nextVersion,
          warningMissingDefectDescription: operation.warning,
          operatorId: actor.id,
          operatorOpenid: actor.openid,
          operatorRole: actor.role,
          sourceClient: actor.sourceClient,
          reason: input.reason,
          createdAt: timestamp
        }
      });
      await tx.collection("admin_operation_logs").add({
        data: {
          businessKey,
          sourceId: operationId,
          idempotencyKey,
          action: "set_product_tags",
          resourceType: "product",
          resourceId: item.id,
          productId: item.id,
          productIndex: product.productIndex || "",
          productName: product.name || "",
          beforeData: { version: currentVersion },
          afterData: { version: nextVersion },
          operatorId: actor.id,
          operatorOpenid: actor.openid,
          operatorRole: actor.role,
          sourceClient: actor.sourceClient,
          reason: input.reason,
          description: publicSummary,
          publicSummary,
          status: "success",
          createdAt: timestamp
        }
      });
      await tx.collection("sync_events").add({
        data: {
          eventId: deterministicKey("product_tag_event", businessKey),
          eventType: "product.tags_updated",
          entityType: "product",
          entityId: item.id,
          action: input.mode === "public" ? "set_public_tag" : "update_tags",
          version: nextVersion,
          changedFields: ["updatedAt", "version"],
          actorType: "admin",
          actorRole: actor.role,
          sourceClient: actor.sourceClient,
          businessKey,
          audience: operation.publicChanged ? "public" : "admin",
          isPublic: operation.publicChanged,
          audienceRoles: ["procurement", "super_admin"],
          createdAt: timestamp,
          expiresAt: new Date(now().getTime() + SYNC_EVENT_TTL_MS)
        }
      });

      return {
        productId: item.id,
        version: nextVersion,
        updatedAt: timestamp,
        changed: true,
        reused: false,
        warning: operation.warning
      };
    });
  }

  async function executeMany({ actor, input, idempotencyKey, operationId }) {
    let fatalError = null;
    const outcomes = await mapWithConcurrency(input.items, BATCH_CONCURRENCY, async (item) => {
      if (fatalError) return { ok: false, skipped: true };
      try {
        const result = await executeItem({ actor, input, item, idempotencyKey, operationId });
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

  async function recoverManyCompletedResult({ actor, input, operationId }) {
    const outcomes = await mapWithConcurrency(input.items, BATCH_CONCURRENCY, async (item) => {
      const businessKey = deterministicKey("product_tag", `${actor.id}:${operationId}:${item.id}`);
      const product = await getProduct(db, item.id);
      if (!product || product.isDeleted === true) return { ok: false, code: "PRODUCT_NOT_FOUND" };
      const existingLog = await db.collection("product_tag_logs").where({ businessKey }).limit(1).get();
      if (existingLog.data && existingLog.data[0]) {
        return { ok: true, result: resultFromExistingLog(item.id, product, existingLog.data[0], input) };
      }

      let operation;
      let currentVersion;
      try {
        currentVersion = versionOf(product);
        if (input.mode === "public") {
          const currentPresent = publicTagPresent(product, input.tag);
          if (currentVersion !== item.expectedVersion || currentPresent !== item.expectedPresent) {
            return { ok: false, code: "DATA_VERSION_CONFLICT" };
          }
        }
        operation = applyOperation(product, input);
      } catch (error) {
        if (isStableItemFailure(error)) return { ok: false, code: safeFailureCode(error) };
        throw error;
      }
      if (operation.changed) return null;
      return {
        ok: true,
        result: {
          productId: item.id,
          version: currentVersion,
          updatedAt: product.updatedAt || null,
          changed: false,
          reused: false,
          warning: operation.warning
        }
      };
    });
    if (outcomes.some((outcome) => !outcome
      || (outcome.ok !== true && !(outcome.ok === false && typeof outcome.code === "string")))) {
      return null;
    }
    return summarizeMany(input.items, outcomes);
  }

  async function runMany({ actor: rawActor, input, idempotencyKey: rawKey, actionType, scopeId, payload }) {
    const actor = normalizeActor(rawActor);
    let idempotencyKey;
    try {
      idempotencyKey = idempotency.assertIdempotencyKey(cleanString(rawKey, 200));
    } catch (error) {
      throw new ProductTagError(error.code || "IDEMPOTENCY_KEY_INVALID", error.message || "操作凭证无效", 400);
    }
    await ensureCollections();
    const outcome = await idempotency.runIdempotentAction({
      db,
      actionType,
      idempotencyKey,
      operatorIdentity: actor.id,
      operatorType: "admin",
      scope: "products",
      scopeId,
      openid: actor.openid,
      adminId: actor.id,
      ttlSeconds: 7 * 24 * 60 * 60,
      payload,
      recoverProcessingResult: () => recoverManyCompletedResult({ actor, input, operationId: idempotencyKey })
    }, () => executeMany({ actor, input, idempotencyKey, operationId: idempotencyKey }));
    if (!outcome || outcome.ok !== true) throw idempotencyFailure(outcome);
    return outcome.data;
  }

  async function setManyPublicTags(command = {}) {
    const input = normalizeManyPublicInput(command.input);
    return runMany({
      actor: command.actor,
      input,
      idempotencyKey: command.idempotencyKey,
      actionType: ACTION_TYPE,
      scopeId: `public:${input.tag}`,
      payload: {
        scope: input.scope,
        tag: input.tag,
        present: input.present,
        items: input.items,
        reason: input.reason
      }
    });
  }

  async function setManyLegacyTags(command = {}) {
    const input = normalizeManyLegacyInput(command.input);
    const batchOperationId = cleanString(command.batchOperationId || command.idempotencyKey, 160);
    return runMany({
      actor: command.actor,
      input,
      idempotencyKey: command.idempotencyKey,
      actionType: LEGACY_ACTION_TYPE,
      scopeId: batchOperationId,
      payload: { batchOperationId, ...legacyIdempotencyPayload(input) }
    });
  }

  return { setManyPublicTags, setManyLegacyTags };
}

module.exports = {
  ACTION_TYPE,
  LEGACY_ACTION_TYPE,
  BATCH_MAX_ITEMS,
  LEGACY_BATCH_MAX_ITEMS,
  BATCH_CONCURRENCY,
  REQUIRED_PERMISSION,
  SYNC_EVENT_TTL_MS,
  PUBLIC_TAGS,
  TAG_FLAG,
  ProductTagError,
  createProductTagService,
  normalizeActor,
  normalizeManyPublicInput,
  normalizeManyLegacyInput,
  versionOf,
  publicTagsOf,
  publicTagPresent,
  applyOperation,
  buildProductSearchText
};
