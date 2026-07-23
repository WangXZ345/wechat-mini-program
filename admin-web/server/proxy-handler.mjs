import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";

const API_ROOT = "/api/admin/v1";
const ALLOWED_METHODS = new Set(["GET", "OPTIONS", "POST"]);
const ALLOW_METHODS = "GET, POST, OPTIONS";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_UPSTREAM_ERROR_BODY_BYTES = 64 * 1024;
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
const ERROR_RESPONSE_HEADERS = new Set([
  "retry-after",
  "set-cookie",
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
  if (code === "BFF_METHOD_NOT_ALLOWED") return "请求方法不受支持";
  if (code === "BFF_REQUEST_TOO_LARGE") return "请求内容过大";
  if (code === "BFF_UPSTREAM_TIMEOUT") return "后台服务响应超时";
  return "后台服务暂时不可用";
}

function writeJson(response, statusCode, payload, extraHeaders = {}) {
  if (response.headersSent || response.destroyed || response.writableEnded) return false;
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  response.end(body);
  return true;
}

function writeJsonError(response, statusCode, code, extraHeaders) {
  return writeJson(
    response,
    statusCode,
    { ok: false, code, message: errorMessage(code) },
    extraHeaders
  );
}

function closeRequestAfterResponse(request, response) {
  request.pause();
  response.once("finish", () => {
    if (!request.destroyed) request.destroy();
  });
}

function writeLocalError(request, response, statusCode, code, extraHeaders = {}) {
  closeRequestAfterResponse(request, response);
  return writeJsonError(response, statusCode, code, {
    connection: "close",
    ...extraHeaders
  });
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

function canonicalCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value)
    ? value
    : "";
}

function canonicalRequestId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : "";
}

function safeUpstreamErrorEnvelope(body, contentType) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, code: "BFF_UPSTREAM_ERROR", message: errorMessage("BFF_UPSTREAM_ERROR") };
  }
  const isCanonical = contentType.toLowerCase().includes("application/json")
    && parsed
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && parsed.ok === false;
  const code = isCanonical ? canonicalCode(parsed.code) : "";
  const requestId = isCanonical ? canonicalRequestId(parsed.requestId) : "";
  if (!code || !requestId) {
    return { ok: false, code: "BFF_UPSTREAM_ERROR", message: errorMessage("BFF_UPSTREAM_ERROR") };
  }
  return { ok: false, code, message: errorMessage("BFF_UPSTREAM_ERROR"), requestId };
}

