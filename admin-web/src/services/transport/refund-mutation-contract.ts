import { z } from "zod";
import { ApiError } from "@/services/http/api-error";

export const REFUND_MUTATION_ACTIONS = ["process", "reject"] as const;
export const REFUND_PROCESSABLE_STATUSES = ["pending", "processing", "failed"] as const;
export const REFUND_CANONICAL_STATUSES = [
  ...REFUND_PROCESSABLE_STATUSES,
  "refunded",
  "partial_refunded",
  "rejected",
  "cancelled"
] as const;

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCents = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const trimString = (value: unknown) => typeof value === "string" ? value.trim() : value;
const shortText = (max: number) => z.string().min(1).max(max);
const inputId = z.preprocess(trimString, shortText(128));
const inputText = (max: number, required = false) => z.preprocess(
  trimString,
  required ? z.string().min(1).max(max) : z.string().max(max)
);
const dateValue = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}, "timestamp must be canonical UTC ISO");
const processableStatus = z.enum(REFUND_PROCESSABLE_STATUSES);
const proofFileId = z.preprocess(
  trimString,
  z.string().max(500).regex(/^cloud:\/\/\S{1,492}$/)
);
const proofFileIds = z.array(proofFileId).max(6).superRefine((value, context) => {
  if (new Set(value).size !== value.length) {
    context.addIssue({ code: "custom", message: "refund proof file IDs must be unique" });
  }
});

const refundSnapshotSchema = z.object({
  refundRecordId: inputId,
  expectedRefundStatus: processableStatus,
  expectedRefundVersion: safeInteger,
  expectedRefundUpdatedAt: dateValue
}).strict();

const refundProcessRequestSchema = refundSnapshotSchema.extend({
  refundAmountCents: positiveCents,
  financeRemark: inputText(300),
  refundProofFileIds: proofFileIds
}).strict();

const refundRejectRequestSchema = refundSnapshotSchema.extend({
  rejectReason: inputText(300, true)
}).strict();

const refundProcessFormSchema = z.object({
  remark: inputText(300)
}).strict();

const refundRejectFormSchema = z.object({
  reason: inputText(300, true)
}).strict();

const refundMutationResultSchema = z.object({
  item: z.object({
    id: shortText(128),
    refundNo: z.string().max(100),
    status: z.enum(REFUND_CANONICAL_STATUSES),
    version: safeInteger,
    updatedAt: dateValue,
    amountCents: positiveCents
  }).strict(),
  affected: safeInteger.max(1),
  reused: z.boolean(),
  action: z.enum(REFUND_MUTATION_ACTIONS),
  accountRecalculationPending: z.boolean(),
  message: shortText(500),
  requestId: shortText(160)
}).strict().superRefine((value, context) => {
  const statusMatches = value.action === "reject"
    ? value.item.status === "rejected"
    : value.item.status === "refunded";
  if (!statusMatches) {
    context.addIssue({ code: "custom", message: "refund action and status mismatch", path: ["item", "status"] });
  }
  if (value.reused !== (value.affected === 0)) {
    context.addIssue({ code: "custom", message: "replay and affected mismatch", path: ["reused"] });
  }
  if (value.action === "reject" && value.accountRecalculationPending) {
    context.addIssue({ code: "custom", message: "reject cannot queue account recalculation", path: ["accountRecalculationPending"] });
  }
});

export type RefundMutationAction = typeof REFUND_MUTATION_ACTIONS[number];
export type RefundProcessRequest = z.infer<typeof refundProcessRequestSchema>;
export type RefundRejectRequest = z.infer<typeof refundRejectRequestSchema>;
export type RefundMutationRequest = RefundProcessRequest | RefundRejectRequest;
export type RefundMutationResult = z.infer<typeof refundMutationResultSchema>;

function inputError(message = "退款操作请求不符合安全契约"): never {
  throw new ApiError(message, "INVALID_REFUND_MUTATION", 400);
}

function resultError(): never {
  throw new ApiError("退款操作响应不符合安全契约", "INVALID_REFUND_MUTATION_CONTRACT", 502);
}

function snapshotFromRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    refundRecordId: row.id,
    expectedRefundStatus: row.status,
    expectedRefundVersion: row.version,
    expectedRefundUpdatedAt: row.updatedAt
  };
}

export function normalizeRefundMutationInput(
  action: RefundMutationAction,
  value: unknown
): RefundMutationRequest {
  const schema = action === "process" ? refundProcessRequestSchema : refundRejectRequestSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    inputError(action === "reject" ? "请填写有效的退款驳回原因并刷新快照后重试" : undefined);
  }
  return parsed.data;
}

export function buildRefundProcessPayload(
  row: Record<string, unknown>,
  form: { remark: string }
): RefundProcessRequest {
  const parsedForm = refundProcessFormSchema.safeParse(form);
  if (!parsedForm.success) inputError();
  return normalizeRefundMutationInput("process", {
    ...snapshotFromRow(row),
    refundAmountCents: row.amountCents,
    financeRemark: parsedForm.data.remark,
    refundProofFileIds: []
  }) as RefundProcessRequest;
}

export function buildRefundRejectPayload(
  row: Record<string, unknown>,
  form: { reason: string }
): RefundRejectRequest {
  const parsedForm = refundRejectFormSchema.safeParse(form);
  if (!parsedForm.success) inputError("请填写驳回原因");
  return normalizeRefundMutationInput("reject", {
    ...snapshotFromRow(row),
    rejectReason: parsedForm.data.reason
  }) as RefundRejectRequest;
}

export function isCurrentRefundMutationSnapshot(
  value: Record<string, unknown> | null | undefined
): boolean {
  if (!value) return false;
  return refundSnapshotSchema.safeParse(snapshotFromRow(value)).success;
}

export function parseRefundMutationResult(value: unknown): RefundMutationResult {
  const parsed = refundMutationResultSchema.safeParse(value);
  if (!parsed.success) resultError();
  return parsed.data;
}
