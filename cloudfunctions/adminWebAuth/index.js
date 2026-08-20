const crypto = require("crypto");
const cloud = require("wx-server-sdk");
const { normalizeRequestId, toPublicError } = require("./errorModel");
const { readSessionIdleMinutes, assertSessionIdleLifetime } = require("./sessionPolicy");
const { RequestValidationError, parseObject } = require("./requestValidation");
const {
  AuthError,
  DEFAULT_SCRYPT_PARAMS,
  REFRESH_COOKIE_NAME,
  cleanString,
  normalizeLoginId,
  maskLoginId,
  createPasswordRecord,
  verifyPassword,
  runDummyPasswordHash,
  randomToken,
  tokenHash,
  safeSecretEqual,
  isCsrfTokenValid,
  normalizePrincipal,
  principalFingerprint,
  publicPrincipal,
  normalizeHeaders,
  parseCookies,
  isOriginAllowed,
  loadSecurityConfig,
  createRefreshCookie,
  clearRefreshCookie,
  sanitizeUserAgent
} = require("./security");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = {
  principals: "admin_users",
  credentials: "admin_web_credentials",
  sessions: "admin_web_sessions",
  attempts: "admin_login_attempts",
  securityLogs: "admin_security_logs"
};

const ACCOUNT_RATE_LIMIT = Object.freeze({ maxAttempts: 5, windowMs: 5 * 60 * 1000, lockMs: 10 * 60 * 1000 });
const IP_RATE_LIMIT = Object.freeze({ maxAttempts: 20, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 });
const MAX_SESSION_ROWS = 100;
const MAX_USED_REFRESH_HASHES = 20;

const ACTION_ALIASES = {
  login: "login",
  refresh: "refresh",
  logout: "logout",
  profile: "profile",
  revokesession: "revokeSession",
  "revoke-session": "revokeSession",
  listsessions: "listSessions",
  "list-sessions": "listSessions",
  bootstrapcredential: "bootstrapCredential",
  "bootstrap-credential": "bootstrapCredential"
};

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value.$date) return new Date(value.$date).getTime();
  if (typeof value === "object" && typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMissingCollectionError(err) {
  return /collection not exists|table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(String(err && err.message || err || ""));
}

function isMissingDocumentError(err) {
  return /does not exist|document not exist|DOCUMENT_NOT_FOUND|not found/i.test(String(err && err.message || err || ""));
}

function isExistingCollectionError(err) {
  return /already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist/i.test(String(err && err.message || err || ""));
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    if (isExistingCollectionError(err)) return;
    if (/createCollection is not a function/i.test(String(err && err.message || err || ""))) return;
    throw err;
  }
}

async function ensureAuthCollections() {
  for (const name of [COLLECTIONS.credentials, COLLECTIONS.sessions, COLLECTIONS.attempts, COLLECTIONS.securityLogs]) {
    await ensureCollection(name);
  }
}

async function getDocumentOrNull(collection, id, source = db) {
  if (!id) return null;
  try {
    const result = await source.collection(collection).doc(id).get();
    return result && result.data || null;
  } catch (err) {
    if (isMissingDocumentError(err) || isMissingCollectionError(err)) return null;
    throw err;
  }
}

function isHttpEvent(event = {}) {
  return Boolean(event.httpMethod || event.rawPath || event.requestContext && (event.requestContext.http || event.requestContext.requestId));
}

function parseJsonBody(event = {}) {
  if (event.body === undefined || event.body === "") return {};
  if (typeof event.body === "object") return parseObject(event.body, { label: "请求内容" });
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : String(event.body);
    const parsed = JSON.parse(raw);
    return parseObject(parsed, { label: "请求内容" });
  } catch (err) {
    if (err instanceof RequestValidationError) throw err;
    throw new AuthError("INVALID_JSON", "请求内容不是有效 JSON", 400);
  }
}

function normalizeAction(value) {
  const key = cleanString(value, 80).replace(/^\/+|\/+$/g, "").split("/").pop().toLowerCase();
  return ACTION_ALIASES[key] || "";
}

function buildRequest(event = {}) {
  const http = isHttpEvent(event);
  const headers = normalizeHeaders(event.headers || {});
  const requestId = normalizeRequestId(headers["x-request-id"], () => crypto.randomUUID());
  if (Array.isArray(event.cookies) && !headers.cookie) headers.cookie = event.cookies.join("; ");
  const body = http
    ? parseJsonBody(event)
    : Object.hasOwn(event, "data")
      ? parseObject(event.data, { label: "请求内容" })
      : Object.hasOwn(event, "payload")
        ? parseObject(event.payload, { label: "请求内容" })
        : parseObject(event, { label: "请求内容" });
  const path = cleanString(event.rawPath || event.path || event.requestContext && event.requestContext.http && event.requestContext.http.path, 300);
  const action = normalizeAction(body.action || event.action || path);
  const forwardedIp = cleanString(headers["x-forwarded-for"], 200).split(",")[0].trim();
  const sourceIp = forwardedIp
    || cleanString(event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp, 100)
    || cleanString(event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp, 100)
    || "unknown";
  const authorization = cleanString(headers.authorization || body.authorization, 4096);
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  return {
    http,
    method: cleanString(event.httpMethod || event.requestContext && event.requestContext.http && event.requestContext.http.method || (http ? "POST" : "ACTION"), 20).toUpperCase(),
    action,
    body,
    headers,
    cookies: parseCookies(headers.cookie || ""),
    origin: cleanString(headers.origin, 300),
    sourceIp,
    userAgent: cleanString(headers["user-agent"] || body.userAgent, 512),
    accessToken: bearer ? bearer[1].trim() : "",
    requestId
  };
}