function proxyRequest(request, response, config, target, requestUpstream, maxRequestBodyBytes) {
  return new Promise((resolve) => {
    let completed = false;
    let closeIncomingAfterResponse = false;
    let onRequestData;
    let onRequestEnd;
    let outgoing;
    let requestBytes = 0;
    let terminalLocked = false;
    let upstreamDestroyed = false;
    let upstreamResponse;

    const settle = () => {
      if (completed) return;
      completed = true;
      resolve();
    };
    const stopIncoming = () => {
      if (onRequestData) request.off("data", onRequestData);
      if (onRequestEnd) request.off("end", onRequestEnd);
      if (!request.readableEnded && !request.destroyed) request.pause();
    };
    const destroyUpstream = () => {
      if (upstreamDestroyed) return;
      upstreamDestroyed = true;
      upstreamResponse?.destroy?.();
      outgoing?.destroy?.();
    };
    const closeIncoming = () => {
      closeIncomingAfterResponse = true;
      stopIncoming();
    };
    const prepareHeaders = (headers) => {
      if (!request.readableEnded) {
        closeIncoming();
        headers.connection = "close";
      }
      return headers;
    };
    const fail = (statusCode, code, forceClose = false) => {
      if (completed || terminalLocked) return;
      terminalLocked = true;
      if (forceClose || !request.readableEnded) closeIncoming();
      destroyUpstream();
      if (response.headersSent) {
        response.destroy();
        settle();
        return;
      }
      const headers = closeIncomingAfterResponse ? { connection: "close" } : undefined;
      if (!writeJsonError(response, statusCode, code, headers)) settle();
    };
    const sendBufferedError = (statusCode, incomingHeaders, chunks, overflow) => {
      if (completed || terminalLocked) return;
      terminalLocked = true;
      if (!request.readableEnded) closeIncoming();
      if (overflow) destroyUpstream();
      const headers = filteredHeaders(incomingHeaders, ERROR_RESPONSE_HEADERS);
      if (closeIncomingAfterResponse) headers.connection = "close";
      const payload = overflow
        ? { ok: false, code: "BFF_UPSTREAM_ERROR", message: errorMessage("BFF_UPSTREAM_ERROR") }
        : safeUpstreamErrorEnvelope(
          Buffer.concat(chunks),
          String(incomingHeaders["content-type"] || "")
        );
      if (!writeJson(response, statusCode, payload, headers)) settle();
    };

    response.once("finish", () => {
      const shouldCloseIncoming = closeIncomingAfterResponse;
      settle();
      if (shouldCloseIncoming) {
        destroyUpstream();
        if (!request.destroyed) request.destroy();
      }
    });
    response.once("close", () => {
      if (!completed) {
        stopIncoming();
        destroyUpstream();
        settle();
      }
    });
    request.once("aborted", () => {
      if (completed || terminalLocked) return;
      terminalLocked = true;
      destroyUpstream();
      settle();
    });
    request.once("error", () => fail(400, "BFF_INVALID_REQUEST"));

    const receiveUpstream = (incoming) => {
      if (completed || terminalLocked) {
        incoming.destroy();
        return;
      }
      upstreamResponse = incoming;
      const statusCode = Number.isInteger(incoming.statusCode)
        && incoming.statusCode >= 200
        && incoming.statusCode <= 599
        ? incoming.statusCode
        : 502;
      if (statusCode >= 500) {
        const chunks = [];
        let bytes = 0;
        let overflow = false;
        incoming.on("data", (chunk) => {
          if (terminalLocked || completed) return;
          bytes += chunk.length;
          if (bytes > MAX_UPSTREAM_ERROR_BODY_BYTES) {
            overflow = true;
            sendBufferedError(statusCode, incoming.headers || {}, chunks, true);
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        incoming.once("end", () => {
          sendBufferedError(statusCode, incoming.headers || {}, chunks, overflow);
        });
        incoming.once("aborted", () => fail(502, "BFF_UPSTREAM_UNAVAILABLE"));
        incoming.on("error", () => fail(502, "BFF_UPSTREAM_UNAVAILABLE"));
        incoming.once("close", () => {
          if (!incoming.complete) fail(502, "BFF_UPSTREAM_UNAVAILABLE");
        });
        return;
      }

      const headers = filteredHeaders(incoming.headers, RESPONSE_HEADERS);
      let started = false;
      const start = () => {
        if (started || completed || terminalLocked) return started && !completed;
        try {
          response.writeHead(statusCode, prepareHeaders(headers));
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
        if (!start() || completed || terminalLocked) return;
        terminalLocked = true;
        response.end();
      });
      incoming.once("aborted", () => fail(502, "BFF_UPSTREAM_UNAVAILABLE"));
      incoming.on("error", () => fail(502, "BFF_UPSTREAM_UNAVAILABLE"));
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
        fail(504, "BFF_UPSTREAM_TIMEOUT");
      });
      outgoing.on("error", () => {
        fail(502, "BFF_UPSTREAM_UNAVAILABLE");
      });
      onRequestData = (chunk) => {
        if (completed || terminalLocked) return;
        requestBytes += chunk.length;
        if (requestBytes > maxRequestBodyBytes) {
          fail(413, "BFF_REQUEST_TOO_LARGE", true);
          return;
        }
        if (!outgoing.write(chunk)) {
          request.pause();
          outgoing.once("drain", () => {
            if (
              !completed
              && !terminalLocked
              && !closeIncomingAfterResponse
              && !request.destroyed
            ) {
              request.resume();
            }
          });
        }
      };
      onRequestEnd = () => {
        if (!completed && !terminalLocked) outgoing.end();
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
      writeLocalError(request, response, 400, "BFF_INVALID_PATH");
      return true;
    }
    const method = String(request.method || "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      writeLocalError(
        request,
        response,
        405,
        "BFF_METHOD_NOT_ALLOWED",
        { allow: ALLOW_METHODS }
      );
      return true;
    }
    const maxRequestBodyBytes = requestBodyLimit(config);
    if ((declaredBodyLength(request) ?? 0) > maxRequestBodyBytes) {
      writeLocalError(request, response, 413, "BFF_REQUEST_TOO_LARGE");
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
