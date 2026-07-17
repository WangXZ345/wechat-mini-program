import { z } from "zod";
import { ApiError } from "@/services/http/api-error";

export const PAYMENT_MUTATION_ACTIONS = ["confirm", "reject"] as const;

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dateValue = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}, "timestamp must be canonical UTC ISO");
const shortText = (max: number) => z.string().min(1).max(max);
const trimString = (value: unknown) => typeof value === "string" ? value.trim() : value;
const inputId = z.preprocess(trimString, z.string().min(1).max(128));
const inputReason = z.preprocess(trimString, z.string().max(300).default(""));

const paymentMutationInputSchema = z.object({
  id: inputId,
  expectedStatus: z.literal("pending_confirm"),
  expectedVersion: safeInteger,
  expectedUpdatedAt: dateValue,
  reason: inputReason
}).strict();

const paymentMutationRequestSchema = z.object({
  paymentId: shortText(128),
  expectedStatus: z.literal("pending_confirm"),
  expectedVersion: safeInteger,
  expectedUpdatedAt: dateValue,
  reason: z.string().max(300)
}).strict();

const paymentMutationResultSchema = z.object({
  item: z.object({
    id: shortText(128),
    orderNo: z.string().max(120),
    status: z.enum(["paid", "rejected"]),
    version: safeInteger,
    updatedAt: dateValue
  }).strict(),
  affected: safeInteger.max(1),
  reused: z.boolean(),
  decision: z.enum(PAYMENT_MUTATION_ACTIONS),
  accountRecalculationPending: z.boolean(),
  message: shortText(500),
  requestId: shortText(160)
}).strict().superRefine((value, context) => {
  const expectedStatus = value.decision === "confirm" ? "paid" : "rejected";
  if (value.item.status !== expectedStatus) {
    context.addIssue({ code: "custom", message: "decision and status mismatch", path: ["item", "status"] });
  }
  if (value.reused !== (value.affected === 0)) {
    context.addIssue({ code: "custom", message: "replay and affected mismatch", path: ["reused"] });
  }
});

export type PaymentMutationAction = typeof PAYMENT_MUTATION_ACTIONS[number];
export type PaymentMutationInput = z.infer<typeof paymentMutationInputSchema>;
export type PaymentMutationRequest = z.infer<typeof paymentMutationRequestSchema>;
export type PaymentMutationResult = z.infer<typeof paymentMutationResultSchema>;

function inputError(message = "付款审核请求不符合安全契约"): never {
  throw new ApiError(message, "INVALID_PAYMENT_MUTATION", 400);
}

function resultError(): never {
  throw new ApiError("付款审核响应不符合安全契约", "INVALID_PAYMENT_MUTATION_CONTRACT", 502);
}

export function normalizePaymentMutationInput(action: PaymentMutationAction, value: unknown): PaymentMutationInput {
  if (!PAYMENT_MUTATION_ACTIONS.includes(action)) inputError();
  const parsed = paymentMutationInputSchema.safeParse(value);
  if (!parsed.success) inputError();
  if (action === "reject" && !parsed.data.reason) inputError("请填写驳回原因");
  return parsed.data;
}

export function toPaymentMutationRequest(input: PaymentMutationInput): PaymentMutationRequest {
  const parsed = paymentMutationRequestSchema.safeParse({
    paymentId: input.id,
    expectedStatus: input.expectedStatus,
    expectedVersion: input.expectedVersion,
    expectedUpdatedAt: input.expectedUpdatedAt,
    reason: input.reason
  });
  if (!parsed.success) inputError();
  return parsed.data;
}

export function isCurrentPaymentMutationSnapshot(value: Record<string, unknown> | null | undefined): boolean {
  if (!value) return false;
  return paymentMutationInputSchema.safeParse({
    id: value.id,
    expectedStatus: value.status,
    expectedVersion: value.version,
    expectedUpdatedAt: value.updatedAt,
    reason: ""
  }).success;
}

export function paymentMutationInputFromRow(
  action: PaymentMutationAction,
  row: Record<string, unknown>,
  reason: string
): PaymentMutationInput {
  return normalizePaymentMutationInput(action, {
    id: row.id,
    expectedStatus: row.status,
    expectedVersion: row.version,
    expectedUpdatedAt: row.updatedAt,
    reason
  });
}

export function parsePaymentMutationResult(value: unknown): PaymentMutationResult {
  const parsed = paymentMutationResultSchema.safeParse(value);
  if (!parsed.success) resultError();
  return parsed.data;
}
