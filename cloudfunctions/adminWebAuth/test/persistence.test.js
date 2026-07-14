const test = require("node:test");
const assert = require("node:assert/strict");
const {
  revokeSessionDocument,
  revokeAdminSessions,
  persistCredentialAndAuthVersion,
  createSessionForVerifiedCredential
} = require("../index")._test;
const { loadSecurityConfig, normalizePrincipal } = require("../security");

function createSessionDatabase(rows, failSessionId = "") {
  const updates = [];
  return {
    updates,
    serverDate() {
      return "SERVER_DATE";
    },
    collection(name) {
      assert.equal(name, "admin_web_sessions");
      return {
        where(filter) {
          const matched = rows.filter((row) => row.adminId === filter.adminId);
          let offset = 0;
          let limit = 100;
          const query = {
            skip(value) {
              offset = value;
              return query;
            },
            limit(value) {
              limit = value;
              return query;
            },
            async get() {
              return { data: matched.slice(offset, offset + limit) };
            }
          };
          return query;
        },
        doc(id) {
          return {
            async update(payload) {
              if (id === failSessionId) throw new Error("simulated session update failure");
              updates.push({ id, data: payload.data });
              return { stats: { updated: 1 } };
            }
          };
        }
      };
    }
  };
}

function createCredentialTransactionDatabase(options = {}) {
  const calls = [];
  const principal = options.principal || {
    _id: "admin-1",
    name: "Admin",
    role: "super_admin",
    isActive: true,
    authVersion: 4
  };
  const credential = options.credential || null;
  const activeCredentials = Object.hasOwn(options, "activeCredentials")
    ? options.activeCredentials
    : (credential && credential.status === "active" ? [credential] : []);
  const source = {
    calls,
    serverDate() {
      return "SERVER_DATE";
    },
    async runTransaction(callback) {
      calls.push("transaction.begin");
      const transaction = {
        collection(name) {
          const collection = {
            doc(id) {
              return {
                async get() {
                  calls.push(`get:${name}:${id}`);
                  if (name === "admin_users") return { data: principal };
                  if (name === "admin_web_credentials") return { data: credential };
                  return { data: null };
                },
                async set(payload) {
                  calls.push(`set:${name}:${id}`);
                  source.credentialWrite = payload.data;
                  // wx-server-sdk@4.0.2 transaction set can commit while both wrapper counters remain zero.
                  return { stats: { created: 0, updated: 0 } };
                },
                async update(payload) {
                  calls.push(`update:${name}:${id}`);
                  if (options.failPrincipalUpdate && name === "admin_users") {
                    throw new Error("simulated principal update failure");
                  }
                  source.principalWrite = payload.data;
                  return { stats: { updated: 1 } };
                }
              };
            },
            where(filter) {
              calls.push(`query:${name}:${filter.adminId}`);
              let maxRows = 100;
              return {
                limit(value) {
                  maxRows = value;
                  return this;
                },
                async get() {
                  return {
                    data: activeCredentials
                      .filter((item) => item.adminId === filter.adminId && item.status === filter.status)
                      .slice(0, maxRows)
                  };
                }
              };
            }
          };
          return collection;
        }
      };
      try {
        const result = await callback(transaction);
        calls.push("transaction.commit");
        return result;
      } catch (err) {
        calls.push("transaction.rollback");
        throw err;
      }
    }
  };
  return source;
}

function createConcurrentLoginDatabase(credential, principal) {
  let releaseFirstAdd;
  let signalFirstAdd;
  const firstAddReached = new Promise((resolve) => { signalFirstAdd = resolve; });
  const firstAddRelease = new Promise((resolve) => { releaseFirstAdd = resolve; });
  const state = {
    credential: { ...credential, passwordParams: { ...credential.passwordParams } },
    principal: { ...principal },
    revision: 0,
    attempts: 0,
    sessions: []
  };

  const source = {
    state,
    firstAddReached,
    releaseFirstAttempt() {
      releaseFirstAdd();
    },
    rotateCredential() {
      state.credential = {
        ...state.credential,
        passwordHash: "rotated-password-hash",
        passwordSalt: "rotated-password-salt",
        passwordVersion: Number(state.credential.passwordVersion || 0) + 1
      };
      state.principal = {
        ...state.principal,
        authVersion: Number(state.principal.authVersion || 0) + 1
      };
      state.revision += 1;
    },
    async runTransaction(callback) {
      while (state.attempts < 3) {
        state.attempts += 1;
        const attempt = state.attempts;
        const startRevision = state.revision;
        let pendingSession = null;
        const transaction = {
          collection(name) {
            if (name === "admin_web_sessions") {
              return {
                async add(payload) {
                  if (attempt === 1) {
                    signalFirstAdd();
                    await firstAddRelease;
                  }
                  pendingSession = { _id: `session-${attempt}`, ...payload.data };
                  return { _id: pendingSession._id };
                }
              };
            }
            return {
              doc() {
                return {
                  async get() {
                    if (name === "admin_web_credentials") {
                      return { data: { ...state.credential, passwordParams: { ...state.credential.passwordParams } } };
                    }
                    if (name === "admin_users") return { data: { ...state.principal } };
                    return { data: null };
                  }
                };
              }
            };
          }
        };
        const result = await callback(transaction);
        if (state.revision !== startRevision) continue;
        if (pendingSession) state.sessions.push(pendingSession);
        return result;
      }
      throw new Error("simulated transaction retry limit reached");
    }
  };
  return source;
}

