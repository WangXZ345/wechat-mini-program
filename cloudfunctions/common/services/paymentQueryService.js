const WEB_PAYMENT_STATUSES = new Set(["pending_confirm", "paid", "partial_paid", "unpaid", "abnormal", "rejected"]);
const WEB_PAYMENT_ROLES = new Set(["finance", "super_admin"]);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 80;
const PAYMENT_AUTHORITY_SCAN_BATCH_SIZE = 100;
const PAYMENT_AUTHORITY_SCAN_LIMIT = 500;

class PaymentQueryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "PaymentQueryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanText(value, max = 240) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function owns(row, key) {
  return Boolean(row && Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined);
}

function isActive(actor) {
  return Boolean(actor && actor.isActive !== false && actor.status !== "disabled" && actor.status !== "inactive");
}

function explicitPermission(actor, permission) {
  return Boolean(actor && Array.isArray(actor.permissions)
    && (actor.permissions.includes("*") || actor.permissions.includes(permission)));
}

function assertWebAccess(actor) {
  if (!isActive(actor) || !WEB_PAYMENT_ROLES.has(actor && actor.role)
    || !explicitPermission(actor, "payment:view_screenshot")) {
    throw new PaymentQueryError("FORBIDDEN", "无权查看付款记录", 403);
  }
}

function dateIso(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeNonNegative(value, field, fallback = 0) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new PaymentQueryError("PAYMENT_DATA_INVALID", `付款记录字段 ${field} 数据异常`, 503);
  }
  return candidate;
}

function amountCents(row) {
  const field = ["amount", "paidAmount", "changeAmount", "orderAmount"].find((name) => owns(row, name));
  return safeNonNegative(field ? row[field] : 0, field || "amount");
}

function versionOf(row) {
  const value = row && row.version;
  return safeNonNegative(value === undefined || value === null || value === "" ? 0 : value, "version");
}

function maskPhone(value) {
  const digits = cleanText(value, 40).replace(/\D/g, "");
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return "";
}

function scrubPhones(value) {
  const text = cleanText(value, 160);
  return text.replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?!\d)/g, (phone) => maskPhone(phone));
}

function customerMasked(row, order) {
  const source = row.customerMasked || row.customerName || row.nickname || order && (order.customerMasked || order.customerName || order.nickname || order.name);
  const phone = row.phoneMasked || order && (order.phoneMasked || order.phoneNumber || order.phone);
  const name = cleanText(source, 80) || "客户";
  const maskedName = name.length > 1 ? `${name.slice(0, 1)}${"*".repeat(Math.min(3, name.length - 1))}` : `${name}*`;
  return scrubPhones([maskedName, maskPhone(phone)].filter(Boolean).join(" / "));
}

function paymentStatus(row) {
  return cleanText(row.paymentStatus || row.status, 60);
}

function normalizeQuery(query = {}) {
  const search = String(query.search === undefined || query.search === null ? "" : query.search).trim();
  if (search.length > MAX_SEARCH_LENGTH) throw new PaymentQueryError("PAYMENT_QUERY_INVALID", "付款记录搜索内容过长", 400);
  const status = cleanText(query.status, 40);
  if (status && !WEB_PAYMENT_STATUSES.has(status)) throw new PaymentQueryError("PAYMENT_QUERY_INVALID", "付款记录状态筛选无效", 400);
  const parsedPageSize = query.pageSize === undefined || query.pageSize === null || query.pageSize === ""
    ? DEFAULT_PAGE_SIZE : Number.parseInt(query.pageSize, 10);
  if (!Number.isSafeInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > MAX_PAGE_SIZE) {
    throw new PaymentQueryError("PAYMENT_QUERY_INVALID", "付款记录分页大小无效", 400);
  }
  const cursor = String(query.cursor === undefined || query.cursor === null ? "" : query.cursor).trim();
  if (cursor.length > 4096) throw new PaymentQueryError("PAYMENT_CURSOR_INVALID", "付款记录分页游标无效", 400);
  return { status, search, pageSize: parsedPageSize, cursor };
}

