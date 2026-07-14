const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const functionSource = fs.readFileSync(path.resolve(__dirname, "../index.js"), "utf8");
const pageSource = fs.readFileSync(path.resolve(__dirname, "../../../miniprogram/pages/admin/unsold/index.js"), "utf8");

test("unsold stock writes require inventory:update and use the canonical set adapter", () => {
  assert.match(functionSource, /event\.action === "updateStock"[\s\S]*requirePermission\("inventory:update"\)/);
  assert.match(functionSource, /inventoryMutationService\.adjustInventory\(\{/);
  assert.match(functionSource, /mode: "set"/);
  assert.match(functionSource, /expectedStock: event\.expectedStock/);
  assert.match(functionSource, /expectedVersion: event\.expectedVersion/);
  assert.doesNotMatch(functionSource, /async function updateStock[\s\S]{0,1000}Invalid operation/);
});

test("the mini-program sends strict stock and version snapshots plus an idempotency key", () => {
  assert.match(pageSource, /action: "updateStock"[\s\S]*expectedStock: Number\(product\.stock \|\| 0\)/);
  assert.match(pageSource, /expectedVersion: Number\(product\.version \|\| 0\)/);
  assert.match(pageSource, /idempotencyKey: generateIdempotencyKey\(`unsold-stock-\$\{id\}`\)/);
});

test("development proxy resolves to the shared canonical inventory service", () => {
  assert.equal(require("../inventoryMutationService"), require("../../common/services/inventoryMutationService"));
});
