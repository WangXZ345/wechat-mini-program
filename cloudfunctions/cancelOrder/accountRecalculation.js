const PENDING_WARNING = "订单已取消，客户账款正在等待重新核对";

async function reconcileAccountAfterCancellation({ cloud, db, result, logger = console } = {}) {
  if (!result || result.accountRecalculationRequired !== true) {
    return { accountRecalculationPending: false, warning: "" };
  }
  try {
    const recalculated = await cloud.callFunction({
      name: "recalculateCustomerAccount",
      data: { userId: result.userId, userOpenid: result.userOpenid }
    });
    if (!recalculated || !recalculated.result || recalculated.result.ok !== true) {
      return { accountRecalculationPending: true, warning: PENDING_WARNING };
    }
    await db.collection("orders").doc(result.orderId).update({
      data: {
        accountRecalculationPending: false,
        accountRecalculatedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    return { accountRecalculationPending: false, warning: "" };
  } catch (error) {
    logger.warn("cancelOrder account recalculation pending", {
      code: error && (error.code || error.errCode) || "ACCOUNT_RECALCULATION_FAILED"
    });
    return { accountRecalculationPending: true, warning: PENDING_WARNING };
  }
}

module.exports = { PENDING_WARNING, reconcileAccountAfterCancellation };
