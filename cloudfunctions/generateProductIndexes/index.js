const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

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

function makeIndex(seed) {
  return `P${String(seed).padStart(6, "0")}`;
}

async function getAllProductIndexes() {
  const pageSize = 100;
  let skip = 0;
  let productIndexes = [];
  while (skip < 3000) {
    const res = await db.collection("products").skip(skip).limit(pageSize).get();
    productIndexes = productIndexes.concat(res.data.map((item) => item.productIndex).filter(Boolean));
    if (res.data.length < pageSize) break;
    skip += pageSize;
  }
  return productIndexes;
}

async function getProductBatch(cursor, limit) {
  const res = await db.collection("products").skip(cursor).limit(limit).get();
  return res.data || [];
}

exports.main = async (event = {}) => {
  try {
    await requirePermission("product:update");
    const cursor = Math.max(0, parseInt(event.cursor, 10) || 0);
    const limit = Math.min(25, Math.max(1, parseInt(event.limit, 10) || 20));
    const products = await getProductBatch(cursor, limit);
    const needsIndex = products.some((item) => !item.productIndex);
    const used = needsIndex ? new Set(await getAllProductIndexes()) : new Set();
    let seed = 1;
    let updatedCount = 0;
    let scannedCount = 0;

    for (const product of products) {
      scannedCount += 1;
      let productIndex = product.productIndex || "";
      if (!productIndex) {
        while (used.has(makeIndex(seed))) seed += 1;
        productIndex = makeIndex(seed);
        used.add(productIndex);
        seed += 1;
      }
      const searchText = buildProductSearchText({ ...product, productIndex });
      if (product.productIndex === productIndex && product.searchText === searchText) continue;
      await db.collection("products").doc(product._id).update({ data: { productIndex, searchText, updatedAt: db.serverDate() } });
      updatedCount += 1;
    }

    return {
      ok: true,
      data: {
        updatedCount,
        scannedCount,
        nextCursor: cursor + scannedCount,
        hasMore: scannedCount === limit
      }
    };
  } catch (err) {
    return { ok: false, message: err.message || "鐢熸垚鍟嗗搧绱㈠紩澶辫触" };
  }
};

