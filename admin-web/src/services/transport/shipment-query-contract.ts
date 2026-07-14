import { z } from "zod";
import { ApiError } from "@/services/http/api-error";

export const SHIPMENT_STATUSES = [
  "created",
  "pending_shipment",
  "shipped",
  "completed",
  "cancelled",
  "abnormal"
] as const;

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dateValue = z.string().datetime({ offset: true }).nullable();
const shortText = (max: number) => z.string().max(max);

const shipmentSummarySchema = z.object({
  id: shortText(128).min(1),
  shipmentNo: shortText(120),
  status: z.enum(SHIPMENT_STATUSES),
  orderCount: safeInteger,
  totalItemCount: safeInteger,
  customerMasked: shortText(160),
  carrier: shortText(80),
  trackingMasked: shortText(120),
  addressConsistent: z.boolean(),
  orderNosPreview: z.array(shortText(120)).max(3),
  createdAt: dateValue,
  updatedAt: dateValue,
  shippedAt: dateValue,
  completedAt: dateValue,
  version: safeInteger,
  totalOrderAmountCents: safeInteger.optional()
}).strict();

const shipmentListPageSchema = z.object({
  items: z.array(shipmentSummarySchema).max(100),
  pageSize: safeInteger.min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(4096).nullable()
}).strict().superRefine((value, context) => {
  if (value.hasMore && !value.nextCursor) {
    context.addIssue({ code: "custom", message: "hasMore requires nextCursor", path: ["nextCursor"] });
  }
  if (!value.hasMore && value.nextCursor !== null) {
    context.addIssue({ code: "custom", message: "final page must not include nextCursor", path: ["nextCursor"] });
  }
});

const maskedAddressSchema = z.object({
  receiverName: shortText(80),
  receiverPhoneMasked: shortText(40),
  regionText: shortText(160),
  detailAddressMasked: shortText(220),
  fullAddressMasked: shortText(360)
}).strict();

const fullAddressSchema = z.object({
  receiverName: shortText(80),
  receiverPhoneMasked: shortText(40),
  regionText: shortText(160),
  detailAddress: shortText(220),
  fullAddress: shortText(360)
}).strict();

const shipmentDetailRecordSchema = z.object({
  id: shortText(128).min(1),
  shipmentNo: shortText(120),
  status: z.enum(SHIPMENT_STATUSES),
  version: safeInteger,
  orderCount: safeInteger,
  totalItemCount: safeInteger,
  totalProductCount: safeInteger,
  customerMasked: shortText(160),
  shippingAddressMasked: maskedAddressSchema.optional(),
  shippingAddress: fullAddressSchema.optional(),
  carrier: shortText(80),
  trackingMasked: shortText(120).optional(),
  trackingNo: shortText(120).optional(),
  addressConsistent: z.boolean(),
  createdAt: dateValue,
  updatedAt: dateValue,
  shippedAt: dateValue,
  completedAt: dateValue,
  cancelledAt: dateValue,
  adminRemark: shortText(500).optional(),
  cancelReason: shortText(300).optional(),
  totalOrderAmountCents: safeInteger.optional(),
  totalPaidAmountCents: safeInteger.optional(),
  totalUnpaidAmountCents: safeInteger.optional()
}).strict().superRefine((value, context) => {
  if (Object.hasOwn(value, "shippingAddressMasked") === Object.hasOwn(value, "shippingAddress")) {
    context.addIssue({ code: "custom", message: "exactly one address projection is required" });
  }
  if (Object.hasOwn(value, "trackingMasked") === Object.hasOwn(value, "trackingNo")) {
    context.addIssue({ code: "custom", message: "exactly one tracking projection is required" });
  }
});

const shipmentOrderSchema = z.object({
  id: shortText(128).min(1),
  orderNo: shortText(120),
  status: shortText(60),
  paymentStatus: shortText(60),
  shippingStatus: shortText(60),
  createdAt: dateValue,
  totalAmountCents: safeInteger.optional()
}).strict();

const shipmentItemSummarySchema = z.object({
  productId: shortText(128),
  productName: shortText(160),
  brand: shortText(80),
  category: shortText(80),
  specification: shortText(120),
  productionDate: shortText(40),
  totalQuantity: safeInteger,
  orderNos: z.array(shortText(120)).max(100)
}).strict();

const shipmentLogSchema = z.object({
  id: shortText(128).min(1),
  action: shortText(80),
  operatorRole: shortText(60),
  createdAt: dateValue,
  remark: shortText(500).optional()
}).strict();

const shipmentDetailSchema = z.object({
  shipment: shipmentDetailRecordSchema,
  orders: z.array(shipmentOrderSchema).max(100),
  itemSummary: z.array(shipmentItemSummarySchema).max(500),
  logs: z.array(shipmentLogSchema).max(100),
  logsHasMore: z.boolean(),
  relatedDataStatus: z.enum(["complete", "partial"]),
  warnings: z.array(z.literal("部分关联订单缺失，数据可能不完整")).max(1)
}).strict();

export type ShipmentStatus = z.infer<typeof shipmentSummarySchema>["status"];
export type ShipmentSummary = z.infer<typeof shipmentSummarySchema>;
export type ShipmentListPage = z.infer<typeof shipmentListPageSchema>;
export type ShipmentDetail = z.infer<typeof shipmentDetailSchema>;

function contractError(message: string): never {
  throw new ApiError(message, "INVALID_SHIPMENT_CONTRACT", 502);
}

export function parseShipmentListPage(value: unknown): ShipmentListPage {
  const parsed = shipmentListPageSchema.safeParse(value);
  if (!parsed.success) contractError("合并发货单列表响应不符合安全契约");
  return parsed.data;
}

export function parseShipmentDetail(value: unknown): ShipmentDetail {
  const parsed = shipmentDetailSchema.safeParse(value);
  if (!parsed.success) contractError("合并发货单详情响应不符合安全契约");
  return parsed.data;
}
