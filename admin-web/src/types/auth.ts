export const ADMIN_ROLES = ["customer_service", "finance", "procurement", "super_admin"] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminProfile {
  id: string;
  username: string;
  displayName: string;
  role: AdminRole;
  roleName: string;
  permissions: string[];
  isActive: boolean;
  sessionExpiresAt?: string;
}

export interface LoginInput {
  account: string;
  password: string;
}

export const ROLE_LABELS: Record<AdminRole, string> = {
  customer_service: "客服",
  finance: "财务",
  procurement: "采购",
  super_admin: "超级管理员"
};

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && ADMIN_ROLES.includes(value as AdminRole);
}