function createConcurrentBootstrapDatabase() {
  let firstAttemptArrivals = 0;
  let releaseFirstAttempts;
  const firstAttemptsReady = new Promise((resolve) => { releaseFirstAttempts = resolve; });
  const state = {
    principal: {
      _id: "admin-1",
      name: "Admin",
      role: "super_admin",
      isActive: true,
      authVersion: 0
    },
    principalRevision: 0,
    credentials: new Map(),
    totalAttempts: 0,
    conflicts: 0,
    commits: 0
  };

  return {
    state,
    serverDate() {
      return "SERVER_DATE";
    },
    async runTransaction(callback) {
      let attempt = 0;
      while (attempt < 3) {
        attempt += 1;
        state.totalAttempts += 1;
        const startingPrincipalRevision = state.principalRevision;
        const principalSnapshot = { ...state.principal };
        const credentialSnapshot = new Map(Array.from(state.credentials, ([id, value]) => [id, { ...value }]));
        const stagedCredentials = new Map();
        let principalUpdatePending = false;
        const transaction = {
          collection(name) {
            const collection = {
              doc(id) {
                return {
                  async get() {
                    if (name === "admin_users") return { data: { ...principalSnapshot } };
                    if (name === "admin_web_credentials") {
                      return { data: credentialSnapshot.has(id) ? { ...credentialSnapshot.get(id) } : null };
                    }
                    return { data: null };
                  },
                  async set(payload) {
                    stagedCredentials.set(id, { _id: id, ...payload.data });
                    return { stats: { created: 0, updated: 0 } };
                  },
                  async update() {
                    if (name === "admin_users") {
                      principalUpdatePending = true;
                      if (attempt === 1) {
                        firstAttemptArrivals += 1;
                        if (firstAttemptArrivals === 2) releaseFirstAttempts();
                        await firstAttemptsReady;
                      }
                    }
                    return { stats: { updated: 1 } };
                  }
                };
              },
              where(filter) {
                let maxRows = 100;
                return {
                  limit(value) {
                    maxRows = value;
                    return this;
                  },
                  async get() {
                    return {
                      data: Array.from(credentialSnapshot.values())
                        .filter((item) => item.adminId === filter.adminId && item.status === filter.status)
                        .slice(0, maxRows)
                    };
                  }
                };
              }
            };
            return collection;
          }
        };

        const result = await callback(transaction);
        if (state.principalRevision !== startingPrincipalRevision) {
          state.conflicts += 1;
          continue;
        }
        for (const [id, credential] of stagedCredentials) state.credentials.set(id, credential);
        if (principalUpdatePending) {
          state.principal = { ...state.principal, authVersion: Number(state.principal.authVersion || 0) + 1 };
          state.principalRevision += 1;
        }
        state.commits += 1;
        return result;
      }
      throw new Error("simulated bootstrap transaction retry limit reached");
    }
  };
}

const PASSWORD_RECORD = {
  algorithm: "scrypt-v1",
  hash: "hash",
  salt: "salt",
  params: { N: 1024, r: 8, p: 1, keyLength: 32, maxmem: 8388608 }
};

const LOGIN_CREDENTIAL = {
  _id: "cred_login_1",
  adminId: "admin-1",
  loginIdHash: "l".repeat(64),
  status: "active",
  passwordAlgorithm: "scrypt-v1",
  passwordHash: "verified-password-hash",
  passwordSalt: "verified-password-salt",
  passwordVersion: 3,
  passwordParams: PASSWORD_RECORD.params
};

const LOGIN_PRINCIPAL = {
  _id: "admin-1",
  name: "Admin",
  role: "super_admin",
  isActive: true,
  authVersion: 4
};

