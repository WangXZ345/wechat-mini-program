export const BATCH_ITEM_STATUSES = [
  "success",
  "skipped",
  "validation",
  "not_allowed",
  "conflict",
  "permission",
  "business_error"
] as const;

export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number];
export type BatchOverallStatus = "success" | "partial" | "failed";

export interface BatchItemResult {
  id: string;
  key: string;
  version: number;
  status: BatchItemStatus;
  code: string;
  message: string;
  retryable: boolean;
  reused: boolean;
}

export interface BatchCounts {
  total: number;
  success: number;
  skipped: number;
  validation: number;
  not_allowed: number;
  conflict: number;
  permission: number;
  business_error: number;
  failed: number;
  retryable: number;
}

export interface BatchResult {
  requestId: string;
  batchId: string;
  overallStatus: BatchOverallStatus;
  counts: BatchCounts;
  items: BatchItemResult[];
}

export interface OriginalBatchItem<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  key: string;
  version: number;
  payload: TPayload;
}

export interface BatchResultExpectation {
  requestId: string;
  batchId: string;
  items: ReadonlyArray<Pick<OriginalBatchItem, "id" | "key" | "version">>;
}

export interface BatchFailureDisplay {
  id: string;
  key: string;
  status: Exclude<BatchItemStatus, "success">;
  code: string;
  reason: string;
  retryable: boolean;
}

export interface BatchResultSummary {
  tone: "success" | "warning" | "danger";
  title: string;
  detail: string;
  counts: BatchCounts;
  failures: BatchFailureDisplay[];
}

const FAILURE_LABELS: Record<Exclude<BatchItemStatus, "success">, string> = {
  skipped: "已跳过",
  validation: "校验失败",
  not_allowed: "当前状态不允许",
  conflict: "数据冲突",
  permission: "权限不足",
  business_error: "业务处理失败"
};

const RETRYABLE_CODES: Partial<Record<BatchItemStatus, ReadonlySet<string>>> = {
  skipped: new Set(["BATCH_DEADLINE_EXCEEDED"]),
  conflict: new Set(["DATA_VERSION_CONFLICT", "VERSION_MISMATCH", "OPTIMISTIC_LOCK_CONFLICT"]),
  business_error: new Set([
    "DEPENDENCY_BUSY",
    "UPSTREAM_UNAVAILABLE",
    "SERVICE_UNAVAILABLE",
    "RATE_LIMITED",
    "NETWORK_ERROR"
  ])
};

function isRetryableOutcome(item: BatchItemResult): boolean {
  return item.retryable === true && RETRYABLE_CODES[item.status]?.has(item.code) === true;
}

function emptyCounts(total: number): BatchCounts {
  return {
    total,
    success: 0,
    skipped: 0,
    validation: 0,
    not_allowed: 0,
    conflict: 0,
    permission: 0,
    business_error: 0,
    failed: 0,
    retryable: 0
  };
}

function countsFromItems(items: BatchItemResult[]): BatchCounts {
  const counts = emptyCounts(items.length);
  for (const item of items) {
    counts[item.status] += 1;
    if (item.status !== "success" && item.status !== "skipped") counts.failed += 1;
    if (isRetryableOutcome(item)) counts.retryable += 1;
  }
  return counts;
}

function invalidBatchResult(): never {
  throw new Error("批量响应无效");
}

function isSafeIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isValidItemCode(status: BatchItemStatus, code: unknown): code is string {
  if (typeof code !== "string" || !code || code.length > 100) return false;
  const allowed: Record<BatchItemStatus, ReadonlySet<string>> = {
    success: new Set(["OK"]),
    skipped: new Set(["UNCHANGED", "NO_CHANGE", "BATCH_DEADLINE_EXCEEDED"]),
    validation: new Set(["INVALID_ROW", "VALIDATION_ERROR", "INVALID_ARGUMENT"]),
    not_allowed: new Set(["STATE_BLOCKED", "INVALID_STATE", "NOT_ALLOWED"]),
    conflict: new Set(["DATA_VERSION_CONFLICT", "VERSION_MISMATCH", "OPTIMISTIC_LOCK_CONFLICT", "BATCH_ITEM_FINGERPRINT_CONFLICT"]),
    permission: new Set(["FORBIDDEN", "PERMISSION_DENIED"]),
    business_error: new Set(["DEPENDENCY_BUSY", "UPSTREAM_UNAVAILABLE", "SERVICE_UNAVAILABLE", "RATE_LIMITED", "NETWORK_ERROR", "BATCH_ITEM_TIMEOUT", "BATCH_DEADLINE_EXCEEDED", "BATCH_ITEM_FAILED"])
  };
  return allowed[status].has(code);
}

