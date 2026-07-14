const cloud = require("wx-server-sdk");

const {
  ALL_PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  permissionsForRole,
  uniquePermissions,
  filterPermissionsForRole
} = require("./permissions");

const db = cloud.database();
const _ = db.command;

function getOpenid() {
  return cloud.getWXContext().OPENID;
}

function isMissingCollection(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

function isExistingCollectionError(err) {
  const message = String((err && err.message) || err || "");
  return /already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message);
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    if (isExistingCollectionError(err)) return;
    if (/createCollection is not a function/i.test(String((err && err.message) || err || ""))) return;
    throw err;
  }
}

function normalizeAdmin(raw, openid) {
  if (!raw) return null;
  const disabled = raw.status === "disabled" || raw.isActive === false;
  const role = raw.role || "";
  if (!role || !ROLE_PERMISSIONS[role]) return null;
  const fallbackPermissions = permissionsForRole(role);
  const sourcePermissions = Array.isArray(raw.permissions) && raw.permissions.length
    ? raw.permissions
    : fallbackPermissions;
  const permissions = role === "super_admin" ? ALL_PERMISSIONS.slice() : filterPermissionsForRole(role, sourcePermissions);
  return {
    ...raw,
    _id: raw._id || raw.id || "",
    id: raw._id || raw.id || "",
    openid: raw.openid || openid || "",
    role,
    roleName: ROLE_NAMES[role] || role,
    permissions,
    status: disabled ? "disabled" : "active",
    isActive: !disabled
  };
}

async function getAdminByOpenid(openid = getOpenid()) {
  try {
    const res = await db.collection("admin_users").where({
      openid,
      isActive: _.neq(false),
      status: _.neq("disabled")
    }).limit(1).get();
    if (res.data[0]) return normalizeAdmin(res.data[0], openid);
  } catch (err) {
    if (!isMissingCollection(err)) throw err;
  }

  return null;
}

function hasPermission(admin, permission) {
  if (!admin || admin.status === "disabled" || admin.isActive === false) return false;
  if (admin.role === "super_admin") return true;
  return Array.isArray(admin.permissions) && admin.permissions.includes(permission);
}

async function requireAdmin() {
  const openid = getOpenid();
  const admin = await getAdminByOpenid(openid);
  if (!admin) throw new Error("无管理员权限");
  if (admin.status === "disabled" || admin.isActive === false) throw new Error("管理员账号已禁用");
  return admin;
}

async function requirePermission(permission) {
  const admin = await requireAdmin();
  if (!hasPermission(admin, permission)) throw new Error("无权限执行该操作");
  return admin;
}

async function requireAnyPermission(permissions = []) {
  const admin = await requireAdmin();
  if (!permissions.some((permission) => hasPermission(admin, permission))) {
    throw new Error("无权限执行该操作");
  }
  return admin;
}

async function requireRole(role) {
  const admin = await requireAdmin();
  if (admin.role !== role) throw new Error("无权限执行该操作");
  return admin;
}

async function seedDefaultRolePermissions() {
  await ensureCollection("role_permissions");
  const now = db.serverDate();
  const roles = Object.keys(ROLE_PERMISSIONS);
  for (const role of roles) {
    const exists = await db.collection("role_permissions").where({ role }).limit(1).get();
    const data = {
      role,
      roleName: ROLE_NAMES[role] || role,
      permissions: permissionsForRole(role),
      description: ROLE_DESCRIPTIONS[role] || "",
      updatedAt: now
    };
    if (exists.data[0]) {
      await db.collection("role_permissions").doc(exists.data[0]._id).update({ data });
    } else {
      await db.collection("role_permissions").add({ data: { ...data, createdAt: now } });
    }
  }
}

async function logAdminOperation({
  operator,
  action,
  resourceType,
  resourceId,
  beforeData,
  afterData,
  description
}) {
  await ensureCollection("admin_operation_logs");
  await db.collection("admin_operation_logs").add({
    data: {
      operatorId: operator && (operator._id || operator.id) || "",
      operatorOpenid: operator && operator.openid || getOpenid(),
      operatorRole: operator && operator.role || "",
      action,
      resourceType,
      resourceId: resourceId || "",
      beforeData: beforeData || null,
      afterData: afterData || null,
      description: description || "",
      createdAt: db.serverDate()
    }
  });
}

module.exports = {
  getOpenid,
  getAdminByOpenid,
  hasPermission,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  requireRole,
  seedDefaultRolePermissions,
  logAdminOperation,
  ensureCollection,
  normalizeAdmin
};
