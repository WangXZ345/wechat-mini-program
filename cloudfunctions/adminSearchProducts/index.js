const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const MAX_PAGE_SIZE = 100;
const { requireAnyPermission } = require("./auth");
const { normalizePublicTags, uniqueClean } = require("./recommend");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return openid;
}

function normalizeSearchText(text) {
  return String(text || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/(20\d{2})\s*[\u5e74./-]\s*(\d{1,2})\s*(?:\u6708)?/g, (all, year, month) => `${year}-${String(month).padStart(2, "0")}`)
    .replace(/milliliter/g, "ml")
    .replace(/(\d+(?:\.\d+)?)\s*m\s*l\b/g, "$1ml")
    .replace(/[锛屻€併€傦紱;:锛殀/\\()[\]{}"'`~!@#$%^&*_+=<>?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildProductSearchText(product = {}) {
  const keywords = Array.isArray(product.keywords) ? product.keywords.join(" ") : product.keywords || "";
  return normalizeSearchText([
    product.name,
    product.baseName,
    product.specification,
    product.productionDate,
    product.description,
    keywords,
    product.productIndex,
    product.skuCode
  ].filter(Boolean).join(" "));
}

async function getAllProducts(filters = {}) {
  const query = {};
  if (filters.isActive === true || filters.isActive === false) query.isActive = filters.isActive;
  if (["normal", "warning", "out_of_stock"].includes(filters.stockStatus)) query.stockStatus = filters.stockStatus;
  const pageSize = 100;
  const maxRows = 3000;
  let skip = 0;
  let products = [];
  while (skip < maxRows) {
    const res = await db.collection("products")
      .where(query)
      .orderBy("updatedAt", "desc")
      .skip(skip)
      .limit(pageSize)
      .get();
    products = products.concat(res.data);
    if (res.data.length < pageSize) break;
    skip += pageSize;
  }
  return products.filter((item) => item.isDeleted !== true);
}

function flagMatches(product, flag, tag) {
  if (product[flag] === true) return true;
  return normalizePublicTags(product.tags || []).includes(tag);
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.length === 7 ? `${text}-01` : text;
  const date = new Date(`${normalized}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function daysUntil(value, now) {
  const date = parseDate(value);
  if (!date) return null;
  return Math.ceil((date.getTime() - now.getTime()) / 86400000);
}

function daysSince(value, now) {
  const date = parseDate(value);
  if (!date) return null;
  return Math.floor((now.getTime() - date.getTime()) / 86400000);
}

function isExpiringProduct(product, now = new Date()) {
  const expiryDays = daysUntil(product.expiryDate, now);
  if (expiryDays !== null && expiryDays >= 0 && expiryDays <= 90) return true;
  if (expiryDays !== null) return false;
  const productionAgeDays = daysSince(product.productionDate, now);
  return productionAgeDays !== null && productionAgeDays >= 540;
}

function applyAdminFilters(products, filters = {}) {
  let matched = products;
  [
    ["isNew", "新货"],
    ["isDefective", "瑕疵"],
    ["isHot", "热销"]
  ].forEach(([flag, tag]) => {
    if (filters[flag] === true || filters[flag] === "true") {
      matched = matched.filter((product) => flagMatches(product, flag, tag));
    }
  });
  if (filters.defectDescription === "has") {
    matched = matched.filter((product) => String(product.defectDescription || "").trim());
  }
  if (filters.defectDescription === "none") {
    matched = matched.filter((product) => !String(product.defectDescription || "").trim());
  }
  if (filters.internalTag) {
    const target = String(filters.internalTag || "").trim();
    matched = matched.filter((product) => uniqueClean(product.internalTags || []).includes(target));
  }
  if (filters.expiring === true || filters.expiring === "true") {
    const now = new Date();
    matched = matched.filter((product) => isExpiringProduct(product, now));
  }
  const tags = normalizePublicTags(filters.tags || []);
  if (tags.length) {
    matched = matched.filter((product) => {
      const productTags = normalizePublicTags(product.tags || []);
      return tags.some((tag) => productTags.includes(tag));
    });
  }
  return matched;
}

exports.main = async (event = {}) => {
  try {
    await requireAnyPermission(["product:view", "product:analytics:view", "dashboard:view_product"]);
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(event.pageSize, 10) || 50));
    const keyword = normalizeSearchText(event.keyword || "");
    const allProducts = applyAdminFilters(await getAllProducts(event.filters || {}), event.filters || {});

    let matched = allProducts;
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

    const total = matched.length;
    const start = (page - 1) * pageSize;
    return {
      ok: true,
      data: {
        products: matched.slice(start, start + pageSize),
        total,
        hasMore: start + pageSize < total
      }
    };
  } catch (err) {
    return { ok: false, message: err.message || "鍚庡彴鎼滅储鍟嗗搧澶辫触" };
  }
};

