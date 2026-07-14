const test = require("node:test");
const assert = require("node:assert/strict");
const { authorizeCleanup, safeSecretEqual } = require("../security");

const SECRET = "cleanup-test-secret-with-more-than-thirty-two-characters";

test("cleanup authorization fails closed without a secret or super admin", async () => {
  assert.equal(await authorizeCleanup({ event: {}, context: {}, env: {}, findAdmin: async () => null }), false);
  assert.equal(await authorizeCleanup({
    event: { secret: "wrong-secret" },
    context: {},
    env: { SYNC_CLEANUP_SECRET: SECRET },
    findAdmin: async () => null
  }), false);
});

test("cleanup accepts only the configured secret or an active super admin", async () => {
  assert.equal(safeSecretEqual(SECRET, SECRET), true);
  assert.equal(await authorizeCleanup({
    event: { secret: SECRET },
    context: {},
    env: { SYNC_CLEANUP_SECRET: SECRET },
    findAdmin: async () => null
  }), true);
  assert.equal(await authorizeCleanup({
    event: {},
    context: { OPENID: "admin-openid" },
    env: {},
    findAdmin: async () => ({ role: "finance", isActive: true })
  }), false);
  assert.equal(await authorizeCleanup({
    event: {},
    context: { OPENID: "admin-openid" },
    env: {},
    findAdmin: async () => ({ role: "super_admin", isActive: true, status: "active" })
  }), true);
});
