const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const DEFAULT_PROCESSING_TIMEOUT_SECONDS = 30 * 60;
const DEFAULT_LIMIT = 100;
const ALLOWED_ACTION_TYPES = ["approve_order", "reject_order", "submit_cart_order", "submit_order", "submit_payment_proof"];
const REVIEW_ACTION_PERMISSION = {
  approve_order: "order:review",
  reject_order: "order:reject",
  submit_payment_proof: "payment:confirm"
};
const ROLE_FALLBACK_PERMISSIONS = {
  super_admin: ["*"],
  customer_service: ["order:review", "order:reject"],
  finance: ["payment:confirm"],
  procurement: []
};

async function getSettings() {
  const res = await db.collection("settings").doc("system_settings").get().catch(() => null);
  const data = res && res.data ? res.data : {};
  return {
    processingTimeoutSeconds: Math.max(60, Number(data.idempotencyProcessingTimeoutSeconds || DEFAULT_PROCESSING_TIMEOUT_SECONDS)),
    limit: Math.max(1, Math.min(500, Number(data.idempotencyCleanupLimit || DEFAULT_LIMIT)))
  };
}

async function queryProcessingByTime(field, cutoff, limit, extra = {}) {
  const res = await db.collection("idempotency_records")
    .where({ ...extra, status: "processing", [field]: _.lt(cutoff) })
    .limit(limit)
    .get()
    .catch(() => ({ data: [] }));
  return res.data || [];
}

async function markExpired(records, errorCode, errorMessage) {
  let updated = 0;
  const seen = new Set();
  for (const record of records || []) {
    if (!record || !record._id || seen.has(record._id)) continue;
    seen.add(record._id);
    await db.collection("idempotency_records").doc(record._id).update({
      data: {
        status: "expired",
        errorCode,
        errorMessage,
        updatedAt: db.serverDate()
      }
    }).then(() => { updated += 1; }).catch(() => null);
  }
  return updated;
}

async function markTimeoutProcessing(cutoff, limit) {
  const records = [];
  for (const field of ["lockedAt", "updatedAt", "createdAt"]) {
    const remaining = limit - records.length;
    if (remaining <= 0) break;
    records.push(...await queryProcessingByTime(field, cutoff, remaining));
  }
  return markExpired(records, "IDEMPOTENCY_PROCESSING_TIMEOUT", "processing timeout");
}

async function removeExpired(now, limit) {
  const res = await db.collection("idempotency_records")
    .where({ expiresAt: _.lt(now), status: _.neq("processing") })
    .limit(limit)
    .get()
    .catch(() => ({ data: [] }));
  let removed = 0;
  for (const record of res.data || []) {
    await db.collection("idempotency_records").doc(record._id).remove()
      .then(() => { removed += 1; })
      .catch(() => null);
  }
  return removed;
}

function cleanText(value, maxLength = 120) {
  return String(value || "").trim().slice(0, maxLength);
}

function hasPermission(admin = {}, permission) {
  if (!admin || admin.isActive === false || admin.status === "disabled") return false;
  if (admin.role === "super_admin") return true;
  const explicit = Array.isArray(admin.permissions) && admin.permissions.length ? admin.permissions : null;
  const permissions = explicit || ROLE_FALLBACK_PERMISSIONS[admin.role] || [];
  return permissions.includes("*") || permissions.includes(permission);
}

async function requireReviewCleanupPermission(actionType) {
  const permission = REVIEW_ACTION_PERMISSION[actionType];
  if (!permission) return;
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users")
    .where({ openid, isActive: _.neq(false), status: _.neq("disabled") })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  const admin = res.data && res.data[0];
  if (!hasPermission(admin, permission)) {
    const err = new Error("无权限清理审核操作记录");
    err.code = "PERMISSION_DENIED";
    throw err;
  }
}

async function expireActionProcessing(event = {}) {
  const actionType = cleanText(event.actionType);
  if (!ALLOWED_ACTION_TYPES.includes(actionType)) {
    return { ok: false, code: "ACTION_NOT_ALLOWED", message: "actionType not allowed" };
  }
  await requireReviewCleanupPermission(actionType);

  const maxAgeSeconds = Math.max(60, Number(event.maxAgeSeconds || 60));
  const limit = Math.max(1, Math.min(20, Number(event.limit || 10)));
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000);
  const query = {
    actionType,
    status: "processing"
  };
  const scopeId = cleanText(event.scopeId || event.openid || "");
  if (scopeId) query.scopeId = scopeId;

  const records = [];
  for (const field of ["lockedAt", "updatedAt", "createdAt"]) {
    const remaining = limit - records.length;
    if (remaining <= 0) break;
    records.push(...await queryProcessingByTime(field, cutoff, remaining, query));
  }
  const updated = await markExpired(records, "MANUAL_EXPIRE_PROCESSING", `manually expired processing ${actionType} record`);

  return {
    ok: true,
    data: {
      actionType,
      expiredProcessing: updated,
      matched: records.length,
      maxAgeSeconds,
      scoped: Boolean(scopeId)
    }
  };
}

exports.main = async (event = {}) => {
  if (event.action === "expireProcessingByAction") {
    return expireActionProcessing(event);
  }

  const settings = await getSettings();
  const now = new Date();
  const cutoff = new Date(Date.now() - settings.processingTimeoutSeconds * 1000);
  const expiredProcessing = await markTimeoutProcessing(cutoff, settings.limit);
  const removed = await removeExpired(now, settings.limit);
  return {
    ok: true,
    data: {
      expiredProcessing,
      removed,
      processingTimeoutSeconds: settings.processingTimeoutSeconds
    }
  };
};