function requestAuditContext(request, config) {
  return {
    ipHash: tokenHash(`ip:${request.sourceIp || "unknown"}`, config.tokenPepper),
    userAgentHash: tokenHash(`ua:${request.userAgent || "unknown"}`, config.tokenPepper),
    deviceLabel: sanitizeUserAgent(request.userAgent),
    originHash: tokenHash(`origin:${request.origin || "unknown"}`, config.tokenPepper)
  };
}

function assertRequestBoundary(request, config) {
  if (!config.allowInsecureActionTransport) {
    if (!config.actionSecret || config.actionSecret.length < 32) {
      throw new AuthError("ACTION_SECURITY_CONFIG_REQUIRED", "Action 调用安全配置不完整", 503);
    }
    const supplied = request.headers["x-admin-action-secret"] || "";
    if (!safeSecretEqual(supplied, config.actionSecret)) {
      throw new AuthError("ACTION_CALL_FORBIDDEN", "Action 调用未授权", 403);
    }
  }

  if (request.http) {
    if (!isOriginAllowed(request.origin, config.allowedOrigins)) {
      throw new AuthError("ORIGIN_NOT_ALLOWED", "请求来源不受信任", 403);
    }
  }
}

function responseHeaders(request, config) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  };
  if (request.requestId) headers["x-request-id"] = request.requestId;
  if (request.http && isOriginAllowed(request.origin, config.allowedOrigins)) {
    headers["access-control-allow-origin"] = request.origin;
    headers["access-control-allow-credentials"] = "true";
    headers["access-control-allow-methods"] = "GET,POST,OPTIONS";
    headers["access-control-allow-headers"] = "authorization,content-type,x-admin-csrf";
    headers.vary = "Origin";
  }
  return headers;
}

function formatResponse(request, config, payload, statusCode = 200, cookie = "", extraHeaders = {}) {
  const headers = { ...responseHeaders(request, config), ...extraHeaders };
  if (cookie) headers["set-cookie"] = cookie;
  if (request.http) {
    return { statusCode, headers, body: statusCode === 204 ? "" : JSON.stringify(payload) };
  }
  return { ...payload, statusCode, headers };
}

function failPayload(err, requestId) {
  const publicError = toPublicError(err, {
    trusted: err instanceof AuthError || err instanceof RequestValidationError,
    fallbackCode: "AUTH_OPERATION_FAILED",
    fallbackMessage: "认证操作失败，请稍后重试"
  });
  const serverTime = new Date().toISOString();
  const payload = {
    ok: false,
    code: publicError.code,
    category: publicError.category,
    message: publicError.message,
    requestId,
    serverTime,
    error: { code: publicError.code, category: publicError.category, message: publicError.message, requestId },
    meta: { requestId, serverTime }
  };
  if (err instanceof AuthError && err.details && err.details.retryAfterSeconds) {
    payload.retryAfterSeconds = err.details.retryAfterSeconds;
    payload.error.retryAfterSeconds = err.details.retryAfterSeconds;
  }
  return { payload, statusCode: publicError.statusCode };
}

async function writeSecurityLog(request, config, entry = {}, store = db) {
  const audit = requestAuditContext(request, config);
  const metadata = entry.metadata || {};
  await store.collection(COLLECTIONS.securityLogs).add({
    data: {
      requestId: cleanString(request && request.requestId, 128),
      eventType: cleanString(entry.eventType, 80),
      outcome: ["success", "failure", "blocked"].includes(entry.outcome) ? entry.outcome : "failure",
      code: cleanString(entry.code, 80),
      adminId: cleanString(entry.adminId, 128),
      sessionId: cleanString(entry.sessionId, 128),
      targetSessionId: cleanString(metadata.targetSessionId, 128),
      loginIdMasked: cleanString(entry.loginIdMasked, 80),
      role: cleanString(entry.role, 50),
      reason: cleanString(metadata.reason, 120),
      ipHash: audit.ipHash,
      userAgentHash: audit.userAgentHash,
      deviceLabel: audit.deviceLabel,
      originHash: audit.originHash,
      createdAt: store.serverDate()
    }
  });
}

async function getPrincipal(adminId) {
  const raw = await getDocumentOrNull(COLLECTIONS.principals, adminId);
  return normalizePrincipal(raw);
}

async function getCredentialByLoginHash(loginIdHash) {
  const result = await db.collection(COLLECTIONS.credentials).where({ loginIdHash, status: "active" }).limit(1).get();
  return result.data && result.data[0] || null;
}

async function findSessionByHash(field, hash, source = db) {
  if (!hash) return null;
  const result = await source.collection(COLLECTIONS.sessions).where({ [field]: hash }).limit(1).get();
  return result.data && result.data[0] || null;
}

async function revokeSessionDocument(sessionId, reason, source = db) {
  if (!sessionId) return;
  const result = await source.collection(COLLECTIONS.sessions).doc(sessionId).update({
    data: {
      revokedAt: source.serverDate(),
      revokeReason: cleanString(reason, 120),
      accessTokenHash: "",
      refreshTokenHash: "",
      updatedAt: source.serverDate()
    }
  });
  if (!result || !result.stats || Number(result.stats.updated) !== 1) {
    throw new AuthError("SESSION_REVOCATION_NOT_CONFIRMED", "会话撤销写入未确认", 503);
  }
}

