import { z } from "zod";
import { ApiError } from "@/services/http/api-error";

export const PAYMENT_QUERY_STATUSES = ["pending_confirm", "paid", "partial_paid", "unpaid", "abnormal", "rejected"] as const;

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dateValue = z.string().datetime({ offset: true }).nullable();
const shortText = (max: number) => z.string().max(max);

const paymentSummarySchema = z.object({
  id: shortText(128).min(1),
  version: safeInteger,
  orderNo: shortText(120),
  customerMasked: shortText(160),
  amountCents: safeInteger,
  proofLabel: z.enum(["已提交凭证", "无凭证"]),
  proofCount: safeInteger.max(20),
  status: z.enum(PAYMENT_QUERY_STATUSES),
  submittedAt: dateValue,
  updatedAt: dateValue
}).strict();

const paymentListPageSchema = z.object({
  items: z.array(paymentSummarySchema).max(100),
  pageSize: safeInteger.min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(4096).nullable()
}).strict().superRefine((value, context) => {
  if (value.hasMore && !value.nextCursor) context.addIssue({ code: "custom", message: "hasMore requires nextCursor", path: ["nextCursor"] });
  if (!value.hasMore && value.nextCursor !== null) context.addIssue({ code: "custom", message: "final page must not include nextCursor", path: ["nextCursor"] });
});

export type PaymentQueryStatus = typeof PAYMENT_QUERY_STATUSES[number];
export type PaymentSummary = z.infer<typeof paymentSummarySchema>;
export type PaymentListPage = z.infer<typeof paymentListPageSchema>;

function contractError(message: string): never {
  throw new ApiError(message, "INVALID_PAYMENT_CONTRACT", 502);
}

export function parsePaymentListPage(value: unknown): PaymentListPage {
  const parsed = paymentListPageSchema.safeParse(value);
  if (!parsed.success) contractError("付款记录列表响应不符合安全契约");
  return parsed.data;
}

export function parsePaymentDetail(value: unknown): PaymentSummary {
  const parsed = paymentSummarySchema.safeParse(value);
  if (!parsed.success) contractError("付款记录详情响应不符合安全契约");
  return parsed.data;
}
