import { describe, expect, it } from "vitest";
import {
  batchFailureReason,
  parseBatchResult,
  selectRetryableBatchItems,
  summarizeBatchResult,
  type BatchItemResult,
  type BatchResult,
  type OriginalBatchItem
} from "./batch-result-model";

function result(items: BatchItemResult[], counts: Partial<BatchResult["counts"]> = {}): BatchResult {
  return {
    requestId: "request-001",
    batchId: "batch-001",
    overallStatus: "partial",
    counts: {
      total: items.length,
      success: 0,
      skipped: 0,
      validation: 0,
      not_allowed: 0,
      conflict: 0,
      permission: 0,
      business_error: 0,
      failed: 0,
      retryable: 0,
      ...counts
    },
    items
  };
}

function item(
  id: string,
  status: BatchItemResult["status"],
  overrides: Partial<BatchItemResult> = {}
): BatchItemResult {
  return {
    id,
    key: `key-${id}`,
    version: 1,
    status,
    code: status === "success" ? "OK" : "FAILED",
    message: status === "success" ? "处理成功" : "处理失败",
    retryable: false,
    reused: false,
    ...overrides
  };
}

it("summarizes all-success results without relying on supplied aggregate counts", () => {
  const summary = summarizeBatchResult(result([
    item("one", "success"),
    item("two", "success", { reused: true })
  ], { failed: 99 }));

  expect(summary).toMatchObject({
    tone: "success",
    title: "全部处理成功",
    detail: "成功 2 项，无失败项",
    counts: { total: 2, success: 2, failed: 0, retryable: 0 }
  });
  expect(summary.failures).toEqual([]);
});

it("summarizes mixed results with exact failure counts and reasons", () => {
  const summary = summarizeBatchResult(result([
    item("one", "success"),
    item("two", "skipped", { code: "UNCHANGED", message: "无需处理" }),
    item("three", "validation", { code: "INVALID_ROW", message: "缺少规格" }),
    item("four", "conflict", { code: "DATA_VERSION_CONFLICT", message: "数据已更新", retryable: true }),
    item("five", "permission", { code: "FORBIDDEN", message: "无权处理" }),
    item("six", "business_error", { code: "DEPENDENCY_BUSY", message: "服务繁忙", retryable: true })
  ]));

  expect(summary.tone).toBe("warning");
  expect(summary.title).toBe("部分项目未处理成功");
  expect(summary.detail).toBe("成功 1 项，跳过 1 项，失败 4 项；可重试 2 项");
  expect(summary.counts).toEqual({
    total: 6,
    success: 1,
    skipped: 1,
    validation: 1,
    not_allowed: 0,
    conflict: 1,
    permission: 1,
    business_error: 1,
    failed: 4,
    retryable: 2
  });
  expect(summary.failures.map((entry) => entry.reason)).toEqual([
    "已跳过：无需处理",
    "校验失败：缺少规格",
    "数据冲突：数据已更新",
    "权限不足：无权处理",
    "业务处理失败：服务繁忙"
  ]);
});

it("uses a danger summary for all-failed results and never says all succeeded", () => {
  const summary = summarizeBatchResult(result([
    item("one", "not_allowed", { message: "状态不允许" }),
    item("two", "permission", { message: "无权处理" })
  ]));

  expect(summary.tone).toBe("danger");
  expect(summary.title).toBe("本批次未处理成功");
  expect(summary.detail).toBe("成功 0 项，跳过 0 项，失败 2 项；可重试 0 项");
  expect(summary.title.includes("全部处理成功")).toBe(false);
});

it("selects only original items with explicit retryable failed or skipped results", () => {
  const originals: OriginalBatchItem[] = [
    { id: "one", key: "key-one", version: 1, payload: { name: "成功原项" } },
    { id: "two", key: "key-two", version: 2, payload: { name: "可重试失败原项" } },
    { id: "three", key: "key-three", version: 3, payload: { name: "不可重试失败原项" } },
    { id: "four", key: "key-four", version: 4, payload: { name: "可重试跳过原项" } }
  ];
  const retry = selectRetryableBatchItems(originals, result([
    item("one", "success", { key: "key-one" }),
    item("two", "conflict", { key: "key-two", version: 2, code: "DATA_VERSION_CONFLICT", retryable: true }),
    item("three", "validation", { key: "key-three", retryable: false }),
    item("four", "skipped", { key: "key-four", version: 4, code: "BATCH_DEADLINE_EXCEEDED", retryable: true })
  ]));

  expect(retry).toEqual([originals[1], originals[3]]);
  expect(retry[0]).toBe(originals[1]);
  expect(retry[1]).toBe(originals[3]);
});

