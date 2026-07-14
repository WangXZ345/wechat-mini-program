const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const {
  getAdminByOpenid,
  getOpenid,
  seedDefaultRolePermissions
} = require("./auth");
const { ROLE_NAMES } = require("./permissions");

const STAFF_BACKEND_ONLY_ROLES = ["customer_service", "finance", "procurement"];
const FULL_ACCESS_ROLES = ["super_admin"];

function getAdminMenuScope(role) {
  const normalized = role || "user";
  if (normalized === "super_admin") return "all";
  if (normalized === "procurement") return "procurement";
  if (normalized === "finance") return "finance";
  if (normalized === "customer_service") return "customer_service";
  return "none";
}

function roleAccess(role) {
  const normalized = role || "user";
  const isBackendOnly = STAFF_BACKEND_ONLY_ROLES.includes(normalized);
  const isFullAccess = FULL_ACCESS_ROLES.includes(normalized);
  const isAdmin = normalized !== "user";
  return {
    defaultEntry: isBackendOnly ? "admin" : "frontend",
    canAccessFrontend: !isBackendOnly,
    canAccessAdmin: isAdmin,
    showFrontendTabBar: !isBackendOnly,
    showAllAdminMenus: isFullAccess,
    adminMenuScope: getAdminMenuScope(normalized)
  };
}

function publicUser(openid) {
  return {
    success: true,
    isAdmin: false,
    openid,
    role: "user",
    roleName: "普通用户",
    permissions: [],
    status: "none",
    ...roleAccess("user")
  };
}

exports.main = async () => {
  try {
    const openid = getOpenid();
    await seedDefaultRolePermissions();
    const admin = await getAdminByOpenid(openid);
    if (!admin) {
      return {
        ok: true,
        data: publicUser(openid)
      };
    }
    const access = roleAccess(admin.role);
    const permissions = admin.role === "super_admin" ? ["*"] : (admin.permissions || []);

    return {
      ok: true,
      data: {
        success: true,
        isAdmin: true,
        id: admin._id || admin.id || "",
        openid: admin.openid,
        name: admin.name || admin.nickname || "",
        phone: admin.phone || "",
        role: admin.role,
        roleName: ROLE_NAMES[admin.role] || admin.role,
        permissions,
        status: admin.status || "active",
        ...access
      }
    };
  } catch (err) {
    return { ok: false, message: "Operation failed" };
  }
};

