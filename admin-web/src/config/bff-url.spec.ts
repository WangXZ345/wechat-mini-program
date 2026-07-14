import { describe, expect, it } from "vitest";
import { normalizeApiBaseUrl, normalizeProxyOrigin, normalizeProxyTarget } from "./bff-url";

describe("BFF URL security", () => {
  it("accepts and normalizes a single-slash same-origin API path", () => {
    expect(normalizeApiBaseUrl("/api/admin/v1/", "test")).toEqual({
      value: "/api/admin/v1",
      sameOrigin: true
    });
  });

  it.each([
    "//evil.example/api",
    "/api/admin/v1?next=evil",
    "/api/admin/v1#fragment",
    "/api\\admin\\v1",
    "api/admin/v1"
  ])("rejects an ambiguous or relative API value: %s", (value) => {
    expect(() => normalizeApiBaseUrl(value, "test")).toThrow();
  });

  it("accepts HTTPS absolute API URLs without credentials, query, or hash", () => {
    expect(normalizeApiBaseUrl("https://bff.example.test/admin/v1/", "test")).toEqual({
      value: "https://bff.example.test/admin/v1",
      sameOrigin: false
    });
  });

  it.each([
    "https://admin:secret@bff.example.test/admin/v1",
    "https://bff.example.test/admin/v1?tenant=1",
    "https://bff.example.test/admin/v1#fragment",
    "ftp://bff.example.test/admin/v1",
    "https:\\bff.example.test\\admin\\v1"
  ])("rejects an unsafe absolute API URL: %s", (value) => {
    expect(() => normalizeApiBaseUrl(value, "test")).toThrow();
  });

  it("allows HTTP only for an explicit test loopback endpoint", () => {
    expect(normalizeApiBaseUrl("http://127.0.0.1:8787/admin/v1", "test").value)
      .toBe("http://127.0.0.1:8787/admin/v1");
    expect(normalizeProxyTarget("http://localhost:8788/action", "test"))
      .toBe("http://localhost:8788/action");
  });

  it.each([
    ["http://bff.example.test/admin/v1", "test"],
    ["http://127.0.0.1:8787/admin/v1", "staging"],
    ["http://localhost:8787/admin/v1", "production"]
  ] as const)("rejects non-secure remote or non-test URL %s in %s", (value, appEnv) => {
    expect(() => normalizeApiBaseUrl(value, appEnv)).toThrow(/HTTPS/);
  });

  it("requires a path-free, credential-free proxy origin", () => {
    expect(normalizeProxyOrigin("http://127.0.0.1:4173", "test")).toBe("http://127.0.0.1:4173");
    expect(() => normalizeProxyOrigin("https://admin:secret@web.example.test", "test")).toThrow(/credentials/);
    expect(() => normalizeProxyOrigin("https://web.example.test/admin", "test")).toThrow(/must not contain a path/);
    expect(() => normalizeProxyOrigin("https://web.example.test?x=1", "test")).toThrow(/query string/);
  });
});
