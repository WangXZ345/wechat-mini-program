# Admin Web ZSpace Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the real-data Vue admin as a fail-closed production gateway container on ZSpace NAS, expose it through ZSpace HTTPS remote access, and preserve the existing CloudBase test-environment authentication and authorization boundaries.

**Architecture:** A multi-stage Node 20 image builds `admin-web/dist`, then a dependency-free Node gateway serves the SPA and proxies only `/api/admin/v1/**` to the existing CloudBase test gateway. The gateway overwrites the upstream `Origin`, reads `X-Admin-Action-Secret` from a read-only secret file, and never exposes that value to the browser or image layers.

**Tech Stack:** Vue 3, Vite 7, TypeScript, Node.js 20 native HTTP/HTTPS APIs, Node test runner, Docker Compose, CloudBase test environment, ZSpace Docker and remote access.

## Global Constraints

- Only use CloudBase test environment `cloud1-d7g4mbc5r2fac4a77`; never connect production.
- Do not publish the mini-program or mutate core order, inventory, account, payment, refund, or customer data during deployment.
- Keep the browser on same-origin `/api/admin/v1`; do not put the action secret, peppers, tokens, cookies, cursor secret, admin password, or bootstrap secret into Git, the image, frontend assets, or logs.
- Preserve the current access-token, HttpOnly refresh-cookie, CSRF, role revalidation, field projection, idempotency, and polling behavior.
- Preserve unrelated working-tree changes in `admin-web/src/services/transport/http-transport.ts`, `admin-web/src/services/transport/http-transport.spec.ts`, `miniprogram/pages/admin/orders.wxml`, `scripts/test-admin-orders-filter-summary.js`, and any unrelated untracked plan.
- The user explicitly authorized scoped local commits on the isolated `codex/admin-web-zspace` worktree branch on 2026-07-23. Do not push or merge that branch without a separate request.
- Before changing or uploading CloudBase function configuration, obtain a fresh explicit confirmation from the user.
- If the ZSpace remote-access URL changes, update the exact HTTPS origin in both `adminWebApi` and `adminWebAuth`; never use `*` or a wildcard domain.

---

## File Map

- Create `admin-web/server/config.mjs`: validate public origin, upstream target, port, dist path, and the secret file.
- Create `admin-web/server/config.test.mjs`: fail-closed configuration tests.
- Create `admin-web/server/static-handler.mjs`: health check, immutable assets, SPA fallback, and safe path handling.
- Create `admin-web/server/static-handler.test.mjs`: static routing and cache tests.
- Create `admin-web/server/proxy-handler.mjs`: narrow API reverse proxy with fixed security headers and safe logging metadata.
- Create `admin-web/server/proxy-handler.test.mjs`: request/response header, timeout, and error tests with an injected upstream requester.
- Create `admin-web/server/server.mjs`: combine the static and proxy handlers and expose a testable server factory.
- Create `admin-web/server/server.test.mjs`: integration tests on an ephemeral loopback port.
- Create `admin-web/server/index.mjs`: production entrypoint and graceful shutdown.
- Modify `admin-web/package.json`: add gateway test and production start scripts without changing frontend dependencies.
- Create `admin-web/Dockerfile`: multi-stage real build and non-root runtime.
- Create `admin-web/.dockerignore`: exclude dependencies, private env files, Git data, reports, and local artifacts.
- Create `admin-web/docker-compose.zspace.yml`: ZSpace service, health check, restart policy, and read-only secret mount.
- Create `admin-web/zspace.env.example`: public deployment variables only.
- Modify `admin-web/README.md`: add ZSpace preparation, deployment, update, rollback, and acceptance instructions.
- Do not create a real secret file in the repository.

---

### Task 1: Fail-Closed Runtime Configuration

**Files:**
- Create: `admin-web/server/config.mjs`
- Create: `admin-web/server/config.test.mjs`
- Modify: `admin-web/package.json`

**Interfaces:**
- Consumes: `process.env`, UTF-8 secret file.
- Produces: `loadGatewayConfig(env, readSecret)` returning `{ port, distDir, publicOrigin, upstream, actionSecret, upstreamTimeoutMs }`.

- [ ] **Step 1: Add a failing Node test for exact HTTPS origins, targets, and secret-file loading**

