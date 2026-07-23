import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Agent, createServer, request as httpRequest } from "node:http";
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

test("closes a slow chunked upload after returning a stable 413 without draining the remaining body", async (t) => {
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
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());

  let client;
  const clientClosed = new Promise((resolve) => {
    client = httpRequest({
      agent,
      headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
      host: "127.0.0.1",
      method: "POST",
      path: "/api/admin/v1/orders/review",
      port: gateway.address().port
    });
    client.once("close", resolve);
  });
  t.after(() => client.destroy());
  const responsePromise = new Promise((resolve, reject) => {
    client.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        statusCode: response.statusCode
      }));
    });
    client.on("error", reject);
  });
  client.write(Buffer.alloc(12, "a"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  client.write(Buffer.alloc(12, "b"));

  const response = await responsePromise;
  assert.equal(response.statusCode, 413);
  assert.equal(JSON.parse(response.body).code, "BFF_REQUEST_TOO_LARGE");
  assert.equal(response.headers.connection, "close");
  await Promise.race([
    clientClosed,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("oversized upload connection remained open")),
      300
    ))
  ]);
  assert.equal(client.destroyed, true);
  assert.equal(completedUpstreamRequests, 0);
});

test("closes an unfinished browser upload when upstream responds before request end", async (t) => {
  const upstream = await listen(createServer((incoming, response) => {
    incoming.once("data", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());

  let client;
  const clientClosed = new Promise((resolve) => {
    client = httpRequest({
      agent,
      headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
      host: "127.0.0.1",
      method: "POST",
      path: "/api/admin/v1/orders/review",
      port: gateway.address().port
    });
    client.once("close", resolve);
  });
  t.after(() => client.destroy());
  const responsePromise = new Promise((resolve, reject) => {
    client.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        statusCode: response.statusCode
      }));
    });
    client.on("error", reject);
  });
  client.write("partial upload");

  const response = await responsePromise;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '{"ok":true}');
  assert.equal(response.headers.connection, "close");
  await Promise.race([
    clientClosed,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("early upstream response left browser upload open")),
      300
    ))
  ]);
  assert.equal(client.destroyed, true);
});

test("keeps a normal completed request connection reusable", async (t) => {
  const upstream = await listen(createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());

  const sockets = [];
  const makeRequest = () => new Promise((resolve, reject) => {
    const client = httpRequest({
      agent,
      host: "127.0.0.1",
      path: "/api/admin/v1/dashboard",
      port: gateway.address().port
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response));
    });
    client.on("socket", (socket) => sockets.push(socket));
    client.on("error", reject);
    client.end();
  });

  const first = await makeRequest();
  const second = await makeRequest();
  assert.notEqual(first.headers.connection, "close");
  assert.notEqual(second.headers.connection, "close");
  assert.equal(sockets[0], sockets[1]);
});

