const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const { requireAnyPermission, logAdminOperation, ensureCollection } = require("./auth");
const {
  normalizeProductTagPayload,
  safeProductLogSnapshot
} = require("./recommend");

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/[，、。；;:：|/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildProductSearchText(product = {}) {
  return normalizeSearchText([
    product.name,
    product.baseName,
    product.brand,
    product.category,
    product.specification,
    product.productionDate,
    product.description,
    product.productIndex,
    product.skuCode,
    Array.isArray(product.keywords) ? product.keywords.join(" ") : product.keywords,
    Array.isArray(product.tags) ? product.tags.join(" ") : ""
  ].filter(Boolean).join(" "));
}

async function writeProductTagLog(productId, productName, before, after, admin) {
  await ensureCollection("product_tag_logs");
  await db.collection("product_tag_logs").add({
    data: {
      productId,
      productName,
      beforeTags: before.tags,
      afterTags: after.tags,
      beforeInternalTags: before.internalTags,
      afterInternalTags: after.internalTags,
      beforeFlags: before.flags,
      afterFlags: after.flags,
      beforeDefectDescription: before.defectDescription,
      afterDefectDescription: after.defectDescription,
      operatorId: admin._id || admin.id || "",
      operatorOpenid: admin.openid || "",
      operatorRole: admin.role || "",
      createdAt: db.serverDate()
    }
  });
}

exports.main = async (event = {}) => {
  try {
    const admin = await requireAnyPermission(["product:tag:update", "product:update"]);
    const productId = String(event.productId || "").trim();
    if (!productId) return { ok: false, message: "缺少商品 ID" };
    const product = (await db.collection("products").doc(productId).get()).data;
    if (!product || product.isDeleted === true) return { ok: false, message: "商品不存在" };

    const before = safeProductLogSnapshot(product);
    const tagData = normalizeProductTagPayload(event, product);
    const updateData = {
      ...tagData,
      tagUpdatedAt: db.serverDate(),
      tagUpdatedBy: admin.openid || "",
      updatedAt: db.serverDate()
    };
    updateData.searchText = buildProductSearchText({ ...product, ...tagData });

    await db.collection("products").doc(productId).update({ data: updateData });
    const after = safeProductLogSnapshot({ ...product, ...tagData });
    await writeProductTagLog(productId, product.name || "", before, after, admin);
    await logAdminOperation({
      operator: admin,
      action: "product_tag_update",
      resourceType: "products",
      resourceId: productId,
      beforeData: before,
      afterData: after,
      description: "更新商品标签"
    });

    return {
      ok: true,
      data: {
        productId,
        tags: tagData.tags,
        internalTags: tagData.internalTags,
        isNew: tagData.isNew,
        isDefective: tagData.isDefective,
        isHot: tagData.isHot,
        isFrequent: tagData.isFrequent,
        defectDescription: tagData.defectDescription,
        warning: tagData.isDefective && !tagData.defectDescription ? "该商品已标记为瑕疵，建议填写瑕疵说明。" : ""
      }
    };
  } catch (err) {
    return { ok: false, message: err.message || "更新商品标签失败" };
  }
};
