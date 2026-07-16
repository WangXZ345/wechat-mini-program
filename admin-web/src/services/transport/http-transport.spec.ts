import axios, { AxiosError, AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpBffTransport } from "./http-transport";

interface StubResult {
  status: number;
  data: unknown;
}

type StubHandler = (config: InternalAxiosRequestConfig) => StubResult | Promise<StubResult>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createClient(handler: StubHandler): AxiosInstance {
  return axios.create({
    adapter: async (config) => {
      const result = await handler(config);
      const response: AxiosResponse = {
        data: result.data,
        status: result.status,
        statusText: String(result.status),
        headers: new AxiosHeaders(),
        config
      };
      if (result.status >= 400) {
        throw new AxiosError("Request failed", AxiosError.ERR_BAD_REQUEST, config, undefined, response);
      }
      return response;
    }
  });
}

function header(config: InternalAxiosRequestConfig, name: string): string {
  return String(config.headers.get(name) || "");
}

function requestBody(config: InternalAxiosRequestConfig): Record<string, unknown> {
  return typeof config.data === "string" ? JSON.parse(config.data) as Record<string, unknown> : config.data as Record<string, unknown>;
}

function sessionEnvelope(accessToken: string, csrfToken: string) {
  return {
    ok: true,
    data: {
      accessToken,
      accessExpiresAt: "2026-07-11T12:00:00.000Z",
      csrfToken,
      sessionId: "session-1",
      profile: {
        id: "admin-1",
        name: "测试管理员",
        phoneMasked: "138****8000",
        role: "finance",
        roleName: "财务",
        permissions: ["payment:confirm"],
        status: "active"
      }
    }
  };
}

function failure(code: string, status = 401) {
  return { status, data: { ok: false, code, message: code } };
}

function validProductAnalytics(range: "7d" | "30d" | "90d" = "30d") {
  return {
    range,
    status: "available" as const,
    summary: [
      { key: "salesCount", label: "销量", value: 12, kind: "number" as const, change: null },
      { key: "averagePriceCents", label: "成交均价", value: null, kind: "money" as const, change: null }
    ],
    series: [
      {
        date: "2026-07-11",
        salesCount: 12,
        averagePriceCents: 0,
        quotePriceCents: null,
        inventoryChange: -2
      }
    ],
    ranking: [
      {
        id: "product-1",
        name: "测试商品",
        sku: "",
        salesCount: 12,
        averagePriceCents: null,
        currentPriceCents: 0,
        change: 0
      }
    ],
    updatedAt: "2026-07-11T12:00:00.000Z"
  };
}

function validOrderSummary(id = "order-1") {
  return {
    id,
    orderNo: `PO-${id}`,
    customerMasked: "张* / 138****8000",
    customerPhoneMasked: "138****8000",
    itemSummary: "精华等 2 件商品",
    itemCount: 2,
    totalQuantity: 3,
    status: "pending_admin",
    paymentStatus: "unpaid",
    deliveryStatus: "",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    version: 2
  };
}

function validShipmentSummary(id = "shipment-1") {
  return {
    id,
    shipmentNo: `SHP-${id}`,
    status: "pending_shipment",
    orderCount: 1,
    totalItemCount: 2,
    customerMasked: "张* 138****8000",
    carrier: "顺丰速运",
    trackingMasked: "SF*******789",
    addressConsistent: true,
    orderNosPreview: ["ORD-001"],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z",
    shippedAt: null,
    completedAt: null,
    version: 0
  };
}

function validShipmentDetail(id = "shipment-1") {
  return {
    shipment: {
      id,
      shipmentNo: `SHP-${id}`,
      status: "pending_shipment",
      version: 0,
      orderCount: 1,
      totalItemCount: 2,
      totalProductCount: 1,
      customerMasked: "张* 138****8000",
      shippingAddressMasked: {
        receiverName: "张*",
        receiverPhoneMasked: "138****8000",
        regionText: "上海市 浦东新区",
        detailAddressMasked: "演示路 ** 号",
        fullAddressMasked: "上海市 浦东新区 演示路 ** 号"
      },
      carrier: "顺丰速运",
      trackingMasked: "SF*******789",
      addressConsistent: true,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T01:00:00.000Z",
      shippedAt: null,
      completedAt: null,
      cancelledAt: null
    },
    orders: [],
    itemSummary: [],
    logs: [],
    logsHasMore: false,
    relatedDataStatus: "complete",
    warnings: []
  };
}

function validAccountSummary(id = "account-1") {
  return {
    id,
    customerMasked: "张* 138****8000",
    totalOrders: 3,
    receivableCents: 30_000,
    receivedCents: 10_000,
    unpaidAmountCents: 20_000,
    pendingConfirmAmountCents: 0,
    abnormalCount: 0,
    status: "unpaid",
    lastOrderAt: "2026-07-13T00:00:00.000Z",
    lastPaymentAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z"
  };
}

function validAccountDetail(id = "account-1") {
  return {
    account: validAccountSummary(id),
    orders: [{
      id: "order-1",
      orderNo: "DEMO-O-001",
      status: "approved",
      paymentStatus: "unpaid",
      totalAmountCents: 20_000,
      createdAt: "2026-07-13T00:00:00.000Z"
    }],
    logs: [{
      id: "log-1",
      changeType: "order_approved",
      beforeReceivableCents: 10_000,
      afterReceivableCents: 30_000,
      beforeReceivedCents: 10_000,
      afterReceivedCents: 10_000,
      beforeUnpaidCents: 0,
      afterUnpaidCents: 20_000,
      changeAmountCents: 20_000,
      orderNo: "DEMO-O-001",
      createdAt: "2026-07-13T00:00:00.000Z",
      summary: "订单审核通过，账款增加"
    }],
    ordersHasMore: false,
    logsHasMore: false,
    relatedDataStatus: "complete",
    warnings: []
  };
}