test("locks the first upstream failure before aborted, error, and close can re-enter", async (t) => {
  let upstreamDestroyCalls = 0;
  const requestUpstream = (_options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {};
    outgoing.end = () => queueMicrotask(() => {
      const upstreamResponse = new EventEmitter();
      upstreamResponse.complete = false;
      upstreamResponse.headers = { "content-type": "application/json" };
      upstreamResponse.pause = () => {};
      upstreamResponse.resume = () => {};
      upstreamResponse.statusCode = 200;
      upstreamResponse.destroy = () => {
        upstreamDestroyCalls += 1;
        if (upstreamDestroyCalls === 1) {
          upstreamResponse.emit("error", new Error("reentrant error"));
          upstreamResponse.emit("close");
        }
      };
      callback(upstreamResponse);
      upstreamResponse.emit("aborted");
      upstreamResponse.emit("error", new Error("late error"));
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
  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).code, "BFF_UPSTREAM_UNAVAILABLE");
  assert.equal(upstreamDestroyCalls, 1);
});

test("replaces platform HTML and arbitrary 5xx JSON with a fixed safe envelope", async (t) => {
  const upstream = await listen(createServer((incoming, response) => {
    if (incoming.url.endsWith("/html")) {
      response.writeHead(500, { "content-type": "text/html", "set-cookie": "refresh=safe; HttpOnly; Secure" });
      response.end(`<html><pre>platform stack ${ACTION_SECRET}</pre></html>`);
      return;
    }
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({
      code: "ATTACKER_CONTROLLED",
      message: `secret detail ${ACTION_SECRET}`,
      nested: { token: ACTION_SECRET },
      stack: "private platform stack"
    }));
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  for (const [path, statusCode] of [
    ["/api/admin/v1/platform/html", 500],
    ["/api/admin/v1/platform/json", 502]
  ]) {
    const response = await request(gateway, { path });
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, statusCode);
    assert.deepEqual(body, {
      ok: false,
      code: "BFF_UPSTREAM_ERROR",
      message: "后台服务暂时不可用"
    });
    assert.match(response.headers["content-type"], /^application\/json/);
    assert.doesNotMatch(response.body, /ATTACKER|secret|stack|nested|ssssssss|<html>/i);
    if (path.endsWith("/html")) {
      assert.deepEqual(response.headers["set-cookie"], ["refresh=safe; HttpOnly; Secure"]);
    }
  }
});

test("projects only canonical top-level code and requestId from a BFF 501", async (t) => {
  const upstream = await listen(createServer((_incoming, response) => {
    response.writeHead(501, { "content-type": "application/json", "x-request-id": "header-request" });
    response.end(JSON.stringify({
      ok: false,
      code: "SERVICE_NOT_MIGRATED",
      message: `internal migration detail ${ACTION_SECRET}`,
      requestId: "request-501",
      serverTime: "private",
      error: { code: "SERVICE_NOT_MIGRATED", message: "nested secret" },
      meta: { requestId: "request-501", trace: "private" }
    }));
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  const response = await request(gateway, { path: "/api/admin/v1/settings/migrate" });
  assert.equal(response.statusCode, 501);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "SERVICE_NOT_MIGRATED",
    message: "后台服务暂时不可用",
    requestId: "request-501"
  });
  assert.equal(response.headers["x-request-id"], "header-request");
  assert.doesNotMatch(response.body, /internal|nested|serverTime|meta|error|ssssssss/);
});

test("bounds buffered upstream 5xx bodies before returning a generic error", async (t) => {
  const upstream = await listen(createServer((_incoming, response) => {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: false,
      code: "SERVICE_NOT_MIGRATED",
      message: "x".repeat(70 * 1024),
      requestId: "oversized-request"
    }));
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  const response = await request(gateway);
  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "BFF_UPSTREAM_ERROR",
    message: "后台服务暂时不可用"
  });
  assert.ok(Buffer.byteLength(response.body) < 1024);
});

test("proxies OPTIONS but rejects HEAD and TRACE locally without creating upstream requests", async (t) => {
  const upstreamRequests = [];
  const upstream = await listen(createServer((incoming, response) => {
    upstreamRequests.push({
      headers: incoming.headers,
      method: incoming.method
    });
    response.writeHead(204).end();
  }));
  t.after(() => close(upstream));
  const gateway = await startGateway(createProxyHandler(gatewayConfig(serverUrl(upstream)), httpRequest));
  t.after(() => close(gateway));

  const options = await request(gateway, { method: "OPTIONS" });
  assert.equal(options.statusCode, 204);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].method, "OPTIONS");
  assert.equal(upstreamRequests[0].headers["x-admin-action-secret"], ACTION_SECRET);

  const head = await request(gateway, { method: "HEAD" });
  assert.equal(head.statusCode, 405);
  assert.equal(head.headers.allow, "GET, POST, OPTIONS");
  assert.equal(head.body, "");

  const trace = await request(gateway, { method: "TRACE" });
  assert.equal(trace.statusCode, 405);
  assert.equal(trace.headers.allow, "GET, POST, OPTIONS");
  assert.equal(JSON.parse(trace.body).code, "BFF_METHOD_NOT_ALLOWED");
  assert.equal(upstreamRequests.length, 1);
});

