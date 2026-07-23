import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { createProxyHandler } from "./proxy-handler.mjs";

const ACTION_SECRET = "s".repeat(32);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
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

function serverUrl(server) {
  const address = server.address();
  return new URL(`http://127.0.0.1:${address.port}`);
}

function gatewayConfig(upstream, overrides = {}) {
  return {
    actionSecret: ACTION_SECRET,
    maxRequestBodyBytes: 1024 * 1024,
    publicOrigin: "https://admin.example",
    upstream,
    upstreamTimeoutMs: 500,
    ...overrides
  };
}

async function startGateway(handler) {
  return listen(createServer(async (request, response) => {
    try {
      if (!(await handler(request, response)) && !response.headersSent) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("gateway fallback");
      }
    } catch {
      if (!response.headersSent) response.writeHead(500).end("unexpected gateway failure");
      else response.destroy();
    }
  }));
}

function request(server, {
  body,
  headers = {},
  method = "GET",
  path = "/api/admin/v1"
} = {}) {
  return new Promise((resolve, reject) => {
    const client = httpRequest({
      headers,
      host: "127.0.0.1",
      method,
      path,
      port: server.address().port
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        statusCode: response.statusCode
      }));
    });
    client.on("error", reject);
    client.end(body);
  });
}

test("overwrites security headers, preserves the request allowlist, and streams safe response headers", async (t) => {
  let capturedOptions;
  let upstreamRequest;
  const upstream = await listen(createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    upstreamRequest = {
      body: Buffer.concat(chunks).toString("utf8"),
      headers: incoming.headers,
      method: incoming.method,
      url: incoming.url
    };
    response.writeHead(201, {
      "content-disposition": 'attachment; filename="orders.json"',
      "content-type": "application/json; charset=utf-8",
      "set-cookie": [
        "refresh=one; HttpOnly; Secure; SameSite=Strict",
        "session=two; HttpOnly; Secure; SameSite=Strict"
      ],
      "x-request-id": "upstream-request",
      "x-upstream-internal": "must-not-leak"
    });
    response.write('{"ok":');
    setImmediate(() => response.end("true}"));
  }));
  t.after(() => close(upstream));

  const requestUpstream = (options, callback) => {
    capturedOptions = { ...options, headers: { ...options.headers } };
    return httpRequest(options, callback);
  };
  const handler = createProxyHandler(gatewayConfig(serverUrl(upstream)), requestUpstream);
  assert.equal(handler.testRequest, undefined);
  const gateway = await startGateway(handler);
  t.after(() => close(gateway));

  const body = '{"orderId":"order-1"}';
  const response = await request(gateway, {
    body,
    headers: {
      accept: "application/json",
      authorization: "Bearer browser-token",
      connection: "keep-alive, x-hop",
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json",
      cookie: "refresh=browser-cookie",
      forwarded: "for=203.0.113.7",
      host: "evil.example",
      "idempotency-key": "order-review-0001",
      origin: "https://evil.example",
      "x-admin-action-secret": "browser-secret",
      "x-admin-csrf": "csrf-token",
      "x-forwarded-for": "203.0.113.7",
      "x-hop": "browser-hop"
    },
    method: "POST",
    path: "/api/admin/v1/orders/review?source=queue"
  });

  assert.equal(capturedOptions.headers.host, serverUrl(upstream).host);
  assert.equal(capturedOptions.headers.origin, "https://admin.example");
  assert.equal(capturedOptions.headers["x-admin-action-secret"], ACTION_SECRET);
  assert.equal(capturedOptions.headers.authorization, "Bearer browser-token");
  assert.equal(capturedOptions.headers.cookie, "refresh=browser-cookie");
  assert.equal(capturedOptions.headers["x-admin-csrf"], "csrf-token");
  assert.equal(capturedOptions.headers["idempotency-key"], "order-review-0001");
  assert.equal(capturedOptions.headers.connection, undefined);
  assert.equal(capturedOptions.headers.forwarded, undefined);
  assert.equal(capturedOptions.headers["x-forwarded-for"], undefined);
  assert.equal(capturedOptions.headers["x-hop"], undefined);
  assert.deepEqual(upstreamRequest, {
    body,
    headers: upstreamRequest.headers,
    method: "POST",
    url: "/api/admin/v1/orders/review?source=queue"
  });
  assert.equal(upstreamRequest.headers.host, serverUrl(upstream).host);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body, '{"ok":true}');
  assert.equal(response.headers["content-disposition"], 'attachment; filename="orders.json"');
  assert.deepEqual(response.headers["set-cookie"], [
    "refresh=one; HttpOnly; Secure; SameSite=Strict",
    "session=two; HttpOnly; Secure; SameSite=Strict"
  ]);
  assert.equal(response.headers["x-request-id"], "upstream-request");
  assert.equal(response.headers["x-upstream-internal"], undefined);
});

