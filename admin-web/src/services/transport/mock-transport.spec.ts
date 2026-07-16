import { beforeEach, describe, expect, it } from "vitest";
import { MockTransport } from "./mock-transport";

describe("MockTransport", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("rejects invalid credentials and accepts explicit demo credentials", async () => {
    const transport = new MockTransport();
    await expect(transport.login({ account: "user.demo", password: "demo-pass" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    const profile = await transport.login({ account: "procurement.demo", password: "demo-pass" });
    expect(profile.role).toBe("procurement");
    expect(profile.permissions).toContain("inventory:view");
  });

  it("sets product status explicitly and replays the same idempotent result", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const options = { idempotencyKey: "product-toggle:test", expectedVersion: 3 };
    const payload = { id: "p-001", isActive: false, expectedIsActive: true, reason: "运营下架" };
    const first = await transport.mutate("products", "toggle-status", payload, options);
    const repeated = await transport.mutate("products", "toggle-status", payload, options);
    expect(repeated).toEqual(first);
    const product = await transport.get("products", "p-001");
    expect(product.status).toBe("inactive");
    expect(product.isActive).toBe(false);
    expect(product.version).toBe(4);
  });

  it("guards product status concurrency and keeps a no-op version/event free", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });

    await expect(transport.mutate("products", "toggle-status", {
      id: "p-001",
      isActive: false,
      expectedIsActive: false,
      reason: "过期状态"
    }, { idempotencyKey: "product-toggle:stale", expectedVersion: 3 })).rejects.toMatchObject({
      code: "DATA_VERSION_CONFLICT",
      status: 409
    });

    const noOp = await transport.mutate("products", "toggle-status", {
      id: "p-003",
      isActive: false,
      expectedIsActive: false,
      reason: "保持下架"
    }, { idempotencyKey: "product-toggle:no-op", expectedVersion: 2 });
    const unchanged = await transport.get("products", "p-003");
    const events = await transport.catchUp("0");

    expect(noOp.affected).toBe(0);
    expect(unchanged.version).toBe(2);
    expect(unchanged.isActive).toBe(false);
    expect(events.events).toHaveLength(0);
  });

  it("batch-enables products with snapshots, partial failures, and idempotent replay", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const options = { idempotencyKey: "product-batch-enable:test" };
    const payload = {
      isActive: true,
      items: [
        { id: "p-003", expectedIsActive: false, expectedVersion: 2 },
        { id: " p-003 ", expectedIsActive: false, expectedVersion: 2 },
        { id: "p-001", expectedIsActive: true, expectedVersion: 3 },
        { id: "missing-product", expectedIsActive: false, expectedVersion: 1 }
      ],
      reason: "批量恢复销售"
    };

    const first = await transport.mutate("products", "batch-enable", payload, options);
    const repeated = await transport.mutate("products", "batch-enable", payload, options);
    const enabled = await transport.get("products", "p-003");
    const unchanged = await transport.get("products", "p-001");
    const events = await transport.catchUp("0");

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      affected: 1,
      changedCount: 1,
      unchangedCount: 1,
      failedCount: 1,
      failures: [{ id: "missing-product", code: "PRODUCT_NOT_FOUND" }]
    });
    expect(enabled).toMatchObject({ isActive: true, status: "active", version: 3 });
    expect(unchanged).toMatchObject({ isActive: true, status: "active", version: 3 });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({ entityId: "p-003", action: "batch-enable", version: 3 });

    await expect(transport.mutate("products", "batch-enable", {
      ...payload,
      reason: "复用不同请求"
    }, options)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      status: 409
    });
  });

  it("keeps an all-no-op batch enable version and event free", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });

    const result = await transport.mutate("products", "batch-enable", {
      isActive: true,
      items: [{ id: "p-001", expectedIsActive: true, expectedVersion: 3 }],
      reason: "保持上架"
    }, { idempotencyKey: "product-batch-enable:no-op" });
    const product = await transport.get("products", "p-001");
    const events = await transport.catchUp("0");

    expect(result).toMatchObject({ affected: 0, changedCount: 0, unchangedCount: 1, failedCount: 0, failures: [] });
    expect(product).toMatchObject({ isActive: true, status: "active", version: 3 });
    expect(events.events).toHaveLength(0);
  });

  it("projects product list and detail rows to the real BFF DTO", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const result = await transport.list<Record<string, unknown>>("products", { page: 1, pageSize: 20 });
    const first = result.items.find((item) => item.id === "p-001")!;
    const second = result.items.find((item) => item.id === "p-002")!;
    const detail = await transport.get<Record<string, unknown>>("products", "p-001");

    expect(result.items.every((item) => Array.isArray(item.tags))).toBe(true);
    expect(result.items.flatMap((item) => item.tags as string[]).every((tag) => ["新货", "瑕疵", "热销"].includes(tag))).toBe(true);
    expect(first).toMatchObject({ tags: ["热销"], status: "active", isActive: true });
    expect(second).toMatchObject({ tags: ["新货"], status: "active", isActive: true });
    expect(Object.keys(first).sort()).toEqual([
      "brand",
      "id",
      "isActive",
      "name",
      "salePriceCents",
      "sku",
      "status",
      "tags",
      "updatedAt",
      "version"
    ]);
    expect(detail).toEqual(first);
    expect(result.items.every((item) => !["isNew", "isDefective", "isHot", "searchText", "internalTags"]
      .some((field) => Object.prototype.hasOwnProperty.call(item, field)))).toBe(true);
  });

  it("enforces the batch-tag permission against the current profile", async () => {
    const roles = [
      { role: "procurement", allowed: true },
      { role: "super_admin", allowed: true },
      { role: "finance", allowed: false },
      { role: "customer_service", allowed: false }
    ] as const;
    const payload = {
      scope: "public",
      tag: "热销",
      present: true,
      items: [{ id: "p-001", expectedVersion: 3, expectedPresent: true }],
      reason: "权限矩阵"
    };

    await Promise.all(roles.map(async ({ role, allowed }) => {
      const transport = new MockTransport();
      const profile = await transport.login({ account: `${role}.demo`, password: "demo-pass" });
      const request = transport.mutate("products", "batch-tags", payload, {
        idempotencyKey: `product-batch-tags:permission:${role}`
      });
      if (allowed) {
        await expect(request).resolves.toMatchObject({ affected: 0, failedCount: 0 });
        expect(profile.permissions.some((permission) => permission === "*" || permission === "product:tag:batch_update")).toBe(true);
      } else {
        await expect(request).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      }
    }));

    const overriddenProfiles = [
      { role: "procurement", permissions: [], allowed: false },
      { role: "finance", permissions: ["product:tag:batch_update"], allowed: false },
      { role: "super_admin", permissions: [], allowed: true }
    ] as const;
    await Promise.all(overriddenProfiles.map(async ({ role, permissions, allowed }) => {
      const transport = new MockTransport();
      const profile = await transport.login({ account: `${role}.demo`, password: "demo-pass" });
      (transport as unknown as { profile: typeof profile }).profile = { ...profile, permissions: [...permissions] };
      const request = transport.mutate("products", "batch-tags", payload, {
        idempotencyKey: `product-batch-tags:overridden-permission:${role}`
      });
      if (allowed) await expect(request).resolves.toMatchObject({ affected: 0, failedCount: 0 });
      else await expect(request).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    }));
  });

  it("batch-sets a public tag with partial success and idempotent replay", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const payload = {
      scope: "public",
      tag: "新货",
      present: true,
      items: [
        { id: "p-001", expectedVersion: 3, expectedPresent: false },
        { id: "p-002", expectedVersion: 5, expectedPresent: true },
        { id: "missing-product", expectedVersion: 1, expectedPresent: false }
      ],
      reason: "季度标签复核"
    };
    const options = { idempotencyKey: "product-batch-tags:test" };

    const first = await transport.mutate("products", "batch-tags", payload, options);
    const repeated = await transport.mutate("products", "batch-tags", payload, options);
    const changed = await transport.get<Record<string, unknown>>("products", "p-001");
    const unchanged = await transport.get<Record<string, unknown>>("products", "p-002");
    const events = await transport.catchUp("0");

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      affected: 1,
      changedCount: 1,
      unchangedCount: 1,
      failedCount: 1,
      failures: [{ id: "missing-product", code: "PRODUCT_NOT_FOUND" }]
    });
    expect(Object.keys(first).sort()).toEqual([
      "affected",
      "changedCount",
      "failedCount",
      "failures",
      "message",
      "requestId",
      "unchangedCount"
    ]);
    expect(changed).toMatchObject({ version: 4, tags: ["新货", "热销"] });
    expect(unchanged).toMatchObject({ version: 5, tags: ["新货"] });
    expect([changed, unchanged].every((item) => !["isNew", "isDefective", "isHot", "searchText", "lastAction", "tagUpdatedAt"]
      .some((field) => Object.prototype.hasOwnProperty.call(item, field)))).toBe(true);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      entityId: "p-001",
      action: "batch-tags",
      version: 4,
      changedFields: ["tags", "isNew", "isDefective", "isHot", "searchText", "updatedAt"]
    });

    await expect(transport.mutate("products", "batch-tags", {
      ...payload,
      present: false
    }, options)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
    expect(await transport.mutate("products", "batch-tags", payload, options)).toEqual(first);
  });

  it("keeps an all-no-op public tag mutation version and event free", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const result = await transport.mutate("products", "batch-tags", {
      scope: "public",
      tag: "热销",
      present: true,
      items: [{ id: "p-001", expectedVersion: 3, expectedPresent: true }],
      reason: "保持热销"
    }, { idempotencyKey: "product-batch-tags:no-op" });
    const product = await transport.get<Record<string, unknown>>("products", "p-001");
    const events = await transport.catchUp("0");

    expect(result).toMatchObject({ affected: 0, changedCount: 0, unchangedCount: 1, failedCount: 0, failures: [] });
    expect(product).toMatchObject({ version: 3, tags: ["热销"] });
    expect(product).not.toHaveProperty("isHot");
    expect(product).not.toHaveProperty("tagUpdatedAt");
    expect(events.events).toHaveLength(0);
  });

  it("returns per-item failures for stale versions and stale tag presence", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const result = await transport.mutate("products", "batch-tags", {
      scope: "public",
      tag: "热销",
      present: false,
      items: [
        { id: "p-001", expectedVersion: 99, expectedPresent: true },
        { id: "p-002", expectedVersion: 5, expectedPresent: true }
      ],
      reason: "过期快照"
    }, { idempotencyKey: "product-batch-tags:conflicts" });
    const first = await transport.get<Record<string, unknown>>("products", "p-001");
    const second = await transport.get<Record<string, unknown>>("products", "p-002");

    expect(result).toMatchObject({
      affected: 0,
      changedCount: 0,
      unchangedCount: 0,
      failedCount: 2,
      failures: [
        { id: "p-001", code: "DATA_VERSION_CONFLICT" },
        { id: "p-002", code: "DATA_VERSION_CONFLICT" }
      ]
    });
    expect(first).toMatchObject({ version: 3, tags: ["热销"] });
    expect(second).toMatchObject({ version: 5, tags: ["新货"] });
  });

  it("enforces the raw batch limit and duplicate snapshot rules", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const base = {
      scope: "public",
      tag: "热销",
      present: true,
      reason: "测试"
    };
    const snapshot = { id: "p-003", expectedVersion: 2, expectedPresent: false };

    await expect(transport.mutate("products", "batch-tags", {
      ...base,
      items: Array.from({ length: 101 }, () => snapshot)
    }, { idempotencyKey: "product-batch-tags:raw-limit" })).rejects.toMatchObject({ code: "BATCH_SIZE_EXCEEDED" });

    const deduplicated = await transport.mutate("products", "batch-tags", {
      ...base,
      items: [snapshot, { ...snapshot }]
    }, { idempotencyKey: "product-batch-tags:duplicate-same" });
    expect(deduplicated).toMatchObject({ affected: 1, changedCount: 1, unchangedCount: 0, failedCount: 0 });
    expect(await transport.get<Record<string, unknown>>("products", "p-003")).toMatchObject({ version: 3, tags: ["热销"] });

    const conflictTransport = new MockTransport();
    await conflictTransport.login({ account: "procurement.demo", password: "demo-pass" });
    await expect(conflictTransport.mutate("products", "batch-tags", {
      ...base,
      items: [snapshot, { ...snapshot, expectedPresent: true }]
    }, { idempotencyKey: "product-batch-tags:duplicate-conflict" })).rejects.toMatchObject({ code: "DUPLICATE_ITEM_CONFLICT" });
    await expect(conflictTransport.mutate("products", "batch-tags", {
      ...base,
      tag: "推荐",
      items: [snapshot]
    }, { idempotencyKey: "product-batch-tags:invalid-public-tag" })).rejects.toMatchObject({ code: "PUBLIC_TAG_INVALID" });
    await expect(conflictTransport.mutate("products", "batch-tags", {
      ...base,
      items: [snapshot],
      internalTags: ["内部"]
    }, { idempotencyKey: "product-batch-tags:internal-field" })).rejects.toMatchObject({ code: "INVALID_REQUEST_BODY" });
  });

  it("rejects legacy or malformed batch-enable payloads", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });

    await expect(transport.mutate("products", "batch-enable", {
      ids: ["p-003"],
      isActive: true,
      reason: "旧契约"
    }, { idempotencyKey: "product-batch-enable:legacy" })).rejects.toMatchObject({
      code: "INVALID_REQUEST_BODY",
      status: 400
    });

    await expect(transport.mutate("products", "batch-enable", {
      isActive: true,
      items: [
        { id: "p-003", expectedIsActive: false, expectedVersion: 2 },
        { id: "p-003", expectedIsActive: true, expectedVersion: 3 }
      ],
      reason: "冲突快照"
    }, { idempotencyKey: "product-batch-enable:duplicate-conflict" })).rejects.toMatchObject({
      code: "DUPLICATE_ITEM_CONFLICT",
      status: 400
    });

    await expect(transport.mutate("products", "batch-enable", {
      isActive: true,
      items: Array.from({ length: 101 }, () => ({
        id: "p-003",
        expectedIsActive: false,
        expectedVersion: 2
      })),
      reason: "重复项超限"
    }, { idempotencyKey: "product-batch-enable:raw-limit" })).rejects.toMatchObject({
      code: "BATCH_SIZE_EXCEEDED",
      status: 400
    });
  });

  it("updates a product price with the explicit cents contract and replays idempotently", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const payload = {
      id: "p-001",
      newPriceCents: 7125,
      expectedPriceCents: 6900,
      reason: "季度改价"
    };
    const options = { idempotencyKey: "product-price:test", expectedVersion: 3 };

    const first = await transport.mutate("products", "change-price", payload, options);
    const repeated = await transport.mutate("products", "change-price", payload, options);
    const product = await transport.get("products", "p-001");

    expect(repeated).toEqual(first);
    expect(first.item).toEqual(product);
    expect(first.item).not.toHaveProperty("isNew");
    expect(first.item).not.toHaveProperty("searchText");
    expect(product.salePriceCents).toBe(7125);
    expect(product.version).toBe(4);
    await expect(transport.mutate("products", "change-price", {
      ...payload,
      newPriceCents: 7300
    }, options)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      status: 409
    });
    await expect(transport.mutate("products", "change-price", {
      ...payload,
      newPriceCents: 7300,
      expectedPriceCents: 6900
    }, { idempotencyKey: "product-price:stale", expectedVersion: 4 })).rejects.toMatchObject({
      code: "DATA_VERSION_CONFLICT",
      status: 409
    });
  });

  it("keeps a same-price mutation version and event free", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });

    const result = await transport.mutate("products", "change-price", {
      id: "p-001",
      newPriceCents: 6900,
      expectedPriceCents: 6900,
      reason: "保持原价"
    }, { idempotencyKey: "product-price:no-op", expectedVersion: 3 });
    const product = await transport.get("products", "p-001");
    const events = await transport.catchUp("0");

    expect(result.affected).toBe(0);
    expect(product.salePriceCents).toBe(6900);
    expect(product.version).toBe(3);
    expect(events.events).toHaveLength(0);
  });

  it.each([null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid integer-cent price %s", async (newPriceCents) => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });

    await expect(transport.mutate("products", "change-price", {
      id: "p-001",
      newPriceCents,
      expectedPriceCents: 6900,
      reason: "测试"
    }, { idempotencyKey: `product-price:invalid:${String(newPriceCents)}`, expectedVersion: 3 })).rejects.toMatchObject({
      code: "INVALID_PRICE"
    });
  });

  it("uses the explicit warning threshold contract instead of the legacy generic value", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    await transport.mutate("inventory", "set-warning", {
      id: "p-001",
      warningThreshold: 0,
      reason: "测试阈值"
    }, { idempotencyKey: "inventory-warning:test", expectedVersion: 3 });

    const updated = await transport.get("inventory", "p-001");
    expect(updated.warningThreshold).toBe(0);
    expect(updated.version).toBe(4);
    await expect(transport.mutate("inventory", "set-warning", {
      id: "p-002",
      value: 20,
      remark: "旧契约"
    }, { idempotencyKey: "inventory-warning:legacy", expectedVersion: 5 })).rejects.toMatchObject({
      code: "INVALID_WARNING_THRESHOLD"
    });
  });

  it("filters sync events to procurement scopes", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    await transport.catchUp("0");
    await transport.catchUp("0");
    const batch = await transport.catchUp("0");
    expect(batch.events.length).toBeGreaterThan(0);
    expect(batch.events.every((event) => ["product", "inventory"].includes(event.entityType))).toBe(true);
  });

  it("reports imported mock rows without mutating product records", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const before = await transport.list("products", { page: 1, pageSize: 20 });
    const result = await transport.mutate(
      "products",
      "import-confirm",
      { rowCount: 3, ids: ["DEMO-101", "DEMO-102", "DEMO-109"] },
      { idempotencyKey: "quote-import:test" }
    );
    const after = await transport.list("products", { page: 1, pageSize: 20 });
    expect(result.affected).toBe(3);
    expect(after.items).toEqual(before.items);
  });

  it("returns an explicit available product analytics contract in mock mode", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });

    const analytics = await transport.getProductAnalytics("30d");

    expect(analytics.status).toBe("available");
    expect(analytics.range).toBe("30d");
    expect(analytics.series).toHaveLength(10);
    expect(analytics.series.every((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date))).toBe(true);
    expect(analytics.ranking.every((item) => Number.isSafeInteger(item.currentPriceCents))).toBe(true);
  });

  it("creates and reads a strict product detail without exposing internal fields", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const input = {
      metadata: {
        name: "演示新增面霜",
        baseName: "面霜",
        imageUrl: "https://example.com/cream.jpg",
        specification: "50g",
        productionDate: "2026-07",
        description: "演示商品",
        productIndex: "",
        skuCode: "DEMO-NEW",
        keywords: ["面霜", "保湿"]
      },
      initial: { salePriceCents: 8800, stock: 30, warningThreshold: 6, isActive: false, tags: ["新货"] as ["新货"] },
      reason: "演示建档"
    };
    const first = await transport.createProduct(input, { idempotencyKey: "product-create:test" });
    const repeated = await transport.createProduct(input, { idempotencyKey: "product-create:test" });
    const productId = first.item!.id;
    const detail = await transport.getProductDetail(productId);
    const inventory = await transport.get<Record<string, unknown>>("inventory", productId);

    expect(repeated).toEqual(first);
    expect(detail).toEqual(expect.objectContaining({
      id: productId,
      version: 1,
      metadata: { ...input.metadata, productIndex: "P000001" },
      initial: input.initial
    }));
    expect(first.item?.sku).toBe("P000001");
    expect(detail).not.toHaveProperty("internalTags");
    expect(detail.metadata).not.toHaveProperty("brand");
    expect(inventory).toMatchObject({ stock: 30, warningThreshold: 6 });
  });

  it("edits metadata only, handles no-op, and guards version and identifiers", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const before = await transport.getProductDetail("p-001");
    const changedInput = {
      id: before.id,
      expectedVersion: before.version,
      metadata: { ...before.metadata, name: "演示柔雾唇釉升级版" },
      reason: "资料校正"
    };
    const result = await transport.editProduct(changedInput, { idempotencyKey: "product-edit:test", expectedVersion: before.version });
    const after = await transport.getProductDetail("p-001");

    expect(result).toMatchObject({ affected: 1, item: { name: "演示柔雾唇釉升级版", version: before.version + 1 } });
    expect(after.initial).toEqual(before.initial);
    expect(after.metadata.name).toBe("演示柔雾唇釉升级版");

    await expect(transport.editProduct(changedInput, {
      idempotencyKey: "product-edit:stale",
      expectedVersion: before.version
    })).rejects.toMatchObject({ code: "DATA_VERSION_CONFLICT", status: 409 });

    const noOpInput = { ...changedInput, expectedVersion: after.version, metadata: after.metadata };
    const noOp = await transport.editProduct(noOpInput, { idempotencyKey: "product-edit:no-op", expectedVersion: after.version });
    expect(noOp.affected).toBe(0);
    expect((await transport.getProductDetail("p-001")).version).toBe(after.version);

    const duplicateSku = await transport.editProduct({
      ...noOpInput,
      metadata: { ...noOpInput.metadata, skuCode: "DEMO-102" }
    }, { idempotencyKey: "product-edit:duplicate-sku", expectedVersion: after.version });
    expect(duplicateSku).toMatchObject({ affected: 1, item: { sku: noOpInput.metadata.productIndex } });

    const latest = await transport.getProductDetail("p-001");
    await expect(transport.editProduct({
      ...noOpInput,
      expectedVersion: latest.version,
      metadata: { ...latest.metadata, productIndex: "DEMO-102" }
    }, { idempotencyKey: "product-edit:duplicate-index", expectedVersion: latest.version })).rejects.toMatchObject({
      code: "PRODUCT_INDEX_DUPLICATE",
      status: 409
    });
  });

  it.each(["finance", "customer_service"])("rejects %s product create and edit even with a valid payload", async (role) => {
    const transport = new MockTransport();
    await transport.login({ account: `${role}.demo`, password: "demo-pass" });
    const createInput = {
      metadata: {
        name: "越权商品",
        baseName: "",
        imageUrl: "",
        specification: "",
        productionDate: "",
        description: "",
        productIndex: "",
        skuCode: "DENIED-1",
        keywords: []
      },
      initial: { salePriceCents: 0, stock: 0, warningThreshold: 0, isActive: false, tags: [] },
      reason: ""
    };
    await expect(transport.createProduct(createInput, { idempotencyKey: `product-create:${role}` })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(transport.getProductDetail("p-001")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects extra create fields before mutating mock data", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const before = await transport.list("products", { page: 1, pageSize: 20 });
    await expect(transport.createProduct({
      metadata: {
        name: "非法商品",
        baseName: "",
        imageUrl: "",
        specification: "",
        productionDate: "",
        description: "",
        productIndex: "",
        skuCode: "INVALID-1",
        keywords: [],
        internalTags: ["内部"]
      },
      initial: { salePriceCents: 0, stock: 0, warningThreshold: 0, isActive: false, tags: [] },
      reason: ""
    } as never, { idempotencyKey: "product-create:invalid" })).rejects.toMatchObject({ code: "INVALID_PRODUCT_INPUT" });
    expect((await transport.list("products", { page: 1, pageSize: 20 })).total).toBe(before.total);
  });
});

