const DEFAULT_MAX_ADDRESS_COUNT = 20;

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function maskPhone(phone) {
  const value = cleanText(phone, 30);
  if (value.length < 7) return value ? "***" : "";
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function maskAddress(detailAddress) {
  const value = cleanText(detailAddress, 200);
  if (!value) return "";
  if (value.length <= 4) return `${value.slice(0, 1)}**`;
  const visibleLength = Math.ceil(value.length / 2);
  return `${value.slice(0, visibleLength)}**`;
}

function normalizeRegion(payload = {}) {
  const region = Array.isArray(payload.region) ? payload.region : [];
  const province = cleanText(payload.province || region[0], 40);
  const city = cleanText(payload.city || region[1], 40);
  const district = cleanText(payload.district || region[2], 40);
  const regionText = cleanText(payload.regionText || [province, city, district].filter(Boolean).join(" "), 160);
  return { province, city, district, regionText };
}

function buildFullAddress(address = {}) {
  const regionText = cleanText(address.regionText || [
    address.province,
    address.city,
    address.district
  ].filter(Boolean).join(" "), 160);
  const detailAddress = cleanText(address.detailAddress, 200);
  return [regionText, detailAddress].filter(Boolean).join(" ");
}

function validateAddressPayload(payload = {}) {
  const region = normalizeRegion(payload);
  const address = {
    receiverName: cleanText(payload.receiverName, 50),
    receiverPhone: cleanText(payload.receiverPhone, 30),
    ...region,
    detailAddress: cleanText(payload.detailAddress, 200),
    addressTag: cleanText(payload.addressTag, 10),
    isDefault: Boolean(payload.isDefault)
  };

  if (!address.receiverName) throw new Error("请填写收货人");
  if (!address.receiverPhone) throw new Error("请填写手机号");
  if (!/^1\d{10}$/.test(address.receiverPhone)) throw new Error("请输入正确手机号");
  if (!address.regionText || !address.province || !address.city) throw new Error("请选择省市区");
  if (!address.detailAddress) throw new Error("请填写详细地址");
  if (address.detailAddress.length < 5) throw new Error("详细地址至少 5 个字");
  if (address.addressTag.length > 10) throw new Error("地址标签最多 10 个字");

  address.receiverPhoneMasked = maskPhone(address.receiverPhone);
  address.fullAddress = buildFullAddress(address);
  return address;
}

function canViewFullAddress(admin = {}) {
  if (!admin) return false;
  if (admin.role === "super_admin") return true;
  const permissions = Array.isArray(admin.permissions) ? admin.permissions : [];
  return permissions.includes("customer:view_address_full");
}

function canExportAddress(admin = {}) {
  if (!admin) return false;
  if (admin.role === "super_admin") return true;
  const permissions = Array.isArray(admin.permissions) ? admin.permissions : [];
  return permissions.includes("customer:export_address");
}

function addressSnapshot(address = {}) {
  return {
    receiverName: cleanText(address.receiverName, 50),
    receiverPhone: cleanText(address.receiverPhone, 30),
    receiverPhoneMasked: address.receiverPhoneMasked || maskPhone(address.receiverPhone),
    regionText: cleanText(address.regionText, 160),
    detailAddress: cleanText(address.detailAddress, 200),
    fullAddress: cleanText(address.fullAddress || buildFullAddress(address), 360),
    addressTag: cleanText(address.addressTag, 10)
  };
}

function maskedAddressSnapshot(address = {}) {
  const snapshot = addressSnapshot(address);
  return {
    receiverName: snapshot.receiverName,
    receiverPhoneMasked: snapshot.receiverPhoneMasked,
    regionText: snapshot.regionText,
    detailAddressMasked: maskAddress(snapshot.detailAddress),
    fullAddressMasked: buildFullAddress({
      regionText: snapshot.regionText,
      detailAddress: maskAddress(snapshot.detailAddress)
    }),
    addressTag: snapshot.addressTag
  };
}

function sanitizeAddressForRole(address = {}, admin = {}) {
  if (canViewFullAddress(admin)) return { ...address };
  const masked = maskedAddressSnapshot(address);
  return {
    ...address,
    receiverPhone: "",
    receiverPhoneMasked: masked.receiverPhoneMasked,
    detailAddress: masked.detailAddressMasked,
    detailAddressMasked: masked.detailAddressMasked,
    fullAddress: masked.fullAddressMasked,
    fullAddressMasked: masked.fullAddressMasked,
    shippingAddressMasked: masked
  };
}

function sanitizeOrderAddress(order = {}, admin = {}) {
  const full = order.shippingAddressSnapshot || order.shippingAddress || null;
  const masked = order.shippingAddressMasked || (full ? maskedAddressSnapshot(full) : null);
  const canViewFull = canViewFullAddress(admin);
  return {
    ...order,
    shippingAddressSnapshot: canViewFull ? full : null,
    shippingAddressMasked: masked,
    shippingAddress: canViewFull ? (full || order.shippingAddress || null) : masked
  };
}

module.exports = {
  DEFAULT_MAX_ADDRESS_COUNT,
  cleanText,
  maskPhone,
  maskAddress,
  buildFullAddress,
  validateAddressPayload,
  canViewFullAddress,
  canExportAddress,
  addressSnapshot,
  maskedAddressSnapshot,
  sanitizeAddressForRole,
  sanitizeOrderAddress
};
