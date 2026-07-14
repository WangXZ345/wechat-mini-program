import { z } from "zod";
import { normalizeApiBaseUrl } from "./bff-url";

const envSchema = z.object({
  appEnv: z.enum(["local", "test", "staging", "production"]).default("test"),
  dataMode: z.enum(["real", "mock"]).default("real"),
  cloudbaseEnvId: z.string().trim().default(""),
  apiBaseUrl: z.string().trim().default(""),
  requestTimeoutMs: z.coerce.number().int().min(1000).max(60_000).default(12_000),
  realtimeMode: z.enum(["mock", "polling", "off"]).default("polling"),
  release: z.string().trim().default("test-local")
});

const parsedEnv = envSchema.parse({
  appEnv: import.meta.env.VITE_APP_ENV || "test",
  dataMode: import.meta.env.VITE_DATA_MODE || "real",
  cloudbaseEnvId: import.meta.env.VITE_CLOUDBASE_ENV_ID || "",
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || "",
  requestTimeoutMs: import.meta.env.VITE_REQUEST_TIMEOUT_MS || "12000",
  realtimeMode: import.meta.env.VITE_REALTIME_MODE || "polling",
  release: import.meta.env.VITE_RELEASE || "test-local"
});

if (parsedEnv.dataMode === "real" && (!parsedEnv.cloudbaseEnvId || !parsedEnv.apiBaseUrl)) {
  throw new Error("Real data mode requires VITE_CLOUDBASE_ENV_ID and VITE_API_BASE_URL.");
}

const normalizedApiBaseUrl = parsedEnv.apiBaseUrl
  ? normalizeApiBaseUrl(parsedEnv.apiBaseUrl, parsedEnv.appEnv).value
  : "";

export const env = {
  ...parsedEnv,
  apiBaseUrl: normalizedApiBaseUrl
};

export const useMockTransport = env.dataMode === "mock";
export const isRealDataMode = env.dataMode === "real";
export const isDevBffProxyMissing = typeof __ADMIN_WEB_DEV_BFF_PROXY_MISSING__ !== "undefined"
  && __ADMIN_WEB_DEV_BFF_PROXY_MISSING__;
const environmentLabels = {
  local: "本地环境",
  test: "测试环境",
  staging: "预发布环境",
  production: "生产环境"
} as const;
export const dataEnvironmentLabel = useMockTransport
  ? "本地演示数据"
  : `${environmentLabels[env.appEnv]} · 真实数据模式`;

if (isRealDataMode && env.realtimeMode === "mock") {
  throw new Error("Real data mode cannot use mock realtime mode.");
}
