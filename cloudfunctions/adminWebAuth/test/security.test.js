const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AuthError,
  REFRESH_COOKIE_NAME,
  normalizeLoginId,
  maskLoginId,
  validatePasswordPolicy,
  createPasswordRecord,
  verifyPassword,
  randomToken,
  tokenHash,
  safeSecretEqual,
  isCsrfTokenValid,
  normalizePrincipal,
  principalFingerprint,
  publicPrincipal,
  parseCookies,
  parseAllowedOrigins,
  isOriginAllowed,
  loadSecurityConfig,
  createRefreshCookie,
  clearRefreshCookie
} = require("../security");

const TEST_PEPPER = "test-password-pepper-with-at-least-32-bytes";
const FAST_SCRYPT = { N: 1024, r: 8, p: 1, keyLength: 32, maxmem: 8 * 1024 * 1024 };
const REMOTE_SECURITY_ENV = {
  ADMIN_WEB_TOKEN_PEPPER: "t".repeat(32),
  ADMIN_WEB_PASSWORD_PEPPER: "p".repeat(32),
  ADMIN_WEB_ACTION_SECRET: "a".repeat(32),
  ADMIN_WEB_ALLOWED_ORIGINS: "https://admin.test.example"
};

test("normalizes login identifiers without retaining whitespace or case", () => {
  assert.equal(normalizeLoginId("  Admin.User  "), "admin.user");
  assert.throws(() => normalizeLoginId("a b"), AuthError);
  assert.equal(maskLoginId("13800138000"), "138****8000");
  assert.equal(maskLoginId("administrator"), "ad***r");
});

test("enforces the administrator password policy", () => {
  assert.throws(() => validatePasswordPolicy("short1!"), /12/);
  assert.throws(() => validatePasswordPolicy("alllowercase123"), /三类/);
  assert.equal(validatePasswordPolicy("Strong-Admin-2026!"), "Strong-Admin-2026!");
});

test("scrypt records use random salts and timing-safe verification", async () => {
  const first = await createPasswordRecord("Strong-Admin-2026!", TEST_PEPPER, FAST_SCRYPT);
  const second = await createPasswordRecord("Strong-Admin-2026!", TEST_PEPPER, FAST_SCRYPT);
  assert.equal(first.algorithm, "scrypt-v1");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(await verifyPassword("Strong-Admin-2026!", first, TEST_PEPPER), true);
  assert.equal(await verifyPassword("Wrong-Admin-2026!", first, TEST_PEPPER), false);
  assert.equal(await verifyPassword("Strong-Admin-2026!", first, `${TEST_PEPPER}-wrong`), false);
});

test("opaque tokens are random and only deterministic hashes are retained", () => {
  const first = randomToken();
  const second = randomToken();
  assert.notEqual(first, second);
  assert.equal(tokenHash(first, TEST_PEPPER), tokenHash(first, TEST_PEPPER));
  assert.notEqual(tokenHash(first, TEST_PEPPER), tokenHash(second, TEST_PEPPER));
  assert.equal(tokenHash("", TEST_PEPPER), "");
  assert.equal(safeSecretEqual(tokenHash(first, TEST_PEPPER), tokenHash(first, TEST_PEPPER)), true);
  assert.equal(safeSecretEqual(tokenHash(first, TEST_PEPPER), tokenHash(second, TEST_PEPPER)), false);
  assert.equal(isCsrfTokenValid(first, tokenHash(first, TEST_PEPPER), TEST_PEPPER), true);
  assert.equal(isCsrfTokenValid(second, tokenHash(first, TEST_PEPPER), TEST_PEPPER), false);
  assert.equal(isCsrfTokenValid("", tokenHash(first, TEST_PEPPER), TEST_PEPPER), false);
});

test("principal output is whitelisted and fingerprint changes with authorization", () => {
  const raw = {
    _id: "admin-1",
    openid: "must-not-leak",
    name: "Admin",
    phone: "13800138000",
    role: "finance",
    permissions: ["payment:confirm", "payment:confirm", "invalid"],
    status: "active",
    isActive: true,
    authVersion: 2,
    passwordHash: "must-not-leak"
  };
  const principal = normalizePrincipal(raw);
  const output = publicPrincipal(principal);
  assert.deepEqual(output, {
    id: "admin-1",
    name: "Admin",
    phoneMasked: "138****8000",
    role: "finance",
    roleName: "财务",
    permissions: ["payment:confirm"],
    status: "active"
  });
  assert.equal(Object.hasOwn(output, "openid"), false);
  assert.equal(Object.hasOwn(output, "passwordHash"), false);
  const changed = normalizePrincipal({ ...raw, permissions: ["refund:process"], authVersion: 3 });
  assert.notEqual(principalFingerprint(principal), principalFingerprint(changed));
  const procurement = normalizePrincipal({
    ...raw,
    role: "procurement",
    permissions: ["product:view", "payment:confirm", "refund:view", "customer:view_account"]
  });
  assert.deepEqual(procurement.permissions, ["product:view"]);
  assert.equal(normalizePrincipal({ ...raw, role: "user" }), null);
  assert.equal(normalizePrincipal({ ...raw, status: "disabled" }), null);
});

