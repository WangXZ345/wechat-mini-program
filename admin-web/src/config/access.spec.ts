import { describe, expect, it } from "vitest";
import { hasAccess, ROLE_PERMISSIONS } from "./access";
import { navigationEntries } from "./navigation";
import type { AdminProfile } from "@/types/auth";

function profile(role: AdminProfile["role"]): AdminProfile {
  return {
    id: `test-${role}`,
    username: `${role}.demo`,
    displayName: role,
    role,
    roleName: role,
    permissions: ROLE_PERMISSIONS[role],
    isActive: true
  };
}

describe("role route isolation", () => {
  it("allows procurement product and inventory routes", () => {
    const procurement = profile("procurement");
    expect(hasAccess(procurement, navigationEntries.find((item) => item.path === "/products")?.access)).toBe(true);
    expect(hasAccess(procurement, navigationEntries.find((item) => item.path === "/inventory")?.access)).toBe(true);
  });

  it("blocks procurement from finance and refund routes", () => {
    const procurement = profile("procurement");
    for (const path of ["/payments", "/accounts", "/refunds"]) {
      expect(hasAccess(procurement, navigationEntries.find((item) => item.path === path)?.access)).toBe(false);
    }
    expect(hasAccess(procurement, navigationEntries.find((item) => item.path === "/audit")?.access)).toBe(false);
  });

  it("keeps finance out of product and inventory writes", () => {
    const finance = profile("finance");
    expect(finance.permissions).not.toContain("product:update");
    expect(finance.permissions).not.toContain("inventory:update");
  });

  it("allows only customer service and super admin to inspect returns", () => {
    expect(profile("customer_service").permissions).toContain("after_sale:inspect");
    expect(profile("finance").permissions).not.toContain("after_sale:inspect");
    expect(profile("procurement").permissions).not.toContain("after_sale:inspect");
    expect(profile("super_admin").permissions).toContain("*");
  });

  it("keeps Web product analytics limited to procurement and super_admin even with injected permission", () => {
    const analyticsAccess = navigationEntries.find((item) => item.path === "/analytics/products")?.access;
    for (const role of ["customer_service", "finance"] as const) {
      const injected = profile(role);
      injected.permissions = [...injected.permissions, "product:analytics:view"];
      expect(hasAccess(injected, analyticsAccess)).toBe(false);
    }
    expect(hasAccess(profile("procurement"), analyticsAccess)).toBe(true);
    expect(hasAccess(profile("super_admin"), analyticsAccess)).toBe(true);
  });
});
