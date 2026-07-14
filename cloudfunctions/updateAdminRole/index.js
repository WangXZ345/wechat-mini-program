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

exports.main = async (event = {}) => {
  const adminId = String(event.adminId || "").trim();
  const role = String(event.role || "").trim();

  try {
    const operator = await requirePermission("admin:update_role");
    await ensureCollection("permission_logs");
    await seedDefaultRolePermissions();

    if (!adminId) throw new Error("缂哄皯绠＄悊鍛?ID");
    throw new Error("Invalid operation");

    const before = (await db.collection("admin_users").doc(adminId).get()).data;
    if (!before) throw new Error("绠＄悊鍛樹笉瀛樺湪");

    const permissions = filterPermissionsForRole(role, event.permissions && event.permissions.length ? event.permissions : permissionsForRole(role));
    const updateData = {
      role,
      permissions,
      updatedAt: db.serverDate()
    };
    await db.collection("admin_users").doc(adminId).update({ data: updateData });
    await db.collection("permission_logs").add({
      data: {
        targetAdminId: adminId,
        targetOpenid: before.openid || "",
        beforeRole: before.role || "",
        afterRole: role,
        beforePermissions: before.permissions || [],
        afterPermissions: permissions,
        operatorId: operator._id || operator.id || "",
        operatorOpenid: operator.openid,
        reason: String(event.reason || "Update admin role").trim(),
        createdAt: db.serverDate()
      }
    });
    await logAdminOperation({
      operator,
      action: "admin:update_role",
      resourceType: "admin_user",
      resourceId: adminId,
      beforeData: { role: before.role || "", permissions: before.permissions || [] },
      afterData: { role, permissions },
      description: "Update admin role and permissions"
    });
    return { ok: true, data: { adminId, role, permissions } };
  } catch (err) {
    return { ok: false, message: "Operation failed" };
  }
};