```js
// admin-web/server/config.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { loadGatewayConfig } from "./config.mjs";

const baseEnv = {
  PORT: "8080",
  ADMIN_WEB_DIST_DIR: "/app/dist",
  ADMIN_WEB_PUBLIC_ORIGIN: "https://example.zconnect.cn",
  ADMIN_WEB_BFF_TARGET: "https://cloud1-d7g4mbc5r2fac4a77-1440838049.ap-shanghai.app.tcloudbase.com",
  ADMIN_WEB_ACTION_SECRET_FILE: "/run/secrets/admin_web_action_secret",
  ADMIN_WEB_UPSTREAM_TIMEOUT_MS: "55000"
};

test("loads a normalized production gateway configuration", () => {
  const config = loadGatewayConfig(baseEnv, () => `${"s".repeat(32)}\n`);
  assert.equal(config.port, 8080);
  assert.equal(config.publicOrigin, "https://example.zconnect.cn");
  assert.equal(config.upstream.origin, baseEnv.ADMIN_WEB_BFF_TARGET);
  assert.equal(config.actionSecret, "s".repeat(32));
  assert.equal(config.upstreamTimeoutMs, 55000);
});

for (const value of [
  "http://example.zconnect.cn",
  "https://user:pass@example.zconnect.cn",
  "https://example.zconnect.cn/path",
  "https://example.zconnect.cn?x=1",
  "https://example.zconnect.cn#x"
]) {
  test(`rejects invalid public origin ${value}`, () => {
    assert.throws(
      () => loadGatewayConfig({ ...baseEnv, ADMIN_WEB_PUBLIC_ORIGIN: value }, () => "s".repeat(32)),
      /ADMIN_WEB_PUBLIC_ORIGIN/
    );
  });
}

test("rejects missing or short action secret", () => {
  assert.throws(() => loadGatewayConfig(baseEnv, () => "short"), /action secret/i);
});
```

- [ ] **Step 2: Add the gateway test script and verify the test fails because the module does not exist**

```json
{
  "scripts": {
    "test": "vitest run && npm run test:gateway",
    "test:gateway": "node --test server/config.test.mjs server/static-handler.test.mjs server/proxy-handler.test.mjs server/server.test.mjs",
    "start": "node server/index.mjs"
  }
}
```

Run: `cd admin-web; node --test server/config.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/config.mjs`.

- [ ] **Step 3: Implement strict normalization and secret loading**

```js
// admin-web/server/config.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function loadGatewayConfig(env = process.env, readSecret = (path) => readFileSync(path, "utf8")) {
  const publicUrl = exactHttpsUrl(env.ADMIN_WEB_PUBLIC_ORIGIN, "ADMIN_WEB_PUBLIC_ORIGIN", false);
  const upstream = exactHttpsUrl(env.ADMIN_WEB_BFF_TARGET, "ADMIN_WEB_BFF_TARGET", true);
  const secretFile = String(env.ADMIN_WEB_ACTION_SECRET_FILE || "").trim();
  if (!secretFile) throw new Error("ADMIN_WEB_ACTION_SECRET_FILE is required.");
  const actionSecret = String(readSecret(secretFile)).trim();
  if (actionSecret.length < 32 || /[\r\n\0]/.test(actionSecret)) {
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
```

- [ ] **Step 4: Run the focused configuration tests**

Run: `cd admin-web; node --test server/config.test.mjs`  
Expected: all configuration tests PASS.

- [ ] **Step 5: Review the scoped diff without staging**

Run: `git diff --check -- admin-web/package.json admin-web/server/config.mjs admin-web/server/config.test.mjs`  
Expected: exit code 0; no unrelated files listed.

---

### Task 2: Static SPA and Health Handler

**Files:**
- Create: `admin-web/server/static-handler.mjs`
- Create: `admin-web/server/static-handler.test.mjs`

**Interfaces:**
- Consumes: `{ distDir }`, Node `IncomingMessage` and `ServerResponse`.
- Produces: `createStaticHandler({ distDir })`, an async handler returning `true` when it wrote a response and `false` only for API paths.

- [ ] **Step 1: Write failing tests for health, cache policy, SPA fallback, and traversal rejection**

