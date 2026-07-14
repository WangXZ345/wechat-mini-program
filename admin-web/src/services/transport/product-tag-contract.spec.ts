import { describe, expect, it } from "vitest";
import {
  buildProductTagMutationPayload,
  isProductTagSnapshotRow,
  normalizePublicProductTags,
  parseProductTagMutationResult
} from "./product-tag-contract";

describe("product tag transport contract", () => {
  it("builds explicit public-tag snapshots from canonical rows", () => {
    const payload = buildProductTagMutationPayload([
      { id: "p-1", version: 0, tags: [], name: "A" },
      { id: "p-2", version: 7, tags: ["热销"], name: "B" }
    ], "热销", false, "  季度复核  ");

    expect(payload).toEqual({
      scope: "public",
      tag: "热销",
      present: false,
      items: [
        { id: "p-1", expectedVersion: 0, expectedPresent: false },
        { id: "p-2", expectedVersion: 7, expectedPresent: true }
      ],
      reason: "季度复核"
    });
  });

  it("accepts only canonical public tag arrays and complete row snapshots", () => {
    expect(normalizePublicProductTags(["新货", "热销"])).toEqual(["新货", "热销"]);
    expect(normalizePublicProductTags(["推荐"])).toBeNull();
    expect(normalizePublicProductTags(["热销", "热销"])).toBeNull();
    expect(normalizePublicProductTags("热销")).toBeNull();
    expect(isProductTagSnapshotRow({ id: "p-1", version: 0, tags: [] })).toBe(true);
    expect(isProductTagSnapshotRow({ id: "p-1", version: -1, tags: [] })).toBe(false);
    expect(isProductTagSnapshotRow({ id: "p-1", version: 1, tags: "热销" })).toBe(false);
  });

  it("normalizes a safe, internally consistent partial result", () => {
    const result = parseProductTagMutationResult({
      affected: 1,
      changedCount: 1,
      unchangedCount: 1,
      failedCount: 1,
      failures: [{ id: "p-3", code: "DATA_VERSION_CONFLICT" }],
      message: "已更新 1 个商品，1 个未处理",
      requestId: "request-1"
    }, ["p-1", "p-2", "p-3"]);

    expect(result).toEqual({
      affected: 1,
      changedCount: 1,
      unchangedCount: 1,
      failedCount: 1,
      failures: [{ id: "p-3", code: "DATA_VERSION_CONFLICT" }],
      message: "已更新 1 个商品，1 个未处理",
      requestId: "request-1"
    });
  });

  it.each([
    "PRODUCT_NOT_FOUND",
    "DATA_VERSION_CONFLICT",
    "DATA_VERSION_INVALID",
    "DATA_INTERNAL_TAGS_INVALID"
  ])("accepts the stable product-tag failure code %s", (code) => {
    expect(parseProductTagMutationResult({
      affected: 0,
      changedCount: 0,
      unchangedCount: 0,
      failedCount: 1,
      failures: [{ id: "p-1", code }],
      message: "未处理",
      requestId: "request-stable-code"
    }, ["p-1"]).failures).toEqual([{ id: "p-1", code }]);
  });

  it.each([
    [{ affected: 0, changedCount: 0, unchangedCount: 1, failedCount: 0, failures: [], message: "ok" }],
    [{ affected: 1, changedCount: 0, unchangedCount: 0, failedCount: 0, failures: [], message: "ok", requestId: "request-bad" }],
    [{ affected: 0, changedCount: 0, unchangedCount: 0, failedCount: 1, failures: [], message: "ok", requestId: "request-bad" }],
    [{ affected: 0, changedCount: 0, unchangedCount: 1, failedCount: 0, failures: [], message: "ok", requestId: "request-bad", item: { tags: ["热销"] } }],
    [{ affected: 0, changedCount: 0, unchangedCount: 0, failedCount: 1, failures: [{ id: "p-1", code: "CONFLICT" }], message: "ok", requestId: "request-bad" }],
    [{ affected: 0, changedCount: 0, unchangedCount: 0, failedCount: 1, failures: [{ id: "p-1", code: "DATA_VERSION_CONFLICT", detail: "internal" }], message: "ok", requestId: "request-bad" }]
  ])("rejects malformed or overexposed mutation results", (result) => {
    expect(() => parseProductTagMutationResult(result, ["p-1"])).toThrowError(expect.objectContaining({
      code: "INVALID_SERVICE_RESPONSE"
    }));
  });
});
