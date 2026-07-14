const { actorFromAdmin, idempotencyFailure } = require("./statusHandler");

function createProductWriteHandler({ service }) {
  if (!service || typeof service.createProduct !== "function" || typeof service.updateLegacyFull !== "function") {
    throw new Error("product write service is required");
  }
  return async function handleProductWrite(event = {}, admin = {}) {
    const action = event.action;
    try {
      if (action === "create") {
        const data = await service.createProduct({
          actor: actorFromAdmin(admin),
          input: event.product || {},
          idempotencyKey: event.idempotencyKey,
          allowMissingIdempotencyKey: true,
          legacy: true
        });
        return { ok: true, data: { productId: data.productId, version: data.version } };
      }
      if (action === "update") {
        const productId = String(event.productId || "").trim();
        if (!productId) return { ok: false, message: "缺少商品 ID" };
        const data = await service.updateLegacyFull({
          actor: actorFromAdmin(admin),
          input: {
            productId,
            product: event.product || {},
            expectedVersion: event.expectedVersion,
            expectedStock: event.expectedStock,
            reason: event.reason
          },
          idempotencyKey: event.idempotencyKey,
          allowMissingIdempotencyKey: true
        });
        return {
          ok: true,
          data: { productId, version: data.version, ...(data.changed === false ? { unchanged: true } : {}) }
        };
      }
      return { ok: false, message: "未知操作" };
    } catch (error) {
      return idempotencyFailure(error) || { ok: false, code: error.code, message: error.message || "商品操作失败" };
    }
  };
}

module.exports = { createProductWriteHandler };
