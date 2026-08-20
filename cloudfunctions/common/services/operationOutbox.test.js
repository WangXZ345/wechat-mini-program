"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildOperationLog,
  buildSyncEvent,
  idempotencyDigest,
  writeOperationBundle
} = require("./operationOutbox");

const now = new Date("2026-08-09T05:30:00.000Z");

function input(overrides = {}) {
  return {
    operator: { id: "admin-1", role: "procurement", openid: "openid-private" },
    action: "change_price",
    resourceType: "product",
    resourceId: "product-1",
    requestId: "request-price-1",
    batchId: "batch-price-1",
    idempotencyKey: "raw-idempotency-key-private",
    businessKey: "product-price-business-key",
    changedFields: ["price", "updatedAt", "version", "phone", "paymentScreenshotUrl"],
    before: { price: 6900, version: 3, phone: "13800138000", token: "secret-token" },
    after: { price: 7200, version: 4, address: "private-address", paymentProofUrl: "private-url" },
    result: { status: "success", affected: 1 },
    timestamp: now,
    ...overrides
  };
}

test("operation log keeps required correlation metadata and redacts secrets and customer privacy", () => {
  const log = buildOperationLog(input());
  assert.equal(log.operatorId, "admin-1");
  assert.equal(log.operatorRole, "procurement");
  assert.equal(log.action, "change_price");
  assert.equal(log.resourceType, "product");
  assert.equal(log.resourceId, "product-1");
  assert.equal(log.requestId, "request-price-1");
  assert.equal(log.batchId, "batch-price-1");
  assert.equal(log.idempotencyDigest, idempotencyDigest("raw-idempotency-key-private"));
  assert.deepEqual(log.changeSummary.changedFields, ["price", "updatedAt", "version"]);
  assert.deepEqual(log.changeSummary.before, { price: 6900, version: 3 });
  assert.deepEqual(log.changeSummary.after, { price: 7200, version: 4 });
  const serialized = JSON.stringify(log);
  for (const secret of ["openid-private", "raw-idempotency-key-private", "13800138000", "secret-token", "private-address", "private-url"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  for (const field of ["operatorOpenid", "idempotencyKey", "phone", "token", "address", "paymentProofUrl"]) {
    assert.equal(serialized.includes(`\"${field}\"`), false, field);
  }
});

test("sync event is deterministic, repeatable and carries only invalidation metadata", () => {
  const first = buildSyncEvent(input({
    eventType: "product.price_updated",
    entityType: "product",
    entityId: "product-1",
    version: 4,
    updatedAt: now,
    audience: "public",
    isPublic: true,
    audienceRoles: ["procurement", "super_admin"]
  }));
  const second = buildSyncEvent(input({
    eventType: "product.price_updated",
    entityType: "product",
    entityId: "product-1",
    version: 4,
    updatedAt: now,
    audience: "public",
    isPublic: true,
    audienceRoles: ["procurement", "super_admin"]
  }));
  assert.equal(first.eventId, second.eventId);
  assert.equal(first.requestId, "request-price-1");
  assert.equal(first.batchId, "batch-price-1");
  assert.equal(first.version, 4);
  assert.equal(first.updatedAt, now);
  assert.deepEqual(first.changedFields, ["price", "updatedAt", "version"]);
  assert.equal(JSON.stringify(first).includes("7200"), false);
  assert.equal(JSON.stringify(first).includes("raw-idempotency-key-private"), false);
});

test("writer awaits audit and every outbox write and propagates failures", async () => {
  const writes = [];
  const store = {
    collection(name) {
      return {
        async add({ data }) {
          writes.push([name, data]);
          if (name === "sync_events") throw new Error("forced outbox failure");
          return { _id: `${name}-1` };
        }
      };
    }
  };
  const operation = input();
  const event = buildSyncEvent(input({
    eventType: "product.price_updated",
    entityType: "product",
    entityId: "product-1",
    version: 4,
    updatedAt: now
  }));
  await assert.rejects(
    writeOperationBundle(store, { operation, events: [event] }),
    /forced outbox failure/
  );
  assert.deepEqual(writes.map(([name]) => name), ["admin_operation_logs", "sync_events"]);
});

test("writer returns deterministic correlation ids for raw batch events", async () => {
  const writes = [];
  const store = {
    collection(name) {
      return {
        async add({ data }) {
          writes.push([name, data]);
          return { _id: `${name}-${writes.length}` };
        }
      };
    }
  };
  const result = await writeOperationBundle(store, {
    operation: input(),
    events: [{
      eventType: "product.price_updated",
      entityType: "product",
      entityId: "product-1",
      action: "change_price",
      version: 4,
      updatedAt: now
    }]
  });
  assert.match(result.operationId, /^operation:/);
  assert.equal(result.eventIds.length, 1);
  assert.equal(result.eventIds[0], writes[1][1].eventId);
  assert.match(result.eventIds[0], /^sync_event:/);
});

test("deployable helper copies stay byte-identical and guarded packaging includes each consumer", () => {
  const canonical = fs.readFileSync(path.join(__dirname, "operationOutbox.js"));
  for (const relative of [
    "../../adminWebApi/lib/operationOutbox.js",
    "../../updateProductPrice/operationOutbox.js",
    "../../updateProductWarningStock/operationOutbox.js"
  ]) {
    assert.deepEqual(fs.readFileSync(path.join(__dirname, relative)), canonical, relative);
  }
  const script = fs.readFileSync(path.join(__dirname, "../../../scripts/package-admin-web-cloudfunctions.ps1"), "utf8");
  assert.match(script, /canonicalOperationOutbox/);
  assert.match(script, /apiTarget\s+"lib\\operationOutbox\.js"/);
  assert.match(script, /priceTarget\s+"operationOutbox\.js"/);
  assert.match(script, /warningTarget\s+"operationOutbox\.js"/);
});
