import { ApiError } from "@/services/http/api-error";
import type { MutationResult } from "@/types/api";
import { PUBLIC_PRODUCT_TAGS, isPublicProductTag, type PublicProductTag } from "./product-tag-contract";

export interface ProductMetadataInput {
  name: string;
  baseName: string;
  imageUrl: string;
  specification: string;
  productionDate: string;
  description: string;
  productIndex: string;
  skuCode: string;
  keywords: string[];
}

export interface ProductInitialInput {
  salePriceCents: number;
  stock: number;
  warningThreshold: number;
  isActive: boolean;
  tags: PublicProductTag[];
}

export interface ProductDetail {
  id: string;
  version: number;
  metadata: ProductMetadataInput;
  initial: ProductInitialInput;
  updatedAt: string;
}

export interface CreateProductInput {
  metadata: ProductMetadataInput;
  initial: ProductInitialInput;
  reason: string;
}

export interface EditProductInput {
  id: string;
  expectedVersion: number;
  metadata: ProductMetadataInput;
  reason: string;
}

export interface ProductSummary {
  id: string;
  sku: string;
  name: string;
  brand: string;
  salePriceCents: number;
  status: "active" | "inactive" | "draft";
  isActive: boolean;
  tags: PublicProductTag[];
  updatedAt: string;
  version: number;
}

const METADATA_KEYS = [
  "name",
  "baseName",
  "imageUrl",
  "specification",
  "productionDate",
  "description",
  "productIndex",
  "skuCode",
  "keywords"
] as const;
const INITIAL_KEYS = ["salePriceCents", "stock", "warningThreshold", "isActive", "tags"] as const;

function contractError(message: string, code = "INVALID_PRODUCT_CONTRACT"): never {
  throw new ApiError(message, code, 502);
}

function inputError(message: string, code = "INVALID_PRODUCT_INPUT"): never {
  throw new ApiError(message, code, 400);
}

function failContract(source: "input" | "response", message: string, code?: string): never {
  if (source === "input") return inputError(message, code);
  return contractError(message, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], source: "input" | "response"): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    failContract(source, "商品数据包含不允许的字段");
  }
}

function strictString(value: unknown, field: string, max: number, required: boolean, source: "input" | "response"): string {
  if (typeof value !== "string") failContract(source, `${field} 格式无效`);
  const normalized = value.trim();
  if (required && !normalized) failContract(source, `${field}不能为空`);
  if (normalized.length > max) failContract(source, `${field}长度超出限制`);
  return normalized;
}

function safeInteger(value: unknown, field: string, max: number, source: "input" | "response"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    failContract(source, `${field}必须是有效的非负整数`);
  }
  return value;
}

function parseKeywords(value: unknown, source: "input" | "response"): string[] {
  if (!Array.isArray(value) || value.length > 20) {
    failContract(source, "关键词格式无效");
  }
  const result = value.map((item) => strictString(item, "关键词", 40, true, source));
  if (new Set(result).size !== result.length) {
    failContract(source, "关键词不能重复");
  }
  return result;
}

function parseTags(value: unknown, source: "input" | "response"): PublicProductTag[] {
  if (!Array.isArray(value) || value.length > PUBLIC_PRODUCT_TAGS.length || value.some((tag) => !isPublicProductTag(tag))) {
    failContract(source, "公开标签格式无效");
  }
  const tags = PUBLIC_PRODUCT_TAGS.filter((tag) => value.includes(tag));
  if (tags.length !== value.length) failContract(source, "公开标签不能重复");
  return tags;
}

function parseMetadata(value: unknown, source: "input" | "response"): ProductMetadataInput {
  if (!isRecord(value)) failContract(source, "商品资料格式无效");
  assertExactKeys(value, METADATA_KEYS, source);
  return {
    name: strictString(value.name, "商品名称", 160, true, source),
    baseName: strictString(value.baseName, "基础名称", 160, false, source),
    imageUrl: strictString(value.imageUrl, "图片地址", 500, false, source),
    specification: strictString(value.specification, "规格", 120, false, source),
    productionDate: strictString(value.productionDate, "生产日期", 40, false, source),
    description: strictString(value.description, "商品说明", 1000, false, source),
    productIndex: strictString(value.productIndex, "商品索引", 80, false, source),
    skuCode: strictString(value.skuCode, "SKU", 80, false, source),
    keywords: parseKeywords(value.keywords, source)
  };
}

