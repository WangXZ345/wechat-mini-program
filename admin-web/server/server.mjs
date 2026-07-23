import { createServer } from "node:http";
import { createProxyHandler } from "./proxy-handler.mjs";
import { createStaticHandler } from "./static-handler.mjs";

const API_ROOT = "/api/admin/v1";
const INTERNAL_ERROR_BODY = '{"ok":false,"code":"GATEWAY_INTERNAL_ERROR"}';
const NOT_FOUND_BODY = '{"ok":false,"code":"ROUTE_NOT_FOUND"}';
const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "manifest-src 'self'"
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
});

function isApiRequest(request) {
  const pathname = String(request.url || "/").split("?", 1)[0];
  return pathname === API_ROOT || pathname.startsWith(`${API_ROOT}/`);
}

function setSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(body);
}

export function createAdminWebServer(config, dependencies = {}) {
  const proxyHandler = dependencies.proxyHandler || createProxyHandler(config);
  const staticHandler = dependencies.staticHandler || createStaticHandler(config);

  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      if (await proxyHandler(request, response)) return;
      if (isApiRequest(request)) {
        writeJson(response, 404, NOT_FOUND_BODY);
        return;
      }
      if (await staticHandler(request, response)) return;
      writeJson(response, 404, NOT_FOUND_BODY);
    } catch {
      if (response.headersSent || response.destroyed || response.writableEnded) {
        if (!response.destroyed) response.destroy();
        return;
      }
      writeJson(response, 500, INTERNAL_ERROR_BODY);
    }
  });
}
