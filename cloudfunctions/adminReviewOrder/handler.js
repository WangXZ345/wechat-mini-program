"use strict";

function createHandler({ service, requirePermission } = {}) {
  if (!service || typeof service.reviewOrder !== "function") throw new Error("order review service is required");
  if (typeof requirePermission !== "function") throw new Error("permission helper is required");

  return async function main(event = {}) {
    const orderId = String(event.orderId || "").trim();
    const action = event.action === "approve" || event.action === "reject" ? event.action : "";
    if (!orderId) return { ok: false, code: "ORDER_ID_REQUIRED", message: "缺少订单 ID" };
    if (!action) return { ok: false, code: "DECISION_INVALID", message: "审核操作无效" };

    try {
      const admin = await requirePermission(action === "reject" ? "order:reject" : "order:review");
      const result = await service.reviewOrder({
        actor: { ...admin, sourceClient: "miniprogram", id: admin.id || admin._id || admin.openid },
        input: { orderId, action },
        idempotencyKey: event.idempotencyKey,
        strict: false
      });
      return { ok: true, data: result };
    } catch (error) {
      return { ok: false, code: error.code || "ORDER_REVIEW_FAILED", message: error.message || "审核失败" };
    }
  };
}

module.exports = { createHandler };
