const ROLE_SYNC_PERMISSIONS = Object.freeze({
  customer_service: ["order:view", "shipment:view", "after_sale:view"],
  finance: ["order:view", "payment:view_screenshot", "shipment:view", "after_sale:view", "refund:view", "customer:view_account"],
  procurement: ["product:view", "inventory:view"],
  super_admin: ["*"]
});

function activeAdmin(row) {
  return Boolean(row
    && row.isActive !== false
    && row.status !== "disabled"
    && ROLE_SYNC_PERMISSIONS[row.role]);
}

function boundedRolePermissions(role, configured) {
  const allowed = ROLE_SYNC_PERMISSIONS[role] || [];
  if (role === "super_admin") return ["*"];
  if (!Array.isArray(configured) || !configured.length) return allowed.slice();
  const configuredSet = new Set(configured);
  return allowed.filter((permission) => configuredSet.has(permission));
}

module.exports = { ROLE_SYNC_PERMISSIONS, activeAdmin, boundedRolePermissions };
