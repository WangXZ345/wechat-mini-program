"use strict";

const crypto = require("node:crypto");

const PROCESSABLE_STATUSES = new Set(["pending", "processing", "failed"]);
const MAX_REFUND_HISTORY = 100;
const MAX_PROOF_COUNT = 6;
const BUSINESS_KEY_MIGRATION_NOTE = "Legacy rows without the indexed business key are excluded by the partial filter; backfill keys and resolve duplicates before replacing this with a full unique index.";

function requiredUniqueIndex(collection, indexName, field, migrationNote = BUSINESS_KEY_MIGRATION_NOTE) {
  return Object.freeze({
    collection,
    indexName,
    unique: true,
    fields: Object.freeze([field]),
    sparse: false,
    partialFilterExpression: Object.freeze({
      [field]: Object.freeze({ $exists: true, $type: "string" })
    }),
    migrationNote
  });
}

const REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES = Object.freeze([
  requiredUniqueIndex("admin_operation_logs", "uniq_refund_admin_operation_business_key", "businessKey"),
  requiredUniqueIndex("account_logs", "uniq_refund_account_log_business_key", "businessKey"),
  requiredUniqueIndex("refund_logs", "uniq_refund_log_business_key", "businessKey"),
  requiredUniqueIndex("after_sale_logs", "uniq_refund_after_sale_log_business_key", "businessKey"),
  requiredUniqueIndex(
    "sync_events",
    "uniq_refund_sync_event_id",
    "eventId",
    "Legacy rows without eventId are excluded by the partial filter; backfill eventId values and resolve duplicates before replacing this with a full unique index."
  )
]);
const REFUND_COLLECTIONS = [
  "refund_records",
  "after_sales",
  "orders",
  "order_items",
  "customer_accounts",
  "account_logs",
  "refund_logs",
  "after_sale_logs",
  "admin_operation_logs",
  "sync_events"
];

class RefundMutationError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "RefundMutationError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanText(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function strictText(value, field, max, options = {}) {
  if (value === undefined || value === null) {
    if (options.required) throw new RefundMutationError(`${field.toUpperCase()}_REQUIRED`, `${field} is required`);
    return "";
  }
  if (typeof value !== "string") {
    throw new RefundMutationError(`${field.toUpperCase()}_INVALID`, `${field} must be a string`);
  }
  const normalized = value.trim();
  if ((options.required && !normalized) || normalized.length > max) {
    throw new RefundMutationError(`${field.toUpperCase()}_INVALID`, `${field} is invalid`);
  }
  return normalized;
}

function versionOf(row = {}, entity = "记录") {
  const value = row.version === undefined || row.version === null || row.version === "" ? 0 : row.version;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RefundMutationError("DATA_VERSION_INVALID", `${entity}版本异常`, 409);
  }
  return value;
}

function storedCents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RefundMutationError("DATA_REFUND_AMOUNT_INVALID", `${field}金额异常`, 409);
  }
  return value;
}

function sameInstant(left, right) {
  const leftDate = left instanceof Date ? left : new Date(left);
  const rightDate = right instanceof Date ? right : new Date(right);
  return Number.isFinite(leftDate.getTime())
    && Number.isFinite(rightDate.getTime())
    && leftDate.getTime() === rightDate.getTime();
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RefundMutationError("CLOCK_INVALID", "退款时间源无效", 503);
  }
  return date.toISOString();
}

function deterministicId(prefix, value) {
  const digest = crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40);
  return `${cleanText(prefix, 40)}:${digest}`;
}

function normalizeActor(actor = {}) {
  const role = cleanText(actor.role, 40);
  const active = actor.isActive !== false && !["disabled", "inactive"].includes(cleanText(actor.status, 40));
  const id = cleanText(actor.id || actor._id, 128);
  if (!id || !active) {
    throw new RefundMutationError("INVALID_ACTOR", "管理员状态无效", 403);
  }
  if (!["finance", "super_admin"].includes(role)) {
    throw new RefundMutationError("FORBIDDEN", "仅财务或超级管理员可处理退款", 403);
  }
  return {
    id,
    openid: cleanText(actor.openid, 128),
    role,
    sourceClient: cleanText(actor.sourceClient, 40) || "unknown"
  };
}

function normalizeExpectedStatus(value, strict) {
  if (value === undefined && !strict) return undefined;
  const status = strictText(value, "expectedRefundStatus", 40, { required: true });
  if (!PROCESSABLE_STATUSES.has(status)) {
    throw new RefundMutationError("EXPECTED_REFUND_STATUS_INVALID", "退款状态快照无效");
  }
  return status;
}

function normalizeExpectedVersion(value, strict) {
  if (value === undefined && !strict) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RefundMutationError("EXPECTED_REFUND_VERSION_INVALID", "退款版本快照无效");
  }
  return value;
}

function normalizeExpectedUpdatedAt(value, strict) {
  if (value === undefined && !strict) return undefined;
  if (typeof value !== "string") {
    throw new RefundMutationError("EXPECTED_REFUND_UPDATED_AT_INVALID", "退款更新时间快照无效");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RefundMutationError("EXPECTED_REFUND_UPDATED_AT_INVALID", "退款更新时间快照无效");
  }
  return value;
}

function normalizeRefundAmount(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RefundMutationError("INVALID_REFUND_AMOUNT", "退款金额必须是大于 0 的整数分");
  }
  return value;
}

function normalizeProofs(value, strict) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RefundMutationError("REFUND_PROOF_INVALID", "退款凭证格式无效");
  }
  if (value.length > MAX_PROOF_COUNT) {
    throw new RefundMutationError("REFUND_PROOF_LIMIT_EXCEEDED", `退款凭证最多 ${MAX_PROOF_COUNT} 个`);
  }
  const normalized = value.map((item) => {
    if (typeof item !== "string") throw new RefundMutationError("REFUND_PROOF_INVALID", "退款凭证格式无效");
    const proof = strict ? item.trim() : cleanText(item, 500);
    if (!/^cloud:\/\/\S{1,492}$/.test(proof) || proof.length > 500) {
      throw new RefundMutationError("REFUND_PROOF_INVALID", "退款凭证必须使用安全的 CloudBase fileID");
    }
    return proof;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new RefundMutationError("REFUND_PROOF_INVALID", "退款凭证不能重复");
  }
  return normalized;
}

function unknownStrictField(input, allowed) {
  const field = Object.keys(input).find((key) => !allowed.has(key));
  if (field) throw new RefundMutationError("UNKNOWN_FIELD", "退款请求包含未知字段", 400, { field });
}

function normalizeProcessInput(input = {}, strict = true) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RefundMutationError("REFUND_INPUT_INVALID", "退款请求格式无效");
  }
  if (strict) {
    unknownStrictField(input, new Set([
      "refundRecordId",
      "refundAmountCents",
      "expectedRefundStatus",
      "expectedRefundVersion",
      "expectedRefundUpdatedAt",
      "financeRemark",
      "refundProofFileIds"
    ]));
  }
  const refundRecordId = strict
    ? strictText(input.refundRecordId, "refundRecordId", 128, { required: true })
    : cleanText(input.refundRecordId || input.id, 128);
  if (!refundRecordId) throw new RefundMutationError("REFUND_RECORD_ID_REQUIRED", "缺少退款记录");
  const amountSource = input.refundAmountCents !== undefined ? input.refundAmountCents : input.refundAmount;
  const refundAmountCents = amountSource === undefined && !strict
    ? undefined
    : normalizeRefundAmount(amountSource);
  const financeRemark = !strict && input.financeRemark === undefined && input.remark === undefined
    ? undefined
    : strict
      ? strictText(input.financeRemark, "financeRemark", 300)
      : cleanText(input.financeRemark || input.remark, 300);
  const proofs = input.refundProofFileIds !== undefined ? input.refundProofFileIds : input.refundProofImages;
  return {
    refundRecordId,
    refundAmountCents,
    expectedRefundStatus: normalizeExpectedStatus(input.expectedRefundStatus, strict),
    expectedRefundVersion: normalizeExpectedVersion(input.expectedRefundVersion, strict),
    expectedRefundUpdatedAt: normalizeExpectedUpdatedAt(input.expectedRefundUpdatedAt, strict),
    financeRemark,
    refundProofFileIds: !strict && proofs === undefined ? undefined : normalizeProofs(proofs, strict)
  };
}