async function revokeAdminSessions(adminId, reason, excludeSessionId = "", source = db) {
  if (!adminId) return 0;
  let offset = 0;
  let revokedCount = 0;
  while (true) {
    const result = await source.collection(COLLECTIONS.sessions)
      .where({ adminId })
      .skip(offset)
      .limit(MAX_SESSION_ROWS)
      .get();
    const rows = result.data || [];
    const active = rows.filter((session) => !session.revokedAt && session._id !== excludeSessionId);
    for (const session of active) {
      await revokeSessionDocument(session._id, reason, source);
      revokedCount += 1;
    }
    offset += rows.length;
    if (rows.length < MAX_SESSION_ROWS) break;
  }
  return revokedCount;
}

function assertSessionLifetime(session, nowMs, requireAccessLifetime) {
  if (!session || session.revokedAt) throw new AuthError("SESSION_REVOKED", "登录状态已失效", 401);
  try {
    assertSessionIdleLifetime(session, nowMs);
  } catch (error) {
    throw new AuthError(error.code, error.message, error.statusCode);
  }
  if (toMillis(session.absoluteExpiresAt) <= nowMs || toMillis(session.refreshExpiresAt) <= nowMs) {
    throw new AuthError("SESSION_EXPIRED", "登录状态已过期", 401);
  }
  if (requireAccessLifetime && toMillis(session.accessExpiresAt) <= nowMs) {
    throw new AuthError("ACCESS_TOKEN_EXPIRED", "访问令牌已过期", 401);
  }
}

async function validateSessionPrincipal(session, request, config) {
  const principal = await getPrincipal(session.adminId);
  if (!principal) {
    await revokeAdminSessions(session.adminId, "PRINCIPAL_DISABLED_OR_INVALID");
    await writeSecurityLog(request, config, {
      eventType: "session.principal_invalid",
      outcome: "blocked",
      code: "PRINCIPAL_DISABLED_OR_INVALID",
      adminId: session.adminId,
      sessionId: session._id
    });
    throw new AuthError("ACCOUNT_UNAVAILABLE", "管理员账号不可用", 401);
  }
  const currentFingerprint = principalFingerprint(principal);
  if (!session.principalFingerprint || session.principalFingerprint !== currentFingerprint) {
    await revokeAdminSessions(session.adminId, "PRINCIPAL_CHANGED");
    await writeSecurityLog(request, config, {
      eventType: "session.principal_changed",
      outcome: "blocked",
      code: "PRINCIPAL_CHANGED",
      adminId: session.adminId,
      sessionId: session._id,
      role: principal.role
    });
    throw new AuthError("SESSION_STALE", "管理员权限已变更，请重新登录", 401);
  }
  return principal;
}

async function requireAccessSession(request, config) {
  if (!request.accessToken) throw new AuthError("ACCESS_TOKEN_REQUIRED", "缺少访问令牌", 401);
  const accessTokenHash = tokenHash(request.accessToken, config.tokenPepper);
  const session = await findSessionByHash("accessTokenHash", accessTokenHash);
  assertSessionLifetime(session, Date.now(), true);
  const principal = await validateSessionPrincipal(session, request, config);
  await db.collection(COLLECTIONS.sessions).doc(session._id).update({
    data: { lastActivityAt: db.serverDate(), updatedAt: db.serverDate() }
  }).catch(() => {});
  return { session, principal };
}

function csrfTokenFromRequest(request) {
  if (request.http) return cleanString(request.headers["x-admin-csrf"], 512);
  return cleanString(request.headers["x-admin-csrf"] || request.body.csrfToken, 512);
}

function assertCsrf(session, request, config) {
  const supplied = csrfTokenFromRequest(request);
  if (!isCsrfTokenValid(supplied, session && session.csrfTokenHash, config.tokenPepper)) {
    throw new AuthError("CSRF_VALIDATION_FAILED", "请求校验失败", 403);
  }
}

function sessionPublicView(session, currentSessionId) {
  return {
    id: session._id,
    current: session._id === currentSessionId,
    device: cleanString(session.deviceLabel || "Browser", 40),
    createdAt: session.createdAt || null,
    lastActivityAt: session.lastActivityAt || null,
    expiresAt: session.refreshExpiresAt || null,
    revoked: Boolean(session.revokedAt)
  };
}

function credentialSecurityFingerprint(credential) {
  if (!credential) return "";
  const params = credential.passwordParams || {};
  return JSON.stringify({
    id: cleanString(credential._id, 128),
    adminId: cleanString(credential.adminId, 128),
    loginIdHash: cleanString(credential.loginIdHash, 128),
    status: cleanString(credential.status, 30),
    passwordAlgorithm: cleanString(credential.passwordAlgorithm, 30),
    passwordHash: cleanString(credential.passwordHash, 256),
    passwordSalt: cleanString(credential.passwordSalt, 256),
    passwordVersion: Math.max(0, Number(credential.passwordVersion || 0)),
    passwordParams: {
      N: Number(params.N || 0),
      r: Number(params.r || 0),
      p: Number(params.p || 0),
      keyLength: Number(params.keyLength || 0),
      maxmem: Number(params.maxmem || 0)
    }
  });
}