function encodeCursor(row, normalized) {
  const updatedAt = dateIso(row.updatedAt);
  const id = cleanText(row._id || row.id, 128);
  if (!updatedAt || !id) return null;
  return Buffer.from(JSON.stringify({ v: 1, updatedAt, id, status: normalized.status, search: normalized.search, pageSize: normalized.pageSize }), "utf8").toString("base64url");
}

function decodeCursor(value, normalized) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const updatedAt = dateIso(parsed.updatedAt);
    const id = cleanText(parsed.id, 128);
    if (parsed.v !== 1 || !updatedAt || !id || parsed.status !== normalized.status || parsed.search !== normalized.search || parsed.pageSize !== normalized.pageSize) throw new Error("invalid");
    return { updatedAt: new Date(updatedAt), id };
  } catch (error) {
    throw new PaymentQueryError("PAYMENT_CURSOR_INVALID", "付款记录分页游标无效或与筛选条件不一致", 400);
  }
}

function combine(command, conditions) {
  const usable = conditions.filter(Boolean);
  if (!usable.length) return null;
  return usable.length === 1 ? usable[0] : command.and(usable);
}

function cursorWhere(command, cursor) {
  if (!cursor) return null;
  return command.or([{ updatedAt: command.lt(cursor.updatedAt) }, command.and([{ updatedAt: cursor.updatedAt }, { _id: command.lt(cursor.id) }])]);
}

