function cleanText(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function hasPermission(admin, permission) {
  if (!admin || admin.status === "disabled" || admin.isActive === false) return false;
  if (admin.role === "super_admin") return true;
  return Array.isArray(admin.permissions) && admin.permissions.includes(permission);
}

function maskPhone(phone) {
  const digits = cleanText(phone, 40).replace(/\D/g, "");
  const value = digits.length > 11 ? digits.slice(-11) : digits;
  if (value.length < 7) return value ? "***" : "";
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function maskBankCard(cardNo) {
  const value = cleanText(cardNo, 80).replace(/\s/g, "");
  if (!value) return "";
  if (value.length <= 8) return `****${value.slice(-4)}`;
  return `${value.slice(0, 4)} **** **** ${value.slice(-4)}`;
}

function maskAccount(value) {
  const text = cleanText(value, 120);
  if (!text) return "";
  if (text.length <= 6) return `${text.slice(0, 1)}***${text.slice(-1)}`;
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function maskWechatAccount(account) {
  return maskAccount(account);
}

function maskAlipayAccount(account) {
  return maskAccount(account);
}

function maskAddressText(address) {
  const text = cleanText(address, 360);
  if (!text) return "";
  if (text.length <= 4) return `${text.slice(0, 1)}**`;
  return `${text.slice(0, Math.ceil(text.length / 2))}**`;
}

function maskAddress(address = {}) {
  const receiverPhone = address.receiverPhone || address.phone || "";
  const regionText = cleanText(address.regionText || [address.province, address.city, address.district].filter(Boolean).join(" "), 160);
  const detailAddress = cleanText(address.detailAddress || "", 200);
  const detailAddressMasked = address.detailAddressMasked || maskAddressText(detailAddress);
  return {
    receiverName: cleanText(address.receiverName, 50),
    receiverPhoneMasked: address.receiverPhoneMasked || maskPhone(receiverPhone),
    regionText,
    detailAddressMasked,
    fullAddressMasked: address.fullAddressMasked || [regionText, detailAddressMasked].filter(Boolean).join(" "),
    addressTag: cleanText(address.addressTag, 10)
  };
}

function canViewFullPhone(admin) {
  return hasPermission(admin, "customer:view_phone_full");
}

function canViewMaskedPhone(admin) {
  return canViewFullPhone(admin) || hasPermission(admin, "customer:view_phone_masked");
}

function canViewFullAddress(admin) {
  return hasPermission(admin, "customer:view_address_full") || hasPermission(admin, "shipment:view_address_full");
}

function canViewMaskedAddress(admin) {
  return canViewFullAddress(admin)
    || hasPermission(admin, "customer:view_address_masked")
    || hasPermission(admin, "shipment:view_address_masked");
}

function sanitizeCustomerForRole(customer = {}, admin = {}) {
  const phone = customer.phoneNumber || customer.phone || customer.customerPhoneSnapshot || "";
  const phoneMasked = customer.phoneMasked || customer.customerPhoneMasked || maskPhone(phone);
  const clean = {
    _id: customer._id || customer.id || "",
    userId: customer.userId || customer._id || "",
    nickname: cleanText(customer.nickname || customer.name || customer.customerName, 80),
    avatarUrl: customer.avatarUrl || "",
    phoneMasked: canViewMaskedPhone(admin) ? phoneMasked : "",
    phoneDisplay: canViewFullPhone(admin) ? phone : (canViewMaskedPhone(admin) ? phoneMasked : ""),
    phoneVerified: Boolean(customer.phoneVerified),
    phoneBindMethod: customer.phoneBindMethod || "",
    phoneBoundAt: customer.phoneBoundAt || null,
    createdAt: customer.createdAt || null,
    updatedAt: customer.updatedAt || null
  };
  if (canViewFullPhone(admin)) clean.phoneNumber = phone;
  return clean;
}

function sanitizeCustomerAccountForRole(account = {}, admin = {}) {
  const clean = {
    _id: account._id || account.id || "",
    userId: account.userId || "",
    nickname: cleanText(account.nickname || account.customerName || account.name, 80),
    phoneMasked: canViewMaskedPhone(admin) ? (account.phoneMasked || maskPhone(account.phoneNumber || account.phone || "")) : "",
    phoneDisplay: canViewFullPhone(admin)
      ? (account.phoneNumber || account.phone || account.phoneMasked || "")
      : (canViewMaskedPhone(admin) ? (account.phoneMasked || maskPhone(account.phoneNumber || account.phone || "")) : ""),
    orderCount: Number(account.orderCount || account.totalOrderCount || 0),
    lastOrderAt: account.lastOrderAt || null,
    todayOrderAmount: Number(account.todayOrderAmount || 0),
    pendingConfirmAmount: Number(account.pendingConfirmAmount || 0),
    abnormalCount: Number(account.abnormalCount || 0),
    isSettled: Boolean(account.isSettled),
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null
  };
  if (canViewFullPhone(admin)) clean.phoneNumber = account.phoneNumber || account.phone || "";
  if (hasPermission(admin, "customer:view_account")) {
    Object.assign(clean, {
      totalOrderAmount: Number(account.totalOrderAmount || account.totalReceivableAmount || 0),
      totalPaidAmount: Number(account.totalPaidAmount || account.paidAmount || 0),
      totalUnpaidAmount: Number(account.totalUnpaidAmount || account.unpaidAmount || 0),
      historyUnpaidAmount: Number(account.historyUnpaidAmount || 0),
      payableAmount: Number(account.payableAmount || 0),
      lastPaymentAt: account.lastPaymentAt || null
    });
  }
  if (hasPermission(admin, "customer:edit_remark")) {
    clean.adminRemark = account.adminRemark || "";
    clean.adminNote = account.adminNote || "";
    clean.adminTags = Array.isArray(account.adminTags) ? account.adminTags : [];
    clean.riskLevel = account.riskLevel || "normal";
  }
  return clean;
}

function sanitizeOrderForRole(order = {}, admin = {}) {
  const address = order.shippingAddressSnapshot || order.shippingAddress || null;
  const clean = {
    orderId: order._id || order.orderId || "",
    _id: order._id || order.orderId || "",
    orderNo: order.orderNo || "",
    status: order.status || "",
    paymentStatus: order.paymentStatus || "",
    deliveryStatus: order.deliveryStatus || "",
    shippingStatus: order.shippingStatus || "",
    deliveryType: order.deliveryType || "",
    shippingType: order.shippingType || "",
    totalAmount: Number(order.totalAmount || 0),
    paidAmount: Number(order.paidAmount || 0),
    unpaidAmount: Number(order.unpaidAmount || 0),
    itemSummary: order.itemSummary || order.productName || "",
    productName: order.productName || "",
    totalQuantity: Number(order.totalQuantity || order.quantity || 0),
    quantity: Number(order.quantity || 0),
    createdAt: order.createdAt || null,
    updatedAt: order.updatedAt || null
  };
  if (canViewMaskedAddress(admin) && address) clean.shippingAddressMasked = order.shippingAddressMasked || maskAddress(address);
  if (canViewFullAddress(admin) && address) clean.shippingAddress = address;
  if (canViewMaskedPhone(admin)) clean.customerPhoneMasked = order.customerPhoneMasked || maskPhone(order.customerPhoneSnapshot || "");
  if (hasPermission(admin, "order:view_sensitive")) {
    clean.paymentScreenshotUrls = order.paymentScreenshotUrls || [];
    clean.paymentScreenshotUrl = order.paymentScreenshotUrl || "";
    clean.adminRemark = order.adminRemark || order.orderAdminNote || "";
  }
  return clean;
}

function sanitizeRefundAccount(account = {}, admin = {}) {
  if (!account) return null;
  const canView = hasPermission(admin, "refund:view_sensitive");
  return {
    accountName: cleanText(account.accountName, 80),
    bankName: cleanText(account.bankName, 80),
    bankCardNoMasked: account.bankCardNoMasked || maskBankCard(account.bankCardNo),
    alipayAccountMasked: account.alipayAccountMasked || maskAlipayAccount(account.alipayAccount),
    wechatAccountMasked: account.wechatAccountMasked || maskWechatAccount(account.wechatAccount),
    bankCardNo: canView ? cleanText(account.bankCardNo, 80) : "",
    alipayAccount: canView ? cleanText(account.alipayAccount, 120) : "",
    wechatAccount: canView ? cleanText(account.wechatAccount, 120) : ""
  };
}

function sanitizeRefundForRole(refund = {}, admin = {}) {
  const canViewSensitive = hasPermission(admin, "refund:view_sensitive");
  const clean = {
    _id: refund._id || refund.id || "",
    refundRecordId: refund._id || refund.refundRecordId || "",
    refundNo: refund.refundNo || "",
    afterSaleId: refund.afterSaleId || "",
    afterSaleNo: refund.afterSaleNo || "",
    orderId: refund.orderId || "",
    orderNo: refund.orderNo || "",
    customerName: refund.customerName || "",
    refundMethod: refund.refundMethod || "",
    refundChannel: refund.refundChannel || "",
    refundAmount: Number(refund.refundAmount || 0),
    approvedRefundAmount: Number(refund.approvedRefundAmount || 0),
    refundStatus: refund.refundStatus || refund.status || "",
    status: refund.status || refund.refundStatus || "",
    createdAt: refund.createdAt || null,
    updatedAt: refund.updatedAt || null,
    processedAt: refund.processedAt || null,
    confirmedAt: refund.confirmedAt || null,
    financeRemark: hasPermission(admin, "refund:process") ? (refund.financeRemark || "") : ""
  };
  clean.offlineRefundAccount = sanitizeRefundAccount(refund.offlineRefundAccount || refund.refundAccountInfo || {}, admin);
  clean.refundAccountInfo = clean.offlineRefundAccount;
  if (canViewSensitive) {
    clean.refundProofImages = refund.refundProofImages || [];
    clean.paymentProofImages = refund.paymentProofImages || [];
    clean.wechatRefundId = refund.wechatRefundId || "";
    clean.wechatPayTransactionId = refund.wechatPayTransactionId || "";
  }
  return clean;
}

function sanitizeAfterSaleForRole(afterSale = {}, admin = {}) {
  const canViewSensitive = hasPermission(admin, "refund:view_sensitive") || hasPermission(admin, "order:view_sensitive");
  const clean = {
    ...afterSale,
    customerPhoneMasked: afterSale.customerPhoneMasked || maskPhone(afterSale.customerPhoneSnapshot || "")
  };
  delete clean.openid;
  delete clean.userOpenid;
  delete clean.customerPhoneSnapshot;
  clean.refundAccountInfo = sanitizeRefundAccount(afterSale.refundAccountInfo || {}, admin);
  if (!canViewSensitive) {
    delete clean.evidenceImages;
    delete clean.paymentScreenshotUrl;
    delete clean.paymentScreenshotUrls;
  }
  if (!hasPermission(admin, "customer:edit_remark")) {
    delete clean.adminInternalRemark;
    delete clean.riskLevel;
  }
  return clean;
}

function sanitizeLogsForRole(logs = [], admin = {}) {
  if (!hasPermission(admin, "operation_log:view") && admin.role !== "super_admin") return [];
  return (logs || []).map((log) => ({
    _id: log._id || "",
    action: log.action || "",
    orderId: log.orderId || "",
    orderNo: log.orderNo || "",
    afterSaleId: log.afterSaleId || "",
    afterSaleNo: log.afterSaleNo || "",
    refundRecordId: log.refundRecordId || "",
    refundNo: log.refundNo || "",
    operatorRole: log.operatorRole || "",
    operatorType: log.operatorType || "",
    remark: log.remark || "",
    beforeData: log.beforeData || null,
    afterData: log.afterData || null,
    createdAt: log.createdAt || null
  }));
}

module.exports = {
  cleanText,
  hasPermission,
  maskPhone,
  maskAddress,
  maskBankCard,
  maskWechatAccount,
  maskAlipayAccount,
  sanitizeCustomerForRole,
  sanitizeCustomerAccountForRole,
  sanitizeRefundForRole,
  sanitizeOrderForRole,
  sanitizeAfterSaleForRole,
  sanitizeLogsForRole
};
