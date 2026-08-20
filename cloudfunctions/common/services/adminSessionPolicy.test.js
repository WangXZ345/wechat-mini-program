const test = require("node:test");
const assert = require("node:assert/strict");
const { readSessionIdleMinutes, assertSessionIdleLifetime } = require("./adminSessionPolicy");

test("session idle policy normalizes configured values and preserves legacy sessions", () => {
  assert.equal(readSessionIdleMinutes({ sessionIdleMinutes: 45 }), 45);
  assert.equal(readSessionIdleMinutes({ sessionIdleMinutes: 4 }), 30);
  assert.equal(readSessionIdleMinutes({ sessionIdleMinutes: 241 }), 30);
  assert.doesNotThrow(() => assertSessionIdleLifetime({ lastActivityAt: new Date("2026-08-15T05:00:00.000Z") }, Date.parse("2026-08-15T10:00:00.000Z")));
});

test("session idle policy rejects an expired snapshot", () => {
  assert.throws(
    () => assertSessionIdleLifetime({ idleTimeoutMinutes: 5, lastActivityAt: new Date("2026-08-15T05:00:00.000Z") }, Date.parse("2026-08-15T05:05:00.000Z")),
    (error) => error.code === "SESSION_IDLE_EXPIRED" && error.statusCode === 401
  );
});
