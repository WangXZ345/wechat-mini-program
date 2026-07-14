function actorFromAdmin(admin = {}) {
  return {
    id: admin.openid || admin._id || admin.id || "",
    openid: admin.openid || "",
    role: admin.role || "",
    permissions: Array.isArray(admin.permissions) ? admin.permissions.slice() : [],
    status: admin.status || "active",
    isActive: admin.isActive !== false,
    sourceClient: "miniprogram"
  };
}

function idempotencyFailure(error) {
  if (!error || !/^IDEMPOTENCY_/.test(error.code || "")) return null;
  return {
    ok: false,
    code: error.code,
    message: error.message || "幂等处理失败",
    data: error.details || {
      duplicate: error.code !== "IDEMPOTENCY_KEY_REQUIRED",
      idempotencyStatus: error.code === "IDEMPOTENCY_KEY_CONFLICT" ? "conflict" : "failed"
    }
  };
}

function legacyResult(data = {}) {
  const result = {
    productId: data.productId,
    beforePrice: data.beforePrice,
    afterPrice: data.afterPrice
  };
  if (data.changed === false) result.unchanged = true;
  return result;
}

function createLegacyHandler({ requirePermission, service }) {
  if (typeof requirePermission !== "function") throw new Error("requirePermission is required");
  if (!service || typeof service.setPrice !== "function") throw new Error("product price service is required");

  return async function legacyUpdateProductPrice(event = {}) {
    try {
      const admin = await requirePermission("product:update_price");
      const productId = String(event.productId || "").trim();
      const newPrice = Number(event.newPrice);
      if (!productId) return { ok: false, message: "缺少商品 ID" };
      if (!Number.isInteger(newPrice) || newPrice < 0) return { ok: false, message: "Invalid price" };
      const data = await service.setPrice({
        actor: actorFromAdmin(admin),
        input: {
          productId,
          newPriceCents: newPrice,
          reason: String(event.reason || "").trim()
        },
        idempotencyKey: event.idempotencyKey,
        requireExpectedVersion: false,
        allowMissingIdempotencyKey: true
      });
      return { ok: true, data: legacyResult(data) };
    } catch (error) {
      return idempotencyFailure(error) || { ok: false, message: error.message || "修改价格失败" };
    }
  };
}

module.exports = { actorFromAdmin, createLegacyHandler, idempotencyFailure, legacyResult };