async function createSessionForVerifiedCredential(verifiedCredential, verifiedPrincipal, request, config, source = db) {
  const now = Date.now();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const csrfToken = randomToken();
  const audit = requestAuditContext(request, config);
  const systemSettings = source && typeof source.collection === "function"
    ? await getDocumentOrNull("settings", "system_settings", source)
    : null;
  const idleTimeoutMinutes = readSessionIdleMinutes(systemSettings || {});
  const credentialId = cleanString(verifiedCredential && verifiedCredential._id, 128);
  const verifiedCredentialFingerprint = credentialSecurityFingerprint(verifiedCredential);
  const verifiedPrincipalFingerprint = principalFingerprint(verifiedPrincipal);
  if (!credentialId || !verifiedCredentialFingerprint || !verifiedPrincipalFingerprint) {
    throw new AuthError("LOGIN_STATE_CHANGED", "登录凭证状态已变更，请重新输入密码后重试", 409);
  }

  return source.runTransaction(async (transaction) => {
    const currentCredential = await getDocumentOrNull(COLLECTIONS.credentials, credentialId, transaction);
    if (!currentCredential
      || currentCredential.status !== "active"
      || !safeSecretEqual(credentialSecurityFingerprint(currentCredential), verifiedCredentialFingerprint)) {
      throw new AuthError("LOGIN_STATE_CHANGED", "登录凭证状态已变更，请重新输入密码后重试", 409);
    }

    const rawPrincipal = await getDocumentOrNull(COLLECTIONS.principals, currentCredential.adminId, transaction);
    const principal = normalizePrincipal(rawPrincipal);
    if (!principal) throw new AuthError("ACCOUNT_UNAVAILABLE", "管理员账号不可用", 401);
    if (principal.id !== verifiedPrincipal.id
      || !safeSecretEqual(principalFingerprint(principal), verifiedPrincipalFingerprint)) {
      throw new AuthError("LOGIN_STATE_CHANGED", "管理员状态已变更，请重试登录", 409);
    }

    const data = {
      adminId: principal.id,
      accessTokenHash: tokenHash(accessToken, config.tokenPepper),
      refreshTokenHash: tokenHash(refreshToken, config.tokenPepper),
      usedRefreshTokenHashes: [],
      csrfTokenHash: tokenHash(csrfToken, config.tokenPepper),
      principalFingerprint: principalFingerprint(principal),
      roleSnapshot: principal.role,
      authVersionSnapshot: principal.authVersion,
      deviceLabel: audit.deviceLabel,
      ipHash: audit.ipHash,
      userAgentHash: audit.userAgentHash,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      lastActivityAt: new Date(now),
      idleTimeoutMinutes,
      accessExpiresAt: new Date(now + config.accessTtlMs),
      refreshExpiresAt: new Date(now + config.refreshTtlMs),
      absoluteExpiresAt: new Date(now + config.absoluteTtlMs),
      revokedAt: null,
      revokeReason: ""
    };
    const created = await transaction.collection(COLLECTIONS.sessions).add({ data });
    if (!created || !created._id) throw new AuthError("SESSION_WRITE_NOT_CONFIRMED", "登录会话写入未确认", 503);
    return {
      session: { _id: created._id, ...data },
      principal,
      accessToken,
      refreshToken,
      csrfToken
    };
  });
}

function rateDocumentId(scope, keyHash, config) {
  return `rl_${tokenHash(`${scope}:${keyHash}`, config.tokenPepper).slice(0, 28)}`;
}

async function readRateRecord(scope, keyHash, config) {
  return getDocumentOrNull(COLLECTIONS.attempts, rateDocumentId(scope, keyHash, config));
}

async function assertNotRateLimited(loginIdHash, ipHash, config) {
  const now = Date.now();
  const records = await Promise.all([
    readRateRecord("account", loginIdHash, config),
    readRateRecord("ip", ipHash, config)
  ]);
  const lockedUntil = Math.max(...records.map((record) => toMillis(record && record.lockedUntil)));
  if (lockedUntil > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
    throw new AuthError("RATE_LIMITED", "登录尝试过于频繁，请稍后重试", 429, { retryAfterSeconds });
  }
}

async function recordRateFailure(scope, keyHash, rule, config) {
  const id = rateDocumentId(scope, keyHash, config);
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const current = await getDocumentOrNull(COLLECTIONS.attempts, id, transaction);
    const inWindow = current && now - toMillis(current.windowStartedAt) <= rule.windowMs;
    const count = inWindow ? Number(current.count || 0) + 1 : 1;
    const data = {
      scope,
      keyHash,
      count,
      windowStartedAt: inWindow ? current.windowStartedAt : new Date(now),
      lastFailedAt: new Date(now),
      lockedUntil: count >= rule.maxAttempts ? new Date(now + rule.lockMs) : null,
      expiresAt: new Date(now + Math.max(rule.windowMs, rule.lockMs) * 2),
      updatedAt: new Date(now)
    };
    await transaction.collection(COLLECTIONS.attempts).doc(id).set({ data });
  });
}

async function recordLoginFailure(loginIdHash, ipHash, config) {
  await recordRateFailure("account", loginIdHash, ACCOUNT_RATE_LIMIT, config);
  await recordRateFailure("ip", ipHash, IP_RATE_LIMIT, config);
}

async function clearAccountRateLimit(loginIdHash, config) {
  await db.collection(COLLECTIONS.attempts).doc(rateDocumentId("account", loginIdHash, config)).remove().catch(() => {});
}

