import { z } from "zod";
import { ApiError } from "@/services/http/api-error";

export const AFTER_SALE_REVIEW_ACTIONS = ["approve", "reject"] as const;
export type AfterSaleReviewAction = typeof AFTER_SALE_REVIEW_ACTIONS[number];

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dateValue = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}, "timestamp must be canonical UTC ISO");
const trimString = (value: unknown) => typeof value === "string" ? value.trim() : value;
const inputId = z.preprocess(trimString, z.string().min(1).max(128));
const inputReason = z.preprocess(trimString, z.string().max(300).default(""));

const afterSaleReviewInputSchema = z.object({
  id: inputId,
  expectedStatus: z.literal("pending_review"),
  expectedVersion: safeInteger,
  expectedUpdatedAt: dateValue,
  approvedRefundAmount: safeInteger.optional(),
  returnRequired: z.boolean().optional(),
  reason: inputReason
}).strict();

const afterSaleReviewRequestSchema = z.object({
  afterSaleId: z.string().min(1).max(128),
  expectedStatus: z.literal("pending_review"),
  expectedVersion: safeInteger,
  expectedUpdatedAt: dateValue,
  approvedRefundAmount: safeInteger.optional(),
  returnRequired: z.boolean().optional(),
  reason: z.string().max(300)
}).strict();

const afterSaleReviewResultSchema = z.object({
  item: z.object({
    id: z.string().min(1).max(128),
    caseNo: z.string().max(100),
    status: z.enum(["approved", "waiting_return", "refund_pending", "rejected"]),
    version: safeInteger,
    updatedAt: dateValue
  }).strict(),
  afterSaleId: z.string().min(1).max(128),
  afterSaleStatus: z.enum(["approved", "waiting_return", "refund_pending", "rejected"]),
  refundStatus: z.enum(["none", "pending", "rejected"]),
  approvedRefundAmount: safeInteger,
  affected: safeInteger.max(1),
  reused: z.boolean(),
  decision: z.enum(AFTER_SALE_REVIEW_ACTIONS),
  message: z.string().min(1).max(500),
  requestId: z.string().min(1).max(160)
}).strict().superRefine((value, context) => {
  if (value.item.id !== value.afterSaleId || value.item.status !== value.afterSaleStatus) {
    context.addIssue({ code: "custom", message: "after-sale item and status mismatch", path: ["item"] });
  }
  if (value.decision === "reject" && value.item.status !== "rejected") {
    context.addIssue({ code: "custom", message: "reject decision must produce rejected status", path: ["decision"] });
  }
  if (value.decision === "approve" && value.item.status === "rejected") {
    context.addIssue({ code: "custom", message: "approve decision cannot produce rejected status", path: ["decision"] });
  }
  if (value.reused !== (value.affected === 0)) {
    context.addIssue({ code: "custom", message: "replay and affected mismatch", path: ["reused"] });
  }
});

export type AfterSaleReviewInput = z.infer<typeof afterSaleReviewInputSchema>;
export type AfterSaleReviewRequest = z.infer<typeof afterSaleReviewRequestSchema>;
export type AfterSaleReviewResult = z.infer<typeof afterSaleReviewResultSchema>;

function inputError(message = "after-sale review request is invalid"): never {
  throw new ApiError(message, "INVALID_AFTER_SALE_REVIEW", 400);
}

function resultError(): never {
  throw new ApiError("invalid after-sale review response", "INVALID_AFTER_SALE_REVIEW_CONTRACT", 502);
}

export function normalizeAfterSaleReviewInput(action: AfterSaleReviewAction, value: unknown): AfterSaleReviewInput {
  if (!AFTER_SALE_REVIEW_ACTIONS.includes(action)) inputError();
  const parsed = afterSaleReviewInputSchema.safeParse(value);
  if (!parsed.success) inputError(action === "reject" ? "rejection reason is required" : undefined);
  if (action === "reject") {
    if (!parsed.data.reason) inputError("rejection reason is required");
    if (parsed.data.approvedRefundAmount !== undefined || parsed.data.returnRequired !== undefined) {
      inputError("reject request contains approve-only fields");
    }
  }
  return parsed.data;
}

export function toAfterSaleReviewRequest(input: AfterSaleReviewInput): AfterSaleReviewRequest {
  const parsed = afterSaleReviewRequestSchema.safeParse({
    afterSaleId: input.id,
    expectedStatus: input.expectedStatus,
    expectedVersion: input.expectedVersion,
    expectedUpdatedAt: input.expectedUpdatedAt,
    approvedRefundAmount: input.approvedRefundAmount,
    returnRequired: input.returnRequired,
    reason: input.reason
  });
  if (!parsed.success) inputError();
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as AfterSaleReviewRequest;
}

export function isCurrentAfterSaleReviewSnapshot(value: Record<string, unknown> | null | undefined): boolean {
  if (!value) return false;
  return afterSaleReviewInputSchema.safeParse({
    id: value.id,
    expectedStatus: value.status,
    expectedVersion: value.version,
    expectedUpdatedAt: value.updatedAt,
    reason: ""
  }).success;
}

export function afterSaleReviewInputFromRow(
  action: AfterSaleReviewAction,
  row: Record<string, unknown>,
  options: { approvedRefundAmount?: number; returnRequired?: boolean; reason: string }
): AfterSaleReviewInput {
  return normalizeAfterSaleReviewInput(action, {
    id: row.id,
    expectedStatus: row.status,
    expectedVersion: row.version,
    expectedUpdatedAt: row.updatedAt,
    approvedRefundAmount: options.approvedRefundAmount,
    returnRequired: options.returnRequired,
    reason: options.reason
  });
}

export function parseAfterSaleReviewResult(value: unknown): AfterSaleReviewResult {
  const parsed = afterSaleReviewResultSchema.safeParse(value);
  if (!parsed.success) resultError();
  return parsed.data;
}