```js
// admin-web/server/static-handler.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStaticHandler } from "./static-handler.mjs";

async function fixture() {
  const distDir = await mkdtemp(join(tmpdir(), "admin-web-static-"));
  await mkdir(join(distDir, "assets"));
  await writeFile(join(distDir, "index.html"), "<!doctype html><div id=app></div>");
  await writeFile(join(distDir, "assets", "app.js"), "console.log('ok')");
  return distDir;
}

test("health does not read business data", async () => {
  const handler = createStaticHandler({ distDir: await fixture() });
  const response = await handler.testRequest("/healthz");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});

test("assets are immutable and routes fall back to uncached index", async () => {
  const handler = createStaticHandler({ distDir: await fixture() });
  const asset = await handler.testRequest("/assets/app.js");
  assert.match(asset.headers["cache-control"], /immutable/);
  const route = await handler.testRequest("/orders/order-1");
  assert.equal(route.statusCode, 200);
  assert.equal(route.headers["cache-control"], "no-store");
});

test("API paths are not converted to index and traversal is rejected", async () => {
  const handler = createStaticHandler({ distDir: await fixture() });
  assert.equal((await handler.testRequest("/api/admin/v1/orders")).handled, false);
  assert.equal((await handler.testRequest("/%2e%2e/package.json")).statusCode, 400);
});
```

- [ ] **Step 2: Run the static tests to verify failure**

Run: `cd admin-web; node --test server/static-handler.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the handler with a small injectable response adapter**

```js
// admin-web/server/static-handler.mjs
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"]
]);

