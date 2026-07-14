import {
  normalizeProxyOrigin,
  normalizeProxyTarget,
  type AdminWebAppEnvironment
} from "./src/config/bff-url";

export interface DevProxyConfiguration {
  target: string;
  origin: string;
  actionSecret: string;
}

export interface DevProxyEnvironment {
  ADMIN_WEB_BFF_PROXY_TARGET?: string;
  ADMIN_WEB_BFF_PROXY_ORIGIN?: string;
  ADMIN_WEB_ACTION_SECRET?: string;
}

function normalizeHeaderSecret(value: string | undefined): string {
  const secret = value?.trim() || "";
  if (!secret) throw new Error("Configured BFF proxy requires ADMIN_WEB_ACTION_SECRET.");
  if (/[\r\n\0]/.test(secret)) throw new Error("ADMIN_WEB_ACTION_SECRET contains invalid header characters.");
  return secret;
}

export function resolveDevProxyConfiguration(
  values: DevProxyEnvironment,
  appEnv: AdminWebAppEnvironment
): DevProxyConfiguration | null {
  const rawTarget = values.ADMIN_WEB_BFF_PROXY_TARGET?.trim() || "";
  if (!rawTarget) return null;

  const rawOrigin = values.ADMIN_WEB_BFF_PROXY_ORIGIN?.trim() || "";
  if (!rawOrigin) throw new Error("Configured BFF proxy requires ADMIN_WEB_BFF_PROXY_ORIGIN.");

  return {
    target: normalizeProxyTarget(rawTarget, appEnv),
    origin: normalizeProxyOrigin(rawOrigin, appEnv),
    actionSecret: normalizeHeaderSecret(values.ADMIN_WEB_ACTION_SECRET)
  };
}
