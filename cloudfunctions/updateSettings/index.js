const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("无管理员权限");
  return { openid, adminId: res.data[0]._id };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String(err && err.message || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist/i.test(message)) {
      const notSupported = /createCollection is not a function/i.test(message);
      if (notSupported) return;
      throw err;
    }
  }
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizePickupSettings(input = {}) {
  const data = {
    pickupLocation: cleanText(input.pickupLocation, 200),
    pickupTimeNote: cleanText(input.pickupTimeNote, 200),
    pickupContact: cleanText(input.pickupContact, 50),
    pickupPhone: cleanText(input.pickupPhone, 30),
    pickupRemark: cleanText(input.pickupRemark, 300)
  };
  if (!data.pickupLocation) throw new Error("请填写自提地址");
  if (!data.pickupContact) throw new Error("请填写联系人");
  if (!data.pickupPhone) throw new Error("请填写联系电话");
  return data;
}

function normalizeSystemSettings(input = {}) {
  const data = {};
  [
    "enableOfflineQrPayment",
    "enableBankTransfer",
    "enableWechatPay",
    "allowMultiplePaymentRecords",
    "requirePaymentProofForOfflinePayment",
    "enableAfterSale",
    "requireManualAfterSaleReview",
    "requireDetailedAfterSaleReason",
    "allowAfterSaleBeforeShipment",
    "allowRefundWithoutReturn",
    "requireFinanceConfirmRefund",
    "allowRefundToBalance",
    "enableWechatPayRefund",
    "requireInspectionBeforeRestock",
    "enableMergeShipment",
    "allowMergeDifferentAddress",
    "allowPartialPaidShipment",
    "requirePaidBeforeShipment",
    "allowCancelMergeShipmentBeforeShipped",
    "enableIdempotency",
    "requireIdempotencyForOrderSubmit",
    "requireIdempotencyForPaymentConfirm",
    "requireIdempotencyForRefundConfirm",
    "requireIdempotencyForInventoryChange"
  ].forEach((key) => {
    if (input[key] !== undefined) data[key] = input[key] === true;
  });
  if (input.maxPaymentScreenshotCount !== undefined && input.maxPaymentScreenshotCount !== "") {
    const count = Number(input.maxPaymentScreenshotCount);
    if (!Number.isFinite(count) || count < 1 || count > 9) throw new Error("付款截图数量上限需为 1-9");
    data.maxPaymentScreenshotCount = Math.round(count);
  }
  if (input.minAfterSaleReasonLength !== undefined && input.minAfterSaleReasonLength !== "") {
    const count = Number(input.minAfterSaleReasonLength);
    if (!Number.isFinite(count) || count < 1 || count > 100) throw new Error("售后原因最小长度需为 1-100");
    data.minAfterSaleReasonLength = Math.round(count);
  }
  if (input.maxAfterSaleReasonLength !== undefined && input.maxAfterSaleReasonLength !== "") {
    const count = Number(input.maxAfterSaleReasonLength);
    if (!Number.isFinite(count) || count < 20 || count > 1000) throw new Error("售后原因最大长度需为 20-1000");
    data.maxAfterSaleReasonLength = Math.round(count);
  }
  if (input.afterSaleDaysAfterShipment !== undefined && input.afterSaleDaysAfterShipment !== "") {
    const count = Number(input.afterSaleDaysAfterShipment);
    if (!Number.isFinite(count) || count < 0 || count > 365) throw new Error("发货后售后期限需为 0-365 天");
    data.afterSaleDaysAfterShipment = Math.round(count);
  }
  if (input.afterSaleDaysAfterCompleted !== undefined && input.afterSaleDaysAfterCompleted !== "") {
    const count = Number(input.afterSaleDaysAfterCompleted);
    if (!Number.isFinite(count) || count < 0 || count > 365) throw new Error("完成后售后期限需为 0-365 天");
    data.afterSaleDaysAfterCompleted = Math.round(count);
  }
  if (input.maxAfterSaleImages !== undefined && input.maxAfterSaleImages !== "") {
    const count = Number(input.maxAfterSaleImages);
    if (!Number.isFinite(count) || count < 0 || count > 9) throw new Error("售后图片数量上限需为 0-9");
    data.maxAfterSaleImages = Math.round(count);
  }
  if (input.maxOrdersPerMergeShipment !== undefined && input.maxOrdersPerMergeShipment !== "") {
    const count = Number(input.maxOrdersPerMergeShipment);
    if (!Number.isFinite(count) || count < 1 || count > 100) throw new Error("单次合并订单数上限需为 1-100");
    data.maxOrdersPerMergeShipment = Math.round(count);
  }
  if (input.maxItemsPerMergeShipment !== undefined && input.maxItemsPerMergeShipment !== "") {
    const count = Number(input.maxItemsPerMergeShipment);
    if (!Number.isFinite(count) || count < 1 || count > 5000) throw new Error("单次合并商品件数上限需为 1-5000");
    data.maxItemsPerMergeShipment = Math.round(count);
  }
  if (input.defaultShippingCompany !== undefined) {
    data.defaultShippingCompany = cleanText(input.defaultShippingCompany, 80);
  }
  [
    ["idempotencyDefaultTTLSeconds", 60, 365 * 86400],
    ["idempotencyPaymentTTLSeconds", 60, 365 * 86400],
    ["idempotencyRefundTTLSeconds", 60, 365 * 86400],
    ["idempotencyProcessingTimeoutSeconds", 60, 86400]
  ].forEach(([key, min, max]) => {
    if (input[key] === undefined || input[key] === "") return;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 配置无效`);
    data[key] = Math.round(value);
  });
  return data;
}

exports.main = async (event) => {
  try {
    const permissionAdmin = await requirePermission("system:settings");
    const admin = { openid: permissionAdmin.openid, adminId: permissionAdmin._id || permissionAdmin.id };
    const methods = Array.isArray(event.paymentMethods)
      ? event.paymentMethods.map((item) => String(item).trim()).filter(Boolean)
      : [];
    if (!methods.length) return { ok: false, message: "请至少保留一个付款方式" };

    await db.collection("settings").doc("payment_methods").set({
      data: {
        methods,
        updatedAt: db.serverDate()
      }
    });

    const result = { paymentMethods: methods };
    if (event.pickupSettings) {
      const pickupSettings = normalizePickupSettings(event.pickupSettings);
      await db.collection("settings").doc("pickup_settings").set({
        data: {
          ...pickupSettings,
          updatedAt: db.serverDate(),
          updatedBy: admin.adminId,
          updatedByOpenid: admin.openid
        }
      });
      result.pickupSettings = pickupSettings;
    }

    if (event.systemSettings) {
      const systemSettings = normalizeSystemSettings(event.systemSettings);
      await db.collection("settings").doc("system_settings").set({
        data: {
          ...systemSettings,
          updatedAt: db.serverDate(),
          updatedBy: admin.adminId,
          updatedByOpenid: admin.openid
        }
      });
      result.systemSettings = systemSettings;
    }

    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, message: err.message || "保存配置失败" };
  }
};

