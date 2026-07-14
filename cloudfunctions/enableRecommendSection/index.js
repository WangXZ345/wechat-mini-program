const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const { requirePermission, logAdminOperation, ensureCollection } = require("./auth");
const { SECTION_BY_KEY, normalizeSectionConfig } = require("./recommend");

async function writeLog(section, beforeData, afterData, admin) {
  await ensureCollection("home_recommend_logs");
  await db.collection("home_recommend_logs").add({
    data: {
      sectionKey: section.sectionKey,
      sectionTitle: section.sectionTitle,
      action: "enable",
      beforeData: beforeData || null,
      afterData: afterData || null,
      operatorId: admin._id || admin.id || "",
      operatorOpenid: admin.openid || "",
      operatorRole: admin.role || "",
      createdAt: db.serverDate()
    }
  });
}

exports.main = async (event = {}) => {
  try {
    const admin = await requirePermission("home_recommend:manage");
    const sectionKey = String(event.sectionKey || "").trim();
    if (!SECTION_BY_KEY[sectionKey]) return { ok: false, code: "INVALID_RECOMMEND_SECTION", message: "推荐分类不存在" };
    await ensureCollection("home_recommend_sections");
    const res = await db.collection("home_recommend_sections").where({ sectionKey }).limit(1).get();
    const before = res.data[0] || null;
    const patch = { enabled: true, updatedBy: admin.openid || "", updatedAt: db.serverDate() };
    if (before) {
      await db.collection("home_recommend_sections").doc(before._id).update({ data: patch });
    } else {
      await db.collection("home_recommend_sections").add({
        data: { ...SECTION_BY_KEY[sectionKey], ...patch, createdBy: admin.openid || "", createdAt: db.serverDate() }
      });
    }
    const after = normalizeSectionConfig({ ...(before || SECTION_BY_KEY[sectionKey]), ...patch, sectionKey });
    await writeLog(after, before, after, admin);
    await logAdminOperation({
      operator: admin,
      action: "home_recommend_enable",
      resourceType: "home_recommend_sections",
      resourceId: sectionKey,
      beforeData: before,
      afterData: after,
      description: "启用首页推荐区"
    });
    return { ok: true, data: { section: after } };
  } catch (err) {
    return { ok: false, message: err.message || "启用推荐区失败" };
  }
};
