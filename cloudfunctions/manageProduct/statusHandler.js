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
    isActive: data.isActive,
    version: data.version
  };
  if (data.changed === false) result.unchanged = true;
  return result;
}

function legacyBatchResult(data = {}) {
  const changedCount = Number(data.changedCount || 0);
  const unchangedCount = Number(data.unchangedCount || 0);
  const failures = Array.isArray(data.failures)
    ? data.failures.map((failure) => ({
      id: String(failure && failure.id || ""),
      code: String(failure && failure.code || "PRODUCT_STATUS_UPDATE_FAILED")
    }))
    : [];
  return {
    changedCount,
    unchangedCount,
    failedCount: failures.length,
    failures,
    updatedCount: changedCount + unchangedCount
  };
}

function createStatusHandler({ requirePermission, service }) {
  if (typeof requirePermission !== "function") throw new Error("requirePermission is required");
  if (!service || typeof service.setStatus !== "function") throw new Error("product status service is required");

  return async function legacyProductStatus(event = {}) {
    try {
      const admin = await requirePermission("product:update_status");
      const productId = String(event.productId || "").trim();
      if (!productId) return { ok: false, message: "缺少商品 ID" };
      const data = await service.setStatus({
        actor: actorFromAdmin(admin),
        input: {
          productId,
          isActive: false,
          expectedIsActive: event.expectedIsActive,
          expectedVersion: event.expectedVersion,
          reason: String(event.reason || "后台商品下架").trim()
        },
        idempotencyKey: event.idempotencyKey,
        requireExpectedVersion: false,
        allowMissingIdempotencyKey: true
      });
      return { ok: true, data: legacyResult(data) };
    } catch (error) {
      return idempotencyFailure(error) || { ok: false, code: error.code, message: error.message || "商品下架失败" };
    }
  };
}

function createBulkActivateHandler({ requirePermission, service }) {
  if (typeof requirePermission !== "function") throw new Error("requirePermission is required");
  if (!service || typeof service.setManyStatuses !== "function") {
    throw new Error("product batch status service is required");
  }

  return async function bulkActivateProducts(event = {}) {
    try {
      const admin = await requirePermission("product:update_status");
      const hasSnapshotItems = Array.isArray(event.items) && event.items.length > 0;
      const items = hasSnapshotItems
        ? event.items
        : (Array.isArray(event.productIds) ? event.productIds : []).map((id) => ({ id }));
      const data = await service.setManyStatuses({
        actor: actorFromAdmin(admin),
        input: {
          isActive: event.isActive === undefined ? true : event.isActive,
          items,
          reason: String(event.reason || "后台批量上架").trim()
        },
        idempotencyKey: event.idempotencyKey,
        requireExpectedVersion: hasSnapshotItems,
        allowMissingIdempotencyKey: true
      });
      return { ok: true, data: legacyBatchResult(data) };
    } catch (error) {
      return idempotencyFailure(error)
        || { ok: false, code: error.code, message: error.message || "批量上架失败" };
    }
  };
}

module.exports = {
  actorFromAdmin,
  createStatusHandler,
  createBulkActivateHandler,
  idempotencyFailure,
  legacyResult,
  legacyBatchResult
};
