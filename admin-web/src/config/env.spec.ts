import { describe, expect, it } from "vitest";
import { env, isRealDataMode, useMockTransport } from "./env";

describe("test environment data mode", () => {
  it("uses the explicit real test configuration", () => {
    expect(env.appEnv).toBe("test");
    expect(env.dataMode).toBe("real");
    expect(env.cloudbaseEnvId).toBe("cloud1-d7g4mbc5r2fac4a77");
    expect(env.apiBaseUrl).toBe("/api/admin/v1");
    expect(env.realtimeMode).toBe("polling");
    expect(isRealDataMode).toBe(true);
    expect(useMockTransport).toBe(false);
  });
});
