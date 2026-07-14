import axios from "axios";

export class ApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, code = "UNKNOWN_ERROR", status?: number, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (axios.isAxiosError(error)) {
    const payload = error.response?.data as {
      code?: string;
      message?: string;
      requestId?: string;
      error?: { code?: string; message?: string; requestId?: string };
    } | undefined;
    return new ApiError(
      payload?.error?.message || payload?.message || (error.response ? "服务暂时不可用" : "网络连接失败"),
      payload?.error?.code || payload?.code || (error.response ? "HTTP_ERROR" : "NETWORK_ERROR"),
      error.response?.status,
      payload?.error?.requestId || payload?.requestId
    );
  }
  return new ApiError(error instanceof Error ? error.message : "未知错误");
}
