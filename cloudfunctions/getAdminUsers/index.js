const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const {
  requirePermission,
  seedDefaultRolePermissions,
  normalizeAdmin,
  ensureCollection
} = require("./auth");

exports.main = async () => {
  try {
    await requirePermission("admin:view");
    await ensureCollection("admin_users");
    await seedDefaultRolePermissions();
    const res = await db.collection("admin_users").orderBy("updatedAt", "desc").limit(200).get();
    const roleRes = await db.collection("role_permissions").orderBy("role", "asc").limit(20).get();
    return {
      ok: true,
      data: {
        admins: res.data.map((admin) => normalizeAdmin(admin)),
        roles: roleRes.data
      }
    };
  } catch (err) {
    return { ok: false, message: "Operation failed" };
  }
};

