const test = require("node:test");
const assert = require("node:assert/strict");
const permissionModel = require("../permissions");
const {
  ApiError,
  RESOURCE_POLICIES,
  normalizePagination,
  getResourcePolicy,
  resolveResourceDocumentId,
  getMutationPermission,
  boundedPermissions,
  hasPermission,
  assertPermission,
  projectResource,
  buildDashboardData,
  emptyProductAnalyticsData,
  allowedSyncEntityTypes,
  syncQuerySpec,
  nextSyncCursor,
  parseHttpRoute,
  successEnvelope,
  errorEnvelope
} = require("../lib/core");

test("resource registry contains the complete Web read surface", () => {
  assert.deepEqual(Object.keys(RESOURCE_POLICIES), [
    "dashboard", "products", "inventory", "inventory-alerts", "orders", "payments", "accounts",
    "shipments", "after-sales", "refunds", "admins", "audit", "analytics", "imports", "settings"
  ]);
});

test("settings resource maps the public singleton to the existing fixed document", () => {
  const policy = getResourcePolicy("settings");
  assert.equal(policy.collection, "settings");
  assert.equal(policy.fixedDocumentId, "system_settings");
  assert.equal(policy.publicDocumentId, "system");
  assert.equal(resolveResourceDocumentId("settings", "system"), "system_settings");
  assert.throws(
    () => resolveResourceDocumentId("settings", "payment_methods"),
    (err) => err.code === "NOT_FOUND" && err.statusCode === 404
  );
  assert.equal(resolveResourceDocumentId("orders", "order-1"), "order-1");
});

test("settings projection keeps a stable public id and strict defaults", () => {
  const projected = projectResource("settings", {
    _id: "system_settings",
    maxPaymentScreenshotCount: 7,
    passwordPepper: "secret",
    updatedByOpenid: "secret-openid"
  }, { role: "super_admin", status: "active", permissions: ["*"] }, true);
  assert.deepEqual(projected, {
    id: "system",
    version: 0,
    enableOfflineQrPayment: true,
    enableBankTransfer: true,
    enableWechatPay: false,
    requirePaymentProofForOfflinePayment: true,
    allowMultiplePaymentRecords: true,
    maxPaymentScreenshotCount: 7,
    lowStockDefaultThreshold: 50,
    sessionIdleMinutes: 30,
    updatedAt: null
  });
  assert.equal(projected.sessionIdleMinutes, 30);

  const explicitlyDisabled = projectResource("settings", {
    _id: "system_settings",
    enableOfflineQrPayment: false,
    enableBankTransfer: false,
    allowMultiplePaymentRecords: false
  }, { role: "super_admin", status: "active", permissions: ["*"] }, true);
  assert.equal(explicitlyDisabled.enableOfflineQrPayment, false);
  assert.equal(explicitlyDisabled.enableBankTransfer, false);
  assert.equal(explicitlyDisabled.allowMultiplePaymentRecords, false);
});

test("imports projection reads canonical nested counts and omits internal execution metadata", () => {
  const projected = projectResource("imports", {
    _id: "import-1",
    fileName: "inventory.csv",
    type: "inventory",
    status: "partial",
    counts: { total: 60, success: 50, failed: 3, skipped: 7, retryable: 10 },
    operatorId: "secret-admin",
    dedupeKey: "secret-dedupe",
    mapping: { name: "商品名称" }
  }, { role: "procurement", status: "active", permissions: ["inventory:import"] }, true);

  assert.equal(projected.totalRows, 60);
  assert.equal(projected.successRows, 50);
  assert.equal(projected.failedRows, 3);
  assert.equal(projected.skippedRows, 7);
  assert.equal(Object.hasOwn(projected, "operatorId"), false);
  assert.equal(Object.hasOwn(projected, "dedupeKey"), false);
  assert.equal(Object.hasOwn(projected, "mapping"), false);
});

test("role boundaries remove injected procurement finance permissions", () => {
  const permissions = boundedPermissions({
    role: "procurement",
    permissions: ["inventory:view", "product:view", "payment:confirm", "refund:view", "customer:view_account"]
  }, permissionModel);
  assert.equal(permissions.includes("inventory:view"), true);
  assert.equal(permissions.includes("product:view"), true);
  assert.equal(permissions.includes("payment:confirm"), false);
  assert.equal(permissions.includes("refund:view"), false);
  assert.equal(permissions.includes("customer:view_account"), false);
  const principal = { role: "procurement", status: "active", permissions };
  assert.equal(hasPermission(principal, "inventory:view"), true);
  assert.throws(() => assertPermission(principal, "payment:view_screenshot"), (err) => err.code === "FORBIDDEN");
});

