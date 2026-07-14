const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function isMissingCollection(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) return;
    if (/createCollection is not a function/i.test(message)) return;
    throw err;
  }
}

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({
    openid,
    isActive: _.neq(false),
    status: _.neq("disabled")
  }).limit(1).get();
  const admin = res.data[0];
  if (!admin) throw new Error("无管理员权限");
  const permissions = Array.isArray(admin.permissions) ? admin.permissions : [];
  const role = admin.role || (admin.isSuperAdmin ? "super_admin" : "");
  const allowed = role === "super_admin" || role === "procurement"
    || permissions.includes("payment:confirm")
    || permissions.includes("payment:update_status")
    || permissions.includes("admin:maintenance")
    || permissions.includes("system:settings");
  if (!allowed) throw new Error("无权更新常购统计");
  return { ...admin, openid, adminId: admin._id || admin.id || "" };
}

function isPaidOrder(order) {
  if (!order) return false;
  if (order.paymentStatus !== "paid") return false;
  if (["rejected", "cancelled", "canceled", "abnormal"].includes(order.status)) return false;
  return true;
}

async function getOrderItems(tx, order) {
  try {
    const res = await tx.collection("order_items").where({ orderId: order._id }).limit(100).get();
    if (res.data && res.data.length) return res.data;
  } catch (err) {
    if (!isMissingCollection(err)) throw err;
  }

  if (!order.productId) return [];
  return [{
    orderId: order._id,
    productId: order.productId,
    productName: order.productName || "",
    productImage: order.productImage || "",
    specification: order.specification || "",
    productionDate: order.productionDate || "",
    quantity: Number(order.quantity || 0),
    unitPrice: Number(order.unitPrice || 0),
    totalAmount: Number(order.totalAmount || 0)
  }];
}

async function safeGetProduct(tx, productId) {
  try {
    return (await tx.collection("products").doc(productId).get()).data || null;
  } catch (err) {
    return null;
  }
}

function mergeOrderItems(items) {
  const map = {};
  items.forEach((item) => {
    const productId = item.productId;
    if (!productId) return;
    const quantity = Math.max(0, Math.floor(Number(item.quantity || 0)));
    if (!quantity) return;
    const unitPrice = Number(item.unitPrice || 0);
    const totalAmount = Number(item.totalAmount !== undefined ? item.totalAmount : unitPrice * quantity);
    if (!map[productId]) {
      map[productId] = { ...item, productId, quantity: 0, totalAmount: 0 };
    }
    map[productId].quantity += quantity;
    map[productId].totalAmount += totalAmount;
  });
  return Object.values(map);
}

async function updateOneOrder(orderId) {
  return db.runTransaction(async (tx) => {
    const order = (await tx.collection("orders").doc(orderId).get()).data;
    if (!order) return { orderId, skipped: true, reason: "order_not_found" };
    if (order.purchaseStatsUpdated === true) return { orderId, skipped: true, reason: "already_updated" };
    if (!isPaidOrder(order)) return { orderId, skipped: true, reason: "not_paid" };
    if (!order.userOpenid) return { orderId, skipped: true, reason: "missing_user" };

    const paidAt = order.paymentConfirmedAt || order.paidMarkedAt || order.updatedAt || order.createdAt || db.serverDate();
    const items = mergeOrderItems(await getOrderItems(tx, order));
    if (!items.length) {
      await tx.collection("orders").doc(orderId).update({
        data: {
          purchaseStatsUpdated: true,
          purchaseStatsUpdatedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return { orderId, skipped: true, reason: "no_items" };
    }

    for (const item of items) {
      const product = await safeGetProduct(tx, item.productId);
      const existing = await tx.collection("user_product_purchase_stats")
        .where({ userOpenid: order.userOpenid, productId: item.productId })
        .limit(1)
        .get();
      const snapshot = {
        userId: order.userId || "",
        userOpenid: order.userOpenid,
        productId: item.productId,
        productNameSnapshot: product && product.name || item.productName || order.productName || "",
        productImageSnapshot: product && product.imageUrl || item.productImage || "",
        specificationSnapshot: product && product.specification || item.specification || "",
        productionDateSnapshot: product && product.productionDate || item.productionDate || "",
        lastPurchasedAt: paidAt,
        updatedAt: db.serverDate()
      };

      if (existing.data[0]) {
        await tx.collection("user_product_purchase_stats").doc(existing.data[0]._id).update({
          data: {
            ...snapshot,
            purchaseCount: _.inc(1),
            totalQuantity: _.inc(item.quantity),
            totalAmount: _.inc(Number(item.totalAmount || 0))
          }
        });
      } else {
        await tx.collection("user_product_purchase_stats").add({
          data: {
            ...snapshot,
            purchaseCount: 1,
            totalQuantity: item.quantity,
            totalAmount: Number(item.totalAmount || 0),
            firstPurchasedAt: paidAt,
            createdAt: db.serverDate()
          }
        });
      }
    }

    await tx.collection("orders").doc(orderId).update({
      data: {
        purchaseStatsUpdated: true,
        purchaseStatsUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });

    return { orderId, skipped: false, itemCount: items.length };
  });
}

exports.main = async (event = {}) => {
  try {
    await requireAdmin();
    await ensureCollection("user_product_purchase_stats");
    const orderIds = Array.isArray(event.orderIds)
      ? event.orderIds
      : (event.orderId ? [event.orderId] : []);
    const uniqueOrderIds = Array.from(new Set(orderIds.map((id) => String(id || "").trim()).filter(Boolean)));
    if (!uniqueOrderIds.length) return fail("缺少订单 ID");

    const results = [];
    for (const orderId of uniqueOrderIds) {
      results.push(await updateOneOrder(orderId));
    }

    return ok({
      success: true,
      updatedCount: results.filter((item) => !item.skipped).length,
      skippedCount: results.filter((item) => item.skipped).length,
      results
    });
  } catch (err) {
    return fail(err.message || "更新常购统计失败");
  }
};
