const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const {
  trimKeyword,
  normalizeKeyword,
  isValidSearchKeyword,
  buildSuggestionKeyword
} = require("./common/search");

const MAX_LIMIT = 20;
const QUERY_LIMIT = 80;
const SUGGESTION_PRODUCT_FIELDS = {
  _id: true,
  name: true,
  brand: true,
  category: true,
  specification: true,
  productionDate: true,
  tags: true,
  skuCode: true,
  productIndex: true,
  searchText: true,
  price: true,
  isActive: true,
  isDeleted: true,
  status: true
};

function isVisibleProduct(item = {}) {
  return item
    && item.isActive === true
    && item.isDeleted !== true
    && item.status !== "deleted"
    && Number(item.price || 0) > 0;
}

function normalizeText(text) {
  return normalizeKeyword(text);
}

function productSearchText(product = {}) {
  const tags = Array.isArray(product.tags) ? product.tags.join(" ") : product.tags || "";
  return normalizeText([
    product.searchText,
    product.name,
    product.brand,
    product.category,
    product.specification,
    product.productionDate,
    tags,
    product.skuCode,
    product.productIndex
  ].filter(Boolean).join(" "));
}

function relevance(item, query) {
  const text = normalizeText(item.keyword);
  const typeWeight = { product: 0, brand: 10, category: 20, spec: 30, tag: 40 }[item.type] || 50;
  if (text === query) return typeWeight;
  if (text.indexOf(query) === 0) return typeWeight + 2;
  return typeWeight + 8;
}

async function fetchCandidateProducts(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fuzzy = db.RegExp({ regexp: escaped, options: "i" });
  const queries = [
    { isActive: true, searchText: fuzzy },
    { isActive: true, name: fuzzy },
    { isActive: true, brand: fuzzy },
    { isActive: true, category: fuzzy },
    { isActive: true, specification: fuzzy },
    { isActive: true, tags: fuzzy }
  ];
  const map = {};
  for (let i = 0; i < queries.length; i += 1) {
    try {
      const res = await db.collection("products")
        .where(queries[i])
        .field(SUGGESTION_PRODUCT_FIELDS)
        .limit(QUERY_LIMIT)
        .get();
      (res.data || []).forEach((item) => {
        if (isVisibleProduct(item)) map[item._id] = item;
      });
    } catch (err) {
      // Some fields may not be indexed or may not support regex in older data. Continue with other fields.
    }
  }
  return Object.values(map);
}

exports.main = async (event = {}) => {
  try {
    const keyword = trimKeyword(event.keyword || "");
    const normalized = normalizeKeyword(keyword);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(event.limit, 10) || 10));
    if (!isValidSearchKeyword(keyword)) {
      return { ok: true, data: { suggestions: [] } };
    }

    const candidates = (await fetchCandidateProducts(keyword))
      .filter((product) => productSearchText(product).includes(normalized));

    const suggestionMap = {};
    candidates.forEach((product) => {
      buildSuggestionKeyword(product).forEach((item) => {
        const key = normalizeKeyword(item.keyword);
        if (!key || !key.includes(normalized)) return;
        const before = suggestionMap[key];
        const next = {
          type: item.type,
          keyword: item.keyword,
          highlight: keyword,
          productId: item.productId || "",
          count: before ? Number(before.count || 1) + 1 : 1
        };
        if (!before || relevance(next, normalized) < relevance(before, normalized)) {
          suggestionMap[key] = next;
        } else {
          before.count = next.count;
        }
      });
    });

    const suggestions = Object.values(suggestionMap)
      .sort((a, b) => relevance(a, normalized) - relevance(b, normalized) || b.count - a.count || a.keyword.length - b.keyword.length)
      .slice(0, limit);

    return { ok: true, data: { suggestions } };
  } catch (err) {
    return { ok: false, message: err.message || "获取搜索联想失败" };
  }
};
