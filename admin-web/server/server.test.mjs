import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startAdminWebGateway } from "./index.mjs";
import { createProxyHandler } from "./proxy-handler.mjs";
import { createAdminWebServer } from "./server.mjs";

const ACTION_SECRET = "s".repeat(32);
const TEST_BFF_ORIGIN = "https://cloud1-d7g4mbc5r2fac4a77-1440838049.ap-shanghai.app.tcloudbase.com";

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function fixture() {
  const distDir = await mkdtemp(join(tmpdir(), "admin-web-server-"));
  await mkdir(join(distDir, "assets"));
  await writeFile(join(distDir, "index.html"), "<!doctype html><div id=app></div>");
  await writeFile(join(distDir, "assets", "app.js"), "console.log('ok')");
  return distDir;
}

function config(distDir, upstream = new URL("https://upstream.invalid")) {
  return {
    actionSecret: ACTION_SECRET,
    distDir,
    publicOrigin: "https://admin.example",
    upstream,
    upstreamTimeoutMs: 500
  };
}

function request(server, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const client = httpRequest({
      host: "127.0.0.1",
      method,
      path,
      port: server.address().port
    }, (response) => {
      const chunks = [];
      let aborted = false;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve({
          aborted,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers,
          statusCode: response.statusCode
        });
      };
      response.on("aborted", () => {
        aborted = true;
      });
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", settle);
      response.on("close", settle);
      response.on("error", (error) => {
        if (error.code === "ECONNRESET") {
          aborted = true;
          settle();
          return;
        }
        reject(error);
      });
    });
    client.on("error", reject);
    client.end();
  });
}

function assertSecurityHeaders(headers) {
  const csp = headers["content-security-policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /https?:|unsafe-eval|\*/);
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
}

function gatewayEnvironment(secretFile, overrides = {}) {
  return Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    WINDIR: process.env.WINDIR,
    ADMIN_WEB_ACTION_SECRET_FILE: secretFile,
    ADMIN_WEB_BFF_TARGET: TEST_BFF_ORIGIN,
    ADMIN_WEB_PUBLIC_ORIGIN: "https://admin.example",
    PORT: "8080",
    ...overrides
  }).filter(([, value]) => value !== undefined));
}

function runEntrypoint(env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./index.mjs", import.meta.url))], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  return {
    child,
    completed: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stderr, stdout }));
    })
  };
}

test("serves health and SPA routes with a local-only CSP", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { force: true, recursive: true }));
  const server = await listen(createAdminWebServer(config(distDir)));
  t.after(() => close(server));

  const health = await request(server, "/healthz");
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true });
  assertSecurityHeaders(health.headers);

  const route = await request(server, "/orders/order-1");
  assert.equal(route.statusCode, 200);
  assert.match(route.headers["content-type"], /^text\/html/);
  assert.match(route.body, /id=app/);
  assertSecurityHeaders(route.headers);
});

test("keeps API 502 and 404 responses out of the SPA and rejects unsafe upstream security headers", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { force: true, recursive: true }));
  const upstream = await listen(createServer((incoming, response) => {
    response.setHeader("content-security-policy", "default-src * 'unsafe-eval'");
    response.setHeader("x-frame-options", "ALLOWALL");
    if (incoming.url.endsWith("/missing")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"ok":false,"code":"UPSTREAM_NOT_FOUND"}');
      return;
    }
    response.writeHead(502, { "content-type": "text/html" });
    response.end("<html>private platform error</html>");
  }));
  t.after(() => close(upstream));

  const serverConfig = config(
    distDir,
    new URL(`http://127.0.0.1:${upstream.address().port}`)
  );
  const server = await listen(createAdminWebServer(serverConfig, {
    proxyHandler: createProxyHandler(serverConfig, httpRequest)
  }));
  t.after(() => close(server));

  const unavailable = await request(server, "/api/admin/v1/dashboard");
  assert.equal(unavailable.statusCode, 502);
  assert.match(unavailable.headers["content-type"], /^application\/json/);
  assert.doesNotMatch(unavailable.body, /html|private platform|id=app/i);
  assertSecurityHeaders(unavailable.headers);

  const missing = await request(server, "/api/admin/v1/missing");
  assert.equal(missing.statusCode, 404);
  assert.match(missing.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(missing.body), {
    ok: false,
    code: "UPSTREAM_NOT_FOUND"
  });
  assert.doesNotMatch(missing.body, /id=app/);
  assertSecurityHeaders(missing.headers);
});

