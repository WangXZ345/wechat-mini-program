import { ROLE_PERMISSIONS, profileHasPermission } from "@/config/access";
import { ApiError } from "@/services/http/api-error";
import type { AdminProfile, AdminRole, LoginInput } from "@/types/auth";
import { ADMIN_ROLES, ROLE_LABELS, isAdminRole } from "@/types/auth";
import type { AdminTransport, DashboardData, DashboardMetric, ListQuery, ListResult, MutationOptions, MutationResult, ProductAnalyticsData } from "@/types/api";
import type { SyncBatch, SyncEvent } from "@/types/realtime";
import {
  MAX_INVENTORY_STOCK,
  normalizeInventoryAdjustmentInput,
  parseInventoryAdjustmentResult,
  parseInventorySnapshot,
  type InventoryAdjustmentInput,
  type InventoryResource,
  type InventorySnapshot,
  type InventoryStatus
} from "./inventory-adjustment-contract";
import {
  PUBLIC_PRODUCT_TAGS,
  isPublicProductTag,
  normalizePublicProductTags,
  type PublicProductTag
} from "./product-tag-contract";
import {
  normalizeCreateProductInput,
  normalizeEditProductInput,
  parseProductDetail,
  parseProductMutationResult,
  type CreateProductInput,
  type EditProductInput,
  type ProductDetail,
  type ProductInitialInput,
  type ProductMetadataInput,
  type ProductSummary
} from "./product-write-contract";
import { parseOrderDetail, parseOrderList, type OrderDetail, type OrderSummary } from "./order-query-contract";
import {
  SHIPMENT_STATUSES,
  parseShipmentDetail,
  parseShipmentListPage,
  type ShipmentDetail,
  type ShipmentSummary
} from "./shipment-query-contract";
import {
  ACCOUNT_QUERY_STATUSES,
  parseAccountDetail,
  parseAccountListPage,
  type AccountDetail,
  type AccountSummary
} from "./account-query-contract";
import {
  PAYMENT_QUERY_STATUSES,
  parsePaymentDetail,
  parsePaymentListPage,
  type PaymentSummary
} from "./payment-query-contract";
import {
  normalizePaymentMutationInput,
  parsePaymentMutationResult,
  type PaymentMutationAction,
  type PaymentMutationResult
} from "./payment-mutation-contract";
import { cloneMockRows } from "./mock-data";

type Row = Record<string, unknown> & { id: string; version: number };
type BatchEnableItem = { id: string; expectedIsActive: boolean; expectedVersion: number };
type BatchPublicTagItem = { id: string; expectedVersion: number; expectedPresent: boolean };

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms));
const SESSION_KEY = "admin-web.mock-role";
const PUBLIC_TAG_FLAG: Record<PublicProductTag, "isNew" | "isDefective" | "isHot"> = {
  "新货": "isNew",
  "瑕疵": "isDefective",
  "热销": "isHot"
};

