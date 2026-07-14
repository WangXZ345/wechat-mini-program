const crypto = require("crypto");
const permissionModel = require("./permissions");

const VALID_ADMIN_ROLES = new Set([
  "customer_service",
  "finance",
  "procurement",
  "super_admin"
]);

const ROLE_NAMES = {
  customer_service: "客服",
  finance: "财务",
  procurement: "采购",
  super_admin: "超级管理员"
};

const DEFAULT_SCRYPT_PARAMS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  keyLength: 64,
  maxmem: 64 * 1024 * 1024
});

const TEST_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const REFRESH_COOKIE_NAME = "__Host-admin_web_refresh";
const LOCAL_ENVIRONMENTS = new Set(["local", "development", "unit-test"]);
const REMOTE_ENVIRONMENTS = new Set(["test", "staging", "production"]);
const HTTP_LOOPBACK_AUTHORITY = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

class AuthError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanString(value, maxLength = 256) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, maxLength);
}

function normalizeLoginId(value) {
  const normalized = cleanString(value, 128).normalize("NFKC").toLowerCase();
  if (normalized.length < 3 || normalized.length > 64) {
    throw new AuthError("INVALID_LOGIN_ID", "账号或密码错误", 401);
  }
  if (/\s/.test(normalized) || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AuthError("INVALID_LOGIN_ID", "账号或密码错误", 401);
  }
  return normalized;
}

function maskLoginId(value) {
  const normalized = cleanString(value, 128);
  if (!normalized) return "";
  if (/^1[3-9]\d{9}$/.test(normalized)) {
    return `${normalized.slice(0, 3)}****${normalized.slice(7)}`;
  }
  if (normalized.includes("@")) {
    const [local, domain] = normalized.split("@");
    return `${local.slice(0, 1)}***@${domain || "***"}`.slice(0, 80);
  }
  if (normalized.length <= 3) return `${normalized.slice(0, 1)}**`;
  return `${normalized.slice(0, 2)}***${normalized.slice(-1)}`.slice(0, 80);
}

function validatePasswordPolicy(password) {
  const value = String(password || "");
  if (value.length < 12 || value.length > 128) {
    throw new AuthError("WEAK_PASSWORD", "密码长度必须为 12 至 128 位", 400);
  }
  const categories = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)];
  if (categories.filter(Boolean).length < 3) {
    throw new AuthError("WEAK_PASSWORD", "密码至少包含大小写字母、数字、符号中的三类", 400);
  }
  return value;
}

function normalizeScryptParams(params = {}) {
  const normalized = {
    N: Number(params.N || DEFAULT_SCRYPT_PARAMS.N),
    r: Number(params.r || DEFAULT_SCRYPT_PARAMS.r),
    p: Number(params.p || DEFAULT_SCRYPT_PARAMS.p),
    keyLength: Number(params.keyLength || DEFAULT_SCRYPT_PARAMS.keyLength),
    maxmem: Number(params.maxmem || DEFAULT_SCRYPT_PARAMS.maxmem)
  };
  const powerOfTwo = normalized.N > 1 && (normalized.N & (normalized.N - 1)) === 0;
  if (!powerOfTwo || normalized.N < 1024 || normalized.N > 262144) throw new Error("Invalid scrypt N");
  if (normalized.r < 1 || normalized.r > 16) throw new Error("Invalid scrypt r");
  if (normalized.p < 1 || normalized.p > 4) throw new Error("Invalid scrypt p");
  if (normalized.keyLength < 32 || normalized.keyLength > 64) throw new Error("Invalid scrypt keyLength");
  const requiredMaxmem = 128 * normalized.N * normalized.r + 1024 * 1024;
  if (normalized.maxmem < requiredMaxmem || normalized.maxmem > 256 * 1024 * 1024) {
    throw new Error("Invalid scrypt maxmem");
  }
  return normalized;
}

function hmacBuffer(value, pepper) {
  return crypto.createHmac("sha256", pepper).update(String(value || ""), "utf8").digest();
}