async function handleLogin(request, config) {
  const loginId = normalizeLoginId(request.body.loginId || request.body.account || request.body.phone);
  const loginIdMasked = maskLoginId(loginId);
  const password = String(request.body.password || "");
  const loginIdHash = tokenHash(`login:${loginId}`, config.tokenPepper);
  const audit = requestAuditContext(request, config);

  try {
    await assertNotRateLimited(loginIdHash, audit.ipHash, config);
  } catch (err) {
    await writeSecurityLog(request, config, {
      eventType: "login.rate_limited",
      outcome: "blocked",
      code: err.code,
      loginIdMasked
    });
    throw err;
  }

  const credential = await getCredentialByLoginHash(loginIdHash);
  const passwordRecord = credential ? {
    algorithm: credential.passwordAlgorithm,
    hash: credential.passwordHash,
    salt: credential.passwordSalt,
    params: credential.passwordParams
  } : null;
  const passwordValid = credential
    ? await verifyPassword(password, passwordRecord, config.passwordPepper)
    : (await runDummyPasswordHash(password, config.passwordPepper, DEFAULT_SCRYPT_PARAMS), false);

  if (!credential || !passwordValid) {
    await recordLoginFailure(loginIdHash, audit.ipHash, config);
    await writeSecurityLog(request, config, {
      eventType: "login.failed",
      outcome: "failure",
      code: "INVALID_CREDENTIALS",
      loginIdMasked
    });
    throw new AuthError("INVALID_CREDENTIALS", "账号或密码错误", 401);
  }

  const principal = await getPrincipal(credential.adminId);
  if (!principal) {
    await recordLoginFailure(loginIdHash, audit.ipHash, config);
    await writeSecurityLog(request, config, {
      eventType: "login.principal_unavailable",
      outcome: "blocked",
      code: "ACCOUNT_UNAVAILABLE",
      adminId: credential.adminId,
      loginIdMasked
    });
    throw new AuthError("ACCOUNT_UNAVAILABLE", "管理员账号不可用", 401);
  }

  let issued;
  try {
    issued = await createSessionForVerifiedCredential(credential, principal, request, config);
  } catch (err) {
    if (err instanceof AuthError && err.code === "ACCOUNT_UNAVAILABLE") {
      await recordLoginFailure(loginIdHash, audit.ipHash, config);
    }
    if (err instanceof AuthError && ["ACCOUNT_UNAVAILABLE", "LOGIN_STATE_CHANGED"].includes(err.code)) {
      await writeSecurityLog(request, config, {
        eventType: err.code === "LOGIN_STATE_CHANGED" ? "login.state_changed" : "login.principal_unavailable",
        outcome: "blocked",
        code: err.code,
        adminId: credential.adminId,
        loginIdMasked
      });
    }
    throw err;
  }

  await clearAccountRateLimit(loginIdHash, config);
  const activePrincipal = issued.principal;
  await Promise.all([
    db.collection(COLLECTIONS.credentials).doc(credential._id).update({
      data: { lastUsedAt: db.serverDate(), updatedAt: db.serverDate() }
    }).catch(() => {}),
    db.collection(COLLECTIONS.principals).doc(activePrincipal.id).update({
      data: { lastLoginAt: db.serverDate(), lastWebLoginAt: db.serverDate(), updatedAt: db.serverDate() }
    }).catch(() => {})
  ]);
  await writeSecurityLog(request, config, {
    eventType: "login.succeeded",
    outcome: "success",
    code: "OK",
    adminId: activePrincipal.id,
    sessionId: issued.session._id,
    loginIdMasked,
    role: activePrincipal.role
  });

  return {
    data: {
      accessToken: issued.accessToken,
      accessExpiresAt: issued.session.accessExpiresAt,
      csrfToken: issued.csrfToken,
      sessionId: issued.session._id,
      profile: publicPrincipal(activePrincipal)
    },
    cookie: createRefreshCookie(issued.refreshToken, config.refreshTtlMs / 1000)
  };
}

async function findRefreshSession(refreshHash) {
  const current = await findSessionByHash("refreshTokenHash", refreshHash);
  if (current) return { session: current, reused: false };
  const reused = await findSessionByHash("usedRefreshTokenHashes", refreshHash).catch(() => null);
  return { session: reused, reused: Boolean(reused) };
}

async function rotateSession(session, suppliedRefreshHash, request, config) {
  const now = Date.now();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const csrfToken = randomToken();
  const nextAccessHash = tokenHash(accessToken, config.tokenPepper);
  const nextRefreshHash = tokenHash(refreshToken, config.tokenPepper);
  const nextCsrfHash = tokenHash(csrfToken, config.tokenPepper);
  const absoluteExpiresAt = toMillis(session.absoluteExpiresAt);
  const refreshExpiresAt = Math.min(now + config.refreshTtlMs, absoluteExpiresAt);
  const systemSettings = await getDocumentOrNull("settings", "system_settings", db);
  const idleTimeoutMinutes = readSessionIdleMinutes(systemSettings || {});

  await db.runTransaction(async (transaction) => {
    const current = await getDocumentOrNull(COLLECTIONS.sessions, session._id, transaction);
    if (!current || current.revokedAt || current.refreshTokenHash !== suppliedRefreshHash) {
      throw new AuthError("REFRESH_TOKEN_REUSED", "刷新会话已失效", 401);
    }
    const used = Array.isArray(current.usedRefreshTokenHashes) ? current.usedRefreshTokenHashes.slice(-MAX_USED_REFRESH_HASHES + 1) : [];
    used.push(suppliedRefreshHash);
    await transaction.collection(COLLECTIONS.sessions).doc(session._id).update({
      data: {
        accessTokenHash: nextAccessHash,
        refreshTokenHash: nextRefreshHash,
        usedRefreshTokenHashes: used,
        csrfTokenHash: nextCsrfHash,
        accessExpiresAt: new Date(now + config.accessTtlMs),
        refreshExpiresAt: new Date(refreshExpiresAt),
        lastActivityAt: new Date(now),
        idleTimeoutMinutes,
        updatedAt: new Date(now)
      }
    });
  });

  return {
    accessToken,
    refreshToken,
    csrfToken,
    accessExpiresAt: new Date(now + config.accessTtlMs),
    refreshExpiresAt: new Date(refreshExpiresAt)
  };
}