function parseInitial(value: unknown, source: "input" | "response"): ProductInitialInput {
  if (!isRecord(value)) failContract(source, "商品初始业务字段格式无效");
  assertExactKeys(value, INITIAL_KEYS, source);
  if (typeof value.isActive !== "boolean") failContract(source, "销售状态格式无效");
  return {
    salePriceCents: safeInteger(value.salePriceCents, "销售价", Number.MAX_SAFE_INTEGER, source),
    stock: safeInteger(value.stock, "初始库存", 9_999_999, source),
    warningThreshold: safeInteger(value.warningThreshold, "库存预警值", 99_999, source),
    isActive: value.isActive,
    tags: parseTags(value.tags, source)
  };
}

export function normalizeCreateProductInput(value: unknown): CreateProductInput {
  if (!isRecord(value)) inputError("新增商品请求格式无效");
  assertExactKeys(value, ["metadata", "initial", "reason"], "input");
  return {
    metadata: parseMetadata(value.metadata, "input"),
    initial: parseInitial(value.initial, "input"),
    reason: strictString(value.reason, "操作说明", 120, false, "input")
  };
}

export function normalizeEditProductInput(value: unknown): EditProductInput {
  if (!isRecord(value)) inputError("编辑商品请求格式无效");
  assertExactKeys(value, ["id", "expectedVersion", "metadata", "reason"], "input");
  const metadata = parseMetadata(value.metadata, "input");
  if (!metadata.productIndex) inputError("编辑商品时必须填写商品索引", "PRODUCT_INDEX_REQUIRED");
  return {
    id: strictString(value.id, "商品 ID", 128, true, "input"),
    expectedVersion: safeInteger(value.expectedVersion, "数据版本", Number.MAX_SAFE_INTEGER, "input"),
    metadata,
    reason: strictString(value.reason, "操作说明", 120, false, "input")
  };
}

export function parseProductDetail(value: unknown): ProductDetail {
  if (!isRecord(value)) contractError("商品详情响应无效");
  assertExactKeys(value, ["id", "version", "metadata", "initial", "updatedAt"], "response");
  return {
    id: strictString(value.id, "商品 ID", 128, true, "response"),
    version: safeInteger(value.version, "数据版本", Number.MAX_SAFE_INTEGER, "response"),
    metadata: parseMetadata(value.metadata, "response"),
    initial: parseInitial(value.initial, "response"),
    updatedAt: strictString(value.updatedAt, "更新时间", 80, false, "response")
  };
}

function parseProductSummary(value: unknown): ProductSummary {
  if (!isRecord(value)) contractError("商品写入结果无效");
  assertExactKeys(value, ["id", "sku", "name", "brand", "salePriceCents", "status", "isActive", "tags", "updatedAt", "version"], "response");
  const status = value.status;
  if (status !== "active" && status !== "inactive" && status !== "draft") contractError("商品状态响应无效");
  if (typeof value.isActive !== "boolean") contractError("商品销售状态响应无效");
  return {
    id: strictString(value.id, "商品 ID", 128, true, "response"),
    sku: strictString(value.sku, "SKU", 80, false, "response"),
    name: strictString(value.name, "商品名称", 160, true, "response"),
    brand: strictString(value.brand, "品牌", 100, false, "response"),
    salePriceCents: safeInteger(value.salePriceCents, "销售价", Number.MAX_SAFE_INTEGER, "response"),
    status,
    isActive: value.isActive,
    tags: parseTags(value.tags, "response"),
    updatedAt: strictString(value.updatedAt, "更新时间", 80, false, "response"),
    version: safeInteger(value.version, "数据版本", Number.MAX_SAFE_INTEGER, "response")
  };
}

export function parseProductMutationResult(value: unknown): MutationResult<ProductSummary> {
  if (!isRecord(value)) contractError("商品写入响应无效");
  assertExactKeys(value, ["item", "affected", "message", "requestId"], "response");
  const affected = safeInteger(value.affected, "影响记录数", 1, "response");
  if (affected === 1 && !value.item) contractError("商品写入响应缺少商品摘要");
  return {
    item: value.item === undefined ? undefined : parseProductSummary(value.item),
    affected,
    message: strictString(value.message, "结果说明", 240, true, "response"),
    requestId: value.requestId === undefined ? undefined : strictString(value.requestId, "请求 ID", 128, false, "response")
  };
}
