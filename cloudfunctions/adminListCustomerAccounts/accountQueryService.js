const WEB_ACCOUNT_STATUSES = new Set(["unpaid", "pending_confirm", "abnormal", "settled"]);
const WEB_ACCOUNT_ROLES = new Set(["finance", "super_admin"]);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 80;
const LEGACY_MAX_ROWS = 1000;

class AccountQueryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "AccountQueryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanText(value, max = 240) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function owns(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined);
}

function isActive(actor) {
  return Boolean(actor && actor.isActive !== false && actor.status !== "disabled" && actor.status !== "inactive");
}

function explicitPermission(actor, permission) {
  return Boolean(actor && Array.isArray(actor.permissions)
    && (actor.permissions.includes("*") || actor.permissions.includes(permission)));
}

function assertWebAccess(actor) {
  if (!isActive(actor) || !WEB_ACCOUNT_ROLES.has(actor && actor.role) || !explicitPermission(actor, "customer:view_account")) {
    throw new AccountQueryError("FORBIDDEN", "无权查看客户账款", 403);
  }
}

function assertLegacyAccess(actor, permission) {
  if (!isActive(actor) || !explicitPermission(actor, permission)) {
    throw new AccountQueryError("FORBIDDEN", "无权查看客户账款", 403);
  }
}

function dateIso(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nonNegativeInteger(value, field, fallback = 0) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new AccountQueryError("ACCOUNT_DATA_INVALID", `客户账款字段 ${field} 数据异常`, 503);
  }
  return candidate;
}

function signedInteger(value, field, fallback = 0) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate)) {
    throw new AccountQueryError("ACCOUNT_DATA_INVALID", `客户账款字段 ${field} 数据异常`, 503);
  }
  return candidate;
}

function currentThenLegacy(row, primary, legacy, fallback = 0) {
  const value = owns(row, primary) ? row[primary] : owns(row, legacy) ? row[legacy] : fallback;
  return nonNegativeInteger(value, primary, fallback);
}

function legacyNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function maskName(value) {
  const text = cleanText(value, 80);
  if (!text) return "客户";
  if (text.length === 1) return `${text}*`;
  return `${text.slice(0, 1)}${"*".repeat(Math.min(3, text.length - 1))}`;
}

function decimalDigitToAscii(character) {
  const code = character.codePointAt(0);
  if (code >= 0x30 && code <= 0x39) return String(code - 0x30);
  if (code >= 0xFF10 && code <= 0xFF19) return String(code - 0xFF10);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06F0 && code <= 0x06F9) return String(code - 0x06F0);
  return "";
}

function extractPhoneDigits(value, max = 100) {
  return Array.from(cleanText(value, max), decimalDigitToAscii).join("");
}

function maskPhone(value) {
  const extracted = extractPhoneDigits(value, 100);
  const digits = extracted.length === 13 && extracted.startsWith("86") ? extracted.slice(2) : extracted.slice(-11);
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return digits ? "***" : "";
}

function scrubPhones(value, max = 500) {
  const digit = "0-9\\uFF10-\\uFF19\\u0660-\\u0669\\u06F0-\\u06F9";
  const one = "1\\uFF11\\u0661\\u06F1";
  const threeToNine = "3-9\\uFF13-\\uFF19\\u0663-\\u0669\\u06F3-\\u06F9";
  const eight = "8\\uFF18\\u0668\\u06F8";
  const six = "6\\uFF16\\u0666\\u06F6";
  const separator = "[\\s.,:_|\\-()/\\\\\\u00b7\\u2010-\\u2015\\u3002\\u200B-\\u200D\\u2060\\uFEFF]*";
  const mobile = `[${one}]${separator}[${threeToNine}](?:${separator}[${digit}]){9}`;
  const country = `(?:[+\\uFF0B]${separator})?[${eight}]${separator}[${six}]${separator}`;
  const candidate = new RegExp(`(?<![${digit}])(?:${country})?${mobile}(?![${digit}])`, "gu");
  return cleanText(value, max).replace(candidate, (phone) => maskPhone(phone));
}

function customerMasked(row) {
  const phone = maskPhone(row.phoneMasked || row.phoneNumber || row.phone || row.customerPhoneMasked || "");
  return [maskName(row.nickname || row.customerName || row.name), phone].filter(Boolean).join(" ");
}

