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
export type AdminApiV1ErrorCategory =
  | "INVALID_ARGUMENT" | "UNAUTHENTICATED" | "FORBIDDEN" | "CSRF" | "RATE_LIMITED"
  | "NOT_FOUND" | "INVALID_STATE" | "DATA_VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT"
  | "FILE_PARSE_ERROR" | "VALIDATION_ERROR" | "INSUFFICIENT_STOCK" | "AMOUNT_LIMIT"
  | "PARTIAL_SUCCESS" | "INTERNAL_ERROR";

export interface AdminApiV1Meta {
  requestId: string;
  serverTime: string;
  version?: number;
}

export interface AdminApiV1Error {
  code: string;
  category: AdminApiV1ErrorCategory;
  message: string;
  requestId: string;
  retryAfterSeconds?: number;
}

export interface AdminApiV1Envelope<T> {
  ok: boolean;
  data?: T;
  code?: string;
  category?: AdminApiV1ErrorCategory;
  message?: string;
  retryAfterSeconds?: number;
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

export type AdminImportType = "quotes" | "inventory";
export type AdminImportMutation = "preview" | "confirm" | "resume";
export type AdminImportMapping = Record<string, string>;

export interface AdminImportFilePayload {
  name: string;
  mimeType: string;
  size: number;
  contentBase64: string;
}

export interface AdminImportPreviewRequest {
  type: AdminImportType;
  file: AdminImportFilePayload;
  mapping: AdminImportMapping;
}

export interface AdminImportConfirmRequest extends AdminImportPreviewRequest {
  previewRecordId: string;
  expectedFileHash: string;
  expectedParseHash: string;
}

export type AdminImportFileType = "xlsx" | "csv" | "txt";

export interface AdminImportPreviewCounts {
  total: number;
  valid: number;
  failed: number;
  ready: number;
  validation: number;
  truncated: boolean;
}

export interface AdminImportPreviewRow {
  row: number;
  values: Record<string, string | number | boolean>;
  status: "ready" | "validation";
  code: string;
  message: string;
  sku?: string;
  name?: string;
  before?: number;
  after?: number;
  version?: number;
}

export interface AdminImportMappingError {
  field: string;
  code: "IMPORT_MAPPING_REQUIRED";
  message: string;
}

export interface AdminImportMappingRequired {
  status: "mapping_required";
  headers: string[];
  suggestedMapping: AdminImportMapping;
  requiredFields: string[];
  mappingErrors: AdminImportMappingError[];
  fileHash: string;
  parseContext: {
    hash: string;
    fileType: AdminImportFileType;
    sheetName: string;
    headerRow: number;
    rowCount: number;
  };
}

export interface AdminImportReadyPreview {
  importRecordId: string;
  status: "previewed" | "validation_failed";
  fileHash: string;
  parseHash: string;
  fileType: AdminImportFileType;
  headers: string[];
  mapping: AdminImportMapping;
  rows: AdminImportPreviewRow[];
  counts: AdminImportPreviewCounts;
  previewTruncated: boolean;
  duplicate?: boolean;
}

export type AdminImportPreviewResponse = AdminImportMappingRequired | AdminImportReadyPreview;

export interface AdminImportExecutionCounts {
  total: number;
  success: number;
  failed: number;
  skipped?: number;
  retryable?: number;
  pending?: number;
}

export interface AdminImportRowResult {
  id: string;
  key: string;
  version: number;
  status: "success" | "skipped" | "validation" | "not_allowed" | "conflict" | "permission" | "business_error";
  code: string;
  message: string;
  retryable: boolean;
  reused: boolean;
}

export interface AdminImportBatchSummary {
  importRecordId: string;
  status: "previewed" | "validation_failed" | "success" | "partial" | "failed";
  counts: AdminImportPreviewCounts | AdminImportExecutionCounts;
  duplicate?: boolean;
  items?: AdminImportRowResult[];
  itemsTruncated?: boolean;
}

export interface AdminImportDetail {
  importRecordId: string;
  type: AdminImportType;
  fileName: string;
  fileType: AdminImportFileType;
  fileSize: number;
  status: "previewed" | "validation_failed" | "processing" | "success" | "partial" | "failed";
  counts: Partial<AdminImportPreviewCounts & AdminImportExecutionCounts>;
  errorSummary: Array<{ code: string; count: number }>;
  executionCursor: number;
  executionAttempt: number;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
}

export interface AdminImportReceiptItem {
  id: string;
  row: number;
  status: AdminImportRowResult["status"];
  code: string;
  retryable: boolean;
  reused: boolean;
  updatedAt: string | null;
}

export interface AdminImportReceiptPage {
  items: AdminImportReceiptItem[];
  total: number;
  page: number;
  pageSize: number;
  nextCursor: string | null;
}

export interface AdminImportReceiptQuery {
  page: number;
  pageSize: number;
  cursor?: string;
}