test("returns false for paths outside the exact API namespace without contacting upstream", async (t) => {
  let upstreamRequests = 0;
  const upstream = await listen(createServer((_request, response) => {
    upstreamRequests += 1;
    response.end("unexpected");
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  for (const path of ["/other", "/api/admin/v10", "/api/admin/v1evil"]) {
    const response = await request(gateway, { path });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, "gateway fallback");
  }
  assert.equal(upstreamRequests, 0);
});

test("rejects malformed or encoded traversal inside the API namespace without contacting upstream", async (t) => {
  let upstreamRequests = 0;
  const upstream = await listen(createServer((_request, response) => {
    upstreamRequests += 1;
    response.end("unexpected");
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  for (const path of [
    "/api/admin/v1/%",
    "/api/admin/v1/%00secret",
    "/api/admin/v1/%252e%252e/secret",
    "/api/admin/v1/%2e%2e%2fsecret"
  ]) {
    const response = await request(gateway, { path });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).code, "BFF_INVALID_PATH");
  }
  assert.equal(upstreamRequests, 0);
});

test("converts an upstream request error to a detail-free JSON 502", async (t) => {
  const requestUpstream = () => {
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {};
    outgoing.end = () => queueMicrotask(() => {
      outgoing.emit("error", new Error(`secret upstream detail ${ACTION_SECRET}`));
    });
    outgoing.setTimeout = () => {};
    outgoing.write = () => true;
    return outgoing;
  };
  const handler = createProxyHandler(
    gatewayConfig(new URL("https://upstream.invalid")),
    requestUpstream
  );
  const gateway = await startGateway(handler);
  t.after(() => close(gateway));

  const response = await request(gateway, { path: "/api/admin/v1/dashboard" });
  assert.equal(response.statusCode, 502);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.equal(JSON.parse(response.body).code, "BFF_UPSTREAM_UNAVAILABLE");
  assert.doesNotMatch(response.body, /secret upstream detail|ssssssss|upstream\.invalid/);
});

test("rejects a declared oversized request before opening an upstream request", async (t) => {
  let upstreamRequests = 0;
  const upstream = await listen(createServer((_request, response) => {
    upstreamRequests += 1;
    response.end("unexpected");
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(
    gatewayConfig(serverUrl(upstream), { maxRequestBodyBytes: 16 }),
    httpRequest
  ));
  t.after(() => close(gateway));

  const response = await request(gateway, {
    body: Buffer.alloc(17, "x"),
    headers: { "content-length": "17", "content-type": "application/json" },
    method: "POST"
  });
  assert.equal(response.statusCode, 413);
  assert.equal(JSON.parse(response.body).code, "BFF_REQUEST_TOO_LARGE");
  assert.equal(upstreamRequests, 0);
});

test("stops a chunked request and its upstream stream when the body limit is crossed", async (t) => {
  let completedUpstreamRequests = 0;
  const upstream = await listen(createServer((incoming, response) => {
    incoming.on("error", () => {});
    incoming.on("end", () => {
      completedUpstreamRequests += 1;
      response.end("unexpected");
    });
    incoming.resume();
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(
    gatewayConfig(serverUrl(upstream), { maxRequestBodyBytes: 16 }),
    httpRequest
  ));
  t.after(() => close(gateway));

  const response = await request(gateway, {
    body: Buffer.alloc(17, "x"),
    headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
    method: "POST"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.statusCode, 413);
  assert.equal(JSON.parse(response.body).code, "BFF_REQUEST_TOO_LARGE");
  assert.equal(completedUpstreamRequests, 0);
});

test("resumes a streamed request after every upstream backpressure cycle", async (t) => {
  const forwarded = [];
  const requestUpstream = (_options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {};
    outgoing.end = () => queueMicrotask(() => {
      const upstreamResponse = new EventEmitter();
      upstreamResponse.complete = true;
      upstreamResponse.destroy = () => {};
      upstreamResponse.headers = { "content-type": "application/json" };
      upstreamResponse.pause = () => {};
      upstreamResponse.resume = () => {};
      upstreamResponse.statusCode = 200;
      callback(upstreamResponse);
      upstreamResponse.emit("data", Buffer.from('{"ok":true}'));
      upstreamResponse.emit("end");
      upstreamResponse.emit("close");
    });
    outgoing.setTimeout = () => {};
    outgoing.write = (chunk) => {
      forwarded.push(Buffer.from(chunk));
      setImmediate(() => outgoing.emit("drain"));
      return false;
    };
    return outgoing;
  };
  const gateway = await startGateway(createProxyHandler(
    gatewayConfig(new URL("https://upstream.invalid")),
    requestUpstream
  ));
  t.after(() => close(gateway));

  let client;
  const responsePromise = new Promise((resolve, reject) => {
    client = httpRequest({
      headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
      host: "127.0.0.1",
      method: "POST",
      path: "/api/admin/v1/orders/review",
      port: gateway.address().port
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        statusCode: response.statusCode
      }));
    });
    client.on("error", reject);
    client.write("first");
    setTimeout(() => client.write("second"), 10);
    setTimeout(() => client.end("third"), 20);
  });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      client.destroy();
      reject(new Error("proxy stalled after repeated upstream backpressure"));
    }, 300);
  });

  const response = await Promise.race([responsePromise, timeout]).finally(() => clearTimeout(timeoutId));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '{"ok":true}');
  assert.equal(Buffer.concat(forwarded).toString("utf8"), "firstsecondthird");
});