function accountAmounts(row) {
  return {
    receivableCents: currentThenLegacy(row, "totalOrderAmount", "totalReceivableAmount"),
    receivedCents: currentThenLegacy(row, "totalPaidAmount", "paidAmount"),
    unpaidAmountCents: currentThenLegacy(row, "totalUnpaidAmount", "unpaidAmount"),
    pendingConfirmAmountCents: nonNegativeInteger(owns(row, "pendingConfirmAmount") ? row.pendingConfirmAmount : 0, "pendingConfirmAmount"),
    abnormalCount: nonNegativeInteger(owns(row, "abnormalCount") ? row.abnormalCount : 0, "abnormalCount")
  };
}

function accountStatus(row, amounts) {
  if (amounts.abnormalCount > 0) return "abnormal";
  if (amounts.pendingConfirmAmountCents > 0) return "pending_confirm";
  if (row.isSettled === true) return "settled";
  return "unpaid";
}

function webAccountProjection(row) {
  const id = cleanText(row._id || row.id, 128);
  const updatedAt = dateIso(row.updatedAt);
  if (!id || !updatedAt) {
    throw new AccountQueryError("ACCOUNT_DATA_INVALID", "客户账款稳定标识或更新时间异常", 503);
  }
  const amounts = accountAmounts(row);
  return {
    id,
    customerMasked: customerMasked(row),
    totalOrders: nonNegativeInteger(owns(row, "orderCount") ? row.orderCount : owns(row, "totalOrderCount") ? row.totalOrderCount : 0, "orderCount"),
    ...amounts,
    status: accountStatus(row, amounts),
    lastOrderAt: dateIso(row.lastOrderAt),
    lastPaymentAt: dateIso(row.lastPaymentAt),
    updatedAt
  };
}

function normalizeWebListQuery(query = {}) {
  const rawSearch = String(query.search === undefined || query.search === null ? "" : query.search).trim();
  if (rawSearch.length > MAX_SEARCH_LENGTH) {
    throw new AccountQueryError("ACCOUNT_QUERY_INVALID", "客户账款搜索内容过长", 400);
  }
  const status = cleanText(query.status, 40);
  if (status && !WEB_ACCOUNT_STATUSES.has(status)) {
    throw new AccountQueryError("ACCOUNT_QUERY_INVALID", "客户账款状态筛选无效", 400);
  }
  const parsedPageSize = query.pageSize === undefined || query.pageSize === null || query.pageSize === ""
    ? DEFAULT_PAGE_SIZE
    : Number.parseInt(query.pageSize, 10);
  if (!Number.isSafeInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > MAX_PAGE_SIZE) {
    throw new AccountQueryError("ACCOUNT_QUERY_INVALID", "客户账款分页大小无效", 400);
  }
  const cursor = String(query.cursor === undefined || query.cursor === null ? "" : query.cursor).trim();
  if (cursor.length > 4096) throw new AccountQueryError("ACCOUNT_CURSOR_INVALID", "客户账款分页游标无效", 400);
  return { status, search: rawSearch, pageSize: parsedPageSize, cursor };
}

function encodeCursor(row, normalized) {
  const updatedAt = dateIso(row.updatedAt);
  const id = cleanText(row._id || row.id, 128);
  if (!updatedAt || !id) return null;
  return Buffer.from(JSON.stringify({
    v: 1,
    updatedAt,
    id,
    status: normalized.status,
    search: normalized.search,
    pageSize: normalized.pageSize
  }), "utf8").toString("base64url");
}

function decodeCursor(value, normalized) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const updatedAt = dateIso(parsed.updatedAt);
    const id = cleanText(parsed.id, 128);
    if (parsed.v !== 1 || !updatedAt || !id || parsed.status !== normalized.status
      || parsed.search !== normalized.search || parsed.pageSize !== normalized.pageSize) throw new Error("invalid");
    return { updatedAt: new Date(updatedAt), id };
  } catch (error) {
    throw new AccountQueryError("ACCOUNT_CURSOR_INVALID", "客户账款分页游标无效或与筛选条件不一致", 400);
  }
}

function combine(command, conditions) {
  const usable = conditions.filter(Boolean);
  if (!usable.length) return null;
  return usable.length === 1 ? usable[0] : command.and(usable);
}

