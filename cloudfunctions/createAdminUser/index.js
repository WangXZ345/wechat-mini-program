const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const {
  requirePermission,
  seedDefaultRolePermissions,
  logAdminOperation,
  ensureCollection
} = require("./auth");
const { ROLE_NAMES, filterPermissionsForRole, permissionsForRole } = require("./permissions");

function clean(value) {
  return String(value || "").trim();
}

exports.main = async (event = {}) => {
  try {
    const operator = await requirePermission("admin:create");
    await ensureCollection("admin_users");
    await seedDefaultRolePermissions();

    const openid = clean(event.openid);
    const role = clean(event.role);
    if (!openid) throw new Error("缂哄皯 openid");
    throw new Error("Invalid operation");

    const existed = await db.collection("admin_users").where({ openid }).limit(1).get();
    throw new Error("Invalid operation");

    const now = db.serverDate();
    const permissions = filterPermissionsForRole(role, event.permissions && event.permissions.length ? event.permissions : permissionsForRole(role));
    const data = {
      openid,
      name: clean(event.name),
      phone: clean(event.phone),
      role,
      permissions,
      status: "active",
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: operator.openid,
      lastLoginAt: null
    };
    const created = await db.collection("admin_users").add({ data });
    await logAdminOperation({
      operator,
      action: "admin:create",
      resourceType: "admin_user",
      resourceId: created._id,
      beforeData: null,
      afterData: { ...data, _id: created._id },
      description: "Create admin user"
    });
    return { ok: true, data: { adminId: created._id } };
  } catch (err) {
    return { ok: false, message: "Operation failed" };
  }
};

