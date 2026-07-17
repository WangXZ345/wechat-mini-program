"use strict";

const crypto = require("crypto");

const REVIEW_STATUS = "pending_review";
const REFUND_TYPES = new Set(["refund_only", "return_refund", "price_adjustment_refund"]);

class AfterSaleReviewError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "AfterSaleReviewError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, max = 300) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function hasPermission(actor, permission) {
  if (!actor || actor.status !== "active" || actor.isActive === false) return false;
  return actor.role === "super_admin"
    || (Array.isArray(actor.permissions) && (actor.permissions.includes("*") || actor.permissions.includes(permission)));
}

function normalizeReviewActor(actor = {}, decision) {
  const id = cleanString(actor.id || actor._id || actor.openid, 128);
  const role = cleanString(actor.role, 50);
  if (!id || !role || actor.status !== "active" || actor.isActive === false) {
    throw new AfterSaleReviewError("INVALID_ACTOR", "管理员身份无效", 403);
  }
  if (["finance", "procurement"].includes(role)) {
    throw new AfterSaleReviewError("FORBIDDEN", "当前角色不能审核售后", 403);
  }
  if (!hasPermission(actor, "after_sale:review")) {
    throw new AfterSaleReviewError("FORBIDDEN", "无权执行售后审核操作", 403);
  }
  return {
    id,
    openid: cleanString(actor.openid, 128),
    role,
    permissions: Array.isArray(actor.permissions) ? actor.permissions.slice() : [],
    status: "active",
    isActive: true,
    sourceClient: actor.sourceClient === "miniprogram" ? "miniprogram" : "admin_web",
    decision
  };
}

function normalizeExpectedVersion(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new AfterSaleReviewError("EXPECTED_VERSION_REQUIRED", "缺少售后单版本，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AfterSaleReviewError("EXPECTED_VERSION_INVALID", "售后单版本无效，请刷新后重试", 400);
  }
  return value;
}

function normalizeExpectedUpdatedAt(value, required) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new AfterSaleReviewError("EXPECTED_UPDATED_AT_REQUIRED", "缺少售后单更新时间，请刷新后重试", 400);
    return undefined;
  }
  if (typeof value !== "string") throw new AfterSaleReviewError("EXPECTED_UPDATED_AT_INVALID", "售后单更新时间无效", 400);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AfterSaleReviewError("EXPECTED_UPDATED_AT_INVALID", "售后单更新时间无效", 400);
  }
  return value;
}

