import { describe, expect, it } from "vitest";
import { resolveDevProxyConfiguration } from "./vite-security";

describe("Vite development BFF proxy security", () => {
  it("keeps the proxy disabled when no server-only target is configured", () => {
    expect(resolveDevProxyConfiguration({}, "test")).toBeNull();
  });

  it("fails closed when a configured target lacks a trusted origin", () => {
    expect(() => resolveDevProxyConfiguration({
      ADMIN_WEB_BFF_PROXY_TARGET: "https://bff.example.test",
      ADMIN_WEB_ACTION_SECRET: "server-only-secret"
    }, "test")).toThrow(/ADMIN_WEB_BFF_PROXY_ORIGIN/);
  });

  it("fails closed when a configured target lacks the internal action secret", () => {
    expect(() => resolveDevProxyConfiguration({
      ADMIN_WEB_BFF_PROXY_TARGET: "https://bff.example.test",
      ADMIN_WEB_BFF_PROXY_ORIGIN: "http://127.0.0.1:4173"
    }, "test")).toThrow(/ADMIN_WEB_ACTION_SECRET/);
  });

  it("rejects unsafe target, origin, and secret values", () => {
    expect(() => resolveDevProxyConfiguration({
      ADMIN_WEB_BFF_PROXY_TARGET: "http://remote.example.test",
      ADMIN_WEB_BFF_PROXY_ORIGIN: "http://127.0.0.1:4173",
      ADMIN_WEB_ACTION_SECRET: "server-only-secret"
    }, "test")).toThrow(/HTTPS/);
    expect(() => resolveDevProxyConfiguration({
      ADMIN_WEB_BFF_PROXY_TARGET: "https://bff.example.test",
      ADMIN_WEB_BFF_PROXY_ORIGIN: "http://remote.example.test",
      ADMIN_WEB_ACTION_SECRET: "server-only-secret"
    }, "test")).toThrow(/HTTPS/);
    expect(() => resolveDevProxyConfiguration({
      ADMIN_WEB_BFF_PROXY_TARGET: "https://bff.example.test",
      ADMIN_WEB_BFF_PROXY_ORIGIN: "http://127.0.0.1:4173",
      ADMIN_WEB_ACTION_SECRET: "server-secret\r\nX-Injected: yes"
    }, "test")).toThrow(/invalid header/);
  });

  it("returns only normalized server-side proxy values", () => {
    expect(resolveDevProxyConfiguration({
      ADMIN_WEB_BFF_PROXY_TARGET: "https://bff.example.test/action/",
      ADMIN_WEB_BFF_PROXY_ORIGIN: "http://127.0.0.1:4173/",
      ADMIN_WEB_ACTION_SECRET: "  server-only-secret  "
    }, "test")).toEqual({
      target: "https://bff.example.test/action",
      origin: "http://127.0.0.1:4173",
      actionSecret: "server-only-secret"
    });
  });
});
