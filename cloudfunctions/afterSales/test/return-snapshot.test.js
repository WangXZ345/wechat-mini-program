"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assertAfterSaleSnapshot, canCompleteAfterSale } = require("../../common/services/returnSnapshot");

const row = { version: 4, updatedAt: "2026-07-16T08:00:00.000Z", afterSaleStatus: "waiting_return" };

test("return operations accept matching status and optimistic snapshots", () => {
  assert.equal(assertAfterSaleSnapshot(row, {
    expectedStatus: "waiting_return",
    expectedVersion: 4,
    expectedUpdatedAt: row.updatedAt
  }, ["waiting_return", "returned"]), 4);
});

test("return operations reject stale version or timestamp", () => {
  assert.throws(
    () => assertAfterSaleSnapshot(row, { expectedVersion: 3 }, ["waiting_return"]),
    (error) => error.code === "DATA_VERSION_CONFLICT"
  );
  assert.throws(
    () => assertAfterSaleSnapshot(row, { expectedUpdatedAt: "2026-07-16T08:01:00.000Z" }, ["waiting_return"]),
    (error) => error.code === "DATA_VERSION_CONFLICT"
  );
});

test("return operations reject forged expected status", () => {
  assert.throws(
    () => assertAfterSaleSnapshot(row, { expectedStatus: "refund_pending" }, ["waiting_return"]),
    (error) => error.code === "EXPECTED_STATUS_INVALID"
  );
});

test("after-sale completion cannot bypass refund pending or unfinished return states", () => {
  for (const status of ["pending_review", "waiting_return", "returned", "received", "inspecting", "refund_pending", "rejected", "cancelled"]) {
    assert.equal(canCompleteAfterSale(status), false, status);
  }
  assert.equal(canCompleteAfterSale("approved"), true);
  assert.equal(canCompleteAfterSale("refunded"), true);
  assert.equal(canCompleteAfterSale("exchanged"), true);
  assert.equal(canCompleteAfterSale("resent"), true);
  assert.equal(canCompleteAfterSale("unknown_corrupt_status"), false);
  assert.equal(canCompleteAfterSale(""), false);
});

test("after-sale log adapter persists only the explicit immutable return result evidence fields", () => {
  const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const start = source.indexOf("async function writeAfterSaleLog");
  const end = source.indexOf("async function writeRefundLog", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const writer = source.slice(start, end);

  assert.match(writer, /resultData\s*=\s*\{\}/);
  for (const field of [
    "afterSaleId",
    "action",
    "businessKey",
    "operatorId",
    "afterSaleStatus",
    "version",
    "updatedAt",
    "restoredQuantity"
  ]) {
    assert.match(writer, new RegExp(`${field}:\\s*resultData\\.${field}`), field);
  }
});
