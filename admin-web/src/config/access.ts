import type { AdminProfile, AdminRole } from "@/types/auth";

export interface AccessRule {
  roles?: AdminRole[];
  permissionsAny?: string[];
  permissionsAll?: string[];
}

export const ROLE_PERMISSIONS: Record<AdminRole, string[]> = {
  customer_service: [
    "dashboard:view_basic",
    "order:view",
    "order:review",
    "order:reject",
    "order:edit_remark",
    "order:ship",
    "shipment:view",
    "shipment:merge",
    "shipment:update",
    "shipment:ship",
    "shipment:cancel",
    "shipment:complete",
    "shipment:view_address_masked",
    "after_sale:view",
    "after_sale:review",
    "after_sale:receive_return",
    "after_sale:update",
    "after_sale:complete",
    "customer:view_basic",
    "customer:view_phone_masked",
    "customer:view_address_masked"
  ],
  finance: [
    "dashboard:view_basic",
    "dashboard:view_sales",
    "dashboard:view_finance",
    "order:view",
    "shipment:view",
    "shipment:view_address_masked",
    "payment:view_screenshot",
    "payment:confirm",
    "payment:update_status",
    "payment:export",
    "after_sale:view",
    "refund:view",
    "refund:create",
    "refund:process",
    "refund:export",
    "refund:view_sensitive",
    "customer:view_basic",
    "customer:view_account",
    "customer:view_phone_masked",
    "customer:view_phone_full",
    "customer:view_address_masked",
    "customer:view_address_full"
  ],
  procurement: [
    "dashboard:view_basic",
    "dashboard:view_inventory",
    "dashboard:view_product",
    "product:view",
    "product:create",
    "product:update",
    "product:update_price",
    "product:update_status",
    "product:tag:view",
    "product:tag:update",
    "product:analytics:view",
    "home_recommend:view",
    "home_recommend:manage",
    "inventory:view",
    "inventory:update",
    "inventory:import",
    "inventory:view_log",
    "inventory:set_warning",
    "product:tag:batch_update"
  ],
  super_admin: ["*"]
};

export function profileHasPermission(profile: AdminProfile | null, permission?: string): boolean {
  if (!permission || !profile || !profile.isActive) return !permission;
  return profile.permissions.includes("*") || profile.permissions.includes(permission);
}

export function hasAccess(profile: AdminProfile | null, rule?: AccessRule): boolean {
  if (!profile || !profile.isActive) return false;
  if (!rule) return true;
  if (rule.roles?.length && !rule.roles.includes(profile.role)) return false;
  if (rule.permissionsAll?.some((permission) => !profileHasPermission(profile, permission))) return false;
  if (rule.permissionsAny?.length && !rule.permissionsAny.some((permission) => profileHasPermission(profile, permission))) {
    return false;
  }
  return true;
}
