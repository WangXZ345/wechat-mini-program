"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { _test } = require("../index");

const request = {
  requestId: "auth-request-1",
  sourceIp: "203.0.113.10",
  userAgent: "Unit Test Browser/1.0",
  origin: "https://admin.example.test"
};
const config = { tokenPepper: "p".repeat(32) };

test("security log write failures propagate instead of being silently swallowed", async () => {
  const store = {
    serverDate() { return new Date("2026-08-09T06:00:00.000Z"); },
    collection() {
      return { async add() { throw new Error("forced security log failure"); } };
    }
  };
  await assert.rejects(
    _test.writeSecurityLog(request, config, {
      eventType: "credential.rotated",
      outcome: "success",
      code: "OK",
      adminId: "admin-1",
      role: "super_admin"
    }, store),
    /forced security log failure/
  );
});

test("security log stores request correlation and hashes network metadata", async () => {
  let row;
  const store = {
    serverDate() { return new Date("2026-08-09T06:00:00.000Z"); },
    collection(name) {
      assert.equal(name, "admin_security_logs");
      return { async add({ data }) { row = data; return { _id: "security-log-1" }; } };
    }
  };
  await _test.writeSecurityLog(request, config, {
    eventType: "credential.rotated",
    outcome: "success",
    code: "OK",
    adminId: "admin-1",
    role: "super_admin"
  }, store);
  assert.equal(row.requestId, "auth-request-1");
  assert.equal(row.adminId, "admin-1");
  assert.match(row.ipHash, /^[a-f0-9]{64}$/);
  assert.match(row.userAgentHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(row).includes("203.0.113.10"), false);
  assert.equal(JSON.stringify(row).includes("https://admin.example.test"), false);
});