function syncMockProductPublicTags(product: Row, tags: PublicProductTag[]): void {
  product.tags = PUBLIC_PRODUCT_TAGS.filter((tag) => tags.includes(tag));
  for (const tag of PUBLIC_PRODUCT_TAGS) product[PUBLIC_TAG_FLAG[tag]] = tags.includes(tag);
  product.searchText = [product.sku, product.name, product.brand, ...tags]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function projectMockProduct(product: Row): Row {
  const storedTags = new Set(Array.isArray(product.tags)
    ? product.tags.filter(isPublicProductTag)
    : []);
  const projected: Row = {
    id: product.id,
    sku: typeof product.productIndex === "string" && product.productIndex
      ? product.productIndex
      : typeof product.skuCode === "string" && product.skuCode
        ? product.skuCode
        : typeof product.sku === "string" ? product.sku : "",
    name: typeof product.name === "string" ? product.name : "",
    brand: typeof product.brand === "string" ? product.brand : "",
    status: product.isActive === false ? "inactive" : product.status === "draft" ? "draft" : "active",
    isActive: product.isActive !== false,
    tags: PUBLIC_PRODUCT_TAGS.filter((tag) => storedTags.has(tag) || product[PUBLIC_TAG_FLAG[tag]] === true),
    updatedAt: product.updatedAt,
    version: Number.isSafeInteger(product.version) && product.version >= 0 ? product.version : 0
  };
  if (typeof product.salePriceCents === "number"
    && Number.isSafeInteger(product.salePriceCents)
    && product.salePriceCents >= 0) {
    projected.salePriceCents = product.salePriceCents;
  }
  return projected;
}

function productMetadata(product: Row): ProductMetadataInput {
  return {
    name: typeof product.name === "string" ? product.name : "",
    baseName: typeof product.baseName === "string" ? product.baseName : typeof product.name === "string" ? product.name : "",
    imageUrl: typeof product.imageUrl === "string" ? product.imageUrl : "",
    specification: typeof product.specification === "string" ? product.specification : "",
    productionDate: typeof product.productionDate === "string" ? product.productionDate : "",
    description: typeof product.description === "string" ? product.description : "",
    productIndex: typeof product.productIndex === "string" ? product.productIndex : typeof product.sku === "string" ? product.sku : "",
    skuCode: typeof product.skuCode === "string" ? product.skuCode : typeof product.sku === "string" ? product.sku : "",
    keywords: Array.isArray(product.keywords) ? product.keywords.filter((item): item is string => typeof item === "string") : []
  };
}

function productInitial(product: Row, inventory?: Row): ProductInitialInput {
  return {
    salePriceCents: typeof product.salePriceCents === "number" ? product.salePriceCents : 0,
    stock: typeof product.stock === "number" ? product.stock : typeof inventory?.stock === "number" ? inventory.stock : 0,
    warningThreshold: typeof product.warningThreshold === "number"
      ? product.warningThreshold
      : typeof inventory?.warningThreshold === "number" ? inventory.warningThreshold : 0,
    isActive: product.isActive !== false,
    tags: normalizePublicProductTags(product.tags) || []
  };
}

function projectMockRow(resource: string, row: Row): Row {
  return resource === "products" ? projectMockProduct(row) : row;
}

const MOCK_ORDER_PHONE: Record<string, { masked: string; full: string }> = {
  "o-001": { masked: "138****1201", full: "13800001201" },
  "o-002": { masked: "139****2302", full: "13900002302" },
  "o-003": { masked: "137****3403", full: "13700003403" },
  "o-004": { masked: "136****4504", full: "13600004504" }
};

function mockOrderSummary(row: Row, profile: AdminProfile): OrderSummary {
  const phone = MOCK_ORDER_PHONE[row.id] || { masked: "", full: "" };
  const createdAt = typeof row.createdAt === "string" ? row.createdAt : null;
  const summary: Record<string, unknown> = {
    id: row.id,
    orderNo: typeof row.orderNo === "string" ? row.orderNo : "",
    customerMasked: typeof row.customerMasked === "string" ? row.customerMasked : "",
    customerPhoneMasked: phone.masked,
    itemSummary: typeof row.itemSummary === "string" ? row.itemSummary : "",
    itemCount: 2,
    totalQuantity: row.id === "o-001" ? 3 : row.id === "o-002" ? 6 : row.id === "o-003" ? 12 : 9,
    status: typeof row.status === "string" ? row.status : "",
    paymentStatus: typeof row.paymentStatus === "string" ? row.paymentStatus : "",
    deliveryStatus: row.status === "completed" ? "completed" : row.status === "pending_shipment" ? "pending_shipment" : "",
    createdAt,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : createdAt,
    version: row.version
  };
  if (profileHasPermission(profile, "dashboard:view_sales") && typeof row.totalAmountCents === "number") {
    summary.totalAmountCents = row.totalAmountCents;
  }
  return summary as OrderSummary;
}

function mockOrderDetail(row: Row, profile: AdminProfile): OrderDetail {
  const summary = mockOrderSummary(row, profile);
  const phone = MOCK_ORDER_PHONE[row.id] || { masked: "", full: "" };
  const customerName = `演示客户 ${row.id.slice(-1).padStart(2, "0")}`;
  const detail: Record<string, unknown> = {
    ...summary,
    items: [
      { id: `${row.id}-line-1`, productId: "p-001", productName: "演示柔雾唇釉", specification: "3.5g", productionDate: "2026-06", quantity: 1 },
      { id: `${row.id}-line-2`, productId: "p-002", productName: "演示修护精华", specification: "30ml", productionDate: "2026-05", quantity: Math.max(1, summary.totalQuantity - 1) }
    ],
    customer: { nameMasked: `${customerName.slice(0, -1)}*`, phoneMasked: phone.masked },
    shippingAddressMasked: {
      receiverName: `${customerName.slice(0, -1)}*`,
      receiverPhoneMasked: phone.masked,
      regionText: "上海市 浦东新区",
      detailAddressMasked: "演示路 ** 号"
    }
  };
  if (profileHasPermission(profile, "customer:view_phone_full")) {
    (detail.customer as Record<string, unknown>).phone = phone.full;
  }
  if (profileHasPermission(profile, "customer:view_address_full")) {
    detail.shippingAddress = {
      receiverName: customerName,
      receiverPhone: phone.full,
      regionText: "上海市 浦东新区",
      detailAddress: "演示路 88 号（仅本地演示）"
    };
  }
  if (profileHasPermission(profile, "order:edit_remark")) detail.adminRemark = "演示订单备注";
  if (profileHasPermission(profile, "order:review")) detail.riskLevelSnapshot = "normal";
  return parseOrderDetail(detail);
}

const MOCK_SHIPMENT_TOTALS: Record<string, number> = {
  "ship-001": 118_800,
  "ship-002": 138_200,
  "ship-003": 73_400
};

const MOCK_SHIPMENT_ORDERS: Record<string, { id: string; orderNo: string; status: string; paymentStatus: string }> = {
  "ship-001": { id: "o-003", orderNo: "DEMO-O-24071103", status: "pending_shipment", paymentStatus: "paid" },
  "ship-002": { id: "o-004", orderNo: "DEMO-O-24071007", status: "completed", paymentStatus: "paid" },
  "ship-003": { id: "o-004", orderNo: "DEMO-O-24071007", status: "completed", paymentStatus: "paid" }
};

function canViewShipments(profile: AdminProfile): boolean {
  return profile.isActive
    && ["customer_service", "finance", "super_admin"].includes(profile.role)
    && profileHasPermission(profile, "shipment:view");
}

function canViewPayments(profile: AdminProfile): boolean {
  return profile.isActive && ["finance", "super_admin"].includes(profile.role)
    && profileHasPermission(profile, "payment:view_screenshot");
}

function mockPaymentSummary(row: Row): PaymentSummary {
  const proofCount = Number.isSafeInteger(row.proofCount) ? Number(row.proofCount) : (row.proofLabel && row.proofLabel !== "无凭证" ? 1 : 0);
  return parsePaymentDetail({
    id: row.id,
    version: row.version,
    orderNo: typeof row.orderNo === "string" ? row.orderNo : "",
    customerMasked: typeof row.customerMasked === "string" ? row.customerMasked : "客户",
    amountCents: typeof row.amountCents === "number" ? row.amountCents : 0,
    proofLabel: proofCount > 0 ? "已提交凭证" : "无凭证",
    proofCount,
    status: typeof row.status === "string" ? row.status : "unpaid",
    submittedAt: typeof row.submittedAt === "string" ? row.submittedAt : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : (typeof row.submittedAt === "string" ? row.submittedAt : null)
  });
}

function canViewShipmentTracking(profile: AdminProfile): boolean {
  return profile.role === "super_admin"
    || profileHasPermission(profile, "shipment:update")
    || profileHasPermission(profile, "shipment:ship");
}

function canViewShipmentNotes(profile: AdminProfile): boolean {
  return profile.role === "super_admin"
    || ["shipment:update", "shipment:ship", "shipment:cancel", "shipment:complete"]
      .some((permission) => profileHasPermission(profile, permission));
}

function mockShipmentTrackingNo(row: Row): string {
  if (typeof row.trackingNo === "string") return row.trackingNo;
  return `DEMO-${row.id.toUpperCase()}-TRACKING`;
}

function mockShipmentSummary(row: Row, profile: AdminProfile): ShipmentSummary {
  const updatedAt = typeof row.updatedAt === "string" ? row.updatedAt : null;
  const status = typeof row.status === "string" && SHIPMENT_STATUSES.includes(row.status as typeof SHIPMENT_STATUSES[number])
    ? row.status as typeof SHIPMENT_STATUSES[number]
    : "abnormal";
  const orderCount = typeof row.orderCount === "number"
    ? row.orderCount
    : typeof row.ordersCount === "number" ? row.ordersCount : 0;
  const order = MOCK_SHIPMENT_ORDERS[row.id];
  const summary: Record<string, unknown> = {
    id: row.id,
    shipmentNo: typeof row.shipmentNo === "string" ? row.shipmentNo : "",
    status,
    orderCount,
    totalItemCount: Math.max(0, orderCount * 2),
    customerMasked: typeof row.customerMasked === "string" ? row.customerMasked : "",
    carrier: typeof row.carrier === "string" ? row.carrier : "",
    trackingMasked: typeof row.trackingMasked === "string" ? row.trackingMasked : "",
    addressConsistent: true,
    orderNosPreview: order ? [order.orderNo] : [],
    createdAt: updatedAt,
    updatedAt,
    shippedAt: status === "shipped" || status === "completed" ? updatedAt : null,
    completedAt: status === "completed" ? updatedAt : null,
    version: row.version
  };
  if (profileHasPermission(profile, "dashboard:view_sales")) {
    summary.totalOrderAmountCents = MOCK_SHIPMENT_TOTALS[row.id] || 0;
  }
  return summary as ShipmentSummary;
}

function mockShipmentDetail(row: Row, profile: AdminProfile): ShipmentDetail {
  const summary = mockShipmentSummary(row, profile);
  const order = MOCK_SHIPMENT_ORDERS[row.id];
  const totalAmountCents = MOCK_SHIPMENT_TOTALS[row.id] || 0;
  const canViewAmounts = profileHasPermission(profile, "dashboard:view_sales");
  const canViewNotes = canViewShipmentNotes(profile);
  const shipment: Record<string, unknown> = {
    id: summary.id,
    shipmentNo: summary.shipmentNo,
    status: summary.status,
    version: summary.version,
    orderCount: summary.orderCount,
    totalItemCount: summary.totalItemCount,
    totalProductCount: summary.totalItemCount > 0 ? 1 : 0,
    customerMasked: summary.customerMasked,
    carrier: summary.carrier,
    addressConsistent: summary.addressConsistent,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    shippedAt: summary.shippedAt,
    completedAt: summary.completedAt,
    cancelledAt: summary.status === "cancelled" ? summary.updatedAt : null
  };
  if (profileHasPermission(profile, "shipment:view_address_full")) {
    shipment.shippingAddress = {
      receiverName: "演示客户",
      receiverPhoneMasked: "137****3403",
      regionText: "上海市 浦东新区",
      detailAddress: "演示路 88 号（仅本地演示）",
      fullAddress: "上海市 浦东新区 演示路 88 号（仅本地演示）"
    };
  } else {
    shipment.shippingAddressMasked = {
      receiverName: "演示客*",
      receiverPhoneMasked: "137****3403",
      regionText: "上海市 浦东新区",
      detailAddressMasked: "演示路 ** 号",
      fullAddressMasked: "上海市 浦东新区 演示路 ** 号"
    };
  }
  if (canViewShipmentTracking(profile)) shipment.trackingNo = mockShipmentTrackingNo(row);
  else shipment.trackingMasked = summary.trackingMasked;
  if (canViewAmounts) {
    shipment.totalOrderAmountCents = totalAmountCents;
    shipment.totalPaidAmountCents = totalAmountCents;
    shipment.totalUnpaidAmountCents = 0;
  }
  if (canViewNotes) shipment.adminRemark = "演示发货备注";

  const orderProjection: Record<string, unknown>[] = order ? [{
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    paymentStatus: order.paymentStatus,
    shippingStatus: summary.status === "created" ? "pending_shipment" : summary.status,
    createdAt: summary.createdAt,
    ...(canViewAmounts ? { totalAmountCents } : {})
  }] : [];
  const detail = {
    shipment,
    orders: orderProjection,
    itemSummary: summary.totalItemCount > 0 ? [{
      productId: "p-005",
      productName: "演示清透防晒",
      brand: "演示品牌 D",
      category: "护肤",
      specification: "50ml",
      productionDate: "2026-05",
      totalQuantity: summary.totalItemCount,
      orderNos: order ? [order.orderNo] : []
    }] : [],
    logs: [{
      id: `${row.id}-log-1`,
      action: "create",
      operatorRole: "customer_service",
      createdAt: summary.createdAt,
      ...(canViewNotes ? { remark: "已创建演示合并发货单" } : {})
    }],
    logsHasMore: false,
    relatedDataStatus: "complete",
    warnings: []
  };
  return parseShipmentDetail(detail);
}

function canViewAccounts(profile: AdminProfile): boolean {
  return profile.isActive
    && (profile.role === "finance" || profile.role === "super_admin")
    && profileHasPermission(profile, "customer:view_account");
}

function mockAccountSummary(row: Row): AccountSummary {
  return {
    id: row.id,
    customerMasked: typeof row.customerMasked === "string" ? row.customerMasked : "",
    totalOrders: typeof row.totalOrders === "number" ? row.totalOrders : 0,
    receivableCents: typeof row.receivableCents === "number" ? row.receivableCents : 0,
    receivedCents: typeof row.receivedCents === "number" ? row.receivedCents : 0,
    unpaidAmountCents: typeof row.unpaidAmountCents === "number" ? row.unpaidAmountCents : 0,
    pendingConfirmAmountCents: typeof row.pendingConfirmAmountCents === "number" ? row.pendingConfirmAmountCents : 0,
    abnormalCount: typeof row.abnormalCount === "number" ? row.abnormalCount : 0,
    status: row.status as AccountSummary["status"],
    lastOrderAt: typeof row.lastOrderAt === "string" ? row.lastOrderAt : null,
    lastPaymentAt: typeof row.lastPaymentAt === "string" ? row.lastPaymentAt : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null
  };
}

function mockAccountDetail(row: Row): AccountDetail {
  const account = mockAccountSummary(row);
  const orderNo = `DEMO-ACCOUNT-${row.id.toUpperCase()}`;
  const createdAt = account.lastOrderAt || account.updatedAt;
  return parseAccountDetail({
    account,
    orders: [{
      id: `order-${row.id}`,
      orderNo,
      status: account.status === "settled" ? "completed" : "approved",
      paymentStatus: account.status === "settled" ? "paid" : account.status === "pending_confirm" ? "pending_confirm" : "unpaid",
      totalAmountCents: account.receivableCents,
      createdAt
    }],
    logs: [{
      id: `log-${row.id}`,
      changeType: account.status === "settled" ? "settled" : "account_updated",
      beforeReceivableCents: 0,
      afterReceivableCents: account.receivableCents,
      beforeReceivedCents: 0,
      afterReceivedCents: account.receivedCents,
      beforeUnpaidCents: 0,
      afterUnpaidCents: account.unpaidAmountCents,
      changeAmountCents: account.unpaidAmountCents,
      orderNo,
      createdAt: account.updatedAt,
      summary: "演示账款汇总已更新"
    }],
    ordersHasMore: false,
    logsHasMore: false,
    relatedDataStatus: "complete",
    warnings: []
  });
}

function canBatchUpdateProductTags(profile: AdminProfile): boolean {
  return profile.isActive
    && (profile.role === "super_admin"
      || (profile.role === "procurement" && profileHasPermission(profile, "product:tag:batch_update")));
}

function canWriteProduct(profile: AdminProfile, permission: "product:create" | "product:update"): boolean {
  return profile.isActive
    && (profile.role === "super_admin"
      || (profile.role === "procurement" && profileHasPermission(profile, permission)));
}

function canUseInventory(profile: AdminProfile, permission: "inventory:view" | "inventory:update"): boolean {
  return profile.isActive
    && (profile.role === "super_admin"
      || (profile.role === "procurement" && profileHasPermission(profile, permission)));
}

function inventoryStatus(stock: number, warningThreshold: number): InventoryStatus {
  if (stock <= 0) return "out";
  return warningThreshold > 0 && stock <= warningThreshold ? "low" : "normal";
}

const syncScopes: Record<AdminRole, string[]> = {
  customer_service: ["order", "shipment", "after_sale"],
  finance: ["payment", "account", "refund", "order", "shipment", "after_sale"],
  procurement: ["product", "inventory"],
  super_admin: ["product", "inventory", "order", "payment", "account", "shipment", "after_sale", "refund", "admin"]
};

function makeProfile(role: AdminRole): AdminProfile {
  return {
    id: `demo-${role}`,
    username: `${role}.demo`,
    displayName: `演示${ROLE_LABELS[role]}`,
    role,
    roleName: ROLE_LABELS[role],
    permissions: [...ROLE_PERMISSIONS[role]],
    isActive: true,
    sessionExpiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString()
  };
}

export class MockTransport implements AdminTransport {
  readonly mode = "mock" as const;
  private rows = cloneMockRows();
  private profile: AdminProfile | null = null;
  private readonly mutationResults = new Map<string, { fingerprint: string; result: MutationResult<unknown> }>();
  private syncCalls = 0;
  private readonly eventLog: SyncEvent[] = [];

  constructor() {
    const storedRole = window.sessionStorage.getItem(SESSION_KEY);
    if (isAdminRole(storedRole)) this.profile = makeProfile(storedRole);
    for (const product of this.rows.products || []) {
      const tags = normalizePublicProductTags(product.tags);
      if (tags) syncMockProductPublicTags(product, tags);
    }
  }

  async login(input: LoginInput): Promise<AdminProfile> {
    await wait(420);
    const role = input.account.replace(/\.demo$/i, "");
    if (!ADMIN_ROLES.includes(role as AdminRole) || input.password !== "demo-pass") {
      throw new ApiError("账号或密码不正确", "INVALID_CREDENTIALS", 401);
    }
    this.profile = makeProfile(role as AdminRole);
    window.sessionStorage.setItem(SESSION_KEY, role);
    return structuredClone(this.profile);
  }

  async logout(): Promise<void> {
    await wait(120);
    this.profile = null;
    window.sessionStorage.removeItem(SESSION_KEY);
  }

  async getCurrentProfile(): Promise<AdminProfile> {
    await wait(100);
    if (!this.profile) throw new ApiError("演示会话尚未建立", "AUTH_REQUIRED", 401);
    return structuredClone(this.profile);
  }

  async getDashboard(): Promise<DashboardData> {
    const profile = this.requireProfile();
    await wait(260);
    const byRole: Record<AdminRole, DashboardMetric[]> = {
      procurement: [
        { key: "products", label: "在售商品", value: 118, kind: "number", unit: "个", tone: "neutral", route: "/products" },
        { key: "alerts", label: "库存预警", value: 3, kind: "number", unit: "项", tone: "warning", route: "/inventory/alerts" },
        { key: "imports", label: "待确认导入", value: 2, kind: "number", unit: "批", tone: "info", route: "/imports/inventory" },
        { key: "changes", label: "今日价格变更", value: 7, kind: "number", unit: "项", tone: "success", route: "/analytics/products" }
      ],
      customer_service: [
        { key: "orders", label: "待审核订单", value: 6, kind: "number", unit: "单", tone: "warning", route: "/orders" },
        { key: "shipments", label: "待发货", value: 9, kind: "number", unit: "单", tone: "info", route: "/shipments" },
        { key: "after-sales", label: "待处理售后", value: 3, kind: "number", unit: "单", tone: "danger", route: "/after-sales" },
        { key: "completed", label: "今日已完成", value: 18, kind: "number", unit: "单", tone: "success", route: "/orders" }
      ],
      finance: [
        { key: "payments", label: "待确认付款", value: 2, kind: "number", unit: "笔", tone: "warning", route: "/payments" },
        { key: "refunds", label: "待处理退款", value: 1, kind: "number", unit: "笔", tone: "danger", route: "/refunds" },
        { key: "confirmed", label: "今日确认金额", value: 173400, kind: "money", tone: "success", route: "/payments" },
        { key: "unpaid", label: "演示未收金额", value: 188500, kind: "money", tone: "info", route: "/accounts" }
      ],
      super_admin: [
        { key: "orders", label: "待审核订单", value: 6, kind: "number", unit: "单", tone: "warning", route: "/orders" },
        { key: "payments", label: "待确认付款", value: 2, kind: "number", unit: "笔", tone: "danger", route: "/payments" },
        { key: "alerts", label: "库存预警", value: 3, kind: "number", unit: "项", tone: "warning", route: "/inventory/alerts" },
        { key: "confirmed", label: "今日确认金额", value: 173400, kind: "money", tone: "success", route: "/accounts" }
      ]
    };
    return {
      metrics: byRole[profile.role],
      tasks: [
        { id: "task-1", title: "优先处理临近时限记录", detail: `${ROLE_LABELS[profile.role]}职责范围内的演示待办`, count: profile.role === "procurement" ? 3 : 2, route: byRole[profile.role][0]?.route || "/dashboard", tone: "warning" },
        { id: "task-2", title: "检查同步后的数据变化", detail: "最近 30 分钟有新的演示事件", count: 4, route: profile.role === "super_admin" ? "/audit" : "/dashboard", tone: "info" },
        { id: "task-3", title: "已完成今日例行核对", detail: "当前没有阻断性演示异常", count: 12, route: "/dashboard", tone: "neutral" }
      ],
      trend: [
        { label: "周一", value: 42 },
        { label: "周二", value: 56 },
        { label: "周三", value: 48 },
        { label: "周四", value: 74 },
        { label: "周五", value: 69 },
        { label: "周六", value: 88 },
        { label: "今日", value: 81 }
      ],
      topProducts: [
        { name: "演示柔雾唇釉", sku: "DEMO-101", value: 286, change: 12 },
        { name: "演示修护精华", sku: "DEMO-102", value: 214, change: 8 },
        { name: "演示清透防晒", sku: "DEMO-105", value: 176, change: -3 },
        { name: "演示氨基酸洁面", sku: "DEMO-106", value: 142, change: 5 }
      ],
      updatedAt: new Date().toISOString()
    };
  }

  async getProductAnalytics(range: "7d" | "30d" | "90d"): Promise<ProductAnalyticsData> {
    this.requireProfile();
    await wait(260);
    const points = range === "7d" ? 7 : range === "30d" ? 10 : 12;
    const multiplier = range === "7d" ? 1 : range === "30d" ? 4 : 10;
    const today = new Date();
    return {
      range,
      status: "available",
      summary: [
        { key: "sales", label: "演示销量", value: 1286 * multiplier, kind: "number", change: 12.4 },
        { key: "average", label: "成交均价", value: 9260, kind: "money", change: 3.1 },
        { key: "quote", label: "平均报价", value: 8840, kind: "money", change: -1.8 },
        { key: "active", label: "有成交商品", value: 86, kind: "number", change: 6.2 }
      ],
      series: Array.from({ length: points }, (_, index) => ({
        date: new Date(Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() - (points - index - 1)
        )).toISOString().slice(0, 10),
        salesCount: Math.round((72 + Math.sin(index * 1.4) * 20 + index * 2) * multiplier),
        averagePriceCents: 8800 + index * 90 + (index % 3) * 130,
        quotePriceCents: 8400 + index * 70 + (index % 2) * 100,
        inventoryChange: Math.round(Math.cos(index * 0.9) * 42)
      })),
      ranking: [
        { id: "p-001", name: "演示柔雾唇釉", sku: "DEMO-101", salesCount: 286 * multiplier, averagePriceCents: 6720, currentPriceCents: 6990, change: 12.0 },
        { id: "p-002", name: "演示修护精华", sku: "DEMO-102", salesCount: 214 * multiplier, averagePriceCents: 15180, currentPriceCents: 15900, change: 8.4 },
        { id: "p-005", name: "演示清透防晒", sku: "DEMO-105", salesCount: 176 * multiplier, averagePriceCents: 9620, currentPriceCents: 9900, change: -3.2 },
        { id: "p-006", name: "演示氨基酸洁面", sku: "DEMO-106", salesCount: 142 * multiplier, averagePriceCents: 7380, currentPriceCents: 7600, change: 5.1 }
      ],
      updatedAt: new Date().toISOString()
    };
  }

  async getProductDetail(id: string): Promise<ProductDetail> {
    const profile = this.requireProfile();
    if (!(profile.role === "super_admin"
      || (profile.role === "procurement" && profileHasPermission(profile, "product:view")))) {
      throw new ApiError("无权查看商品资料", "FORBIDDEN", 403);
    }
    await wait(120);
    const product = (this.rows.products || []).find((row) => row.id === id);
    if (!product) throw new ApiError("商品不存在或已更新", "PRODUCT_NOT_FOUND", 404);
    const inventory = (this.rows.inventory || []).find((row) => row.id === id);
    return parseProductDetail({
      id: product.id,
      version: product.version,
      metadata: productMetadata(product),
      initial: productInitial(product, inventory),
      updatedAt: typeof product.updatedAt === "string" ? product.updatedAt : ""
    });
  }

  async getShipmentDetail(id: string): Promise<ShipmentDetail> {
    const profile = this.requireProfile();
    if (!canViewShipments(profile)) throw new ApiError("无权查看合并发货单", "FORBIDDEN", 403);
    await wait(120);
    const shipment = (this.rows.shipments || []).find((row) => row.id === id);
    if (!shipment) throw new ApiError("合并发货单不存在", "SHIPMENT_NOT_FOUND", 404);
    return mockShipmentDetail(shipment, profile);
  }

  async getAccountDetail(id: string): Promise<AccountDetail> {
    const profile = this.requireProfile();
    if (!canViewAccounts(profile)) throw new ApiError("无权查看客户账款", "FORBIDDEN", 403);
    await wait(120);
    const account = (this.rows.accounts || []).find((row) => row.id === id);
    if (!account) throw new ApiError("客户账款不存在", "ACCOUNT_NOT_FOUND", 404);
    return mockAccountDetail(account);
  }

  async createProduct(input: CreateProductInput, options: MutationOptions): Promise<MutationResult<ProductSummary>> {
    const profile = this.requireProfile();
    if (!canWriteProduct(profile, "product:create")) throw new ApiError("无权新增商品", "FORBIDDEN", 403);
    const normalized = normalizeCreateProductInput(input);
    return this.writeProduct("create", normalized, options);
  }

  async editProduct(input: EditProductInput, options: MutationOptions): Promise<MutationResult<ProductSummary>> {
    const profile = this.requireProfile();
    if (!canWriteProduct(profile, "product:update")) throw new ApiError("无权编辑商品", "FORBIDDEN", 403);
    const normalized = normalizeEditProductInput(input);
    if (options.expectedVersion !== normalized.expectedVersion) {
      throw new ApiError("商品版本与请求选项不一致", "EXPECTED_VERSION_MISMATCH", 400);
    }
    return this.writeProduct("edit", normalized, options);
  }

  async getInventorySnapshot(id: string): Promise<InventorySnapshot> {
    const profile = this.requireProfile();
    if (!canUseInventory(profile, "inventory:view")) throw new ApiError("无权查看库存", "FORBIDDEN", 403);
    await wait(120);
    return this.inventorySnapshot(id);
  }

  async adjustInventory(
    resource: InventoryResource,
    input: InventoryAdjustmentInput,
    options: MutationOptions
  ): Promise<MutationResult<InventorySnapshot>> {
    const profile = this.requireProfile();
    if (!canUseInventory(profile, "inventory:update")) throw new ApiError("无权调整库存", "FORBIDDEN", 403);
    const normalized = normalizeInventoryAdjustmentInput(input);
    if (options.expectedVersion !== normalized.expectedVersion) {
      throw new ApiError("库存版本与请求选项不一致", "EXPECTED_VERSION_MISMATCH", 400);
    }
    if (!options.idempotencyKey) throw new ApiError("缺少幂等键", "IDEMPOTENCY_KEY_REQUIRED", 400);
    await wait(360);

    const fingerprint = JSON.stringify({ resource, action: "adjust", input: normalized, expectedVersion: options.expectedVersion });
    const prior = this.mutationResults.get(options.idempotencyKey);
    if (prior && prior.fingerprint !== fingerprint) {
      throw new ApiError("请求已被用于其他库存调整，请刷新后重试", "IDEMPOTENCY_KEY_CONFLICT", 409);
    }
    if (prior) return parseInventoryAdjustmentResult(structuredClone(prior.result));

    const inventory = (this.rows.inventory || []).find((row) => row.id === normalized.id);
    const product = (this.rows.products || []).find((row) => row.id === normalized.id);
    if (!inventory || !product) throw new ApiError("商品不存在或已更新", "PRODUCT_NOT_FOUND", 404);
    const currentStock = inventory.stock;
    const currentVersion = product.version;
    if (typeof currentStock !== "number" || !Number.isSafeInteger(currentStock) || currentStock < 0 || currentStock > MAX_INVENTORY_STOCK) {
      throw new ApiError("商品库存数据异常，暂不能修改", "DATA_STOCK_INVALID", 409);
    }
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
      throw new ApiError("商品数据版本异常，暂不能修改", "DATA_VERSION_INVALID", 409);
    }
    if (currentStock !== normalized.expectedStock || currentVersion !== normalized.expectedVersion) {
      throw new ApiError("记录已变化，请刷新后重新确认", "DATA_VERSION_CONFLICT", 409);
    }
    const afterStock = currentStock + normalized.delta;
    if (afterStock < 0 || afterStock > MAX_INVENTORY_STOCK) {
      throw new ApiError(`调整后库存必须是 0 到 ${MAX_INVENTORY_STOCK} 之间的整数`, "INVENTORY_STOCK_OUT_OF_RANGE", 400);
    }

    const warningThreshold = typeof inventory.warningThreshold === "number"
      && Number.isSafeInteger(inventory.warningThreshold)
      && inventory.warningThreshold >= 0
      ? inventory.warningThreshold
      : 0;
    const status = inventoryStatus(afterStock, warningThreshold);
    const nextVersion = currentVersion + 1;
    const updatedAt = new Date().toISOString();
    const autoHidden = afterStock === 0 && product.autoHideWhenOutOfStock === true;
    const isActive = autoHidden ? false : product.isActive !== false;
    const signedDelta = normalized.delta > 0 ? `+${normalized.delta}` : String(normalized.delta);

    Object.assign(product, {
      stock: afterStock,
      warningThreshold,
      stockStatus: status === "out" ? "out_of_stock" : status === "low" ? "warning" : "normal",
      isActive,
      version: nextVersion,
      updatedAt
    });
    Object.assign(inventory, {
      stock: afterStock,
      warningThreshold,
      status,
      isActive,
      version: nextVersion,
      lastChange: `${signedDelta} 人工调整`,
      updatedAt
    });
    this.syncMockInventoryAlert(inventory);

    const item = parseInventorySnapshot({
      id: normalized.id,
      stock: afterStock,
      warningThreshold,
      status,
      isActive,
      version: nextVersion,
      updatedAt
    });
    const result = parseInventoryAdjustmentResult({
      item,
      affected: 1,
      message: `库存已从 ${currentStock} 调整为 ${afterStock}`,
      requestId: `mock-${crypto.randomUUID()}`
    });
    this.mutationResults.set(options.idempotencyKey, { fingerprint, result });
    this.pushEvent("inventory", normalized.id, "adjust", nextVersion, ["stock", "stockStatus", "updatedAt", "version"]);
    return structuredClone(result);
  }

  async list<T extends Record<string, unknown>>(resource: string, query: ListQuery): Promise<ListResult<T>> {
    const profile = this.requireProfile();
    if (resource === "orders" && !profileHasPermission(profile, "order:view")) {
      throw new ApiError("无权查看订单", "FORBIDDEN", 403);
    }
    if (resource === "shipments" && !canViewShipments(profile)) {
      throw new ApiError("无权查看合并发货单", "FORBIDDEN", 403);
    }
    if (resource === "accounts" && !canViewAccounts(profile)) {
      throw new ApiError("无权查看客户账款", "FORBIDDEN", 403);
    }
    if (resource === "payments" && !canViewPayments(profile)) {
      throw new ApiError("无权查看付款记录", "FORBIDDEN", 403);
    }
    await wait();
    if (query.search === "__error__") throw new ApiError("演示请求失败，请重试", "MOCK_REQUEST_FAILED", 503);
    let items = [...(this.rows[resource] || [])];
    if (resource === "shipments") {
      const status = String(query.status || "").trim();
      if (status && !SHIPMENT_STATUSES.includes(status as typeof SHIPMENT_STATUSES[number])) {
        throw new ApiError("发货状态筛选无效", "SHIPMENT_QUERY_INVALID", 400);
      }
      if (status) items = items.filter((item) => item.status === status);
      const search = String(query.search || "").trim().slice(0, 100);
      if (search) {
        items = items.filter((item) => {
          const order = MOCK_SHIPMENT_ORDERS[item.id];
          const orderNos = [
            order?.orderNo,
            typeof item.orderNo === "string" ? item.orderNo : undefined,
            ...(Array.isArray(item.orderNos) ? item.orderNos.filter((value): value is string => typeof value === "string") : [])
          ].filter((value): value is string => Boolean(value));
          const trackingNos = [
            mockShipmentTrackingNo(item),
            ...(Array.isArray(item.trackingNoList) ? item.trackingNoList.filter((value): value is string => typeof value === "string") : [])
          ];
          return item.shipmentNo === search || orderNos.includes(search) || trackingNos.includes(search);
        });
      }
      const total = items.length;
      const start = Math.max(0, (query.page - 1) * query.pageSize);
      const page = parseShipmentListPage({
        items: items.slice(start, start + query.pageSize).map((item) => mockShipmentSummary(item, profile)),
        pageSize: query.pageSize,
        hasMore: start + query.pageSize < total,
        nextCursor: start + query.pageSize < total ? String(start + query.pageSize) : null
      });
      return {
        items: page.items as unknown as T[],
        total,
        page: query.page,
        pageSize: page.pageSize,
        nextCursor: page.nextCursor
      };
    }
    if (resource === "accounts") {
      const status = String(query.status || "").trim();
      if (status && !ACCOUNT_QUERY_STATUSES.includes(status as typeof ACCOUNT_QUERY_STATUSES[number])) {
        throw new ApiError("账款状态筛选无效", "ACCOUNT_QUERY_INVALID", 400);
      }
      const rawSearch = String(query.search || "").trim();
      if (rawSearch.length > 80) throw new ApiError("账款搜索内容过长", "ACCOUNT_QUERY_INVALID", 400);
      const search = rawSearch.toLocaleLowerCase("zh-CN");
      if (status) items = items.filter((item) => item.status === status);
      if (search) {
        items = items.filter((item) => [item.nickname, item.customerName, item.phoneMasked]
          .some((value) => typeof value === "string" && value.toLocaleLowerCase("zh-CN").includes(search)));
      }
      items.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
        || right.id.localeCompare(left.id));
      const total = items.length;
      const start = Math.max(0, (query.page - 1) * query.pageSize);
      const hasMore = start + query.pageSize < total;
      const page = parseAccountListPage({
        items: items.slice(start, start + query.pageSize).map(mockAccountSummary),
        pageSize: query.pageSize,
        hasMore,
        nextCursor: hasMore ? `mock-account:${start + query.pageSize}` : null
      });
      return {
        items: page.items as unknown as T[],
        total,
        page: query.page,
        pageSize: page.pageSize,
        nextCursor: page.nextCursor
      };
    }
    if (resource === "payments") {
      const paymentStatus = String(query.status || "").trim();
      if (paymentStatus && !PAYMENT_QUERY_STATUSES.includes(paymentStatus as typeof PAYMENT_QUERY_STATUSES[number])) {
        throw new ApiError("付款记录状态筛选无效", "PAYMENT_QUERY_INVALID", 400);
      }
      const rawSearch = String(query.search || "").trim();
      if (rawSearch.length > 80) throw new ApiError("付款记录搜索内容过长", "PAYMENT_QUERY_INVALID", 400);
      const search = rawSearch.toLocaleLowerCase("zh-CN");
      if (paymentStatus) items = items.filter((item) => item.status === paymentStatus);
      if (search) items = items.filter((item) => [item.orderNo, item.customerMasked].some((value) => typeof value === "string" && value.toLocaleLowerCase("zh-CN").includes(search)));
      items.sort((left, right) => String(right.updatedAt || right.submittedAt || "").localeCompare(String(left.updatedAt || left.submittedAt || "")) || right.id.localeCompare(left.id));
      const total = items.length;
      const start = Math.max(0, (query.page - 1) * query.pageSize);
      const hasMore = start + query.pageSize < total;
      const page = parsePaymentListPage({ items: items.slice(start, start + query.pageSize).map(mockPaymentSummary), pageSize: query.pageSize, hasMore, nextCursor: hasMore ? `mock-payment:${start + query.pageSize}` : null });
      return { items: page.items as unknown as T[], total, page: query.page, pageSize: page.pageSize, nextCursor: page.nextCursor };
    }
    const search = String(query.search || "").trim().toLocaleLowerCase("zh-CN");
    if (search) items = items.filter((item) => JSON.stringify(Object.values(item)).toLocaleLowerCase("zh-CN").includes(search));
    if (query.status) items = items.filter((item) => item.status === query.status);
    const total = items.length;
    const start = Math.max(0, (query.page - 1) * query.pageSize);
    if (resource === "orders") {
      return parseOrderList({
        items: items.slice(start, start + query.pageSize).map((item) => mockOrderSummary(item, profile)),
        total,
        page: query.page,
        pageSize: query.pageSize,
        nextCursor: start + query.pageSize < total ? String(start + query.pageSize) : null
      }) as unknown as ListResult<T>;
    }
    return {
      items: structuredClone(items.slice(start, start + query.pageSize)
        .map((item) => projectMockRow(resource, item))) as T[],
      total,
      page: query.page,
      pageSize: query.pageSize,
      nextCursor: start + query.pageSize < total ? String(start + query.pageSize) : null
    };
  }

  async get<T extends Record<string, unknown>>(resource: string, id: string): Promise<T> {
    const profile = this.requireProfile();
    if (resource === "orders" && !profileHasPermission(profile, "order:view")) {
      throw new ApiError("无权查看订单", "FORBIDDEN", 403);
    }
    if (resource === "payments" && !canViewPayments(profile)) {
      throw new ApiError("无权查看付款记录", "FORBIDDEN", 403);
    }
    if (resource === "shipments") return this.getShipmentDetail(id) as unknown as Promise<T>;
    if (resource === "accounts") return this.getAccountDetail(id) as unknown as Promise<T>;
    await wait(120);
    const item = (this.rows[resource] || []).find((row) => row.id === id);
    if (!item) throw new ApiError("记录不存在或已更新", "NOT_FOUND", 404);
    if (resource === "orders") return mockOrderDetail(item, profile) as unknown as T;
    if (resource === "payments") return mockPaymentSummary(item) as unknown as T;
    return structuredClone(projectMockRow(resource, item)) as T;
  }

  async mutate<T extends Record<string, unknown>>(
    resource: string,
    action: string,
    payload: Record<string, unknown>,
    options: MutationOptions
  ): Promise<MutationResult<T>> {
    const profile = this.requireProfile();
    await wait(360);
    if (resource === "accounts") {
      throw new ApiError("账款写入与导出尚未接入", "SERVICE_NOT_MIGRATED", 501);
    }
    if (resource === "payments") {
      if (action !== "confirm" && action !== "reject") {
        throw new ApiError("该付款写操作尚未接入", "SERVICE_NOT_MIGRATED", 501);
      }
      return this.mutatePayment(profile, action, payload, options) as unknown as MutationResult<T>;
    }
    if (resource === "products"
      && action === "batch-tags"
      && !canBatchUpdateProductTags(profile)) {
      throw new ApiError("无权批量修改商品标签", "FORBIDDEN", 403);
    }
    if (resource === "orders"
      && (action === "review" || action === "reject")
      && !profileHasPermission(profile, action === "reject" ? "order:reject" : "order:review")) {
      throw new ApiError("无权执行订单审核操作", "FORBIDDEN", 403);
    }
    if (!options.idempotencyKey) throw new ApiError("缺少幂等键", "IDEMPOTENCY_KEY_REQUIRED", 400);
    const fingerprint = JSON.stringify({ resource, action, payload, expectedVersion: options.expectedVersion ?? null });
    const prior = this.mutationResults.get(options.idempotencyKey);
    if (prior && prior.fingerprint !== fingerprint) {
      throw new ApiError("请求已被用于其他操作，请刷新后重试", "IDEMPOTENCY_KEY_CONFLICT", 409);
    }
    if (prior) return structuredClone(prior.result) as MutationResult<T>;

    const items = this.rows[resource] || [];
    if (resource === "products" && action === "batch-enable") {
      const result = this.batchEnableProducts(items, payload);
      this.mutationResults.set(options.idempotencyKey, { fingerprint, result });
      return structuredClone(result) as MutationResult<T>;
    }
    if (resource === "products" && action === "batch-tags") {
      const result = this.batchPublicProductTags(items, payload);
      this.mutationResults.set(options.idempotencyKey, { fingerprint, result });
      return structuredClone(result) as MutationResult<T>;
    }
    if (resource === "orders" && (action === "review" || action === "reject")) {
      const item = items.find((row) => row.id === String(payload.id));
      if (!item) throw new ApiError("订单不存在", "ORDER_NOT_FOUND", 404);
      if (!["pending_admin", "auto_reviewing"].includes(String(item.status))) throw new ApiError("当前订单状态不可审核", "ORDER_STATUS_INVALID", 409);
      const reviewReason = payload.reason;
      if (action === "reject" && (typeof reviewReason !== "string" || !reviewReason.trim())) throw new ApiError("请填写驳回原因", "REASON_REQUIRED", 400);
      if (options.expectedVersion !== undefined && item.version !== options.expectedVersion) throw new ApiError("数据已被其他管理员更新", "DATA_VERSION_CONFLICT", 409);
      if (payload.expectedStatus !== item.status) throw new ApiError("订单状态已变化，请刷新后重试", "DATA_VERSION_CONFLICT", 409);
      item.status = action === "review" ? "approved_pending_payment" : "rejected";
      item.reviewType = "manual";
      item.version += 1;
      item.updatedAt = new Date().toISOString();
      const result = { item: structuredClone(projectMockRow(resource, item)), affected: 1, reused: false, decision: action === "review" ? "approve" : "reject", message: action === "review" ? "订单已审核通过" : "订单已驳回", requestId: `mock-${crypto.randomUUID()}` } as MutationResult<T>;
      this.mutationResults.set(options.idempotencyKey, { fingerprint, result });
      this.pushEvent(resource, item.id, action, item.version);
      return structuredClone(result) as MutationResult<T>;
    }
    const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : payload.id ? [String(payload.id)] : [];
    let affected = 0;
    let resultItem: Row | undefined;

    if (action === "create") {
      resultItem = this.createDemoRow(resource, items.length + 1);
      items.unshift(resultItem);
      affected = 1;
    } else if (action === "import-confirm") {
      const rowCount = Number(payload.rowCount);
      affected = Number.isSafeInteger(rowCount) && rowCount > 0 ? rowCount : 0;
    } else {
      for (const item of items) {
        if (ids.length && !ids.includes(item.id)) continue;
        if (!ids.length && payload.id) continue;
        if (options.expectedVersion !== undefined && item.version !== options.expectedVersion) {
          throw new ApiError("数据已被其他管理员更新", "DATA_VERSION_CONFLICT", 409);
        }
        const changed = this.applyAction(item, action, payload);
        resultItem = item;
        if (!changed) break;
        item.version += 1;
        item.updatedAt = new Date().toISOString();
        affected += 1;
        if (!Array.isArray(payload.ids)) break;
      }
    }

    const result: MutationResult<Row> = {
      item: resultItem ? structuredClone(projectMockRow(resource, resultItem)) : undefined,
      affected,
      message: affected ? "演示操作已完成" : "没有记录发生变化",
      requestId: `mock-${crypto.randomUUID()}`
    };
    this.mutationResults.set(options.idempotencyKey, { fingerprint, result });
    if (affected > 0) this.pushEvent(resource, resultItem?.id || ids[0] || "batch", action, resultItem?.version || 1);
    return structuredClone(result) as MutationResult<T>;
  }

  private mutatePayment(
    profile: AdminProfile,
    action: PaymentMutationAction,
    payload: Record<string, unknown>,
    options: MutationOptions
  ): PaymentMutationResult {
    const permission = action === "confirm" ? "payment:confirm" : "payment:update_status";
    if (!profile.isActive
      || !["finance", "super_admin"].includes(profile.role)
      || !profileHasPermission(profile, permission)) {
      throw new ApiError("无权执行付款审核操作", "FORBIDDEN", 403);
    }
    const input = normalizePaymentMutationInput(action, payload);
    if (options.expectedVersion !== input.expectedVersion) {
      throw new ApiError("付款版本与请求选项不一致", "EXPECTED_VERSION_MISMATCH", 400);
    }
    if (!options.idempotencyKey?.trim()) throw new ApiError("缺少幂等键", "IDEMPOTENCY_KEY_REQUIRED", 400);

    const fingerprint = JSON.stringify({ resource: "payments", action, input });
    const prior = this.mutationResults.get(options.idempotencyKey);
    if (prior && prior.fingerprint !== fingerprint) {
      throw new ApiError("请求已被用于其他付款审核，请重新核对后重试", "IDEMPOTENCY_KEY_CONFLICT", 409);
    }
    if (prior) {
      return parsePaymentMutationResult({ ...structuredClone(prior.result), affected: 0, reused: true });
    }

    const payment = (this.rows.payments || []).find((row) => row.id === input.id);
    if (!payment) throw new ApiError("付款记录不存在", "PAYMENT_NOT_FOUND", 404);
    const currentUpdatedAt = typeof payment.updatedAt === "string"
      ? payment.updatedAt
      : typeof payment.submittedAt === "string" ? payment.submittedAt : null;
    if (payment.status !== "pending_confirm") {
      throw new ApiError("付款记录已变化，请刷新后重新核对", "PAYMENT_STATE_CONFLICT", 409);
    }
    if (payment.version !== input.expectedVersion || currentUpdatedAt !== input.expectedUpdatedAt) {
      throw new ApiError("付款记录已被其他管理员更新", "DATA_VERSION_CONFLICT", 409);
    }

    const updatedAt = new Date().toISOString();
    payment.status = action === "confirm" ? "paid" : "rejected";
    payment.version += 1;
    payment.updatedAt = updatedAt;
    const result = parsePaymentMutationResult({
      item: {
        id: payment.id,
        orderNo: typeof payment.orderNo === "string" ? payment.orderNo : "",
        status: payment.status,
        version: payment.version,
        updatedAt
      },
      affected: 1,
      reused: false,
      decision: action,
      accountRecalculationPending: false,
      message: action === "confirm" ? "付款已确认" : "付款已驳回",
      requestId: `mock-${crypto.randomUUID()}`
    });
    this.mutationResults.set(options.idempotencyKey, { fingerprint, result });
    return structuredClone(result);
  }

  async catchUp(cursor?: string): Promise<SyncBatch> {
    const profile = this.requireProfile();
    await wait(90);
    this.syncCalls += 1;
    if (this.syncCalls % 3 === 0) {
      const cycle = syncScopes[profile.role];
      const entityType = cycle[(this.syncCalls / 3 - 1) % cycle.length] || "product";
      this.pushEvent(entityType, `demo-${this.syncCalls}`, "updated", 1);
    }
    const from = Number.parseInt(cursor || "0", 10) || 0;
    const allowed = new Set(syncScopes[profile.role]);
    const events = this.eventLog.slice(from).filter((event) => allowed.has(event.entityType));
    return {
      events: structuredClone(events),
      nextCursor: String(this.eventLog.length),
      hasMore: false,
      serverTime: new Date().toISOString()
    };
  }

  private requireProfile(): AdminProfile {
    if (!this.profile) throw new ApiError("请先登录", "AUTH_REQUIRED", 401);
    return this.profile;
  }

  private async writeProduct(
    action: "create" | "edit",
    input: CreateProductInput | EditProductInput,
    options: MutationOptions
  ): Promise<MutationResult<ProductSummary>> {
    await wait(360);
    if (!options.idempotencyKey) throw new ApiError("缺少幂等键", "IDEMPOTENCY_KEY_REQUIRED", 400);
    const fingerprint = JSON.stringify({ resource: "products", action, input, expectedVersion: options.expectedVersion ?? null });
    const prior = this.mutationResults.get(options.idempotencyKey);
    if (prior && prior.fingerprint !== fingerprint) {
      throw new ApiError("请求已被用于其他操作，请刷新后重试", "IDEMPOTENCY_KEY_CONFLICT", 409);
    }
    if (prior) return parseProductMutationResult(structuredClone(prior.result));

    const products = this.rows.products || [];
    const metadata = input.metadata;
    const duplicate = products.find((product) => {
      const sameProduct = action === "edit" && product.id === (input as EditProductInput).id;
      if (sameProduct) return false;
      return Boolean(metadata.productIndex && productMetadata(product).productIndex === metadata.productIndex);
    });
    if (duplicate) throw new ApiError("商品索引已存在", "PRODUCT_INDEX_DUPLICATE", 409);

    let row: Row;
    let affected = 1;
    if (action === "create") {
      const createInput = input as CreateProductInput;
      const resolvedMetadata = {
        ...createInput.metadata,
        productIndex: createInput.metadata.productIndex || this.allocateProductIndex(products)
      };
      row = {
        id: `products-demo-${crypto.randomUUID()}`,
        version: 1,
        ...resolvedMetadata,
        ...createInput.initial,
        sku: resolvedMetadata.productIndex || resolvedMetadata.skuCode,
        status: createInput.initial.isActive ? "active" : "draft",
        updatedAt: new Date().toISOString()
      };
      syncMockProductPublicTags(row, createInput.initial.tags);
      products.unshift(row);
      const inventoryRow: Row = {
        id: row.id,
        version: row.version,
        sku: row.sku,
        name: row.name,
        stock: createInput.initial.stock,
        warningThreshold: createInput.initial.warningThreshold,
        status: createInput.initial.stock <= 0 ? "out" : createInput.initial.warningThreshold > 0 && createInput.initial.stock <= createInput.initial.warningThreshold ? "low" : "normal",
        lastChange: "新增商品",
        updatedAt: row.updatedAt
      };
      (this.rows.inventory ||= []).unshift(inventoryRow);
    } else {
      const editInput = input as EditProductInput;
      const found = products.find((product) => product.id === editInput.id);
      if (!found) throw new ApiError("商品不存在或已更新", "PRODUCT_NOT_FOUND", 404);
      if (found.version !== editInput.expectedVersion) throw new ApiError("数据已被其他管理员更新", "DATA_VERSION_CONFLICT", 409);
      const before = productMetadata(found);
      const changed = JSON.stringify(before) !== JSON.stringify(editInput.metadata);
      row = found;
      if (changed) {
        Object.assign(row, editInput.metadata, {
          sku: editInput.metadata.productIndex || editInput.metadata.skuCode,
          version: row.version + 1,
          updatedAt: new Date().toISOString()
        });
      } else {
        affected = 0;
      }
    }

    const summary = projectMockProduct(row);
    const result = parseProductMutationResult({
      item: summary,
      affected,
      message: affected ? action === "create" ? "商品已新增" : "商品资料已更新" : "商品资料无需更新",
      requestId: `mock-${crypto.randomUUID()}`
    });
    this.mutationResults.set(options.idempotencyKey, { fingerprint, result });
    if (affected) this.pushEvent("products", row.id, action, row.version, action === "create" ? ["created"] : Object.keys(input.metadata));
    return structuredClone(result);
  }

  private allocateProductIndex(products: Row[]): string {
    const used = new Set(products.map((product) => productMetadata(product).productIndex).filter(Boolean));
    let seed = 1;
    let candidate = `P${String(seed).padStart(6, "0")}`;
    while (used.has(candidate)) {
      seed += 1;
      candidate = `P${String(seed).padStart(6, "0")}`;
    }
    return candidate;
  }

  private inventorySnapshot(id: string): InventorySnapshot {
    const inventory = (this.rows.inventory || []).find((row) => row.id === id);
    const product = (this.rows.products || []).find((row) => row.id === id);
    if (!inventory || !product) throw new ApiError("商品不存在或已更新", "PRODUCT_NOT_FOUND", 404);
    return parseInventorySnapshot({
      id,
      stock: inventory.stock,
      warningThreshold: inventory.warningThreshold,
      status: inventory.status,
      isActive: product.isActive !== false,
      version: product.version,
      updatedAt: inventory.updatedAt
    });
  }

  private syncMockInventoryAlert(inventory: Row): void {
    const alerts = (this.rows["inventory-alerts"] ||= []);
    const index = alerts.findIndex((row) => row.id === inventory.id);
    if (inventory.status === "normal") {
      if (index >= 0) alerts.splice(index, 1);
      return;
    }
    const stock = typeof inventory.stock === "number" ? inventory.stock : 0;
    const warningThreshold = typeof inventory.warningThreshold === "number" ? inventory.warningThreshold : 0;
    const alert: Row = {
      id: inventory.id,
      version: inventory.version,
      sku: inventory.sku,
      name: inventory.name,
      stock,
      warningThreshold,
      status: inventory.status,
      isActive: inventory.isActive,
      suggestion: inventory.status === "out"
        ? "已缺货，优先补货"
        : `建议补充 ${Math.max(0, warningThreshold - stock)} 件`,
      updatedAt: inventory.updatedAt
    };
    if (index >= 0) alerts.splice(index, 1, alert);
    else alerts.unshift(alert);
  }

  private pushEvent(
    resource: string,
    entityId: string,
    action: string,
    version: number,
    changedFields: string[] = ["status", "updatedAt"]
  ): void {
    const entityType = resource.replace(/-alerts$/, "").replace(/s$/, "").replace("after-sale", "after_sale");
    const cursor = String(this.eventLog.length + 1);
    this.eventLog.push({
      eventId: `mock-event-${cursor}`,
      eventType: `${entityType}.${action}`,
      entityType,
      entityId,
      action,
      version,
      changedFields,
      sourceClient: "mock",
      createdAt: new Date().toISOString(),
      cursor
    });
  }

  private batchEnableProducts(products: Row[], payload: Record<string, unknown>): MutationResult<Row> {
    const allowedFields = new Set(["isActive", "items", "reason"]);
    if (Object.keys(payload).some((key) => !allowedFields.has(key))) {
      throw new ApiError("请求包含不允许的字段", "INVALID_REQUEST_BODY", 400);
    }
    if (payload.isActive !== true) {
      throw new ApiError("批量上架目标状态必须为 true", "BATCH_TARGET_INVALID", 400);
    }
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new ApiError("请至少选择一个商品", "BATCH_ITEMS_REQUIRED", 400);
    }
    if (payload.items.length > 100) {
      throw new ApiError("单次最多上架 100 个商品", "BATCH_SIZE_EXCEEDED", 400);
    }
    if (payload.reason !== undefined
      && (typeof payload.reason !== "string" || payload.reason.trim().length > 120)) {
      throw new ApiError("操作说明格式无效", "INVALID_REQUEST_BODY", 400);
    }

    const itemsById = new Map<string, BatchEnableItem>();
    for (const candidate of payload.items) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new ApiError("批量商品快照无效，请刷新后重试", "BATCH_ITEM_INVALID", 400);
      }
      const item = candidate as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (Object.keys(item).some((key) => !["id", "expectedIsActive", "expectedVersion"].includes(key))) {
        throw new ApiError("批量商品快照包含不允许的字段", "BATCH_ITEM_INVALID", 400);
      }
      if (!id || id.length > 128) {
        throw new ApiError("批量商品缺少有效 ID", "PRODUCT_ID_REQUIRED", 400);
      }
      if (typeof item.expectedIsActive !== "boolean") {
        throw new ApiError("批量商品当前状态无效，请刷新后重试", "EXPECTED_STATUS_INVALID", 400);
      }
      if (typeof item.expectedVersion !== "number"
        || !Number.isSafeInteger(item.expectedVersion)
        || item.expectedVersion < 0) {
        throw new ApiError("批量商品数据版本无效，请刷新后重试", "EXPECTED_VERSION_INVALID", 400);
      }
      const normalized = {
        id,
        expectedIsActive: item.expectedIsActive,
        expectedVersion: item.expectedVersion
      };
      const existing = itemsById.get(id);
      if (existing
        && (existing.expectedIsActive !== normalized.expectedIsActive
          || existing.expectedVersion !== normalized.expectedVersion)) {
        throw new ApiError("同一商品存在冲突快照，请刷新后重试", "DUPLICATE_ITEM_CONFLICT", 400);
      }
      if (!existing) itemsById.set(id, normalized);
    }
    const normalizedItems = Array.from(itemsById.values());
    if (normalizedItems.length > 100) {
      throw new ApiError("单次最多上架 100 个商品", "BATCH_SIZE_EXCEEDED", 400);
    }

    let changedCount = 0;
    let unchangedCount = 0;
    const failures: Array<{ id: string; code: string }> = [];
    const changedProducts: Row[] = [];
    for (const input of normalizedItems) {
      const product = products.find((item) => item.id === input.id);
      if (!product) {
        failures.push({ id: input.id, code: "PRODUCT_NOT_FOUND" });
        continue;
      }
      if (typeof product.isActive !== "boolean") {
        failures.push({ id: input.id, code: "DATA_STATUS_INVALID" });
        continue;
      }
      if (!Number.isSafeInteger(product.version) || product.version < 0) {
        failures.push({ id: input.id, code: "DATA_VERSION_INVALID" });
        continue;
      }
      if (product.isActive !== input.expectedIsActive || product.version !== input.expectedVersion) {
        failures.push({ id: input.id, code: "DATA_VERSION_CONFLICT" });
        continue;
      }
      if (product.isActive) {
        unchangedCount += 1;
        continue;
      }
      product.isActive = true;
      product.status = "active";
      product.version += 1;
      product.updatedAt = new Date().toISOString();
      product.lastAction = "batch-enable";
      changedCount += 1;
      changedProducts.push(product);
    }

    for (const product of changedProducts) {
      this.pushEvent("products", product.id, "batch-enable", product.version);
    }
    const failedCount = failures.length;
    const message = failedCount > 0
      ? `已上架 ${changedCount} 个商品，${failedCount} 个未处理`
      : changedCount > 0 ? `已上架 ${changedCount} 个商品` : "所选商品已处于上架状态";
    return {
      affected: changedCount,
      changedCount,
      unchangedCount,
      failedCount,
      failures,
      message,
      requestId: `mock-${crypto.randomUUID()}`
    };
  }

  private batchPublicProductTags(products: Row[], payload: Record<string, unknown>): MutationResult<Row> {
    const allowedFields = new Set(["scope", "tag", "present", "items", "reason"]);
    if (Object.keys(payload).some((key) => !allowedFields.has(key))) {
      throw new ApiError("请求包含不允许的字段", "INVALID_REQUEST_BODY", 400);
    }
    if (payload.scope !== "public") {
      throw new ApiError("标签范围无效", "TAG_SCOPE_INVALID", 400);
    }
    if (!isPublicProductTag(payload.tag)) {
      throw new ApiError("公开标签无效", "PUBLIC_TAG_INVALID", 400);
    }
    if (typeof payload.present !== "boolean") {
      throw new ApiError("标签目标状态无效", "TAG_PRESENT_INVALID", 400);
    }
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new ApiError("请至少选择一个商品", "BATCH_ITEMS_REQUIRED", 400);
    }
    if (payload.items.length > 100) {
      throw new ApiError("单次最多处理 100 个商品", "BATCH_SIZE_EXCEEDED", 400);
    }
    if (payload.reason !== undefined
      && (typeof payload.reason !== "string" || payload.reason.trim().length > 120)) {
      throw new ApiError("操作说明格式无效", "REASON_INVALID", 400);
    }

    const itemsById = new Map<string, BatchPublicTagItem>();
    for (const candidate of payload.items) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new ApiError("批量商品快照无效", "BATCH_ITEM_INVALID", 400);
      }
      const item = candidate as Record<string, unknown>;
      if (Object.keys(item).some((key) => !["id", "expectedVersion", "expectedPresent"].includes(key))) {
        throw new ApiError("批量商品快照包含不允许的字段", "BATCH_ITEM_INVALID", 400);
      }
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id || id.length > 128) throw new ApiError("商品 ID 无效", "PRODUCT_ID_REQUIRED", 400);
      if (typeof item.expectedVersion !== "number" || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 0) {
        throw new ApiError("商品版本无效", "EXPECTED_VERSION_INVALID", 400);
      }
      if (typeof item.expectedPresent !== "boolean") {
        throw new ApiError("商品标签快照无效", "EXPECTED_PRESENT_INVALID", 400);
      }
      const normalized: BatchPublicTagItem = {
        id,
        expectedVersion: item.expectedVersion,
        expectedPresent: item.expectedPresent
      };
      const prior = itemsById.get(id);
      if (prior && (prior.expectedVersion !== normalized.expectedVersion
        || prior.expectedPresent !== normalized.expectedPresent)) {
        throw new ApiError("同一商品存在冲突快照", "DUPLICATE_ITEM_CONFLICT", 400);
      }
      if (!prior) itemsById.set(id, normalized);
    }

    const tag = payload.tag;
    const present = payload.present;
    let changedCount = 0;
    let unchangedCount = 0;
    const failures: Array<{ id: string; code: string }> = [];
    for (const input of itemsById.values()) {
      const product = products.find((item) => item.id === input.id);
      if (!product) {
        failures.push({ id: input.id, code: "PRODUCT_NOT_FOUND" });
        continue;
      }
      const tags = normalizePublicProductTags(product.tags);
      if (!tags) {
        failures.push({ id: input.id, code: "DATA_TAGS_INVALID" });
        continue;
      }
      if (!Number.isSafeInteger(product.version) || product.version < 0) {
        failures.push({ id: input.id, code: "DATA_VERSION_INVALID" });
        continue;
      }
      const currentPresent = tags.includes(tag);
      if (product.version !== input.expectedVersion || currentPresent !== input.expectedPresent) {
        failures.push({ id: input.id, code: "DATA_VERSION_CONFLICT" });
        continue;
      }
      if (currentPresent === present) {
        unchangedCount += 1;
        continue;
      }

      const nextTags = present ? [...tags, tag] : tags.filter((candidate) => candidate !== tag);
      syncMockProductPublicTags(product, nextTags);
      product.version += 1;
      product.updatedAt = new Date().toISOString();
      product.tagUpdatedAt = product.updatedAt;
      product.lastAction = "batch-tags";
      changedCount += 1;
      this.pushEvent(
        "products",
        product.id,
        "batch-tags",
        product.version,
        ["tags", "isNew", "isDefective", "isHot", "searchText", "updatedAt"]
      );
    }

    const failedCount = failures.length;
    const message = failedCount > 0
      ? `已更新 ${changedCount} 个商品，${failedCount} 个未处理`
      : changedCount > 0 ? `已更新 ${changedCount} 个商品` : "所选商品标签无需更新";
    return {
      affected: changedCount,
      changedCount,
      unchangedCount,
      failedCount,
      failures,
      message,
      requestId: `mock-${crypto.randomUUID()}`
    };
  }

  private applyAction(item: Row, action: string, payload: Record<string, unknown>): boolean {
    if (action === "change-price") {
      const currentPriceCents = item.salePriceCents;
      const newPriceCents = payload.newPriceCents;
      const expectedPriceCents = payload.expectedPriceCents;
      if (typeof currentPriceCents !== "number" || !Number.isSafeInteger(currentPriceCents) || currentPriceCents < 0) {
        throw new ApiError("商品售价数据异常，暂不能修改", "DATA_PRICE_INVALID", 409);
      }
      if (typeof newPriceCents !== "number" || !Number.isSafeInteger(newPriceCents) || newPriceCents < 0) {
        throw new ApiError("新售价必须是非负整数分", "INVALID_PRICE", 400);
      }
      if (typeof expectedPriceCents !== "number" || !Number.isSafeInteger(expectedPriceCents) || expectedPriceCents < 0) {
        throw new ApiError("原售价数据无效，请刷新后重试", "EXPECTED_PRICE_INVALID", 400);
      }
      if (currentPriceCents !== expectedPriceCents) {
        throw new ApiError("数据已被其他管理员更新", "DATA_VERSION_CONFLICT", 409);
      }
      if (currentPriceCents === newPriceCents) return false;
      item.salePriceCents = newPriceCents;
    }
    if (action === "toggle-status") {
      const targetIsActive = payload.isActive;
      const expectedIsActive = payload.expectedIsActive;
      if (typeof targetIsActive !== "boolean" || typeof expectedIsActive !== "boolean") {
        throw new ApiError("商品状态参数无效", "INVALID_PRODUCT_STATUS", 400);
      }
      if (typeof item.isActive !== "boolean") {
        throw new ApiError("商品状态数据异常，暂不能修改", "DATA_STATUS_INVALID", 409);
      }
      if (item.isActive !== expectedIsActive) {
        throw new ApiError("数据已被其他管理员更新", "DATA_VERSION_CONFLICT", 409);
      }
      if (item.isActive === targetIsActive) return false;
      item.isActive = targetIsActive;
      item.status = targetIsActive ? "active" : "inactive";
      item.lastAction = action;
      return true;
    }
    const statusByAction: Record<string, string> = {
      review: "approved_pending_payment",
      "batch-review": "approved_pending_payment",
      reject: "rejected",
      confirm: "paid",
      ship: "shipped",
      approve: "approved",
      process: "completed",
      disable: "disabled"
    };
    if (statusByAction[action]) item.status = statusByAction[action];
    if (action === "adjust") {
      throw new ApiError("库存调整必须使用严格 delta 契约", "INVALID_INVENTORY_ADJUSTMENT", 400);
    }
    if (action === "set-warning") {
      const warningThreshold = payload.warningThreshold;
      if (typeof warningThreshold !== "number" || !Number.isSafeInteger(warningThreshold) || warningThreshold < 0 || warningThreshold > 99_999) {
        throw new ApiError("预警值必须是 0 到 99999 的整数", "INVALID_WARNING_THRESHOLD", 400);
      }
      item.warningThreshold = warningThreshold;
      if (typeof item.stock === "number") {
        item.status = item.stock <= 0 ? "out" : warningThreshold > 0 && item.stock <= warningThreshold ? "low" : "normal";
      }
    }
    item.lastAction = action;
    return true;
  }

  private createDemoRow(resource: string, index: number): Row {
    const base = { id: `${resource}-demo-${Date.now()}`, version: 1, status: "draft", updatedAt: new Date().toISOString() };
    if (resource === "products") {
      const product = { ...base, sku: `DEMO-N${index}`, name: `新增演示商品 ${index}`, brand: "示例品牌", salePriceCents: 10000, isActive: false, tags: [] };
      syncMockProductPublicTags(product, []);
      return product;
    }
    if (resource === "admins") {
      return { ...base, status: "enabled", name: `新增演示管理员 ${index}`, username: `new.demo.${index}`, role: "customer_service", permissionSummary: "待分配", lastLoginAt: "" };
    }
    return base;
  }
}
