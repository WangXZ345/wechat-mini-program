import axios from "axios";
import type { ApiErrorCategory } from "@/types/api";

export type { ApiErrorCategory } from "@/types/api";

const categories = new Set<ApiErrorCategory>([
  "INVALID_ARGUMENT", "UNAUTHENTICATED", "FORBIDDEN", "CSRF", "RATE_LIMITED", "NOT_FOUND",
  "INVALID_STATE", "DATA_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "FILE_PARSE_ERROR",
  "VALIDATION_ERROR", "INSUFFICIENT_STOCK", "AMOUNT_LIMIT", "PARTIAL_SUCCESS", "INTERNAL_ERROR"
]);

function classifyError(codeValue: unknown, status?: number): ApiErrorCategory {
  const code = String(codeValue || "").trim().toUpperCase();
  if (categories.has(code as ApiErrorCategory)) return code as ApiErrorCategory;
  if (code.includes("CSRF")) return "CSRF";
  if (code.includes("RATE_LIMIT")) return "RATE_LIMITED";
  if (code.includes("DATA_VERSION") || code === "EXPECTED_VERSION_MISMATCH") return "DATA_VERSION_CONFLICT";
  if (code.includes("IDEMPOTENCY") && (code.includes("CONFLICT") || code.includes("PROCESSING") || code.includes("REUSED"))) return "IDEMPOTENCY_CONFLICT";
  if (code.includes("FILE") && (code.includes("PARSE") || code.includes("FORMAT"))) return "FILE_PARSE_ERROR";
  if (code.includes("STOCK") && code.includes("INSUFFICIENT")) return "INSUFFICIENT_STOCK";
  if (code.includes("AMOUNT") && (code.includes("LIMIT") || code.includes("EXCEED") || code.includes("OUT_OF_RANGE"))) return "AMOUNT_LIMIT";
  if (code.includes("PARTIAL")) return "PARTIAL_SUCCESS";
  if (code.includes("VALIDATION") || code.endsWith("_DATA_INVALID")) return "VALIDATION_ERROR";
  if (status !== undefined && status >= 500) return "INTERNAL_ERROR";
  if (code.includes("FORBIDDEN") || code === "ORIGIN_NOT_ALLOWED" || code === "PERMISSION_DENIED") return "FORBIDDEN";
  if (status === 404 || code === "NOT_FOUND" || code.endsWith("_NOT_FOUND")) return "NOT_FOUND";
  if (status === 405) return "INVALID_ARGUMENT";
  if (status === 400 && (code.startsWith("INVALID_") || code === "INVALID_JSON" || code === "INVALID_REQUEST_BODY" || code.endsWith("_REQUIRED") || code.includes("_INVALID"))) return "INVALID_ARGUMENT";
  if (status === 401 || /^(AUTH_)|SESSION_|TOKEN_|ACCOUNT_UNAVAILABLE|REFRESH_TOKEN/.test(code)) return "UNAUTHENTICATED";
  if (code.includes("STATE") || code.includes("STATUS") || status === 409) return "INVALID_STATE";
  if (status === 403) return "FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400) return "INVALID_ARGUMENT";
  return "INTERNAL_ERROR";
}

function safeMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const message = value.trim();
  const hasControlCharacter = Array.from(message).some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!message || message.length > 240 || hasControlCharacter) return fallback;
  if (/(?:\bat\s+\S+\s*\(|node_modules|Mongo(?:Server)?Error|CloudBase|database|collection|SQLSTATE|stack\s*trace)/i.test(message)) return fallback;
  return message;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly category: ApiErrorCategory;
  readonly retryable: boolean;
  readonly requiresRefresh: boolean;
  readonly partialSuccess: boolean;
  readonly retryAfterSeconds?: number;

  constructor(message: string, code = "UNKNOWN_ERROR", status?: number, requestId?: string, category?: ApiErrorCategory, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.category = category || classifyError(code, status);
    this.requiresRefresh = this.category === "DATA_VERSION_CONFLICT";
    this.partialSuccess = this.category === "PARTIAL_SUCCESS";
    this.retryable = code === "NETWORK_ERROR" || code === "IDEMPOTENCY_PROCESSING" || this.category === "RATE_LIMITED";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function positiveSeconds(value: unknown): number | undefined {
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (axios.isAxiosError(error)) {
    const payload = error.response?.data as {
      code?: string;
      message?: string;
      requestId?: string;
      category?: ApiErrorCategory;
      retryAfterSeconds?: number;
      error?: { code?: string; category?: ApiErrorCategory; message?: string; requestId?: string; retryAfterSeconds?: number };
    } | undefined;
    const code = payload?.error?.code || payload?.code || (error.response ? "HTTP_ERROR" : "NETWORK_ERROR");
    const category = categories.has(payload?.error?.category as ApiErrorCategory)
      ? payload?.error?.category
      : categories.has(payload?.category as ApiErrorCategory)
        ? payload?.category
        : classifyError(code, error.response?.status);
    const responseHeaders = error.response?.headers as unknown as { get?: (name: string) => unknown; [key: string]: unknown } | undefined;
    const retryAfterSeconds = positiveSeconds(
      payload?.error?.retryAfterSeconds
      ?? payload?.retryAfterSeconds
      ?? responseHeaders?.get?.("retry-after")
      ?? responseHeaders?.["retry-after"]
    );
    return new ApiError(
      safeMessage(payload?.error?.message || payload?.message, error.response ? "服务暂时不可用" : "网络连接失败"),
      code,
      error.response?.status,
      payload?.error?.requestId || payload?.requestId,
      category,
      retryAfterSeconds
    );
  }
  return new ApiError("请求失败，请稍后重试", "UNKNOWN_ERROR", undefined, undefined, "INTERNAL_ERROR");
}