test("customer service role includes the bounded return inspection permission", () => {
  assert.equal(permissionModel.permissionsForRole("customer_service").includes("after_sale:inspect"), true);
});

test("payment, order and admin projections are strict whitelists", () => {
  const finance = { role: "finance", status: "active", permissions: ["payment:view_screenshot", "order:view"] };
  const payment = projectResource("payments", {
    _id: "payment-1",
    orderId: "order-1",
    paidAmount: 12345,
    paymentScreenshotUrl: "cloud://secret-proof",
    screenshotUrls: ["cloud://secret-proof"],
    wechatPayTransactionId: "secret-transaction",
    userOpenid: "secret-openid",
    refundAccountInfo: { account: "secret-account" },
    paymentStatus: "pending_confirm"
  }, finance, true);
  assert.equal(payment.amountCents, 12345);
  assert.equal(payment.orderNo, "");
  assert.equal(JSON.stringify(payment).includes("order-1"), false);
  assert.equal(payment.proofLabel, "已提交凭证");
  for (const key of ["orderId", "paymentScreenshotUrl", "screenshotUrls", "wechatPayTransactionId", "userOpenid", "refundAccountInfo"]) {
    assert.equal(Object.hasOwn(payment, key), false);
  }

  const order = projectResource("orders", {
    _id: "order-1",
    orderNo: "NO-1",
    customerName: "张三",
    phone: "13800138000",
    shippingAddressSnapshot: { detail: "完整地址" },
    shippingAddressMasked: "上海市***",
    totalAmount: 100,
    internalTags: ["secret"],
    adminNote: "secret-note"
  }, finance, true);
  assert.equal(order.customerMasked, "张*");
  assert.equal(order.shippingAddressMasked, "地址已脱敏");
  assert.equal(Object.hasOwn(order, "phone"), false);
  assert.equal(Object.hasOwn(order, "shippingAddressSnapshot"), false);
  assert.equal(Object.hasOwn(order, "internalTags"), false);
  assert.equal(Object.hasOwn(order, "adminRemark"), false);

  const admin = projectResource("admins", {
    _id: "admin-1",
    name: "管理员",
    username: "admin",
    role: "finance",
    passwordHash: "secret",
    passwordSalt: "secret",
    openid: "secret-openid"
  }, { role: "super_admin", status: "active", permissions: ["*"] }, true);
  for (const key of ["passwordHash", "passwordSalt", "openid"]) assert.equal(Object.hasOwn(admin, key), false);

  const audit = projectResource("audit", {
    _id: "log-1",
    operatorId: "internal-admin-id",
    action: "update",
    targetType: "product"
  }, { role: "super_admin", status: "active", permissions: ["*"] }, true);
  assert.equal(audit.operator, "管理员");
  assert.equal(JSON.stringify(audit).includes("internal-admin-id"), false);
  assert.equal(Object.hasOwn(audit, "targetId"), false);
  assert.equal(Object.hasOwn(audit, "description"), false);
});

test("product and inventory projections prefer canonical product identifiers", () => {
  const principal = { role: "procurement", status: "active", permissions: ["product:view", "inventory:view"] };
  const row = {
    _id: "product-1",
    name: "商品",
    productIndex: "P000123",
    skuCode: "SKU-NEW",
    sku: "SKU-OLD",
    productCode: "CODE-OLD",
    stock: 8,
    warningStock: 3,
    stockStatus: "normal",
    isActive: true,
    version: 4
  };
  assert.equal(projectResource("products", row, principal, false).sku, "P000123");
  const inventory = projectResource("inventory", row, principal, false);
  assert.equal(inventory.sku, "P000123");
  assert.equal(inventory.isActive, true);
});

