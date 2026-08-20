import { AxiosError, type AxiosResponse } from "axios";
import { describe, expect, it } from "vitest";
import { toApiError } from "./api-error";

function axiosFailure(status: number, data: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = { status, data, statusText: "Failure", headers, config: {} } as AxiosResponse;
  return new AxiosError("request failed", "ERR_BAD_RESPONSE", undefined, undefined, response);
}

describe("toApiError", () => {
  it("preserves the detailed code while exposing refresh guidance for version conflicts", () => {
    const error = toApiError(axiosFailure(409, {
      ok: false,
      code: "DATA_VERSION_CONFLICT",
      category: "DATA_VERSION_CONFLICT",
      message: "记录已变化，请刷新后重新确认",
      requestId: "request-1"
    }));
    expect(error).toMatchObject({
      code: "DATA_VERSION_CONFLICT",
      category: "DATA_VERSION_CONFLICT",
      status: 409,
      requestId: "request-1",
      requiresRefresh: true,
      retryable: false,
      partialSuccess: false
    });
  });

  it("marks idempotency processing as retryable and partial success explicitly", () => {
    expect(toApiError(axiosFailure(409, {
      code: "IDEMPOTENCY_PROCESSING",
      category: "IDEMPOTENCY_CONFLICT",
      message: "操作正在处理中，请稍后重试"
    }))).toMatchObject({ category: "IDEMPOTENCY_CONFLICT", retryable: true });
    expect(toApiError(axiosFailure(409, {
      code: "IDEMPOTENCY_KEY_CONFLICT",
      category: "IDEMPOTENCY_CONFLICT",
      message: "同一幂等键已绑定其他操作"
    }))).toMatchObject({ category: "IDEMPOTENCY_CONFLICT", retryable: false });
    expect(toApiError(axiosFailure(207, {
      code: "PARTIAL_SUCCESS",
      category: "PARTIAL_SUCCESS",
      message: "部分项目处理失败，请查看结果"
    }))).toMatchObject({ category: "PARTIAL_SUCCESS", partialSuccess: true, retryable: false });
  });

  it("keeps legacy envelopes aligned with the server category map", () => {
    const cases = [
      [409, "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_CONFLICT"],
      [422, "FILE_FORMAT_INVALID", "FILE_PARSE_ERROR"],
      [409, "REFUND_AMOUNT_OUT_OF_RANGE", "AMOUNT_LIMIT"],
      [503, "SECURITY_CONFIG_REQUIRED", "INTERNAL_ERROR"],
      [404, "SESSION_NOT_FOUND", "NOT_FOUND"],
      [400, "EXPECTED_STATUS_INVALID", "INVALID_ARGUMENT"],
      [400, "INVALID_ORDER_STATUS", "INVALID_ARGUMENT"],
      [405, "METHOD_NOT_ALLOWED", "INVALID_ARGUMENT"]
    ] as const;
    for (const [status, code, category] of cases) {
      expect(toApiError(axiosFailure(status, { code, message: "操作失败" }))).toMatchObject({ code, category });
    }
  });

  it("only exposes safe automatic retry guidance and preserves retry delay", () => {
    expect(toApiError(axiosFailure(422, { code: "FILE_PARSE_FAILED", message: "文件错误" }))).toMatchObject({ retryable: false });
    expect(toApiError(axiosFailure(500, { code: "INTERNAL_ERROR", message: "服务失败" }))).toMatchObject({ retryable: false });
    expect(toApiError(axiosFailure(429, {
      code: "RATE_LIMITED",
      message: "稍后重试",
      retryAfterSeconds: 8
    }))).toMatchObject({ retryable: true, retryAfterSeconds: 8 });
    expect(toApiError(axiosFailure(429, {
      code: "RATE_LIMITED",
      message: "稍后重试"
    }, { "retry-after": "12" }))).toMatchObject({ retryable: true, retryAfterSeconds: 12 });
  });

  it("does not expose unknown exception or database stack text", () => {
    const error = toApiError(new Error("MongoServerError\n    at node_modules/driver.js:42"));
    expect(error.code).toBe("UNKNOWN_ERROR");
    expect(error.category).toBe("INTERNAL_ERROR");
    expect(error.message).toBe("请求失败，请稍后重试");
    expect(error.message).not.toContain("Mongo");
    expect(error.message).not.toContain("node_modules");
  });
});