test("returns a detail-free JSON 504 when the upstream request times out", async (t) => {
  let destroyCalls = 0;
  const requestUpstream = () => {
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {
      destroyCalls += 1;
    };
    outgoing.end = () => {};
    outgoing.setTimeout = (_milliseconds, onTimeout) => setImmediate(onTimeout);
    outgoing.write = () => true;
    return outgoing;
  };
  const gateway = await startGateway(createProxyHandler(
    gatewayConfig(new URL("https://upstream.invalid"), { upstreamTimeoutMs: 25 }),
    requestUpstream
  ));
  t.after(() => close(gateway));

  const response = await request(gateway);
  assert.equal(response.statusCode, 504);
  assert.equal(JSON.parse(response.body).code, "BFF_UPSTREAM_TIMEOUT");
  assert.doesNotMatch(response.body, /upstream\.invalid|ssssssss/);
  assert.equal(destroyCalls, 1);
});

test("turns an upstream abort before the first body byte into a JSON 502", async (t) => {
  const upstream = await listen(createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "application/json", "x-upstream-internal": ACTION_SECRET });
    response.flushHeaders();
    setImmediate(() => response.destroy());
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  const response = await request(gateway);
  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).code, "BFF_UPSTREAM_UNAVAILABLE");
  assert.doesNotMatch(response.body, /ssssssss|x-upstream-internal/);
});

