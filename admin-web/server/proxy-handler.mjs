import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";

const API_ROOT = "/api/admin/v1";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "authorization",
  "content-length",
  "content-type",
  "cookie",
  "idempotency-key",
  "user-agent",
  "x-admin-csrf",
  "x-request-id"
]);
const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "pragma",
  "retry-after",
  "set-cookie",
  "vary",
  "www-authenticate",
  "x-request-id"
]);

function isApiPath(pathname) {
  return pathname === API_ROOT || pathname.startsWith(`${API_ROOT}/`);
}

function parseRequestTarget(rawUrl) {
  const raw = String(rawUrl || "/");
  const rawPathname = raw.split("?", 1)[0];
  if (!isApiPath(rawPathname)) return { handled: false };
  if (
    !raw.startsWith("/")
    || raw.startsWith("//")
    || raw.includes("#")
    || /[\u0000-\u0020\u007f\\]/.test(raw)
  ) {
    return { handled: true, valid: false };
  }

  let decoded = rawPathname;
  try {
    for (let depth = 0; depth < 5; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return { handled: true, valid: false };
  }
  if (
    /%[0-9a-f]{2}/i.test(decoded)
    || decoded.includes("?")
    || decoded.includes("#")
    || decoded.includes("\0")
    || decoded.includes("\\")
    || decoded.split("/").some((segment) => segment === "." || segment === "..")
    || !isApiPath(decoded)
  ) {
    return { handled: true, valid: false };
  }

  return { handled: true, target: raw, valid: true };
}

function filteredHeaders(source, allowlist) {
  const result = {};
  for (const [name, value] of Object.entries(source || {})) {
    const lower = name.toLowerCase();
    if (allowlist.has(lower) && value !== undefined) result[lower] = value;
  }
  return result;
}

function requestHeaders(request, config) {
  const headers = filteredHeaders(request.headers, REQUEST_HEADERS);
  headers.host = config.upstream.host;
  headers.origin = config.publicOrigin;
  headers["x-admin-action-secret"] = config.actionSecret;
  if (!headers["x-request-id"]) headers["x-request-id"] = randomUUID();
  return headers;
}

function errorMessage(code) {
  if (code === "BFF_INVALID_PATH") return "请求路径无效";
  if (code === "BFF_REQUEST_TOO_LARGE") return "请求内容过大";
  if (code === "BFF_UPSTREAM_TIMEOUT") return "后台服务响应超时";
  return "后台服务暂时不可用";
}

function writeJsonError(response, statusCode, code) {
  if (response.headersSent || response.destroyed || response.writableEnded) return false;
  const body = JSON.stringify({ ok: false, code, message: errorMessage(code) });
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(body);
  return true;
}

function requestBodyLimit(config) {
  return Number.isSafeInteger(config.maxRequestBodyBytes) && config.maxRequestBodyBytes > 0
    ? config.maxRequestBodyBytes
    : DEFAULT_MAX_REQUEST_BODY_BYTES;
}

function declaredBodyLength(request) {
  const raw = request.headers["content-length"];
  if (raw === undefined || Array.isArray(raw) || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}

function proxyRequest(request, response, config, target, requestUpstream, maxRequestBodyBytes) {
  return new Promise((resolve) => {
    let completed = false;
    let onRequestData;
    let onRequestEnd;
    let outgoing;
    let requestBytes = 0;
    let upstreamEnded = false;
    let upstreamResponse;

    const settle = () => {
      if (completed) return;
      completed = true;
      resolve();
    };
    const stopIncoming = () => {
      if (onRequestData) request.off("data", onRequestData);
      if (onRequestEnd) request.off("end", onRequestEnd);
      if (!request.readableEnded && !request.destroyed) request.resume();
    };
    const destroyUpstream = () => {
      upstreamResponse?.destroy?.();
      outgoing?.destroy?.();
    };
    const fail = (statusCode, code) => {
      if (completed) return;
      stopIncoming();
      destroyUpstream();
      if (response.headersSent) {
        response.destroy();
        settle();
        return;
      }
      if (!writeJsonError(response, statusCode, code)) settle();
    };

    response.once("finish", settle);
    response.once("close", () => {
      if (!completed) {
        stopIncoming();
        destroyUpstream();
        settle();
      }
    });
    request.once("aborted", () => {
      destroyUpstream();
      settle();
    });
    request.once("error", () => fail(400, "BFF_INVALID_REQUEST"));

    const receiveUpstream = (incoming) => {
      if (completed) {
        incoming.destroy();
        return;
      }
      upstreamResponse = incoming;
      const headers = filteredHeaders(incoming.headers, RESPONSE_HEADERS);
      const statusCode = Number.isInteger(incoming.statusCode)
        && incoming.statusCode >= 200
        && incoming.statusCode <= 599
        ? incoming.statusCode
        : 502;
      let started = false;
      const start = () => {
        if (started || completed) return !completed;
        try {
          response.writeHead(statusCode, headers);
          started = true;
          return true;
        } catch {
          fail(502, "BFF_UPSTREAM_UNAVAILABLE");
          return false;
        }
      };

      incoming.on("data", (chunk) => {
        if (!start()) return;
        if (!response.write(chunk)) {
          incoming.pause();
          response.once("drain", () => {
            if (!completed) incoming.resume();
          });
        }
      });
      incoming.once("end", () => {
        upstreamEnded = true;
        if (start() && !completed) response.end();
      });
      incoming.once("aborted", () => {
        if (!upstreamEnded) fail(502, "BFF_UPSTREAM_UNAVAILABLE");
      });
      incoming.once("error", () => {
        if (!upstreamEnded) fail(502, "BFF_UPSTREAM_UNAVAILABLE");
      });
      incoming.once("close", () => {
        if (!incoming.complete) fail(502, "BFF_UPSTREAM_UNAVAILABLE");
      });
    };

    try {
      outgoing = requestUpstream({
        headers: requestHeaders(request, config),
        hostname: config.upstream.hostname,
        method: request.method || "GET",
        path: target,
        port: config.upstream.port || undefined,
        protocol: config.upstream.protocol
      }, receiveUpstream);
      outgoing.setTimeout(config.upstreamTimeoutMs, () => {
        if (!upstreamEnded) fail(504, "BFF_UPSTREAM_TIMEOUT");
      });
      outgoing.once("error", () => {
        if (!upstreamEnded) fail(502, "BFF_UPSTREAM_UNAVAILABLE");
      });
      onRequestData = (chunk) => {
        if (completed) return;
        requestBytes += chunk.length;
        if (requestBytes > maxRequestBodyBytes) {
          fail(413, "BFF_REQUEST_TOO_LARGE");
          return;
        }
        if (!outgoing.write(chunk)) {
          request.pause();
          outgoing.once("drain", () => {
            if (!completed && !request.destroyed) request.resume();
          });
        }
      };
      onRequestEnd = () => {
        if (!completed) outgoing.end();
      };
      request.on("data", onRequestData);
      request.once("end", onRequestEnd);
    } catch {
      fail(502, "BFF_UPSTREAM_UNAVAILABLE");
    }
  });
}

export function createProxyHandler(config, requestUpstream = httpsRequest) {
  return async function proxyHandler(request, response) {
    const parsed = parseRequestTarget(request.url);
    if (!parsed.handled) return false;
    if (!parsed.valid) {
      request.resume();
      writeJsonError(response, 400, "BFF_INVALID_PATH");
      return true;
    }
    const maxRequestBodyBytes = requestBodyLimit(config);
    if ((declaredBodyLength(request) ?? 0) > maxRequestBodyBytes) {
      request.resume();
      writeJsonError(response, 413, "BFF_REQUEST_TOO_LARGE");
      return true;
    }
    await proxyRequest(
      request,
      response,
      config,
      parsed.target,
      requestUpstream,
      maxRequestBodyBytes
    );
    return true;
  };
}
