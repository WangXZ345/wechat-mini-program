import { describe, expect, it } from "vitest";
import {
  normalizeCreateProductInput,
  normalizeEditProductInput,
  parseProductDetail,
  parseProductMutationResult
} from "./product-write-contract";

const metadata = {
  name: "测试商品",
  baseName: "测试商品",
  imageUrl: "https://example.com/product.jpg",
  specification: "30ml",
  productionDate: "2026-07",
  description: "测试说明",
  productIndex: "P000001",
  skuCode: "SKU-001",
  keywords: ["测试", "精华"]
};
const initial = {
  salePriceCents: 6990,
  stock: 20,
  warningThreshold: 5,
  isActive: false,
  tags: ["新货"]
};

describe("product write contract", () => {
  it("normalizes the exact create and edit payloads", () => {
    expect(normalizeCreateProductInput({ metadata, initial, reason: " 新品建档 " })).toEqual({
      metadata,
      initial,
      reason: "新品建档"
    });
    expect(normalizeEditProductInput({ id: " p-1 ", expectedVersion: 3, metadata, reason: " 修正资料 " })).toEqual({
      id: "p-1",
      expectedVersion: 3,
      metadata,
      reason: "修正资料"
    });
  });

  it.each([
    { metadata: { ...metadata, price: 1 }, initial, reason: "" },
    { metadata, initial: { ...initial, internalTags: ["内部"] }, reason: "" },
    { id: "p-1", expectedVersion: 1, metadata: { ...metadata, stock: 2 }, reason: "" }
  ])("rejects extra or sensitive request fields", (payload) => {
    const normalize = "id" in payload ? normalizeEditProductInput : normalizeCreateProductInput;
    expect(() => normalize(payload)).toThrowError(/不允许的字段/);
  });

  it("requires productIndex for edit while allowing create to request server allocation", () => {
    expect(normalizeCreateProductInput({ metadata: { ...metadata, productIndex: "" }, initial, reason: "" }).metadata.productIndex).toBe("");
    expect(() => normalizeEditProductInput({ id: "p-1", expectedVersion: 1, metadata: { ...metadata, productIndex: "" }, reason: "" }))
      .toThrowError(/必须填写商品索引/);
  });

  it("strictly parses detail without accepting internal fields", () => {
    const detail = { id: "p-1", version: 3, metadata, initial, updatedAt: "2026-07-12T08:00:00.000Z" };
    expect(parseProductDetail(detail)).toEqual(detail);
    expect(() => parseProductDetail({ ...detail, internalTags: ["内部"] })).toThrowError(/不允许的字段/);
  });

  it("strictly parses the mutation summary and rejects malformed cents", () => {
    const result = {
      item: {
        id: "p-1",
        sku: "SKU-001",
        name: "测试商品",
        brand: "",
        salePriceCents: 6990,
        status: "draft",
        isActive: false,
        tags: ["新货"],
        updatedAt: "2026-07-12T08:00:00.000Z",
        version: 1
      },
      affected: 1,
      message: "商品已新增",
      requestId: "request-1"
    };
    expect(parseProductMutationResult(result)).toEqual(result);
    expect(() => parseProductMutationResult({ ...result, item: { ...result.item, salePriceCents: 69.9 } })).toThrowError(/非负整数/);
  });
});