export function parseBatchResult(value: unknown, expected?: BatchResultExpectation): BatchResult {
  if (!isPlainRecord(value) || !exactKeys(value, ["requestId", "batchId", "overallStatus", "counts", "items"])
    || !isSafeIdentity(value.requestId) || !isSafeIdentity(value.batchId)
    || !["success", "partial", "failed"].includes(String(value.overallStatus))
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 50
    || !isPlainRecord(value.counts)
    || !exactKeys(value.counts, ["total", "success", "skipped", "validation", "not_allowed", "conflict", "permission", "business_error", "failed", "retryable"])) {
    return invalidBatchResult();
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const items: BatchItemResult[] = value.items.map((raw) => {
    const version = isPlainRecord(raw) ? raw.version : undefined;
    if (!isPlainRecord(raw) || !exactKeys(raw, ["id", "key", "version", "status", "code", "message", "retryable", "reused"])
      || !isSafeIdentity(raw.id) || !isSafeIdentity(raw.key) || !Number.isSafeInteger(version)
      || !BATCH_ITEM_STATUSES.includes(raw.status as BatchItemStatus) || !isValidItemCode(raw.status as BatchItemStatus, raw.code)
      || typeof raw.message !== "string" || raw.message.length > 240 || typeof raw.retryable !== "boolean" || typeof raw.reused !== "boolean") {
      return invalidBatchResult();
    }
    const safeVersion = version as number;
    if (safeVersion < 0) return invalidBatchResult();
    const item: BatchItemResult = {
      id: raw.id,
      key: raw.key,
      version: safeVersion,
      status: raw.status as BatchItemStatus,
      code: raw.code,
      message: raw.message,
      retryable: raw.retryable,
      reused: raw.reused
    };
    if (ids.has(item.id) || keys.has(item.key) || item.retryable !== isRetryableOutcome(item)) return invalidBatchResult();
    ids.add(item.id);
    keys.add(item.key);
    return { ...item };
  });
  const counts = countsFromItems(items);
  const suppliedCounts = value.counts as Record<string, unknown>;
  if (!Object.entries(counts).every(([key, expected]) => suppliedCounts[key] === expected)) return invalidBatchResult();
  const overallStatus: BatchOverallStatus = counts.success === counts.total
    ? "success"
    : counts.success === 0 && counts.skipped === 0 ? "failed" : "partial";
  if (value.overallStatus !== overallStatus) return invalidBatchResult();
  if (expected && (
    value.requestId !== expected.requestId
    || value.batchId !== expected.batchId
    || items.length !== expected.items.length
    || items.some((item, index) => {
      const original = expected.items[index];
      return !original || item.id !== original.id || item.key !== original.key || item.version !== original.version;
    })
  )) return invalidBatchResult();
  return { requestId: value.requestId, batchId: value.batchId, overallStatus, counts, items };
}

export function batchFailureReason(item: BatchItemResult): string {
  if (item.status === "success") return "处理成功";
  const label = FAILURE_LABELS[item.status];
  const message = item.message.trim();
  return message ? `${label}：${message}` : label;
}

export function summarizeBatchResult(result: BatchResult): BatchResultSummary {
  const counts = countsFromItems(result.items);
  const failures = result.items
    .filter((item): item is BatchItemResult & { status: Exclude<BatchItemStatus, "success"> } => item.status !== "success")
    .map((item) => ({
      id: item.id,
      key: item.key,
      status: item.status,
      code: item.code,
      reason: batchFailureReason(item),
      retryable: isRetryableOutcome(item)
    }));

  if (counts.total === 0) {
    return { tone: "danger", title: "批量结果无效", detail: "未收到逐项处理结果", counts, failures };
  }

  if (counts.success === counts.total) {
    return {
      tone: "success",
      title: "全部处理成功",
      detail: `成功 ${counts.success} 项，无失败项`,
      counts,
      failures
    };
  }

  const detail = `成功 ${counts.success} 项，跳过 ${counts.skipped} 项，失败 ${counts.failed} 项；可重试 ${counts.retryable} 项`;
  if (counts.success === 0 && counts.failed > 0) {
    return { tone: "danger", title: "本批次未处理成功", detail, counts, failures };
  }
  return { tone: "warning", title: "部分项目未处理成功", detail, counts, failures };
}

export function selectRetryableBatchItems<TPayload extends Record<string, unknown>>(
  originals: OriginalBatchItem<TPayload>[],
  result: BatchResult
): OriginalBatchItem<TPayload>[] {
  const resultsByIdentity = new Map(result.items.map((item) => [`${item.id}\u0000${item.key}`, item]));
  return originals.filter((original) => {
    const outcome = resultsByIdentity.get(`${original.id}\u0000${original.key}`);
    return outcome !== undefined && outcome.version === original.version && isRetryableOutcome(outcome);
  });
}