it("does not retry a mismatched, absent, or successful result even if retryable is malformed", () => {
  const originals: OriginalBatchItem[] = [
    { id: "one", key: "key-one", version: 1, payload: {} },
    { id: "two", key: "key-two", version: 1, payload: {} },
    { id: "three", key: "key-three", version: 1, payload: {} }
  ];
  const retry = selectRetryableBatchItems(originals, result([
    item("wrong-id", "conflict", { key: "key-one", retryable: true }),
    item("two", "success", { key: "key-two", retryable: true })
  ]));

  expect(retry).toEqual([]);
});

it("fails an empty batch result closed instead of reporting all success", () => {
  const summary = summarizeBatchResult(result([]));

  expect(summary).toEqual({
    tone: "danger",
    title: "批量结果无效",
    detail: "未收到逐项处理结果",
    counts: {
      total: 0,
      success: 0,
      skipped: 0,
      validation: 0,
      not_allowed: 0,
      conflict: 0,
      permission: 0,
      business_error: 0,
      failed: 0,
      retryable: 0
    },
    failures: []
  });
});

it("fails retry closed for unsafe statuses, codes, and stale versions", () => {
  const originals: OriginalBatchItem[] = [
    { id: "validation", key: "key-validation", version: 1, payload: {} },
    { id: "permission", key: "key-permission", version: 1, payload: {} },
    { id: "state", key: "key-state", version: 1, payload: {} },
    { id: "stale", key: "key-stale", version: 1, payload: {} },
    { id: "skip", key: "key-skip", version: 1, payload: {} },
    { id: "unknown", key: "key-unknown", version: 1, payload: {} }
  ];
  const retry = selectRetryableBatchItems(originals, result([
    item("validation", "validation", { key: "key-validation", retryable: true }),
    item("permission", "permission", { key: "key-permission", retryable: true }),
    item("state", "not_allowed", { key: "key-state", retryable: true }),
    item("stale", "conflict", { key: "key-stale", version: 2, code: "DATA_VERSION_CONFLICT", retryable: true }),
    item("skip", "skipped", { key: "key-skip", code: "UNCHANGED", retryable: true }),
    item("unknown", "business_error", { key: "key-unknown", code: "BATCH_ITEM_FAILED", retryable: true })
  ]));

  expect(retry).toEqual([]);
});

it("parses a complete all-success wire result only when aggregates match its items", () => {
  const parsed = parseBatchResult({
    requestId: "request-001",
    batchId: "batch-001",
    overallStatus: "success",
    counts: { total: 2, success: 2, skipped: 0, validation: 0, not_allowed: 0, conflict: 0, permission: 0, business_error: 0, failed: 0, retryable: 0 },
    items: [item("one", "success"), item("two", "success", { key: "key-two", version: 2 })]
  });

  expect(parsed.overallStatus).toBe("success");
  expect(parsed.counts).toEqual({ total: 2, success: 2, skipped: 0, validation: 0, not_allowed: 0, conflict: 0, permission: 0, business_error: 0, failed: 0, retryable: 0 });
});

it.each([
  ["request id", { requestId: "unexpected-request" }],
  ["batch id", { batchId: "unexpected-batch" }],
  ["item id", { items: [item("unexpected-item", "success", { key: "expected-item", version: 3 })] }],
  ["item key", { items: [item("expected-item", "success", { key: "unexpected-key", version: 3 })] }],
  ["item version", { items: [item("expected-item", "success", { key: "expected-item", version: 4 })] }]
] as const)("fails closed when a structurally valid response has a mismatched %s", (_label, override) => {
  const expected = {
    requestId: "expected-request",
    batchId: "expected-batch",
    items: [{ id: "expected-item", key: "expected-item", version: 3 }]
  };
  const response = {
    requestId: expected.requestId,
    batchId: expected.batchId,
    overallStatus: "success" as const,
    counts: { total: 1, success: 1, skipped: 0, validation: 0, not_allowed: 0, conflict: 0, permission: 0, business_error: 0, failed: 0, retryable: 0 },
    items: [item("expected-item", "success", { key: "expected-item", version: 3 })],
    ...override
  };

  expect(() => parseBatchResult(response, expected)).toThrow("批量响应无效");
});

