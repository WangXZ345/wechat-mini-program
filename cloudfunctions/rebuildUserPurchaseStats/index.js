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

async function requireMaintenanceAdmin() {
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
    || permissions.includes("admin:maintenance")
    || permissions.includes("system:settings");
  if (!allowed) throw new Error("无权重建常购统计");
  return { ...admin, openid, adminId: admin._id || admin.id || "" };
}

async function removeStats(userOpenid) {
  let removed = 0;
  while (true) {
    let query = db.collection("user_product_purchase_stats");
    if (userOpenid) query = query.where({ userOpenid });
    const res = await query.limit(100).get();
    if (!res.data.length) break;
    await Promise.all(res.data.map((item) => {
      return db.collection("user_product_purchase_stats").doc(item._id).remove();
    }));
    removed += res.data.length;
    if (res.data.length < 100) break;
  }
  return removed;
}

function isPaidOrder(order) {
  if (!order || order.paymentStatus !== "paid") return false;
  return !["rejected", "cancelled", "canceled", "abnormal"].includes(order.status);
}

async function getPaidOrders(userOpenid) {
  const orders = [];
  let skip = 0;
  while (skip < 5000) {
    let query = db.collection("orders").where(userOpenid ? {
      userOpenid,
      paymentStatus: "paid"
    } : {
      paymentStatus: "paid"
    });
    const res = await query.orderBy("createdAt", "asc").skip(skip).limit(100).get();
    orders.push(...res.data.filter(isPaidOrder));
    if (res.data.length < 100) break;
    skip += 100;
  }
  return orders;
}

async function getOrderItems(order) {
  try {
    const res = await db.collection("order_items").where({ orderId: order._id }).limit(100).get();
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

async function safeGetProduct(productId) {
  try {
    return (await db.collection("products").doc(productId).get()).data || null;
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

function dateMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

async function buildStats(orders) {
  const stats = {};
  for (const order of orders) {
    if (!order.userOpenid) continue;
    const paidAt = order.paymentConfirmedAt || order.paidMarkedAt || order.updatedAt || order.createdAt || new Date();
    const items = mergeOrderItems(await getOrderItems(order));
    for (const item of items) {
      const key = `${order.userOpenid}::${item.productId}`;
      const product = await safeGetProduct(item.productId);
      if (!stats[key]) {
        stats[key] = {
          userId: order.userId || "",
          userOpenid: order.userOpenid,
          productId: item.productId,
          productNameSnapshot: product && product.name || item.productName || order.productName || "",
          productImageSnapshot: product && product.imageUrl || item.productImage || "",
          specificationSnapshot: product && product.specification || item.specification || "",
          productionDateSnapshot: product && product.productionDate || item.productionDate || "",
          purchaseCount: 0,
          totalQuantity: 0,
          totalAmount: 0,
          firstPurchasedAt: paidAt,
          lastPurchasedAt: paidAt
        };
      }
      const stat = stats[key];
      stat.purchaseCount += 1;
      stat.totalQuantity += item.quantity;
      stat.totalAmount += Number(item.totalAmount || 0);
      if (dateMillis(paidAt) < dateMillis(stat.firstPurchasedAt)) stat.firstPurchasedAt = paidAt;
      if (dateMillis(paidAt) >= dateMillis(stat.lastPurchasedAt)) stat.lastPurchasedAt = paidAt;
    }
  }
  return Object.values(stats);
}

async function writeStats(stats) {
  const now = db.serverDate();
  for (const stat of stats) {
    await db.collection("user_product_purchase_stats").add({
      data: {
        ...stat,
        createdAt: now,
        updatedAt: now
      }
    });
  }
}

async function markOrdersUpdated(orders) {
  for (const order of orders) {
    await db.collection("orders").doc(order._id).update({
      data: {
        purchaseStatsUpdated: true,
        purchaseStatsUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  }
}

async function logOperation(admin, result) {
  await ensureCollection("admin_operation_logs");
  await db.collection("admin_operation_logs").add({
    data: {
      operatorId: admin.adminId,
      operatorOpenid: admin.openid,
      operatorRole: admin.role || "",
      action: "purchase_stats:rebuild",
      resourceType: result.userOpenid ? "user_product_purchase_stats" : "all_user_product_purchase_stats",
      resourceId: result.userOpenid || "",
      beforeData: null,
      afterData: result,
      description: "Rebuild user frequent purchase stats",
      createdAt: db.serverDate()
    }
  });
}

exports.main = async (event = {}) => {
  try {
    const admin = await requireMaintenanceAdmin();
    await ensureCollection("user_product_purchase_stats");
    const userOpenid = String(event.userOpenid || "").trim();
    if (!userOpenid && event.fullRebuild !== true) {
      return fail("全量重建需要传入 fullRebuild: true");
    }

    const removedCount = await removeStats(userOpenid);
    const orders = await getPaidOrders(userOpenid);
    const stats = await buildStats(orders);
    await writeStats(stats);
    await markOrdersUpdated(orders);

    const result = {
      success: true,
      userOpenid,
      removedCount,
      orderCount: orders.length,
      statCount: stats.length
    };
    await logOperation(admin, result);
    return ok(result);
  } catch (err) {
    return fail(err.message || "重建常购统计失败");
  }
};