describe("MockTransport inventory adjustment", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("adjusts by delta, replays idempotently, and synchronizes product, inventory, and alerts", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    const input = {
      id: "p-002",
      mode: "delta" as const,
      delta: 30,
      expectedStock: 42,
      expectedVersion: 5,
      reason: "到货入库"
    };
    const options = { idempotencyKey: "inventory-adjust:test", expectedVersion: 5 };
    const first = await transport.adjustInventory("inventory-alerts", input, options);
    const repeated = await transport.adjustInventory("inventory-alerts", input, options);

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ affected: 1, item: { stock: 72, status: "normal", version: 6 } });
    await expect(transport.get("inventory", "p-002")).resolves.toMatchObject({ stock: 72, status: "normal", version: 6 });
    await expect(transport.get("inventory-alerts", "p-002")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(transport.getProductDetail("p-002")).resolves.toMatchObject({ version: 6, initial: { stock: 72 } });
    const events = await transport.catchUp("0");
    expect(events.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "inventory", entityId: "p-002", action: "adjust", version: 6 })
    ]));
  });

  it("creates or updates an alert when a delta crosses the warning threshold", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    await transport.adjustInventory("inventory", {
      id: "p-001",
      mode: "delta",
      delta: -250,
      expectedStock: 286,
      expectedVersion: 3,
      reason: "报损出库"
    }, { idempotencyKey: "inventory-adjust:low", expectedVersion: 3 });

    await expect(transport.get("inventory-alerts", "p-001")).resolves.toMatchObject({
      stock: 36,
      warningThreshold: 80,
      status: "low",
      version: 4
    });
  });

  it("rejects stale snapshots, invalid stock ranges, changed idempotent payloads, and the legacy generic action", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });
    await expect(transport.adjustInventory("inventory", {
      id: "p-001",
      mode: "delta",
      delta: 1,
      expectedStock: 285,
      expectedVersion: 3,
      reason: "快照过期"
    }, { idempotencyKey: "inventory-adjust:stale", expectedVersion: 3 })).rejects.toMatchObject({ code: "DATA_VERSION_CONFLICT" });

    await expect(transport.adjustInventory("inventory", {
      id: "p-001",
      mode: "delta",
      delta: -287,
      expectedStock: 286,
      expectedVersion: 3,
      reason: "无效出库"
    }, { idempotencyKey: "inventory-adjust:negative", expectedVersion: 3 })).rejects.toMatchObject({ code: "INVENTORY_STOCK_OUT_OF_RANGE" });

    const base = {
      id: "p-001",
      mode: "delta" as const,
      delta: 1,
      expectedStock: 286,
      expectedVersion: 3,
      reason: "测试入库"
    };
    await transport.adjustInventory("inventory", base, { idempotencyKey: "inventory-adjust:conflict", expectedVersion: 3 });
    await expect(transport.adjustInventory("inventory", { ...base, delta: 2 }, {
      idempotencyKey: "inventory-adjust:conflict",
      expectedVersion: 3
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });

    await expect(transport.mutate("inventory", "adjust", {
      id: "p-003",
      value: 10,
      remark: "旧契约"
    }, { idempotencyKey: "inventory-adjust:legacy", expectedVersion: 2 })).rejects.toMatchObject({
      code: "INVALID_INVENTORY_ADJUSTMENT"
    });
  });

  it("enforces inventory:update inside the transport, not only in the UI", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "finance.demo", password: "demo-pass" });
    await expect(transport.adjustInventory("inventory", {
      id: "p-001",
      mode: "delta",
      delta: 1,
      expectedStock: 286,
      expectedVersion: 3,
      reason: "越权调整"
    }, { idempotencyKey: "inventory-adjust:forbidden", expectedVersion: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("projects mock order list and detail through the same safe contract for customer service", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "customer_service.demo", password: "demo-pass" });

    const list = await transport.list("orders", { page: 1, pageSize: 20 });
    const detail = await transport.get("orders", "o-001");

    expect(list.items[0]).toMatchObject({
      id: "o-001",
      customerPhoneMasked: "138****1201",
      itemCount: expect.any(Number),
      totalQuantity: expect.any(Number),
      deliveryStatus: expect.any(String),
      updatedAt: expect.any(String)
    });
    expect(list.items[0]).not.toHaveProperty("totalAmountCents");
    expect(detail).toMatchObject({
      id: "o-001",
      customer: { phoneMasked: "138****1201" },
      shippingAddressMasked: { receiverPhoneMasked: "138****1201" }
    });
    expect(detail.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: expect.any(String), quantity: expect.any(Number) })
    ]));
    expect(detail).not.toHaveProperty("shippingAddress");
    expect(detail).not.toHaveProperty("totalAmountCents");
  });

  it("includes full contact and amount only for a mock finance profile with matching permissions", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "finance.demo", password: "demo-pass" });

    const detail = await transport.get("orders", "o-001");

    expect(detail).toMatchObject({
      totalAmountCents: 28700,
      customer: { phone: "13800001201" },
      shippingAddress: { receiverPhone: "13800001201" }
    });
  });

  it("enforces order:view inside mock list and detail transports", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });

    await expect(transport.list("orders", { page: 1, pageSize: 20 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403
    });
    await expect(transport.get("orders", "o-001")).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403
    });
  });

  it.each(["finance", "procurement"])("enforces order review permissions inside mock mutate for %s", async (role) => {
    const transport = new MockTransport();
    await transport.login({ account: `${role}.demo`, password: "demo-pass" });

    await expect(transport.mutate("orders", "review", {
      id: "o-001",
      expectedStatus: "pending_admin"
    }, { idempotencyKey: `order-review-forbidden:${role}`, expectedVersion: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403
    });

    await expect(transport.mutate("orders", "reject", {
      id: "o-001",
      expectedStatus: "pending_admin",
      reason: "越权测试"
    }, { idempotencyKey: `order-reject-forbidden:${role}`, expectedVersion: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403
    });
  });

  it("returns the same safe order review message contract in mock mode", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "customer_service.demo", password: "demo-pass" });

    const result = await transport.mutate("orders", "review", {
      id: "o-001",
      expectedStatus: "pending_admin"
    }, { idempotencyKey: "order-review-safe-message", expectedVersion: 2 });

    expect(result.message).toBe("订单已审核通过");
    expect(result.accountRecalculationPending).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it("projects mock shipment lists through the strict safe DTO", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "customer_service.demo", password: "demo-pass" });

    const list = await transport.list("shipments", { page: 1, pageSize: 20 });

    expect(list.items[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      shipmentNo: expect.any(String),
      status: expect.any(String),
      orderCount: expect.any(Number),
      totalItemCount: expect.any(Number),
      customerMasked: expect.any(String),
      trackingMasked: expect.any(String),
      orderNosPreview: expect.any(Array),
      addressConsistent: expect.any(Boolean),
      version: expect.any(Number)
    }));
    expect(list.items[0]).not.toHaveProperty("trackingNo");
    expect(list.items[0]).not.toHaveProperty("orderIds");
    expect(list.items[0]).not.toHaveProperty("shippingAddressSnapshot");
    expect(list.items[0]).not.toHaveProperty("totalOrderAmountCents");
  });

  it("matches mock shipments only by a complete shipment, order, or tracking number", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "customer_service.demo", password: "demo-pass" });

    const [byShipment, byOrder, byTracking, partial, byCustomer] = await Promise.all([
      transport.list("shipments", { page: 1, pageSize: 20, search: "DEMO-S-24071101" }),
      transport.list("shipments", { page: 1, pageSize: 20, search: "DEMO-O-24071103" }),
      transport.list("shipments", { page: 1, pageSize: 20, search: "DEMO-SHIP-001-TRACKING" }),
      transport.list("shipments", { page: 1, pageSize: 20, search: "DEMO-S-2407" }),
      transport.list("shipments", { page: 1, pageSize: 20, search: "演示客户 03" })
    ]);

    expect(byShipment.items.map((item) => item.id)).toEqual(["ship-001"]);
    expect(byOrder.items.map((item) => item.id)).toEqual(["ship-001"]);
    expect(byTracking.items.map((item) => item.id)).toEqual(["ship-001"]);
    expect(partial.items).toEqual([]);
    expect(byCustomer.items).toEqual([]);
  });

  it("rejects a mock shipment status outside the six authoritative states", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "customer_service.demo", password: "demo-pass" });

    await expect(transport.list("shipments", {
      page: 1,
      pageSize: 20,
      status: "approved"
    })).rejects.toMatchObject({ code: "SHIPMENT_QUERY_INVALID", status: 400 });
  });

  it("projects customer-service shipment detail with masked address, full tracking, notes, and no amount", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "customer_service.demo", password: "demo-pass" });

    const detail = await transport.getShipmentDetail("ship-001");

    expect(detail.shipment).toEqual(expect.objectContaining({
      id: "ship-001",
      shippingAddressMasked: expect.objectContaining({ receiverPhoneMasked: expect.stringContaining("****") }),
      trackingNo: expect.any(String),
      adminRemark: expect.any(String)
    }));
    expect(detail.shipment).not.toHaveProperty("shippingAddress");
    expect(detail.shipment).not.toHaveProperty("totalOrderAmountCents");
    expect(detail.orders[0]).not.toHaveProperty("totalAmountCents");
    expect(detail.logs[0]).not.toHaveProperty("operatorOpenid");
  });

  it("does not let finance inherit a full shipment address from customer permissions", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "finance.demo", password: "demo-pass" });

    const detail = await transport.getShipmentDetail("ship-001");

    expect(detail.shipment.shippingAddress).toBeUndefined();
    expect(detail.shipment.shippingAddressMasked).toBeDefined();
    expect(detail.shipment.trackingNo).toBeUndefined();
    expect(detail.shipment.trackingMasked).toBeDefined();
    expect(detail.shipment.totalOrderAmountCents).toBe(118_800);
    expect(detail.orders[0]?.totalAmountCents).toBe(118_800);
    expect(detail.shipment.adminRemark).toBeUndefined();
  });

  it("projects explicit super-admin shipment privileges without exposing a full phone", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "super_admin.demo", password: "demo-pass" });

    const detail = await transport.get("shipments", "ship-001");
    const shipment = detail.shipment as Record<string, unknown>;

    expect(shipment.shippingAddress).toEqual(expect.objectContaining({
      receiverPhoneMasked: expect.stringContaining("****"),
      detailAddress: expect.any(String)
    }));
    expect(shipment.shippingAddress).not.toHaveProperty("receiverPhone");
    expect(shipment.trackingNo).toBeDefined();
    expect(shipment.totalOrderAmountCents).toBe(118_800);
  });

  it("enforces shipment:view and the allowed role boundary inside mock transport", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "procurement.demo", password: "demo-pass" });

    await expect(transport.list("shipments", { page: 1, pageSize: 20 })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(transport.getShipmentDetail("ship-001")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it.each(["finance", "super_admin"])("allows %s to read strict mock account summaries and details", async (role) => {
    const transport = new MockTransport();
    await transport.login({ account: `${role}.demo`, password: "demo-pass" });

    const list = await transport.list("accounts", { page: 1, pageSize: 20 });
    expect(list.items[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      customerMasked: expect.stringContaining("****"),
      receivableCents: expect.any(Number),
      receivedCents: expect.any(Number),
      unpaidAmountCents: expect.any(Number),
      pendingConfirmAmountCents: expect.any(Number),
      status: expect.stringMatching(/^(unpaid|pending_confirm|abnormal|settled)$/)
    }));
    expect(list.items[0]).not.toHaveProperty("userId");
    expect(list.items[0]).not.toHaveProperty("phone");

    const detail = await transport.getAccountDetail(String(list.items[0]?.id));
    expect(detail.account.id).toBe(list.items[0]?.id);
    expect(detail.orders[0]).toEqual(expect.objectContaining({ totalAmountCents: expect.any(Number) }));
    expect(detail.logs[0]).toEqual(expect.objectContaining({ summary: expect.any(String) }));
    expect(JSON.stringify(detail)).not.toContain("13800138000");
    expect(JSON.stringify(detail)).not.toContain("openid");
  });

  it.each(["customer_service", "procurement"])("rejects %s account list and detail reads", async (role) => {
    const transport = new MockTransport();
    await transport.login({ account: `${role}.demo`, password: "demo-pass" });

    await expect(transport.list("accounts", { page: 1, pageSize: 20 })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(transport.getAccountDetail("acct-001")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("requires explicit customer:view_account even for a mock finance profile", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "finance.demo", password: "demo-pass" });
    const profile = await transport.getCurrentProfile();
    (transport as unknown as { profile: typeof profile }).profile = { ...profile, permissions: [] };

    await expect(transport.list("accounts", { page: 1, pageSize: 20 })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(transport.getAccountDetail("acct-001")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it.each(["finance", "super_admin"])("allows %s to confirm a current payment and safely replay the same key", async (role) => {
    const transport = new MockTransport();
    await transport.login({ account: `${role}.demo`, password: "demo-pass" });
    const list = await transport.list("payments", { page: 1, pageSize: 20, status: "pending_confirm" });
    const row = list.items[0]!;
    expect(row).toEqual(expect.objectContaining({ proofLabel: "已提交凭证", proofCount: expect.any(Number), amountCents: expect.any(Number), version: expect.any(Number), updatedAt: expect.any(String) }));
    expect(list.items[0]).not.toHaveProperty("paymentScreenshotUrl");
    await expect(transport.get("payments", String(row.id))).resolves.toEqual(expect.objectContaining({ id: row.id }));
    const payload = {
      id: row.id,
      expectedStatus: "pending_confirm",
      expectedVersion: row.version,
      expectedUpdatedAt: row.updatedAt,
      reason: "已核对到账"
    };
    const options = { idempotencyKey: `payment-confirm:${role}`, expectedVersion: Number(row.version) };
    const first = await transport.mutate("payments", "confirm", {
      ...payload,
      id: `  ${String(row.id)}  `,
      reason: "  已核对到账  "
    }, options);
    const replay = await transport.mutate("payments", "confirm", payload, options);
    const updated = await transport.get("payments", String(row.id));

    expect(first).toMatchObject({ affected: 1, reused: false, decision: "confirm", item: { id: row.id, status: "paid", version: Number(row.version) + 1 } });
    expect(replay).toMatchObject({ affected: 0, reused: true, decision: "confirm", item: first.item });
    expect(Object.keys(first).sort()).toEqual(["accountRecalculationPending", "affected", "decision", "item", "message", "requestId", "reused"]);
    expect(updated).toMatchObject({ id: row.id, status: "paid", version: Number(row.version) + 1 });
    expect(JSON.stringify(first)).not.toMatch(/amount|proof|openid|orderId|userId|transaction/i);
  });

  it("rejects a current payment with a trimmed reason and the strict safe result", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "finance.demo", password: "demo-pass" });
    const row = (await transport.list("payments", { page: 1, pageSize: 20, status: "pending_confirm" })).items[0]!;

    const result = await transport.mutate("payments", "reject", {
      id: row.id,
      expectedStatus: "pending_confirm",
      expectedVersion: row.version,
      expectedUpdatedAt: row.updatedAt,
      reason: "  凭证不清晰  "
    }, { idempotencyKey: "payment-reject:test", expectedVersion: Number(row.version) });

    expect(result).toMatchObject({ affected: 1, reused: false, decision: "reject", item: { id: row.id, status: "rejected", version: Number(row.version) + 1 } });
    await expect(transport.get("payments", String(row.id))).resolves.toMatchObject({ status: "rejected" });
  });

  it.each([
    { role: "finance", active: true, permissions: [], action: "confirm" },
    { role: "finance", active: true, permissions: ["payment:confirm"], action: "reject" },
    { role: "customer_service", active: true, permissions: ["payment:confirm", "payment:update_status"], action: "confirm" },
    { role: "procurement", active: true, permissions: ["payment:confirm", "payment:update_status"], action: "reject" },
    { role: "finance", active: false, permissions: ["payment:confirm", "payment:update_status"], action: "confirm" }
  ])("rejects an unauthorized payment mutation %#", async ({ role, active, permissions, action }) => {
    const transport = new MockTransport();
    const profile = await transport.login({ account: `${role}.demo`, password: "demo-pass" });
    (transport as unknown as { profile: typeof profile }).profile = { ...profile, isActive: active, permissions };
    const payload = {
      id: "pay-001",
      expectedStatus: "pending_confirm",
      expectedVersion: 1,
      expectedUpdatedAt: "2026-07-13T08:05:00.000Z",
      reason: action === "reject" ? "凭证无效" : ""
    };

    await expect(transport.mutate("payments", action, payload, {
      idempotencyKey: `payment-forbidden:${role}:${action}`,
      expectedVersion: 1
    })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("guards payment request fields, snapshot version/time/state, and idempotency payload changes", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "finance.demo", password: "demo-pass" });
    const row = (await transport.list("payments", { page: 1, pageSize: 20, status: "pending_confirm" })).items[0]!;
    const payload = {
      id: row.id,
      expectedStatus: "pending_confirm",
      expectedVersion: row.version,
      expectedUpdatedAt: row.updatedAt,
      reason: "已核对"
    };

    await expect(transport.mutate("payments", "confirm", { ...payload, orderId: "forbidden" }, {
      idempotencyKey: "payment-invalid:field", expectedVersion: Number(row.version)
    })).rejects.toMatchObject({ code: "INVALID_PAYMENT_MUTATION", status: 400 });
    await expect(transport.mutate("payments", "confirm", { ...payload, expectedVersion: Number(row.version) + 1 }, {
      idempotencyKey: "payment-invalid:version", expectedVersion: Number(row.version) + 1
    })).rejects.toMatchObject({ code: "DATA_VERSION_CONFLICT", status: 409 });
    await expect(transport.mutate("payments", "confirm", { ...payload, expectedUpdatedAt: "2026-07-13T08:05:01.000Z" }, {
      idempotencyKey: "payment-invalid:time", expectedVersion: Number(row.version)
    })).rejects.toMatchObject({ code: "DATA_VERSION_CONFLICT", status: 409 });

    const options = { idempotencyKey: "payment-conflict:key", expectedVersion: Number(row.version) };
    await transport.mutate("payments", "confirm", payload, options);
    await expect(transport.mutate("payments", "confirm", { ...payload, reason: "changed" }, options))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
    await expect(transport.mutate("payments", "confirm", payload, { idempotencyKey: "payment-after-paid", expectedVersion: Number(row.version) }))
      .rejects.toMatchObject({ code: "PAYMENT_STATE_CONFLICT", status: 409 });
  });

  it("keeps unrelated payment write actions closed", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "finance.demo", password: "demo-pass" });
    await expect(transport.mutate("payments", "partial", { id: "pay-001" }, { idempotencyKey: "payment-partial:closed" }))
      .rejects.toMatchObject({ code: "SERVICE_NOT_MIGRATED", status: 501 });
  });

  it.each(["customer_service", "procurement"]) ("rejects %s payment reads", async (role) => {
    const transport = new MockTransport();
    await transport.login({ account: `${role}.demo`, password: "demo-pass" });
    await expect(transport.list("payments", { page: 1, pageSize: 20 })).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("aligns mock account status filters and whitelist search with the HTTP contract", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "finance.demo", password: "demo-pass" });

    for (const status of ["unpaid", "pending_confirm", "abnormal", "settled"] as const) {
      const result = await transport.list("accounts", { page: 1, pageSize: 20, status });
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((item) => item.status === status)).toBe(true);
    }
    const byName = await transport.list("accounts", { page: 1, pageSize: 20, search: "演示客户 02" });
    const byMaskedPhone = await transport.list("accounts", { page: 1, pageSize: 20, search: "2302" });
    const internal = await transport.list("accounts", { page: 1, pageSize: 20, search: "内部风险命中" });
    expect(byName.items.map((item) => item.id)).toEqual(["acct-002"]);
    expect(byMaskedPhone.items.map((item) => item.id)).toEqual(["acct-002"]);
    expect(internal.items).toEqual([]);

    await expect(transport.list("accounts", { page: 1, pageSize: 20, status: "overdue" })).rejects.toMatchObject({
      code: "ACCOUNT_QUERY_INVALID", status: 400
    });
    await expect(transport.list("accounts", { page: 1, pageSize: 20, search: "x".repeat(81) })).rejects.toMatchObject({
      code: "ACCOUNT_QUERY_INVALID", status: 400
    });
  });

  it("keeps all mock account writes and exports fail closed", async () => {
    const transport = new MockTransport();
    await transport.login({ account: "finance.demo", password: "demo-pass" });

    for (const action of ["recalculate", "settle", "edit", "export"]) {
      await expect(transport.mutate("accounts", action, { id: "acct-001" }, {
        idempotencyKey: `account-disabled:${action}`
      })).rejects.toMatchObject({ code: "SERVICE_NOT_MIGRATED", status: 501 });
    }
  });
});
