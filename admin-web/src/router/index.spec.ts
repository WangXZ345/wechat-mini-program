import { describe, expect, it, vi } from "vitest";
import { router } from "./index";

vi.mock("@/layouts/AdminLayout.vue", () => ({ default: { template: "<router-view />" } }));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => ({ bootstrap: vi.fn(), isAuthenticated: false, profile: null }) }));

describe("shipment detail route", () => {
  it("registers a dedicated read-only detail page guarded by shipment:view", () => {
    const route = router.getRoutes().find((item) => item.name === "shipment-detail");

    expect(route?.path).toBe("/shipments/:id");
    expect(route?.meta.requiresAuth).toBe(true);
    expect(route?.meta.access).toEqual({ permissionsAny: ["shipment:view"] });
  });
});

describe("account detail route", () => {
  it("registers a dedicated read-only detail page guarded by customer:view_account", () => {
    const route = router.getRoutes().find((item) => item.name === "account-detail");

    expect(route?.path).toBe("/accounts/:id");
    expect(route?.meta.requiresAuth).toBe(true);
    expect(route?.meta.sensitive).toBe(true);
    expect(route?.meta.access).toEqual({ permissionsAny: ["customer:view_account"] });
  });
});