async function handleRefresh(request, config) {
  const refreshToken = request.cookies[REFRESH_COOKIE_NAME] || "";
  if (!refreshToken) throw new AuthError("REFRESH_TOKEN_REQUIRED", "缺少刷新会话", 401);
  const refreshHash = tokenHash(refreshToken, config.tokenPepper);
  const found = await findRefreshSession(refreshHash);
  if (found.reused && found.session) {
    await revokeAdminSessions(found.session.adminId, "REFRESH_TOKEN_REUSE");
    await writeSecurityLog(request, config, {
      eventType: "session.refresh_reuse",
      outcome: "blocked",
      code: "REFRESH_TOKEN_REUSED",
      adminId: found.session.adminId,
      sessionId: found.session._id
    });
    throw new AuthError("REFRESH_TOKEN_REUSED", "刷新会话已失效", 401);
  }
  const session = found.session;
  assertSessionLifetime(session, Date.now(), false);
  assertCsrf(session, request, config);
  const principal = await validateSessionPrincipal(session, request, config);

  let rotated;
  try {
    rotated = await rotateSession(session, refreshHash, request, config);
  } catch (err) {
    if (err instanceof AuthError && err.code === "REFRESH_TOKEN_REUSED") {
      await revokeAdminSessions(session.adminId, "REFRESH_TOKEN_REUSE");
    }
    throw err;
  }
  await writeSecurityLog(request, config, {
    eventType: "session.refreshed",
    outcome: "success",
    code: "OK",
    adminId: principal.id,
    sessionId: session._id,
    role: principal.role
  });
  const maxAgeSeconds = Math.max(0, Math.floor((toMillis(rotated.refreshExpiresAt) - Date.now()) / 1000));
  return {
    data: {
      accessToken: rotated.accessToken,
      accessExpiresAt: rotated.accessExpiresAt,
      csrfToken: rotated.csrfToken,
      sessionId: session._id,
      profile: publicPrincipal(principal)
    },
    cookie: createRefreshCookie(rotated.refreshToken, maxAgeSeconds)
  };
}

async function findLogoutSession(request, config) {
  if (request.accessToken) {
    const byAccess = await findSessionByHash("accessTokenHash", tokenHash(request.accessToken, config.tokenPepper));
    if (byAccess) return byAccess;
  }
  const refreshToken = request.cookies[REFRESH_COOKIE_NAME] || "";
  if (!refreshToken) return null;
  return findSessionByHash("refreshTokenHash", tokenHash(refreshToken, config.tokenPepper));
}

async function handleLogout(request, config) {
  const session = await findLogoutSession(request, config);
  if (session) {
    assertCsrf(session, request, config);
    await revokeSessionDocument(session._id, "LOGOUT");
    await writeSecurityLog(request, config, {
      eventType: "session.logout",
      outcome: "success",
      code: "OK",
      adminId: session.adminId,
      sessionId: session._id
    });
  }
  return { data: { loggedOut: true }, cookie: clearRefreshCookie() };
}

async function handleProfile(request, config) {
  const { session, principal } = await requireAccessSession(request, config);
  return {
    data: {
      sessionId: session._id,
      accessExpiresAt: session.accessExpiresAt,
      profile: publicPrincipal(principal)
    }
  };
}

async function handleListSessions(request, config) {
  const { session, principal } = await requireAccessSession(request, config);
  const result = await db.collection(COLLECTIONS.sessions).where({ adminId: principal.id }).limit(MAX_SESSION_ROWS).get();
  const sessions = (result.data || [])
    .filter((row) => toMillis(row.absoluteExpiresAt) > Date.now())
    .sort((a, b) => toMillis(b.lastActivityAt) - toMillis(a.lastActivityAt))
    .map((row) => sessionPublicView(row, session._id));
  return { data: { sessions } };
}

async function handleRevokeSession(request, config) {
  const { session, principal } = await requireAccessSession(request, config);
  assertRevokeSessionCsrf(session, request, config);
  const targetSessionId = cleanString(request.body.sessionId, 128);
  if (!targetSessionId) throw new AuthError("SESSION_ID_REQUIRED", "缺少会话 ID", 400);
  const target = await getDocumentOrNull(COLLECTIONS.sessions, targetSessionId);
  if (!target || target.adminId !== principal.id) throw new AuthError("SESSION_NOT_FOUND", "会话不存在", 404);
  await revokeSessionDocument(targetSessionId, "USER_REVOKED");
  await writeSecurityLog(request, config, {
    eventType: "session.revoked",
    outcome: "success",
    code: "OK",
    adminId: principal.id,
    sessionId: session._id,
    role: principal.role,
    metadata: { targetSessionId, reason: "USER_REVOKED" }
  });
  return {
    data: { sessionId: targetSessionId, revoked: true },
    cookie: targetSessionId === session._id ? clearRefreshCookie() : ""
  };
}

