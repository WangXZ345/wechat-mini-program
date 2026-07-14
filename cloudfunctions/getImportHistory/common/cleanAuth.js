const cloud = require("wx-server-sdk");

const db = cloud.database();
const _ = db.command;

const ALL_PERMISSIONS = [
  "order:view",
  "order:review",
  "order:reject",
  "order:edit_remark",
  "order:export",
  "payment:view_screenshot",
  "payment:confirm",
  "payment:update_status",
  "payment:export",
  "customer:view_basic",
  "customer:view_account",
  "customer:edit_remark",
  "customer:export_account",
  "product:view",
  "product:create",
  "product:update",
  "product:delete",
  "product:update_price",
  "product:update_status",
  "inventory:view",
  "inventory:update",
  "inventory:import",
  "inventory:view_log",
  "inventory:set_warning",
  "dashboard:view_basic",
  "dashboard:view_sales",
  "dashboard:view_finance",
  "dashboard:view_inventory",
  "admin:view",
  "admin:create",
  "admin:update_role",
  "admin:disable",
  "system:settings",
  "system:payment_methods"
];

const ROLE_PERMISSIONS = {
  super_admin: ALL_PERMISSIONS.slice(),
  customer_service: [
    "dashboard:view_basic",
    "order:view",
    "order:review",
    "order:reject",
    "order:edit_remark",
    "customer:view_basic",
    "customer:edit_remark"
  ],
  finance: [
    "dashboard:view_basic",
    "dashboard:view_sales",
    "dashboard:view_finance",
    "order:view",
    "payment:view_screenshot",
    "payment:confirm",
    "payment:update_status",
    "payment:export",
    "customer:view_basic",
    "customer:view_account",
    "customer:export_account",
    "order:export"
  ],
  procurement: [
    "dashboard:view_basic",
    "dashboard:view_inventory",
    "product:view",
    "product:create",
    "product:update",
    "product:update_status",
    "inventory:view",
    "inventory:update",
    "inventory:import",
    "inventory:view_log",
    "inventory:set_warning"
  ]
};

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

function uniquePermissions(permissions) {
  const allowed = new Set(ALL_PERMISSIONS);
  return Array.from(new Set((permissions || []).filter((item) => allowed.has(item))));
}

function filterPermissionsForRole(role, permissions) {
  const list = uniquePermissions(permissions);
  if (role !== "procurement") return list;
  const allowed = new Set(uniquePermissions(ROLE_PERMISSIONS.procurement || []));
  return list.filter((permission) => allowed.has(permission));
}

function permissionsForRole(role) {
  return filterPermissionsForRole(role, ROLE_PERMISSIONS[role] || []);
}

function normalizeRole(role) {
  const raw = String(role || "").trim();
  const map = {
    purchase: "procurement",
    buyer: "procurement",
    "采购": "procurement",
    admin: "super_admin",
    "超级管理员": "super_admin"
  };
  return map[raw] || raw || "";
}

function normalizeAdmin(raw, openid) {
  if (!raw) return null;
  const disabled = raw.status === "disabled" || raw.isActive === false;
  const role = normalizeRole(raw.role || raw.roleKey || "");
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
  const admin = await getAdminByOpenid();
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
      resourceType: resourceType || "",
      resourceId: resourceId || "",
      beforeData: beforeData || null,
      afterData: afterData || null,
      description: description || "",
      createdAt: db.serverDate()
    }
  });
}

module.exports = {
  db,
  _,
  getOpenid,
  ensureCollection,
  getAdminByOpenid,
  hasPermission,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  logAdminOperation,
  normalizeAdmin,
  permissionsForRole
};
