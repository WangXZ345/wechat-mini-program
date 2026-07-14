const { ApiError, boundedPermissions } = require("./core");
const security = require("../security");
const permissionModel = require("../permissions");

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

async function getAdmin(db, adminId) {
  try {
    const result = await db.collection("admin_users").doc(adminId).get();
    return result && result.data || null;
  } catch (err) {
    return null;
  }
}

async function requireAccessSession({ db, accessToken, config }) {
  if (!accessToken) throw new ApiError("AUTH_REQUIRED", "缺少访问令牌", 401);
  const accessTokenHash = security.tokenHash(accessToken, config.tokenPepper);
  const result = await db.collection("admin_web_sessions").where({ accessTokenHash }).limit(1).get();
  const session = result.data && result.data[0];
  if (!session || session.revokedAt) throw new ApiError("SESSION_REVOKED", "登录状态已失效", 401);
  const now = Date.now();
  if (toMillis(session.accessExpiresAt) <= now || toMillis(session.absoluteExpiresAt) <= now) {
    throw new ApiError("SESSION_EXPIRED", "登录状态已过期", 401);
  }

  const rawAdmin = await getAdmin(db, session.adminId);
  const fingerprintPrincipal = security.normalizePrincipal(rawAdmin);
  if (!fingerprintPrincipal) throw new ApiError("ACCOUNT_UNAVAILABLE", "管理员账号不可用", 401);
  const currentFingerprint = security.principalFingerprint(fingerprintPrincipal);
  if (!session.principalFingerprint || session.principalFingerprint !== currentFingerprint) {
    throw new ApiError("SESSION_STALE", "管理员权限已变更，请重新登录", 401);
  }

  const permissions = boundedPermissions(fingerprintPrincipal, permissionModel);
  const principal = { ...fingerprintPrincipal, permissions };
  await db.collection("admin_web_sessions").doc(session._id).update({
    data: { lastActivityAt: db.serverDate(), updatedAt: db.serverDate() }
  }).catch(() => {});
  return { session, principal, rawAdmin, accessTokenHash };
}

function csrfTokenFromRequest(request = {}) {
  const headers = request.headers || {};
  if (request.http) return security.cleanString(headers["x-admin-csrf"], 512);
  return security.cleanString(headers["x-admin-csrf"] || request.body && request.body.csrfToken, 512);
}

function assertSessionCsrf({ session, request, config }) {
  const supplied = csrfTokenFromRequest(request);
  if (!security.isCsrfTokenValid(supplied, session && session.csrfTokenHash, config.tokenPepper)) {
    throw new ApiError("CSRF_VALIDATION_FAILED", "请求校验失败", 403);
  }
}

module.exports = { requireAccessSession, assertSessionCsrf, csrfTokenFromRequest, toMillis };