test("origin parsing is exact and remote environments fail closed", () => {
  const origins = parseAllowedOrigins("https://admin.example.com, https://admin.example.com");
  assert.deepEqual(origins, ["https://admin.example.com"]);
  assert.equal(isOriginAllowed("https://admin.example.com", origins), true);
  assert.equal(isOriginAllowed("https://admin.example.com/", origins), true);
  assert.equal(isOriginAllowed("https://admin.example.com.evil.test", origins), false);
  assert.equal(isOriginAllowed("https://user:pass@admin.example.com", origins), false);
  assert.equal(isOriginAllowed("https://admin.example.com/path", origins), false);
  assert.equal(isOriginAllowed("https://admin.example.com?next=1", origins), false);
  assert.equal(isOriginAllowed("https://admin.example.com#fragment", origins), false);
  assert.equal(isOriginAllowed("//admin.example.com", origins), false);
  assert.deepEqual(parseAllowedOrigins("https://admin.example.com,not-a-url"), []);

  for (const environment of ["test", "staging", "production"]) {
    assert.throws(() => loadSecurityConfig({ ADMIN_WEB_ENV: environment }), /安全配置不完整/);
    const config = loadSecurityConfig({ ADMIN_WEB_ENV: environment, ...REMOTE_SECURITY_ENV });
    assert.equal(config.testLike, false);
    assert.equal(config.remoteLike, true);
    assert.equal(config.allowInsecureActionTransport, false);
    assert.deepEqual(config.allowedOrigins, ["https://admin.test.example"]);
  }

  for (const origin of ["http://localhost:5173", "http://127.0.0.1:4173", "http://[::1]:5173"]) {
    const config = loadSecurityConfig({
      ADMIN_WEB_ENV: "test",
      ...REMOTE_SECURITY_ENV,
      ADMIN_WEB_ALLOWED_ORIGINS: origin
    });
    assert.deepEqual(config.allowedOrigins, [origin]);
  }
  for (const origin of [
    "http://admin.test.example",
    "http://127.0.0.2:5173",
    "http://127.1:5173",
    "http://2130706433:5173",
    "http://localhost.evil.test:5173",
    "https://user:pass@admin.test.example",
    "https://admin.test.example/path",
    "https://admin.test.example?query=1",
    "https://admin.test.example#fragment",
    "//admin.test.example"
  ]) {
    assert.throws(() => loadSecurityConfig({
      ADMIN_WEB_ENV: "test",
      ...REMOTE_SECURITY_ENV,
      ADMIN_WEB_ALLOWED_ORIGINS: origin
    }), /安全配置不完整/);
  }
  for (const environment of ["staging", "production"]) {
    assert.throws(() => loadSecurityConfig({
      ADMIN_WEB_ENV: environment,
      ...REMOTE_SECURITY_ENV,
      ADMIN_WEB_ALLOWED_ORIGINS: "http://127.0.0.1:5173"
    }), /安全配置不完整/);
  }
  for (const key of ["ADMIN_WEB_TOKEN_PEPPER", "ADMIN_WEB_PASSWORD_PEPPER", "ADMIN_WEB_ACTION_SECRET", "ADMIN_WEB_ALLOWED_ORIGINS"]) {
    assert.throws(() => loadSecurityConfig({ ADMIN_WEB_ENV: "test", ...REMOTE_SECURITY_ENV, [key]: "" }), /安全配置不完整/);
  }
  assert.throws(() => loadSecurityConfig({
    ADMIN_WEB_ENV: "test",
    ...REMOTE_SECURITY_ENV,
    ADMIN_WEB_ALLOW_BOOTSTRAP: "true",
    ADMIN_WEB_BOOTSTRAP_SECRET: "short"
  }), /安全配置不完整/);
});

test("only an explicit local switch enables insecure internal-gateway transport", () => {
  const local = loadSecurityConfig({ ADMIN_WEB_ENV: "local" });
  assert.equal(local.testLike, true);
  assert.equal(local.allowInsecureActionTransport, false);
  assert.equal(local.allowedOrigins.includes("http://localhost:5173"), true);
  const enabled = loadSecurityConfig({
    ADMIN_WEB_ENV: "unit-test",
    ADMIN_WEB_ALLOW_TEST_ACTION_TRANSPORT: "true"
  });
  assert.equal(enabled.allowInsecureActionTransport, true);
});

test("refresh cookies are host-only, HttpOnly, Secure and SameSite protected", () => {
  const cookie = createRefreshCookie("secret-refresh-token", 3600);
  assert.match(cookie, new RegExp(`^${REFRESH_COOKIE_NAME}=`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(/Domain=/i.test(cookie), false);
  assert.equal(parseCookies(`${REFRESH_COOKIE_NAME}=abc%20123; other=value`)[REFRESH_COOKIE_NAME], "abc 123");
  assert.match(clearRefreshCookie(), /Max-Age=0/);
});
