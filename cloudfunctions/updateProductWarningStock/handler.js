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

function normalizeLegacyWarningStock(value) {
  if (value === undefined || value === null || value === "") return 10;
  const warningStock = Number(value);
  if (!Number.isSafeInteger(warningStock) || warningStock < 0 || warningStock > 99999) {
    const error = new Error("预警库存必须是 0 到 99999 的整数");
    error.code = "WARNING_THRESHOLD_INVALID";
    throw error;
  }
  return warningStock;
}

function createLegacyHandler({ requirePermission, service }) {
  if (typeof requirePermission !== "function") throw new Error("requirePermission is required");
  if (!service || typeof service.setWarningStock !== "function") throw new Error("inventory warning service is required");

  return async function legacyUpdateProductWarningStock(event = {}) {
    try {
      const admin = await requirePermission("inventory:set_warning");
      const productId = String(event.productId || "").trim();
      if (!productId) return { ok: false, message: "PRODUCT_ID_REQUIRED" };
      const command = {
        actor: actorFromAdmin(admin),
        input: {
          productId,
          warningThreshold: normalizeLegacyWarningStock(event.warningStock),
          reason: String(event.reason || "").trim()
        },
        idempotencyKey: event.idempotencyKey,
        requireExpectedVersion: false,
        allowMissingIdempotencyKey: true
      };
      if (typeof event.autoHideWhenOutOfStock === "boolean") {
        command.legacyAutoHideWhenOutOfStock = event.autoHideWhenOutOfStock;
      }
      return { ok: true, data: await service.setWarningStock(command) };
    } catch (error) {
      return idempotencyFailure(error) || { ok: false, message: error.message || "UPDATE_WARNING_STOCK_FAILED" };
    }
  };
}

module.exports = { actorFromAdmin, createLegacyHandler, idempotencyFailure, normalizeLegacyWarningStock };