function normalizeRejectInput(input = {}, strict = true) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RefundMutationError("REFUND_INPUT_INVALID", "退款请求格式无效");
  }
  if (strict) {
    unknownStrictField(input, new Set([
      "refundRecordId",
      "expectedRefundStatus",
      "expectedRefundVersion",
      "expectedRefundUpdatedAt",
      "rejectReason"
    ]));
  }
  const refundRecordId = strict
    ? strictText(input.refundRecordId, "refundRecordId", 128, { required: true })
    : cleanText(input.refundRecordId || input.id, 128);
  if (!refundRecordId) throw new RefundMutationError("REFUND_RECORD_ID_REQUIRED", "缺少退款记录");
  const rejectReason = strict
    ? strictText(input.rejectReason, "rejectReason", 300, { required: true })
    : cleanText(input.rejectReason || input.failedReason || input.reason, 300);
  if (!rejectReason) throw new RefundMutationError("REJECT_REASON_REQUIRED", "请填写退款拒绝原因");
  return {
    refundRecordId,
    expectedRefundStatus: normalizeExpectedStatus(input.expectedRefundStatus, strict),
    expectedRefundVersion: normalizeExpectedVersion(input.expectedRefundVersion, strict),
    expectedRefundUpdatedAt: normalizeExpectedUpdatedAt(input.expectedRefundUpdatedAt, strict),
    rejectReason
  };
}

function normalizeOfflineRefundAccount(value) {
  const account = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    accountName: cleanText(account.accountName, 80),
    bankName: cleanText(account.bankName, 80),
    bankCardNoMasked: cleanText(account.bankCardNoMasked, 80),
    alipayAccountMasked: cleanText(account.alipayAccountMasked, 80),
    wechatAccountMasked: cleanText(account.wechatAccountMasked, 80)
  };
}

function normalizeCreateInput(input = {}, strict = true) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RefundMutationError("REFUND_INPUT_INVALID", "退款请求格式无效");
  }
  if (strict) {
    unknownStrictField(input, new Set([
      "afterSaleId",
      "refundAmountCents",
      "refundMethod",
      "refundChannel",
      "financeRemark"
    ]));
  }
  const afterSaleId = strict
    ? strictText(input.afterSaleId, "afterSaleId", 128, { required: true })
    : cleanText(input.afterSaleId, 128);
  if (!afterSaleId) throw new RefundMutationError("AFTER_SALE_ID_REQUIRED", "缺少售后记录");
  const amountSource = input.refundAmountCents !== undefined ? input.refundAmountCents : input.refundAmount;
  return {
    afterSaleId,
    refundAmountCents: amountSource === undefined && !strict
      ? undefined
      : normalizeRefundAmount(amountSource),
    refundMethod: strict
      ? strictText(input.refundMethod, "refundMethod", 80, { required: true })
      : cleanText(input.refundMethod, 80),
    refundChannel: strict
      ? strictText(input.refundChannel, "refundChannel", 40, { required: true })
      : cleanText(input.refundChannel, 40) || "offline",
    financeRemark: strict
      ? strictText(input.financeRemark, "financeRemark", 300)
      : cleanText(input.financeRemark || input.remark, 300),
    offlineRefundAccount: strict
      ? normalizeOfflineRefundAccount()
      : normalizeOfflineRefundAccount(input.offlineRefundAccount)
  };
}

function publicResult(refund, action, options = {}) {
  return {
    item: {
      id: cleanText(refund._id || refund.id, 128),
      refundNo: cleanText(refund.refundNo, 100),
      status: cleanText(refund.refundStatus || refund.status, 40),
      version: versionOf(refund, "退款记录"),
      updatedAt: isoTimestamp(refund.updatedAt),
      amountCents: storedCents(
        refund.refundAmount !== undefined ? refund.refundAmount : refund.amountCents,
        "退款"
      )
    },
    affected: options.affected === undefined ? 1 : options.affected,
    reused: options.reused === true,
    action,
    accountRecalculationPending: options.accountRecalculationPending === true
  };
}