test("session revocation propagates write failures", async () => {
  const source = createSessionDatabase([{ _id: "session-1", adminId: "admin-1", revokedAt: null }], "session-1");
  await assert.rejects(
    () => revokeSessionDocument("session-1", "LOGOUT", source),
    /simulated session update failure/
  );
});

test("session revocation rejects an unconfirmed zero-row update", async () => {
  const source = createSessionDatabase([{ _id: "session-1", adminId: "admin-1", revokedAt: null }]);
  source.collection = () => ({
    doc: () => ({ update: async () => ({ stats: { updated: 0 } }) })
  });
  await assert.rejects(
    () => revokeSessionDocument("session-1", "LOGOUT", source),
    (err) => err.code === "SESSION_REVOCATION_NOT_CONFIRMED" && err.statusCode === 503
  );
});

test("administrator session revocation paginates beyond the first 100 rows", async () => {
  const rows = Array.from({ length: 205 }, (_, index) => ({
    _id: `session-${index + 1}`,
    adminId: "admin-1",
    revokedAt: null
  }));
  rows[150].revokedAt = "already-revoked";
  rows.push({ _id: "other-admin-session", adminId: "admin-2", revokedAt: null });
  const source = createSessionDatabase(rows);

  const revoked = await revokeAdminSessions("admin-1", "PASSWORD_ROTATED", "session-205", source);

  assert.equal(revoked, 203);
  assert.equal(source.updates.length, 203);
  assert.equal(source.updates.some((entry) => entry.id === "session-151"), false);
  assert.equal(source.updates.some((entry) => entry.id === "session-205"), false);
  assert.equal(source.updates.some((entry) => entry.id === "other-admin-session"), false);
  assert.equal(source.updates.every((entry) => entry.data.revokeReason === "PASSWORD_ROTATED"), true);
});

test("credential and authVersion writes share one transaction without relying on set stats", async () => {
  const source = createCredentialTransactionDatabase();
  const result = await persistCredentialAndAuthVersion({
    adminId: "admin-1",
    loginIdHash: "a".repeat(64),
    loginIdMasked: "ad***n",
    passwordRecord: PASSWORD_RECORD,
    rotate: false
  }, source);

  assert.equal(result.passwordVersion, 1);
  assert.equal(source.credentialWrite.passwordVersion, 1);
  assert.equal(source.credentialWrite.adminId, "admin-1");
  assert.equal(Object.hasOwn(source.principalWrite, "authVersion"), true);
  assert.deepEqual(source.calls.map((call) => call.split(":")[0]), [
    "transaction.begin",
    "get",
    "get",
    "query",
    "set",
    "update",
    "transaction.commit"
  ]);
});

test("credential rotation increments the password version without resetting creation time", async () => {
  const loginIdHash = "c".repeat(64);
  const source = createCredentialTransactionDatabase({
    credential: {
      _id: `cred_${loginIdHash.slice(0, 27)}`,
      adminId: "admin-1",
      loginIdHash,
      status: "active",
      passwordVersion: 7,
      createdAt: "ORIGINAL_CREATED_AT",
      lastUsedAt: "LAST_USED_AT"
    }
  });
  const result = await persistCredentialAndAuthVersion({
    adminId: "admin-1",
    loginIdHash,
    loginIdMasked: "ad***n",
    passwordRecord: PASSWORD_RECORD,
    rotate: true
  }, source);

  assert.equal(result.passwordVersion, 8);
  assert.equal(Boolean(result.existing), true);
  assert.equal(source.credentialWrite.createdAt, "ORIGINAL_CREATED_AT");
  assert.equal(source.credentialWrite.lastUsedAt, "LAST_USED_AT");
});

test("bootstrap rejects a second active login identifier for the same administrator", async () => {
  const existingCredential = {
    _id: `cred_${"d".repeat(27)}`,
    adminId: "admin-1",
    loginIdHash: "d".repeat(64),
    status: "active"
  };
  const source = createCredentialTransactionDatabase({
    credential: null,
    activeCredentials: [existingCredential]
  });

  await assert.rejects(
    () => persistCredentialAndAuthVersion({
      adminId: "admin-1",
      loginIdHash: "e".repeat(64),
      loginIdMasked: "ne***w",
      passwordRecord: PASSWORD_RECORD,
      rotate: false
    }, source),
    (err) => err.code === "ADMIN_CREDENTIAL_EXISTS" && err.statusCode === 409
  );
  assert.equal(source.calls.some((call) => call.startsWith("set:")), false);
  assert.equal(source.calls.some((call) => call.startsWith("update:")), false);
});

