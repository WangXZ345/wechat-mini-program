const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const {
  requirePermission,
  logAdminOperation
} = require("./auth");

async function activeSuperAdminCount(excludeId) {
  const res = await db.collection("admin_users").where({
    role: "super_admin",
    status: "active"
  }).limit(100).get();
  return res.data.filter((admin) => admin.isActive !== false && admin._id !== excludeId).length;
}

exports.main = async (event = {}) => {
  const adminId = String(event.adminId || "").trim();
  const disabled = event.disabled !== false;
  try {
    const operator = await requirePermission("admin:disable");
    if (!adminId) throw new Error("缂哄皯绠＄悊鍛?ID");
    if (adminId === (operator._id || operator.id)) throw new Error("涓嶈兘绂佺敤鑷繁");

    const before = (await db.collection("admin_users").doc(adminId).get()).data;
    if (!before) throw new Error("绠＄悊鍛樹笉瀛樺湪");
    if (disabled && before.role === "super_admin" && await activeSuperAdminCount(adminId) < 1) {
      throw new Error("鑷冲皯闇€瑕佷繚鐣欎竴涓?active 鐨勮秴绾х鐞嗗憳");
    }

    const afterStatus = disabled ? "disabled" : "active";
    await db.collection("admin_users").doc(adminId).update({
      data: {
        status: afterStatus,
        isActive: !disabled,
        updatedAt: db.serverDate()
      }
    });
    await logAdminOperation({
      operator,
      action: disabled ? "admin:disable" : "admin:enable",
      resourceType: "admin_user",
      resourceId: adminId,
      beforeData: { status: before.status || (before.isActive === false ? "disabled" : "active") },
      afterData: { status: afterStatus },
      description: disabled ? "Disable admin user" : "Enable admin user"
    });
    return { ok: true, data: { adminId, status: afterStatus } };
  } catch (err) {
    return { ok: false, message: "Operation failed" };
  }
};

