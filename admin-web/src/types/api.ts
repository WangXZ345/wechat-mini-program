import type { AdminProfile, LoginInput } from "./auth";
import type { SyncBatch } from "./realtime";
import type { CreateProductInput, EditProductInput, ProductDetail, ProductSummary } from "@/services/transport/product-write-contract";
import type {
  InventoryAdjustmentInput,
  InventoryResource,
  InventorySnapshot
} from "@/services/transport/inventory-adjustment-contract";
import type { ShipmentDetail } from "@/services/transport/shipment-query-contract";
import type { AccountDetail } from "@/services/transport/account-query-contract";

export interface ApiMeta {
  requestId?: string;
  serverTime?: string;
  version?: number;
  nextCursor?: string | null;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
  requestId?: string;
  serverTime?: string;
  meta?: ApiMeta;
  error?: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export interface ListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  sort?: string;
  cursor?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  nextCursor?: string | null;
}

export interface MutationOptions {
  idempotencyKey: string;
  expectedVersion?: number;
}

export interface MutationFailure {
  id: string;
  code: string;
}

export interface MutationResult<T = Record<string, unknown>> {
  item?: T;
  affected: number;
  changedCount?: number;
  unchangedCount?: number;
  failedCount?: number;
  failures?: MutationFailure[];
  message: string;
  accountRecalculationPending?: boolean;
  warning?: string;
  requestId?: string;
}

export interface SessionInvalidationReason {
  code: string;
  message: string;
  status?: number;
  requestId?: string;
}

export interface DashboardMetric {
  key: string;
  label: string;
  value: number;
  kind: "number" | "money";
  unit?: string;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
  route: string;
}

export interface DashboardTask {
  id: string;
  title: string;
  detail: string;
  count: number;
  route: string;
  tone: "neutral" | "warning" | "danger" | "info";
}

export interface DashboardData {
  metrics: DashboardMetric[];
  tasks: DashboardTask[];
  trend: Array<{ label: string; value: number }>;
  topProducts: Array<{ name: string; sku: string; value: number; change: number }>;
  updatedAt: string;
}

export interface ProductAnalyticsData {
  range: "7d" | "30d" | "90d";
  status: "available" | "empty" | "unavailable";
  message?: string;
  summary: Array<{ key: string; label: string; value: number | null; kind: "number" | "money"; change: number | null }>;
  series: Array<{
    date: string;
    salesCount: number;
    averagePriceCents: number | null;
    quotePriceCents: number | null;
    inventoryChange: number | null;
  }>;
  ranking: Array<{
    id: string;
    name: string;
    sku: string;
    salesCount: number;
    averagePriceCents: number | null;
    currentPriceCents: number | null;
    change: number | null;
  }>;
  updatedAt: string;
}

export interface AdminTransport {
  readonly mode: "mock" | "http";
  setSessionInvalidationHandler?(handler: (reason: SessionInvalidationReason) => void): void;
  login(input: LoginInput): Promise<AdminProfile>;
  logout(): Promise<void>;
  getCurrentProfile(): Promise<AdminProfile>;
  getDashboard(): Promise<DashboardData>;
  getProductAnalytics(range: "7d" | "30d" | "90d"): Promise<ProductAnalyticsData>;
  getProductDetail(id: string): Promise<ProductDetail>;
  getShipmentDetail(id: string): Promise<ShipmentDetail>;
  getAccountDetail(id: string, signal?: AbortSignal): Promise<AccountDetail>;
  createProduct(input: CreateProductInput, options: MutationOptions): Promise<MutationResult<ProductSummary>>;
  editProduct(input: EditProductInput, options: MutationOptions): Promise<MutationResult<ProductSummary>>;
  getInventorySnapshot(id: string): Promise<InventorySnapshot>;
  adjustInventory(
    resource: InventoryResource,
    input: InventoryAdjustmentInput,
    options: MutationOptions
  ): Promise<MutationResult<InventorySnapshot>>;
  list<T extends Record<string, unknown>>(resource: string, query: ListQuery): Promise<ListResult<T>>;
  get<T extends Record<string, unknown>>(resource: string, id: string): Promise<T>;
  mutate<T extends Record<string, unknown>>(
    resource: string,
    action: string,
    payload: Record<string, unknown>,
    options: MutationOptions
  ): Promise<MutationResult<T>>;
  catchUp(cursor?: string): Promise<SyncBatch>;
}