function assertRevokeSessionCsrf(session, request, config) {
  assertCsrf(session, request, config);
}

function credentialDocumentId(loginIdHash) {
  return `cred_${loginIdHash.slice(0, 27)}`;
}

function assertBootstrapAllowed(request, config) {
  if (!config.bootstrapEnabled) throw new AuthError("BOOTSTRAP_DISABLED", "管理员凭证初始化未启用", 403);
  if (config.remoteLike && config.bootstrapSecret.length < 32) {
    throw new AuthError("BOOTSTRAP_SECURITY_CONFIG_REQUIRED", "管理员凭证初始化配置不完整", 503);
  }
  const supplied = request.headers["x-admin-bootstrap-secret"]
    || (config.remoteLike ? "" : request.body.bootstrapSecret)
    || "";
  if (!config.bootstrapSecret || !safeSecretEqual(supplied, config.bootstrapSecret)) {
    throw new AuthError("BOOTSTRAP_FORBIDDEN", "管理员凭证初始化未授权", 403);
  }
}

function credentialIdentity(credential) {
  return cleanString(credential && credential._id, 128)
    || credentialDocumentId(cleanString(credential && credential.loginIdHash, 128));
}

function assertCredentialWriteAllowed(existing, activeCredentials, loginIdHash, adminId, rotate) {
  const active = Array.isArray(activeCredentials) ? activeCredentials : [];
  if (existing && existing.loginIdHash !== loginIdHash) throw new AuthError("CREDENTIAL_CONFLICT", "账号凭证冲突", 409);
  if (existing && existing.adminId !== adminId) throw new AuthError("LOGIN_ID_IN_USE", "该账号已被占用", 409);
  if (rotate) {
    if (!existing || existing.status !== "active") {
      if (active.length) throw new AuthError("ROTATION_LOGIN_ID_MISMATCH", "密码轮换必须使用管理员当前登录账号", 409);
      throw new AuthError("ACTIVE_CREDENTIAL_NOT_FOUND", "管理员当前没有可轮换的登录凭证", 409);
    }
    if (active.length !== 1 || credentialIdentity(active[0]) !== credentialIdentity(existing)) {
      throw new AuthError("ADMIN_CREDENTIAL_CONFLICT", "管理员存在冲突的登录凭证，请先处理凭证数据", 409);
    }
    return;
  }
  if (existing) throw new AuthError("CREDENTIAL_EXISTS", "管理员凭证已存在", 409);
  if (active.length) throw new AuthError("ADMIN_CREDENTIAL_EXISTS", "管理员已绑定登录账号，不能重复初始化", 409);
}

async function persistCredentialAndAuthVersion(params, source = db) {
  const {
    adminId,
    loginIdHash,
    loginIdMasked,
    passwordRecord,
    rotate
  } = params;
  const documentId = credentialDocumentId(loginIdHash);
  return source.runTransaction(async (transaction) => {
    const rawPrincipal = await getDocumentOrNull(COLLECTIONS.principals, adminId, transaction);
    const principal = normalizePrincipal(rawPrincipal);
    if (!principal) throw new AuthError("ADMIN_NOT_AVAILABLE", "管理员不存在、已禁用或角色非法", 400);

    const existing = await getDocumentOrNull(COLLECTIONS.credentials, documentId, transaction);
    const activeResult = await transaction.collection(COLLECTIONS.credentials)
      .where({ adminId, status: "active" })
      .limit(2)
      .get();
    const activeCredentials = activeResult.data || [];
    assertCredentialWriteAllowed(existing, activeCredentials, loginIdHash, adminId, rotate);
    const now = source.serverDate();
    const passwordVersion = Math.max(1, Number(existing && existing.passwordVersion || 0) + 1);
    await transaction.collection(COLLECTIONS.credentials).doc(documentId).set({
      data: {
        adminId,
        loginIdHash,
        loginIdMasked,
        passwordAlgorithm: passwordRecord.algorithm,
        passwordHash: passwordRecord.hash,
        passwordSalt: passwordRecord.salt,
        passwordParams: passwordRecord.params,
        passwordVersion,
        status: "active",
        createdAt: existing && existing.createdAt || now,
        updatedAt: now,
        lastUsedAt: existing && existing.lastUsedAt || null
      }
    });
    await transaction.collection(COLLECTIONS.principals).doc(adminId).update({
      data: { authVersion: _.inc(1), updatedAt: source.serverDate() }
    });
    return { principal, existing, passwordVersion };
  });
}

