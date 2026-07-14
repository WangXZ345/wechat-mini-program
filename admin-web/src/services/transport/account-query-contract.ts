import { z } from "zod";
import { ApiError } from "@/services/http/api-error";

export const ACCOUNT_QUERY_STATUSES = ["unpaid", "pending_confirm", "abnormal", "settled"] as const;

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signedSafeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const dateValue = z.string().datetime({ offset: true }).nullable();
const shortText = (max: number) => z.string().max(max);

function digitToAscii(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  if (code >= 0x30 && code <= 0x39) return character;
  if (code >= 0xFF10 && code <= 0xFF19) return String(code - 0xFF10);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06F0 && code <= 0x06F9) return String(code - 0x06F0);
  return character;
}

function containsCompletePhone(value: string): boolean {
  const normalized = Array.from(value, digitToAscii).join("")
    .replace(/[\s.,:_|\-()/\\·‐-―。\u200B-\u200D\u2060\uFEFF]/gu, "");
  return /(?:^|\D)(?:\+?86)?1[3-9]\d{9}(?:\D|$)/.test(normalized);
}

const noCompletePhone = (max: number) => shortText(max).refine(
  (value) => !containsCompletePhone(value),
  "complete phone is forbidden"
);

const accountSummarySchema = z.object({
  id: shortText(128).min(1),
  customerMasked: noCompletePhone(160),
  totalOrders: safeInteger,
  receivableCents: safeInteger,
  receivedCents: safeInteger,
  unpaidAmountCents: safeInteger,
  pendingConfirmAmountCents: safeInteger,
  abnormalCount: safeInteger,
  status: z.enum(ACCOUNT_QUERY_STATUSES),
  lastOrderAt: dateValue,
  lastPaymentAt: dateValue,
  updatedAt: dateValue
}).strict();

const accountListPageSchema = z.object({
  items: z.array(accountSummarySchema).max(100),
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

const accountOrderSchema = z.object({
  id: shortText(128).min(1),
  orderNo: shortText(120),
  status: shortText(60),
  paymentStatus: shortText(60),
  totalAmountCents: safeInteger,
  createdAt: dateValue
}).strict();

const accountLogSchema = z.object({
  id: shortText(128).min(1),
  changeType: shortText(80),
  beforeReceivableCents: safeInteger,
  afterReceivableCents: safeInteger,
  beforeReceivedCents: safeInteger,
  afterReceivedCents: safeInteger,
  beforeUnpaidCents: safeInteger,
  afterUnpaidCents: safeInteger,
  changeAmountCents: signedSafeInteger,
  orderNo: shortText(120),
  createdAt: dateValue,
  summary: noCompletePhone(300)
}).strict();

const accountWarningSchema = z.enum(["关联订单暂不可用", "账款流水暂不可用"]);

const accountDetailSchema = z.object({
  account: accountSummarySchema,
  orders: z.array(accountOrderSchema).max(50),
  logs: z.array(accountLogSchema).max(100),
  ordersHasMore: z.boolean(),
  logsHasMore: z.boolean(),
  relatedDataStatus: z.enum(["complete", "partial"]),
  warnings: z.array(accountWarningSchema).max(2)
}).strict().superRefine((value, context) => {
  if (value.relatedDataStatus === "complete" && value.warnings.length > 0) {
    context.addIssue({ code: "custom", message: "complete detail must not contain warnings", path: ["warnings"] });
  }
  if (value.relatedDataStatus === "partial" && value.warnings.length === 0) {
    context.addIssue({ code: "custom", message: "partial detail requires a fixed warning", path: ["warnings"] });
  }
});

export type AccountQueryStatus = typeof ACCOUNT_QUERY_STATUSES[number];
export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type AccountListPage = z.infer<typeof accountListPageSchema>;
export type AccountOrder = z.infer<typeof accountOrderSchema>;
export type AccountLog = z.infer<typeof accountLogSchema>;
export type AccountDetail = z.infer<typeof accountDetailSchema>;

function contractError(message: string): never {
  throw new ApiError(message, "INVALID_ACCOUNT_CONTRACT", 502);
}

export function parseAccountListPage(value: unknown): AccountListPage {
  const parsed = accountListPageSchema.safeParse(value);
  if (!parsed.success) contractError("账款列表响应不符合安全契约");
  return parsed.data;
}

export function parseAccountDetail(value: unknown): AccountDetail {
  const parsed = accountDetailSchema.safeParse(value);
  if (!parsed.success) contractError("账款详情响应不符合安全契约");
  return parsed.data;
}