function normalizeReviewInput(input = {}, options = {}) {
  const strict = options.strict === true;
  const allowed = new Set([
    "id", "afterSaleId", "decision", "action", "expectedStatus", "expectedVersion",
    "expectedUpdatedAt", "approvedRefundAmount", "returnRequired", "reason"
  ]);
  if (strict) {
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown) throw new AfterSaleReviewError("UNKNOWN_FIELD", "售后审核请求包含未知字段", 400, { field: unknown });
  }
  const id = cleanString(input.id || input.afterSaleId, 128);
  if (!id) throw new AfterSaleReviewError("AFTER_SALE_ID_REQUIRED", "缺少售后单 ID", 400);
  const decision = cleanString(
    input.decision || (input.action === "approve" ? "approve" : input.action === "reject" ? "reject" : ""),
    20
  );
  if (!["approve", "reject"].includes(decision)) {
    throw new AfterSaleReviewError("DECISION_INVALID", "售后审核操作无效", 400);
  }
  const expectedStatus = cleanString(input.expectedStatus, 60);
  if (strict && expectedStatus !== REVIEW_STATUS) {
    throw new AfterSaleReviewError(
      expectedStatus ? "EXPECTED_STATUS_INVALID" : "EXPECTED_STATUS_REQUIRED",
      expectedStatus ? "售后单当前状态无效" : "缺少售后单当前状态，请刷新后重试",
      400
    );
  }
  if (!strict && expectedStatus && expectedStatus !== REVIEW_STATUS) {
    throw new AfterSaleReviewError("EXPECTED_STATUS_INVALID", "售后单当前状态无效", 400);
  }
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion, strict);
  const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expectedUpdatedAt, strict);
  let approvedRefundAmount;
  if (input.approvedRefundAmount !== undefined && input.approvedRefundAmount !== null && input.approvedRefundAmount !== "") {
    if (typeof input.approvedRefundAmount !== "number"
      || !Number.isSafeInteger(input.approvedRefundAmount)
      || input.approvedRefundAmount < 0) {
      throw new AfterSaleReviewError("REFUND_AMOUNT_INVALID", "审批退款金额无效", 400);
    }
    approvedRefundAmount = input.approvedRefundAmount;
  }
  if (decision === "reject" && approvedRefundAmount !== undefined) {
    throw new AfterSaleReviewError("REJECT_FIELDS_INVALID", "驳回售后不能提交审批退款金额", 400);
  }
  let returnRequired;
  if (input.returnRequired !== undefined) {
    if (typeof input.returnRequired !== "boolean") {
      throw new AfterSaleReviewError("RETURN_REQUIRED_INVALID", "退货要求格式无效", 400);
    }
    returnRequired = input.returnRequired;
  }
  if (decision === "reject" && returnRequired !== undefined) {
    throw new AfterSaleReviewError("REJECT_FIELDS_INVALID", "驳回售后不能提交退货要求", 400);
  }
  const reason = input.reason === undefined || input.reason === null ? "" : cleanString(input.reason, 300);
  if (input.reason !== undefined && typeof input.reason !== "string") {
    throw new AfterSaleReviewError("REASON_INVALID", "审核说明格式无效", 400);
  }
  if (strict && decision === "reject" && !reason) {
    throw new AfterSaleReviewError("REASON_REQUIRED", "请填写驳回原因", 400);
  }
  return {
    id,
    decision,
    expectedStatus: expectedStatus || undefined,
    expectedVersion,
    expectedUpdatedAt,
    approvedRefundAmount,
    returnRequired,
    reason
  };
}

function versionOf(row = {}) {
  const value = row.version === undefined || row.version === null || row.version === "" ? 0 : row.version;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AfterSaleReviewError("DATA_VERSION_INVALID", "售后单版本数据异常，暂不能审核", 409);
  }
  return value;
}

function cents(value, field = "退款金额") {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AfterSaleReviewError("REFUND_AMOUNT_INVALID", `${field}数据异常`, 409);
  }
  return value;
}

function sameInstant(left, right) {
  const leftDate = left instanceof Date ? left : new Date(left);
  const rightDate = right instanceof Date ? right : new Date(right);
  return Number.isFinite(leftDate.getTime()) && Number.isFinite(rightDate.getTime())
    && leftDate.getTime() === rightDate.getTime();
}

function deterministicId(value) {
  return `after_sale_review:${crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40)}`;
}

function afterSaleLogSnapshot(row = {}) {
  return {
    afterSaleNo: cleanString(row.afterSaleNo || row.caseNo, 100),
    orderId: cleanString(row.orderId, 128),
    orderNo: cleanString(row.orderNo, 100),
    afterSaleType: cleanString(row.afterSaleType || row.type, 60),
    afterSaleReason: cleanString(row.afterSaleReason, 60),
    afterSaleStatus: cleanString(row.afterSaleStatus || row.status, 60),
    refundStatus: cleanString(row.refundStatus, 40),
    requestedRefundAmount: typeof row.requestedRefundAmount === "number" ? row.requestedRefundAmount : 0,
    approvedRefundAmount: typeof row.approvedRefundAmount === "number" ? row.approvedRefundAmount : 0,
    actualRefundAmount: typeof row.actualRefundAmount === "number" ? row.actualRefundAmount : 0,
    returnRequired: row.returnRequired === true,
    reviewedByRole: cleanString(row.reviewedByRole, 50)
  };
}

