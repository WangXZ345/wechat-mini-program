const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function ok(data) {
  return { ok: true, data };
}

function fail(message, code = "") {
  return { ok: false, code, message };
}

function publicAfterSale(row = {}) {
  return {
    _id: row._id || "",
    afterSaleNo: row.afterSaleNo || "",
    orderId: row.orderId || "",
    orderNo: row.orderNo || "",
    afterSaleType: row.afterSaleType || "",
    afterSaleReason: row.afterSaleReason || "",
    afterSaleStatus: row.afterSaleStatus || "",
    refundStatus: row.refundStatus || "none",
    requestedRefundAmount: Number(row.requestedRefundAmount || 0),
    approvedRefundAmount: Number(row.approvedRefundAmount || 0),
    actualRefundAmount: Number(row.actualRefundAmount || 0),
    returnRequired: row.returnRequired === true,
    returnLogistics: row.returnLogistics || {},
    evidenceImages: Array.isArray(row.evidenceImages) ? row.evidenceImages : [],
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    reviewedAt: row.reviewedAt || null,
    refundedAt: row.refundedAt || null,
    completedAt: row.completedAt || null
  };
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail("登录状态已失效，请重新进入小程序后再试", "LOGIN_REQUIRED");

  const limit = Math.max(1, Math.min(100, Number(event.pageSize || event.limit || 50)));
  try {
    const res = await db.collection("after_sales")
      .where({ openid })
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    const rows = res.data || [];
    return ok({
      afterSales: rows.map(publicAfterSale),
      total: rows.length
    });
  } catch (err) {
    return fail(err.message || "获取售后列表失败", err.code || "");
  }
};
