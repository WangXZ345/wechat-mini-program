import { describe, expect, it } from "vitest";
import {
  inventorySnapshotFromResourceRow,
  normalizeInventoryAdjustmentInput,
  parseInventoryAdjustmentResult,
  parseInventorySnapshot
} from "./inventory-adjustment-contract";

const input = {
  id: "product-1",
  mode: "delta",
  delta: -3,
  expectedStock: 10,
  expectedVersion: 4,
  reason: "盘点修正"
} as const;

const snapshot = {
  id: "product-1",
  stock: 7,
  warningThreshold: 5,
  status: "normal",
  isActive: true,
  version: 5,
  updatedAt: "2026-07-12T08:00:00.000Z"
} as const;

describe("inventory adjustment contract", () => {
  it("normalizes the exact delta-only request", () => {
    expect(normalizeInventoryAdjustmentInput({ ...input, id: " product-1 ", reason: " 盘点修正 " })).toEqual(input);
  });

  it.each([
    { ...input, mode: "set" },
    { ...input, delta: 0 },
    { ...input, delta: 1.5 },
    { ...input, expectedStock: -1 },
    { ...input, expectedVersion: -1 },
    { ...input, reason: " " },
    { ...input, stock: 7 },
    { ...input, delta: -11 }
  ])("rejects ambiguous, invalid, extra, or out-of-range input", (value) => {
    expect(() => normalizeInventoryAdjustmentInput(value)).toThrow();
  });

  it("strictly parses the response snapshot and mutation envelope", () => {
    expect(parseInventorySnapshot(snapshot)).toEqual(snapshot);
    expect(parseInventoryAdjustmentResult({ item: snapshot, affected: 1, message: "库存已调整", requestId: "request-1" }))
      .toEqual({ item: snapshot, affected: 1, message: "库存已调整", requestId: "request-1" });
  });

  it("rejects malformed or extra response fields", () => {
    expect(() => parseInventorySnapshot({ ...snapshot, internalTags: ["内部"] })).toThrowError(/不允许的字段/);
    expect(() => parseInventoryAdjustmentResult({ item: { ...snapshot, stock: "7" }, affected: 1, message: "库存已调整" }))
      .toThrowError(/非负整数/);
  });

  it("extracts only the inventory snapshot from a resource detail row", () => {
    expect(inventorySnapshotFromResourceRow({ ...snapshot, sku: "SKU-1", name: "测试商品" })).toEqual(snapshot);
  });
});
