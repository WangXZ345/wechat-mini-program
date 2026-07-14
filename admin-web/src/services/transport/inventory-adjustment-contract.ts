import { ApiError } from "@/services/http/api-error";
import type { MutationResult } from "@/types/api";

export const MAX_INVENTORY_STOCK = 9_999_999;

export type InventoryResource = "inventory" | "inventory-alerts";
export type InventoryStatus = "normal" | "low" | "out";

export interface InventoryAdjustmentInput {
  id: string;
  mode: "delta";
  delta: number;
  expectedStock: number;
  expectedVersion: number;
  reason: string;
}

export interface InventorySnapshot {
  id: string;
  stock: number;
  warningThreshold: number;
  status: InventoryStatus;
  isActive: boolean;
  version: number;
  updatedAt: string;
}

const INPUT_KEYS = ["id", "mode", "delta", "expectedStock", "expectedVersion", "reason"] as const;
const SNAPSHOT_KEYS = ["id", "stock", "warningThreshold", "status", "isActive", "version", "updatedAt"] as const;

function inputError(message: string, code = "INVALID_INVENTORY_ADJUSTMENT"): never {
  throw new ApiError(message, code, 400);
}

function contractError(message: string, code = "INVALID_INVENTORY_ADJUSTMENT_RESPONSE"): never {
  throw new ApiError(message, code, 502);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  source: "input" | "response"
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    if (source === "input") inputError("库存调整请求包含不允许的字段", "INVALID_REQUEST_BODY");
    contractError("库存调整响应包含不允许的字段");
  }
}

function strictString(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean,
  source: "input" | "response"
): string {
  const fail = (message: string): never => source === "input" ? inputError(message) : contractError(message);
  if (typeof value !== "string") return fail(`${field}格式无效`);
  const normalized = value.trim();
  if (required && !normalized) fail(`${field}不能为空`);
  if (normalized.length > maxLength) fail(`${field}长度超出限制`);
  return normalized;
}

function safeNonNegativeInteger(
  value: unknown,
  field: string,
  max: number,
  source: "input" | "response"
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    if (source === "input") inputError(`${field}必须是有效的非负整数`);
    contractError(`${field}必须是有效的非负整数`);
  }
  return value;
}

function adjustmentDelta(value: unknown): number {
  if (typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value === 0
    || Math.abs(value) > MAX_INVENTORY_STOCK) {
    inputError(`调整数量必须是 ${-MAX_INVENTORY_STOCK} 到 ${MAX_INVENTORY_STOCK} 之间的非零整数`, "INVENTORY_DELTA_INVALID");
  }
  return value;
}

export function normalizeInventoryAdjustmentInput(value: unknown): InventoryAdjustmentInput {
  if (!isRecord(value)) inputError("库存调整请求格式无效", "INVALID_REQUEST_BODY");
  assertExactKeys(value, INPUT_KEYS, "input");
  if (value.mode !== "delta") inputError("库存调整模式仅支持 delta", "INVENTORY_MODE_INVALID");
  const expectedStock = safeNonNegativeInteger(value.expectedStock, "当前库存", MAX_INVENTORY_STOCK, "input");
  const delta = adjustmentDelta(value.delta);
  if (expectedStock + delta < 0 || expectedStock + delta > MAX_INVENTORY_STOCK) {
    inputError(`调整后库存必须是 0 到 ${MAX_INVENTORY_STOCK} 之间的整数`, "INVENTORY_STOCK_OUT_OF_RANGE");
  }
  return {
    id: strictString(value.id, "商品 ID", 128, true, "input"),
    mode: "delta",
    delta,
    expectedStock,
    expectedVersion: safeNonNegativeInteger(value.expectedVersion, "数据版本", Number.MAX_SAFE_INTEGER, "input"),
    reason: strictString(value.reason, "调整原因", 120, true, "input")
  };
}

export function parseInventorySnapshot(value: unknown): InventorySnapshot {
  if (!isRecord(value)) contractError("库存快照响应无效");
  assertExactKeys(value, SNAPSHOT_KEYS, "response");
  if (!(["normal", "low", "out"] as unknown[]).includes(value.status)) {
    contractError("库存状态响应无效");
  }
  if (typeof value.isActive !== "boolean") contractError("商品销售状态响应无效");
  return {
    id: strictString(value.id, "商品 ID", 128, true, "response"),
    stock: safeNonNegativeInteger(value.stock, "库存", MAX_INVENTORY_STOCK, "response"),
    warningThreshold: safeNonNegativeInteger(value.warningThreshold, "预警值", 99_999, "response"),
    status: value.status as InventoryStatus,
    isActive: value.isActive,
    version: safeNonNegativeInteger(value.version, "数据版本", Number.MAX_SAFE_INTEGER, "response"),
    updatedAt: strictString(value.updatedAt, "更新时间", 80, false, "response")
  };
}

export function parseInventoryAdjustmentResult(value: unknown): MutationResult<InventorySnapshot> {
  if (!isRecord(value)) contractError("库存调整响应无效");
  assertExactKeys(value, ["item", "affected", "message", "requestId"], "response");
  const affected = safeNonNegativeInteger(value.affected, "影响记录数", 1, "response");
  if (!value.item) contractError("库存调整响应缺少最新库存快照");
  return {
    item: parseInventorySnapshot(value.item),
    affected,
    message: strictString(value.message, "结果说明", 240, true, "response"),
    requestId: value.requestId === undefined
      ? undefined
      : strictString(value.requestId, "请求 ID", 128, false, "response")
  };
}

export function inventorySnapshotFromResourceRow(value: unknown): InventorySnapshot {
  if (!isRecord(value)) contractError("库存详情响应无效");
  return parseInventorySnapshot({
    id: value.id,
    stock: value.stock,
    warningThreshold: value.warningThreshold,
    status: value.status,
    isActive: value.isActive,
    version: value.version,
    updatedAt: value.updatedAt
  });
}
