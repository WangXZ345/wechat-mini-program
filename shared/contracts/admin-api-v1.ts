export const ADMIN_API_V1_RESOURCES = [
  "dashboard",
  "products",
  "inventory",
  "inventory-alerts",
  "orders",
  "payments",
  "accounts",
  "shipments",
  "after-sales",
  "refunds",
  "admins",
  "audit",
  "analytics",
  "imports"
] as const;

export type AdminApiV1Resource = (typeof ADMIN_API_V1_RESOURCES)[number];
export type AdminApiV1Action = "profile" | "list" | "get" | "sync" | "mutate";

export interface AdminApiV1Meta {
  requestId: string;
  serverTime: string;
  version?: number;
}

export interface AdminApiV1Error {
  code: string;
  message: string;
  requestId: string;
}

export interface AdminApiV1Envelope<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
  requestId: string;
  serverTime: string;
  meta: AdminApiV1Meta;
  error?: AdminApiV1Error;
}

export interface AdminApiV1ListQuery {
  page?: number;
  pageSize?: number;
  cursor?: string;
  search?: string;
  status?: string;
  sort?: "asc" | "desc";
}

export interface AdminApiV1ListResult<T extends Record<string, unknown>> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  nextCursor: string | null;
}

export interface AdminApiV1ActionRequest {
  action: AdminApiV1Action;
  resource?: AdminApiV1Resource;
  id?: string;
  query?: AdminApiV1ListQuery;
  authorization: `Bearer ${string}`;
  actionSecret?: string;
}

export const SERVICE_NOT_MIGRATED = "SERVICE_NOT_MIGRATED" as const;
