const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async () => {
  try {
    const res = await db.collection("settings").doc("payment_methods").get().catch(() => null);
    const methods = res && res.data && Array.isArray(res.data.methods)
      ? res.data.methods
      : ["微信转账", "支付宝", "银行转账"];
    const pickupRes = await db.collection("settings").doc("pickup_settings").get().catch(() => null);
    const pickup = pickupRes && pickupRes.data ? pickupRes.data : {};
    const systemRes = await db.collection("settings").doc("system_settings").get().catch(() => null);
    const system = systemRes && systemRes.data ? systemRes.data : {};
    return {
      ok: true,
      data: {
        paymentMethods: methods,
        systemSettings: {
          requirePhoneBeforeOrder: system.requirePhoneBeforeOrder !== false,
          requireVerifiedPhoneBeforeOrder: system.requireVerifiedPhoneBeforeOrder === true,
          allowManualPhoneBinding: system.allowManualPhoneBinding !== false,
          maxPhoneChangePerDay: Math.max(1, Number(system.maxPhoneChangePerDay || 3)),
          requireAddressBeforeDeliveryOrder: system.requireAddressBeforeDeliveryOrder !== false,
          maxAddressCountPerUser: Math.max(1, Number(system.maxAddressCountPerUser || 20)),
          allowPickupWithoutAddress: system.allowPickupWithoutAddress !== false,
          defaultShippingType: system.defaultShippingType === "pickup" ? "pickup" : "delivery",
          enableOfflineQrPayment: system.enableOfflineQrPayment !== false,
          enableBankTransfer: system.enableBankTransfer !== false,
          enableWechatPay: system.enableWechatPay === true,
          maxPaymentScreenshotCount: Math.max(1, Number(system.maxPaymentScreenshotCount || 3)),
          allowMultiplePaymentRecords: system.allowMultiplePaymentRecords !== false,
          requirePaymentProofForOfflinePayment: system.requirePaymentProofForOfflinePayment !== false,
          lowStockDefaultThreshold: Math.max(0, Number(system.lowStockDefaultThreshold || 50)),
          sessionIdleMinutes: Math.max(5, Math.min(240, Number(system.sessionIdleMinutes || 30))),
          version: Math.max(0, Number(system.version || system.dataVersion || 0)),
          enableAfterSale: system.enableAfterSale !== false,
          requireManualAfterSaleReview: system.requireManualAfterSaleReview !== false,
          requireDetailedAfterSaleReason: system.requireDetailedAfterSaleReason !== false,
          minAfterSaleReasonLength: Math.max(1, Number(system.minAfterSaleReasonLength || 5)),
          maxAfterSaleReasonLength: Math.max(20, Number(system.maxAfterSaleReasonLength || 300)),
          afterSaleDaysAfterShipment: Math.max(0, Number(system.afterSaleDaysAfterShipment || 15)),
          afterSaleDaysAfterCompleted: Math.max(0, Number(system.afterSaleDaysAfterCompleted || 7)),
          allowAfterSaleBeforeShipment: system.allowAfterSaleBeforeShipment !== false,
          allowRefundWithoutReturn: system.allowRefundWithoutReturn !== false,
          maxAfterSaleImages: Math.max(0, Number(system.maxAfterSaleImages || 6)),
          requireFinanceConfirmRefund: system.requireFinanceConfirmRefund !== false,
          allowRefundToBalance: system.allowRefundToBalance !== false,
          enableWechatPayRefund: system.enableWechatPayRefund === true,
          requireInspectionBeforeRestock: system.requireInspectionBeforeRestock !== false,
          enableMergeShipment: system.enableMergeShipment !== false,
          allowMergeDifferentAddress: system.allowMergeDifferentAddress === true,
          allowPartialPaidShipment: system.allowPartialPaidShipment === true,
          requirePaidBeforeShipment: system.requirePaidBeforeShipment !== false,
          maxOrdersPerMergeShipment: Math.max(1, Number(system.maxOrdersPerMergeShipment || 50)),
          maxItemsPerMergeShipment: Math.max(1, Number(system.maxItemsPerMergeShipment || 500)),
          defaultShippingCompany: system.defaultShippingCompany || "",
          allowCancelMergeShipmentBeforeShipped: system.allowCancelMergeShipmentBeforeShipped !== false,
          enableIdempotency: system.enableIdempotency !== false,
          requireIdempotencyForOrderSubmit: system.requireIdempotencyForOrderSubmit !== false,
          requireIdempotencyForPaymentConfirm: system.requireIdempotencyForPaymentConfirm !== false,
          requireIdempotencyForRefundConfirm: system.requireIdempotencyForRefundConfirm !== false,
          requireIdempotencyForInventoryChange: system.requireIdempotencyForInventoryChange !== false,
          idempotencyDefaultTTLSeconds: Math.max(60, Number(system.idempotencyDefaultTTLSeconds || 604800)),
          idempotencyPaymentTTLSeconds: Math.max(60, Number(system.idempotencyPaymentTTLSeconds || 2592000)),
          idempotencyRefundTTLSeconds: Math.max(60, Number(system.idempotencyRefundTTLSeconds || 7776000)),
          idempotencyProcessingTimeoutSeconds: Math.max(60, Number(system.idempotencyProcessingTimeoutSeconds || 1800))
        },
        pickupSettings: {
          pickupLocation: pickup.pickupLocation || "",
          pickupTimeNote: pickup.pickupTimeNote || "",
          pickupContact: pickup.pickupContact || "",
          pickupPhone: pickup.pickupPhone || "",
          pickupRemark: pickup.pickupRemark || "",
          isConfigured: Boolean(pickup.pickupLocation && pickup.pickupContact && pickup.pickupPhone)
        }
      }
    };
  } catch (err) {
    return { ok: false, message: err.message || "获取配置失败" };
  }
};