test("closes the downstream response instead of appending an error after headers were sent", async (t) => {
  const upstream = await listen(createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"partial":');
    setImmediate(() => response.destroy());
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  const observed = await new Promise((resolve, reject) => {
    const client = httpRequest({
      host: "127.0.0.1",
      path: "/api/admin/v1/dashboard",
      port: gateway.address().port
    }, (response) => {
      const chunks = [];
      let aborted = false;
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("aborted", () => {
        aborted = true;
      });
      response.on("error", () => {});
      response.on("close", () => resolve({
        aborted,
        body: Buffer.concat(chunks).toString("utf8"),
        statusCode: response.statusCode
      }));
    });
    client.on("error", reject);
    client.end();
  });
  assert.equal(observed.statusCode, 200);
  assert.equal(observed.aborted, true);
  assert.equal(observed.body, '{"partial":');
  assert.doesNotMatch(observed.body, /BFF_UPSTREAM_UNAVAILABLE/);
});

test("destroys the upstream request when the browser aborts its upload", async (t) => {
  let destroyCalls = 0;
  let signalWrite;
  const firstWrite = new Promise((resolve) => {
    signalWrite = resolve;
  });
  const requestUpstream = () => {
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {
      destroyCalls += 1;
    };
    outgoing.end = () => {};
    outgoing.setTimeout = () => {};
    outgoing.write = () => {
      signalWrite();
      return true;
    };
    return outgoing;
  };
  const gateway = await startGateway(createProxyHandler(
    gatewayConfig(new URL("https://upstream.invalid")),
    requestUpstream
  ));
  t.after(() => close(gateway));

  const client = httpRequest({
    headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
    host: "127.0.0.1",
    method: "POST",
    path: "/api/admin/v1/orders/review",
    port: gateway.address().port
  });
  client.on("error", () => {});
  client.write("partial upload");
  await firstWrite;
  client.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(destroyCalls, 1);
});

test("ignores a late request error after the upstream response ended successfully", async (t) => {
  const requestUpstream = (_options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {};
    outgoing.end = () => queueMicrotask(() => {
      const upstreamResponse = new EventEmitter();
      upstreamResponse.complete = true;
      upstreamResponse.destroy = () => {};
      upstreamResponse.headers = { "content-type": "application/json" };
      upstreamResponse.pause = () => {};
      upstreamResponse.resume = () => {};
      upstreamResponse.statusCode = 200;
      callback(upstreamResponse);
      upstreamResponse.emit("data", Buffer.from('{"ok":true}'));
      upstreamResponse.emit("end");
      outgoing.emit("error", new Error("late transport error"));
      upstreamResponse.emit("close");
    });
    outgoing.setTimeout = () => {};
    outgoing.write = () => true;
    return outgoing;
  };
  const gateway = await startGateway(createProxyHandler(
    gatewayConfig(new URL("https://upstream.invalid")),
    requestUpstream
  ));
  t.after(() => close(gateway));

  const response = await request(gateway);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '{"ok":true}');
});

test("forwards an upstream API 404 instead of returning control to the SPA fallback", async (t) => {
  const upstream = await listen(createServer((_incoming, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"ok":false,"code":"ROUTE_NOT_FOUND"}');
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  const response = await request(gateway, { path: "/api/admin/v1/unknown" });
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).code, "ROUTE_NOT_FOUND");
  assert.notEqual(response.body, "gateway fallback");
});

test("delivers the first upstream response chunk before the upstream response ends", async (t) => {
  let releaseUpstream;
  const released = new Promise((resolve) => {
    releaseUpstream = resolve;
  });
  const upstream = await listen(createServer(async (_incoming, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("first");
    await released;
    response.end("second");
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  let timeoutId;
  const response = await new Promise((resolve, reject) => {
    const client = httpRequest({
      host: "127.0.0.1",
      path: "/api/admin/v1/dashboard",
      port: gateway.address().port
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        if (chunks.length === 1) releaseUpstream();
      });
      incoming.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        statusCode: incoming.statusCode
      }));
    });
    client.on("error", reject);
    client.end();
    timeoutId = setTimeout(() => {
      client.destroy();
      releaseUpstream();
      reject(new Error("proxy buffered the upstream response until completion"));
    }, 300);
  }).finally(() => clearTimeout(timeoutId));

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "firstsecond");
});

test("uses a 1 MiB request limit when the loaded gateway config has no override", async (t) => {
  let completedUpstreamRequests = 0;
  const upstream = await listen(createServer((incoming, response) => {
    incoming.on("error", () => {});
    incoming.on("end", () => {
      completedUpstreamRequests += 1;
      response.end("unexpected");
    });
    incoming.resume();
  }));
  t.after(() => close(upstream));
  const config = gatewayConfig(serverUrl(upstream));
  delete config.maxRequestBodyBytes;
  const gateway = await startGateway(createProxyHandler(config, httpRequest));
  t.after(() => close(gateway));

  const response = await request(gateway, {
    body: Buffer.alloc(1024 * 1024 + 1, "x"),
    headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
    method: "POST"
  });
  assert.equal(response.statusCode, 413);
  assert.equal(JSON.parse(response.body).code, "BFF_REQUEST_TOO_LARGE");
  assert.equal(completedUpstreamRequests, 0);
});
