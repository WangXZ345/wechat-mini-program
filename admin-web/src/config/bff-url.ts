export type AdminWebAppEnvironment = "local" | "test" | "staging" | "production";

export interface NormalizedApiBaseUrl {
  value: string;
  sameOrigin: boolean;
}

const ABSOLUTE_HTTP_PROTOCOLS = new Set(["http:", "https:"]);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseAbsoluteHttpUrl(
  rawValue: string,
  appEnv: AdminWebAppEnvironment,
  label: string
): URL {
  const value = rawValue.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }

  if (!ABSOLUTE_HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain a query string or hash.`);
  }
  if (value.includes("\\")) {
    throw new Error(`${label} must not contain backslashes.`);
  }
  if (parsed.protocol === "http:" && !(appEnv === "test" && isLoopbackHostname(parsed.hostname))) {
    throw new Error(`${label} must use HTTPS; test may use HTTP only for a loopback host.`);
  }
  return parsed;
}

export function normalizeApiBaseUrl(
  rawValue: string,
  appEnv: AdminWebAppEnvironment
): NormalizedApiBaseUrl {
  const value = rawValue.trim();
  if (!value) throw new Error("VITE_API_BASE_URL must not be empty.");

  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.includes("\\") || /[\s?#]/.test(value)) {
      throw new Error("VITE_API_BASE_URL same-origin value must be a single-slash path without whitespace, query, hash, or backslashes.");
    }
    return {
      value: value.length > 1 ? value.replace(/\/$/, "") : value,
      sameOrigin: true
    };
  }

  const parsed = parseAbsoluteHttpUrl(value, appEnv, "VITE_API_BASE_URL");
  return {
    value: parsed.toString().replace(/\/$/, ""),
    sameOrigin: false
  };
}

export function normalizeProxyTarget(
  rawValue: string,
  appEnv: AdminWebAppEnvironment
): string {
  return parseAbsoluteHttpUrl(rawValue, appEnv, "BFF proxy target").toString().replace(/\/$/, "");
}

export function normalizeProxyOrigin(
  rawValue: string,
  appEnv: AdminWebAppEnvironment
): string {
  const parsed = parseAbsoluteHttpUrl(rawValue, appEnv, "BFF proxy origin");
  if (parsed.pathname !== "/") {
    throw new Error("BFF proxy origin must not contain a path.");
  }
  return parsed.origin;
}
