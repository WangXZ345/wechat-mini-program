import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/services/http/api-error";

const transportMock = vi.hoisted(() => ({
  getCurrentProfile: vi.fn(),
  login: vi.fn(),
  logout: vi.fn()
}));

vi.mock("@/services/transport", () => ({
  transport: {
    mode: "http",
    getCurrentProfile: transportMock.getCurrentProfile,
    login: transportMock.login,
    logout: transportMock.logout
  }
}));

import { useAuthStore } from "./auth";

const profile = {
  id: "admin-1",
  username: "finance.test",
  displayName: "测试财务",
  role: "finance" as const,
  roleName: "财务",
  permissions: ["payment:confirm"],
  isActive: true
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("auth store session lifecycle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    transportMock.getCurrentProfile.mockReset();
    transportMock.login.mockReset();
    transportMock.logout.mockReset();
  });

  it("keeps first-visit AUTH_REQUIRED bootstrap quiet", async () => {
    transportMock.getCurrentProfile.mockRejectedValue(new ApiError("请先登录", "AUTH_REQUIRED", 401));
    const auth = useAuthStore();

    await auth.bootstrap();

    expect(auth.initialized).toBe(true);
    expect(auth.profile).toBeNull();
    expect(auth.error).toBeNull();
  });

  it("clears the profile and exposes a session-expired prompt", async () => {
    transportMock.login.mockResolvedValue(profile);
    const auth = useAuthStore();
    await auth.login({ account: "finance.test", password: "Strong-Admin-2026!" });
    expect(auth.isAuthenticated).toBe(true);

    auth.invalidateSession({ code: "SESSION_REVOKED", message: "登录状态已失效，请重新登录", status: 401 });

    expect(auth.isAuthenticated).toBe(false);
    expect(auth.profile).toBeNull();
    expect(auth.error).toMatchObject({
      code: "SESSION_REVOKED",
      message: "登录状态已失效，请重新登录",
      status: 401
    });
  });

  it("clears local UI state before remote logout settles", async () => {
    const remoteLogout = deferred<void>();
    transportMock.login.mockResolvedValue(profile);
    transportMock.logout.mockReturnValue(remoteLogout.promise);
    const auth = useAuthStore();
    await auth.login({ account: "finance.test", password: "Strong-Admin-2026!" });

    const logout = auth.logout();

    expect(auth.profile).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.initialized).toBe(true);
    expect(auth.authenticating).toBe(false);
    expect(auth.error).toBeNull();

    remoteLogout.resolve();
    await expect(logout).resolves.toBeUndefined();
  });

  it("ignores a login response that arrives after local logout", async () => {
    const remoteLogin = deferred<typeof profile>();
    transportMock.login.mockReturnValue(remoteLogin.promise);
    transportMock.logout.mockResolvedValue(undefined);
    const auth = useAuthStore();

    const login = auth.login({ account: "finance.test", password: "Strong-Admin-2026!" });
    await auth.logout();
    remoteLogin.resolve(profile);

    await expect(login).rejects.toMatchObject({ code: "AUTH_TRANSITION_SUPERSEDED", status: 409 });
    expect(auth.profile).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.error).toBeNull();
  });
});
