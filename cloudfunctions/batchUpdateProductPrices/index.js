const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const CHANGE_TYPES = ["set", "increase_amount", "decrease_amount", "increase_percent", "decrease_percent"];
const MAX_BATCH = 200;
const { requirePermission } = require("./auth");
const { runIdempotentAction } = require("./idempotency");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("No admin permission");
  return openid;
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    if (!/exist|already|collection exists/i.test(err.message || "")) throw err;
  }
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

function nextPrice(beforePrice, changeType, changeValue) {
  const value = Number(changeValue);
  if (!Number.isFinite(value)) throw new Error("Invalid price change value");
  if (changeType === "set") return Math.round(value);
  if (changeType === "increase_amount") return beforePrice + Math.round(value);
  if (changeType === "decrease_amount") return beforePrice - Math.round(value);
  if (changeType === "increase_percent") return Math.round(beforePrice * (1 + value / 100));
  if (changeType === "decrease_percent") return Math.round(beforePrice * (1 - value / 100));
  throw new Error("Invalid price change type");
}

exports.main = async (event = {}) => {
  try {
    const admin = await requirePermission("product:update_price");
    const operatorOpenid = admin.openid;
    await ensureCollection("price_logs");

    const productIds = Array.isArray(event.productIds) ? Array.from(new Set(event.productIds.filter(Boolean))) : [];
    const changeType = String(event.changeType || "");
    const changeValue = Number(event.changeValue);
    const reason = String(event.reason || "").trim();
    const previewOnly = event.previewOnly === true;
    const batchOperationId = String(event.batchOperationId || event.idempotencyKey || "").trim();

    if (!productIds.length) return { ok: false, message: "Please select products" };
    if (productIds.length > MAX_BATCH) return { ok: false, message: `Max ${MAX_BATCH} products per batch` };
    if (!CHANGE_TYPES.includes(changeType)) return { ok: false, message: "Invalid price change type" };
    if (!Number.isFinite(changeValue)) return { ok: false, message: "Invalid price change value" };

    const products = [];
    for (const id of productIds) {
      try {
        const product = (await db.collection("products").doc(id).get()).data;
        if (product) products.push(product);
      } catch (err) {
        products.push({ _id: id, missing: true });
      }
    }

    const preview = products.map((product) => {
      if (product.missing) return { productId: product._id, ok: false, message: "Product not found" };
      const beforePrice = Number(product.price || 0);
      const afterPrice = nextPrice(beforePrice, changeType, changeValue);
      return {
        productId: product._id,
        productIndex: product.productIndex || "",
        productName: product.name || "",
        beforePrice,
        afterPrice,
        ok: Number.isInteger(afterPrice) && afterPrice >= 0,
        message: afterPrice < 0 ? "Price cannot be negative" : ""
      };
    });

    const invalid = preview.filter((item) => !item.ok);
    if (invalid.length) return { ok: false, message: invalid[0].message || "Invalid price preview", data: { preview } };
    if (previewOnly) return { ok: true, data: { preview, total: preview.length, hasMore: false } };

    return await runIdempotentAction({
      db,
      actionType: "batch_update_price",
      idempotencyKey: event.idempotencyKey,
      operatorIdentity: admin._id || admin.id || admin.openid,
      operatorType: "admin",
      scope: "admin",
      scopeId: batchOperationId,
      openid: admin.openid,
      adminId: admin._id || admin.id || "",
      payload: { batchOperationId, productIds, changeType, changeValue, reason }
    }, async () => {
    let successCount = 0;
    const failures = [];
    await db.runTransaction(async (tx) => {
      for (const item of preview) {
        try {
          const businessKey = `batch_price:${batchOperationId}:${item.productId}`;
          const existingLog = await tx.collection("price_logs").where({ businessKey }).limit(1).get().catch(() => ({ data: [] }));
          if (existingLog.data && existingLog.data[0]) {
            successCount += 1;
            continue;
          }
          const product = (await tx.collection("products").doc(item.productId).get()).data;
          if (!product) throw new Error("Product not found");
          await tx.collection("products").doc(item.productId).update({
            data: {
              price: item.afterPrice,
              searchText: buildProductSearchText({ ...product, price: item.afterPrice }),
              priceUpdatedAt: db.serverDate(),
              priceUpdatedBy: operatorOpenid,
              updatedAt: db.serverDate()
            }
          });
          await tx.collection("price_logs").add({
            data: {
              businessKey,
              sourceType: "batch_price",
              sourceId: batchOperationId,
              idempotencyKey: event.idempotencyKey || "",
              productId: item.productId,
              productIndex: product.productIndex || "",
              productName: product.name || "",
              beforePrice: item.beforePrice,
              afterPrice: item.afterPrice,
              changeType,
              changeValue,
              operatorId: operatorOpenid,
              operatorOpenid,
              reason,
              createdAt: db.serverDate()
            }
          });
          successCount += 1;
        } catch (err) {
          failures.push({ productId: item.productId, message: err.message || "Update failed" });
        }
      }
    });

    return { batchOperationId, successCount, failedCount: failures.length, failures, preview };
    });
  } catch (err) {
    return { ok: false, message: err.message || "Batch price update failed" };
  }
};

