import { z } from "zod";
import { ApiError } from "@/services/http/api-error";
import type { ListResult } from "@/types/api";

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dateValue = z.string().datetime({ offset: true }).nullable();
const shortText = (max: number) => z.string().max(max);

const orderSummarySchema = z.object({
  id: shortText(128).min(1),
  orderNo: shortText(100),
  customerMasked: shortText(160),
  customerPhoneMasked: shortText(40),
  itemSummary: shortText(240),
  itemCount: safeInteger,
  totalQuantity: safeInteger,
  status: shortText(60),
  paymentStatus: shortText(60),
  deliveryStatus: shortText(60),
  createdAt: dateValue,
  updatedAt: dateValue,
  version: safeInteger,
  totalAmountCents: safeInteger.optional()
}).strict();

const orderLineSchema = z.object({
  id: shortText(128),
  productId: shortText(128),
  productName: shortText(160),
  specification: shortText(120),
  productionDate: shortText(40),
  quantity: safeInteger,
  unitPriceCents: safeInteger.optional(),
  totalAmountCents: safeInteger.optional()
}).strict();

const customerSchema = z.object({
  nameMasked: shortText(80),
  phoneMasked: shortText(40),
  phone: shortText(40).optional()
}).strict();

const maskedAddressSchema = z.object({
  receiverName: shortText(80),
  receiverPhoneMasked: shortText(40),
  regionText: shortText(160),
  detailAddressMasked: shortText(220)
}).strict();

const fullAddressSchema = z.object({
  receiverName: shortText(80),
  receiverPhone: shortText(40),
  regionText: shortText(160),
  detailAddress: shortText(220)
}).strict();

const orderDetailSchema = orderSummarySchema.extend({
  items: z.array(orderLineSchema).max(500),
  customer: customerSchema,
  shippingAddressMasked: maskedAddressSchema.optional(),
  shippingAddress: fullAddressSchema.optional(),
  adminRemark: shortText(500).optional(),
  riskLevelSnapshot: z.enum(["normal", "important", "risk", "blocked"]).optional()
}).strict();

const orderListSchema = z.object({
  items: z.array(orderSummarySchema).max(100),
  total: safeInteger,
  page: safeInteger.min(1),
  pageSize: safeInteger.min(1).max(100),
  nextCursor: z.string().max(4096).nullable().optional()
}).strict();

export type OrderSummary = z.infer<typeof orderSummarySchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export type OrderDetail = z.infer<typeof orderDetailSchema>;

function contractError(message: string): never {
  throw new ApiError(message, "INVALID_ORDER_CONTRACT", 502);
}

export function parseOrderList(value: unknown): ListResult<OrderSummary> {
  const parsed = orderListSchema.safeParse(value);
  if (!parsed.success) contractError("订单列表响应不符合安全契约");
  return parsed.data;
}

export function parseOrderDetail(value: unknown): OrderDetail {
  const parsed = orderDetailSchema.safeParse(value);
  if (!parsed.success) contractError("订单详情响应不符合安全契约");
  return parsed.data;
}