it.each([
  ["malformed aggregate", { ...result([item("one", "success")]), overallStatus: "success", counts: { ...result([item("one", "success")]).counts, success: 0 } }],
  ["unsafe retry flag", { ...result([item("one", "validation", { code: "INVALID_ARGUMENT", retryable: true })]), counts: { total: 1, success: 0, skipped: 0, validation: 1, not_allowed: 0, conflict: 0, permission: 0, business_error: 0, failed: 1, retryable: 1 } }],
  ["duplicate identity", { ...result([item("one", "success"), item("one", "success", { key: "key-one" })]), overallStatus: "success", counts: { total: 2, success: 2, skipped: 0, validation: 0, not_allowed: 0, conflict: 0, permission: 0, business_error: 0, failed: 0, retryable: 0 } }]
] as const)("fails closed for %s", (_label, value) => {
  expect(() => parseBatchResult(value)).toThrow("批量响应无效");
});

it.each([
  ["duplicate id with a different key", [item("one", "success", { key: "key-one" }), item("one", "success", { key: "key-two" })]],
  ["duplicate key with a different id", [item("one", "success", { key: "key-shared" }), item("two", "success", { key: "key-shared" })]]
] as const)("fails closed for %s", (_label, items) => {
  expect(() => parseBatchResult({
    requestId: "request-duplicate",
    batchId: "batch-duplicate",
    overallStatus: "success",
    counts: { total: 2, success: 2, skipped: 0, validation: 0, not_allowed: 0, conflict: 0, permission: 0, business_error: 0, failed: 0, retryable: 0 },
    items
  })).toThrow("批量响应无效");
});

it("retries only an unstarted deadline skip, never a started timeout or deadline failure", () => {
  const originals: OriginalBatchItem[] = [
    { id: "timeout", key: "key-timeout", version: 1, payload: {} },
    { id: "started-deadline", key: "key-started-deadline", version: 1, payload: {} },
    { id: "unstarted-deadline", key: "key-unstarted-deadline", version: 1, payload: {} }
  ];
  const retry = selectRetryableBatchItems(originals, result([
    item("timeout", "business_error", { key: "key-timeout", code: "BATCH_ITEM_TIMEOUT", retryable: true }),
    item("started-deadline", "business_error", { key: "key-started-deadline", code: "BATCH_DEADLINE_EXCEEDED", retryable: true }),
    item("unstarted-deadline", "skipped", { key: "key-unstarted-deadline", code: "BATCH_DEADLINE_EXCEEDED", retryable: true })
  ]));

  expect(retry).toEqual([originals[2]]);
});

it("fails skipped timeout, generic, and legacy retry responses closed", () => {
  const originals: OriginalBatchItem[] = [
    { id: "deadline", key: "key-deadline", version: 1, payload: {} },
    { id: "timeout", key: "key-timeout", version: 1, payload: {} },
    { id: "generic", key: "key-generic", version: 1, payload: {} },
    { id: "legacy", key: "key-legacy", version: 1, payload: {} }
  ];
  const retry = selectRetryableBatchItems(originals, result([
    item("deadline", "skipped", { key: "key-deadline", code: "BATCH_DEADLINE_EXCEEDED", retryable: true }),
    item("timeout", "skipped", { key: "key-timeout", code: "BATCH_ITEM_TIMEOUT", retryable: true }),
    item("generic", "skipped", { key: "key-generic", code: "SKIPPED", retryable: true }),
    item("legacy", "skipped", { key: "key-legacy", code: "LEGACY_RETRY", retryable: true })
  ]));

  expect(retry).toEqual([originals[0]]);
});

describe("batchFailureReason", () => {
  it.each([
    ["skipped", "已跳过"],
    ["validation", "校验失败"],
    ["not_allowed", "当前状态不允许"],
    ["conflict", "数据冲突"],
    ["permission", "权限不足"],
    ["business_error", "业务处理失败"]
  ] as const)("labels %s failures", (status, label) => {
    expect(batchFailureReason(item("one", status, { message: "具体原因" }))).toBe(`${label}：具体原因`);
  });
});
