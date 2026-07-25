import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_BFF_ORIGIN = "https://cloud1-d7g4mbc5r2fac4a77-1440838049.ap-shanghai.app.tcloudbase.com";

function exactHttpsUrl(raw, label, allowPath) {
  const value = String(raw || "").trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an absolute HTTPS URL without credentials, query, or hash.`);
  }
  if (!allowPath && parsed.pathname !== "/") {
    throw new Error(`${label} must contain only scheme and host.`);
  }
  return parsed;
}

function integer(raw, fallback, min, max, label) {
  const value = Number(raw || fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function containsControlCharacter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function loadGatewayConfig(env = process.env, readSecret = (path) => readFileSync(path, "utf8")) {
  const publicUrl = exactHttpsUrl(env.ADMIN_WEB_PUBLIC_ORIGIN, "ADMIN_WEB_PUBLIC_ORIGIN", false);
  const upstream = exactHttpsUrl(env.ADMIN_WEB_BFF_TARGET, "ADMIN_WEB_BFF_TARGET", false);
  if (upstream.origin !== TEST_BFF_ORIGIN) {
    throw new Error("ADMIN_WEB_BFF_TARGET must match the configured test BFF gateway.");
  }
  const secretFile = String(env.ADMIN_WEB_ACTION_SECRET_FILE || "").trim();
  if (!secretFile) throw new Error("ADMIN_WEB_ACTION_SECRET_FILE is required.");
  const actionSecret = String(readSecret(secretFile)).trim();
  if (actionSecret.length < 32 || containsControlCharacter(actionSecret)) {
    throw new Error("The action secret must be at least 32 characters without control characters.");
  }
  return Object.freeze({
    port: integer(env.PORT, 8080, 1024, 65535, "PORT"),
    distDir: resolve(env.ADMIN_WEB_DIST_DIR || fileURLToPath(new URL("../dist", import.meta.url))),
    publicOrigin: publicUrl.origin,
    upstream,
    actionSecret,
    upstreamTimeoutMs: integer(env.ADMIN_WEB_UPSTREAM_TIMEOUT_MS, 55000, 45000, 120000, "ADMIN_WEB_UPSTREAM_TIMEOUT_MS")
  });
}
