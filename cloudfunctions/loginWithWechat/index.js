const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BACKEND_ONLY_ROLES = ["customer_service", "finance", "procurement"];
const FULL_ACCESS_ROLES = ["super_admin"];
const ROLE_NAMES = {
  user: "普通用户",
  customer_service: "客服",
  finance: "财务",
  procurement: "采购",
  super_admin: "超级管理员"
};

function maskPhone(phone) {
  const value = String(phone || "").replace(/\D/g, "");
  const normalized = value.length > 11 ? value.slice(-11) : value;
  if (!/^1[3-9]\d{9}$/.test(normalized)) return "";
  return `${normalized.slice(0, 3)}****${normalized.slice(7)}`;
}

function publicUser(user = {}) {
  const phoneMasked = user.phoneMasked || maskPhone(user.phone || user.phoneNumber || "");
  return {
    userId: user._id || user.id || "",
    phoneMasked,
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

async function getAdminByOpenid(openid) {
  const res = await db.collection("admin_users").where({
    openid,
    isActive: _.neq(false),
    status: _.neq("disabled")
  }).limit(1).get();
  return res.data && res.data[0] || null;
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const unionid = wxContext.UNIONID || "";
  const now = db.serverDate();

  if (!openid) {
    return { ok: false, code: "NO_OPENID", message: "登录失败，请稍后重试" };
  }

  try {
    const usersResult = await db.collection("users").where({ openid }).limit(1).get();
    let user = usersResult.data && usersResult.data[0];

    if (!user) {
      const userData = {
        openid,
        unionid,
        phone: "",
        phoneNumber: "",
        phoneMasked: "",
        phoneVerified: false,
        phoneBindMethod: "",
        passwordHash: "",
        passwordSalt: "",
        passwordUpdatedAt: null,
        hasPassword: false,
        nickname: String(event.nickname || "").trim(),
        avatarUrl: String(event.avatarUrl || "").trim(),
        status: "active",
        lastLoginAt: now,
        lastLoginType: "wechat",
        createdAt: now,
        updatedAt: now
      };
      const created = await db.collection("users").add({ data: userData });
      user = { _id: created._id, ...userData };
    } else {
      if (user.status === "disabled") {
        return { ok: false, code: "USER_DISABLED", message: "账号已被禁用，请联系客服" };
      }
      const updateData = {
        lastLoginAt: now,
        lastLoginType: "wechat",
        updatedAt: now
      };
      if (unionid && !user.unionid) updateData.unionid = unionid;
      if (event.nickname && event.nickname !== user.nickname) updateData.nickname = String(event.nickname).trim();
      if (event.avatarUrl && event.avatarUrl !== user.avatarUrl) updateData.avatarUrl = String(event.avatarUrl).trim();
      await db.collection("users").doc(user._id).update({ data: updateData });
      user = { ...user, ...updateData };
    }

    const admin = await getAdminByOpenid(openid);
    const profile = admin ? adminProfile(admin) : customerProfile();

    return {
      ok: true,
      data: {
        loginType: "wechat",
        user: publicUser(user),
        adminProfile: profile,
        expiresAt: Date.now() + SESSION_TTL_MS
      }
    };
  } catch (err) {
    console.error("loginWithWechat error:", err && err.message || err);
    return { ok: false, code: "LOGIN_FAILED", message: "登录失败，请稍后重试" };
  }
};
