const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const {
  SECTION_DEFINITIONS,
  SECTION_BY_KEY,
  decoratePublicProduct,
  isVisibleProduct,
  matchesSection,
  normalizeSectionConfig
} = require("./common/recommend");

const PRODUCT_RECOMMEND_FIELDS = {
  _id: true,
  name: true,
  thumbnailUrl: true,
  imageUrl: true,
  brand: true,
  category: true,
  specification: true,
  productionDate: true,
  price: true,
  tags: true,
  isNew: true,
  isDefective: true,
  isHot: true,
  isActive: true,
  isDeleted: true,
  status: true,
  createdAt: true,
  updatedAt: true
};

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
    if (isExistingCollectionError(err) || /createCollection is not a function/i.test(String((err && err.message) || err || ""))) return;
    throw err;
  }
}

async function ensureSections() {
  await ensureCollection("home_recommend_sections");
  const existing = await db.collection("home_recommend_sections")
    .where({ sectionKey: _.in(SECTION_DEFINITIONS.map((item) => item.sectionKey)) })
    .limit(20)
    .get();
  const existingKeys = new Set((existing.data || []).map((item) => item.sectionKey));
  for (const section of SECTION_DEFINITIONS) {
    if (!existingKeys.has(section.sectionKey)) {
      await db.collection("home_recommend_sections").add({
        data: {
          ...section,
          createdBy: "system",
          updatedBy: "system",
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
  }
  const latest = await db.collection("home_recommend_sections")
    .where({ sectionKey: _.in(SECTION_DEFINITIONS.map((item) => item.sectionKey)) })
    .limit(20)
    .get();
  return (latest.data || [])
    .map(normalizeSectionConfig)
    .filter(Boolean)
    .filter((item) => item.enabled !== false)
    .sort((a, b) => a.sortIndex - b.sortIndex);
}

async function getAllVisibleProducts() {
  const pageSize = 100;
  let skip = 0;
  let products = [];
  while (skip < 3000) {
    const res = await db.collection("products")
      .where({ isActive: true })
      .field(PRODUCT_RECOMMEND_FIELDS)
      .orderBy("updatedAt", "desc")
      .skip(skip)
      .limit(pageSize)
      .get();
    products = products.concat(res.data || []);
    if (!res.data || res.data.length < pageSize) break;
    skip += pageSize;
  }
  return products.filter(isVisibleProduct);
}

async function getFrequentProducts(openid, allProducts, maxItems) {
  if (!openid) return [];
  try {
    const stats = await db.collection("user_product_purchase_stats")
      .where({ userOpenid: openid })
      .field({ productId: true, purchaseCount: true, lastPurchasedAt: true })
      .orderBy("purchaseCount", "desc")
      .orderBy("lastPurchasedAt", "desc")
      .limit(Math.max(maxItems * 3, 20))
      .get();
    const productMap = new Map(allProducts.map((item) => [item._id, item]));
    return (stats.data || [])
      .map((stat) => productMap.get(stat.productId))
      .filter(Boolean)
      .slice(0, maxItems);
  } catch (err) {
    if (isMissingCollection(err)) return [];
    throw err;
  }
}

function pickRuleProducts(section, allProducts) {
  return allProducts
    .filter((product) => matchesSection(product, section.sectionKey))
    .sort((a, b) => {
      if (section.sectionKey === "new_arrivals") return String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || ""));
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    })
    .slice(0, section.maxItems);
}

exports.main = async () => {
  try {
    const openid = cloud.getWXContext().OPENID;
    const sections = await ensureSections();
    const allProducts = await getAllVisibleProducts();
    const result = [];

    for (const section of sections) {
      if (!SECTION_BY_KEY[section.sectionKey]) continue;
      let products = [];
      if (section.sectionKey === "frequent_purchase") {
        products = await getFrequentProducts(openid, allProducts, section.maxItems);
        if (!products.length) continue;
      } else {
        products = pickRuleProducts(section, allProducts);
      }
      if (!products.length) continue;
      result.push({
        sectionKey: section.sectionKey,
        sectionTitle: section.sectionTitle,
        subtitle: section.subtitle,
        displayType: section.displayType,
        sortIndex: section.sortIndex,
        showMore: section.showMore,
        products: products.slice(0, section.maxItems).map((item) => decoratePublicProduct(item))
      });
    }

    return { ok: true, data: { sections: result } };
  } catch (err) {
    return { ok: false, message: err.message || "获取首页推荐失败" };
  }
};
