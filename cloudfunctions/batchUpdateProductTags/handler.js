const LEGACY_FAILURE_MESSAGES = Object.freeze({
  PRODUCT_NOT_FOUND: "商品不存在",
  DATA_VERSION_CONFLICT: "商品已变化，请刷新后重试",
  DATA_VERSION_INVALID: "商品数据版本异常",
  DATA_INTERNAL_TAGS_INVALID: "商品内部标签数据异常"
});
const SAFE_ERROR_CODES = new Set([
  "FORBIDDEN",
  "INVALID_ACTOR",
  "BATCH_ITEMS_REQUIRED",
  "BATCH_LIMIT_EXCEEDED",
  "TAG_LIST_INVALID",
  "TAG_INVALID",
  "PUBLIC_TAG_INVALID",
  "INTERNAL_TAG_LIST_INVALID",
  "INTERNAL_TAG_INVALID",
  "TAG_FLAGS_INVALID",
  "TAG_OPERATION_CONFLICT",
  "DEFECT_DESCRIPTION_INVALID",
  "REASON_INVALID"
]);

function legacyFailureMessage(code) {
  return LEGACY_FAILURE_MESSAGES[code] || "更新失败，请重试";
}

function createBatchUpdateProductTagsHandler({ requirePermission, service, idempotencyErrorResponse } = {}) {
  if (typeof requirePermission !== "function") throw new Error("batch tag handler requires permission checker");
  if (!service || typeof service.setManyLegacyTags !== "function") throw new Error("batch tag handler requires product tag service");

  return async function handleBatchUpdateProductTags(event = {}) {
    try {
      const admin = await requirePermission("product:tag:batch_update");
      const batchOperationId = String(event.batchOperationId || event.idempotencyKey || "").trim();
      const result = await service.setManyLegacyTags({
        actor: {
          id: admin._id || admin.id || admin.openid,
          openid: admin.openid || "",
          role: admin.role || "",
          permissions: Array.isArray(admin.permissions) ? admin.permissions : [],
          status: admin.status === "disabled" ? "disabled" : "active",
          isActive: admin.isActive !== false,
          sourceClient: "miniprogram"
        },
        input: {
          productIds: event.productIds,
          addTags: event.addTags,
          removeTags: event.removeTags,
          addInternalTags: event.addInternalTags,
          removeInternalTags: event.removeInternalTags,
          setFlags: event.setFlags,
          ...(Object.prototype.hasOwnProperty.call(event, "defectDescription")
            ? { defectDescription: event.defectDescription }
            : {}),
          reason: event.reason
        },
        idempotencyKey: event.idempotencyKey,
        batchOperationId
      });
      const failures = result.failures.map((failure) => ({
        productId: failure.id,
        reason: legacyFailureMessage(failure.code)
      }));
      return {
        ok: true,
        data: {
          batchOperationId,
          successCount: result.changedCount + result.unchangedCount,
          failureCount: result.failedCount,
          failures,
          warning: result.warningCount > 0
            ? `有 ${result.warningCount} 个瑕疵商品尚未填写瑕疵说明。`
            : "",
          duplicate: result.duplicate === true,
          idempotencyStatus: result.idempotencyStatus || "success"
        }
      };
    } catch (error) {
      const idempotencyFailure = typeof idempotencyErrorResponse === "function"
        ? idempotencyErrorResponse(error)
        : null;
      if (idempotencyFailure) return idempotencyFailure;
      const rawCode = error && error.code || "";
      const safeError = SAFE_ERROR_CODES.has(rawCode);
      return {
        ok: false,
        code: safeError ? rawCode : "BATCH_UPDATE_PRODUCT_TAGS_FAILED",
        message: safeError
          ? error.message
          : "批量更新商品标签失败"
      };
    }
  };
}

module.exports = { createBatchUpdateProductTagsHandler, legacyFailureMessage };