function createRefundMutationService({
  db,
  idempotency,
  ownerKeyFor,
  syncOwnerPepper = "",
  recalculateAccount,
  now = () => new Date(),
  randomId = () => crypto.randomUUID()
} = {}) {
  function assertDependencies() {
    if (!db || typeof db.runTransaction !== "function") {
      throw new Error("refund mutation service requires db");
    }
    if (!idempotency
      || typeof idempotency.assertIdempotencyKey !== "function"
      || typeof idempotency.runIdempotentAction !== "function") {
      throw new Error("refund mutation service requires idempotency helpers");
    }
  }

  async function ensureCollections() {
    if (typeof idempotency.ensureCollection !== "function") return;
    for (const name of REFUND_COLLECTIONS) {
      await idempotency.ensureCollection(db, name);
    }
  }

  function businessTimestamp() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new RefundMutationError("CLOCK_INVALID", "退款时间源无效", 503);
    }
    return value;
  }

  function ownerKey(order) {
    if (typeof ownerKeyFor !== "function") {
      throw new RefundMutationError("SYNC_OWNER_CONFIG_REQUIRED", "退款同步安全配置不完整", 503);
    }
    const subject = cleanText(order.userOpenid || order.openid || order.userId, 256);
    const key = cleanText(ownerKeyFor(subject, syncOwnerPepper), 128);
    if (!key) throw new RefundMutationError("SYNC_OWNER_CONFIG_REQUIRED", "退款同步安全配置不完整", 503);
    return key;
  }

  async function boundedRows(source, collectionName, where) {
    const response = await source.collection(collectionName).where(where).limit(MAX_REFUND_HISTORY + 1).get();
    const rows = Array.isArray(response.data) ? response.data : [];
    if (rows.length > MAX_REFUND_HISTORY) {
      throw new RefundMutationError("REFUND_HISTORY_LIMIT_EXCEEDED", "退款历史超过安全处理上限", 409);
    }
    return rows;
  }

  function confirmedAmount(rows) {
    return rows
      .filter((row) => cleanText(row.refundStatus || row.status, 40) === "refunded")
      .reduce((sum, row) => sum + storedCents(
        row.refundAmount !== undefined ? row.refundAmount : row.amountCents,
        "历史退款"
      ), 0);
  }

  function reservedAmount(rows) {
    return rows
      .filter((row) => ["pending", "processing", "failed", "refunded"].includes(
        cleanText(row.refundStatus || row.status, 40)
      ))
      .reduce((sum, row) => sum + storedCents(
        row.refundAmount !== undefined ? row.refundAmount : row.amountCents,
        "退款预约"
      ), 0);
  }

  async function validateConfirmedHistory(source, afterSale, order) {
    const afterSaleRows = await boundedRows(source, "refund_records", { afterSaleId: afterSale._id });
    const orderRows = await boundedRows(source, "refund_records", { orderId: order._id });
    const afterSaleConfirmed = confirmedAmount(afterSaleRows);
    const orderConfirmed = confirmedAmount(orderRows);
    const actual = storedCents(afterSale.actualRefundAmount || 0, "售后实退");
    const total = storedCents(order.totalRefundAmount || 0, "订单累计退款");
    if (afterSaleConfirmed !== actual || orderConfirmed !== total) {
      throw new RefundMutationError(
        "IMMUTABLE_EVIDENCE_CONFLICT",
        "退款确认记录与售后或订单累计退款不一致",
        409
      );
    }
    return { afterSaleRows, orderRows, afterSaleConfirmed, orderConfirmed };
  }

  async function oneOrNone(source, collectionName, where, codes = {}) {
    const response = await source.collection(collectionName).where(where).limit(2).get();
    const rows = Array.isArray(response.data) ? response.data : [];
    if (rows.length > 1) {
      throw new RefundMutationError(
        codes.duplicate || "IMMUTABLE_EVIDENCE_DUPLICATE",
        `${collectionName} 不可变证据重复`,
        409
      );
    }
    return rows[0] || null;
  }

  async function requiredEvidence(source, collectionName, where) {
    const row = await oneOrNone(source, collectionName, where);
    if (!row) {
      throw new RefundMutationError(
        "IMMUTABLE_EVIDENCE_MISSING",
        `${collectionName} 不可变证据缺失`,
        409
      );
    }
    return row;
  }

  function assertRefundSnapshot(refund, input) {
    const status = cleanText(refund.refundStatus || refund.status, 40);
    if (input.expectedRefundStatus !== undefined && input.expectedRefundStatus !== status) {
      throw new RefundMutationError("DATA_VERSION_CONFLICT", "退款记录已变化，请刷新后重试", 409);
    }
    if (input.expectedRefundVersion !== undefined && input.expectedRefundVersion !== versionOf(refund, "退款记录")) {
      throw new RefundMutationError("DATA_VERSION_CONFLICT", "退款记录已变化，请刷新后重试", 409);
    }
    if (input.expectedRefundUpdatedAt !== undefined && !sameInstant(input.expectedRefundUpdatedAt, refund.updatedAt)) {
      throw new RefundMutationError("DATA_VERSION_CONFLICT", "退款记录已变化，请刷新后重试", 409);
    }
    if (!PROCESSABLE_STATUSES.has(status)) {
      throw new RefundMutationError("REFUND_STATUS_CONFLICT", "当前退款状态不能执行该操作", 409);
    }
    return status;
  }

  function assertRefundRelations(refund, afterSale, order) {
    const invalid = [
      !afterSale,
      !order,
      cleanText(refund.afterSaleId, 128) !== cleanText(afterSale && afterSale._id, 128),
      cleanText(refund.orderId, 128) !== cleanText(order && order._id, 128),
      cleanText(afterSale && afterSale.orderId, 128) !== cleanText(order && order._id, 128)
    ];
    if (invalid.some(Boolean)) {
      throw new RefundMutationError("REFUND_RELATION_CONFLICT", "退款、售后和订单关系不一致", 409);
    }
  }

  function assertReturnInspection(afterSale) {
    const returnRequired = afterSale.returnRequired === true
      || cleanText(afterSale.afterSaleType, 60) === "return_refund";
    if (!returnRequired) return;
    const inspection = afterSale.inspectionResult || {};
    const inspectedAt = inspection.inspectedAt instanceof Date
      ? inspection.inspectedAt
      : new Date(inspection.inspectedAt || "");
    const completed = cleanText(afterSale.afterSaleStatus, 60) === "refund_pending"
      && inspection.received === true
      && Number.isFinite(inspectedAt.getTime());
    if (!completed) {
      throw new RefundMutationError("RETURN_INSPECTION_REQUIRED", "退货退款必须先完成验货", 409);
    }
  }

  function assertAfterSaleRefundable(afterSale) {
    const status = cleanText(afterSale.afterSaleStatus || afterSale.status, 60);
    if (!["approved", "refund_pending"].includes(status)) {
      throw new RefundMutationError("AFTER_SALE_NOT_APPROVED", "售后申请尚未审核通过或已结束", 409);
    }
    if (storedCents(afterSale.approvedRefundAmount || 0, "审批退款") <= 0) {
      throw new RefundMutationError("REFUND_APPROVAL_LIMIT_EXCEEDED", "审批退款金额必须大于 0", 409);
    }
  }

  function eventIds(businessKey) {
    return {
      ownerEventId: deterministicId("refund_event_owner", businessKey),
      adminEventId: deterministicId("refund_event_admin", businessKey)
    };
  }

  function evidenceKeys(businessKey) {
    return {
      accountBusinessKey: `refund_account:${businessKey}`,
      refundLogBusinessKey: `refund_log:${businessKey}`,
      afterSaleLogBusinessKey: `refund_after_sale:${businessKey}`,
      ...eventIds(businessKey)
    };
  }

  async function preflightEvidence(source, businessKey, options = {}) {
    const keys = evidenceKeys(businessKey);
    const checks = [
      ["admin_operation_logs", { businessKey }],
      ["refund_logs", { businessKey: keys.refundLogBusinessKey }],
      ["after_sale_logs", { businessKey: keys.afterSaleLogBusinessKey }],
      ["sync_events", { eventId: keys.ownerEventId }],
      ["sync_events", { eventId: keys.adminEventId }]
    ];
    if (options.account) checks.push(["account_logs", { businessKey: keys.accountBusinessKey }]);
    for (const [collectionName, where] of checks) {
      const existing = await oneOrNone(source, collectionName, where);
      if (existing) {
        throw new RefundMutationError("IMMUTABLE_EVIDENCE_CONFLICT", "退款操作标识已被占用", 409);
      }
    }
    return keys;
  }

  async function writeSyncEvents(source, {
    refund,
    actor,
    action,
    businessKey,
    timestamp,
    keys,
    frozenOwnerKey
  }) {
    const common = {
      eventType: "refund.status_changed",
      entityType: "refund",
      entityId: refund._id,
      action,
      version: versionOf(refund, "退款记录"),
      changedFields: ["refundStatus", "version", "updatedAt"],
      actorType: "admin",
      actorRole: actor.role,
      sourceClient: actor.sourceClient,
      createdAt: timestamp,
      expiresAt: new Date(timestamp.getTime() + 7 * 24 * 60 * 60 * 1000)
    };
    await source.collection("sync_events").add({
      data: {
        ...common,
        eventId: keys.ownerEventId,
        audience: "owner",
        ownerKey: frozenOwnerKey
      }
    });
    await source.collection("sync_events").add({
      data: {
        ...common,
        eventId: keys.adminEventId,
        audience: "admin"
      }
    });
  }

  async function findAccount(source, order) {
    const found = new Map();
    for (const where of [
      cleanText(order.userId, 128) ? { userId: cleanText(order.userId, 128) } : null,
      cleanText(order.userOpenid || order.openid, 128)
        ? { userOpenid: cleanText(order.userOpenid || order.openid, 128) }
        : null
    ].filter(Boolean)) {
      const response = await source.collection("customer_accounts").where(where).limit(2).get();
      const rows = Array.isArray(response.data) ? response.data : [];
      if (rows.length > 1) {
        throw new RefundMutationError("ACCOUNT_DUPLICATE", "客户账款记录重复", 409);
      }
      if (rows[0]) found.set(rows[0]._id, rows[0]);
    }
    if (found.size > 1) {
      throw new RefundMutationError("ACCOUNT_IDENTITY_CONFLICT", "客户账款身份不一致", 409);
    }
    return Array.from(found.values())[0] || null;
  }

  async function writeAccountLog(source, { account, order, refund, actor, timestamp, businessKey }) {
    const amount = storedCents(refund.refundAmount, "退款");
    const beforePaid = storedCents(
      account.totalPaidAmount !== undefined ? account.totalPaidAmount : account.paidAmount,
      "账款已付"
    );
    const beforeOrder = storedCents(
      account.totalOrderAmount !== undefined
        ? account.totalOrderAmount
        : account.totalReceivableAmount || beforePaid,
      "账款总额"
    );
    const beforeUnpaid = storedCents(
      account.totalUnpaidAmount !== undefined ? account.totalUnpaidAmount : account.unpaidAmount || 0,
      "账款未付"
    );
    await source.collection("account_logs").add({
      data: {
        businessKey,
        accountId: account._id,
        sourceType: "refund",
        sourceId: refund._id,
        relatedOrderId: order._id,
        relatedRefundRecordId: refund._id,
        relatedAfterSaleId: refund.afterSaleId,
        changeType: "refund",
        beforeTotalOrderAmount: beforeOrder,
        afterTotalOrderAmount: beforeOrder,
        beforeTotalPaidAmount: beforePaid,
        afterTotalPaidAmount: Math.max(beforePaid - amount, 0),
        beforeTotalUnpaidAmount: beforeUnpaid,
        afterTotalUnpaidAmount: beforeUnpaid,
        changeAmount: -amount,
        operatorId: actor.id,
        operatorRole: actor.role,
        createdAt: timestamp
      }
    });
  }

  async function prepareOrderItems(source, afterSale, amount, options = {}) {
    const requested = Array.isArray(afterSale.returnItems)
      ? afterSale.returnItems.filter((item) => cleanText(item.orderItemId, 128))
      : [];
    if (!requested.length) {
      return {
        mutations: [],
        evidence: { count: 0, amountCents: 0 }
      };
    }
    const weights = requested.map((item) => storedCents(item.refundableAmount || 0, "退款商品"));
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    let allocated = 0;
    const mutations = [];
    for (let index = 0; index < requested.length; index += 1) {
      const request = requested[index];
      const item = (await source.collection("order_items").doc(request.orderItemId).get()).data;
      if (!item || cleanText(item.orderId, 128) !== cleanText(afterSale.orderId, 128)) {
        throw new RefundMutationError("ORDER_ITEM_NOT_FOUND", "退款商品明细不存在", 409);
      }
      const itemAmount = index === requested.length - 1
        ? amount - allocated
        : weightTotal > 0
          ? Math.floor(amount * weights[index] / weightTotal)
          : 0;
      allocated += itemAmount;
      const quantity = storedCents(Number(request.returnQuantity || 0), "退款数量");
      const afterSaleId = cleanText(afterSale._id, 128);
      const appliedAfterSaleIds = Array.isArray(item.refundQuantityAppliedAfterSaleIds)
        ? item.refundQuantityAppliedAfterSaleIds.map((value) => cleanText(value, 128)).filter(Boolean)
        : [];
      const quantityAlreadyApplied = appliedAfterSaleIds.includes(afterSaleId);
      if (options.hasConfirmedRefund === true && !quantityAlreadyApplied) {
        throw new RefundMutationError(
          "REFUND_ITEM_QUANTITY_RECONCILIATION_REQUIRED",
          "历史退款商品数量归属需要人工核对",
          409
        );
      }
      const quantityDelta = quantityAlreadyApplied ? 0 : quantity;
      mutations.push({
        itemId: item._id,
        data: {
          afterSaleQuantity: storedCents(Number(item.afterSaleQuantity || 0), "售后数量") + quantityDelta,
          refundedQuantity: storedCents(Number(item.refundedQuantity || 0), "退款数量") + quantityDelta,
          returnedQuantity: storedCents(Number(item.returnedQuantity || 0), "退货数量")
            + (afterSale.returnRequired === true ? quantityDelta : 0),
          itemRefundAmount: storedCents(Number(item.itemRefundAmount || 0), "商品退款") + itemAmount,
          refundQuantityAppliedAfterSaleIds: Array.from(new Set([
            ...appliedAfterSaleIds,
            afterSaleId
          ])),
          itemAfterSaleStatus: "refunded"
        }
      });
    }
    return {
      mutations,
      evidence: { count: requested.length, amountCents: allocated }
    };
  }

  async function writeOrderItems(source, plan, timestamp) {
    for (const mutation of plan.mutations) {
      await source.collection("order_items").doc(mutation.itemId).update({
        data: {
          ...mutation.data,
          updatedAt: timestamp
        }
      });
    }
    return plan.evidence;
  }

  function refundSnapshot(row = {}) {
    return {
      id: cleanText(row._id || row.id, 128),
      refundNo: cleanText(row.refundNo, 100),
      afterSaleId: cleanText(row.afterSaleId, 128),
      orderId: cleanText(row.orderId, 128),
      refundStatus: cleanText(row.refundStatus || row.status, 40),
      refundAmount: storedCents(
        row.refundAmount !== undefined ? row.refundAmount : row.amountCents,
        "退款"
      ),
      version: versionOf(row, "退款记录"),
      updatedAt: isoTimestamp(row.updatedAt)
    };
  }

  function afterSaleSnapshot(row = {}) {
    return {
      id: cleanText(row._id || row.id, 128),
      orderId: cleanText(row.orderId, 128),
      afterSaleStatus: cleanText(row.afterSaleStatus || row.status, 60),
      refundStatus: cleanText(row.refundStatus, 40),
      approvedRefundAmount: storedCents(row.approvedRefundAmount || 0, "审批退款"),
      actualRefundAmount: storedCents(row.actualRefundAmount || 0, "售后实退"),
      version: versionOf(row, "售后记录")
    };
  }

  function orderSnapshot(row = {}) {
    return {
      id: cleanText(row._id || row.id, 128),
      refundStatus: cleanText(row.refundStatus, 40),
      afterSaleStatus: cleanText(row.afterSaleStatus, 60),
      paidAmount: storedCents(row.paidAmount || 0, "订单已付"),
      totalRefundAmount: storedCents(row.totalRefundAmount || 0, "订单累计退款"),
      version: versionOf(row, "订单")
    };
  }

  async function writeRefundLog(source, {
    refund,
    before,
    actor,
    action,
    businessKey,
    timestamp,
    result,
    itemEvidence,
    recovery
  }) {
    await source.collection("refund_logs").add({
      data: {
        businessKey,
        refundRecordId: refund._id,
        refundNo: refund.refundNo,
        afterSaleId: refund.afterSaleId,
        orderId: refund.orderId,
        action,
        beforeData: before ? refundSnapshot(before) : null,
        afterData: refundSnapshot(refund),
        amountCents: storedCents(refund.refundAmount, "退款"),
        result: {
          item: result.item,
          action: result.action,
          itemEvidence,
          recovery
        },
        operatorId: actor.id,
        operatorRole: actor.role,
        createdAt: timestamp
      }
    });
  }

  async function writeAfterSaleLog(source, {
    afterSale,
    before,
    actor,
    action,
    businessKey,
    timestamp
  }) {
    await source.collection("after_sale_logs").add({
      data: {
        businessKey,
        afterSaleId: afterSale._id,
        afterSaleNo: cleanText(afterSale.afterSaleNo, 100),
        orderId: afterSale.orderId,
        action,
        beforeData: before ? afterSaleSnapshot(before) : null,
        afterData: afterSaleSnapshot(afterSale),
        operatorType: "admin",
        operatorId: actor.id,
        operatorRole: actor.role,
        createdAt: timestamp
      }
    });
  }

  function recoverySnapshot({
    refund,
    afterSale,
    order,
    approvedAmountCents,
    paidAmountCents,
    frozenOwnerKey,
    accountId = "",
    cumulative = null
  }) {
    return {
      relationships: {
        refundRecordId: cleanText(refund._id, 128),
        afterSaleId: cleanText(afterSale._id, 128),
        orderId: cleanText(order._id, 128)
      },
      limits: {
        approvedAmountCents,
        paidAmountCents
      },
      committedVersions: {
        refund: versionOf(refund, "refund record"),
        afterSale: versionOf(afterSale, "after-sale record"),
        order: versionOf(order, "order")
      },
      ...(cumulative ? { cumulative: { ...cumulative } } : {}),
      accountId: cleanText(accountId, 128),
      ownerKey: frozenOwnerKey
    };
  }

  function recoveryMatches(left = {}, right = {}) {
    const leftRelationships = left.relationships || {};
    const rightRelationships = right.relationships || {};
    const leftLimits = left.limits || {};
    const rightLimits = right.limits || {};
    const leftVersions = left.committedVersions || {};
    const rightVersions = right.committedVersions || {};
    const leftCumulative = left.cumulative || {};
    const rightCumulative = right.cumulative || {};
    return cleanText(leftRelationships.refundRecordId, 128) === cleanText(rightRelationships.refundRecordId, 128)
      && cleanText(leftRelationships.afterSaleId, 128) === cleanText(rightRelationships.afterSaleId, 128)
      && cleanText(leftRelationships.orderId, 128) === cleanText(rightRelationships.orderId, 128)
      && leftLimits.approvedAmountCents === rightLimits.approvedAmountCents
      && leftLimits.paidAmountCents === rightLimits.paidAmountCents
      && leftVersions.refund === rightVersions.refund
      && leftVersions.afterSale === rightVersions.afterSale
      && leftVersions.order === rightVersions.order
      && leftCumulative.afterSaleBeforeCents === rightCumulative.afterSaleBeforeCents
      && leftCumulative.afterSaleAfterCents === rightCumulative.afterSaleAfterCents
      && leftCumulative.orderBeforeCents === rightCumulative.orderBeforeCents
      && leftCumulative.orderAfterCents === rightCumulative.orderAfterCents
      && cleanText(left.accountId, 128) === cleanText(right.accountId, 128)
      && cleanText(left.ownerKey, 128) === cleanText(right.ownerKey, 128);
  }

  async function executeProcess({ actor, input, idempotencyKey, operationId }) {
    return db.runTransaction(async (tx) => {
      const timestamp = businessTimestamp();
      const refund = (await tx.collection("refund_records").doc(input.refundRecordId).get()).data;
      if (!refund) throw new RefundMutationError("REFUND_NOT_FOUND", "退款记录不存在", 404);
      assertRefundSnapshot(refund, input);
      const afterSale = refund.afterSaleId
        ? (await tx.collection("after_sales").doc(refund.afterSaleId).get()).data
        : null;
      const order = refund.orderId
        ? (await tx.collection("orders").doc(refund.orderId).get()).data
        : null;
      assertRefundRelations(refund, afterSale, order);
      assertReturnInspection(afterSale);
      assertAfterSaleRefundable(afterSale);
      const history = await validateConfirmedHistory(tx, afterSale, order);
      const amount = input.refundAmountCents === undefined
        ? normalizeRefundAmount(refund.refundAmount)
        : input.refundAmountCents;
      if (amount > storedCents(refund.refundAmount, "退款记录")) {
        throw new RefundMutationError("REFUND_RECORD_AMOUNT_EXCEEDED", "退款金额超过退款记录金额", 409);
      }
      const approved = storedCents(afterSale.approvedRefundAmount || 0, "审批退款");
      const paid = storedCents(order.paidAmount || 0, "订单已付");
      if (history.afterSaleConfirmed + amount > approved) {
        throw new RefundMutationError("REFUND_APPROVAL_LIMIT_EXCEEDED", "退款金额超过审批上限", 409);
      }
      if (history.orderConfirmed + amount > paid) {
        throw new RefundMutationError("REFUND_PAID_LIMIT_EXCEEDED", "订单累计退款超过已付金额", 409);
      }
      const businessKey = `refund_mutation:${operationId}:${refund._id}:process`;
      const keys = await preflightEvidence(tx, businessKey, { account: true });
      const nextRefund = {
        ...refund,
        refundAmount: amount,
        refundStatus: "refunded",
        refundProofFileIds: input.refundProofFileIds === undefined
          ? (Array.isArray(refund.refundProofFileIds)
            ? refund.refundProofFileIds.slice()
            : Array.isArray(refund.refundProofImages) ? refund.refundProofImages.slice() : [])
          : input.refundProofFileIds,
        refundProofImages: input.refundProofFileIds === undefined
          ? (Array.isArray(refund.refundProofImages)
            ? refund.refundProofImages.slice()
            : Array.isArray(refund.refundProofFileIds) ? refund.refundProofFileIds.slice() : [])
          : input.refundProofFileIds,
        financeRemark: input.financeRemark === undefined
          ? cleanText(refund.financeRemark, 300)
          : input.financeRemark,
        failedReason: "",
        processedAt: timestamp,
        confirmedAt: timestamp,
        processedBy: actor.id,
        confirmedBy: actor.id,
        confirmationBusinessKey: businessKey,
        idempotencyKey,
        version: versionOf(refund, "退款记录") + 1,
        updatedAt: timestamp
      };
      const nextActual = history.afterSaleConfirmed + amount;
      const afterSaleRefundStatus = nextActual >= approved ? "refunded" : "partial_refunded";
      const nextAfterSale = {
        ...afterSale,
        refundStatus: afterSaleRefundStatus,
        afterSaleStatus: afterSaleRefundStatus === "refunded" ? "refunded" : "refund_pending",
        actualRefundAmount: nextActual,
        refundedBy: actor.id,
        refundedAt: timestamp,
        version: versionOf(afterSale, "售后记录") + 1,
        updatedAt: timestamp
      };
      const nextOrderTotal = history.orderConfirmed + amount;
      const orderRefundStatus = nextOrderTotal >= paid ? "refunded" : "partial_refunded";
      const nextOrderVersion = versionOf(order, "订单") + 1;
      const completionBusinessKey = `refund_recalculation:${operationId}:${order._id}`;
      const nextOrder = {
        ...order,
        refundStatus: orderRefundStatus,
        afterSaleStatus: nextAfterSale.afterSaleStatus,
        totalRefundAmount: nextOrderTotal,
        refundableAmount: Math.max(paid - nextOrderTotal, 0),
        netPaidAmount: Math.max(paid - nextOrderTotal, 0),
        lastRefundAt: timestamp,
        accountRecalculationPending: true,
        accountRecalculationOwner: operationId,
        accountRecalculationExpectedVersion: nextOrderVersion,
        version: nextOrderVersion,
        updatedAt: timestamp
      };
      const itemPlan = await prepareOrderItems(tx, afterSale, amount, {
        hasConfirmedRefund: history.afterSaleConfirmed > 0
      });
      const account = await findAccount(tx, order);
      if (!account) {
        throw new RefundMutationError("ACCOUNT_NOT_FOUND", "客户账款记录不存在", 409);
      }
      const frozenOwnerKey = ownerKey(order);
      const recovery = recoverySnapshot({
        refund: nextRefund,
        afterSale: nextAfterSale,
        order: nextOrder,
        approvedAmountCents: approved,
        paidAmountCents: paid,
        frozenOwnerKey,
        accountId: account._id,
        cumulative: {
          afterSaleBeforeCents: history.afterSaleConfirmed,
          afterSaleAfterCents: nextActual,
          orderBeforeCents: history.orderConfirmed,
          orderAfterCents: nextOrderTotal
        }
      });
      const result = publicResult(nextRefund, "process", {
        affected: 1,
        reused: false,
        accountRecalculationPending: true
      });

      await tx.collection("refund_records").doc(refund._id).update({
        data: {
          refundAmount: nextRefund.refundAmount,
          refundStatus: nextRefund.refundStatus,
          refundProofFileIds: nextRefund.refundProofFileIds,
          refundProofImages: nextRefund.refundProofImages,
          financeRemark: nextRefund.financeRemark,
          failedReason: "",
          processedAt: timestamp,
          confirmedAt: timestamp,
          processedBy: actor.id,
          confirmedBy: actor.id,
          confirmationBusinessKey: businessKey,
          idempotencyKey,
          version: nextRefund.version,
          updatedAt: timestamp
        }
      });
      await tx.collection("after_sales").doc(afterSale._id).update({
        data: {
          refundStatus: nextAfterSale.refundStatus,
          afterSaleStatus: nextAfterSale.afterSaleStatus,
          actualRefundAmount: nextAfterSale.actualRefundAmount,
          refundedBy: actor.id,
          refundedAt: timestamp,
          version: nextAfterSale.version,
          updatedAt: timestamp
        }
      });
      await tx.collection("orders").doc(order._id).update({
        data: {
          refundStatus: nextOrder.refundStatus,
          afterSaleStatus: nextOrder.afterSaleStatus,
          totalRefundAmount: nextOrder.totalRefundAmount,
          refundableAmount: nextOrder.refundableAmount,
          netPaidAmount: nextOrder.netPaidAmount,
          lastRefundAt: timestamp,
          accountRecalculationPending: true,
          accountRecalculationOwner: operationId,
          accountRecalculationExpectedVersion: nextOrderVersion,
          version: nextOrderVersion,
          updatedAt: timestamp
        }
      });
      const itemEvidence = await writeOrderItems(tx, itemPlan, timestamp);
      await writeAccountLog(tx, {
        account,
        order,
        refund: nextRefund,
        actor,
        timestamp,
        businessKey: keys.accountBusinessKey
      });
      await writeRefundLog(tx, {
        refund: nextRefund,
        before: refund,
        actor,
        action: "process_offline_refund",
        businessKey: keys.refundLogBusinessKey,
        timestamp,
        result,
        itemEvidence,
        recovery
      });
      await writeAfterSaleLog(tx, {
        afterSale: nextAfterSale,
        before: afterSale,
        actor,
        action: "refund_confirmed",
        businessKey: keys.afterSaleLogBusinessKey,
        timestamp
      });
      const journal = {
        schemaVersion: 1,
        committedAt: timestamp,
        action: "process",
        result,
        refund: refundSnapshot(nextRefund),
        afterSale: afterSaleSnapshot(nextAfterSale),
        order: orderSnapshot(nextOrder),
        recovery,
        itemEvidence,
        evidence: keys,
        recalculation: {
          required: true,
          owner: operationId,
          expectedOrderVersion: nextOrderVersion,
          completionBusinessKey
        }
      };
      await tx.collection("admin_operation_logs").add({
        data: {
          businessKey,
          sourceId: operationId,
          operationKind: "refund_process",
          action: "refund:process",
          resourceType: "refund",
          resourceId: refund._id,
          afterSaleId: afterSale._id,
          orderId: order._id,
          journal,
          operatorId: actor.id,
          operatorRole: actor.role,
          status: "success",
          createdAt: timestamp
        }
      });
      await writeSyncEvents(tx, {
        refund: nextRefund,
        actor,
        action: "process",
        businessKey,
        timestamp,
        keys,
        frozenOwnerKey
      });
      return result;
    });
  }

  async function executeReject({ actor, input, operationId }) {
    return db.runTransaction(async (tx) => {
      const timestamp = businessTimestamp();
      const refund = (await tx.collection("refund_records").doc(input.refundRecordId).get()).data;
      if (!refund) throw new RefundMutationError("REFUND_NOT_FOUND", "退款记录不存在", 404);
      assertRefundSnapshot(refund, input);
      const afterSale = refund.afterSaleId
        ? (await tx.collection("after_sales").doc(refund.afterSaleId).get()).data
        : null;
      const order = refund.orderId
        ? (await tx.collection("orders").doc(refund.orderId).get()).data
        : null;
      assertRefundRelations(refund, afterSale, order);
      await validateConfirmedHistory(tx, afterSale, order);
      const businessKey = `refund_mutation:${operationId}:${refund._id}:reject`;
      const keys = await preflightEvidence(tx, businessKey);
      const nextRefund = {
        ...refund,
        refundStatus: "rejected",
        failedReason: input.rejectReason,
        rejectReason: input.rejectReason,
        processedBy: actor.id,
        processedAt: timestamp,
        rejectionBusinessKey: businessKey,
        version: versionOf(refund, "退款记录") + 1,
        updatedAt: timestamp
      };
      const actual = storedCents(afterSale.actualRefundAmount || 0, "售后实退");
      const nextAfterSale = {
        ...afterSale,
        refundStatus: actual > 0 ? "partial_refunded" : "pending",
        version: versionOf(afterSale, "售后记录") + 1,
        updatedAt: timestamp
      };
      const total = storedCents(order.totalRefundAmount || 0, "订单累计退款");
      const nextOrder = {
        ...order,
        refundStatus: total > 0 ? "partial_refunded" : "pending",
        version: versionOf(order, "订单") + 1,
        updatedAt: timestamp
      };
      const frozenOwnerKey = ownerKey(order);
      const recovery = recoverySnapshot({
        refund: nextRefund,
        afterSale: nextAfterSale,
        order: nextOrder,
        approvedAmountCents: storedCents(afterSale.approvedRefundAmount || 0, "approved refund"),
        paidAmountCents: storedCents(order.paidAmount || 0, "paid amount"),
        frozenOwnerKey
      });
      const result = publicResult(nextRefund, "reject", {
        affected: 1,
        reused: false,
        accountRecalculationPending: false
      });
      await tx.collection("refund_records").doc(refund._id).update({
        data: {
          refundStatus: "rejected",
          failedReason: input.rejectReason,
          rejectReason: input.rejectReason,
          processedBy: actor.id,
          processedAt: timestamp,
          rejectionBusinessKey: businessKey,
          version: nextRefund.version,
          updatedAt: timestamp
        }
      });
      await tx.collection("after_sales").doc(afterSale._id).update({
        data: {
          refundStatus: nextAfterSale.refundStatus,
          version: nextAfterSale.version,
          updatedAt: timestamp
        }
      });
      await tx.collection("orders").doc(order._id).update({
        data: {
          refundStatus: nextOrder.refundStatus,
          version: nextOrder.version,
          updatedAt: timestamp
        }
      });
      await writeRefundLog(tx, {
        refund: nextRefund,
        before: refund,
        actor,
        action: "reject_refund",
        businessKey: keys.refundLogBusinessKey,
        timestamp,
        result,
        itemEvidence: { count: 0, amountCents: 0 },
        recovery
      });
      await writeAfterSaleLog(tx, {
        afterSale: nextAfterSale,
        before: afterSale,
        actor,
        action: "refund_rejected",
        businessKey: keys.afterSaleLogBusinessKey,
        timestamp
      });
      await tx.collection("admin_operation_logs").add({
        data: {
          businessKey,
          sourceId: operationId,
          operationKind: "refund_reject",
          action: "refund:reject",
          resourceType: "refund",
          resourceId: refund._id,
          afterSaleId: afterSale._id,
          orderId: order._id,
          journal: {
            schemaVersion: 1,
            committedAt: timestamp,
            action: "reject",
            result,
            refund: refundSnapshot(nextRefund),
            afterSale: afterSaleSnapshot(nextAfterSale),
            order: orderSnapshot(nextOrder),
            recovery,
            itemEvidence: { count: 0, amountCents: 0 },
            evidence: keys,
            recalculation: { required: false }
          },
          operatorId: actor.id,
          operatorRole: actor.role,
          status: "success",
          createdAt: timestamp
        }
      });
      await writeSyncEvents(tx, {
        refund: nextRefund,
        actor,
        action: "reject",
        businessKey,
        timestamp,
        keys,
        frozenOwnerKey
      });
      return result;
    });
  }

  async function executeCreate({ actor, input, operationId, idempotencyKey }) {
    return db.runTransaction(async (tx) => {
      const timestamp = businessTimestamp();
      const afterSale = (await tx.collection("after_sales").doc(input.afterSaleId).get()).data;
      if (!afterSale) throw new RefundMutationError("AFTER_SALE_NOT_FOUND", "售后记录不存在", 404);
      const order = afterSale.orderId
        ? (await tx.collection("orders").doc(afterSale.orderId).get()).data
        : null;
      if (!order) throw new RefundMutationError("ORDER_NOT_FOUND", "订单不存在", 404);
      assertReturnInspection(afterSale);
      assertAfterSaleRefundable(afterSale);
      const history = await validateConfirmedHistory(tx, afterSale, order);
      const approved = storedCents(afterSale.approvedRefundAmount || 0, "审批退款");
      const paid = storedCents(order.paidAmount || 0, "订单已付");
      const reserved = reservedAmount(history.afterSaleRows);
      const amount = input.refundAmountCents === undefined
        ? approved - reserved
        : input.refundAmountCents;
      if (!Number.isSafeInteger(amount) || amount <= 0 || reserved + amount > approved) {
        throw new RefundMutationError("REFUND_APPROVAL_LIMIT_EXCEEDED", "退款金额超过审批上限", 409);
      }
      if (history.orderConfirmed + amount > paid) {
        throw new RefundMutationError("REFUND_PAID_LIMIT_EXCEEDED", "订单累计退款超过已付金额", 409);
      }
      const refundId = deterministicId("refund_record", `${operationId}:${afterSale._id}`);
      const businessKey = `refund_mutation:${operationId}:${refundId}:create`;
      const keys = await preflightEvidence(tx, businessKey);
      const refundNo = `RF-${deterministicId("no", `${operationId}:${randomId()}`).split(":")[1].slice(0, 16).toUpperCase()}`;
      const refund = {
        _id: refundId,
        refundNo,
        afterSaleId: afterSale._id,
        afterSaleNo: cleanText(afterSale.afterSaleNo, 100),
        orderId: order._id,
        orderNo: cleanText(order.orderNo, 100),
        userId: cleanText(afterSale.userId || order.userId, 128),
        openid: cleanText(afterSale.openid || order.userOpenid || order.openid, 128),
        refundMethod: input.refundMethod || cleanText(afterSale.refundMethod, 80) || "offline",
        refundChannel: input.refundChannel,
        refundAmount: amount,
        refundStatus: "pending",
        financeRemark: input.financeRemark,
        originalPaymentMethodId: cleanText(order.paymentMethodId, 128),
        originalPaymentMethodType: cleanText(order.paymentMethodType || order.paymentMethod, 80),
        originalPaymentRecordId: cleanText(order.latestPaymentRecordId, 128),
        wechatPayTransactionId: cleanText(order.wechatPayTransactionId, 160),
        wechatPayOutTradeNo: cleanText(order.wechatPayOutTradeNo, 160),
        wechatPayRefundId: "",
        offlineRefundAccount: input.offlineRefundAccount,
        refundProofFileIds: [],
        refundProofImages: [],
        idempotencyKey,
        creationBusinessKey: businessKey,
        version: 1,
        requestedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const nextRefundIds = Array.from(new Set([
        ...(Array.isArray(afterSale.refundRecordIds) ? afterSale.refundRecordIds : []),
        refundId
      ]));
      const nextAfterSale = {
        ...afterSale,
        refundRecordIds: nextRefundIds,
        refundStatus: "pending",
        afterSaleStatus: "refund_pending",
        version: versionOf(afterSale, "售后记录") + 1,
        updatedAt: timestamp
      };
      const nextOrder = {
        ...order,
        refundStatus: "pending",
        afterSaleStatus: "refund_pending",
        version: versionOf(order, "订单") + 1,
        updatedAt: timestamp
      };
      const frozenOwnerKey = ownerKey(order);
      const recovery = recoverySnapshot({
        refund,
        afterSale: nextAfterSale,
        order: nextOrder,
        approvedAmountCents: approved,
        paidAmountCents: paid,
        frozenOwnerKey
      });
      const result = publicResult(refund, "create", {
        affected: 1,
        reused: false,
        accountRecalculationPending: false
      });
      await tx.collection("refund_records").add({ data: refund });
      await tx.collection("after_sales").doc(afterSale._id).update({
        data: {
          refundRecordIds: nextRefundIds,
          refundStatus: "pending",
          afterSaleStatus: "refund_pending",
          version: nextAfterSale.version,
          updatedAt: timestamp
        }
      });
      await tx.collection("orders").doc(order._id).update({
        data: {
          refundStatus: "pending",
          afterSaleStatus: "refund_pending",
          version: nextOrder.version,
          updatedAt: timestamp
        }
      });
      await writeRefundLog(tx, {
        refund,
        before: null,
        actor,
        action: "create_refund_record",
        businessKey: keys.refundLogBusinessKey,
        timestamp,
        result,
        itemEvidence: { count: 0, amountCents: 0 },
        recovery
      });
      await writeAfterSaleLog(tx, {
        afterSale: nextAfterSale,
        before: afterSale,
        actor,
        action: "create_refund_record",
        businessKey: keys.afterSaleLogBusinessKey,
        timestamp
      });
      await tx.collection("admin_operation_logs").add({
        data: {
          businessKey,
          sourceId: operationId,
          operationKind: "refund_create",
          action: "refund:create",
          resourceType: "refund",
          resourceId: refundId,
          afterSaleId: afterSale._id,
          orderId: order._id,
          journal: {
            schemaVersion: 1,
            committedAt: timestamp,
            action: "create",
            result,
            refund: refundSnapshot(refund),
            afterSale: afterSaleSnapshot(nextAfterSale),
            order: orderSnapshot(nextOrder),
            recovery,
            itemEvidence: { count: 0, amountCents: 0 },
            evidence: keys,
            recalculation: { required: false }
          },
          operatorId: actor.id,
          operatorRole: actor.role,
          status: "success",
          createdAt: timestamp
        }
      });
      await writeSyncEvents(tx, {
        refund,
        actor,
        action: "create",
        businessKey,
        timestamp,
        keys,
        frozenOwnerKey
      });
      return result;
    });
  }

  function journalFor(log, action, refundRecordId, operationId) {
    const journal = log && log.journal || {};
    const result = journal.result || {};
    const item = result.item || {};
    const refund = journal.refund || {};
    const evidence = journal.evidence || {};
    const recovery = journal.recovery || {};
    const relationships = recovery.relationships || {};
    const limits = recovery.limits || {};
    const committedVersions = recovery.committedVersions || {};
    const cumulative = recovery.cumulative || {};
    const valid = [
      cleanText(log.businessKey, 512) === `refund_mutation:${operationId}:${refundRecordId}:${action}`,
      cleanText(log.sourceId, 180) === operationId,
      cleanText(log.resourceId, 128) === refundRecordId,
      cleanText(log.status, 40) === "success",
      journal.schemaVersion === 1,
      cleanText(journal.action, 40) === action,
      cleanText(item.id, 128) === refundRecordId,
      cleanText(refund.id, 128) === refundRecordId,
      cleanText(item.status, 40) === cleanText(refund.refundStatus, 40),
      item.version === refund.version,
      item.amountCents === refund.refundAmount,
      Boolean(cleanText(evidence.refundLogBusinessKey, 512)),
      Boolean(cleanText(evidence.afterSaleLogBusinessKey, 512)),
      Boolean(cleanText(evidence.ownerEventId, 128)),
      Boolean(cleanText(evidence.adminEventId, 128)),
      cleanText(relationships.refundRecordId, 128) === refundRecordId,
      cleanText(relationships.afterSaleId, 128) === cleanText(journal.afterSale && journal.afterSale.id, 128),
      cleanText(relationships.orderId, 128) === cleanText(journal.order && journal.order.id, 128),
      Number.isSafeInteger(limits.approvedAmountCents) && limits.approvedAmountCents >= 0,
      Number.isSafeInteger(limits.paidAmountCents) && limits.paidAmountCents >= 0,
      committedVersions.refund === refund.version,
      committedVersions.afterSale === (journal.afterSale && journal.afterSale.version),
      committedVersions.order === (journal.order && journal.order.version),
      action !== "process" || Boolean(cleanText(recovery.accountId, 128)),
      action !== "process" || (
        Number.isSafeInteger(cumulative.afterSaleBeforeCents)
        && Number.isSafeInteger(cumulative.afterSaleAfterCents)
        && Number.isSafeInteger(cumulative.orderBeforeCents)
        && Number.isSafeInteger(cumulative.orderAfterCents)
        && cumulative.afterSaleBeforeCents >= 0
        && cumulative.orderBeforeCents >= 0
        && cumulative.afterSaleBeforeCents + refund.refundAmount === cumulative.afterSaleAfterCents
        && cumulative.orderBeforeCents + refund.refundAmount === cumulative.orderAfterCents
        && cumulative.afterSaleAfterCents === (journal.afterSale && journal.afterSale.actualRefundAmount)
        && cumulative.orderAfterCents === (journal.order && journal.order.totalRefundAmount)
        && cumulative.afterSaleAfterCents <= limits.approvedAmountCents
        && cumulative.orderAfterCents <= limits.paidAmountCents
      ),
      Boolean(cleanText(recovery.ownerKey, 128))
    ];
    if (valid.some((entry) => entry !== true)) {
      throw new RefundMutationError("IMMUTABLE_EVIDENCE_CONFLICT", "退款操作 journal 冲突", 409);
    }
    return journal;
  }

  function validateEvidenceLink(row, expected = {}) {
    return Object.entries(expected).every(([field, value]) => {
      if (typeof value === "number") return row[field] === value;
      return cleanText(row[field], 512) === cleanText(value, 512);
    });
  }

  async function recoverCommitted({ operationId, refundRecordId, action }) {
    const businessKey = `refund_mutation:${operationId}:${refundRecordId}:${action}`;
    const log = await oneOrNone(db, "admin_operation_logs", { businessKey });
    if (!log) return null;
    const journal = journalFor(log, action, refundRecordId, operationId);

    const refundLog = await requiredEvidence(db, "refund_logs", {
      businessKey: journal.evidence.refundLogBusinessKey
    });
    const afterSaleLog = await requiredEvidence(db, "after_sale_logs", {
      businessKey: journal.evidence.afterSaleLogBusinessKey
    });
    const ownerEvent = await requiredEvidence(db, "sync_events", {
      eventId: journal.evidence.ownerEventId
    });
    const adminEvent = await requiredEvidence(db, "sync_events", {
      eventId: journal.evidence.adminEventId
    });
    const currentAfterSale = (await db.collection("after_sales")
      .doc(journal.recovery.relationships.afterSaleId)
      .get()).data;
    const currentOrder = (await db.collection("orders")
      .doc(journal.recovery.relationships.orderId)
      .get()).data;
    if (!currentAfterSale || !currentOrder) {
      throw new RefundMutationError("IMMUTABLE_EVIDENCE_MISSING", "退款操作关联结果缺失", 409);
    }
    const expectedRefundLogAction = action === "process"
      ? "process_offline_refund"
      : action === "reject" ? "reject_refund" : "create_refund_record";
    const expectedAfterSaleLogAction = action === "process"
      ? "refund_confirmed"
      : action === "reject" ? "refund_rejected" : "create_refund_record";
    const expectedChangedFields = ["refundStatus", "version", "updatedAt"];
    const recovery = journal.recovery;
    const invalid = [
      !recoveryMatches(refundLog.result && refundLog.result.recovery, recovery),
      !validateEvidenceLink(refundLog, {
        refundRecordId,
        amountCents: journal.refund.refundAmount,
        action: expectedRefundLogAction
      }),
      !validateEvidenceLink(afterSaleLog, {
        afterSaleId: recovery.relationships.afterSaleId,
        orderId: recovery.relationships.orderId,
        action: expectedAfterSaleLogAction
      }),
      !validateEvidenceLink(ownerEvent, {
        eventId: journal.evidence.ownerEventId,
        entityId: refundRecordId,
        audience: "owner",
        action,
        eventType: "refund.status_changed",
        entityType: "refund",
        version: journal.refund.version
      }),
      !validateEvidenceLink(adminEvent, {
        eventId: journal.evidence.adminEventId,
        entityId: refundRecordId,
        audience: "admin",
        action,
        eventType: "refund.status_changed",
        entityType: "refund",
        version: journal.refund.version
      }),
      cleanText(ownerEvent.ownerKey, 128) !== cleanText(recovery.ownerKey, 128),
      JSON.stringify(ownerEvent.changedFields) !== JSON.stringify(expectedChangedFields),
      JSON.stringify(adminEvent.changedFields) !== JSON.stringify(expectedChangedFields),
      cleanText(refundLog.result && refundLog.result.item && refundLog.result.item.id, 128) !== refundRecordId,
      refundLog.result && refundLog.result.item && refundLog.result.item.amountCents !== journal.refund.refundAmount,
      cleanText(refundLog.afterData && refundLog.afterData.refundStatus, 40) !== journal.refund.refundStatus,
      refundLog.afterData && refundLog.afterData.version !== journal.refund.version,
      cleanText(afterSaleLog.afterData && afterSaleLog.afterData.afterSaleStatus, 60) !== journal.afterSale.afterSaleStatus,
      cleanText(afterSaleLog.afterData && afterSaleLog.afterData.refundStatus, 40) !== journal.afterSale.refundStatus,
      afterSaleLog.afterData && afterSaleLog.afterData.actualRefundAmount !== journal.afterSale.actualRefundAmount,
      afterSaleLog.afterData && afterSaleLog.afterData.version !== journal.afterSale.version,
      action === "process"
        && (!afterSaleLog.beforeData
          || afterSaleLog.beforeData.actualRefundAmount !== recovery.cumulative.afterSaleBeforeCents),
      storedCents(currentAfterSale.actualRefundAmount || 0, "售后实退") < journal.afterSale.actualRefundAmount,
      storedCents(currentOrder.totalRefundAmount || 0, "订单累计退款") < journal.order.totalRefundAmount,
      recovery.limits.approvedAmountCents < journal.refund.refundAmount,
      recovery.limits.paidAmountCents < journal.refund.refundAmount
    ];
    if (invalid.some(Boolean)) {
      throw new RefundMutationError("IMMUTABLE_EVIDENCE_CONFLICT", "退款不可变证据冲突", 409);
    }
    if (action === "process") {
      const accountLog = await requiredEvidence(db, "account_logs", {
        businessKey: journal.evidence.accountBusinessKey
      });
      if (!validateEvidenceLink(accountLog, {
        accountId: recovery.accountId,
        relatedRefundRecordId: refundRecordId,
        relatedOrderId: recovery.relationships.orderId,
        changeAmount: -journal.refund.refundAmount
      })) {
        throw new RefundMutationError("IMMUTABLE_EVIDENCE_CONFLICT", "退款账款证据冲突", 409);
      }
    }
    return journal.result;
  }

  async function loadRecalculationContext(operationId, refundRecordId) {
    const businessKey = `refund_mutation:${operationId}:${refundRecordId}:process`;
    const log = await oneOrNone(db, "admin_operation_logs", { businessKey });
    if (!log) return null;
    const journal = journalFor(log, "process", refundRecordId, operationId);
    const marker = journal.recalculation || {};
    if (marker.required !== true
      || cleanText(marker.owner, 180) !== operationId
      || !Number.isSafeInteger(marker.expectedOrderVersion)
      || !cleanText(marker.completionBusinessKey, 512)
      || !cleanText(journal.recovery && journal.recovery.accountId, 128)) {
      return null;
    }
    return {
      journalId: log._id,
      journalBusinessKey: businessKey,
      orderId: journal.order.id,
      accountId: journal.recovery.accountId,
      owner: marker.owner,
      expectedOrderVersion: marker.expectedOrderVersion,
      completionBusinessKey: marker.completionBusinessKey
    };
  }

  async function completionEvidence(source, context) {
    const completion = await oneOrNone(
      source,
      "admin_operation_logs",
      { businessKey: context.completionBusinessKey }
    );
    if (!completion) return null;
    const valid = cleanText(completion.operationKind, 80) === "refund_recalculation_completion"
      && cleanText(completion.sourceBusinessKey, 512) === context.journalBusinessKey
      && cleanText(completion.resourceId, 128) === context.orderId
      && cleanText(completion.status, 40) === "success";
    if (!valid) {
      throw new RefundMutationError("IMMUTABLE_EVIDENCE_CONFLICT", "退款账款重算完成证据冲突", 409);
    }
    return completion;
  }

  async function clearOwnedMarker(context) {
    return db.runTransaction(async (tx) => {
      const order = (await tx.collection("orders").doc(context.orderId).get()).data;
      const journal = (await tx.collection("admin_operation_logs").doc(context.journalId).get()).data;
      const completion = await completionEvidence(tx, context);
      if (completion) return order && order.accountRecalculationPending === false;
      const marker = journal && journal.journal && journal.journal.recalculation || {};
      const owns = order
        && journal
        && cleanText(journal.businessKey, 512) === context.journalBusinessKey
        && cleanText(marker.owner, 180) === context.owner
        && marker.expectedOrderVersion === context.expectedOrderVersion
        && cleanText(marker.completionBusinessKey, 512) === context.completionBusinessKey
         && order.accountRecalculationPending === true
         && cleanText(order.accountRecalculationOwner, 180) === context.owner
         && order.accountRecalculationExpectedVersion === context.expectedOrderVersion;
      if (!owns) return false;
      await tx.collection("orders").doc(order._id).update({
        data: {
          accountRecalculationPending: false,
          accountRecalculatedAt: db.serverDate ? db.serverDate() : businessTimestamp()
        }
      });
      await tx.collection("admin_operation_logs").add({
        data: {
          businessKey: context.completionBusinessKey,
          sourceBusinessKey: context.journalBusinessKey,
          operationKind: "refund_recalculation_completion",
          action: "refund_account_recalculated",
          resourceType: "order",
          resourceId: order._id,
          status: "success",
          createdAt: db.serverDate ? db.serverDate() : businessTimestamp()
        }
      });
      return true;
    });
  }

  async function finalizeRecalculation(result, operationId, refundRecordId) {
    const safe = {
      ...result,
      item: { ...result.item }
    };
    if (safe.accountRecalculationPending !== true) return safe;
    let context;
    try {
      context = await loadRecalculationContext(operationId, refundRecordId);
      if (!context) return safe;
      if (await completionEvidence(db, context)) {
        return { ...safe, accountRecalculationPending: false };
      }
      if (typeof recalculateAccount !== "function") return safe;
      const response = await recalculateAccount({ accountId: context.accountId });
      if ((response && response.ok === false)
        || (response && response.result && response.result.ok === false)) {
        return safe;
      }
      const cleared = await clearOwnedMarker(context);
      return cleared ? { ...safe, accountRecalculationPending: false } : safe;
    } catch (_) {
      return safe;
    }
  }

  function throwIdempotencyOutcome(outcome) {
    const code = cleanText(outcome && outcome.code, 80) || "IDEMPOTENCY_FAILED";
    throw new RefundMutationError(
      code,
      cleanText(outcome && outcome.message, 240) || "退款操作未完成",
      ["IDEMPOTENCY_KEY_CONFLICT", "IDEMPOTENCY_PROCESSING"].includes(code) ? 409 : 400
    );
  }

  async function runMutation({
    action,
    command,
    input,
    actor,
    execute
  }) {
    assertDependencies();
    await ensureCollections();
    const key = idempotency.assertIdempotencyKey(command.idempotencyKey);
    const scopeId = action === "create" ? input.afterSaleId : input.refundRecordId;
    const outcome = await idempotency.runIdempotentAction({
      db,
      actionType: `refund_${action}`,
      idempotencyKey: key,
      operatorIdentity: actor.id,
      operatorType: "admin",
      scope: "refund",
      scopeId,
      openid: actor.openid,
      adminId: actor.id,
      payload: input,
      recoverProcessingResult: () => action === "create"
        ? recoverCreated({ operationId: key, afterSaleId: input.afterSaleId })
        : recoverCommitted({ operationId: key, refundRecordId: input.refundRecordId, action })
    }, () => execute({
      actor,
      input,
      idempotencyKey: key,
      operationId: key
    }));
    if (!outcome || outcome.ok !== true) throwIdempotencyOutcome(outcome);
    const duplicate = outcome.data && outcome.data.duplicate === true;
    const result = {
      ...outcome.data,
      item: { ...outcome.data.item },
      affected: duplicate ? 0 : outcome.data.affected,
      reused: duplicate || outcome.data.reused === true
    };
    delete result.duplicate;
    delete result.idempotencyStatus;
    return action === "process"
      ? finalizeRecalculation(result, key, input.refundRecordId)
      : result;
  }

  async function recoverCreated({ operationId, afterSaleId }) {
    const response = await db.collection("admin_operation_logs")
      .where({ sourceId: operationId, operationKind: "refund_create", afterSaleId })
      .limit(2)
      .get();
    const logs = Array.isArray(response.data) ? response.data : [];
    if (logs.length > 1) {
      throw new RefundMutationError("IMMUTABLE_EVIDENCE_DUPLICATE", "退款创建 journal 重复", 409);
    }
    if (!logs[0]) return null;
    return recoverCommitted({
      operationId,
      refundRecordId: cleanText(logs[0].resourceId, 128),
      action: "create"
    });
  }

  async function createRefundRecord(command = {}) {
    const strict = command.strict !== false;
    return runMutation({
      action: "create",
      command,
      input: normalizeCreateInput(command.input, strict),
      actor: normalizeActor(command.actor),
      execute: executeCreate
    });
  }

  async function processOfflineRefund(command = {}) {
    const strict = command.strict !== false;
    return runMutation({
      action: "process",
      command,
      input: normalizeProcessInput(command.input, strict),
      actor: normalizeActor(command.actor),
      execute: executeProcess
    });
  }

  async function rejectRefund(command = {}) {
    const strict = command.strict !== false;
    return runMutation({
      action: "reject",
      command,
      input: normalizeRejectInput(command.input, strict),
      actor: normalizeActor(command.actor),
      execute: executeReject
    });
  }

  return {
    createRefundRecord,
    processOfflineRefund,
    rejectRefund
  };
}

module.exports = {
  RefundMutationError,
  createRefundMutationService,
  REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES
};
