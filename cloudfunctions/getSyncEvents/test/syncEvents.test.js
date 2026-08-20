const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ownerKeyFor,
  encodeSyncCursor,
  decodeSyncCursor,
  pageRowsByCompositeMark,
  markForRow,
  deriveFallbackEvent,
  sanitizeStoredEvent,
  storedEventVisible,
  safeChangedFields,
  stableEventId,
  selectedEntityTypes,
  mergeAndDedupeEvents
} = require("../common/syncEvents");

const CURSOR_SECRET = "test-sync-cursor-secret-with-at-least-32-characters";

test("opaque ownerKey gates private outbox events", () => {
  const pepper = "test-pepper-with-at-least-thirty-two-characters";
  const ownerKey = ownerKeyFor("openid-user-a", pepper);
  assert.equal(ownerKey.length, 64);
  assert.notEqual(ownerKey, ownerKeyFor("openid-user-b", pepper));

  const principal = { kind: "user", ownerKey };
  const allowed = new Set(["order"]);
  assert.equal(storedEventVisible({ entityType: "order", ownerKey }, principal, allowed), true);
  assert.equal(storedEventVisible({ entityType: "order", ownerKey: ownerKeyFor("openid-user-b", pepper) }, principal, allowed), false);
  assert.equal(storedEventVisible({ entityType: "order", openid: "openid-user-a" }, principal, allowed), false);
});

test("composite mark drains more than one page created in the same millisecond", () => {
  const timestamp = new Date("2026-07-11T01:02:03.456Z");
  const rows = Array.from({ length: 250 }, (_, index) => ({
    _id: `doc-${String(index).padStart(3, "0")}`,
    updatedAt: timestamp
  }));

  const first = pageRowsByCompositeMark(rows, "updatedAt", { ms: timestamp.getTime(), id: "" }, 100);
  assert.equal(first.rows.length, 100);
  assert.equal(first.hasMore, true);
  const second = pageRowsByCompositeMark(rows, "updatedAt", markForRow(first.rows.at(-1), "updatedAt"), 100);
  assert.equal(second.rows.length, 100);
  assert.equal(second.hasMore, true);
  const third = pageRowsByCompositeMark(rows, "updatedAt", markForRow(second.rows.at(-1), "updatedAt"), 100);
  assert.equal(third.rows.length, 50);
  assert.equal(third.hasMore, false);

  const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row._id);
  assert.equal(new Set(ids).size, 250);
});

test("duplicate outbox delivery is idempotent and keeps the latest composite mark", () => {
  const earlier = {
    eventId: "sync-event-1",
    entityType: "product",
    entityId: "product-1",
    version: 3,
    _mark: { ms: 1000, id: "row-a" }
  };
  const later = {
    ...earlier,
    version: 4,
    _mark: { ms: 1000, id: "row-b" }
  };
  const other = {
    eventId: "sync-event-2",
    entityType: "inventory",
    entityId: "product-1",
    version: 4,
    _mark: { ms: 1001, id: "row-c" }
  };
  const merged = mergeAndDedupeEvents([earlier, later, other, later], 100);
  assert.deepEqual(merged.map((event) => [event.eventId, event.version]), [
    ["sync-event-1", 4],
    ["sync-event-2", 4]
  ]);
});

test("cursor round trip preserves a watermark per source", () => {
  const cursor = encodeSyncCursor({ marks: {
    products: { ms: 1000, id: "p-2" },
    orders: { ms: 1000, id: "o-9" }
  } }, { secret: CURSOR_SECRET });
  assert.match(cursor, /^v3\.[A-Za-z0-9_-]+$/);
  assert.equal(cursor.includes("p-2"), false);
  assert.equal(cursor.includes("o-9"), false);
  const decoded = decodeSyncCursor(cursor, { secret: CURSOR_SECRET });
  assert.deepEqual(decoded.marks.products, { ms: 1000, id: "p-2" });
  assert.deepEqual(decoded.marks.orders, { ms: 1000, id: "o-9" });
  assert.throws(() => decodeSyncCursor(cursor, { secret: `${CURSOR_SECRET}-wrong` }), (err) => err.code === "INVALID_SYNC_CURSOR");
  assert.throws(() => encodeSyncCursor({ marks: {} }), (err) => err.code === "SYNC_CURSOR_CONFIG_REQUIRED");
});

test("event envelopes retain only non-sensitive changed field names", () => {
  assert.deepEqual(
    safeChangedFields(["price", "paymentStatus", "warningStock", "stockStatus", "phone", "address", "paymentScreenshotUrl", "price"]),
    ["price", "paymentStatus", "warningStock", "stockStatus"]
  );
});

test("stored system order events remain readable without being relabeled as admin activity", () => {
  const event = sanitizeStoredEvent({
    _id: "stored-system-order-event",
    eventId: "auto_order_state:opaque",
    eventType: "order.status_changed",
    entityType: "order",
    entityId: "order-1",
    action: "manual_review_required",
    version: 3,
    changedFields: [
      "status",
      "updatedAt",
      "version",
      "riskLevelSnapshot",
      "phone",
      "paymentScreenshotUrl"
    ],
    actorType: "system",
    sourceClient: "system",
    createdAt: new Date("2026-07-23T08:00:00.000Z")
  }, "admin_web");

  assert.deepEqual(event.changedFields, ["status", "updatedAt", "version"]);
  assert.equal(event.action, "manual_review_required");
  assert.equal(event.actorType, "system");
  assert.equal(event.sourceClient, "system");
  assert.equal(JSON.stringify(event).includes("riskLevelSnapshot"), false);
  assert.equal(JSON.stringify(event).includes("phone"), false);
  assert.equal(JSON.stringify(event).includes("paymentScreenshotUrl"), false);
});

test("procurement never receives payment refund or account topics", () => {
  const principal = {
    kind: "admin",
    role: "procurement",
    permissions: ["product:view", "inventory:view", "payment:view_screenshot", "refund:view", "customer:view_account"]
  };
  assert.deepEqual(
    selectedEntityTypes(principal, ["product", "inventory", "payment", "refund", "account"]),
    ["product", "inventory"]
  );
});

test("customer service sync topics require both role scope and actual permission", () => {
  const principal = {
    kind: "admin",
    role: "customer_service",
    permissions: ["order:view", "payment:view_screenshot", "refund:view", "customer:view_account"]
  };
  assert.deepEqual(
    selectedEntityTypes(principal, ["order", "payment", "refund", "account", "shipment"]),
    ["order"]
  );
});

test("partial finance permissions only expose matching sync topics", () => {
  const principal = {
    kind: "admin",
    role: "finance",
    permissions: ["payment:view_screenshot"]
  };
  assert.deepEqual(
    selectedEntityTypes(principal, ["order", "payment", "refund", "account", "shipment"]),
    ["payment"]
  );
});

test("fallback event identifiers do not embed database document ids", () => {
  const eventId = stableEventId("fallback-orders", "private-document-id", 1234);
  assert.match(eventId, /^fallback-orders:[a-f0-9]{32}$/);
  assert.equal(eventId.includes("private-document-id"), false);
  const event = deriveFallbackEvent("orders", {
    _id: "private-document-id",
    updatedAt: new Date(1234),
    version: 2
  }, "admin_web");
  assert.equal(Object.hasOwn(event, "cursor"), false);
  assert.equal(Object.hasOwn(event, "sortKey"), false);
});
