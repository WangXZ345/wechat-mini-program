const PHONE_FULL_PERMISSION = "customer:view_phone_full";
const PHONE_MASKED_PERMISSION = "customer:view_phone_masked";
const PHONE_SEARCH_PERMISSION = "customer:search_by_phone";

function normalizePhone(phone) {
  const value = String(phone || "")
    .trim()
    .replace(/[\s-]/g, "")
    .replace(/^(\+?86|0086)/, "");
  if (!/^1[3-9]\d{9}$/.test(value)) {
    throw new Error("手机号格式错误");
  }
  return value;
}

function validatePhone(phone) {
  try {
    normalizePhone(phone);
    return true;
  } catch (err) {
    return false;
  }
}

function maskPhone(phone) {
  const value = String(phone || "").replace(/\D/g, "");
  const normalized = value.length > 11 ? value.slice(-11) : value;
  if (!/^1[3-9]\d{9}$/.test(normalized)) return "";
  return `${normalized.slice(0, 3)}****${normalized.slice(7)}`;
}

function hasPermission(admin, permission) {
  if (!admin || admin.status === "disabled" || admin.isActive === false) return false;
  if (admin.role === "super_admin") return true;
  return Array.isArray(admin.permissions) && admin.permissions.includes(permission);
}

function canViewFullPhone(admin) {
  return hasPermission(admin, PHONE_FULL_PERMISSION);
}

function canViewMaskedPhone(admin) {
  return canViewFullPhone(admin) || hasPermission(admin, PHONE_MASKED_PERMISSION);
}

function canSearchByPhone(admin) {
  return canViewFullPhone(admin) && hasPermission(admin, PHONE_SEARCH_PERMISSION);
}

function sanitizeUserForRole(user = {}, admin = null) {
  const phoneMasked = user.phoneMasked || maskPhone(user.phoneNumber || user.phone || "");
  const clean = {
    ...user,
    phoneMasked,
    phoneVerified: Boolean(user.phoneVerified),
    phoneBindMethod: user.phoneBindMethod || "",
    phoneBoundAt: user.phoneBoundAt || null,
    phoneUpdatedAt: user.phoneUpdatedAt || null,
    phoneChangeCount: Number(user.phoneChangeCount || 0)
  };
  if (canViewFullPhone(admin)) {
    clean.phoneNumber = user.phoneNumber || user.phone || "";
  } else {
    delete clean.phoneNumber;
    delete clean.phone;
  }
  return clean;
}

function publicPhoneProfile(user = {}) {
  return {
    phoneMasked: user.phoneMasked || maskPhone(user.phoneNumber || user.phone || ""),
    phoneVerified: Boolean(user.phoneVerified),
    phoneBindMethod: user.phoneBindMethod || "",
    phoneBoundAt: user.phoneBoundAt || null,
    phoneUpdatedAt: user.phoneUpdatedAt || null
  };
}

module.exports = {
  PHONE_FULL_PERMISSION,
  PHONE_MASKED_PERMISSION,
  PHONE_SEARCH_PERMISSION,
  normalizePhone,
  validatePhone,
  maskPhone,
  canViewFullPhone,
  canViewMaskedPhone,
  canSearchByPhone,
  sanitizeUserForRole,
  publicPhoneProfile
};