async function handleBootstrapCredential(request, config) {
  assertBootstrapAllowed(request, config);
  await ensureAuthCollections();
  const adminId = cleanString(request.body.adminId, 128);
  if (!adminId) throw new AuthError("ADMIN_ID_REQUIRED", "缺少管理员 ID", 400);
  const principal = await getPrincipal(adminId);
  if (!principal) throw new AuthError("ADMIN_NOT_AVAILABLE", "管理员不存在、已禁用或角色非法", 400);
  const loginId = normalizeLoginId(request.body.loginId || request.body.account || request.body.phone);
  const loginIdMasked = maskLoginId(loginId);
  const loginIdHash = tokenHash(`login:${loginId}`, config.tokenPepper);
  const rotate = request.body.rotate === true;

  const passwordRecord = await createPasswordRecord(request.body.password, config.passwordPepper);
  const state = await persistCredentialAndAuthVersion({
    adminId,
    loginIdHash,
    loginIdMasked,
    passwordRecord,
    rotate
  });
  const revocationReason = rotate ? "PASSWORD_ROTATED" : "CREDENTIAL_BOOTSTRAPPED";
  try {
    await revokeAdminSessions(adminId, revocationReason);
  } catch (err) {
    console.error("adminWebAuth session cleanup failed", cleanString(err && err.message, 160));
    await writeSecurityLog(request, config, {
      eventType: "credential.session_cleanup_failed",
      outcome: "failure",
      code: "CREDENTIAL_UPDATED_SESSION_CLEANUP_FAILED",
      adminId,
      loginIdMasked,
      role: state.principal.role,
      metadata: { reason: revocationReason }
    });
    throw new AuthError(
      "CREDENTIAL_UPDATED_SESSION_CLEANUP_FAILED",
      "凭证已更新，旧会话已通过版本变更失效，但撤销记录未完全写入",
      503
    );
  }
  await writeSecurityLog(request, config, {
    eventType: rotate ? "credential.rotated" : "credential.bootstrapped",
    outcome: "success",
    code: "OK",
    adminId,
    loginIdMasked,
    role: state.principal.role
  });

  return {
    data: {
      adminId,
      loginIdMasked,
      passwordVersion: state.passwordVersion,
      rotated: Boolean(state.existing)
    }
  };
}

function assertMethod(request, allowed) {
  if (!request.http || request.method === "ACTION") return;
  if (!allowed.includes(request.method)) throw new AuthError("METHOD_NOT_ALLOWED", "请求方法不受支持", 405);
}

async function dispatch(request, config) {
  switch (request.action) {
    case "login":
      assertMethod(request, ["POST"]);
      return handleLogin(request, config);
    case "refresh":
      assertMethod(request, ["POST"]);
      return handleRefresh(request, config);
    case "logout":
      assertMethod(request, ["POST"]);
      return handleLogout(request, config);
    case "profile":
      assertMethod(request, ["GET", "POST"]);
      return handleProfile(request, config);
    case "revokeSession":
      assertMethod(request, ["POST"]);
      return handleRevokeSession(request, config);
    case "listSessions":
      assertMethod(request, ["GET", "POST"]);
      return handleListSessions(request, config);
    case "bootstrapCredential":
      assertMethod(request, ["POST"]);
      return handleBootstrapCredential(request, config);
    default:
      throw new AuthError("UNKNOWN_ACTION", "未知认证操作", 404);
  }
}

exports.main = async (event = {}) => {
  let request;
  let config;
  try {
    config = loadSecurityConfig(process.env);
    request = buildRequest(event);
    if (request.http && request.method === "OPTIONS") {
      assertRequestBoundary(request, config);
      return formatResponse(request, config, {}, 204);
    }
    assertRequestBoundary(request, config);
    const result = await dispatch(request, config);
    return formatResponse(request, config, { ok: true, data: result.data }, 200, result.cookie || "");
  } catch (err) {
    if (!(err instanceof AuthError) && isMissingCollectionError(err)) {
      err = new AuthError("AUTH_STORAGE_NOT_READY", "管理员认证存储尚未初始化", 503);
    }
    config = config || (() => {
      try {
        return loadSecurityConfig({ ADMIN_WEB_ENV: "unit-test" });
      } catch (ignored) {
        return { allowedOrigins: [], tokenPepper: "", passwordPepper: "", testLike: false };
      }
    })();
    request = request || {
      http: isHttpEvent(event),
      origin: "",
      headers: {},
      body: {},
      sourceIp: "unknown",
      userAgent: "",
      requestId: normalizeRequestId(normalizeHeaders(event.headers || {})["x-request-id"], () => crypto.randomUUID())
    };
    const failure = failPayload(err, request.requestId);
    if (!(err instanceof AuthError) && !(err instanceof RequestValidationError)) {
      console.error("adminWebAuth failed", cleanString(err && err.message, 160));
    }
    const retryHeaders = failure.payload.retryAfterSeconds
      ? { "retry-after": String(failure.payload.retryAfterSeconds) }
      : {};
    const clearCookie = ["SESSION_REVOKED", "SESSION_EXPIRED", "SESSION_STALE", "ACCOUNT_UNAVAILABLE", "REFRESH_TOKEN_REUSED"].includes(failure.payload.code)
      ? clearRefreshCookie()
      : "";
    return formatResponse(request, config, failure.payload, failure.statusCode, clearCookie, retryHeaders);
  }
};

exports._test = {
  buildRequest,
  normalizeAction,
  toMillis,
  sessionPublicView,
  credentialDocumentId,
  assertRequestBoundary,
  responseHeaders,
  assertCsrf,
  assertRevokeSessionCsrf,
  assertBootstrapAllowed,
  revokeSessionDocument,
  revokeAdminSessions,
  persistCredentialAndAuthVersion,
  credentialSecurityFingerprint,
  createSessionForVerifiedCredential,
  writeSecurityLog
};