test("resumes the upstream response after every downstream backpressure cycle", async () => {
  const upstreamChunks = ["first", "second", "third"];
  let pauseCalls = 0;
  let resumeCalls = 0;
  const requestUpstream = (_options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {};
    outgoing.setTimeout = () => {};
    outgoing.write = () => true;
    outgoing.end = () => queueMicrotask(() => {
      let index = 0;
      let paused = false;
      const upstreamResponse = new EventEmitter();
      upstreamResponse.complete = false;
      upstreamResponse.destroy = () => {};
      upstreamResponse.headers = { "content-type": "application/octet-stream" };
      upstreamResponse.statusCode = 200;
      const emitNext = () => {
        if (paused) return;
        if (index === upstreamChunks.length) {
          upstreamResponse.complete = true;
          upstreamResponse.emit("end");
          upstreamResponse.emit("close");
          return;
        }
        const chunk = upstreamChunks[index];
        index += 1;
        upstreamResponse.emit("data", Buffer.from(chunk));
      };
      upstreamResponse.pause = () => {
        pauseCalls += 1;
        paused = true;
      };
      upstreamResponse.resume = () => {
        resumeCalls += 1;
        paused = false;
        queueMicrotask(emitNext);
      };
      callback(upstreamResponse);
      queueMicrotask(emitNext);
    });
    return outgoing;
  };

  const incomingRequest = new EventEmitter();
  incomingRequest.destroyed = false;
  incomingRequest.headers = {};
  incomingRequest.method = "GET";
  incomingRequest.pause = () => {};
  incomingRequest.readableEnded = false;
  incomingRequest.resume = () => {};
  incomingRequest.url = "/api/admin/v1/dashboard";

  const responseChunks = [];
  const outgoingResponse = new EventEmitter();
  outgoingResponse.destroyed = false;
  outgoingResponse.headersSent = false;
  outgoingResponse.writableEnded = false;
  outgoingResponse.destroy = () => {
    outgoingResponse.destroyed = true;
    outgoingResponse.emit("close");
  };
  outgoingResponse.end = (chunk) => {
    if (chunk) responseChunks.push(Buffer.from(chunk));
    outgoingResponse.writableEnded = true;
    queueMicrotask(() => outgoingResponse.emit("finish"));
  };
  outgoingResponse.write = (chunk) => {
    responseChunks.push(Buffer.from(chunk));
    setImmediate(() => outgoingResponse.emit("drain"));
    return false;
  };
  outgoingResponse.writeHead = (statusCode, headers) => {
    outgoingResponse.headersSent = true;
    outgoingResponse.statusCode = statusCode;
    outgoingResponse.headers = headers;
  };

  const handler = createProxyHandler(
    gatewayConfig(new URL("https://upstream.invalid")),
    requestUpstream
  );
  const handled = handler(incomingRequest, outgoingResponse);
  incomingRequest.readableEnded = true;
  incomingRequest.emit("end");
  assert.equal(await handled, true);
  assert.equal(outgoingResponse.statusCode, 200);
  assert.equal(Buffer.concat(responseChunks).toString("utf8"), "firstsecondthird");
  assert.equal(pauseCalls, 3);
  assert.equal(resumeCalls, 3);
});

test("does not resume an unfinished upload from a stale drain after upstream completed early", async () => {
  let outgoing;
  let outgoingDestroyCalls = 0;
  let outgoingEndCalls = 0;
  let requestResumeCalls = 0;
  let responseDestroyCalls = 0;
  let responseEndCalls = 0;
  let responseFinish;
  const requestUpstream = (_options, callback) => {
    outgoing = new EventEmitter();
    outgoing.destroy = () => {
      outgoingDestroyCalls += 1;
      outgoing.emit("error", new Error("late outgoing error after early response"));
    };
    outgoing.end = () => {
      outgoingEndCalls += 1;
    };
    outgoing.setTimeout = () => {};
    outgoing.write = () => {
      queueMicrotask(() => {
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
        outgoing.emit("drain");
        responseFinish();
      });
      return false;
    };
    return outgoing;
  };

  const incomingRequest = new EventEmitter();
  incomingRequest.destroy = () => {
    incomingRequest.destroyed = true;
  };
  incomingRequest.destroyed = false;
  incomingRequest.headers = { "transfer-encoding": "chunked" };
  incomingRequest.method = "POST";
  incomingRequest.pause = () => {};
  incomingRequest.readableEnded = false;
  incomingRequest.resume = () => {
    requestResumeCalls += 1;
  };
  incomingRequest.url = "/api/admin/v1/orders/review";

  const outgoingResponse = new EventEmitter();
  outgoingResponse.destroyed = false;
  outgoingResponse.headersSent = false;
  outgoingResponse.writableEnded = false;
  outgoingResponse.destroy = () => {
    responseDestroyCalls += 1;
  };
  outgoingResponse.end = () => {
    responseEndCalls += 1;
    outgoingResponse.writableEnded = true;
  };
  outgoingResponse.write = () => true;
  outgoingResponse.writeHead = () => {
    outgoingResponse.headersSent = true;
  };
  responseFinish = () => outgoingResponse.emit("finish");

  const handler = createProxyHandler(
    gatewayConfig(new URL("https://upstream.invalid")),
    requestUpstream
  );
  const handled = handler(incomingRequest, outgoingResponse);
  incomingRequest.emit("data", Buffer.from("partial"));
  assert.equal(await handled, true);
  assert.equal(requestResumeCalls, 0);
  assert.equal(incomingRequest.destroyed, true);
  assert.equal(outgoingDestroyCalls, 1);
  assert.equal(outgoingEndCalls, 0);
  assert.equal(responseEndCalls, 1);
  assert.equal(responseDestroyCalls, 0);
});