test("never sends an API request to the static handler when the proxy declines it", async (t) => {
  let staticCalls = 0;
  const server = await listen(createAdminWebServer(config("unused"), {
    proxyHandler: async () => false,
    staticHandler: async (_request, response) => {
      staticCalls += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<div id=app></div>");
      return true;
    }
  }));
  t.after(() => close(server));

  const response = await request(server, "/api/admin/v1/unhandled");
  assert.equal(response.statusCode, 404);
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "ROUTE_NOT_FOUND"
  });
  assert.equal(staticCalls, 0);
  assertSecurityHeaders(response.headers);
});

test("preserves static 404 semantics instead of turning missing assets into API errors", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { force: true, recursive: true }));
  const server = await listen(createAdminWebServer(config(distDir)));
  t.after(() => close(server));

  const missing = await request(server, "/assets/missing.js");
  assert.equal(missing.statusCode, 404);
  assert.match(missing.headers["content-type"], /^text\/plain/);
  assert.equal(missing.body, "Not Found");
  assertSecurityHeaders(missing.headers);
});

test("returns a fixed detail-free JSON 500 when a handler throws before headers", async (t) => {
  const server = await listen(createAdminWebServer(config("unused"), {
    proxyHandler: async () => {
      throw new Error(`private path and ${ACTION_SECRET}`);
    },
    staticHandler: async () => false
  }));
  t.after(() => close(server));

  const response = await request(server, "/api/admin/v1/dashboard");
  assert.equal(response.statusCode, 500);
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "GATEWAY_INTERNAL_ERROR"
  });
  assert.doesNotMatch(response.body, /private|ssssssss/);
  assertSecurityHeaders(response.headers);
});

test("destroys a response safely when a streaming handler throws after headers", async (t) => {
  const server = await listen(createAdminWebServer(config("unused"), {
    proxyHandler: async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"partial":true');
      throw new Error("late streaming failure");
    },
    staticHandler: async () => false
  }));
  t.after(() => close(server));

  const response = await request(server, "/api/admin/v1/stream");
  assert.equal(response.statusCode, 200);
  assert.equal(response.aborted, true);
  assert.equal(response.body, '{"partial":true');
  assert.doesNotMatch(response.body, /GATEWAY_INTERNAL_ERROR/);
  assertSecurityHeaders(response.headers);
});

test("can be closed cleanly after serving requests", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { force: true, recursive: true }));
  const server = await listen(createAdminWebServer(config(distDir)));
  const response = await request(server, "/healthz");
  assert.equal(response.statusCode, 200);
  await close(server);
  assert.equal(server.listening, false);
});

test("entrypoint exits nonzero on configuration failure without printing the secret", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "admin-web-entry-config-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const secret = `TOP_SECRET_${"x".repeat(32)}`;
  const secretFile = join(directory, "action-secret");
  await writeFile(secretFile, secret);

  const { completed } = runEntrypoint(gatewayEnvironment(secretFile, {
    PORT: "not-a-port"
  }));
  const result = await completed;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /configuration/i);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.doesNotMatch(result.stderr, /TOP_SECRET|action-secret/i);
});

test("entrypoint exits nonzero on listen errors without printing the secret", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "admin-web-entry-listen-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const secret = `LISTEN_SECRET_${"x".repeat(32)}`;
  const secretFile = join(directory, "action-secret");
  await writeFile(secretFile, secret);
  const occupied = await listen(
    createServer((_request, response) => response.end()),
    "0.0.0.0"
  );
  t.after(() => close(occupied));

  const { completed } = runEntrypoint(gatewayEnvironment(secretFile, {
    PORT: String(occupied.address().port)
  }));
  const result = await completed;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /listen/i);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.doesNotMatch(result.stderr, /LISTEN_SECRET|action-secret/i);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} stops accepting work and bounds shutdown for an active response`, async (t) => {
    const runtime = new EventEmitter();
    runtime.exitCode = undefined;
    runtime.stderr = { write() {} };
    runtime.stdout = { write() {} };
    const activeServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    });
    t.after(() => close(activeServer));
    startAdminWebGateway(
      { port: 0 },
      {
        host: "127.0.0.1",
        runtime,
        server: activeServer,
        shutdownTimeoutMs: 30
      }
    );
    await once(activeServer, "listening");

    let client;
    const responseStarted = new Promise((resolve, reject) => {
      client = httpRequest({
        host: "127.0.0.1",
        path: "/",
        port: activeServer.address().port
      }, (response) => {
        response.on("error", () => {});
        response.once("data", resolve);
        response.resume();
      });
      client.on("error", reject);
      client.end();
    });
    t.after(() => client.destroy());
    await responseStarted;

    const closed = once(activeServer, "close");
    runtime.emit(signal);
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`${signal} shutdown remained open`)),
        500
      ))
    ]);
    assert.equal(activeServer.listening, false);
    assert.equal(runtime.exitCode, 0);
    assert.equal(runtime.listenerCount("SIGINT"), 0);
    assert.equal(runtime.listenerCount("SIGTERM"), 0);
  });
}
