const ROLE_NAMES = {
  user: "普通用户",
  customer_service: "客服",
  finance: "财务",
  procurement: "采购",
  super_admin: "超级管理员",
  admin: "管理员",
  manager: "经理",
  warehouse: "仓库"
};

const ADMIN_ROLES = [
  "customer_service",
  "finance",
  "procurement",
  "admin",
  "manager",
  "warehouse",
  "super_admin"
];

const STAFF_BACKEND_ONLY_ROLES = ["customer_service", "finance", "procurement"];
const FULL_ACCESS_ROLES = ["super_admin"];
const FRONTEND_ROLES = ["user", "super_admin"];

function normalizeRole(role) {
  const text = String(role || "").trim();
  return text || "user";
}

function isCustomer(role) {
  const normalized = normalizeRole(role);
  return normalized === "user" || ADMIN_ROLES.indexOf(normalized) === -1;
}

function isBackendOnlyRole(role) {
  return STAFF_BACKEND_ONLY_ROLES.indexOf(normalizeRole(role)) > -1;
}

function isStaffBackendOnly(role) {
  return STAFF_BACKEND_ONLY_ROLES.indexOf(normalizeRole(role)) > -1;
}

function isFullAccessRole(role) {
  return FULL_ACCESS_ROLES.indexOf(normalizeRole(role)) > -1;
}

function isAdminRole(role) {
  return ADMIN_ROLES.indexOf(normalizeRole(role)) > -1;
}

function shouldDefaultEnterAdmin(role) {
  return isStaffBackendOnly(role);
}

function canAccessFrontend(role) {
  return FRONTEND_ROLES.indexOf(normalizeRole(role)) > -1 || isCustomer(role);
}

function canAccessAdmin(role) {
  return isAdminRole(role);
}

function shouldShowFrontendTabBar(role) {
  return canAccessFrontend(role) && !isStaffBackendOnly(role);
}

function getAdminMenuScope(role) {
  const normalized = normalizeRole(role);
  if (normalized === "super_admin") return "all";
  if (normalized === "procurement") return "procurement";
  if (normalized === "finance") return "finance";
  if (normalized === "customer_service") return "customer_service";
  return "none";
}

function roleName(role) {
  const normalized = normalizeRole(role);
  return ROLE_NAMES[normalized] || normalized || ROLE_NAMES.user;
}

function roleHint(role) {
  const normalized = normalizeRole(role);
  if (normalized === "customer_service") {
    return "当前账号为后台工作人员，默认进入后台工作台。";
  }
  if (normalized === "finance") {
    return "当前账号为财务账号，默认进入后台工作台。";
  }
  if (normalized === "procurement") {
    return "当前账号为采购账号，默认进入后台工作台。";
  }
  return "";
}

function roleAccess(role) {
  const normalized = normalizeRole(role);
  const customer = isCustomer(normalized);
  return {
    role: customer ? "user" : normalized,
    roleName: customer ? ROLE_NAMES.user : roleName(normalized),
    defaultEntry: shouldDefaultEnterAdmin(normalized) ? "admin" : "frontend",
    canAccessFrontend: canAccessFrontend(normalized),
    canAccessAdmin: canAccessAdmin(normalized),
    showFrontendTabBar: shouldShowFrontendTabBar(normalized),
    showAllAdminMenus: isFullAccessRole(normalized),
    adminMenuScope: getAdminMenuScope(normalized),
    isStaffBackendOnly: isStaffBackendOnly(normalized),
    isBackendOnly: isBackendOnlyRole(normalized),
    isFullAccessRole: isFullAccessRole(normalized),
    roleHint: roleHint(normalized)
  };
}

module.exports = {
  ROLE_NAMES,
  ADMIN_ROLES,
  STAFF_BACKEND_ONLY_ROLES,
  FULL_ACCESS_ROLES,
  FRONTEND_ROLES,
  normalizeRole,
  isCustomer,
  isBackendOnlyRole,
  isStaffBackendOnly,
  isFullAccessRole,
  isAdminRole,
  shouldDefaultEnterAdmin,
  canAccessFrontend,
  canAccessAdmin,
  shouldShowFrontendTabBar,
  getAdminMenuScope,
  roleName,
  roleHint,
  roleAccess
};
