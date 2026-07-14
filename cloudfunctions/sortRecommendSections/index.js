const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission, logAdminOperation, ensureCollection } = require("./auth");
const { SECTION_DEFINITIONS, SECTION_BY_KEY, normalizeSectionConfig } = require("./recommend");

async function writeLog(section, beforeData, afterData, admin) {
  await ensureCollection("home_recommend_logs");
  await db.collection("home_recommend_logs").add({
    data: {
      sectionKey: section.sectionKey,
      sectionTitle: section.sectionTitle,
      action: "sort",
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
    const list = Array.isArray(event.sections) ? event.sections : [];
    if (!list.length) return { ok: false, message: "缺少排序数据" };
    await ensureCollection("home_recommend_sections");
    const normalized = list.map((item, index) => ({
      sectionKey: String(item.sectionKey || "").trim(),
      sortIndex: Math.max(1, parseInt(item.sortIndex, 10) || index + 1)
    }));
    const invalid = normalized.find((item) => !SECTION_BY_KEY[item.sectionKey]);
    if (invalid) return { ok: false, code: "INVALID_RECOMMEND_SECTION", message: "推荐分类不存在" };

    const existing = await db.collection("home_recommend_sections")
      .where({ sectionKey: _.in(SECTION_DEFINITIONS.map((item) => item.sectionKey)) })
      .limit(20)
      .get();
    const byKey = {};
    (existing.data || []).forEach((item) => { byKey[item.sectionKey] = item; });
    const changed = [];
    for (const item of normalized) {
      const before = byKey[item.sectionKey] || null;
      const base = before || SECTION_BY_KEY[item.sectionKey];
      const patch = { sortIndex: item.sortIndex, updatedBy: admin.openid || "", updatedAt: db.serverDate() };
      if (before) {
        await db.collection("home_recommend_sections").doc(before._id).update({ data: patch });
      } else {
        await db.collection("home_recommend_sections").add({
          data: { ...SECTION_BY_KEY[item.sectionKey], ...patch, createdBy: admin.openid || "", createdAt: db.serverDate() }
        });
      }
      const after = normalizeSectionConfig({ ...base, ...patch, sectionKey: item.sectionKey });
      await writeLog(after, before, after, admin);
      changed.push(after);
    }

    await logAdminOperation({
      operator: admin,
      action: "home_recommend_sort",
      resourceType: "home_recommend_sections",
      resourceId: "all",
      beforeData: { sections: existing.data || [] },
      afterData: { sections: changed },
      description: "调整首页推荐区排序"
    });
    return { ok: true, data: { sections: changed.sort((a, b) => a.sortIndex - b.sortIndex) } };
  } catch (err) {
    return { ok: false, message: err.message || "调整推荐区排序失败" };
  }
};