test("concurrent first bootstraps serialize on principal and commit only one credential", async () => {
  const source = createConcurrentBootstrapDatabase();
  const first = persistCredentialAndAuthVersion({
    adminId: "admin-1",
    loginIdHash: "1".repeat(64),
    loginIdMasked: "fi***t",
    passwordRecord: PASSWORD_RECORD,
    rotate: false
  }, source);
  const second = persistCredentialAndAuthVersion({
    adminId: "admin-1",
    loginIdHash: "2".repeat(64),
    loginIdMasked: "se***d",
    passwordRecord: PASSWORD_RECORD,
    rotate: false
  }, source);

  const settled = await Promise.allSettled([first, second]);
  const fulfilled = settled.filter((result) => result.status === "fulfilled");
  const rejected = settled.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "ADMIN_CREDENTIAL_EXISTS");
  assert.equal(rejected[0].reason.statusCode, 409);
  assert.equal(source.state.credentials.size, 1);
  assert.equal(source.state.principal.authVersion, 1);
  assert.equal(source.state.principalRevision, 1);
  assert.equal(source.state.commits, 1);
  assert.equal(source.state.conflicts, 1);
  assert.equal(source.state.totalAttempts, 3);
});

test("password rotation cannot switch to a different login identifier", async () => {
  const existingCredential = {
    _id: `cred_${"f".repeat(27)}`,
    adminId: "admin-1",
    loginIdHash: "f".repeat(64),
    status: "active"
  };
  const source = createCredentialTransactionDatabase({
    credential: null,
    activeCredentials: [existingCredential]
  });

  await assert.rejects(
    () => persistCredentialAndAuthVersion({
      adminId: "admin-1",
      loginIdHash: "0".repeat(64),
      loginIdMasked: "ot***r",
      passwordRecord: PASSWORD_RECORD,
      rotate: true
    }, source),
    (err) => err.code === "ROTATION_LOGIN_ID_MISMATCH" && err.statusCode === 409
  );
  assert.equal(source.calls.some((call) => call.startsWith("set:")), false);
});

test("verified credential state can create a session in one committed transaction", async () => {
  const source = createConcurrentLoginDatabase(LOGIN_CREDENTIAL, LOGIN_PRINCIPAL);
  const config = loadSecurityConfig({ ADMIN_WEB_ENV: "unit-test" });
  const request = { sourceIp: "127.0.0.1", userAgent: "Test Browser", origin: "", headers: {}, body: {}, http: false };
  const issuedPromise = createSessionForVerifiedCredential(
    { ...LOGIN_CREDENTIAL, passwordParams: { ...LOGIN_CREDENTIAL.passwordParams } },
    normalizePrincipal(LOGIN_PRINCIPAL),
    request,
    config,
    source
  );

  await source.firstAddReached;
  source.releaseFirstAttempt();
  const issued = await issuedPromise;

  assert.equal(issued.session._id, "session-1");
  assert.equal(issued.session.authVersionSnapshot, 4);
  assert.equal(source.state.sessions.length, 1);
});

test("concurrent password rotation makes an old-password login transaction retry and fail", async () => {
  const source = createConcurrentLoginDatabase(LOGIN_CREDENTIAL, LOGIN_PRINCIPAL);
  const config = loadSecurityConfig({ ADMIN_WEB_ENV: "unit-test" });
  const request = { sourceIp: "127.0.0.1", userAgent: "Test Browser", origin: "", headers: {}, body: {}, http: false };
  const loginPromise = createSessionForVerifiedCredential(
    { ...LOGIN_CREDENTIAL, passwordParams: { ...LOGIN_CREDENTIAL.passwordParams } },
    normalizePrincipal(LOGIN_PRINCIPAL),
    request,
    config,
    source
  );
  const rejected = assert.rejects(
    loginPromise,
    (err) => err.code === "LOGIN_STATE_CHANGED" && err.statusCode === 409
  );

  await source.firstAddReached;
  source.rotateCredential();
  source.releaseFirstAttempt();
  await rejected;

  assert.equal(source.state.attempts, 2);
  assert.equal(source.state.sessions.length, 0);
});

test("credential transaction failure is propagated without a commit", async () => {
  const source = createCredentialTransactionDatabase({ failPrincipalUpdate: true });
  await assert.rejects(
    () => persistCredentialAndAuthVersion({
      adminId: "admin-1",
      loginIdHash: "b".repeat(64),
      loginIdMasked: "ad***n",
      passwordRecord: PASSWORD_RECORD,
      rotate: false
    }, source),
    /simulated principal update failure/
  );
  assert.equal(source.calls.includes("transaction.commit"), false);
  assert.equal(source.calls.at(-1), "transaction.rollback");
});