function cursorWhere(command, cursor) {
  if (!cursor) return null;
  return command.or([
    { updatedAt: command.lt(cursor.updatedAt) },
    command.and([{ updatedAt: cursor.updatedAt }, { _id: command.lt(cursor.id) }])
  ]);
}

function statusWhere(command, status) {
  if (!status) return null;
  if (status === "pending_confirm") return { pendingConfirmAmount: command.gt(0) };
  if (status === "abnormal") return { abnormalCount: command.gt(0) };
  if (status === "settled") return { isSettled: true };
  return command.or([
    { totalUnpaidAmount: command.gt(0) },
    command.and([{ totalUnpaidAmount: command.exists(false) }, { unpaidAmount: command.gt(0) }])
  ]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchWhere(db, command, search) {
  if (!search) return null;
  if (typeof db.RegExp !== "function") {
    throw new AccountQueryError("ACCOUNT_READ_FAILED", "客户账款读取失败，请稍后重试", 503);
  }
  const expression = db.RegExp({ regexp: escapeRegExp(search), options: "i" });
  return command.or([
    { nickname: expression },
    { customerName: expression },
    { phoneMasked: expression }
  ]);
}

function isMissingCollection(error) {
  const message = String((error && error.message) || error || "");
  return /collection not exists|database collection not exists|Db or Table not exist|DATABASE_COLLECTION_NOT_EXIST|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

function readFailure(error) {
  if (error instanceof AccountQueryError) return error;
  return new AccountQueryError("ACCOUNT_READ_FAILED", "客户账款读取失败，请稍后重试", 503);
}

function relationCondition(command, account) {
  const conditions = [];
  if (account.userId) conditions.push({ userId: account.userId });
  if (account.userOpenid) conditions.push({ userOpenid: account.userOpenid });
  if (!conditions.length) return null;
  return conditions.length === 1 ? conditions[0] : command.or(conditions);
}

function webOrderProjection(row) {
  return {
    id: cleanText(row._id || row.id, 128),
    orderNo: cleanText(row.orderNo, 120),
    status: cleanText(row.status, 60),
    paymentStatus: cleanText(row.paymentStatus, 60),
    totalAmountCents: nonNegativeInteger(owns(row, "totalAmount") ? row.totalAmount : 0, "order.totalAmount"),
    createdAt: dateIso(row.createdAt)
  };
}

function logAmount(row, fields, label, signed = false) {
  const field = fields.find((name) => owns(row, name));
  const value = field ? row[field] : 0;
  return signed ? signedInteger(value, label) : nonNegativeInteger(value, label);
}

function webLogProjection(row, orderMap = new Map()) {
  const relatedOrder = orderMap.get(cleanText(row.relatedOrderId || row.orderId || row.sourceId, 128));
  return {
    id: cleanText(row._id || row.id, 128),
    changeType: cleanText(row.changeType || row.action || row.type, 80),
    beforeReceivableCents: logAmount(row, ["beforeTotalOrderAmount", "beforeTotalReceivableAmount"], "log.beforeReceivable"),
    afterReceivableCents: logAmount(row, ["afterTotalOrderAmount", "afterTotalReceivableAmount"], "log.afterReceivable"),
    beforeReceivedCents: logAmount(row, ["beforeTotalPaidAmount", "beforePaidAmount"], "log.beforeReceived"),
    afterReceivedCents: logAmount(row, ["afterTotalPaidAmount", "afterPaidAmount"], "log.afterReceived"),
    beforeUnpaidCents: logAmount(row, ["beforeTotalUnpaidAmount", "beforeUnpaidAmount"], "log.beforeUnpaid"),
    afterUnpaidCents: logAmount(row, ["afterTotalUnpaidAmount", "afterUnpaidAmount"], "log.afterUnpaid"),
    changeAmountCents: logAmount(row, ["changeAmount", "amount"], "log.changeAmount", true),
    orderNo: cleanText(row.orderNo || (relatedOrder && relatedOrder.orderNo), 120),
    createdAt: dateIso(row.createdAt),
    summary: scrubPhones(row.summary || row.remark || row.description || row.changeType || "账款变更", 300)
  };
}

function canViewFullPhone(actor) {
  return explicitPermission(actor, "customer:view_phone_full");
}

function canViewMaskedPhone(actor) {
  return canViewFullPhone(actor) || explicitPermission(actor, "customer:view_phone_masked");
}

function canSearchByPhone(actor) {
  return canViewFullPhone(actor) && explicitPermission(actor, "customer:search_by_phone");
}

function legacyAccountProjection(row, actor) {
  const fullPhone = cleanText(row.phoneNumber || row.phone, 40);
  const masked = maskPhone(row.phoneMasked || fullPhone);
  const projected = {
    _id: cleanText(row._id || row.id, 128),
    userId: cleanText(row.userId, 128),
    userOpenid: cleanText(row.userOpenid, 128),
    nickname: cleanText(row.nickname || row.customerName || row.name, 80),
    phoneMasked: canViewMaskedPhone(actor) ? masked : "",
    phoneDisplay: canViewFullPhone(actor) ? (fullPhone || masked) : canViewMaskedPhone(actor) ? masked : "",
    phoneVerified: Boolean(row.phoneVerified),
    phoneBindMethod: cleanText(row.phoneBindMethod, 60),
    phoneBoundAt: row.phoneBoundAt || null,
    phoneUpdatedAt: row.phoneUpdatedAt || null,
    orderCount: legacyNumber(row.orderCount !== undefined ? row.orderCount : row.totalOrderCount),
    lastOrderAt: row.lastOrderAt || null,
    todayOrderAmount: legacyNumber(row.todayOrderAmount),
    pendingConfirmAmount: legacyNumber(row.pendingConfirmAmount),
    abnormalCount: legacyNumber(row.abnormalCount),
    abnormalAmount: legacyNumber(row.abnormalAmount),
    isSettled: Boolean(row.isSettled),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
  if (canViewFullPhone(actor)) projected.phoneNumber = fullPhone;
  if (explicitPermission(actor, "customer:view_account")) {
    projected.totalOrderAmount = legacyNumber(row.totalOrderAmount !== undefined ? row.totalOrderAmount : row.totalReceivableAmount);
    projected.totalPaidAmount = legacyNumber(row.totalPaidAmount !== undefined ? row.totalPaidAmount : row.paidAmount);
    projected.totalUnpaidAmount = legacyNumber(row.totalUnpaidAmount !== undefined ? row.totalUnpaidAmount : row.unpaidAmount);
    projected.historyUnpaidAmount = legacyNumber(row.historyUnpaidAmount);
    projected.payableAmount = legacyNumber(row.payableAmount);
    projected.lastPaymentAt = row.lastPaymentAt || null;
  }
  if (explicitPermission(actor, "customer:edit_remark")) {
    projected.adminRemark = scrubPhones(row.adminRemark, 500);
    projected.adminNote = scrubPhones(row.adminNote, 500);
    projected.adminTags = Array.isArray(row.adminTags) ? row.adminTags.map((tag) => cleanText(tag, 80)).filter(Boolean) : [];
    projected.riskLevel = row.riskLevel === "watch" ? "important" : row.riskLevel === "risky" ? "risk" : cleanText(row.riskLevel || "normal", 40);
  }
  return projected;
}

function legacyOrderProjection(row) {
  return {
    _id: cleanText(row._id || row.id, 128),
    orderId: cleanText(row._id || row.orderId || row.id, 128),
    orderNo: cleanText(row.orderNo, 120),
    totalAmount: legacyNumber(row.totalAmount),
    paidAmount: legacyNumber(row.paidAmount),
    unpaidAmount: legacyNumber(row.unpaidAmount),
    status: cleanText(row.status, 60),
    paymentStatus: cleanText(row.paymentStatus, 60),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function legacyPaymentProjection(row) {
  return {
    _id: cleanText(row._id || row.id, 128),
    orderId: cleanText(row.orderId, 128),
    orderNo: cleanText(row.orderNo, 120),
    orderAmount: legacyNumber(row.orderAmount),
    paidAmount: legacyNumber(row.paidAmount !== undefined ? row.paidAmount : row.amount),
    unpaidAmount: legacyNumber(row.unpaidAmount),
    paymentMethod: cleanText(row.paymentMethod, 80),
    confirmStatus: cleanText(row.confirmStatus || row.paymentStatus || row.status, 60),
    remark: scrubPhones(row.remark, 300),
    confirmedAt: row.confirmedAt || null,
    createdAt: row.createdAt || null
  };
}

function legacyLogProjection(row) {
  return {
    _id: cleanText(row._id || row.id, 128),
    changeType: cleanText(row.changeType || row.action || row.type, 80),
    changeAmount: legacyNumber(row.changeAmount !== undefined ? row.changeAmount : row.amount),
    orderId: cleanText(row.orderId, 128),
    orderNo: cleanText(row.orderNo, 120),
    remark: scrubPhones(row.remark || row.summary, 300),
    createdAt: row.createdAt || null
  };
}

function legacyFilter(row, filter) {
  const unpaid = legacyNumber(row.totalUnpaidAmount !== undefined ? row.totalUnpaidAmount : row.unpaidAmount);
  if (filter === "unpaid") return unpaid > 0;
  if (filter === "today") return legacyNumber(row.todayOrderAmount) > 0;
  if (filter === "pending") return legacyNumber(row.pendingConfirmAmount) > 0;
  if (filter === "abnormal") return legacyNumber(row.abnormalCount) > 0;
  if (filter === "risk") return ["watch", "important", "risky", "risk", "blocked", "slow_pay"].includes(row.riskLevel);
  if (filter === "settled") return Boolean(row.isSettled);
  return true;
}

function legacyKeyword(row, keyword, actor) {
  if (!keyword) return true;
  const text = [
    row.nickname,
    canSearchByPhone(actor) ? (row.phoneNumber || row.phoneMasked || row.phone) : "",
    row.userOpenid,
    row.userId,
    row.adminRemark,
    row.adminNote,
    ...(Array.isArray(row.adminTags) ? row.adminTags : [])
  ].map((value) => cleanText(value, 1000)).filter(Boolean).join(" ").toLowerCase();
  return text.includes(keyword);
}

function sortLegacy(rows, sortBy) {
  const sorted = rows.slice();
  const time = (row, field) => {
    const date = new Date(row[field] || 0);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
  };
  if (sortBy === "today") sorted.sort((a, b) => legacyNumber(b.todayOrderAmount) - legacyNumber(a.todayOrderAmount));
  else if (sortBy === "lastOrder") sorted.sort((a, b) => time(b, "lastOrderAt") - time(a, "lastOrderAt"));
  else if (sortBy === "lastPayment") sorted.sort((a, b) => time(b, "lastPaymentAt") - time(a, "lastPaymentAt"));
  else if (sortBy === "abnormal") sorted.sort((a, b) => legacyNumber(b.abnormalCount) - legacyNumber(a.abnormalCount));
  else sorted.sort((a, b) => legacyNumber(b.totalUnpaidAmount !== undefined ? b.totalUnpaidAmount : b.unpaidAmount)
    - legacyNumber(a.totalUnpaidAmount !== undefined ? a.totalUnpaidAmount : a.unpaidAmount));
  return sorted;
}

function createAccountQueryService({ db, command }) {
  if (!db || !command) throw new Error("account query service requires db and command");

  async function supplementWebAccounts(rows) {
    const candidates = rows.filter((row) => !(row.nickname || row.customerName || row.name)
      || !(row.phoneMasked || row.phoneNumber || row.phone || row.customerPhoneMasked));
    if (!candidates.length) return rows;
    const userIds = Array.from(new Set(candidates.map((row) => cleanText(row.userId, 128)).filter(Boolean)));
    const openids = Array.from(new Set(candidates.map((row) => cleanText(row.userOpenid, 128)).filter(Boolean)));
    async function optionalUsers(field, values) {
      if (!values.length) return [];
      try {
        const response = await db.collection("users").where({ [field]: command.in(values) }).limit(MAX_PAGE_SIZE).get();
        return Array.isArray(response.data) ? response.data : [];
      } catch (error) {
        return [];
      }
    }
    const [byIdRows, byOpenidRows] = await Promise.all([
      optionalUsers("_id", userIds),
      optionalUsers("openid", openids)
    ]);
    const byId = new Map(byIdRows.map((user) => [cleanText(user._id || user.id, 128), user]));
    const byOpenid = new Map(byOpenidRows.map((user) => [cleanText(user.openid, 128), user]));
    return rows.map((row) => {
      const user = byId.get(cleanText(row.userId, 128)) || byOpenid.get(cleanText(row.userOpenid, 128));
      if (!user) return row;
      return {
        ...row,
        nickname: row.nickname || row.customerName || row.name || user.nickname || user.name || "",
        phoneMasked: row.phoneMasked || row.phoneNumber || row.phone || row.customerPhoneMasked
          || user.phoneMasked || user.phoneNumber || user.phone || ""
      };
    });
  }

  async function listWebAccounts({ actor, query = {} } = {}) {
    assertWebAccess(actor);
    const normalized = normalizeWebListQuery(query);
    const cursor = decodeCursor(normalized.cursor, normalized);
    try {
      const where = combine(command, [
        statusWhere(command, normalized.status),
        searchWhere(db, command, normalized.search),
        cursorWhere(command, cursor)
      ]);
      let request = db.collection("customer_accounts");
      if (where) request = request.where(where);
      const response = await request.orderBy("updatedAt", "desc").orderBy("_id", "desc").limit(normalized.pageSize + 1).get();
      const rows = Array.isArray(response.data) ? response.data : [];
      const hasMore = rows.length > normalized.pageSize;
      const pageRows = rows.slice(0, normalized.pageSize);
      const supplementedRows = await supplementWebAccounts(pageRows);
      return {
        items: supplementedRows.map(webAccountProjection),
        pageSize: normalized.pageSize,
        hasMore,
        nextCursor: hasMore && pageRows.length ? encodeCursor(pageRows[pageRows.length - 1], normalized) : null
      };
    } catch (error) {
      throw readFailure(error);
    }
  }

  async function getWebAccount({ actor, id } = {}) {
    assertWebAccess(actor);
    const accountId = cleanText(id, 128);
    if (!accountId) throw new AccountQueryError("ACCOUNT_QUERY_INVALID", "缺少客户账款 ID", 400);
    let account;
    try {
      account = (await db.collection("customer_accounts").doc(accountId).get()).data;
    } catch (error) {
      throw readFailure(error);
    }
    if (!account) throw new AccountQueryError("ACCOUNT_NOT_FOUND", "客户账款不存在", 404);

    const condition = relationCondition(command, account);
    async function readRelated(collectionName, limit, warning) {
      if (!condition) return { rows: [], warning: null };
      try {
        const response = await db.collection(collectionName).where(condition)
          .orderBy("createdAt", "desc").orderBy("_id", "desc").limit(limit).get();
        return { rows: Array.isArray(response.data) ? response.data : [], warning: null };
      } catch (error) {
        return { rows: [], warning };
      }
    }
    const [orderResult, logResult] = await Promise.all([
      readRelated("orders", 51, "关联订单暂不可用"),
      readRelated("account_logs", 101, "账款流水暂不可用")
    ]);
    const orderRows = orderResult.rows;
    const logRows = logResult.rows;
    const warnings = [orderResult.warning, logResult.warning].filter(Boolean);
    try {
      const orderMap = new Map(orderRows.map((row) => [cleanText(row._id || row.id, 128), row]));
      const [supplementedAccount] = await supplementWebAccounts([account]);
      return {
        account: webAccountProjection(supplementedAccount),
        orders: orderRows.slice(0, 50).map(webOrderProjection),
        logs: logRows.slice(0, 100).map((row) => webLogProjection(row, orderMap)),
        ordersHasMore: orderRows.length > 50,
        logsHasMore: logRows.length > 100,
        relatedDataStatus: warnings.length ? "partial" : "complete",
        warnings
      };
    } catch (error) {
      throw readFailure(error);
    }
  }

  async function findUser(row) {
    if (row.userId) {
      try {
        const user = (await db.collection("users").doc(row.userId).get()).data;
        if (user) return user;
      } catch (error) {
        // Preserve the legacy fallback: a missing/stale userId may still resolve by userOpenid.
      }
    }
    if (row.userOpenid) {
      try {
        const response = await db.collection("users").where({ openid: row.userOpenid }).limit(1).get();
        return Array.isArray(response.data) ? response.data[0] || null : null;
      } catch (error) {
        if (!isMissingCollection(error)) throw error;
      }
    }
    return null;
  }

  async function enrichLegacyAccount(row) {
    const user = await findUser(row);
    if (!user) return row;
    return {
      ...row,
      nickname: row.nickname || user.nickname || user.name || "",
      phoneNumber: user.phoneNumber || user.phone || row.phoneNumber || row.phone || "",
      phoneMasked: user.phoneMasked || row.phoneMasked || "",
      phoneVerified: Boolean(user.phoneVerified),
      phoneBindMethod: user.phoneBindMethod || "",
      phoneBoundAt: user.phoneBoundAt || null,
      phoneUpdatedAt: user.phoneUpdatedAt || null
    };
  }

  async function listLegacyAccounts({ actor, query = {} } = {}) {
    assertLegacyAccess(actor, "customer:view_basic");
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.parseInt(query.pageSize || query.limit, 10) || 100));
    const filter = cleanText(query.filter || "all", 40);
    const sortBy = cleanText(query.sortBy || "unpaid", 40);
    const keyword = cleanText(query.keyword, 200).toLowerCase();
    try {
      const response = await db.collection("customer_accounts").orderBy("updatedAt", "desc").limit(LEGACY_MAX_ROWS).get();
      const source = Array.isArray(response.data) ? response.data : [];
      let matched;
      if (keyword) {
        const enriched = [];
        for (const row of source) enriched.push(await enrichLegacyAccount(row));
        matched = sortLegacy(enriched.filter((row) => legacyFilter(row, filter) && legacyKeyword(row, keyword, actor)), sortBy);
      } else {
        matched = sortLegacy(source.filter((row) => legacyFilter(row, filter)), sortBy);
      }
      const start = (page - 1) * pageSize;
      const pageRows = matched.slice(start, start + pageSize);
      const enrichedPage = [];
      for (const row of pageRows) enrichedPage.push(keyword ? row : await enrichLegacyAccount(row));
      return {
        accounts: enrichedPage.map((row) => legacyAccountProjection(row, actor)),
        page,
        pageSize,
        hasMore: start + pageSize < matched.length,
        total: matched.length
      };
    } catch (error) {
      throw readFailure(error);
    }
  }

  async function findLegacyAccount(selector) {
    if (selector.accountId) return (await db.collection("customer_accounts").doc(cleanText(selector.accountId, 128)).get()).data;
    if (selector.userId) {
      const response = await db.collection("customer_accounts").where({ userId: cleanText(selector.userId, 128) }).limit(1).get();
      return Array.isArray(response.data) ? response.data[0] || null : null;
    }
    if (selector.userOpenid) {
      const response = await db.collection("customer_accounts").where({ userOpenid: cleanText(selector.userOpenid, 128) }).limit(1).get();
      return Array.isArray(response.data) ? response.data[0] || null : null;
    }
    return null;
  }

  async function readLegacyRows(collectionName, account) {
    const condition = relationCondition(command, account);
    if (!condition) return [];
    try {
      const response = await db.collection(collectionName).where(condition).orderBy("createdAt", "desc").limit(200).get();
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      if (isMissingCollection(error)) return [];
      throw error;
    }
  }

  async function getLegacyAccountDetail({ actor, selector = {} } = {}) {
    assertLegacyAccess(actor, "customer:view_account");
    try {
      const account = await findLegacyAccount(selector);
      if (!account) throw new AccountQueryError("ACCOUNT_NOT_FOUND", "客户账款不存在", 404);
      const [enriched, orders, paymentRecords, accountLogs] = await Promise.all([
        enrichLegacyAccount(account),
        readLegacyRows("orders", account),
        readLegacyRows("payment_records", account),
        readLegacyRows("account_logs", account)
      ]);
      return {
        account: legacyAccountProjection(enriched, actor),
        orders: orders.map(legacyOrderProjection),
        paymentRecords: paymentRecords.map(legacyPaymentProjection),
        accountLogs: accountLogs.map(legacyLogProjection)
      };
    } catch (error) {
      throw readFailure(error);
    }
  }

  return { listWebAccounts, getWebAccount, listLegacyAccounts, getLegacyAccountDetail };
}

module.exports = {
  AccountQueryError,
  WEB_ACCOUNT_STATUSES,
  createAccountQueryService
};
