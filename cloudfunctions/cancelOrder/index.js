const cloud = require("wx-server-sdk");
const stockAlert = require("./stockAlert");
const { applyInventoryMutationInTransaction } = require("./inventoryMutationService");
const { createOrderCancellationService } = require("./orderCancellationService");
const { reconcileAccountAfterCancellation } = require("./accountRecalculation");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const cancellationService = createOrderCancellationService({
  db,
  stockAlert,
  applyInventoryMutationInTransaction
});

function failure(err) {
  return {
    ok: false,
    code: err && err.code || "CANCEL_ORDER_FAILED",
    message: err && err.message || "取消订单失败"
  };
}

exports.main = async (event = {}) => {
  const orderId = String(event.orderId || "").trim();
  if (!orderId) return failure({ code: "ORDER_ID_REQUIRED", message: "缺少订单 ID" });

  try {
    const currentOpenid = cloud.getWXContext().OPENID;
    const isAdmin = event.operatorType === "admin";
    let actor;

    if (isAdmin) {
      const adminRes = await db.collection("admin_users").where({
        openid: currentOpenid,
        isActive: _.neq(false),
        status: _.neq("disabled")
      }).limit(1).get();
      const admin = adminRes.data && adminRes.data[0];
      if (!admin) return failure({ code: "ADMIN_AUTH_FAILED", message: "管理员身份验证失败" });
      if (!["super_admin", "customer_service"].includes(admin.role)) {
        return failure({ code: "FORBIDDEN", message: "当前角色无权取消订单" });
      }
      actor = {
        id: admin._id || currentOpenid,
        openid: currentOpenid,
        kind: "admin",
        role: admin.role,
        sourceClient: "miniprogram"
      };
    } else {
      actor = {
        id: currentOpenid,
        openid: currentOpenid,
        kind: "user",
        role: "user",
        sourceClient: "miniprogram"
      };
    }

    const result = await cancellationService.cancel({
      actor,
      orderId,
      reason: event.reason,
      idempotencyKey: event.idempotencyKey
    });

    const { accountRecalculationPending, warning } = await reconcileAccountAfterCancellation({
      cloud, db, result, logger: console
    });

    return {
      ok: true,
      data: {
        orderId: result.orderId,
        status: result.status,
        message: warning || result.message,
        reused: result.reused === true,
        inventoryRestored: result.inventoryRestored === true,
        accountRecalculationPending,
        warning
      }
    };
  } catch (err) {
    console.error("cancelOrder error:", {
      code: err && (err.code || err.errCode) || "CANCEL_ORDER_FAILED"
    });
    return failure(err);
  }
};
