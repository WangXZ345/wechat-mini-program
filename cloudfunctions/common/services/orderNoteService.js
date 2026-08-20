"use strict";

const crypto = require("crypto");
const operationOutbox = require("./operationOutbox");

class OrderNoteError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "OrderNoteError";
    this.code = code;
    this.statusCode = statusCode;
    if (details) this.details = details;
  }
}

function cleanString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function assertInput(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OrderNoteError("INVALID_REQUEST_BODY", "备注请求无效");
  if (Object.keys(raw).some((key) => !["orderId", "content", "expectedVersion"].includes(key))) throw new OrderNoteError("INVALID_REQUEST_BODY", "备注请求包含未知字段");
  const orderId = cleanString(raw.orderId, 128);
  if (!orderId) throw new OrderNoteError("ORDER_ID_REQUIRED", "缺少订单 ID");
  if (typeof raw.content !== "string") throw new OrderNoteError("NOTE_CONTENT_INVALID", "备注内容格式无效");
  const content = raw.content.trim();
  if (!content) throw new OrderNoteError("NOTE_CONTENT_REQUIRED", "备注内容不能为空");
  if (content.length > 500) throw new OrderNoteError("NOTE_CONTENT_TOO_LONG", "备注内容不能超过 500 个字符");
  if (typeof raw.expectedVersion !== "number" || !Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion < 0) {
    throw new OrderNoteError("EXPECTED_VERSION_INVALID", "订单版本无效，请刷新后重试");
  }
  return { orderId, content, expectedVersion: raw.expectedVersion };
}

function assertActor(actor = {}) {
  if (!actor || actor.isActive === false || actor.status !== "active") throw new OrderNoteError("FORBIDDEN", "无权修改订单备注", 403);
  const id = cleanString(actor.id || actor._id, 128);
  const role = cleanString(actor.role, 50);
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (!id || !role || !(role === "super_admin" || permissions.includes("*") || permissions.includes("order:edit_remark"))) {
    throw new OrderNoteError("FORBIDDEN", "无权修改订单备注", 403);
  }
  return { id, role, name: cleanString(actor.name || actor.displayName, 80) };
}

function asDate(value, fallback) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function currentVersionOf(current) {
  const version = current && current.version === undefined ? 0 : current && current.version;
  if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER) {
    throw new OrderNoteError("DATA_VERSION_INVALID", "订单版本数据异常，请刷新后重试", 409);
  }
  return version;
}

function errorForOrder(current, input) {
  if (!current) throw new OrderNoteError("ORDER_NOT_FOUND", "订单不存在", 404);
  const version = currentVersionOf(current);
  if (version !== input.expectedVersion) throw new OrderNoteError("DATA_VERSION_CONFLICT", "订单已变化，请刷新后重新确认", 409, { currentVersion: version, refreshRequired: true });
  return version;
}

function recoveryBusinessKey(actor, input, idempotencyDigest) {
  return `order:${input.orderId}:remark:${actor.id}:${idempotencyDigest}`;
}

function createOrderNoteService({ db, idempotency, now = () => new Date(), randomId = () => crypto.randomUUID() }) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("order note service requires db.runTransaction");
  if (!idempotency || typeof idempotency.runIdempotentAction !== "function" || typeof idempotency.assertIdempotencyKey !== "function") throw new Error("order note service requires idempotency helpers");

  async function appendNote(command = {}) {
    const actor = assertActor(command.actor);
    const input = assertInput(command.input);
    const idempotencyKey = idempotency.assertIdempotencyKey(command.idempotencyKey);
    const idempotencyDigest = crypto.createHash("sha256").update(idempotencyKey).digest("hex");
    const businessKey = recoveryBusinessKey(actor, input, idempotencyDigest);
    const outcome = await idempotency.runIdempotentAction({
      db, actionType: "order:edit_remark", operatorIdentity: actor.id, operatorType: "admin",
      scope: "order", scopeId: input.orderId, payload: input, idempotencyKey, requestId: cleanString(command.requestId, 100),
      async recoverProcessingResult() {
        const response = await db.collection("note_logs").where({ targetType: "order", targetId: input.orderId, businessKey }).orderBy("createdAt", "desc").limit(2).get();
        const rows = Array.isArray(response && response.data) ? response.data : [];
        if (rows.length !== 1) return null;
        const row = rows[0];
        const version = row && row.versionAfter;
        const content = cleanString(row && (row.content || row.afterNote), 500);
        const createdAt = row && row.createdAt ? asDate(row.createdAt, null) : null;
        const authorId = cleanString(row && (row.authorId || row.operatorId), 128);
        const id = cleanString(row && (row._id || row.id), 128);
        if (!row || !id || !content || content !== input.content || authorId !== actor.id || row.versionBefore !== input.expectedVersion || !createdAt || !Number.isSafeInteger(version) || version !== input.expectedVersion + 1) return null;
        return { note: { id, content, authorId, authorRole: cleanString(row.authorRole || row.operatorRole, 50), authorName: cleanString(row.authorName || row.operatorName, 80), createdAt: createdAt.toISOString() }, version, updatedAt: createdAt.toISOString(), changed: true, reused: true };
      }
    }, async () => db.runTransaction(async (transaction) => {
      const current = (await transaction.collection("orders").doc(input.orderId).get()).data;
      const currentVersion = errorForOrder(current, input);
      const updatedAt = asDate(now(), new Date());
      const nextVersion = currentVersion + 1;
      const noteId = cleanString(randomId(), 128) || crypto.randomUUID();
      const note = { id: noteId, content: input.content, authorId: actor.id, authorRole: actor.role, authorName: actor.name, createdAt: updatedAt.toISOString() };
      await transaction.collection("note_logs").add({ data: {
        _id: noteId, targetType: "order", targetId: input.orderId, orderId: input.orderId,
        content: note.content, afterNote: note.content, authorId: actor.id, authorRole: actor.role, authorName: actor.name,
        versionBefore: currentVersion, versionAfter: nextVersion, businessKey,
        idempotencyDigest, createdAt: updatedAt
      } });
      await transaction.collection("orders").doc(input.orderId).update({ data: {
        adminNote: note.content, adminRemark: note.content, adminNoteUpdatedAt: updatedAt,
        adminNoteUpdatedBy: actor.id, updatedAt, version: nextVersion
      } });
      const operation = {
        operator: actor, action: "order:edit_remark", resourceType: "order", resourceId: input.orderId,
        requestId: cleanString(command.requestId, 100), idempotencyKey, businessKey,
        changedFields: ["updatedAt", "version"], before: { version: currentVersion }, after: { version: nextVersion },
        result: { status: "success", affected: 1, changed: true }, timestamp: updatedAt
      };
      await operationOutbox.writeOperationBundle(transaction, { operation, events: [operationOutbox.buildSyncEvent({
        ...operation, eventType: "order.remark_updated", entityType: "order", entityId: input.orderId, version: nextVersion, updatedAt
      })] });
      return { note, version: nextVersion, updatedAt: updatedAt.toISOString(), changed: true, reused: false };
    }));
    if (!outcome || outcome.ok !== true || !outcome.data || typeof outcome.data !== "object") {
      const err = new OrderNoteError("IDEMPOTENCY_PROCESSING", "请求正在处理中，请稍后重试", 409);
      if (outcome && outcome.code) { err.code = outcome.code; err.statusCode = outcome.statusCode || err.statusCode; }
      throw err;
    }
    return { ...outcome.data, reused: outcome.data.reused === true || outcome.data.duplicate === true };
  }
  return { appendNote };
}

module.exports = { OrderNoteError, createOrderNoteService, assertInput };