export function createStaticHandler({ distDir }) {
  const root = resolve(distDir);

  async function handle(pathname, write) {
    if (pathname.startsWith("/api/admin/v1")) return false;
    if (pathname === "/healthz") {
      write(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, '{"ok":true}');
      return true;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      write(400, { "content-type": "text/plain; charset=utf-8" }, "Bad Request");
      return true;
    }
    if (decoded.includes("\0") || decoded.split("/").includes("..")) {
      write(400, { "content-type": "text/plain; charset=utf-8" }, "Bad Request");
      return true;
    }
    let candidate = resolve(root, `.${decoded}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      write(400, { "content-type": "text/plain; charset=utf-8" }, "Bad Request");
      return true;
    }
    try {
      if (!(await stat(candidate)).isFile()) throw new Error("not-file");
    } catch {
      candidate = resolve(root, "index.html");
    }
    const body = await readFile(candidate);
    const isAsset = candidate.includes(`${sep}assets${sep}`);
    write(200, {
      "content-type": TYPES.get(extname(candidate).toLowerCase()) || "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-store"
    }, body);
    return true;
  }

  const handler = async (request, response) => {
    const pathname = String(request.url || "/").split("?", 1)[0];
    return handle(pathname, (status, headers, body) => {
      response.writeHead(status, headers);
      response.end(body);
    });
  };
  handler.testRequest = async (pathname) => {
    const result = { handled: true, statusCode: 0, headers: {}, body: "" };
    result.handled = await handle(pathname, (status, headers, body) => {
      result.statusCode = status;
      result.headers = headers;
      result.body = Buffer.isBuffer(body) ? body.toString("utf8") : body;
    });
    return result;
  };
  return handler;
}
```

- [ ] **Step 4: Run the static tests**

Run: `cd admin-web; node --test server/static-handler.test.mjs`  
Expected: all static-handler tests PASS.

- [ ] **Step 5: Review the scoped diff without staging**

Run: `git diff --check -- admin-web/server/static-handler.mjs admin-web/server/static-handler.test.mjs`  
Expected: exit code 0.

---

### Task 3: Narrow Security Proxy

**Files:**
- Create: `admin-web/server/proxy-handler.mjs`
- Create: `admin-web/server/proxy-handler.test.mjs`

**Interfaces:**
- Consumes: gateway config and an injectable `requestUpstream(options, callback)` compatible with `https.request`.
- Produces: `createProxyHandler(config, requestUpstream)` returning an API handler.

- [ ] **Step 1: Write failing tests for overwritten security headers and safe failures**

```js
// admin-web/server/proxy-handler.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createProxyHandler } from "./proxy-handler.mjs";

test("overwrites host, origin, and action secret instead of trusting the browser", async () => {
  let captured;
  const requestUpstream = (options, callback) => {
    captured = options;
    const upstream = new EventEmitter();
    upstream.statusCode = 200;
    upstream.headers = { "content-type": "application/json", "set-cookie": ["refresh=x; HttpOnly; Secure"] };
    queueMicrotask(() => {
      callback(upstream);
      upstream.emit("data", Buffer.from('{"ok":true}'));
      upstream.emit("end");
    });
    const outgoing = new EventEmitter();
    outgoing.write = () => {};
    outgoing.end = () => {};
    outgoing.destroy = () => {};
    outgoing.setTimeout = () => {};
    return outgoing;
  };
  const handler = createProxyHandler({
    publicOrigin: "https://public.example",
    upstream: new URL("https://cloud.example"),
    actionSecret: "s".repeat(32),
    upstreamTimeoutMs: 55000
  }, requestUpstream);
  const response = await handler.testRequest({
    method: "GET",
    url: "/api/admin/v1/dashboard",
    headers: { host: "evil", origin: "https://evil.example", "x-admin-action-secret": "evil" }
  });
  assert.equal(captured.headers.host, "cloud.example");
  assert.equal(captured.headers.origin, "https://public.example");
  assert.equal(captured.headers["x-admin-action-secret"], "s".repeat(32));
  assert.deepEqual(response.headers["set-cookie"], ["refresh=x; HttpOnly; Secure"]);
});

test("rejects non-api paths and converts upstream errors to a JSON 502", async () => {
  const handler = createProxyHandler({
    publicOrigin: "https://public.example",
    upstream: new URL("https://cloud.example"),
    actionSecret: "s".repeat(32),
    upstreamTimeoutMs: 55000
  }, () => {
    const outgoing = new EventEmitter();
    outgoing.write = () => {};
    outgoing.end = () => queueMicrotask(() => outgoing.emit("error", new Error("secret upstream detail")));
    outgoing.destroy = () => {};
    outgoing.setTimeout = () => {};
    return outgoing;
  });
  assert.equal((await handler.testRequest({ method: "GET", url: "/other", headers: {} })).handled, false);
  const failed = await handler.testRequest({ method: "GET", url: "/api/admin/v1/dashboard", headers: {} });
  assert.equal(failed.statusCode, 502);
  assert.equal(JSON.parse(failed.body).code, "BFF_UPSTREAM_UNAVAILABLE");
  assert.doesNotMatch(failed.body, /secret upstream detail/);
});
```

- [ ] **Step 2: Run the proxy tests to verify failure**

Run: `cd admin-web; node --test server/proxy-handler.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the HTTPS proxy with an explicit header allowlist**

```js
// admin-web/server/proxy-handler.mjs
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";

const REQUEST_HEADERS = new Set([
  "accept", "accept-language", "authorization", "content-type", "cookie",
  "idempotency-key", "user-agent", "x-csrf-token", "x-request-id"
]);
const RESPONSE_HEADERS = new Set([
  "cache-control", "content-disposition", "content-type", "etag",
  "set-cookie", "vary", "x-request-id"
]);

function jsonError(write, statusCode, code) {
  write(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }, JSON.stringify({ ok: false, code, message: "后台服务暂时不可用" }));
}

export function createProxyHandler(config, requestUpstream = httpsRequest) {
  async function handle(input, write) {
    const url = new URL(input.url || "/", "http://gateway.local");
    if (url.pathname !== "/api/admin/v1" && !url.pathname.startsWith("/api/admin/v1/")) return false;
    const headers = {};
    for (const [name, value] of Object.entries(input.headers || {})) {
      const lower = name.toLowerCase();
      if (REQUEST_HEADERS.has(lower) && value !== undefined) headers[lower] = value;
    }
    headers.host = config.upstream.host;
    headers.origin = config.publicOrigin;
    headers["x-admin-action-secret"] = config.actionSecret;
    headers["x-request-id"] ||= randomUUID();

    await new Promise((resolve) => {
      let settled = false;
      const finish = (status, responseHeaders, body) => {
        if (settled) return;
        settled = true;
        write(status, responseHeaders, body);
        resolve();
      };
      const outgoing = requestUpstream({
        protocol: config.upstream.protocol,
        hostname: config.upstream.hostname,
        port: config.upstream.port || 443,
        method: input.method || "GET",
        path: `${config.upstream.pathname.replace(/\/$/, "")}${url.pathname}${url.search}`,
        headers
      }, (upstreamResponse) => {
        const chunks = [];
        upstreamResponse.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        upstreamResponse.on("end", () => {
          const responseHeaders = {};
          for (const [name, value] of Object.entries(upstreamResponse.headers || {})) {
            if (RESPONSE_HEADERS.has(name.toLowerCase()) && value !== undefined) responseHeaders[name.toLowerCase()] = value;
          }
          finish(upstreamResponse.statusCode || 502, responseHeaders, Buffer.concat(chunks));
        });
      });
      outgoing.setTimeout(config.upstreamTimeoutMs, () => {
        outgoing.destroy();
        jsonError(finish, 504, "BFF_UPSTREAM_TIMEOUT");
      });
      outgoing.on("error", () => jsonError(finish, 502, "BFF_UPSTREAM_UNAVAILABLE"));
      if (input.body?.length) outgoing.write(input.body);
      outgoing.end();
    });
    return true;
  }

  const handler = async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return handle({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks)
    }, (status, headers, body) => {
      response.writeHead(status, headers);
      response.end(body);
    });
  };
  handler.testRequest = async (input) => {
    const result = { handled: true, statusCode: 0, headers: {}, body: "" };
    result.handled = await handle(input, (status, headers, body) => {
      result.statusCode = status;
      result.headers = headers;
      result.body = Buffer.isBuffer(body) ? body.toString("utf8") : body;
    });
    return result;
  };
  return handler;
}
```

- [ ] **Step 4: Run proxy tests and fix only contract failures**

Run: `cd admin-web; node --test server/proxy-handler.test.mjs`  
Expected: all proxy tests PASS; no secret values appear in failure bodies.

- [ ] **Step 5: Review the scoped diff without staging**

Run: `git diff --check -- admin-web/server/proxy-handler.mjs admin-web/server/proxy-handler.test.mjs`  
Expected: exit code 0.

---

### Task 4: Production Server, Security Headers, and Graceful Shutdown

**Files:**
- Create: `admin-web/server/server.mjs`
- Create: `admin-web/server/server.test.mjs`
- Create: `admin-web/server/index.mjs`

**Interfaces:**
- Consumes: `loadGatewayConfig`, `createStaticHandler`, and `createProxyHandler`.
- Produces: `createAdminWebServer(config, dependencies)` and the `node server/index.mjs` entrypoint.

- [ ] **Step 1: Write a failing integration test for health, SPA route, API non-fallback, and security headers**

```js
// admin-web/server/server.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAdminWebServer } from "./server.mjs";

