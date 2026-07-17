"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("admin confirm-return action supplies a stable idempotency key", () => {
  const block = source.match(/confirmReceived\(\)\s*\{([\s\S]*?)\n\s*\},\n\n\s*inspect\(\)/);
  assert.ok(block, "confirmReceived handler should exist");
  assert.match(block[1], /idempotencyKey:\s*generateIdempotencyKey\(["']confirm_return_received["']\)/);
});
