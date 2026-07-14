const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const {
  SECTION_BY_KEY,
  decoratePublicProduct,
  isVisibleProduct,
  matchesSection
} = require("./common/recommend");

const MAX_PAGE_SIZE = 50;

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/(20\d{2})\s*[年./-]\s*(\d{1,2})\s*(?:月)?/g, (all, year, month) => `${year}-${String(month).padStart(2, "0")}`)
    .replace(/毫升/g, "ml")
    .replace(/(\d+(?:\.\d+)?)\s*m\s*l\b/g, "$1ml")
    .replace(/[，、。；;:：|/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchText(product = {}) {
  const keywords = Array.isArray(product.keywords) ? product.keywords.join(" ") : product.keywords || "";
  return normalizeSearchText([
    product.name,
    product.baseName,
    product.brand,
    product.category,
    product.specification,
    product.productionDate,
    product.description,
    keywords,
    product.productIndex,
    product.skuCode
  ].filter(Boolean).join(" "));
}

async function getAllVisibleProducts() {
  const pageSize = 100;
  let skip = 0;
  let products = [];
  while (skip < 3000) {
    const res = await db.collection("products")
      .where({ isActive: true })
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

async function getFrequentProducts(openid, allProducts) {
  if (!openid) return [];
  try {
    const stats = await db.collection("user_product_purchase_stats")
      .where({ userOpenid: openid })
      .orderBy("purchaseCount", "desc")
      .orderBy("lastPurchasedAt", "desc")
      .limit(500)
      .get();
    const productMap = new Map(allProducts.map((item) => [item._id, item]));
    return (stats.data || [])
      .map((stat) => productMap.get(stat.productId))
      .filter(Boolean);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (/collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message)) return [];
    throw err;
  }
}

function compareBy(sortBy) {
  return (a, b) => {
    if (sortBy === "price_asc") return Number(a.price || 0) - Number(b.price || 0);
    if (sortBy === "price_desc") return Number(b.price || 0) - Number(a.price || 0);
    if (sortBy === "created_desc") return String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || ""));
    if (sortBy === "production_desc") return String(b.productionDate || "").localeCompare(String(a.productionDate || ""));
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  };
}

exports.main = async (event = {}) => {
  try {
    const sectionKey = String(event.sectionKey || "").trim();
    if (!SECTION_BY_KEY[sectionKey]) {
      return {
        ok: false,
        code: "INVALID_RECOMMEND_SECTION",
        message: "推荐分类不存在"
      };
    }
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const keyword = normalizeSearchText(event.keyword || "");
    const category = String(event.category || "").trim();
    const sortBy = String(event.sortBy || "default");

    const openid = cloud.getWXContext().OPENID;
    const allProducts = await getAllVisibleProducts();
    let matched = sectionKey === "frequent_purchase"
      ? await getFrequentProducts(openid, allProducts)
      : allProducts.filter((item) => matchesSection(item, sectionKey));
    if (keyword) {
      matched = matched.filter((item) => (item.searchText || buildSearchText(item)).includes(keyword));
    }
    if (category) {
      matched = matched.filter((item) => String(item.category || "") === category);
    }
    matched = matched.sort(compareBy(sortBy));

    const categories = Array.from(new Set(matched.map((item) => item.category).filter(Boolean)));
    const total = matched.length;
    const start = (page - 1) * pageSize;
    const products = matched.slice(start, start + pageSize).map((item) => decoratePublicProduct(item));

    return {
      ok: true,
      data: {
        sectionKey,
        sectionTitle: SECTION_BY_KEY[sectionKey].sectionTitle,
        products,
        categories,
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total
      }
    };
  } catch (err) {
    return { ok: false, message: err.message || "获取推荐商品失败" };
  }
};
