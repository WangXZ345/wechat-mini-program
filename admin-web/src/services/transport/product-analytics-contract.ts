import { z } from "zod";
import { ApiError } from "@/services/http/api-error";
import type { ProductAnalyticsData } from "@/types/api";

const analyticsRangeSchema = z.enum(["7d", "30d", "90d"]);
const safeNonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const finiteChange = z.number().finite().min(-100);
const boundedText = z.string().min(1).max(200);

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");

const summaryItemSchema = z.object({
  key: z.string().min(1).max(64),
  label: boundedText,
  value: safeNonNegativeInteger.nullable(),
  kind: z.enum(["number", "money"]),
  change: finiteChange.nullable()
}).strict();

const seriesItemSchema = z.object({
  date: calendarDateSchema,
  salesCount: safeNonNegativeInteger,
  averagePriceCents: safeNonNegativeInteger.nullable(),
  quotePriceCents: safeNonNegativeInteger.nullable(),
  inventoryChange: safeInteger.nullable()
}).strict();

const rankingItemSchema = z.object({
  id: boundedText,
  name: boundedText,
  sku: z.string().max(200),
  salesCount: safeNonNegativeInteger,
  averagePriceCents: safeNonNegativeInteger.nullable(),
  currentPriceCents: safeNonNegativeInteger.nullable(),
  change: finiteChange.nullable()
}).strict();

const productAnalyticsSchema = z.object({
  range: analyticsRangeSchema,
  status: z.enum(["available", "empty", "unavailable"]),
  message: z.string().max(500).optional(),
  summary: z.array(summaryItemSchema).max(8),
  series: z.array(seriesItemSchema).max(90),
  ranking: z.array(rankingItemSchema).max(20),
  updatedAt: z.string().datetime({ offset: true })
}).strict();

export function parseProductAnalyticsData(
  raw: unknown,
  expectedRange: ProductAnalyticsData["range"]
): ProductAnalyticsData {
  const parsed = productAnalyticsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("商品分析响应格式无效", "INVALID_PRODUCT_ANALYTICS_RESPONSE", 502);
  }
  if (parsed.data.range !== expectedRange) {
    throw new ApiError("商品分析响应范围不匹配", "PRODUCT_ANALYTICS_RANGE_MISMATCH", 502);
  }
  return parsed.data;
}
