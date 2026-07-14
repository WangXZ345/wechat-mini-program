import { ApiError } from "@/services/http/api-error";
import type { MutationFailure, MutationResult } from "@/types/api";

export const PUBLIC_PRODUCT_TAGS = ["新货", "瑕疵", "热销"] as const;

export type PublicProductTag = (typeof PUBLIC_PRODUCT_TAGS)[number];

export interface ProductTagSnapshotRow extends Record<string, unknown> {
  id: string;
  version: number;
  tags: PublicProductTag[];
}

export interface ProductTagMutationItem {
  id: string;
  expectedVersion: number;
  expectedPresent: boolean;
}

export interface ProductTagMutationPayload extends Record<string, unknown> {
  scope: "public";
  tag: PublicProductTag;
  present: boolean;
  items: ProductTagMutationItem[];
  reason: string;
}

const PRODUCT_TAG_FAILURE_CODES = new Set([
  "PRODUCT_NOT_FOUND",
  "DATA_VERSION_CONFLICT",
  "DATA_VERSION_INVALID",
  "DATA_INTERNAL_TAGS_INVALID"
]);

export function isPublicProductTag(value: unknown): value is PublicProductTag {
  return typeof value === "string" && (PUBLIC_PRODUCT_TAGS as readonly string[]).includes(value);
}

export function normalizePublicProductTags(value: unknown): PublicProductTag[] | null {
  if (!Array.isArray(value)) return null;
  const tags: PublicProductTag[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isPublicProductTag(candidate) || seen.has(candidate)) return null;
    seen.add(candidate);
    tags.push(candidate);
  }
  return tags;
}

export function isProductTagSnapshotRow(value: Record<string, unknown>): value is ProductTagSnapshotRow {
  return typeof value.id === "string"
    && value.id.trim().length > 0
    && value.id.trim().length <= 128
    && typeof value.version === "number"
    && Number.isSafeInteger(value.version)
    && value.version >= 0
    && normalizePublicProductTags(value.tags) !== null;
}

export function buildProductTagMutationPayload(
  rows: ProductTagSnapshotRow[],
  tag: PublicProductTag,
  present: boolean,
  reason: string
): ProductTagMutationPayload {
  return {
    scope: "public",
    tag,
    present,
    items: rows.map((row) => ({
      id: row.id.trim(),
      expectedVersion: row.version,
      expectedPresent: row.tags.includes(tag)
    })),
    reason: reason.trim()
  };
}

export function parseProductTagMutationResult<T extends Record<string, unknown>>(
  value: MutationResult<T>,
  expectedIds: string[]
): MutationResult<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResult();
  const allowedFields = new Set([
    "affected",
    "changedCount",
    "unchangedCount",
    "failedCount",
    "failures",
    "message",
    "requestId"
  ]);
  if (Object.keys(value).some((key) => !allowedFields.has(key))) return invalidResult();
  const countFields = [value.affected, value.changedCount, value.unchangedCount, value.failedCount];
  if (countFields.some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
    return invalidResult();
  }
  if (value.affected !== value.changedCount
    || value.changedCount! + value.unchangedCount! + value.failedCount! !== expectedIds.length) {
    return invalidResult();
  }
  if (!Array.isArray(value.failures) || value.failures.length !== value.failedCount) return invalidResult();
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const failures: MutationFailure[] = value.failures.map((failure) => {
    if (!failure || typeof failure !== "object" || Array.isArray(failure)) throw invalidResultError();
    const rawFailure = failure as unknown as Record<string, unknown>;
    if (Object.keys(rawFailure).some((key) => !["id", "code"].includes(key))) throw invalidResultError();
    const id = typeof rawFailure.id === "string" ? rawFailure.id.trim() : "";
    const code = typeof rawFailure.code === "string" ? rawFailure.code.trim() : "";
    if (!id || id.length > 128 || !expected.has(id) || seen.has(id) || !PRODUCT_TAG_FAILURE_CODES.has(code)) {
      throw invalidResultError();
    }
    seen.add(id);
    return { id, code };
  });
  if (typeof value.message !== "string" || !value.message.trim() || value.message.trim().length > 240) {
    return invalidResult();
  }
  if (typeof value.requestId !== "string" || !value.requestId.trim() || value.requestId.trim().length > 128) {
    return invalidResult();
  }
  return {
    affected: value.affected,
    changedCount: value.changedCount,
    unchangedCount: value.unchangedCount,
    failedCount: value.failedCount,
    failures,
    message: value.message.trim(),
    requestId: value.requestId.trim()
  };
}

function invalidResult<T extends Record<string, unknown>>(): MutationResult<T> {
  throw invalidResultError();
}

function invalidResultError(): ApiError {
  return new ApiError("批量标签结果无效，请刷新后重试", "INVALID_SERVICE_RESPONSE", 502);
}