test("product projection exposes the authoritative active flag for optimistic status writes", () => {
  const principal = { role: "procurement", status: "active", permissions: ["product:view"] };
  const active = projectResource("products", { _id: "product-1", isActive: true, version: 4 }, principal);
  const inactiveDraft = projectResource("products", { _id: "product-2", isActive: false, status: "draft", version: 5 }, principal);
  const activeDraft = projectResource("products", { _id: "product-3", isActive: true, status: "draft", version: 6 }, principal);
  const activeWithStaleInactive = projectResource("products", { _id: "product-4", isActive: true, status: "inactive", version: 7 }, principal);
  const legacyWithStaleInactive = projectResource("products", { _id: "product-5", status: "inactive", dataVersion: 2 }, principal);
  const legacyDraft = projectResource("products", { _id: "product-6", status: "draft", dataVersion: 3 }, principal);
  assert.equal(active.isActive, true);
  assert.equal(active.status, "active");
  assert.equal(inactiveDraft.isActive, false);
  assert.equal(inactiveDraft.status, "inactive");
  assert.equal(activeDraft.isActive, true);
  assert.equal(activeDraft.status, "draft");
  assert.equal(activeWithStaleInactive.isActive, true);
  assert.equal(activeWithStaleInactive.status, "active");
  assert.equal(legacyWithStaleInactive.isActive, true);
  assert.equal(legacyWithStaleInactive.status, "active");
  assert.equal(legacyWithStaleInactive.version, 2);
  assert.equal(legacyDraft.isActive, true);
  assert.equal(legacyDraft.status, "draft");
});

test("analytics projection and search prefer canonical product identifiers", () => {
  const principal = { role: "super_admin", status: "active", permissions: ["product:analytics:view"] };
  const row = {
    _id: "product-analytics-1",
    name: "分析商品",
    productIndex: "P000777",
    skuCode: "SKU-CANONICAL",
    sku: "SKU-LEGACY",
    productCode: "CODE-LEGACY"
  };
  assert.equal(projectResource("analytics", row, principal).sku, "P000777");
  assert.deepEqual(getResourcePolicy("analytics").searchFields, [
    "name", "productName", "brand", "productIndex", "skuCode", "sku", "productCode", "searchText"
  ]);
});

test("HTTP routes match AdminTransport generic paths", () => {
  assert.deepEqual(parseHttpRoute("/api/admin/v1/auth/profile", "GET"), { action: "profile" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/dashboard", "GET"), { action: "dashboard" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/analytics/products", "GET"), { action: "productAnalytics" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/orders", "GET"), { action: "list", resource: "orders" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/orders/order-1", "GET"), { action: "get", resource: "orders", id: "order-1" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/imports/import-1/items", "GET"), { action: "importItems", resource: "imports", id: "import-1" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/payments", "GET"), { action: "paymentList" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/payments/payment-1", "GET"), { action: "paymentDetail", id: "payment-1" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/settings/system", "GET"), { action: "get", resource: "settings", id: "system" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/orders/review", "POST"), { action: "mutate", resource: "orders", mutationAction: "review" });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/sync/events", "GET"), { action: "sync" });
  assert.throws(() => parseHttpRoute("/api/admin/v1/orders", "DELETE"), (err) => err.code === "ROUTE_NOT_FOUND");
  for (const [path, method] of [
    ["/api/admin/v1/auth/profile", "POST"],
    ["/api/admin/v1/auth/profile/extra", "GET"],
    ["/api/admin/v1/sync/events", "POST"],
    ["/api/admin/v1/sync/events/extra", "GET"],
    ["/api/admin/v1/orders/order-1/extra", "GET"],
    ["/api/admin/v1/orders/review/extra", "POST"],
    ["/api/admin/v1/unknown", "GET"]
  ]) {
    assert.throws(() => parseHttpRoute(path, method), (err) => err.code === "ROUTE_NOT_FOUND" && err.statusCode === 404);
  }
});

test("dashboard contract only includes metrics allowed for the current role", () => {
  const principal = {
    role: "procurement",
    status: "active",
    permissions: ["product:view", "inventory:view", "inventory:import"]
  };
  const dashboard = buildDashboardData({
    productCount: 12,
    inventoryAlertCount: 3,
    pendingImportCount: 2,
    pendingPaymentCount: 99,
    pendingRefundCount: 88,
    accountCount: 77,
    topProducts: [{ name: "商品 A", sku: "SKU-A", value: 6, change: 0 }]
  }, principal, new Date("2026-07-11T00:00:00.000Z"));
  assert.deepEqual(dashboard.metrics.map((item) => item.key), ["products", "inventory-alerts", "imports"]);
  assert.deepEqual(dashboard.tasks.map((item) => item.id), ["inventory-alerts", "imports"]);
  assert.equal(dashboard.topProducts.length, 1);
  assert.equal(JSON.stringify(dashboard).includes("payment"), false);
  assert.equal(JSON.stringify(dashboard).includes("refund"), false);
  assert.equal(JSON.stringify(dashboard).includes("account"), false);
});

