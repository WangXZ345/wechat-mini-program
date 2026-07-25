const crypto = require("crypto");

const CURSOR_VERSION = 3;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const INITIAL_LOOKBACK_MS = 2 * 60 * 1000;
const SAFE_CHANGED_FIELDS = new Set([
  "name",
  "price",
  "isActive",
  "status",
  "paymentStatus",
  "deliveryStatus",
  "shippingStatus",
  "afterSaleStatus",
  "refundStatus",
  "warningStock",
  "stockStatus",
  "updatedAt",
  "version",
  "dataVersion"
]);

const SOURCE_DEFINITIONS = Object.freeze({
  products: { collection: "products", timeField: "updatedAt", entityType: "product", eventType: "product.updated" },
  inventory: { collection: "inventory_logs", timeField: "createdAt", entityType: "inventory", eventType: "inventory.changed", entityIdField: "productId" },
  orders: { collection: "orders", timeField: "updatedAt", entityType: "order", eventType: "order.status_changed", ownerFields: ["userOpenid", "openid"] },
  payments: { collection: "payment_records", timeField: "updatedAt", entityType: "payment", eventType: "payment.updated", entityIdField: "orderId", ownerFields: ["userOpenid", "openid"] },
  shipments: { collection: "shipment_groups", timeField: "updatedAt", entityType: "shipment", eventType: "shipment.updated", ownerFields: ["openid", "userOpenid"] },
  after_sales: { collection: "after_sales", timeField: "updatedAt", entityType: "after_sale", eventType: "after_sale.status_changed", ownerFields: ["openid", "userOpenid"] },
  refunds: { collection: "refund_records", timeField: "updatedAt", entityType: "refund", eventType: "refund.status_changed", ownerFields: ["openid", "userOpenid"] },
  accounts: { collection: "customer_accounts", timeField: "updatedAt", entityType: "account", eventType: "account.changed" }
});

const TOPIC_ALIASES = Object.freeze({
  product: "product",
  products: "product",
  inventory: "inventory",
  order: "order",
  orders: "order",
  payment: "payment",
  payments: "payment",
  shipment: "shipment",
  shipments: "shipment",
  "after-sale": "after_sale",
  "after-sales": "after_sale",
  after_sale: "after_sale",
  refund: "refund",
  refunds: "refund",
  account: "account",
  accounts: "account",
  system: "system"
});

const ADMIN_ENTITY_SCOPES = Object.freeze({
  procurement: ["product", "inventory"],
  customer_service: ["order", "shipment", "after_sale"],
  finance: ["order", "payment", "shipment", "after_sale", "refund", "account"]
});

function cleanString(value, max = 160) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function stableEventId(prefix, value, timestamp) {
  const digest = crypto.createHash("sha256")
    .update(`${cleanString(prefix, 40)}:${cleanString(value, 256)}:${Math.max(0, Number(timestamp || 0))}`)
    .digest("hex")
    .slice(0, 32);
  return `${cleanString(prefix, 40)}:${digest}`;
}

function ownerKeyFor(value, secret) {
  const subject = cleanString(value, 256);
  const pepper = cleanString(secret, 4096);
  if (!subject || pepper.length < 32) return "";
  return crypto.createHmac("sha256", pepper).update(`sync-owner:${subject}`).digest("hex");
}

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value === "object" && Number.isFinite(Number(value.$date))) return Number(value.$date);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function normalizeMark(value, fallbackMs = 0) {
  if (Array.isArray(value)) {
    return { ms: Math.max(0, Number(value[0] || fallbackMs)), id: cleanString(value[1], 128) };
  }
  if (value && typeof value === "object") {
    return { ms: Math.max(0, Number(value.ms || fallbackMs)), id: cleanString(value.id, 128) };
  }
  return { ms: Math.max(0, Number(fallbackMs || 0)), id: "" };
}

function compareMarks(left, right) {
  const a = normalizeMark(left);
  const b = normalizeMark(right);
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  return a.id === b.id ? 0 : (a.id < b.id ? -1 : 1);
}

function maxMark(left, right) {
  return compareMarks(left, right) >= 0 ? normalizeMark(left) : normalizeMark(right);
}