describe("HttpBffTransport session recovery", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("uses one refresh request for concurrent 401 responses", async () => {
    let initialRequests = 0;
    let refreshedRequests = 0;
    let refreshCalls = 0;
    let releaseInitialRequests!: () => void;
    const bothInitialRequests = new Promise<void>((resolve) => {
      releaseInitialRequests = resolve;
    });
    const client = createClient(async (config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/auth/refresh") {
        refreshCalls += 1;
        await bothInitialRequests;
        return { status: 200, data: sessionEnvelope("access-2", "csrf-2") };
      }
      if (config.method === "get") {
        if (header(config, "Authorization") === "Bearer access-1") {
          initialRequests += 1;
          if (initialRequests === 2) releaseInitialRequests();
          return failure("SESSION_EXPIRED");
        }
        if (header(config, "Authorization") === "Bearer access-2") {
          refreshedRequests += 1;
          return config.url === "/accounts"
            ? { status: 200, data: { ok: true, data: { items: [], pageSize: 20, hasMore: false, nextCursor: null } } }
            : config.url === "/payments"
              ? { status: 200, data: { ok: true, data: { items: [], pageSize: 20, hasMore: false, nextCursor: null } } }
              : { status: 200, data: { ok: true, data: { items: [], total: 0, page: 1, pageSize: 20 } } };
        }
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await Promise.all([
      transport.list("payments", { page: 1, pageSize: 20 }),
      transport.list("accounts", { page: 1, pageSize: 20 })
    ]);

    expect(initialRequests).toBe(2);
    expect(refreshedRequests).toBe(2);
    expect(refreshCalls).toBe(1);
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBe("csrf-2");
  });

  it("does not refresh again for a stale 401 that arrives after rotation", async () => {
    let refreshCalls = 0;
    let releaseDelayedResponse!: () => void;
    const newAccessObserved = new Promise<void>((resolve) => {
      releaseDelayedResponse = resolve;
    });
    const client = createClient(async (config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/auth/refresh") {
        refreshCalls += 1;
        return { status: 200, data: sessionEnvelope("access-2", "csrf-2") };
      }
      if (config.method === "get" && header(config, "Authorization") === "Bearer access-1") {
        if (config.url === "/accounts") await newAccessObserved;
        return failure("SESSION_EXPIRED");
      }
      if (config.method === "get" && header(config, "Authorization") === "Bearer access-2") {
        if (config.url === "/payments") releaseDelayedResponse();
        return config.url === "/accounts"
          ? { status: 200, data: { ok: true, data: { items: [], pageSize: 20, hasMore: false, nextCursor: null } } }
          : config.url === "/payments"
            ? { status: 200, data: { ok: true, data: { items: [], pageSize: 20, hasMore: false, nextCursor: null } } }
            : { status: 200, data: { ok: true, data: { items: [], total: 0, page: 1, pageSize: 20 } } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await Promise.all([
      transport.list("payments", { page: 1, pageSize: 20 }),
      transport.list("accounts", { page: 1, pageSize: 20 })
    ]);

    expect(refreshCalls).toBe(1);
  });

  it("retries a mutation once with the same idempotency key", async () => {
    const idempotencyKeys: string[] = [];
    let mutationCalls = 0;
    let refreshCalls = 0;
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/auth/refresh") {
        refreshCalls += 1;
        return { status: 200, data: sessionEnvelope("access-2", "csrf-2") };
      }
      if (config.url === "/orders/review") {
        mutationCalls += 1;
        idempotencyKeys.push(header(config, "Idempotency-Key"));
        if (mutationCalls === 1) return failure("SESSION_EXPIRED");
        return { status: 200, data: { ok: true, data: { affected: 1, message: "ok" } } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    const result = await transport.mutate("orders", "review", { id: "order-1" }, {
      idempotencyKey: "idem-review-1",
      expectedVersion: 3
    });

    expect(result.affected).toBe(1);
    expect(mutationCalls).toBe(2);
    expect(refreshCalls).toBe(1);
    expect(idempotencyKeys).toEqual(["idem-review-1", "idem-review-1"]);
  });

  it("preserves the safe order review recalculation status from the real BFF", async () => {
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/orders/review") {
        return { status: 200, data: { ok: true, data: {
          affected: 1,
          message: "订单已审核通过",
          accountRecalculationPending: true,
          warning: "订单已审核，客户账款汇总将在稍后更新"
        } } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "service.test", password: "Strong-Admin-2026!" });

    const result = await transport.mutate("orders", "review", { id: "order-1" }, { idempotencyKey: "idem-review-pending", expectedVersion: 3 });

    expect(result.accountRecalculationPending).toBe(true);
    expect(result.warning).toBe("订单已审核，客户账款汇总将在稍后更新");
    expect(result.message).toBe("订单已审核通过");
  });

  it("sends the exact product price body, version, CSRF, and idempotency key", async () => {
    let mutationRequest: InternalAxiosRequestConfig | null = null;
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/products/change-price") {
        mutationRequest = config;
        return { status: 200, data: { ok: true, data: { affected: 1, message: "商品售价已更新" } } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "procurement.test", password: "Strong-Admin-2026!" });

    await transport.mutate("products", "change-price", {
      id: "product-1",
      newPriceCents: 7125,
      expectedPriceCents: 6900,
      reason: "季度改价"
    }, {
      idempotencyKey: "products:change-price:test",
      expectedVersion: 3
    });

    expect(mutationRequest).not.toBeNull();
    expect(mutationRequest!.method).toBe("post");
    expect(requestBody(mutationRequest!)).toEqual({
      id: "product-1",
      newPriceCents: 7125,
      expectedPriceCents: 6900,
      reason: "季度改价",
      expectedVersion: 3
    });
    expect(header(mutationRequest!, "Authorization")).toBe("Bearer access-1");
    expect(header(mutationRequest!, "X-Admin-CSRF")).toBe("csrf-1");
    expect(header(mutationRequest!, "Idempotency-Key")).toBe("products:change-price:test");
  });

  it("sends the exact public product-tag batch contract without an invented version", async () => {
    let mutationRequest: InternalAxiosRequestConfig | null = null;
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/products/batch-tags") {
        mutationRequest = config;
        return {
          status: 200,
          data: {
            ok: true,
            data: {
              affected: 1,
              changedCount: 1,
              unchangedCount: 0,
              failedCount: 0,
              failures: [],
              message: "已更新 1 个商品"
            }
          }
        };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "procurement.test", password: "Strong-Admin-2026!" });
    const payload = {
      scope: "public",
      tag: "热销",
      present: false,
      items: [
        { id: "product-1", expectedVersion: 3, expectedPresent: true },
        { id: "product-2", expectedVersion: 7, expectedPresent: false }
      ],
      reason: "季度标签复核"
    };

    await transport.mutate("products", "batch-tags", payload, {
      idempotencyKey: "products:batch-tags:test"
    });

    expect(mutationRequest).not.toBeNull();
    expect(mutationRequest!.method).toBe("post");
    expect(requestBody(mutationRequest!)).toEqual(payload);
    expect(header(mutationRequest!, "Authorization")).toBe("Bearer access-1");
    expect(header(mutationRequest!, "X-Admin-CSRF")).toBe("csrf-1");
    expect(header(mutationRequest!, "Idempotency-Key")).toBe("products:batch-tags:test");
  });

  it("sends the exact explicit product status body and mutation headers", async () => {
    let mutationRequest: InternalAxiosRequestConfig | null = null;
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/products/toggle-status") {
        mutationRequest = config;
        return { status: 200, data: { ok: true, data: { affected: 1, message: "商品已下架" } } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "procurement.test", password: "Strong-Admin-2026!" });

    await transport.mutate("products", "toggle-status", {
      id: "product-1",
      isActive: false,
      expectedIsActive: true,
      reason: "运营下架"
    }, {
      idempotencyKey: "products:toggle-status:test",
      expectedVersion: 4
    });

    expect(mutationRequest).not.toBeNull();
    expect(mutationRequest!.method).toBe("post");
    expect(requestBody(mutationRequest!)).toEqual({
      id: "product-1",
      isActive: false,
      expectedIsActive: true,
      reason: "运营下架",
      expectedVersion: 4
    });
    expect(header(mutationRequest!, "Authorization")).toBe("Bearer access-1");
    expect(header(mutationRequest!, "X-Admin-CSRF")).toBe("csrf-1");
    expect(header(mutationRequest!, "Idempotency-Key")).toBe("products:toggle-status:test");
  });

  it("does not commit a late refresh success after logout and revokes the rotated server session", async () => {
    const refreshResult = deferred<StubResult>();
    const refreshStarted = deferred<void>();
    const callOrder: string[] = [];
    let logoutCsrfToken = "";
    const client = createClient(async (config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/dashboard") return failure("SESSION_EXPIRED");
      if (config.url === "/auth/refresh") {
        callOrder.push("refresh:start");
        refreshStarted.resolve();
        const result = await refreshResult.promise;
        callOrder.push("refresh:end");
        return result;
      }
      if (config.url === "/auth/logout") {
        callOrder.push("logout");
        logoutCsrfToken = header(config, "X-Admin-CSRF");
        return { status: 200, data: { ok: true, data: {} } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    const onInvalidated = vi.fn();
    transport.setSessionInvalidationHandler(onInvalidated);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    const dashboard = transport.getDashboard();
    await refreshStarted.promise;
    const logout = transport.logout();

    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBeNull();
    refreshResult.resolve({ status: 200, data: sessionEnvelope("access-2", "csrf-2") });

    await expect(dashboard).rejects.toMatchObject({ code: "AUTH_TRANSITION_SUPERSEDED", status: 409 });
    await expect(logout).resolves.toBeUndefined();
    expect(callOrder).toEqual(["refresh:start", "refresh:end", "logout"]);
    expect(logoutCsrfToken).toBe("csrf-2");
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBeNull();
    await expect(transport.getCurrentProfile()).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
  });

  it("serializes relogin behind a late refresh failure and does not invalidate the new session", async () => {
    const refreshResult = deferred<StubResult>();
    const refreshStarted = deferred<void>();
    let loginCalls = 0;
    let logoutCalls = 0;
    const client = createClient(async (config) => {
      if (config.url === "/auth/login") {
        loginCalls += 1;
        return loginCalls === 1
          ? { status: 200, data: sessionEnvelope("access-1", "csrf-1") }
          : { status: 200, data: sessionEnvelope("access-3", "csrf-3") };
      }
      if (config.url === "/auth/refresh") {
        refreshStarted.resolve();
        return refreshResult.promise;
      }
      if (config.url === "/auth/logout") {
        logoutCalls += 1;
        return { status: 200, data: { ok: true, data: {} } };
      }
      if (config.url === "/dashboard" && header(config, "Authorization") === "Bearer access-1") {
        return failure("SESSION_EXPIRED");
      }
      if (config.url === "/dashboard" && header(config, "Authorization") === "Bearer access-3") {
        return {
          status: 200,
          data: { ok: true, data: { metrics: [], tasks: [], trend: [], topProducts: [], updatedAt: "2026-07-11T12:00:00.000Z" } }
        };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    const onInvalidated = vi.fn();
    transport.setSessionInvalidationHandler(onInvalidated);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    const oldDashboard = transport.getDashboard();
    await refreshStarted.promise;
    const logout = transport.logout();
    const relogin = transport.login({ account: "finance.test", password: "New-Strong-Admin-2026!" });

    expect(loginCalls).toBe(1);
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBeNull();
    refreshResult.resolve(failure("SESSION_REVOKED"));

    await expect(oldDashboard).rejects.toMatchObject({ code: "SESSION_REVOKED", status: 401 });
    await expect(logout).resolves.toBeUndefined();
    await expect(relogin).resolves.toMatchObject({ id: "admin-1", role: "finance" });
    expect(loginCalls).toBe(2);
    expect(logoutCalls).toBe(1);
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBe("csrf-3");
    await expect(transport.getDashboard()).resolves.toMatchObject({ metrics: [], tasks: [] });
  });

  it("does not let a late second 401 from an old retry invalidate a relogged session", async () => {
    const oldRetryResult = deferred<StubResult>();
    const oldRetryStarted = deferred<void>();
    let loginCalls = 0;
    const client = createClient(async (config) => {
      if (config.url === "/auth/login") {
        loginCalls += 1;
        return loginCalls === 1
          ? { status: 200, data: sessionEnvelope("access-1", "csrf-1") }
          : { status: 200, data: sessionEnvelope("access-3", "csrf-3") };
      }
      if (config.url === "/auth/refresh") {
        return { status: 200, data: sessionEnvelope("access-2", "csrf-2") };
      }
      if (config.url === "/auth/logout") {
        return { status: 200, data: { ok: true, data: {} } };
      }
      if (config.url === "/dashboard" && header(config, "Authorization") === "Bearer access-1") {
        return failure("SESSION_EXPIRED");
      }
      if (config.url === "/dashboard" && header(config, "Authorization") === "Bearer access-2") {
        oldRetryStarted.resolve();
        return oldRetryResult.promise;
      }
      if (config.url === "/dashboard" && header(config, "Authorization") === "Bearer access-3") {
        return {
          status: 200,
          data: { ok: true, data: { metrics: [], tasks: [], trend: [], topProducts: [], updatedAt: "2026-07-11T12:00:00.000Z" } }
        };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    const onInvalidated = vi.fn();
    transport.setSessionInvalidationHandler(onInvalidated);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    const oldDashboard = transport.getDashboard();
    await oldRetryStarted.promise;
    await transport.logout();
    await transport.login({ account: "finance.test", password: "New-Strong-Admin-2026!" });
    oldRetryResult.resolve(failure("SESSION_REVOKED"));

    await expect(oldDashboard).rejects.toMatchObject({ code: "SESSION_REVOKED", status: 401 });
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBe("csrf-3");
    await expect(transport.getDashboard()).resolves.toMatchObject({ metrics: [], tasks: [] });
  });

  it("invalidates the current session when the retry still returns 401", async () => {
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/auth/refresh") return { status: 200, data: sessionEnvelope("access-2", "csrf-2") };
      if (config.url === "/dashboard") return failure("SESSION_REVOKED");
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    const onInvalidated = vi.fn();
    transport.setSessionInvalidationHandler(onInvalidated);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await expect(transport.getDashboard()).rejects.toMatchObject({ code: "SESSION_REVOKED", status: 401 });
    expect(onInvalidated).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBeNull();
  });

  it("invalidates the current session after a direct CSRF validation failure", async () => {
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/orders/review") return failure("CSRF_VALIDATION_FAILED", 403);
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    const onInvalidated = vi.fn();
    transport.setSessionInvalidationHandler(onInvalidated);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await expect(transport.mutate("orders", "review", { id: "order-1" }, {
      idempotencyKey: "idem-review-csrf",
      expectedVersion: 3
    })).rejects.toMatchObject({ code: "CSRF_VALIDATION_FAILED", status: 403 });
    expect(onInvalidated).toHaveBeenCalledTimes(1);
    expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
      code: "CSRF_VALIDATION_FAILED",
      status: 401
    }));
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBeNull();
  });

  it("does not invalidate a rotated session for a late CSRF failure from the old revision", async () => {
    const oldMutationResult = deferred<StubResult>();
    const oldMutationStarted = deferred<void>();
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/auth/refresh") return { status: 200, data: sessionEnvelope("access-2", "csrf-2") };
      if (config.url === "/orders/review" && header(config, "Authorization") === "Bearer access-1") {
        oldMutationStarted.resolve();
        return oldMutationResult.promise;
      }
      if (config.url === "/payments" && header(config, "Authorization") === "Bearer access-1") {
        return failure("SESSION_EXPIRED");
      }
      if (config.url === "/payments" && header(config, "Authorization") === "Bearer access-2") {
        return { status: 200, data: { ok: true, data: { items: [], pageSize: 20, hasMore: false, nextCursor: null } } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    const onInvalidated = vi.fn();
    transport.setSessionInvalidationHandler(onInvalidated);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    const oldMutation = transport.mutate("orders", "review", { id: "order-1" }, {
      idempotencyKey: "idem-review-old-csrf",
      expectedVersion: 3
    });
    await oldMutationStarted.promise;
    await transport.list("payments", { page: 1, pageSize: 20 });
    oldMutationResult.resolve(failure("CSRF_VALIDATION_FAILED", 403));

    await expect(oldMutation).rejects.toMatchObject({ code: "CSRF_VALIDATION_FAILED", status: 403 });
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBe("csrf-2");
  });

  it("keeps the current session after an ordinary 403", async () => {
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/orders") return failure("FORBIDDEN", 403);
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    const onInvalidated = vi.fn();
    transport.setSessionInvalidationHandler(onInvalidated);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await expect(transport.list("orders", { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBe("csrf-1");
  });

  it("clears local credentials and emits one invalidation after refresh fails", async () => {
    let requestCount = 0;
    const client = createClient((config) => {
      requestCount += 1;
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/dashboard") return failure("SESSION_EXPIRED");
      if (config.url === "/auth/refresh") return failure("SESSION_REVOKED");
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    const onInvalidated = vi.fn();
    transport.setSessionInvalidationHandler(onInvalidated);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await expect(transport.getDashboard()).rejects.toMatchObject({ code: "SESSION_REVOKED", status: 401 });
    expect(onInvalidated).toHaveBeenCalledTimes(1);
    expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({
      code: "SESSION_REVOKED",
      message: "登录状态已失效，请重新登录",
      status: 401
    }));
    expect(window.sessionStorage.getItem("admin-web.csrf-token")).toBeNull();

    const countAfterInvalidation = requestCount;
    await expect(transport.getCurrentProfile()).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    expect(requestCount).toBe(countAfterInvalidation);
  });

  it("treats a first visit without session material as a quiet auth miss", async () => {
    const adapter = vi.fn<StubHandler>(() => failure("ACCESS_TOKEN_REQUIRED"));
    const transport = new HttpBffTransport(createClient(adapter));
    const onInvalidated = vi.fn();
    transport.setSessionInvalidationHandler(onInvalidated);

    await expect(transport.getCurrentProfile()).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    expect(adapter).not.toHaveBeenCalled();
    expect(onInvalidated).not.toHaveBeenCalled();
  });
});

describe("HttpBffTransport order read contract", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("validates order list and detail responses with the strict contract", async () => {
    const client = createClient((config) => {
      if (config.url === "/orders" && config.method === "get") {
        return { status: 200, data: { ok: true, data: { items: [validOrderSummary()], total: 1, page: 1, pageSize: 20, nextCursor: null } } };
      }
      if (config.url === "/orders/order-1" && config.method === "get") {
        return {
          status: 200,
          data: {
            ok: true,
            data: {
              ...validOrderSummary(),
              items: [{ id: "line-1", productId: "product-1", productName: "精华", specification: "30ml", productionDate: "2026-06", quantity: 3 }],
              customer: { nameMasked: "张*", phoneMasked: "138****8000" }
            }
          }
        };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);

    await expect(transport.list("orders", { page: 1, pageSize: 20 })).resolves.toMatchObject({ total: 1 });
    await expect(transport.get("orders", "order-1")).resolves.toMatchObject({ id: "order-1", items: [{ quantity: 3 }] });
  });

  it("rejects overexposed order payloads instead of passing unknown fields to the UI", async () => {
    const client = createClient((config) => {
      if (config.url === "/orders") {
        return { status: 200, data: { ok: true, data: { items: [{ ...validOrderSummary(), openid: "secret" }], total: 1, page: 1, pageSize: 20 } } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });

    await expect(new HttpBffTransport(client).list("orders", { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "INVALID_ORDER_CONTRACT", status: 502 });
  });

  it("uses the previous order page cursor and isolates cursors by filter", async () => {
    const requests: InternalAxiosRequestConfig[] = [];
    const client = createClient((config) => {
      requests.push(config);
      if (config.url !== "/orders") throw new Error(`Unexpected request: ${config.method} ${config.url}`);
      const page = Number(config.params?.page || 1);
      const search = String(config.params?.search || "");
      const nextCursor = page === 1 && !search ? "cursor-page-2" : null;
      return {
        status: 200,
        data: { ok: true, data: { items: [validOrderSummary(`order-${page}-${search || "all"}`)], total: 2, page, pageSize: 1, nextCursor } }
      };
    });
    const transport = new HttpBffTransport(client);

    await transport.list("orders", { page: 1, pageSize: 1 });
    await transport.list("orders", { page: 2, pageSize: 1 });
    await transport.list("orders", { page: 1, pageSize: 1, search: "new" });

    expect(requests[1]!.params).toMatchObject({ page: 2, cursor: "cursor-page-2" });
    expect(requests[2]!.params).not.toHaveProperty("cursor");
  });

  it("resolves missing intermediate cursors when the operator jumps to a later order page", async () => {
    const requestedPages: Array<{ page: number; cursor?: string }> = [];
    const client = createClient((config) => {
      const page = Number(config.params?.page || 1);
      requestedPages.push({ page, cursor: config.params?.cursor as string | undefined });
      return {
        status: 200,
        data: {
          ok: true,
          data: {
            items: [validOrderSummary(`order-${page}`)],
            total: 3,
            page,
            pageSize: 1,
            nextCursor: page < 3 ? `cursor-page-${page + 1}` : null
          }
        }
      };
    });

    await new HttpBffTransport(client).list("orders", { page: 3, pageSize: 1 });

    expect(requestedPages).toEqual([
      { page: 1, cursor: undefined },
      { page: 2, cursor: "cursor-page-2" },
      { page: 3, cursor: "cursor-page-3" }
    ]);
  });

  it("returns an empty target page when a direct order-page jump passes the last cursor", async () => {
    const requestedPages: number[] = [];
    const client = createClient((config) => {
      const page = Number(config.params?.page || 1);
      requestedPages.push(page);
      return {
        status: 200,
        data: {
          ok: true,
          data: {
            items: [validOrderSummary(`order-${page}`)],
            total: 1,
            page,
            pageSize: 1,
            nextCursor: null
          }
        }
      };
    });

    const result = await new HttpBffTransport(client).list("orders", { page: 3, pageSize: 1 });

    expect(requestedPages).toEqual([1]);
    expect(result).toEqual({ items: [], total: 1, page: 3, pageSize: 1, nextCursor: null });
  });
});

describe("HttpBffTransport inventory adjustment", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("loads the latest inventory snapshot and posts the exact delta-only request", async () => {
    const snapshot = {
      id: "product-1",
      stock: 12,
      warningThreshold: 5,
      status: "normal",
      isActive: true,
      version: 3,
      updatedAt: "2026-07-12T08:00:00.000Z"
    };
    const requests: InternalAxiosRequestConfig[] = [];
    const client = createClient((config) => {
      requests.push(config);
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.method === "get" && config.url === "/inventory/product-1") {
        return { status: 200, data: { ok: true, data: { ...snapshot, sku: "SKU-001", name: "测试商品", lastChange: "" } } };
      }
      if (config.method === "post" && config.url === "/inventory/adjust") {
        return {
          status: 200,
          data: {
            ok: true,
            data: {
              item: { ...snapshot, stock: 8, version: 4 },
              affected: 1,
              message: "库存已从 12 调整为 8",
              requestId: "request-1"
            }
          }
        };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await expect(transport.getInventorySnapshot("product-1")).resolves.toEqual(snapshot);
    const input = {
      id: "product-1",
      mode: "delta" as const,
      delta: -4,
      expectedStock: 12,
      expectedVersion: 3,
      reason: "盘点修正"
    };
    await expect(transport.adjustInventory("inventory", input, {
      idempotencyKey: "inventory-adjust:test",
      expectedVersion: 3
    })).resolves.toMatchObject({ affected: 1, item: { stock: 8, version: 4 } });

    const mutation = requests.find((config) => config.url === "/inventory/adjust")!;
    expect(requestBody(mutation)).toEqual(input);
    expect(Object.keys(requestBody(mutation))).toEqual(["id", "mode", "delta", "expectedStock", "expectedVersion", "reason"]);
    expect(header(mutation, "Idempotency-Key")).toBe("inventory-adjust:test");
    expect(header(mutation, "X-Admin-CSRF")).toBe("csrf-1");
  });

  it("rejects an expectedVersion mismatch before sending the request", async () => {
    let adjustCalls = 0;
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/inventory-alerts/adjust") adjustCalls += 1;
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });
    await expect(transport.adjustInventory("inventory-alerts", {
      id: "product-1",
      mode: "delta",
      delta: 2,
      expectedStock: 12,
      expectedVersion: 3,
      reason: "到货入库"
    }, { idempotencyKey: "inventory-adjust:mismatch", expectedVersion: 2 })).rejects.toMatchObject({
      code: "EXPECTED_VERSION_MISMATCH"
    });
    expect(adjustCalls).toBe(0);
  });
});

describe("HttpBffTransport payment review mutation", () => {
  beforeEach(() => window.sessionStorage.clear());

  const paymentInput = {
    id: "pay-001",
    expectedStatus: "pending_confirm",
    expectedVersion: 2,
    expectedUpdatedAt: "2026-07-13T08:05:00.000Z",
    reason: "已核对到账"
  };

  function paymentResult(decision: "confirm" | "reject" = "confirm") {
    return {
      item: {
        id: "pay-001",
        orderNo: "ORDER-001",
        status: decision === "confirm" ? "paid" : "rejected",
        version: 3,
        updatedAt: "2026-07-13T08:06:00.000Z"
      },
      affected: 1,
      reused: false,
      decision,
      accountRecalculationPending: false,
      message: decision === "confirm" ? "付款已确认" : "付款已驳回",
      requestId: "request-payment-1"
    };
  }

  it("posts the exact payment body with CSRF and the header-only idempotency key", async () => {
    let request: InternalAxiosRequestConfig | undefined;
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/payments/confirm") {
        request = config;
        return { status: 200, data: { ok: true, data: paymentResult() } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    const response = await transport.mutate("payments", "confirm", {
      ...paymentInput,
      id: "  pay-001  ",
      reason: "  已核对到账  "
    }, {
      idempotencyKey: "payments:confirm:test",
      expectedVersion: 2
    });

    expect(response).toEqual(paymentResult());
    expect(requestBody(request!)).toEqual({
      paymentId: "pay-001",
      expectedStatus: "pending_confirm",
      expectedVersion: 2,
      expectedUpdatedAt: "2026-07-13T08:05:00.000Z",
      reason: "已核对到账"
    });
    expect(Object.keys(requestBody(request!))).toEqual(["paymentId", "expectedStatus", "expectedVersion", "expectedUpdatedAt", "reason"]);
    expect(header(request!, "Idempotency-Key")).toBe("payments:confirm:test");
    expect(header(request!, "X-Admin-CSRF")).toBe("csrf-1");
  });

  it("retries one payment network failure with the identical body and key", async () => {
    const attempts: Array<{ body: Record<string, unknown>; key: string }> = [];
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/payments/reject") {
        attempts.push({ body: requestBody(config), key: header(config, "Idempotency-Key") });
        if (attempts.length === 1) return failure("UPSTREAM_UNAVAILABLE", 503);
        return { status: 200, data: { ok: true, data: paymentResult("reject") } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await expect(transport.mutate("payments", "reject", { ...paymentInput, reason: "凭证不清晰" }, {
      idempotencyKey: "payments:reject:retry",
      expectedVersion: 2
    })).resolves.toMatchObject({ decision: "reject", item: { status: "rejected" } });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it("rejects forbidden payment input and mismatched option versions before posting", async () => {
    let paymentCalls = 0;
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/payments/confirm") {
        paymentCalls += 1;
        return { status: 200, data: { ok: true, data: paymentResult() } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await expect(transport.mutate("payments", "confirm", { ...paymentInput, amountCents: 1 }, {
      idempotencyKey: "payments:confirm:forbidden",
      expectedVersion: 2
    })).rejects.toMatchObject({ code: "INVALID_PAYMENT_MUTATION", status: 400 });
    await expect(transport.mutate("payments", "confirm", paymentInput, {
      idempotencyKey: "payments:confirm:mismatch",
      expectedVersion: 9
    })).rejects.toMatchObject({ code: "EXPECTED_VERSION_MISMATCH", status: 400 });
    expect(paymentCalls).toBe(0);
  });

  it("rejects a payment response that includes sensitive or unknown fields", async () => {
    const client = createClient((config) => {
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/payments/confirm") {
        return { status: 200, data: { ok: true, data: { ...paymentResult(), orderId: "order-secret" } } };
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    await expect(transport.mutate("payments", "confirm", paymentInput, {
      idempotencyKey: "payments:confirm:unsafe-result",
      expectedVersion: 2
    })).rejects.toMatchObject({ code: "INVALID_PAYMENT_MUTATION_CONTRACT", status: 502 });
  });
});

describe("HttpBffTransport product analytics contract", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("validates and returns the requested product analytics range", async () => {
    const client = createClient((config) => {
      expect(config.url).toBe("/analytics/products");
      expect(config.params).toEqual({ range: "30d" });
      return { status: 200, data: { ok: true, data: validProductAnalytics() } };
    });

    await expect(new HttpBffTransport(client).getProductAnalytics("30d")).resolves.toMatchObject({
      range: "30d",
      status: "available",
      ranking: [{ currentPriceCents: 0, averagePriceCents: null }]
    });
  });

  it("accepts the explicit empty status without inventing metrics", async () => {
    const payload = {
      ...validProductAnalytics("7d"),
      status: "empty" as const,
      message: "当前范围暂无成交数据",
      summary: [],
      series: [],
      ranking: []
    };
    const client = createClient(() => ({ status: 200, data: { ok: true, data: payload } }));

    await expect(new HttpBffTransport(client).getProductAnalytics("7d")).resolves.toEqual(payload);
  });

  it("accepts a legacy product with an empty SKU", async () => {
    const payload = validProductAnalytics();
    const client = createClient(() => ({ status: 200, data: { ok: true, data: payload } }));

    await expect(new HttpBffTransport(client).getProductAnalytics("30d")).resolves.toMatchObject({
      ranking: [{ sku: "" }]
    });
  });

  it("accepts mathematically valid growth above 100000 percent", async () => {
    const base = validProductAnalytics();
    const payload = {
      ...base,
      summary: base.summary.map((item, index) => index === 0 ? { ...item, change: 100_100 } : item),
      ranking: base.ranking.map((item, index) => index === 0 ? { ...item, change: 100_100 } : item)
    };
    const client = createClient(() => ({ status: 200, data: { ok: true, data: payload } }));

    const result = await new HttpBffTransport(client).getProductAnalytics("30d");
    expect(result.summary[0]?.change).toBe(100_100);
    expect(result.ranking[0]?.change).toBe(100_100);
  });

  it.each([
    ["missing status", (payload) => Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "status")
    )],
    ["unknown top-level field", (payload) => ({ ...payload, stock: 100 })],
    ["unknown nested field", (payload) => ({
      ...payload,
      ranking: [{ ...payload.ranking[0], openid: "sensitive" }]
    })],
    ["fractional quantity", (payload) => ({
      ...payload,
      series: [{ ...payload.series[0], salesCount: 1.5 }]
    })],
    ["fractional summary value", (payload) => ({
      ...payload,
      summary: [{ ...payload.summary[0], value: 1.5 }]
    })],
    ["fractional cents", (payload) => ({
      ...payload,
      ranking: [{ ...payload.ranking[0], currentPriceCents: 99.5 }]
    })],
    ["invalid calendar date", (payload) => ({
      ...payload,
      series: [{ ...payload.series[0], date: "2026-02-30" }]
    })],
    ["oversized summary", (payload) => ({
      ...payload,
      summary: Array.from({ length: 9 }, (_, index) => ({
        key: `metric-${index}`,
        label: `指标 ${index}`,
        value: index,
        kind: "number" as const,
        change: null
      }))
    })],
    ["oversized series", (payload) => ({
      ...payload,
      series: Array.from({ length: 91 }, () => payload.series[0])
    })],
    ["oversized ranking", (payload) => ({
      ...payload,
      ranking: Array.from({ length: 21 }, () => payload.ranking[0])
    })]
  ] satisfies Array<[
    string,
    (payload: ReturnType<typeof validProductAnalytics>) => unknown
  ]>)("rejects %s instead of coercing it to empty analytics", async (_label, mutate) => {
    let calls = 0;
    const payload = mutate(validProductAnalytics());
    const client = createClient(() => {
      calls += 1;
      return { status: 200, data: { ok: true, data: payload } };
    });

    await expect(new HttpBffTransport(client).getProductAnalytics("30d")).rejects.toMatchObject({
      code: "INVALID_PRODUCT_ANALYTICS_RESPONSE",
      status: 502
    });
    expect(calls).toBe(1);
  });

  it("rejects a valid response for a different range", async () => {
    const client = createClient(() => ({
      status: 200,
      data: { ok: true, data: validProductAnalytics("7d") }
    }));

    await expect(new HttpBffTransport(client).getProductAnalytics("30d")).rejects.toMatchObject({
      code: "PRODUCT_ANALYTICS_RANGE_MISMATCH",
      status: 502
    });
  });
});

describe("HttpBffTransport product write contract", () => {
  const metadata = {
    name: "测试商品",
    baseName: "测试商品",
    imageUrl: "https://example.com/product.jpg",
    specification: "30ml",
    productionDate: "2026-07",
    description: "测试说明",
    productIndex: "P000001",
    skuCode: "SKU-001",
    keywords: ["测试"]
  };
  const initial = { salePriceCents: 6990, stock: 20, warningThreshold: 5, isActive: false, tags: ["新货"] as ["新货"] };
  const detail = { id: "product-1", version: 3, metadata, initial, updatedAt: "2026-07-12T08:00:00.000Z" };
  const summary = {
    id: "product-1",
    sku: "SKU-001",
    name: "测试商品",
    brand: "",
    salePriceCents: 6990,
    status: "draft",
    isActive: false,
    tags: ["新货"],
    updatedAt: "2026-07-12T08:00:00.000Z",
    version: 3
  };

  it("uses dedicated detail/create/edit routes with CSRF and exact bodies", async () => {
    const requests: InternalAxiosRequestConfig[] = [];
    const client = createClient((config) => {
      requests.push(config);
      if (config.url === "/auth/login") return { status: 200, data: sessionEnvelope("access-1", "csrf-1") };
      if (config.url === "/products/product-1") return { status: 200, data: { ok: true, data: detail } };
      if (config.url === "/products/create") return { status: 200, data: { ok: true, data: { item: { ...summary, version: 1 }, affected: 1, message: "商品已新增" } } };
      if (config.url === "/products/edit") return { status: 200, data: { ok: true, data: { item: { ...summary, name: "修订商品", version: 4 }, affected: 1, message: "商品资料已更新" } } };
      return { status: 404, data: { ok: false, code: "NOT_FOUND", message: "NOT_FOUND" } };
    });
    const transport = new HttpBffTransport(client);
    await transport.login({ account: "finance.demo", password: "demo-pass" });

    expect(await transport.getProductDetail("product-1")).toEqual(detail);
    await transport.createProduct({ metadata, initial, reason: "新品建档" }, { idempotencyKey: "product-create:test" });
    await transport.editProduct({ id: "product-1", expectedVersion: 3, metadata: { ...metadata, name: "修订商品" }, reason: "资料修正" }, {
      idempotencyKey: "product-edit:test",
      expectedVersion: 3
    });

    const createRequest = requests.find((request) => request.url === "/products/create")!;
    const editRequest = requests.find((request) => request.url === "/products/edit")!;
    expect(requestBody(createRequest)).toEqual({ metadata, initial, reason: "新品建档" });
    expect(requestBody(editRequest)).toEqual({ id: "product-1", expectedVersion: 3, metadata: { ...metadata, name: "修订商品" }, reason: "资料修正" });
    expect(header(createRequest, "Idempotency-Key")).toBe("product-create:test");
    expect(header(editRequest, "Idempotency-Key")).toBe("product-edit:test");
    expect(header(createRequest, "X-Admin-CSRF")).toBe("csrf-1");
    expect(requestBody(editRequest)).not.toHaveProperty("initial");
  });

  it("rejects extra response fields and mismatched edit versions before writing", async () => {
    let calls = 0;
    const transport = new HttpBffTransport(createClient(() => {
      calls += 1;
      return { status: 200, data: { ok: true, data: { ...detail, internalTags: ["内部"] } } };
    }));
    await expect(transport.getProductDetail("product-1")).rejects.toMatchObject({ code: "INVALID_PRODUCT_CONTRACT", status: 502 });
    expect(calls).toBe(1);

    await expect(transport.editProduct({ id: "product-1", expectedVersion: 3, metadata, reason: "" }, {
      idempotencyKey: "product-edit:mismatch",
      expectedVersion: 2
    })).rejects.toMatchObject({ code: "EXPECTED_VERSION_MISMATCH", status: 400 });
    expect(calls).toBe(1);
  });
});

describe("HttpBffTransport shipment reads", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("bridges an arbitrary forward UI page through every required opaque cursor", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = createClient((config) => {
      if (config.url !== "/shipments") throw new Error(`Unexpected request: ${config.method} ${config.url}`);
      const params = { ...(config.params as Record<string, unknown> | undefined) };
      seen.push(params);
      const cursor = params.cursor;
      if (!cursor) return { status: 200, data: { ok: true, data: {
        items: [validShipmentSummary("shipment-1"), validShipmentSummary("shipment-2")],
        pageSize: 2,
        hasMore: true,
        nextCursor: "cursor-1"
      } } };
      if (cursor === "cursor-1") return { status: 200, data: { ok: true, data: {
        items: [validShipmentSummary("shipment-3"), validShipmentSummary("shipment-4")],
        pageSize: 2,
        hasMore: true,
        nextCursor: "cursor-2"
      } } };
      if (cursor === "cursor-2") return { status: 200, data: { ok: true, data: {
        items: [validShipmentSummary("shipment-5")],
        pageSize: 2,
        hasMore: false,
        nextCursor: null
      } } };
      throw new Error(`Unexpected cursor: ${String(cursor)}`);
    });
    const transport = new HttpBffTransport(client);

    const page = await transport.list("shipments", { page: 3, pageSize: 2, status: "pending_shipment" });

    expect(page).toMatchObject({ page: 3, pageSize: 2, total: 5, nextCursor: null });
    expect(page.items.map((item) => item.id)).toEqual(["shipment-5"]);
    expect(seen.map((params) => params.cursor)).toEqual([undefined, "cursor-1", "cursor-2"]);
    expect(seen.every((params) => !Object.hasOwn(params, "page"))).toBe(true);
  });

  it("returns the requested empty page instead of silently reusing an exhausted earlier page", async () => {
    const client = createClient((config) => {
      if (config.url !== "/shipments") throw new Error(`Unexpected request: ${config.method} ${config.url}`);
      const cursor = (config.params as Record<string, unknown> | undefined)?.cursor;
      return cursor
        ? { status: 200, data: { ok: true, data: { items: [validShipmentSummary("shipment-2")], pageSize: 1, hasMore: false, nextCursor: null } } }
        : { status: 200, data: { ok: true, data: { items: [validShipmentSummary("shipment-1")], pageSize: 1, hasMore: true, nextCursor: "cursor-1" } } };
    });
    const transport = new HttpBffTransport(client);

    const page = await transport.list("shipments", { page: 3, pageSize: 1 });

    expect(page).toEqual({ items: [], total: 2, page: 3, pageSize: 1, nextCursor: null });
  });

  it("starts a new cursor chain when search, status, or page size changes", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = createClient((config) => {
      if (config.url !== "/shipments") throw new Error(`Unexpected request: ${config.method} ${config.url}`);
      const params = { ...(config.params as Record<string, unknown> | undefined) };
      seen.push(params);
      const suffix = `${String(params.search || "all")}:${String(params.status || "all")}:${String(params.pageSize)}`;
      return params.cursor
        ? { status: 200, data: { ok: true, data: { items: [validShipmentSummary(`last-${suffix}`)], pageSize: params.pageSize, hasMore: false, nextCursor: null } } }
        : { status: 200, data: { ok: true, data: { items: [validShipmentSummary(`first-${suffix}`)], pageSize: params.pageSize, hasMore: true, nextCursor: `next-${suffix}` } } };
    });
    const transport = new HttpBffTransport(client);

    await transport.list("shipments", { page: 2, pageSize: 20 });
    seen.length = 0;
    await transport.list("shipments", { page: 2, pageSize: 10, search: "SHP-001", status: "shipped" });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ pageSize: 10, search: "SHP-001", status: "shipped" });
    expect(seen[0]).not.toHaveProperty("cursor");
    expect(seen[1]?.cursor).toBe("next-SHP-001:shipped:10");
  });

  it("keeps independent shipment cursor chains for interleaved filters", async () => {
    const releaseA = deferred<void>();
    const releaseB = deferred<void>();
    const startedA = deferred<void>();
    const startedB = deferred<void>();
    const seen: Array<{ search: string; cursor?: string }> = [];
    const client = createClient(async (config) => {
      if (config.url !== "/shipments") throw new Error(`Unexpected request: ${config.method} ${config.url}`);
      const params = config.params as Record<string, unknown>;
      const search = String(params.search || "");
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
      seen.push({ search, cursor });
      if (!cursor) {
        if (search === "SHP-A") {
          startedA.resolve(undefined);
          await releaseA.promise;
        } else {
          startedB.resolve(undefined);
          await releaseB.promise;
        }
        return { status: 200, data: { ok: true, data: {
          items: [validShipmentSummary(`${search}-first`)],
          pageSize: 1,
          hasMore: true,
          nextCursor: `${search}-cursor`
        } } };
      }
      return { status: 200, data: { ok: true, data: {
        items: [validShipmentSummary(`${search}-second`)],
        pageSize: 1,
        hasMore: false,
        nextCursor: null
      } } };
    });
    const transport = new HttpBffTransport(client);

    const firstA = transport.list("shipments", { page: 1, pageSize: 1, search: "SHP-A" });
    const firstB = transport.list("shipments", { page: 1, pageSize: 1, search: "SHP-B" });
    await Promise.all([startedA.promise, startedB.promise]);
    releaseB.resolve(undefined);
    releaseA.resolve(undefined);
    await Promise.all([firstA, firstB]);

    seen.length = 0;
    const [secondA, secondB] = await Promise.all([
      transport.list("shipments", { page: 2, pageSize: 1, search: "SHP-A" }),
      transport.list("shipments", { page: 2, pageSize: 1, search: "SHP-B" })
    ]);

    expect(seen).toEqual(expect.arrayContaining([
      { search: "SHP-A", cursor: "SHP-A-cursor" },
      { search: "SHP-B", cursor: "SHP-B-cursor" }
    ]));
    expect(seen).toHaveLength(2);
    expect(secondA.items.map((item) => item.id)).toEqual(["SHP-A-second"]);
    expect(secondB.items.map((item) => item.id)).toEqual(["SHP-B-second"]);
  });

  it("uses the dedicated strict detail parser from both the explicit and compatibility entry points", async () => {
    let calls = 0;
    const client = createClient((config) => {
      if (config.url !== "/shipments/shipment-1") throw new Error(`Unexpected request: ${config.method} ${config.url}`);
      calls += 1;
      const value = validShipmentDetail();
      if (calls === 2) Object.assign(value, { operatorOpenid: "secret-openid" });
      return { status: 200, data: { ok: true, data: value } };
    });
    const transport = new HttpBffTransport(client);

    expect((await transport.getShipmentDetail("shipment-1")).shipment.id).toBe("shipment-1");
    await expect(transport.get("shipments", "shipment-1")).rejects.toMatchObject({
      code: "INVALID_SHIPMENT_CONTRACT",
      status: 502
    });
  });

  it("preserves safe shipment 403, 404, and 503 errors", async () => {
    for (const [status, code] of [[403, "FORBIDDEN"], [404, "SHIPMENT_NOT_FOUND"], [503, "SHIPMENT_READ_FAILED"]] as const) {
      const transport = new HttpBffTransport(createClient(() => failure(code, status)));
      await expect(transport.getShipmentDetail("shipment-1")).rejects.toMatchObject({ code, status });
    }
  });
});

describe("HttpBffTransport account reads", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("uses a filter-bound cursor chain without forwarding a numeric page", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = createClient((config) => {
      if (config.url !== "/accounts") throw new Error(`Unexpected request: ${config.method} ${config.url}`);
      const params = { ...(config.params as Record<string, unknown> | undefined) };
      seen.push(params);
      return params.cursor
        ? { status: 200, data: { ok: true, data: {
          items: [validAccountSummary("account-2")], pageSize: 1, hasMore: false, nextCursor: null
        } } }
        : { status: 200, data: { ok: true, data: {
          items: [validAccountSummary("account-1")], pageSize: 1, hasMore: true, nextCursor: "account-cursor-1"
        } } };
    });
    const transport = new HttpBffTransport(client);

    const first = await transport.list("accounts", { page: 1, pageSize: 1, search: "张*", status: "unpaid" });
    const second = await transport.list("accounts", { page: 2, pageSize: 1, search: "张*", status: "unpaid" });

    expect(first).toMatchObject({ page: 1, pageSize: 1, total: 2, nextCursor: "account-cursor-1" });
    expect(second).toEqual({
      items: [validAccountSummary("account-2")], total: 2, page: 2, pageSize: 1, nextCursor: null
    });
    expect(seen).toEqual([
      { pageSize: 1, search: "张*", status: "unpaid" },
      { pageSize: 1, search: "张*", status: "unpaid", cursor: "account-cursor-1" }
    ]);
  });

  it("rejects a direct page jump and starts a separate chain when filters change", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = createClient((config) => {
      const params = { ...(config.params as Record<string, unknown> | undefined) };
      seen.push(params);
      return { status: 200, data: { ok: true, data: {
        items: [validAccountSummary()], pageSize: params.pageSize, hasMore: true,
        nextCursor: `cursor-${String(params.search || "all")}`
      } } };
    });
    const transport = new HttpBffTransport(client);

    await expect(transport.list("accounts", { page: 2, pageSize: 20 })).rejects.toMatchObject({
      code: "ACCOUNT_PAGE_JUMP_NOT_ALLOWED",
      status: 400
    });
    expect(seen).toHaveLength(0);

    await transport.list("accounts", { page: 1, pageSize: 20 });
    await expect(transport.list("accounts", { page: 2, pageSize: 20, search: "新筛选" })).rejects.toMatchObject({
      code: "ACCOUNT_PAGE_JUMP_NOT_ALLOWED",
      status: 400
    });
    await transport.list("accounts", { page: 1, pageSize: 20, search: "新筛选" });
    await transport.list("accounts", { page: 2, pageSize: 20, search: "新筛选" });

    expect(seen.at(-1)).toEqual({ pageSize: 20, search: "新筛选", cursor: "cursor-新筛选" });
  });

  it("parses dedicated account detail from both explicit and compatibility entry points", async () => {
    let calls = 0;
    const client = createClient((config) => {
      if (config.url !== "/accounts/account-1") throw new Error(`Unexpected request: ${config.method} ${config.url}`);
      calls += 1;
      const value = validAccountDetail();
      if (calls === 2) Object.assign(value.logs[0]!, { operatorOpenid: "secret-openid" });
      return { status: 200, data: { ok: true, data: value } };
    });
    const transport = new HttpBffTransport(client);

    expect((await transport.getAccountDetail("account-1")).account.id).toBe("account-1");
    await expect(transport.get("accounts", "account-1")).rejects.toMatchObject({
      code: "INVALID_ACCOUNT_CONTRACT",
      status: 502
    });
  });

  it("rejects unsafe list DTOs and preserves safe account errors", async () => {
    const unsafe = new HttpBffTransport(createClient(() => ({ status: 200, data: { ok: true, data: {
      items: [{ ...validAccountSummary(), openid: "secret" }], pageSize: 20, hasMore: false, nextCursor: null
    } } })));
    await expect(unsafe.list("accounts", { page: 1, pageSize: 20 })).rejects.toMatchObject({
      code: "INVALID_ACCOUNT_CONTRACT",
      status: 502
    });

    for (const [status, code] of [[403, "FORBIDDEN"], [404, "ACCOUNT_NOT_FOUND"], [503, "ACCOUNT_READ_FAILED"]] as const) {
      const transport = new HttpBffTransport(createClient(() => failure(code, status)));
      await expect(transport.getAccountDetail("account-1")).rejects.toMatchObject({ code, status });
    }
  });
});