function statusWhere(command, status) {
  if (!status) return null;
  return command.or([{ paymentStatus: status }, { status }]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchWhere(db, command, search) {
  if (!search) return null;
  if (typeof db.RegExp !== "function") throw new PaymentQueryError("PAYMENT_READ_FAILED", "付款记录读取失败，请稍后重试", 503);
  const expression = db.RegExp({ regexp: escapeRegExp(search), options: "i" });
  return command.or([{ orderNo: expression }, { orderId: expression }, { customerMasked: expression }, { customerName: expression }, { nickname: expression }]);
}

function paymentProjection(row, order) {
  const id = cleanText(row._id || row.id, 128);
  const updatedAt = dateIso(row.updatedAt);
  if (!id || !updatedAt) throw new PaymentQueryError("PAYMENT_DATA_INVALID", "付款记录稳定标识或更新时间异常", 503);
  const proofCount = Array.isArray(row.screenshotUrls) ? row.screenshotUrls.length : (row.paymentScreenshotUrl || row.screenshotUrl ? 1 : 0);
  if (!Number.isSafeInteger(proofCount) || proofCount < 0 || proofCount > 20) throw new PaymentQueryError("PAYMENT_DATA_INVALID", "付款记录凭证数量异常", 503);
  const submittedAt = dateIso(row.submittedAt || row.createdAt);
  return {
    id,
    orderNo: cleanText(row.orderNo || order && order.orderNo, 120),
    customerMasked: customerMasked(row, order),
    amountCents: amountCents(row),
    proofLabel: proofCount > 0 ? "已提交凭证" : "无凭证",
    proofCount,
    status: paymentStatus(row),
    submittedAt,
    updatedAt,
    version: versionOf(row)
  };
}

function isAuthoritativePending(row, order) {
  if (paymentStatus(row) !== "pending_confirm") return true;
  const paymentId = cleanText(row && (row._id || row.id), 128);
  return Boolean(paymentId
    && order
    && cleanText(order.latestPaymentRecordId, 128) === paymentId
    && order.paymentStatus === "pending_confirm"
    && order.status === "pending_payment_confirm");
}

function isMissingCollection(error) {
  const message = String((error && error.message) || error || "");
  return /collection not exists|database collection not exists|Db or Table not exist|DATABASE_COLLECTION_NOT_EXIST|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

function readFailure(error) {
  if (error instanceof PaymentQueryError) return error;
  return new PaymentQueryError("PAYMENT_READ_FAILED", "付款记录读取失败，请稍后重试", 503);
}

function createPaymentQueryService({ db, command }) {
  if (!db || !command) throw new Error("payment query service requires db and command");

  async function supplementOrders(rows) {
    const ids = Array.from(new Set(rows.map((row) => cleanText(row.orderId, 128)).filter(Boolean)));
    if (!ids.length) return new Map();
    try {
      const result = await db.collection("orders").where({ _id: command.in(ids) }).limit(MAX_PAGE_SIZE).get();
      return new Map((Array.isArray(result.data) ? result.data : []).map((row) => [cleanText(row._id || row.id, 128), row]));
    } catch (error) {
      if (isMissingCollection(error)) return new Map();
      throw error;
    }
  }

  async function listWebPayments({ actor, query = {} } = {}) {
    assertWebAccess(actor);
    const normalized = normalizeQuery(query);
    const cursor = decodeCursor(normalized.cursor, normalized);
    try {
      const baseConditions = [statusWhere(command, normalized.status), searchWhere(db, command, normalized.search)];
      const authoritative = [];
      let scanCursor = cursor;
      let lastScanned = null;
      let scanned = 0;
      let exhausted = false;
      while (authoritative.length <= normalized.pageSize && scanned < PAYMENT_AUTHORITY_SCAN_LIMIT && !exhausted) {
        const batchLimit = Math.min(PAYMENT_AUTHORITY_SCAN_BATCH_SIZE, PAYMENT_AUTHORITY_SCAN_LIMIT - scanned);
        const where = combine(command, [...baseConditions, cursorWhere(command, scanCursor)]);
        let request = db.collection("payment_records");
        if (where) request = request.where(where);
        const response = await request.orderBy("updatedAt", "desc").orderBy("_id", "desc").limit(batchLimit).get();
        const batch = Array.isArray(response.data) ? response.data : [];
        if (!batch.length) {
          exhausted = true;
          break;
        }
        scanned += batch.length;
        lastScanned = batch[batch.length - 1];
        const orderMap = await supplementOrders(batch);
        for (const row of batch) {
          if (normalized.status && paymentStatus(row) !== normalized.status) continue;
          const order = orderMap.get(cleanText(row.orderId, 128));
          if (isAuthoritativePending(row, order)) authoritative.push({ row, order });
          if (authoritative.length > normalized.pageSize) break;
        }
        exhausted = batch.length < batchLimit;
        const encodedScanCursor = encodeCursor(lastScanned, normalized);
        if (!encodedScanCursor) {
          throw new PaymentQueryError("PAYMENT_DATA_INVALID", "付款记录稳定标识或更新时间异常", 503);
        }
        scanCursor = decodeCursor(encodedScanCursor, normalized);
      }
      const pageEntries = authoritative.slice(0, normalized.pageSize);
      const pageRows = pageEntries.map((entry) => entry.row);
      const hasBufferedMore = authoritative.length > normalized.pageSize;
      const scanLimitReached = !exhausted && scanned >= PAYMENT_AUTHORITY_SCAN_LIMIT;
      const hasMore = hasBufferedMore || scanLimitReached;
      const cursorRow = hasBufferedMore
        ? pageRows[pageRows.length - 1]
        : scanLimitReached ? lastScanned : null;
      return {
        items: pageEntries.map(({ row, order }) => paymentProjection(row, order)),
        pageSize: normalized.pageSize,
        hasMore,
        nextCursor: hasMore && cursorRow ? encodeCursor(cursorRow, normalized) : null
      };
    } catch (error) {
      throw readFailure(error);
    }
  }

  async function getWebPayment({ actor, id } = {}) {
    assertWebAccess(actor);
    const paymentId = cleanText(id, 128);
    if (!paymentId) throw new PaymentQueryError("PAYMENT_QUERY_INVALID", "缺少付款记录 ID", 400);
    try {
      const result = await db.collection("payment_records").doc(paymentId).get();
      if (!result.data) throw new PaymentQueryError("PAYMENT_NOT_FOUND", "付款记录不存在", 404);
      const orderMap = await supplementOrders([result.data]);
      const order = orderMap.get(cleanText(result.data.orderId, 128));
      if (!isAuthoritativePending(result.data, order)) {
        throw new PaymentQueryError("PAYMENT_NOT_FOUND", "付款记录不存在", 404);
      }
      return paymentProjection(result.data, order);
    } catch (error) {
      if (error instanceof PaymentQueryError) throw error;
      throw readFailure(error);
    }
  }

  return { listWebPayments, getWebPayment };
}

module.exports = { PaymentQueryError, WEB_PAYMENT_STATUSES, createPaymentQueryService };