function scryptAsync(input, salt, keyLength, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(input, salt, keyLength, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function derivePasswordHash(password, saltHex, pepper, params = DEFAULT_SCRYPT_PARAMS) {
  const normalized = normalizeScryptParams(params);
  const salt = Buffer.from(String(saltHex || ""), "hex");
  if (salt.length < 16) throw new Error("Invalid password salt");
  const prehashed = hmacBuffer(password, pepper);
  const derived = await scryptAsync(prehashed, salt, normalized.keyLength, {
    N: normalized.N,
    r: normalized.r,
    p: normalized.p,
    maxmem: normalized.maxmem
  });
  return derived.toString("hex");
}

async function createPasswordRecord(password, pepper, params = DEFAULT_SCRYPT_PARAMS) {
  const checked = validatePasswordPolicy(password);
  const normalized = normalizeScryptParams(params);
  const salt = crypto.randomBytes(32).toString("hex");
  const hash = await derivePasswordHash(checked, salt, pepper, normalized);
  return {
    algorithm: "scrypt-v1",
    hash,
    salt,
    params: normalized
  };
}

function timingSafeHexEqual(left, right) {
  try {
    const leftBuffer = Buffer.from(String(left || ""), "hex");
    const rightBuffer = Buffer.from(String(right || ""), "hex");
    return leftBuffer.length > 0
      && leftBuffer.length === rightBuffer.length
      && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  } catch (err) {
    return false;
  }
}

async function verifyPassword(password, record, pepper) {
  if (!record || record.algorithm !== "scrypt-v1" || !record.hash || !record.salt) return false;
  try {
    const actual = await derivePasswordHash(password, record.salt, pepper, record.params);
    return timingSafeHexEqual(actual, record.hash);
  } catch (err) {
    return false;
  }
}

async function runDummyPasswordHash(password, pepper, params = DEFAULT_SCRYPT_PARAMS) {
  const salt = crypto.createHash("sha256").update(`admin-web-dummy:${pepper}`).digest("hex");
  await derivePasswordHash(String(password || ""), salt, pepper, params);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function tokenHash(token, pepper) {
  if (!token) return "";
  return crypto.createHmac("sha256", pepper).update(String(token), "utf8").digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeSecretEqual(left, right) {
  const leftHash = sha256(left);
  const rightHash = sha256(right);
  return timingSafeHexEqual(leftHash, rightHash);
}

function isCsrfTokenValid(suppliedToken, expectedHash, pepper) {
  const supplied = cleanString(suppliedToken, 512);
  if (!supplied || !expectedHash || !pepper) return false;
  return safeSecretEqual(tokenHash(supplied, pepper), expectedHash);
}

function normalizePermissions(permissions) {
  if (!Array.isArray(permissions)) return [];
  return Array.from(new Set(permissions
    .map((permission) => cleanString(permission, 100))
    .filter((permission) => /^[a-z][a-z0-9_]*(?::[a-z0-9_*]+)+$/.test(permission))))
    .sort();
}

function normalizePrincipal(raw) {
  if (!raw || raw.status === "disabled" || raw.isActive === false) return null;
  const role = cleanString(raw.role, 50);
  if (!VALID_ADMIN_ROLES.has(role)) return null;
  return {
    id: cleanString(raw._id || raw.id, 128),
    name: cleanString(raw.name || raw.nickname, 100),
    phoneMasked: maskLoginId(raw.phone || ""),
    role,
    roleName: ROLE_NAMES[role],
    permissions: role === "super_admin"
      ? ["*"]
      : permissionModel.filterPermissionsForRole(role, normalizePermissions(raw.permissions)),
    status: "active",
    authVersion: Math.max(0, Number(raw.authVersion || 0))
  };
}

function principalFingerprint(principal) {
  if (!principal) return "";
  return sha256(JSON.stringify({
    id: principal.id,
    role: principal.role,
    permissions: normalizePermissions(principal.permissions),
    status: principal.status,
    authVersion: Number(principal.authVersion || 0)
  }));
}

function publicPrincipal(principal) {
  if (!principal) return null;
  return {
    id: principal.id,
    name: principal.name,
    phoneMasked: principal.phoneMasked,
    role: principal.role,
    roleName: principal.roleName,
    permissions: principal.permissions.slice(),
    status: principal.status
  };
}

function normalizeHeaders(headers = {}) {
  return Object.keys(headers || {}).reduce((result, key) => {
    result[String(key).toLowerCase()] = Array.isArray(headers[key]) ? headers[key].join(",") : String(headers[key]);
    return result;
  }, {});
}

function parseCookies(cookieHeader = "") {
  return String(cookieHeader || "").split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return cookies;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (err) {
      cookies[name] = value;
    }
    return cookies;
  }, {});
}

function normalizeOrigin(value, environment = "") {
  const origin = String(value || "").trim();
  if (!origin || origin.length > 300 || /[\u0000-\u0020\u007f]/.test(origin)) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(origin) || /[?#]/.test(origin)) return "";

  try {
    const parsed = new URL(origin);
    const schemeEnd = origin.indexOf("://") + 3;
    const pathStart = origin.indexOf("/", schemeEnd);
    const authority = origin.slice(schemeEnd, pathStart < 0 ? origin.length : pathStart);
    const hasOnlyOptionalTrailingSlash = pathStart < 0 || pathStart === origin.length - 1;
    if (!hasOnlyOptionalTrailingSlash || parsed.pathname !== "/" || parsed.username || parsed.password) return "";
    if (parsed.protocol === "https:") return parsed.origin;
    if (parsed.protocol !== "http:" || !HTTP_LOOPBACK_AUTHORITY.test(authority)) return "";
    if (["staging", "production"].includes(cleanString(environment, 30).toLowerCase())) return "";
    return parsed.origin;
  } catch (err) {
    return "";
  }
}

function parseAllowedOrigins(value, environment = "") {
  const entries = String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!entries.length) return [];
  const normalized = entries.map((origin) => normalizeOrigin(origin, environment));
  if (normalized.some((origin) => !origin)) return [];
  return Array.from(new Set(normalized));
}

function isOriginAllowed(origin, allowedOrigins) {
  const normalized = normalizeOrigin(origin);
  return Boolean(normalized && Array.isArray(allowedOrigins) && allowedOrigins.includes(normalized));
}

function loadSecurityConfig(env = process.env) {
  const environment = cleanString(env.ADMIN_WEB_ENV || env.NODE_ENV, 30).toLowerCase();
  const localLike = LOCAL_ENVIRONMENTS.has(environment);
  const remoteLike = REMOTE_ENVIRONMENTS.has(environment);
  const tokenPepper = String(env.ADMIN_WEB_TOKEN_PEPPER || (localLike ? "local-only-token-pepper-never-deploy" : ""));
  const passwordPepper = String(env.ADMIN_WEB_PASSWORD_PEPPER || (localLike ? "local-only-password-pepper-never-deploy" : ""));
  let allowedOrigins = parseAllowedOrigins(env.ADMIN_WEB_ALLOWED_ORIGINS, environment);
  if (!allowedOrigins.length && localLike) allowedOrigins = TEST_ORIGINS.slice();
  const actionSecret = String(env.ADMIN_WEB_ACTION_SECRET || "");
  const bootstrapEnabled = String(env.ADMIN_WEB_ALLOW_BOOTSTRAP || "").toLowerCase() === "true";
  const bootstrapSecret = String(env.ADMIN_WEB_BOOTSTRAP_SECRET || "");
  const allowInsecureActionTransport = localLike
    && String(env.ADMIN_WEB_ALLOW_TEST_ACTION_TRANSPORT || "").toLowerCase() === "true";

  if (!localLike && !remoteLike) {
    throw new AuthError("SECURITY_CONFIG_REQUIRED", "管理员认证安全配置不完整", 503);
  }
  if (remoteLike && (
    tokenPepper.length < 32
    || passwordPepper.length < 32
    || actionSecret.length < 32
    || !allowedOrigins.length
    || (bootstrapEnabled && bootstrapSecret.length < 32)
  )) {
    throw new AuthError("SECURITY_CONFIG_REQUIRED", "管理员认证安全配置不完整", 503);
  }

  return {
    environment,
    testLike: localLike,
    localLike,
    remoteLike,
    tokenPepper,
    passwordPepper,
    allowedOrigins,
    accessTtlMs: Math.max(5 * 60 * 1000, Math.min(30 * 60 * 1000, Number(env.ADMIN_WEB_ACCESS_TTL_MS || 15 * 60 * 1000))),
    refreshTtlMs: Math.max(60 * 60 * 1000, Math.min(14 * 24 * 60 * 60 * 1000, Number(env.ADMIN_WEB_REFRESH_TTL_MS || 7 * 24 * 60 * 60 * 1000))),
    absoluteTtlMs: Math.max(24 * 60 * 60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, Number(env.ADMIN_WEB_ABSOLUTE_TTL_MS || 30 * 24 * 60 * 60 * 1000))),
    bootstrapEnabled,
    bootstrapSecret,
    actionSecret,
    allowInsecureActionTransport
  };
}

function createRefreshCookie(token, maxAgeSeconds) {
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

function clearRefreshCookie() {
  return `${REFRESH_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function sanitizeUserAgent(userAgent) {
  const value = cleanString(userAgent, 512);
  if (!value) return "unknown";
  if (/edg\//i.test(value)) return "Edge";
  if (/chrome\//i.test(value)) return "Chrome";
  if (/firefox\//i.test(value)) return "Firefox";
  if (/safari\//i.test(value)) return "Safari";
  return "Browser";
}

module.exports = {
  AuthError,
  DEFAULT_SCRYPT_PARAMS,
  REFRESH_COOKIE_NAME,
  VALID_ADMIN_ROLES,
  cleanString,
  normalizeLoginId,
  maskLoginId,
  validatePasswordPolicy,
  normalizeScryptParams,
  createPasswordRecord,
  verifyPassword,
  runDummyPasswordHash,
  randomToken,
  tokenHash,
  sha256,
  safeSecretEqual,
  isCsrfTokenValid,
  normalizePermissions,
  normalizePrincipal,
  principalFingerprint,
  publicPrincipal,
  normalizeHeaders,
  parseCookies,
  parseAllowedOrigins,
  isOriginAllowed,
  loadSecurityConfig,
  createRefreshCookie,
  clearRefreshCookie,
  sanitizeUserAgent
};