test("serves health and SPA with security headers without treating API errors as HTML", async (t) => {
  const distDir = await mkdtemp(join(tmpdir(), "admin-web-server-"));
  await writeFile(join(distDir, "index.html"), "<!doctype html><div id=app></div>");
  const server = createAdminWebServer({
    distDir,
    publicOrigin: "https://public.example",
    upstream: new URL("https://cloud.example"),
    actionSecret: "s".repeat(32),
    upstreamTimeoutMs: 55000
  }, {
    proxyHandler: async (_request, response) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end('{"ok":false}');
      return true;
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  const route = await fetch(`http://127.0.0.1:${port}/orders/order-1`);
  assert.match(await route.text(), /id=app/);
  const api = await fetch(`http://127.0.0.1:${port}/api/admin/v1/dashboard`);
  assert.equal(api.status, 502);
  assert.match(api.headers.get("content-type"), /application\/json/);
});
```

- [ ] **Step 2: Run the integration test to verify failure**

Run: `cd admin-web; node --test server/server.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the composable server**

```js
// admin-web/server/server.mjs
import { createServer } from "node:http";
import { createProxyHandler } from "./proxy-handler.mjs";
import { createStaticHandler } from "./static-handler.mjs";

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

export function createAdminWebServer(config, dependencies = {}) {
  const staticHandler = dependencies.staticHandler || createStaticHandler(config);
  const proxyHandler = dependencies.proxyHandler || createProxyHandler(config);
  return createServer(async (request, response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    try {
      if (await proxyHandler(request, response)) return;
      if (await staticHandler(request, response)) return;
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end('{"ok":false,"code":"ROUTE_NOT_FOUND"}');
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end('{"ok":false,"code":"GATEWAY_INTERNAL_ERROR"}');
    }
  });
}
```

```js
// admin-web/server/index.mjs
import { loadGatewayConfig } from "./config.mjs";
import { createAdminWebServer } from "./server.mjs";

const config = loadGatewayConfig();
const server = createAdminWebServer(config);
server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`admin-web gateway listening on ${config.port}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
```

- [ ] **Step 4: Run all gateway tests**

Run: `cd admin-web; npm run test:gateway`  
Expected: configuration, static, proxy, and server tests all PASS.

- [ ] **Step 5: Review the scoped diff without staging**

Run: `git diff --check -- admin-web/server admin-web/package.json`  
Expected: exit code 0.

---

### Task 5: Multi-Stage Image and ZSpace Compose Package

**Files:**
- Create: `admin-web/Dockerfile`
- Create: `admin-web/.dockerignore`
- Create: `admin-web/docker-compose.zspace.yml`
- Create: `admin-web/zspace.env.example`

**Interfaces:**
- Consumes: verified source tree, public `.env.test`, NAS public origin, CloudBase target, and a host secret file.
- Produces: a non-root container listening on port `8080` with `/healthz`.

- [ ] **Step 1: Add a multi-stage Dockerfile that builds only real mode**

```dockerfile
# admin-web/Dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run test:gateway && npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=8080 ADMIN_WEB_DIST_DIR=/app/dist
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server/index.mjs"]
```

- [ ] **Step 2: Exclude all local and secret-bearing inputs**

```dockerignore
# admin-web/.dockerignore
.git
.env
.env.*.local
node_modules
dist
coverage
playwright-report
test-results
.tooling
*.log
secrets
docker-compose*.local.yml
```

- [ ] **Step 3: Add the ZSpace Compose template and public env example**

```yaml
# admin-web/docker-compose.zspace.yml
services:
  admin-web:
    build:
      context: .
      dockerfile: Dockerfile
    image: beauty-wholesale-admin-web:2026-07-23
    container_name: beauty-wholesale-admin-web
    restart: unless-stopped
    ports:
      - "18080:8080"
    environment:
      NODE_ENV: production
      PORT: "8080"
      ADMIN_WEB_DIST_DIR: /app/dist
      ADMIN_WEB_PUBLIC_ORIGIN: ${ADMIN_WEB_PUBLIC_ORIGIN}
      ADMIN_WEB_BFF_TARGET: ${ADMIN_WEB_BFF_TARGET}
      ADMIN_WEB_ACTION_SECRET_FILE: /run/secrets/admin_web_action_secret
      ADMIN_WEB_UPSTREAM_TIMEOUT_MS: "55000"
    volumes:
      - ./secrets/admin_web_action_secret:/run/secrets/admin_web_action_secret:ro
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

```dotenv
# admin-web/zspace.env.example
# First boot may temporarily use https://bootstrap.invalid until ZSpace creates the final URL.
ADMIN_WEB_PUBLIC_ORIGIN=https://bootstrap.invalid
ADMIN_WEB_BFF_TARGET=https://cloud1-d7g4mbc5r2fac4a77-1440838049.ap-shanghai.app.tcloudbase.com
```

- [ ] **Step 4: Validate Compose interpolation without creating a real secret**

Run:

```powershell
cd admin-web
$env:ADMIN_WEB_PUBLIC_ORIGIN = "https://bootstrap.invalid"
$env:ADMIN_WEB_BFF_TARGET = "https://cloud1-d7g4mbc5r2fac4a77-1440838049.ap-shanghai.app.tcloudbase.com"
docker compose -f docker-compose.zspace.yml config
```

Expected: valid Compose output; the output contains the two public values and a secret file path, but no action-secret value.

- [ ] **Step 5: Build the image and scan its history and filesystem**

Run:

```powershell
docker build -t beauty-wholesale-admin-web:local admin-web
docker history --no-trunc beauty-wholesale-admin-web:local
docker run --rm --entrypoint sh beauty-wholesale-admin-web:local -c "find /app -maxdepth 3 -type f -print"
```

Expected: build PASS; runtime image contains only `dist/` and `server/`; no `.env`, tests, source tree, `node_modules`, Windows private path, or action-secret value.

- [ ] **Step 6: Review the scoped diff without staging**

Run: `git diff --check -- admin-web/Dockerfile admin-web/.dockerignore admin-web/docker-compose.zspace.yml admin-web/zspace.env.example`  
Expected: exit code 0.

---

### Task 6: Deployment Documentation and Full Local Regression

**Files:**
- Modify: `admin-web/README.md`

**Interfaces:**
- Consumes: completed gateway and Compose contract.
- Produces: exact ZSpace GUI, update, rollback, and acceptance instructions with no private values.

- [ ] **Step 1: Add a ZSpace section covering directory layout and bootstrap origin**

```markdown
## 极空间部署

将 `admin-web/` 上传到极空间受限目录，并在同级创建不提交 Git 的文件：

`secrets/admin_web_action_secret`

文件内容只包含测试环境 action secret。首次启动可将
`ADMIN_WEB_PUBLIC_ORIGIN` 临时设为 `https://bootstrap.invalid`，仅用于让容器
健康启动并创建极空间远程访问；取得最终 HTTPS 地址后必须立即替换并重建容器。

Compose 项目使用 `docker-compose.zspace.yml`，宿主端口默认为 `18080`，
重启策略为 `unless-stopped`。不要将 secret 填入 Compose 环境变量或截图。
```

- [ ] **Step 2: Document the exact deployment and rollback sequence**

Append the following exact operational sequence:

```markdown
### 部署顺序

1. 将已验证的 `admin-web/` 上传到极空间中仅管理员可写的目录。
2. 在项目目录创建 `secrets/admin_web_action_secret`；不要截图、不要写入 Compose。
3. 在极空间 Docker 的 Compose 项目中导入 `docker-compose.zspace.yml`。
4. 首次以 `ADMIN_WEB_PUBLIC_ORIGIN=https://bootstrap.invalid` 启动，只验收容器为 `healthy`。
5. 把宿主端口 `18080` 添加为极空间远程访问网页服务。
6. 记录极空间返回的完整 HTTPS 地址，并提取 `scheme + host + 可选端口` 作为 `ZSPACE_PUBLIC_ORIGIN`。
7. 如果远程入口不是映射到站点根路径，停止部署并修订 base-path 设计，不修改 CloudBase。
8. 用 `ZSPACE_PUBLIC_ORIGIN` 替换 bootstrap origin，重新创建容器。
9. 取得用户明确确认后，才把 `ZSPACE_PUBLIC_ORIGIN` 追加到两个测试云函数的 allowlist。
10. 只做外网登录和代表性真实读取验收，不用业务写操作证明连通性。

### 回滚

把 Compose 镜像标签切回上一版并重新创建容器。容器回滚不修改数据库；
只有远程地址确认废弃后，才从 `adminWebApi`、`adminWebAuth` 的测试 allowlist
删除对应 origin。
```

- [ ] **Step 3: Run the complete local web verification**

Run:

```powershell
cd admin-web
npm run typecheck
npm run lint
npm run test
npm run build
```

Expected: every command exits 0; real build scan passes; report the actual test count rather than copying an older count.

- [ ] **Step 4: Scan changed text files for secret names and private values**

Run:

```powershell
rg -n "demo-pass|ADMIN_WEB_TOKEN_PEPPER|ADMIN_WEB_PASSWORD_PEPPER|SYNC_CURSOR_SECRET" `
  admin-web/server admin-web/Dockerfile admin-web/docker-compose.zspace.yml admin-web/zspace.env.example admin-web/README.md
```

Expected: no credential values; only intentional configuration names allowed by the design appear.

- [ ] **Step 5: Review all deployment diffs without staging**

Run:

```powershell
git diff --check -- admin-web
git status --short
```

Expected: no whitespace errors; unrelated working-tree changes remain preserved and are called out separately.

---

### Task 7: ZSpace Installation and HTTPS Remote Entry

**Files:**
- NAS state only; no repository file must receive a real secret.

**Interfaces:**
- Consumes: verified deployment directory, current ZSpace administrator session, and the private test action secret.
- Produces: healthy container, LAN port `18080`, and one final ZSpace HTTPS public origin.

- [ ] **Step 1: Ask the user to open and sign in to the ZSpace Web/PC administration interface**

Expected: the user confirms the Docker page is visible. Do not ask the user to paste the action secret into chat.

- [ ] **Step 2: Load the browser-control skill before interacting with the ZSpace UI**

Read `chrome:control-chrome` if using the user's logged-in Chrome session. Use visual control only after the skill is loaded.

- [ ] **Step 3: Create the Compose project without exposing private fields in commentary**

Set the public variables and read-only secret file mount. Use `https://bootstrap.invalid` only for first boot.

Expected: container state `healthy`; `http://NAS_LAN_IP:18080/healthz` returns `{"ok":true}` where `NAS_LAN_IP` is read from the current ZSpace network page rather than guessed.

- [ ] **Step 4: Create the ZSpace remote-access entry for host port 18080**

Expected: ZSpace returns an HTTPS webpage URL. Record only its exact origin for configuration; do not infer or invent a host.

- [ ] **Step 5: Replace bootstrap origin with the exact ZSpace origin and recreate the container**

Expected: container returns to `healthy`; external login page loads over HTTPS with no mixed-content error.

- [ ] **Step 6: Stop at the CloudBase change gate**

Report the exact non-secret origin and ask:

`是否确认把 ZSPACE_PUBLIC_ORIGIN（上一步显示的精确 HTTPS origin）追加到测试环境 adminWebApi 和 adminWebAuth 的 ADMIN_WEB_ALLOWED_ORIGINS，并上传这两个云函数配置？`

Do not continue until the user explicitly confirms.

---

### Task 8: Test CloudBase Origin Update and End-to-End Acceptance

**Files:**
- CloudBase test configuration for `adminWebApi` and `adminWebAuth`.
- No production configuration.

**Interfaces:**
- Consumes: explicit user confirmation and the exact ZSpace HTTPS origin.
- Produces: matching origin allowlists on both functions and a verified external real-data session.

- [ ] **Step 1: Load the WeChat cloud-function upload skill**

Read `upload-new-wechat-cloudfunctions/SKILL.md` completely. Follow its backup, preflight, dry-run, and upload ledger requirements.

- [ ] **Step 2: Back up the deployed test configuration and compare both functions**

Capture the current non-secret configuration keys and exact current allowlist. Never print peppers, tokens, action secret, bootstrap secret, cursor secret, cleanup secret, or password.

Expected: backup location recorded; both current origins are known; no production environment selected.

- [ ] **Step 3: Prepare the exact allowlist**

Keep the current local origin and append the ZSpace origin:

```text
http://127.0.0.1:4173,ZSPACE_PUBLIC_ORIGIN
```

Expected: no wildcard, duplicate, path, query, hash, or trailing slash ambiguity.

- [ ] **Step 4: Run the required dry run**

Target functions in A–Z order:

```text
adminWebApi
adminWebAuth
```

Expected: dry run reports only the two explicitly authorized test functions/configurations and `uploadPerformed=false`.

- [ ] **Step 5: Upload only after the dry run matches the authorized scope**

Expected: both uploads/config updates succeed; record an exact uploaded-versus-not-uploaded ledger. Do not publish the mini-program.

- [ ] **Step 6: Verify external authentication and representative real reads**

Using the ZSpace HTTPS URL:

1. Log in with the existing test administrator.
2. Verify dashboard, product, order, payment, and account reads.
3. Verify a restricted role still receives 403 or projected fields.
4. Verify refresh cookie is `Secure` and `HttpOnly`.
5. Verify `/api/admin/v1/sync/events` resumes polling without exposing event payload secrets.
6. Do not execute business mutations merely to prove connectivity.

Expected: real test data appears, no Mock fallback, no `ORIGIN_NOT_ALLOWED`, CORS, mixed-content, cookie, or CSP failure.

- [ ] **Step 7: Verify restart recovery**

Restart the container from ZSpace and wait for `healthy`, then reload the external URL.

Expected: the service recovers without Windows `4173`; login and representative reads still work.

- [ ] **Step 8: Produce the final delivery ledger**

Report:

- Local files changed.
- Actual test/typecheck/lint/build/container results.
- ZSpace container name, image tag, health status, and external URL.
- Cloud functions/configuration updated, in A–Z order.
- Explicit statement that production and mini-program publication were untouched.
- Remaining risks, including ZSpace URL stability and non-guaranteed sync latency.
