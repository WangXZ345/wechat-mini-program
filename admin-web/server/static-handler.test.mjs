import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStaticHandler } from "./static-handler.mjs";

async function fixture({ withIndex = true } = {}) {
  const distDir = await mkdtemp(join(tmpdir(), "admin-web-static-"));
  await mkdir(join(distDir, "assets"));
  if (withIndex) await writeFile(join(distDir, "index.html"), "<!doctype html><div id=app></div>");
  await writeFile(join(distDir, "assets", "app.js"), "console.log('ok')");
  return distDir;
}

async function request(server, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const client = httpRequest({
      host: "127.0.0.1",
      method,
      path,
      port: server.address().port
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        statusCode: response.statusCode
      }));
    });
    client.on("error", reject);
    client.end();
  });
}

async function withServer(distDir, run) {
  const handler = createStaticHandler({ distDir });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end("API handled elsewhere");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("health does not read business data", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { force: true, recursive: true }));
  await withServer(distDir, async (server) => {
    const response = await request(server, "/healthz");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true });
    assert.equal(response.headers["cache-control"], "no-store");
  });
});

test("assets are immutable and routes fall back to uncached index", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { force: true, recursive: true }));
  await withServer(distDir, async (server) => {
    const asset = await request(server, "/assets/app.js?version=1");
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers["cache-control"], /immutable/);
    assert.match(asset.headers["content-type"], /^text\/javascript/);
    assert.equal(asset.body, "console.log('ok')");

    const route = await request(server, "/orders/order-1");
    assert.equal(route.statusCode, 200);
    assert.equal(route.headers["cache-control"], "no-store");
    assert.match(route.headers["content-type"], /^text\/html/);
  });
});

test("API paths are left for the API handler", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { force: true, recursive: true }));
  const handler = createStaticHandler({ distDir });
  const server = createServer(async (req, res) => {
    assert.equal(await handler(req, res), false);
    res.writeHead(204).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(server, "/api/admin/v1/orders");
    assert.equal(response.statusCode, 204);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("encoded traversal and malformed paths are rejected without SPA fallback", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { force: true, recursive: true }));
  await withServer(distDir, async (server) => {
    for (const path of ["/%2e%2e/package.json", "/assets/%2e%2e%5cpackage.json", "/%E0%A4%A"]) {
      const response = await request(server, path);
      assert.equal(response.statusCode, 400, path);
      assert.equal(response.body, "Bad Request");
    }
  });
});

test("HEAD returns static headers without a response body", async (t) => {
  const distDir = await fixture();
  t.after(() => rm(distDir, { force: true, recursive: true }));
  await withServer(distDir, async (server) => {
    const response = await request(server, "/assets/app.js", "HEAD");
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["cache-control"], /immutable/);
    assert.equal(response.body, "");
  });
});

test("a missing index responds safely instead of throwing", async (t) => {
  const distDir = await fixture({ withIndex: false });
  t.after(() => rm(distDir, { force: true, recursive: true }));
  await withServer(distDir, async (server) => {
    const response = await request(server, "/missing-route");
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, "Not Found");
  });
});
