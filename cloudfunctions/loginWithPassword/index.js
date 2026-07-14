const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOCK_DURATION_MS = 10 * 60 * 1000;
const failures = {};

const BACKEND_ONLY_ROLES = ["customer_service", "finance", "procurement"];
const FULL_ACCESS_ROLES = ["super_admin"];
const ROLE_NAMES = {
  user: "普通用户",
  customer_service: "客服",
  finance: "财务",
  procurement: "采购",
  super_admin: "超级管理员"
};

function normalizePhone(phone) {
  const value = String(phone || "").trim().replace(/[\s-]/g, "").replace(/^(\+?86|0086)/, "");
  if (!/^1[3-9]\d{9}$/.test(value)) throw new Error("INVALID_PHONE");
  return value;
}

function maskPhone(phone) {
  const value = String(phone || "").replace(/\D/g, "");
  const normalized = value.length > 11 ? value.slice(-11) : value;
  if (!/^1[3-9]\d{9}$/.test(normalized)) return "";
  return `${normalized.slice(0, 3)}****${normalized.slice(7)}`;
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
}

function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) return false;
  try {
    const hash = Buffer.from(hashPassword(password, storedSalt), "hex");
    const expected = Buffer.from(storedHash, "hex");
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch (err) {
    return false;
  }
}

function checkLocked(phone) {
  const record = failures[phone];
  if (!record) return { locked: false, remainingSeconds: 0 };
  const now = Date.now();
  if (record.lockedUntil && now < record.lockedUntil) {
    return {
      locked: true,
      remainingSeconds: Math.ceil((record.lockedUntil - now) / 1000)
    };
  }
  if (record.lockedUntil && now >= record.lockedUntil) delete failures[phone];
  return { locked: false, remainingSeconds: 0 };
}

function recordFailure(phone) {
  const now = Date.now();
  const record = failures[phone];
  if (!record || now - record.firstAttemptAt > ATTEMPT_WINDOW_MS) {
    failures[phone] = { count: 1, firstAttemptAt: now, lockedUntil: null };
    return;
  }
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) record.lockedUntil = now + LOCK_DURATION_MS;
}

function clearFailures(phone) {
  delete failures[phone];
}

function publicUser(user = {}) {
  return {
    userId: user._id || user.id || "",
    phoneMasked: user.phoneMasked || maskPhone(user.phone || user.phoneNumber || ""),
    hasPassword: Boolean(user.hasPassword && user.passwordHash && user.passwordSalt),
    status: user.status || "active",
    nickname: user.nickname || "",
    avatarUrl: user.avatarUrl || ""
  };
}

function adminMenuScope(role) {
  if (role === "super_admin") return "all";
  if (role === "procurement") return "procurement";
  if (role === "finance") return "finance";
  if (role === "customer_service") return "customer_service";
  return "none";
}

function customerProfile() {
  return {
    isAdmin: false,
    role: "user",
    roleName: ROLE_NAMES.user,
    permissions: [],
    status: "none",
    defaultEntry: "frontend",
    canAccessFrontend: true,
    canAccessAdmin: false,
    showFrontendTabBar: true,
    showAllAdminMenus: false,
    adminMenuScope: "none"
  };
}

function adminProfile(admin) {
  if (!admin || admin.status === "disabled" || admin.isActive === false) return customerProfile();
  const role = admin.role || "user";
  const backendOnly = BACKEND_ONLY_ROLES.includes(role);
  const fullAccess = FULL_ACCESS_ROLES.includes(role);
  return {
    isAdmin: role !== "user",
    role,
    roleName: ROLE_NAMES[role] || admin.roleName || role,
    permissions: fullAccess ? ["*"] : (Array.isArray(admin.permissions) ? admin.permissions : []),
    status: "active",
    defaultEntry: backendOnly ? "admin" : "frontend",
    canAccessFrontend: !backendOnly,
    canAccessAdmin: role !== "user",
    showFrontendTabBar: !backendOnly,
    showAllAdminMenus: fullAccess,
    adminMenuScope: adminMenuScope(role)
  };
}

async function getUserByPhone(phone) {
  let res = await db.collection("users").where({ phone }).limit(1).get();
  if (res.data && res.data[0]) return res.data[0];
  res = await db.collection("users").where({ phoneNumber: phone }).limit(1).get();
  return res.data && res.data[0] || null;
}

async function getAdminByOpenid(openid) {
  const res = await db.collection("admin_users").where({
    openid,
    isActive: _.neq(false),
    status: _.neq("disabled")
  }).limit(1).get();
  return res.data && res.data[0] || null;
}

function invalidCredentials(phone) {
  recordFailure(phone);
  return {
    ok: false,
    code: "INVALID_CREDENTIALS",
    message: "手机号或密码错误，请检查后重试"
  };
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const currentOpenid = wxContext.OPENID;
  const unionid = wxContext.UNIONID || "";
  const now = db.serverDate();

  let phone = "";
  try {
    phone = normalizePhone(event.phone);
  } catch (err) {
    return { ok: false, code: "INVALID_PHONE", message: "手机号格式不正确" };
  }

  const password = String(event.password || "");
  if (password.length < 6) {
    return { ok: false, code: "INVALID_PASSWORD", message: "密码长度至少 6 位" };
  }

  const lock = checkLocked(phone);
  if (lock.locked) {
    return {
      ok: false,
      code: "ACCOUNT_LOCKED",
      message: `登录失败次数过多，请 ${lock.remainingSeconds} 秒后再试`
    };
  }

  try {
    const user = await getUserByPhone(phone);
    if (!user || !user.hasPassword || !user.passwordHash || !user.passwordSalt) {
      return invalidCredentials(phone);
    }
    if (user.status === "disabled") {
      return { ok: false, code: "USER_DISABLED", message: "账号已被禁用，请联系客服" };
    }
    if (!verifyPassword(password, user.passwordHash, user.passwordSalt)) {
      return invalidCredentials(phone);
    }

    if (user.openid && user.openid !== currentOpenid) {
      return {
        ok: false,
        code: "PHONE_BOUND_TO_OTHER",
        message: "该手机号已绑定其他微信账号，请联系客服处理或使用原微信登录。"
      };
    }

    clearFailures(phone);

    const updateData = {
      phone,
      phoneNumber: user.phoneNumber || phone,
      phoneMasked: user.phoneMasked || maskPhone(phone),
      lastLoginAt: now,
      lastLoginType: "password",
      updatedAt: now
    };
    if (!user.openid) updateData.openid = currentOpenid;
    if (unionid && !user.unionid) updateData.unionid = unionid;

    await db.collection("users").doc(user._id).update({ data: updateData });
    const nextUser = { ...user, ...updateData };
    const admin = await getAdminByOpenid(nextUser.openid || currentOpenid);
    const profile = admin ? adminProfile(admin) : customerProfile();

    return {
      ok: true,
      data: {
        loginType: "password",
        user: publicUser(nextUser),
        adminProfile: profile,
        expiresAt: Date.now() + SESSION_TTL_MS
      }
    };
  } catch (err) {
    console.error("loginWithPassword error:", err && err.message || err);
    return { ok: false, code: "LOGIN_FAILED", message: "登录失败，请稍后重试" };
  }
};
