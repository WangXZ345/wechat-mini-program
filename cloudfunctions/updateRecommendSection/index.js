const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission, logAdminOperation, ensureCollection } = require("./auth");
const { SECTION_BY_KEY, MAX_HOME_ITEMS, normalizeSectionConfig } = require("./recommend");

async function getSection(sectionKey) {
  const res = await db.collection("home_recommend_sections").where({ sectionKey }).limit(1).get();
  return res.data[0] || null;
}

async function writeHomeRecommendLog(section, action, beforeData, afterData, admin) {
  await ensureCollection("home_recommend_logs");
  await db.collection("home_recommend_logs").add({
    data: {
      sectionKey: section.sectionKey,
      sectionTitle: section.sectionTitle,
      action,
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
    const before = await getSection(sectionKey);
    const base = before || SECTION_BY_KEY[sectionKey];
    const patch = {
      sectionTitle: String(event.sectionTitle === undefined ? base.sectionTitle : event.sectionTitle || "").trim() || base.sectionTitle,
      subtitle: String(event.subtitle === undefined ? base.subtitle : event.subtitle || "").trim(),
      displayType: event.displayType === "grid" ? "grid" : "horizontal",
      enabled: event.enabled === undefined ? base.enabled !== false : event.enabled !== false,
      sortIndex: Math.max(1, parseInt(event.sortIndex, 10) || base.sortIndex || SECTION_BY_KEY[sectionKey].sortIndex),
      maxItems: Math.min(MAX_HOME_ITEMS, Math.max(1, parseInt(event.maxItems, 10) || base.maxItems || 8)),
      showMore: event.showMore === undefined ? base.showMore !== false : event.showMore !== false,
      updatedBy: admin.openid || "",
      updatedAt: db.serverDate()
    };
    let id = before && before._id;
    if (id) {
      await db.collection("home_recommend_sections").doc(id).update({ data: patch });
    } else {
      const created = await db.collection("home_recommend_sections").add({
        data: {
          ...SECTION_BY_KEY[sectionKey],
          ...patch,
          createdBy: admin.openid || "",
          createdAt: db.serverDate()
        }
      });
      id = created._id;
    }
    const after = normalizeSectionConfig({ ...base, ...patch, _id: id, sectionKey });
    await writeHomeRecommendLog(after, "update", before, after, admin);
    await logAdminOperation({
      operator: admin,
      action: "home_recommend_update",
      resourceType: "home_recommend_sections",
      resourceId: sectionKey,
      beforeData: before,
      afterData: after,
      description: "更新首页推荐区配置"
    });
    return { ok: true, data: { section: after } };
  } catch (err) {
    return { ok: false, message: err.message || "更新推荐区配置失败" };
  }
};
