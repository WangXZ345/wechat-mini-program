import { z } from "zod";
import { ApiError } from "@/services/http/api-error";

export const RETURN_INSPECTION_ACTIONS = ["receive", "inspect"] as const;
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dateValue = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}, "timestamp must be canonical UTC ISO");
const inputId = z.preprocess((value) => typeof value === "string" ? value.trim() : value, z.string().min(1).max(128));
const expectedStatus = z.enum(["waiting_return", "returned", "received", "inspecting"]);
const remark = z.string().max(300).default("");

const receiveInputSchema = z.object({
  action: z.literal("receive"),
  id: inputId,
  expectedStatus: z.enum(["waiting_return", "returned"]),
  expectedVersion: safeInteger,
  expectedUpdatedAt: dateValue,
  remark
}).strict();

const inspectInputSchema = z.object({
  action: z.literal("inspect"),
  id: inputId,
  expectedStatus: z.enum(["received", "inspecting"]),
  expectedVersion: safeInteger,
  expectedUpdatedAt: dateValue,
  itemCondition: z.enum(["sellable", "damaged", "defective", "missing", "opened", "unknown"]),
  canRestock: z.boolean(),
  restockQuantity: safeInteger,
  inspectionRemark: z.string().max(300).default("")
}).strict().superRefine((value, context) => {
  if (!value.canRestock && value.restockQuantity !== 0) {
    context.addIssue({ code: "custom", message: "restock quantity must be zero when restocking is disabled", path: ["restockQuantity"] });
  }
  if (value.canRestock && (value.itemCondition !== "sellable" || value.restockQuantity <= 0)) {
    context.addIssue({ code: "custom", message: "only positive sellable restock is allowed", path: ["restockQuantity"] });
  }
});

const requestBase = {
  afterSaleId: inputId,
  expectedStatus,
  expectedVersion: safeInteger,
  expectedUpdatedAt: dateValue
};
const receiveRequestSchema = z.object({ ...requestBase, remark }).strict();
const inspectRequestSchema = z.object({
  ...requestBase,
  itemCondition: z.enum(["sellable", "damaged", "defective", "missing", "opened", "unknown"]),
  canRestock: z.boolean(),
  restockQuantity: safeInteger,
  inspectionRemark: z.string().max(300).default("")
}).strict().superRefine((value, context) => {
  if (!value.canRestock && value.restockQuantity !== 0) {
    context.addIssue({ code: "custom", path: ["restockQuantity"], message: "restock quantity must be zero when disabled" });
  }
  if (value.canRestock && (value.itemCondition !== "sellable" || value.restockQuantity <= 0)) {
    context.addIssue({ code: "custom", path: ["restockQuantity"], message: "sellable restock quantity must be positive" });
  }
});

const resultSchema = z.object({
  item: z.object({
    id: z.string().min(1).max(128),
    status: z.enum(["received", "approved", "refund_pending"]),
    version: safeInteger,
    updatedAt: dateValue
  }).strict(),
  afterSaleId: z.string().min(1).max(128),
  afterSaleStatus: z.enum(["received", "approved", "refund_pending"]),
  restoredQuantity: safeInteger,
  affected: z.union([z.literal(0), z.literal(1)]),
  reused: z.boolean(),
  message: z.string().min(1).max(500),
  requestId: z.string().min(1).max(160)
}).strict().superRefine((value, context) => {
  if (value.item.id !== value.afterSaleId || value.item.status !== value.afterSaleStatus) {
    context.addIssue({ code: "custom", path: ["item"], message: "result identity mismatch" });
  }
  if (value.reused !== (value.affected === 0)) {
    context.addIssue({ code: "custom", path: ["reused"], message: "replay and affected mismatch" });
  }
});

export type ReturnInspectionAction = typeof RETURN_INSPECTION_ACTIONS[number];
export type ReturnInspectionInput = z.infer<typeof receiveInputSchema> | z.infer<typeof inspectInputSchema>;
export type ReturnInspectionRequest = z.infer<typeof receiveRequestSchema> | z.infer<typeof inspectRequestSchema>;
export type ReturnInspectionResult = z.infer<typeof resultSchema>;

function inputError(message = "退货验收请求不符合安全契约"): never {
  throw new ApiError(message, "INVALID_RETURN_INSPECTION", 400);
}

function resultError(): never {
  throw new ApiError("退货验收响应不符合安全契约", "INVALID_RETURN_INSPECTION_CONTRACT", 502);
}

export function normalizeReturnInspectionInput(action: ReturnInspectionAction, value: unknown): ReturnInspectionInput {
  const schema = action === "receive" ? receiveInputSchema : inspectInputSchema;
  const parsed = schema.safeParse({ ...(value as Record<string, unknown>), action });
  if (!parsed.success) inputError();
  return parsed.data as ReturnInspectionInput;
}

export function toReturnInspectionRequest(input: ReturnInspectionInput): ReturnInspectionRequest {
  const raw = input.action === "receive"
    ? {
      afterSaleId: input.id,
      expectedStatus: input.expectedStatus,
      expectedVersion: input.expectedVersion,
      expectedUpdatedAt: input.expectedUpdatedAt,
      remark: input.remark
    }
    : {
      afterSaleId: input.id,
      expectedStatus: input.expectedStatus,
      expectedVersion: input.expectedVersion,
      expectedUpdatedAt: input.expectedUpdatedAt,
      itemCondition: input.itemCondition,
      canRestock: input.canRestock,
      restockQuantity: input.restockQuantity,
      inspectionRemark: input.inspectionRemark
    };
  const parsed = (input.action === "receive" ? receiveRequestSchema : inspectRequestSchema).safeParse(raw);
  if (!parsed.success) inputError();
  return parsed.data as ReturnInspectionRequest;
}

export function isCurrentReturnInspectionSnapshot(
  action: ReturnInspectionAction,
  row: Record<string, unknown> | null | undefined
): boolean {
  if (!row) return false;
  const base = {
    id: row.id,
    expectedStatus: row.status,
    expectedVersion: row.version,
    expectedUpdatedAt: row.updatedAt
  };
  if (action === "receive") return receiveInputSchema.safeParse({ ...base, action, remark: "" }).success;
  return inspectInputSchema.safeParse({
    ...base,
    action,
    itemCondition: typeof row.itemCondition === "string" ? row.itemCondition : "unknown",
    canRestock: false,
    restockQuantity: 0,
    inspectionRemark: ""
  }).success;
}

export function returnInspectionInputFromRow(
  action: ReturnInspectionAction,
  row: Record<string, unknown>,
  details: Partial<Record<string, unknown>> = {}
): ReturnInspectionInput {
  return normalizeReturnInspectionInput(action, {
    ...details,
    id: row.id,
    expectedStatus: row.status,
    expectedVersion: row.version,
    expectedUpdatedAt: row.updatedAt
  });
}

export function parseReturnInspectionResult(value: unknown): ReturnInspectionResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) resultError();
  return parsed.data;
}