async function defaultGetAfterSaleById(store, id) {
  const response = await store.collection("after_sales").doc(id).get();
  const row = response && response.data;
  if (!row) throw new AfterSaleReviewError("AFTER_SALE_NOT_FOUND", "售后单不存在", 404);
  return row;
}

async function defaultWriteAfterSaleLog(store, { afterSale, action, beforeData, afterData, operator, remark }) {
  await store.collection("after_sale_logs").add({
    data: {
      afterSaleId: cleanString(afterSale._id || afterSale.afterSaleId, 128),
      afterSaleNo: cleanString(afterSale.afterSaleNo || afterSale.caseNo, 100),
      orderId: cleanString(afterSale.orderId, 128),
      orderNo: cleanString(afterSale.orderNo, 100),
      action: cleanString(action, 80),
      beforeData: afterSaleLogSnapshot(beforeData),
      afterData: afterSaleLogSnapshot(afterData),
      operatorType: "admin",
      operatorId: cleanString(operator && (operator.id || operator._id), 128),
      operatorRole: cleanString(operator && operator.role, 50),
      remark: cleanString(remark, 300),
      createdAt: afterData && afterData.updatedAt || new Date()
    }
  });
}

async function defaultWriteAdminOperation(store, { admin, action, resourceType, resourceId, beforeData, afterData, description }) {
  await store.collection("admin_operation_logs").add({
    data: {
      operatorId: cleanString(admin && (admin.id || admin._id), 128),
      operatorRole: cleanString(admin && admin.role, 50),
      action: cleanString(action, 100),
      resourceType: cleanString(resourceType, 80),
      resourceId: cleanString(resourceId, 128),
      beforeData: beforeData || null,
      afterData: afterData || null,
      description: cleanString(description, 300),
      createdAt: afterData && afterData.updatedAt || new Date()
    }
  });
}