test("mutation routes require an explicit action permission before migration", () => {
  assert.equal(getMutationPermission("orders", "review"), "order:review");
  assert.equal(getMutationPermission("payments", "confirm"), "payment:confirm");
  assert.equal(getMutationPermission("after-sales", "approve"), "after_sale:review");
  assert.deepEqual(parseHttpRoute("/api/admin/v1/refunds/process", "POST"), {
    action: "mutate", resource: "refunds", mutationAction: "process"
  });
  assert.deepEqual(parseHttpRoute("/api/admin/v1/refunds/reject", "POST"), {
    action: "mutate", resource: "refunds", mutationAction: "reject"
  });
  assert.equal(getMutationPermission("refunds", "process"), "refund:process");
  assert.equal(getMutationPermission("refunds", "reject"), "refund:process");
  assert.throws(() => getMutationPermission("refunds", "create"), (err) => (
    err.code === "MUTATION_NOT_SUPPORTED" && err.statusCode === 404
  ));
  assert.throws(() => getMutationPermission("orders", "unknown"), (err) => err.code === "MUTATION_NOT_SUPPORTED");

  const finance = { role: "finance", status: "active", permissions: ["after_sale:view", "refund:process", "payment:confirm"] };
  assert.throws(() => assertPermission(finance, getMutationPermission("after-sales", "approve")), (err) => err.code === "FORBIDDEN");
  assert.doesNotThrow(() => assertPermission(finance, getMutationPermission("payments", "confirm")));
  assert.doesNotThrow(() => assertPermission(finance, getMutationPermission("refunds", "process")));
});

test("product analytics contract rejects fake history and normalizes range", () => {
  const analytics = emptyProductAnalyticsData("invalid", new Date("2026-07-11T00:00:00.000Z"));
  assert.equal(analytics.range, "30d");
  assert.equal(analytics.status, "unavailable");
  assert.deepEqual(analytics.summary, []);
  assert.deepEqual(analytics.series, []);
  assert.deepEqual(analytics.ranking, []);
});

test("pagination defaults to 20, caps at 100 and validates cursors", () => {
  assert.deepEqual(normalizePagination({}), { page: 1, pageSize: 20, skip: 0 });
  assert.deepEqual(normalizePagination({ page: 3, pageSize: 500 }), { page: 3, pageSize: 100, skip: 200 });
  assert.deepEqual(normalizePagination({ page: -3, pageSize: 0 }), { page: 1, pageSize: 20, skip: 0 });
  assert.throws(() => normalizePagination({ cursor: "not-a-cursor" }), (err) => err.code === "INVALID_CURSOR");
});

test("sync cursor advances and procurement excludes financial entities", () => {
  const procurement = {
    role: "procurement",
    status: "active",
    permissions: ["product:view", "inventory:view", "payment:view_screenshot", "refund:view", "customer:view_account"]
  };
  const bounded = { ...procurement, permissions: boundedPermissions(procurement, permissionModel) };
  assert.deepEqual(allowedSyncEntityTypes(bounded), ["inventory", "product", "system"]);
  assert.deepEqual(syncQuerySpec(bounded, "cursor-0007"), {
    cursorAfter: "cursor-0007",
    entityTypes: ["inventory", "product", "system"]
  });
  assert.equal(nextSyncCursor([{ cursor: "cursor-0008" }, { cursor: "cursor-0009" }], "cursor-0007"), "cursor-0009");
  assert.equal(nextSyncCursor([], "cursor-0009"), "cursor-0009");
});

test("envelopes always carry request and server metadata", () => {
  const success = successEnvelope({ value: 1 }, "req-1");
  assert.equal(success.ok, true);
  assert.equal(success.meta.requestId, "req-1");
  const failure = errorEnvelope(new ApiError("SERVICE_NOT_MIGRATED", "not ready", 501), "req-2");
  assert.equal(failure.statusCode, 501);
  assert.equal(failure.payload.error.code, "SERVICE_NOT_MIGRATED");
  assert.equal(failure.payload.category, "INTERNAL_ERROR");
  assert.equal(failure.payload.error.category, "INTERNAL_ERROR");
  assert.equal(failure.payload.meta.requestId, "req-2");
});