function markForRow(row, timeField) {
  return normalizeMark([toMillis(row && row[timeField]), row && (row._id || row.id)]);
}

function cursorKey(secret) {
  const value = String(secret || "");
  if (value.length < 32) {
    const error = new Error("Sync cursor encryption secret is not configured");
    error.code = "SYNC_CURSOR_CONFIG_REQUIRED";
    throw error;
  }
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function encodeSyncCursor(state = {}, options = {}) {
  const compactMarks = {};
  Object.keys(state.marks || {}).sort().forEach((key) => {
    const mark = normalizeMark(state.marks[key]);
    compactMarks[key] = [mark.ms, mark.id];
  });
  const key = cursorKey(options.secret || options.cursorSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ v: CURSOR_VERSION, m: compactMarks }), "utf8"),
    cipher.final()
  ]);
  return `v${CURSOR_VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

function decodeSyncCursor(cursor, options = {}) {
  const initialMs = Math.max(0, Number(options.initialMs || 0));
  if (!cursor) return { version: CURSOR_VERSION, marks: {}, initialMs };
  try {
    const [prefix, encoded] = cleanString(cursor, 8192).split(".");
    if (prefix !== `v${CURSOR_VERSION}` || !encoded) throw new Error("Invalid sync cursor prefix");
    const packed = Buffer.from(encoded, "base64url");
    if (packed.length < 29) throw new Error("Invalid sync cursor payload");
    const decipher = crypto.createDecipheriv("aes-256-gcm", cursorKey(options.secret || options.cursorSecret), packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    const decrypted = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(decrypted);
    if (Number(parsed.v) !== CURSOR_VERSION || !parsed.m || typeof parsed.m !== "object") {
      const error = new Error("Invalid sync cursor version");
      error.code = "INVALID_SYNC_CURSOR";
      throw error;
    }
    const marks = {};
    Object.keys(parsed.m).slice(0, 32).forEach((key) => {
      marks[cleanString(key, 40)] = normalizeMark(parsed.m[key], initialMs);
    });
    return { version: CURSOR_VERSION, marks, initialMs };
  } catch (err) {
    if (err && err.code === "SYNC_CURSOR_CONFIG_REQUIRED") throw err;
    if (err && err.code === "INVALID_SYNC_CURSOR") throw err;
    const error = new Error("Invalid sync cursor");
    error.code = "INVALID_SYNC_CURSOR";
    throw error;
  }
}

function normalizeTopics(value) {
  const values = Array.isArray(value) ? value : cleanString(value, 1000).split(",");
  return Array.from(new Set(values
    .map((item) => TOPIC_ALIASES[cleanString(item, 40).toLowerCase()])
    .filter(Boolean)));
}

function permissionList(principal) {
  return Array.isArray(principal && principal.permissions) ? principal.permissions : [];
}

function hasPermission(principal, permission) {
  return Boolean(principal && (principal.role === "super_admin"
    || permissionList(principal).includes("*")
    || permissionList(principal).includes(permission)));
}

function allowedEntityTypes(principal = {}) {
  if (principal.kind === "user") {
    return ["system", "product", "order", "payment", "shipment", "after_sale", "refund"];
  }
  if (principal.role === "super_admin") {
    return ["system", "product", "inventory", "order", "payment", "shipment", "after_sale", "refund", "account"];
  }
  const allowed = new Set(["system"]);
  const roleScope = new Set(ADMIN_ENTITY_SCOPES[principal.role] || []);
  if (roleScope.has("product") && hasPermission(principal, "product:view")) allowed.add("product");
  if (roleScope.has("inventory") && hasPermission(principal, "inventory:view")) allowed.add("inventory");
  if (roleScope.has("order") && hasPermission(principal, "order:view")) allowed.add("order");
  if (roleScope.has("payment") && hasPermission(principal, "payment:view_screenshot")) allowed.add("payment");
  if (roleScope.has("shipment") && hasPermission(principal, "shipment:view")) allowed.add("shipment");
  if (roleScope.has("after_sale") && hasPermission(principal, "after_sale:view")) allowed.add("after_sale");
  if (roleScope.has("refund") && hasPermission(principal, "refund:view")) allowed.add("refund");
  if (roleScope.has("account") && hasPermission(principal, "customer:view_account")) allowed.add("account");
  return Array.from(allowed);
}

function selectedEntityTypes(principal, topics) {
  const allowed = new Set(allowedEntityTypes(principal));
  const requested = normalizeTopics(topics);
  if (!requested.length) return Array.from(allowed);
  return requested.filter((topic) => allowed.has(topic));
}

function safeChangedFields(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((field) => cleanString(field, 80))
    .filter((field) => SAFE_CHANGED_FIELDS.has(field))))
    .slice(0, 20);
}

function sourceClient(value, fallback) {
  const normalized = cleanString(value, 30);
  return ["miniprogram", "admin_web", "mock", "system"].includes(normalized) ? normalized : fallback;
}

function safeActorType(value) {
  const normalized = cleanString(value, 30);
  return ["admin", "user", "system"].includes(normalized) ? normalized : "";
}

function eventOwnerMatches(row, principal) {
  if (!principal || principal.kind !== "user") return true;
  const ownerKey = cleanString(principal.ownerKey, 128);
  return Boolean(ownerKey && cleanString(row && row.ownerKey, 128) === ownerKey);
}

function storedEventVisible(row, principal, allowedTypes) {
  const entityType = cleanString(row && row.entityType, 40);
  if (!allowedTypes.has(entityType)) return false;
  if (principal && principal.role === "procurement" && ["payment", "refund", "account"].includes(entityType)) return false;
  if (!principal || principal.kind !== "user") {
    const roles = Array.isArray(row && row.audienceRoles) ? row.audienceRoles.map((role) => cleanString(role, 50)) : [];
    return !roles.length || roles.includes("*") || roles.includes(principal.role);
  }
  if (["system", "product"].includes(entityType) && (row.isPublic === true || row.audience === "public")) return true;
  return eventOwnerMatches(row || {}, principal);
}

function sanitizeStoredEvent(row, fallbackClient) {
  const mark = markForRow(row, "createdAt");
  const actorType = safeActorType(row && row.actorType);
  return {
    eventId: cleanString(row.eventId, 128) || stableEventId("stored", row._id || row.id, mark.ms),
    eventType: cleanString(row.eventType, 100),
    entityType: cleanString(row.entityType, 40),
    entityId: cleanString(row.entityId, 128),
    action: cleanString(row.action || "invalidate", 60),
    version: Math.max(0, Number(row.version || 0)),
    changedFields: safeChangedFields(row.changedFields),
    ...(actorType ? { actorType } : {}),
    sourceClient: sourceClient(row.sourceClient, fallbackClient),
    createdAt: mark.ms ? new Date(mark.ms).toISOString() : null,
    fallback: false,
    _mark: mark,
    _source: "sync_events"
  };
}

function fallbackEntityId(definition, row) {
  const field = definition.entityIdField;
  return cleanString(field && row[field] || row._id || row.id, 128);
}

function deriveFallbackEvent(sourceName, row, fallbackClient) {
  const definition = SOURCE_DEFINITIONS[sourceName];
  if (!definition) return null;
  const mark = markForRow(row, definition.timeField);
  const documentId = cleanString(row._id || row.id, 128);
  if (!mark.ms || !documentId) return null;
  const eventId = stableEventId(`fallback-${sourceName}`, documentId, mark.ms);
  return {
    eventId,
    eventType: definition.eventType,
    entityType: definition.entityType,
    entityId: fallbackEntityId(definition, row),
    action: "invalidate",
    version: Math.max(0, Number(row.version || row.dataVersion || mark.ms)),
    changedFields: [],
    sourceClient: fallbackClient,
    createdAt: new Date(mark.ms).toISOString(),
    fallback: true,
    _mark: mark,
    _source: sourceName
  };
}

function mergeAndDedupeEvents(events, limit) {
  const byId = new Map();
  (events || []).filter(Boolean).forEach((event) => {
    if (!event.eventId || !event._mark) return;
    const existing = byId.get(event.eventId);
    if (!existing || compareMarks(event._mark, existing._mark) > 0) byId.set(event.eventId, event);
  });
  return Array.from(byId.values())
    .sort((left, right) => compareMarks(left._mark, right._mark) || left.eventId.localeCompare(right.eventId))
    .slice(0, limit);
}

function pageRowsByCompositeMark(rows, timeField, afterMark, limit) {
  const mark = normalizeMark(afterMark);
  const ordered = (rows || [])
    .filter((row) => compareMarks(markForRow(row, timeField), mark) > 0)
    .sort((left, right) => compareMarks(markForRow(left, timeField), markForRow(right, timeField)));
  const pageSize = Math.max(1, Number(limit || DEFAULT_LIMIT));
  return { rows: ordered.slice(0, pageSize), hasMore: ordered.length > pageSize };
}

function combineWhere(command, conditions) {
  const filtered = conditions.filter(Boolean);
  if (!filtered.length) return null;
  return filtered.length === 1 ? filtered[0] : command.and(filtered);
}

function ownerWhere(command, definition, principal) {
  if (!principal || principal.kind !== "user" || !definition.ownerFields) return null;
  const openid = cleanString(principal.openid, 128);
  if (!openid) return { _id: "__no_owner__" };
  return command.or(definition.ownerFields.map((field) => ({ [field]: openid })));
}

async function queryRowsAfterMark({ db, command, definition, mark, principal, limit }) {
  const queryLimit = limit + 1;
  const time = new Date(mark.ms);
  const owner = ownerWhere(command, definition, principal);
  const sameTimeWhere = combineWhere(command, [
    owner,
    { [definition.timeField]: command.eq(time) },
    mark.id ? { _id: command.gt(mark.id) } : null
  ]);
  const laterWhere = combineWhere(command, [owner, { [definition.timeField]: command.gt(time) }]);
  const collection = db.collection(definition.collection);
  const sameTimeQuery = sameTimeWhere
    ? collection.where(sameTimeWhere).orderBy("_id", "asc").limit(queryLimit).get()
    : Promise.resolve({ data: [] });
  const laterQuery = collection.where(laterWhere)
    .orderBy(definition.timeField, "asc")
    .orderBy("_id", "asc")
    .limit(queryLimit)
    .get();
  const [sameTime, later] = await Promise.all([sameTimeQuery, laterQuery]);
  const rows = [];
  const seen = new Set();
  [...(sameTime.data || []), ...(later.data || [])].forEach((row) => {
    const id = cleanString(row && row._id, 128);
    if (!id || seen.has(id)) return;
    seen.add(id);
    rows.push(row);
  });
  const sorted = rows.sort((left, right) => compareMarks(
    markForRow(left, definition.timeField),
    markForRow(right, definition.timeField)
  ));
  return {
    rows: sorted.slice(0, limit),
    hasMore: sorted.length > limit
      || (sameTime.data || []).length > limit
      || (later.data || []).length > limit
  };
}

function missingCollection(err) {
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(String(err && err.message || err || ""));
}

async function readSource(options) {
  const { sourceName, definition, state, nowMs } = options;
  const mark = normalizeMark(state.marks[sourceName], state.initialMs || nowMs - INITIAL_LOOKBACK_MS);
  try {
    const page = await queryRowsAfterMark({ ...options, definition, mark });
    const rows = page.rows;
    const events = rows.map((row) => deriveFallbackEvent(sourceName, row, options.fallbackClient)).filter(Boolean);
    return {
      sourceName,
      events,
      mark: events.reduce((current, event) => maxMark(current, event._mark), mark),
      sourceHasMore: page.hasMore
    };
  } catch (err) {
    if (missingCollection(err)) return { sourceName, events: [], mark, sourceHasMore: false };
    throw err;
  }
}

async function readStoredEvents(options) {
  const { state, nowMs, principal, entityTypes, limit, fallbackClient } = options;
  const mark = normalizeMark(state.marks.sync_events, state.initialMs || nowMs - INITIAL_LOOKBACK_MS);
  const definition = { collection: "sync_events", timeField: "createdAt" };
  try {
    const page = await queryRowsAfterMark({ ...options, definition, mark, principal: null, limit });
    const rows = page.rows;
    const allowed = new Set(entityTypes);
    const events = rows
      .filter((row) => storedEventVisible(row, principal, allowed))
      .map((row) => sanitizeStoredEvent(row, fallbackClient));
    const scannedMark = rows.reduce((current, row) => maxMark(current, markForRow(row, "createdAt")), mark);
    return { sourceName: "sync_events", events, mark: scannedMark, sourceHasMore: page.hasMore };
  } catch (err) {
    if (missingCollection(err)) return { sourceName: "sync_events", events: [], mark, sourceHasMore: false };
    throw err;
  }
}

function sourceNamesForEntityTypes(entityTypes) {
  const allowed = new Set(entityTypes);
  return Object.keys(SOURCE_DEFINITIONS).filter((name) => allowed.has(SOURCE_DEFINITIONS[name].entityType));
}

function publicEvent(event) {
  const { _mark, _source, ...safe } = event;
  return safe;
}

async function readSyncBatch(options = {}) {
  const nowMs = Math.max(0, Number(options.nowMs || Date.now()));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(options.limit || DEFAULT_LIMIT)));
  const cursorSecret = options.cursorSecret;
  cursorKey(cursorSecret);
  const state = decodeSyncCursor(options.cursor, { initialMs: nowMs - INITIAL_LOOKBACK_MS, secret: cursorSecret });
  const entityTypes = selectedEntityTypes(options.principal || {}, options.topics);
  const storedEntityTypes = allowedEntityTypes(options.principal || {});
  const fallbackClient = options.fallbackClient === "admin_web" ? "admin_web" : "miniprogram";
  const common = {
    db: options.db,
    command: options.command,
    principal: options.principal || {},
    state,
    nowMs,
    limit,
    fallbackClient
  };
  // Outbox events are always drained for every authorized type so changing the
  // active page topics cannot advance a shared cursor past an unseen event.
  const reads = [readStoredEvents({ ...common, entityTypes: storedEntityTypes })];
  sourceNamesForEntityTypes(entityTypes).forEach((sourceName) => {
    reads.push(readSource({ ...common, sourceName, definition: SOURCE_DEFINITIONS[sourceName] }));
  });
  const results = await Promise.all(reads);
  const nextMarks = { ...state.marks };
  const allEvents = [];
  results.forEach((result) => {
    nextMarks[result.sourceName] = normalizeMark(result.mark);
    allEvents.push(...result.events);
  });
  const selected = mergeAndDedupeEvents(allEvents, limit);
  const selectedIds = new Set(selected.map((event) => `${event._source}:${event.eventId}`));
  let hasMore = allEvents.length > selected.length || results.some((result) => result.sourceHasMore);
  if (hasMore) {
    results.forEach((result) => {
      const emitted = result.events.filter((event) => selectedIds.has(`${event._source}:${event.eventId}`));
      const previous = normalizeMark(state.marks[result.sourceName], state.initialMs);
      if (emitted.length) {
        nextMarks[result.sourceName] = emitted.reduce((current, event) => maxMark(current, event._mark), previous);
      } else if (!result.events.length) {
        nextMarks[result.sourceName] = normalizeMark(result.mark);
      } else {
        nextMarks[result.sourceName] = previous;
      }
    });
  }
  return {
    events: selected.map(publicEvent),
    nextCursor: encodeSyncCursor({ marks: nextMarks }, { secret: cursorSecret }),
    highWatermark: encodeSyncCursor({ marks: nextMarks }, { secret: cursorSecret }),
    hasMore,
    serverTime: new Date(nowMs).toISOString(),
    mode: "outbox_with_collection_fallback",
    fallbackActive: sourceNamesForEntityTypes(entityTypes).length > 0,
    entityTypes
  };
}

module.exports = {
  CURSOR_VERSION,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  INITIAL_LOOKBACK_MS,
  SOURCE_DEFINITIONS,
  ADMIN_ENTITY_SCOPES,
  cleanString,
  stableEventId,
  ownerKeyFor,
  toMillis,
  normalizeMark,
  compareMarks,
  maxMark,
  markForRow,
  cursorKey,
  encodeSyncCursor,
  decodeSyncCursor,
  normalizeTopics,
  allowedEntityTypes,
  selectedEntityTypes,
  safeChangedFields,
  sanitizeStoredEvent,
  storedEventVisible,
  deriveFallbackEvent,
  mergeAndDedupeEvents,
  pageRowsByCompositeMark,
  readSyncBatch
};
