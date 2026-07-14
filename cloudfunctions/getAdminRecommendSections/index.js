const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requireAnyPermission, logAdminOperation, ensureCollection } = require("./auth");
const {
  SECTION_DEFINITIONS,
  SECTION_BY_KEY,
  decoratePublicProduct,
  isVisibleProduct,
  matchesSection,
  normalizeSectionConfig
} = require("./recommend");

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

async function ensureSections(admin) {
  await ensureCollection("home_recommend_sections");
  const existing = await db.collection("home_recommend_sections")
    .where({ sectionKey: _.in(SECTION_DEFINITIONS.map((item) => item.sectionKey)) })
    .limit(20)
    .get();
  const existingKeys = new Set((existing.data || []).map((item) => item.sectionKey));
  for (const section of SECTION_DEFINITIONS) {
    if (!existingKeys.has(section.sectionKey)) {
      const data = {
        ...section,
        createdBy: admin.openid || "system",
        updatedBy: admin.openid || "system",
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      };
      await db.collection("home_recommend_sections").add({ data });
      await writeHomeRecommendLog(section, "init", null, section, admin);
    }
  }
  const latest = await db.collection("home_recommend_sections")
    .where({ sectionKey: _.in(SECTION_DEFINITIONS.map((item) => item.sectionKey)) })
    .limit(20)
    .get();
  return (latest.data || []).map(normalizeSectionConfig).filter(Boolean).sort((a, b) => a.sortIndex - b.sortIndex);
}

async function getAllVisibleProducts() {
  const res = await db.collection("products").where({ isActive: true }).orderBy("updatedAt", "desc").limit(1000).get();
  return (res.data || []).filter(isVisibleProduct);
}

exports.main = async () => {
  try {
    const admin = await requireAnyPermission(["home_recommend:view", "home_recommend:manage"]);
    const sections = await ensureSections(admin);
    const products = await getAllVisibleProducts();
    const data = sections.map((section) => ({
      ...section,
      products: section.sectionKey === "frequent_purchase"
        ? []
        : products.filter((item) => matchesSection(item, section.sectionKey))
          .slice(0, section.maxItems)
          .map((item) => decoratePublicProduct(item))
    }));
    await logAdminOperation({
      operator: admin,
      action: "home_recommend_view",
      resourceType: "home_recommend_sections",
      resourceId: "all",
      afterData: { sectionCount: data.length },
      description: "查看首页推荐配置"
    });
    return { ok: true, data: { sections: data } };
  } catch (err) {
    return { ok: false, message: err.message || "获取推荐区配置失败" };
  }
};