function createAfterSaleReviewService({
  db,
  idempotency,
  now = () => new Date(),
  refundTypes = REFUND_TYPES,
  getAfterSaleById = defaultGetAfterSaleById,
  writeAfterSaleLog = defaultWriteAfterSaleLog,
  writeAdminOperation = defaultWriteAdminOperation,
  afterSaleLogSnapshot: snapshot = afterSaleLogSnapshot,
  ownerKeyFor,
  syncOwnerPepper = ""
} = {}) {
  function assertDependencies() {
    if (!db || typeof db.runTransaction !== "function") throw new Error("after-sale review service requires db");
    if (!idempotency || typeof idempotency.runIdempotentAction !== "function") {
      throw new Error("after-sale review service requires idempotency helpers");
    }
    if (typeof getAfterSaleById !== "function" || typeof writeAfterSaleLog !== "function" || typeof writeAdminOperation !== "function") {
      throw new Error("after-sale review service requires log adapters");
    }
  }

  async function ensureCollections() {
    if (typeof idempotency.ensureCollection !== "function") return;
    for (const name of ["after_sales", "orders", "admin_operation_logs", "after_sale_logs", "sync_events"]) {
      await idempotency.ensureCollection(db, name);
    }
  }

  function buildResult(afterSale, decision, options = {}) {
    const item = {
      id: cleanString(afterSale._id || afterSale.id, 128),
      caseNo: cleanString(afterSale.afterSaleNo || afterSale.caseNo, 100),
      status: cleanString(afterSale.afterSaleStatus || afterSale.status, 60),
      version: versionOf(afterSale),
      updatedAt: afterSale.updatedAt || null
    };
    return {
      item,
      afterSaleId: item.id,
      afterSaleStatus: item.status,
      refundStatus: cleanString(afterSale.refundStatus, 40) || "none",
      approvedRefundAmount: cents(Number(afterSale.approvedRefundAmount || 0)),
      affected: options.affected === 1 ? 1 : 0,
      reused: options.reused === true,
      decision,
      requestId: cleanString(options.requestId, 160)
    };
  }

  function ownerKey(afterSale) {
    if (typeof ownerKeyFor !== "function") return "";
    const subject = cleanString(afterSale.openid || afterSale.userOpenid || afterSale.userId, 256);
    return cleanString(ownerKeyFor(subject, syncOwnerPepper), 128);
  }

  async function execute({ actor, input, idempotencyKey, operationId }) {
    const businessKey = `after_sale_review:${operationId}:${input.id}:${input.decision}`;
    return db.runTransaction(async (tx) => {
      const afterSale = await getAfterSaleById(tx, input.id);
      const currentVersion = versionOf(afterSale);
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new AfterSaleReviewError("DATA_VERSION_CONFLICT", "售后单已变化，请刷新后重试", 409);
      }
      if (input.expectedUpdatedAt !== undefined && !sameInstant(input.expectedUpdatedAt, afterSale.updatedAt)) {
        throw new AfterSaleReviewError("DATA_VERSION_CONFLICT", "售后单已变化，请刷新后重试", 409);
      }
      if (input.expectedStatus !== undefined && input.expectedStatus !== afterSale.afterSaleStatus) {
        throw new AfterSaleReviewError("DATA_VERSION_CONFLICT", "售后单状态已变化，请刷新后重试", 409);
      }
      const currentStatus = cleanString(afterSale.afterSaleStatus || afterSale.status, 60);
      if (input.decision === "approve"
        && ["approved", "waiting_return", "refund_pending"].includes(currentStatus)) {
        return buildResult(afterSale, "approve", { affected: 0, reused: true, requestId: operationId });
      }
      if (input.decision === "reject" && currentStatus === "rejected") {
        return buildResult(afterSale, "reject", { affected: 0, reused: true, requestId: operationId });
      }
      if (currentStatus !== REVIEW_STATUS) {
        throw new AfterSaleReviewError("AFTER_SALE_STATUS_INVALID", "当前售后状态不能审核", 409);
      }

      const timestamp = now();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
        throw new AfterSaleReviewError("CLOCK_INVALID", "售后审核时间源无效", 503);
      }
      let nextStatus;
      let refundStatus;
      let approvedRefundAmount = 0;
      let returnRequired = false;
      const patch = {
        reviewedBy: actor.id,
        reviewedByRole: actor.role,
        reviewedAt: timestamp,
        updatedAt: timestamp,
        version: currentVersion + 1
      };
      if (input.decision === "reject") {
        if (!input.reason) throw new AfterSaleReviewError("REASON_REQUIRED", "请填写驳回原因", 400);
        nextStatus = "rejected";
        refundStatus = "rejected";
        Object.assign(patch, {
          afterSaleStatus: nextStatus,
          refundStatus,
          rejectReason: input.reason,
          adminReviewRemark: input.reason
        });
      } else {
        approvedRefundAmount = cents(
          input.approvedRefundAmount === undefined
            ? cents(Number(afterSale.requestedRefundAmount || 0), "申请退款金额")
            : input.approvedRefundAmount,
          "审批退款金额"
        );
        const maxRefundableAmount = cents(Number(afterSale.maxRefundableAmount || 0), "可退金额");
        if (approvedRefundAmount > maxRefundableAmount) {
          throw new AfterSaleReviewError("REFUND_AMOUNT_EXCEEDED", "审批退款金额不能超过可退金额", 409);
        }
        returnRequired = input.returnRequired === undefined
          ? afterSale.returnRequired === true
          : input.returnRequired;
        if (returnRequired) nextStatus = "waiting_return";
        else if (approvedRefundAmount > 0 && new Set(refundTypes).has(afterSale.afterSaleType)) nextStatus = "refund_pending";
        else nextStatus = "approved";
        refundStatus = approvedRefundAmount > 0 ? "pending" : "none";
        Object.assign(patch, {
          afterSaleStatus: nextStatus,
          refundStatus,
          approvedRefundAmount,
          returnRequired,
          adminReviewRemark: input.reason,
          rejectReason: ""
        });
      }
      const next = { ...afterSale, ...patch };
      await tx.collection("after_sales").doc(afterSale._id).update({ data: patch });
      await tx.collection("orders").doc(afterSale.orderId).update({
        data: {
          afterSaleStatus: nextStatus,
          refundStatus,
          lastAfterSaleAt: timestamp,
          updatedAt: timestamp
        }
      });
      await writeAfterSaleLog(tx, {
        afterSale,
        action: input.decision === "reject" ? "review_reject" : "review_approve",
        beforeData: afterSale,
        afterData: next,
        operatorType: "admin",
        operator: actor,
        remark: input.reason
      });
      await writeAdminOperation(tx, {
        admin: actor,
        action: input.decision === "reject" ? "after_sale:reject" : "after_sale:review",
        resourceType: "after_sale",
        resourceId: afterSale._id,
        beforeData: snapshot(afterSale),
        afterData: snapshot(next),
        description: input.decision === "reject" ? "拒绝售后申请" : "审核通过售后申请"
      });
      if (typeof ownerKeyFor === "function") {
        const owner = ownerKey(afterSale);
        if (!owner) throw new AfterSaleReviewError("SYNC_OWNER_CONFIG_REQUIRED", "售后同步安全配置不完整", 503);
        await tx.collection("sync_events").add({
          data: {
            eventId: deterministicId(businessKey),
            eventType: "after_sale.status_changed",
            entityType: "after_sale",
            entityId: afterSale._id,
            action: input.decision,
            version: next.version,
            changedFields: ["afterSaleStatus", "refundStatus", "version", "updatedAt"],
            actorType: "admin",
            actorRole: actor.role,
            sourceClient: actor.sourceClient,
            businessKey,
            audience: "owner",
            ownerKey: owner,
            createdAt: timestamp,
            expiresAt: new Date(timestamp.getTime() + 7 * 24 * 60 * 60 * 1000)
          }
        });
      }
      return buildResult(next, input.decision, { affected: 1, reused: false, requestId: operationId });
    });
  }

  async function reviewAfterSale(commandInput = {}) {
    assertDependencies();
    const input = normalizeReviewInput(commandInput.input, { strict: commandInput.strict !== false });
    const actor = normalizeReviewActor(commandInput.actor, input.decision);
    await ensureCollections();
    const key = cleanString(commandInput.idempotencyKey, 180);
    if (!key) throw new AfterSaleReviewError("IDEMPOTENCY_KEY_REQUIRED", "缺少操作凭证，请刷新后重试", 400);
    const normalizedKey = typeof idempotency.assertIdempotencyKey === "function"
      ? idempotency.assertIdempotencyKey(key)
      : key;
    const outcome = await idempotency.runIdempotentAction({
      db,
      actionType: `after_sale_${input.decision}`,
      idempotencyKey: normalizedKey,
      operatorIdentity: actor.id,
      operatorType: "admin",
      scope: "after_sale",
      scopeId: input.id,
      openid: actor.openid,
      adminId: actor.id,
      payload: input
    }, (begin) => execute({
      actor,
      input,
      idempotencyKey: normalizedKey,
      operationId: normalizedKey || begin && begin.recordId
    }));
    if (!outcome || outcome.ok !== true) {
      const code = cleanString(outcome && outcome.code, 80) || "IDEMPOTENCY_FAILED";
      throw new AfterSaleReviewError(code, cleanString(outcome && outcome.message, 240) || "售后审核未完成", code === "IDEMPOTENCY_PROCESSING" || code === "IDEMPOTENCY_KEY_CONFLICT" ? 409 : 400);
    }
    return outcome.data;
  }

  return { reviewAfterSale };
}

module.exports = {
  REVIEW_STATUS,
  REFUND_TYPES,
  AfterSaleReviewError,
  normalizeReviewActor,
  normalizeReviewInput,
  createAfterSaleReviewService
};
