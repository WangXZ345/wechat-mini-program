const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const {
  decoratePublicProduct,
  normalizePublicTags
} = require("./common/recommend");
const MAX_PAGE_SIZE = 50;
const SEARCH_FIELDS = ["name", "baseName", "specification", "productionDate", "description", "keywords", "productIndex", "skuCode"];
const PRODUCT_LIST_FIELDS = {
  _id: true,
  name: true,
  baseName: true,
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
  updatedAt: true,
  searchText: true,
  description: true,
  keywords: true,
  productIndex: true,
  skuCode: true
};

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

function buildProductSearchText(product = {}) {
  const keywords = Array.isArray(product.keywords) ? product.keywords.join(" ") : product.keywords || "";
  return normalizeSearchText(SEARCH_FIELDS.map((key) => product[key]).filter(Boolean).concat(keywords).join(" "));
}

function sanitizeProduct(item) {
  return {
    ...decoratePublicProduct(item),
    description: item.description || "",
    productIndex: item.productIndex || "",
    skuCode: item.skuCode || "",
    isSpecial: Boolean(item.isSpecial || item.isOnSale),
    isWholesale: item.isWholesale !== false
  };
}

function flagMatches(product, flag, tag) {
  if (product[flag] === true) return true;
  return normalizePublicTags(product.tags || []).includes(tag);
}

function applyTagFilters(products, event = {}) {
  let matched = products;
  [
    ["isNew", "新货"],
    ["isDefective", "瑕疵"],
    ["isHot", "热销"]
  ].forEach(([flag, tag]) => {
    if (event[flag] === true || event[flag] === "true") {
      matched = matched.filter((product) => flagMatches(product, flag, tag));
    }
  });
  const tags = normalizePublicTags(event.tags || []);
  if (tags.length) {
    matched = matched.filter((product) => {
      const productTags = normalizePublicTags(product.tags || []);
      return tags.some((tag) => productTags.includes(tag));
    });
  }
  return matched;
}

function isMissingCollection(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

async function getFavoriteSet(openid, productIds) {
  if (!openid || !productIds.length) return {};
  try {
    const res = await db.collection("user_favorites")
      .where({ userOpenid: openid, productId: _.in(productIds) })
      .field({ productId: true })
      .limit(productIds.length)
      .get();
    return (res.data || []).reduce((map, item) => {
      map[item.productId] = true;
      return map;
    }, {});
  } catch (err) {
    if (isMissingCollection(err)) return {};
    throw err;
  }
}

async function getAllActiveProducts() {
  const pageSize = 100;
  const maxRows = 2000;
  let skip = 0;
  let products = [];
  while (skip < maxRows) {
    const res = await db.collection("products")
      .where({ isActive: true })
      .field(PRODUCT_LIST_FIELDS)
      .orderBy("updatedAt", "desc")
      .skip(skip)
      .limit(pageSize)
      .get();
    products = products.concat(res.data);
    if (res.data.length < pageSize) break;
    skip += pageSize;
  }
  return products;
}

exports.main = async (event = {}) => {
  try {
    const openid = cloud.getWXContext().OPENID;
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const keyword = normalizeSearchText(event.keyword || "");
    const allProducts = await getAllActiveProducts();

    let matched = applyTagFilters(allProducts.filter((item) => item.isDeleted !== true && item.status !== "deleted"), event);
    if (keyword) {
      const exact = [];
      const fuzzy = [];
      allProducts.forEach((product) => {
        const indexText = normalizeSearchText([product.productIndex, product.skuCode].filter(Boolean).join(" "));
        if (indexText && indexText === keyword) {
          exact.push(product);
          return;
        }
        const searchText = product.searchText || buildProductSearchText(product);
        if (searchText.includes(keyword)) fuzzy.push(product);
      });
      matched = exact.concat(fuzzy.filter((item) => !exact.some((row) => row._id === item._id)));
    }
    if (event.category) {
      matched = matched.filter((item) => String(item.category || "") === String(event.category || ""));
    }

    const total = matched.length;
    const start = (page - 1) * pageSize;
    const products = matched.slice(start, start + pageSize).map(sanitizeProduct);
    const favoriteMap = await getFavoriteSet(openid, products.map((item) => item._id));
    products.forEach((item) => {
      item.isFavorite = Boolean(favoriteMap[item._id]);
    });
    return { ok: true, data: { products, total, hasMore: start + pageSize < total } };
  } catch (err) {
    return { ok: false, message: err.message || "搜索商品失败" };
  }
};
