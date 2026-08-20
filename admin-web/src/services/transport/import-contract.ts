import { ApiError } from "@/services/http/api-error";
import type { MutationResult } from "@/types/api";

export type ImportMode = "quotes" | "inventory";
export type ImportMapping = Record<string, string>;

export interface ImportFilePayload {
  name: string;
  mimeType: string;
  size: number;
  contentBase64: string;
}

export interface ImportPreviewRow {
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

export interface ImportPreviewCounts {
  total: number;
  valid: number;
  failed: number;
  ready: number;
  validation: number;
  truncated: boolean;
}

export interface ImportReadyPreviewData extends Record<string, unknown> {
  importRecordId: string;
  status: "previewed" | "validation_failed";
  fileHash: string;
  parseHash: string;
  fileType: string;
  headers: string[];
  mapping: ImportMapping;
  rows: ImportPreviewRow[];
  counts: ImportPreviewCounts;
  previewTruncated: boolean;
  duplicate?: boolean;
}

export interface ImportMappingError {
  field: string;
  code: "IMPORT_MAPPING_REQUIRED";
  message: string;
}

export interface ImportMappingRequiredData extends Record<string, unknown> {
  status: "mapping_required";
  headers: string[];
  suggestedMapping: ImportMapping;
  requiredFields: string[];
  mappingErrors: ImportMappingError[];
  fileHash: string;
  parseContext: {
    hash: string;
    fileType: "xlsx" | "csv" | "txt";
    sheetName: string;
    headerRow: number;
    rowCount: number;
  };
}

export type ImportPreviewData = ImportReadyPreviewData | ImportMappingRequiredData;

export interface ImportExecutionData extends Record<string, unknown> {
  importRecordId: string;
  status: "success" | "partial" | "failed";
  counts: { total: number; success: number; failed: number };
  duplicate?: boolean;
}

export type ImportReceiptStatus = "success" | "skipped" | "validation" | "not_allowed" | "conflict" | "permission" | "business_error";

export interface ImportReceiptItem {
  id: string;
  row: number;
  status: ImportReceiptStatus;
  code: string;
  retryable: boolean;
  reused: boolean;
  updatedAt: string | null;
}

export interface ImportReceiptQuery {
  page: number;
  pageSize: number;
  cursor?: string;
}

export interface ImportReceiptPage {
  items: ImportReceiptItem[];
  total: number;
  page: number;
  pageSize: number;
  nextCursor: string | null;
}

function fail(message: string): never {
  throw new ApiError(message, "INVALID_IMPORT_CONTRACT", 502);
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeCounts(value: unknown, fields: string[]): boolean {
  return record(value) && fields.every((field) => Number.isSafeInteger(value[field]) && Number(value[field]) >= 0);
}

function safePreviewRows(value: unknown): value is ImportPreviewRow[] {
  if (!Array.isArray(value) || value.length > 200) return false;
  const allowed = new Set(["row", "values", "status", "code", "message", "sku", "name", "before", "after", "version"]);
  return value.every((row) => record(row)
    && Object.keys(row).every((key) => allowed.has(key))
    && Number.isSafeInteger(row.row) && Number(row.row) >= 1
    && record(row.values) && Object.values(row.values).every((cell) => typeof cell === "string"
      || typeof cell === "boolean" || typeof cell === "number" && Number.isFinite(cell))
    && ["ready", "validation"].includes(String(row.status))
    && typeof row.code === "string" && Boolean(row.code)
    && typeof row.message === "string"
    && (row.sku === undefined || typeof row.sku === "string")
    && (row.name === undefined || typeof row.name === "string")
    && (row.before === undefined || Number.isSafeInteger(row.before))
    && (row.after === undefined || Number.isSafeInteger(row.after))
    && (row.version === undefined || Number.isSafeInteger(row.version) && Number(row.version) >= 0));
}

export function parseImportPreviewResult(result: MutationResult<ImportPreviewData>): ImportPreviewData {
  const item = result.item;
  if (!record(item)) return fail("导入预览响应无效");
  if (item.status === "mapping_required") {
    const context = item.parseContext;
    if (!safeHash(item.fileHash)
      || !Array.isArray(item.headers) || item.headers.some((header) => typeof header !== "string" || !header)
      || !record(item.suggestedMapping) || Object.values(item.suggestedMapping).some((header) => typeof header !== "string")
      || !Array.isArray(item.requiredFields) || item.requiredFields.some((field) => typeof field !== "string" || !field)
      || !Array.isArray(item.mappingErrors) || item.mappingErrors.some((error) => !record(error)
        || typeof error.field !== "string" || error.code !== "IMPORT_MAPPING_REQUIRED" || typeof error.message !== "string")
      || !record(context) || !safeHash(context.hash) || !["xlsx", "csv", "txt"].includes(String(context.fileType))
      || typeof context.sheetName !== "string" || !Number.isSafeInteger(context.headerRow) || Number(context.headerRow) < 1
      || !Number.isSafeInteger(context.rowCount) || Number(context.rowCount) < 1) {
      return fail("导入预览响应无效");
    }
    return item as ImportMappingRequiredData;
  }
  if (typeof item.importRecordId !== "string" || !item.importRecordId
    || !["previewed", "validation_failed"].includes(String(item.status))
    || !safeHash(item.fileHash) || !safeHash(item.parseHash)
    || !Array.isArray(item.headers) || item.headers.some((header) => typeof header !== "string")
    || !record(item.mapping) || Object.values(item.mapping).some((header) => typeof header !== "string")
    || !safePreviewRows(item.rows)
    || !safeCounts(item.counts, ["total", "valid", "failed", "ready", "validation"])
    || typeof item.counts.truncated !== "boolean"
    || item.counts.total !== item.counts.valid + item.counts.failed
    || item.counts.ready !== item.counts.valid || item.counts.validation !== item.counts.failed
    || item.previewTruncated !== item.counts.truncated
    || (item.counts.truncated ? item.counts.total <= item.rows.length : item.counts.total !== item.rows.length)) {
    return fail("导入预览响应无效");
  }
  return item as ImportReadyPreviewData;
}

export function parseImportExecutionResult(result: MutationResult<ImportExecutionData>): ImportExecutionData {
  const item = result.item;
  if (!record(item) || typeof item.importRecordId !== "string" || !item.importRecordId
    || !["success", "partial", "failed"].includes(String(item.status))
    || !safeCounts(item.counts, ["total", "success", "failed"])) {
    return fail("导入执行响应无效");
  }
  return item as ImportExecutionData;
}

export function parseImportReceiptPage(value: unknown, expected?: ImportReceiptQuery): ImportReceiptPage {
  const statuses = new Set<ImportReceiptStatus>(["success", "skipped", "validation", "not_allowed", "conflict", "permission", "business_error"]);
  const allowedPageFields = new Set(["items", "total", "page", "pageSize", "nextCursor"]);
  const allowedItemFields = new Set(["id", "row", "status", "code", "retryable", "reused", "updatedAt"]);
  if (!record(value) || Object.keys(value).some((key) => !allowedPageFields.has(key))
    || !Array.isArray(value.items) || value.items.length > 100
    || !Number.isSafeInteger(value.total) || Number(value.total) < value.items.length
    || !Number.isSafeInteger(value.page) || Number(value.page) < 1
    || !Number.isSafeInteger(value.pageSize) || Number(value.pageSize) < 1 || Number(value.pageSize) > 100
    || expected && (value.page !== expected.page || value.pageSize !== expected.pageSize
      || value.page > 1 && (typeof expected.cursor !== "string" || !/^v1\.[A-Za-z0-9_-]{16,4096}$/.test(expected.cursor))
      || value.page === 1 && expected.cursor !== undefined)
    || !(value.nextCursor === null || typeof value.nextCursor === "string" && /^v1\.[A-Za-z0-9_-]{16,4096}$/.test(value.nextCursor))) {
    return fail("导入明细响应无效");
  }
  const hasMore = Number(value.page) * Number(value.pageSize) < Number(value.total);
  if (hasMore !== (typeof value.nextCursor === "string")) return fail("导入明细响应无效");
  for (const item of value.items) {
    if (!record(item) || Object.keys(item).some((key) => !allowedItemFields.has(key))
      || typeof item.id !== "string" || !/^row-[1-9][0-9]*$/.test(item.id)
      || !Number.isSafeInteger(item.row) || item.id !== `row-${item.row}`
      || !statuses.has(item.status as ImportReceiptStatus)
      || typeof item.code !== "string" || !item.code || item.code.length > 100
      || typeof item.retryable !== "boolean" || typeof item.reused !== "boolean"
      || !(item.updatedAt === null || typeof item.updatedAt === "string" && !Number.isNaN(Date.parse(item.updatedAt)))) {
      return fail("导入明细响应无效");
    }
  }
  return value as unknown as ImportReceiptPage;
}

export function fileToImportPayload(file: File): Promise<ImportFilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ApiError("无法读取文件", "IMPORT_FILE_READ_FAILED", 400));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const separator = value.indexOf(",");
      const contentBase64 = separator >= 0 ? value.slice(separator + 1) : "";
      if (!contentBase64) {
        reject(new ApiError("无法读取文件", "IMPORT_FILE_READ_FAILED", 400));
        return;
      }
      resolve({ name: file.name, mimeType: file.type, size: file.size, contentBase64 });
    };
    reader.readAsDataURL(file);
  });
}
