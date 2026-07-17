import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { env } from "@/config/env";
import { ApiError, toApiError } from "@/services/http/api-error";
import type { AdminProfile, LoginInput } from "@/types/auth";
import { isAdminRole, ROLE_LABELS } from "@/types/auth";
import type { AdminTransport, ApiEnvelope, DashboardData, ListQuery, ListResult, MutationOptions, MutationResult, ProductAnalyticsData, SessionInvalidationReason } from "@/types/api";
import type { SyncBatch } from "@/types/realtime";
import { parseProductAnalyticsData } from "./product-analytics-contract";
import {
  inventorySnapshotFromResourceRow,
  normalizeInventoryAdjustmentInput,
  parseInventoryAdjustmentResult,
  type InventoryAdjustmentInput,
  type InventoryResource,
  type InventorySnapshot
} from "./inventory-adjustment-contract";
import {
  normalizeCreateProductInput,
  normalizeEditProductInput,
  parseProductDetail,
  parseProductMutationResult,
  type CreateProductInput,
  type EditProductInput,
  type ProductDetail,
  type ProductSummary
} from "./product-write-contract";
import { parseOrderDetail, parseOrderList, type OrderSummary } from "./order-query-contract";
import {
  parseShipmentDetail,
  parseShipmentListPage,
  type ShipmentDetail,
  type ShipmentSummary
} from "./shipment-query-contract";
import {
  parseAccountDetail,
  parseAccountListPage,
  type AccountDetail,
  type AccountSummary
} from "./account-query-contract";
import { parsePaymentDetail, parsePaymentListPage, type PaymentSummary } from "./payment-query-contract";
import {
  normalizePaymentMutationInput,
  parsePaymentMutationResult,
  toPaymentMutationRequest,
  type PaymentMutationAction
} from "./payment-mutation-contract";
import {
  normalizeAfterSaleReviewInput,
  parseAfterSaleReviewResult,
  toAfterSaleReviewRequest,
  type AfterSaleReviewAction
} from "./after-sale-review-contract";
import {
  normalizeReturnInspectionInput,
  parseReturnInspectionResult,
  toReturnInspectionRequest,
  type ReturnInspectionAction
} from "./return-inspection-contract";
import {
  normalizeRefundMutationInput,
  parseRefundMutationResult,
  type RefundMutationAction
} from "./refund-mutation-contract";

export class HttpBffTransport implements AdminTransport {
  readonly mode = "http" as const;
  private readonly client: AxiosInstance;
  private accessToken = "";
  private csrfToken = window.sessionStorage.getItem("admin-web.csrf-token") || "";
  private serverCsrfToken = this.csrfToken;
  private authEpoch = 0;
  private authTransitionQueue: Promise<void> = Promise.resolve();
  private refreshOperation: RefreshOperation | null = null;
  private sessionRevision = 0;
  private sessionInvalidationHandler: ((reason: SessionInvalidationReason) => void) | null = null;
  private sessionInvalidationNotified = false;
  private readonly orderCursors = new Map<string, Map<number, string | undefined>>();
  private readonly shipmentCursors = new Map<string, Map<number, string | undefined>>();
  private readonly accountCursors = new Map<string, Map<number, string | undefined>>();
  private readonly paymentCursors = new Map<string, Map<number, string | undefined>>();

  constructor(client?: AxiosInstance) {
    this.client = client ?? axios.create({
      baseURL: env.apiBaseUrl,
      timeout: env.requestTimeoutMs,
      withCredentials: true,
      headers: { Accept: "application/json" }
    });
    this.client.interceptors.request.use((config) => {
      if (this.accessToken) config.headers.Authorization = `Bearer ${this.accessToken}`;
      if (this.csrfToken && config.method?.toLowerCase() !== "get") config.headers["X-Admin-CSRF"] = this.csrfToken;
      return config;
    });
  }

  setSessionInvalidationHandler(handler: (reason: SessionInvalidationReason) => void): void {
    this.sessionInvalidationHandler = handler;
  }

  async login(input: LoginInput): Promise<AdminProfile> {
    const authEpoch = this.beginAuthTransition();
    return this.enqueueAuthTransition(async () => {
      this.assertAuthEpoch(authEpoch);
      const response = await this.client.post<ApiEnvelope<AuthSessionData>>("/auth/login", input);
      const session = this.unwrap(response);
      this.recordServerSession(session);
      const profile = this.normalizeProfile(session.profile);
      this.assertAuthEpoch(authEpoch);
      this.saveSession(session);
      return profile;
    });
  }

  async logout(): Promise<void> {
    const fallbackCsrfToken = this.serverCsrfToken || this.csrfToken;
    this.beginAuthTransition();
    return this.enqueueAuthTransition(async () => {
      const csrfToken = this.serverCsrfToken || fallbackCsrfToken;
      try {
        await this.client.post<ApiEnvelope<Record<string, never>>>("/auth/logout", {}, {
          headers: this.csrfHeaders(csrfToken)
        });
      } finally {
        if (this.serverCsrfToken === csrfToken) this.serverCsrfToken = "";
      }
    });
  }

  async getCurrentProfile(): Promise<AdminProfile> {
    if (!this.hasSessionMaterial()) throw new ApiError("请先登录", "AUTH_REQUIRED", 401);
    const data = await this.safeProfile();
    return this.normalizeProfile(data.profile);
  }

  async getDashboard(): Promise<DashboardData> {
    return this.safeGet<DashboardData>("/dashboard");
  }

  async getProductAnalytics(range: "7d" | "30d" | "90d"): Promise<ProductAnalyticsData> {
    const raw = await this.safeGet<unknown>("/analytics/products", { params: { range } });
    return parseProductAnalyticsData(raw, range);
  }

  async getProductDetail(id: string): Promise<ProductDetail> {
    const raw = await this.safeGet<unknown>(`/products/${encodeURIComponent(id)}`);
    return parseProductDetail(raw);
  }

  async getShipmentDetail(id: string): Promise<ShipmentDetail> {
    const raw = await this.safeGet<unknown>(`/shipments/${encodeURIComponent(id)}`);
    return parseShipmentDetail(raw);
  }

  async getAccountDetail(id: string, signal?: AbortSignal): Promise<AccountDetail> {
    const raw = await this.safeGet<unknown>(`/accounts/${encodeURIComponent(id)}`, { signal });
    return parseAccountDetail(raw);
  }

  async createProduct(input: CreateProductInput, options: MutationOptions): Promise<MutationResult<ProductSummary>> {
    const payload = normalizeCreateProductInput(input);
    const raw = await this.postProductMutation("create", payload, options);
    return parseProductMutationResult(raw);
  }

  async editProduct(input: EditProductInput, options: MutationOptions): Promise<MutationResult<ProductSummary>> {
    const payload = normalizeEditProductInput(input);
    if (options.expectedVersion !== payload.expectedVersion) {
      throw new ApiError("商品版本与请求选项不一致", "EXPECTED_VERSION_MISMATCH", 400);
    }
    const raw = await this.postProductMutation("edit", payload, options);
    return parseProductMutationResult(raw);
  }

  async getInventorySnapshot(id: string): Promise<InventorySnapshot> {
    const raw = await this.safeGet<unknown>(`/inventory/${encodeURIComponent(id)}`);
    return inventorySnapshotFromResourceRow(raw);
  }

  async adjustInventory(
    resource: InventoryResource,
    input: InventoryAdjustmentInput,
    options: MutationOptions
  ): Promise<MutationResult<InventorySnapshot>> {
    const payload = normalizeInventoryAdjustmentInput(input);
    if (options.expectedVersion !== payload.expectedVersion) {
      throw new ApiError("库存版本与请求选项不一致", "EXPECTED_VERSION_MISMATCH", 400);
    }
    if (!options.idempotencyKey) throw new ApiError("缺少幂等键", "IDEMPOTENCY_KEY_REQUIRED", 400);
    const raw = await this.requestWithSession(
      () => this.client.post<ApiEnvelope<unknown>>(
        `/${encodeURIComponent(resource)}/adjust`,
        payload,
        {
          headers: {
            ...this.csrfHeaders(),
            "Idempotency-Key": options.idempotencyKey
          }
        }
      ),
      false
    );
    return parseInventoryAdjustmentResult(raw);
  }

  async list<T extends Record<string, unknown>>(resource: string, query: ListQuery): Promise<ListResult<T>> {
    if (resource === "orders") {
      return this.listOrders(query) as unknown as Promise<ListResult<T>>;
    }
    if (resource === "shipments") {
      return this.listShipments(query) as unknown as Promise<ListResult<T>>;
    }
    if (resource === "accounts") {
      return this.listAccounts(query) as unknown as Promise<ListResult<T>>;
    }
    if (resource === "payments") {
      return this.listPayments(query) as unknown as Promise<ListResult<T>>;
    }
    return this.safeGet<ListResult<T>>(`/${encodeURIComponent(resource)}`, { params: query });
  }

  async get<T extends Record<string, unknown>>(resource: string, id: string): Promise<T> {
    if (resource === "orders") {
      const raw = await this.safeGet<unknown>(`/orders/${encodeURIComponent(id)}`);
      return parseOrderDetail(raw) as unknown as T;
    }
    if (resource === "shipments") return this.getShipmentDetail(id) as unknown as Promise<T>;
    if (resource === "accounts") return this.getAccountDetail(id) as unknown as Promise<T>;
    if (resource === "payments") {
      const raw = await this.safeGet<unknown>(`/payments/${encodeURIComponent(id)}`);
      return parsePaymentDetail(raw) as unknown as T;
    }
    return this.safeGet<T>(`/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`);
  }

  async mutate<T extends Record<string, unknown>>(
    resource: string,
    action: string,
    payload: Record<string, unknown>,
    options: MutationOptions
  ): Promise<MutationResult<T>> {
    if (resource === "payments" && (action === "confirm" || action === "reject")) {
      return this.mutatePayment(action, payload, options) as unknown as Promise<MutationResult<T>>;
    }
    if (resource === "after-sales" && (action === "approve" || action === "reject")) {
      return this.mutateAfterSaleReview(action, payload, options) as unknown as Promise<MutationResult<T>>;
    }
    if (resource === "after-sales" && (action === "receive" || action === "inspect")) {
      return this.mutateReturnInspection(action, payload, options) as unknown as Promise<MutationResult<T>>;
    }
    if (resource === "refunds" && (action === "process" || action === "reject")) {
      return this.mutateRefund(action, payload, options) as unknown as Promise<MutationResult<T>>;
    }
    return this.requestWithSession(
      () => this.client.post<ApiEnvelope<MutationResult<T>>>(
        `/${encodeURIComponent(resource)}/${encodeURIComponent(action)}`,
        { ...payload, expectedVersion: options.expectedVersion },
        {
          headers: {
            ...this.csrfHeaders(),
            "Idempotency-Key": options.idempotencyKey
          }
        }
      ),
      false
    );
  }

  private async mutatePayment(
    action: PaymentMutationAction,
    payload: Record<string, unknown>,
    options: MutationOptions
  ): Promise<ReturnType<typeof parsePaymentMutationResult>> {
    const input = normalizePaymentMutationInput(action, payload);
    if (options.expectedVersion !== input.expectedVersion) {
      throw new ApiError("付款版本与请求选项不一致", "EXPECTED_VERSION_MISMATCH", 400);
    }
    if (!options.idempotencyKey?.trim()) throw new ApiError("缺少幂等键", "IDEMPOTENCY_KEY_REQUIRED", 400);
    const request = toPaymentMutationRequest(input);
    const raw = await this.requestWithSession(
      () => this.client.post<ApiEnvelope<unknown>>(
        `/payments/${action}`,
        request,
        {
          headers: {
            ...this.csrfHeaders(),
            "Idempotency-Key": options.idempotencyKey
          }
        }
      )
    );
    return parsePaymentMutationResult(raw);
  }

  private async mutateAfterSaleReview(
    action: AfterSaleReviewAction,
    payload: Record<string, unknown>,
    options: MutationOptions
  ): Promise<ReturnType<typeof parseAfterSaleReviewResult>> {
    const input = normalizeAfterSaleReviewInput(action, payload);
    if (options.expectedVersion !== input.expectedVersion) {
      throw new ApiError("after-sale version does not match request options", "EXPECTED_VERSION_MISMATCH", 400);
    }
    if (!options.idempotencyKey?.trim()) throw new ApiError("missing idempotency key", "IDEMPOTENCY_KEY_REQUIRED", 400);
    const request = toAfterSaleReviewRequest(input);
    const raw = await this.requestWithSession(
      () => this.client.post<ApiEnvelope<unknown>>(
        `/after-sales/${action}`,
        request,
        {
          headers: {
            ...this.csrfHeaders(),
            "Idempotency-Key": options.idempotencyKey
          }
        }
      )
    );
    return parseAfterSaleReviewResult(raw);
  }

  private async mutateReturnInspection(
    action: ReturnInspectionAction,
    payload: Record<string, unknown>,
    options: MutationOptions
  ): Promise<ReturnType<typeof parseReturnInspectionResult>> {
    const input = normalizeReturnInspectionInput(action, payload);
    if (options.expectedVersion !== input.expectedVersion) {
      throw new ApiError("退货验收版本与请求选项不一致", "EXPECTED_VERSION_MISMATCH", 400);
    }
    if (!options.idempotencyKey?.trim()) throw new ApiError("缺少幂等键", "IDEMPOTENCY_KEY_REQUIRED", 400);
    const request = toReturnInspectionRequest(input);
    const raw = await this.requestWithSession(
      () => this.client.post<ApiEnvelope<unknown>>(
        `/after-sales/${action}`,
        request,
        {
          headers: {
            ...this.csrfHeaders(),
            "Idempotency-Key": options.idempotencyKey
          }
        }
      )
    );
    return parseReturnInspectionResult(raw);
  }

  private async mutateRefund(
    action: RefundMutationAction,
    payload: Record<string, unknown>,
    options: MutationOptions
  ): Promise<ReturnType<typeof parseRefundMutationResult>> {
    const request = normalizeRefundMutationInput(action, payload);
    if (options.expectedVersion !== request.expectedRefundVersion) {
      throw new ApiError("退款版本与请求选项不一致", "EXPECTED_VERSION_MISMATCH", 400);
    }
    if (!options.idempotencyKey?.trim()) throw new ApiError("缺少幂等键", "IDEMPOTENCY_KEY_REQUIRED", 400);
    const raw = await this.requestWithSession(
      () => this.client.post<ApiEnvelope<unknown>>(
        `/refunds/${action}`,
        request,
        {
          headers: {
            ...this.csrfHeaders(),
            "Idempotency-Key": options.idempotencyKey
          }
        }
      )
    );
    return parseRefundMutationResult(raw);
  }

  async catchUp(cursor?: string): Promise<SyncBatch> {
    return this.safeGet<SyncBatch>("/sync/events", { params: { cursor, limit: 200 } });
  }

  private async safeGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.requestWithSession(() => this.client.get<ApiEnvelope<T>>(url, config));
  }

  private async listOrders(query: ListQuery): Promise<ListResult<OrderSummary>> {
    const targetPage = Math.max(1, Math.trunc(query.page));
    const key = this.orderCursorKey(query);
    if (targetPage === 1) this.orderCursors.delete(key);
    const cursors = this.orderCursors.get(key) ?? new Map<number, string | undefined>([[1, undefined]]);
    this.orderCursors.set(key, cursors);

    let startPage = targetPage;
    if (!cursors.has(targetPage)) {
      startPage = Math.max(...Array.from(cursors.keys()).filter((page) => page < targetPage));
    }

    let result: ListResult<OrderSummary> | null = null;
    let exhaustedBeforeTarget = false;
    for (let page = startPage; page <= targetPage; page += 1) {
      const cursor = cursors.get(page);
      const params: ListQuery = { ...query, page };
      delete params.cursor;
      if (cursor) params.cursor = cursor;
      const raw = await this.safeGet<unknown>("/orders", { params });
      result = parseOrderList(raw);
      if (result.nextCursor) cursors.set(page + 1, result.nextCursor);
      else cursors.delete(page + 1);
      if (page < targetPage && !result.nextCursor) {
        exhaustedBeforeTarget = true;
        break;
      }
    }

    if (!result) throw new ApiError("订单分页响应为空", "INVALID_ORDER_CONTRACT", 502);
    if (exhaustedBeforeTarget) {
      return {
        items: [],
        total: result.total,
        page: targetPage,
        pageSize: query.pageSize,
        nextCursor: null
      };
    }
    return result;
  }

  private orderCursorKey(query: ListQuery): string {
    return JSON.stringify(Object.entries(query)
      .filter(([key, value]) => key !== "page" && key !== "cursor" && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)));
  }

  private async listShipments(query: ListQuery): Promise<ListResult<ShipmentSummary>> {
    const targetPage = Math.max(1, Math.trunc(query.page));
    const key = this.shipmentCursorKey(query);
    if (targetPage === 1) this.shipmentCursors.delete(key);
    const cursors = this.shipmentCursors.get(key) ?? new Map<number, string | undefined>([[1, undefined]]);
    this.shipmentCursors.set(key, cursors);

    let startPage = targetPage;
    if (!cursors.has(targetPage)) {
      startPage = Math.max(...Array.from(cursors.keys()).filter((page) => page < targetPage));
    }

    let result: ReturnType<typeof parseShipmentListPage> | null = null;
    let resultPage = startPage;
    let exhaustedBeforeTarget = false;
    for (let page = startPage; page <= targetPage; page += 1) {
      const params: Record<string, string | number> = { pageSize: query.pageSize };
      if (query.search) params.search = query.search;
      if (query.status) params.status = query.status;
      const cursor = cursors.get(page);
      if (cursor) params.cursor = cursor;
      const raw = await this.safeGet<unknown>("/shipments", { params });
      result = parseShipmentListPage(raw);
      resultPage = page;
      if (result.pageSize !== query.pageSize) {
        throw new ApiError("合并发货单分页大小与请求不一致", "INVALID_SHIPMENT_CONTRACT", 502);
      }
      if (result.nextCursor) cursors.set(page + 1, result.nextCursor);
      else cursors.delete(page + 1);
      if (page < targetPage && !result.nextCursor) {
        exhaustedBeforeTarget = true;
        break;
      }
    }

    if (!result) throw new ApiError("合并发货单分页响应为空", "INVALID_SHIPMENT_CONTRACT", 502);
    const total = result.hasMore
      ? resultPage * result.pageSize + 1
      : (resultPage - 1) * result.pageSize + result.items.length;
    if (exhaustedBeforeTarget) {
      return { items: [], total, page: targetPage, pageSize: result.pageSize, nextCursor: null };
    }
    return {
      items: result.items,
      total,
      page: targetPage,
      pageSize: result.pageSize,
      nextCursor: result.nextCursor
    };
  }

  private shipmentCursorKey(query: ListQuery): string {
    return JSON.stringify({
      pageSize: query.pageSize,
      search: query.search || "",
      status: query.status || ""
    });
  }

  private async listAccounts(query: ListQuery): Promise<ListResult<AccountSummary>> {
    const targetPage = Math.max(1, Math.trunc(query.page));
    const key = this.accountCursorKey(query);
    if (targetPage === 1) {
      this.accountCursors.set(key, new Map<number, string | undefined>([[1, undefined]]));
    }
    const cursors = this.accountCursors.get(key);
    if (!cursors?.has(targetPage)) {
      throw new ApiError("请从账款第一页开始并按顺序翻页", "ACCOUNT_PAGE_JUMP_NOT_ALLOWED", 400);
    }

    const params: Record<string, string | number> = { pageSize: query.pageSize };
    if (query.search) params.search = query.search;
    if (query.status) params.status = query.status;
    const cursor = cursors.get(targetPage);
    if (cursor) params.cursor = cursor;

    const raw = await this.safeGet<unknown>("/accounts", { params });
    const result = parseAccountListPage(raw);
    if (result.pageSize !== query.pageSize) {
      throw new ApiError("账款分页大小与请求不一致", "INVALID_ACCOUNT_CONTRACT", 502);
    }
    if (result.nextCursor) cursors.set(targetPage + 1, result.nextCursor);
    else cursors.delete(targetPage + 1);

    const total = result.hasMore
      ? targetPage * result.pageSize + 1
      : (targetPage - 1) * result.pageSize + result.items.length;
    return {
      items: result.items,
      total,
      page: targetPage,
      pageSize: result.pageSize,
      nextCursor: result.nextCursor
    };
  }

  private accountCursorKey(query: ListQuery): string {
    return JSON.stringify({
      pageSize: query.pageSize,
      search: query.search || "",
      status: query.status || ""
    });
  }

  private async listPayments(query: ListQuery): Promise<ListResult<PaymentSummary>> {
    const targetPage = Math.max(1, Math.trunc(query.page));
    const key = this.paymentCursorKey(query);
    if (targetPage === 1) this.paymentCursors.set(key, new Map<number, string | undefined>([[1, undefined]]));
    const cursors = this.paymentCursors.get(key);
    if (!cursors?.has(targetPage)) throw new ApiError("请从付款记录第一页开始并按顺序翻页", "PAYMENT_PAGE_JUMP_NOT_ALLOWED", 400);
    const params: Record<string, string | number> = { pageSize: query.pageSize };
    if (query.search) params.search = query.search;
    if (query.status) params.status = query.status;
    const cursor = cursors.get(targetPage);
    if (cursor) params.cursor = cursor;
    const raw = await this.safeGet<unknown>("/payments", { params });
    const result = parsePaymentListPage(raw);
    if (result.pageSize !== query.pageSize) throw new ApiError("付款记录分页大小与请求不一致", "INVALID_PAYMENT_CONTRACT", 502);
    if (result.nextCursor) cursors.set(targetPage + 1, result.nextCursor);
    else cursors.delete(targetPage + 1);
    const total = result.hasMore ? targetPage * result.pageSize + 1 : (targetPage - 1) * result.pageSize + result.items.length;
    return { items: result.items, total, page: targetPage, pageSize: result.pageSize, nextCursor: result.nextCursor };
  }

  private paymentCursorKey(query: ListQuery): string {
    return JSON.stringify({ pageSize: query.pageSize, search: query.search || "", status: query.status || "" });
  }

  private postProductMutation(action: "create" | "edit", payload: CreateProductInput | EditProductInput, options: MutationOptions): Promise<unknown> {
    if (!options.idempotencyKey) throw new ApiError("缺少幂等键", "IDEMPOTENCY_KEY_REQUIRED", 400);
    return this.requestWithSession(
      () => this.client.post<ApiEnvelope<unknown>>(
        `/products/${action}`,
        payload,
        {
          headers: {
            ...this.csrfHeaders(),
            "Idempotency-Key": options.idempotencyKey
          }
        }
      ),
      false
    );
  }

  private async safeProfile(): Promise<ProfileData> {
    return this.requestWithSession(
      () => this.client.post<ApiEnvelope<ProfileData>>("/auth/profile", {}, { headers: this.csrfHeaders() })
    );
  }

  private async requestWithSession<T>(
    request: () => Promise<AxiosResponse<ApiEnvelope<T>>>,
    retryNetwork = true
  ): Promise<T> {
    const requestAuthEpoch = this.authEpoch;
    let didRefresh = false;
    let networkRetry = 0;
    while (true) {
      this.assertAuthEpoch(requestAuthEpoch);
      const requestRevision = this.sessionRevision;
      try {
        const response = await request();
        this.assertAuthEpoch(requestAuthEpoch);
        return this.unwrap(response);
      } catch (error) {
        const apiError = toApiError(error);
        if (apiError.status === 401 && !didRefresh) {
          this.assertAuthEpoch(requestAuthEpoch);
          if (requestRevision !== this.sessionRevision) {
            if (!this.hasSessionMaterial()) throw apiError;
            didRefresh = true;
            continue;
          }
          didRefresh = true;
          if (!this.hasSessionMaterial()) throw apiError;
          try {
            await this.refreshSessionOnce(requestAuthEpoch, requestRevision);
            continue;
          } catch (refreshReason) {
            const refreshError = toApiError(refreshReason);
            if (requestAuthEpoch === this.authEpoch && this.isTerminalSessionError(refreshError)) {
              this.invalidateSession(refreshError);
            }
            throw refreshError;
          }
        }
        if (this.isTerminalSessionError(apiError)
          && requestAuthEpoch === this.authEpoch
          && requestRevision === this.sessionRevision) {
          this.invalidateSession(apiError);
        }
        if (retryNetwork && networkRetry < 1 && (apiError.code === "NETWORK_ERROR" || (apiError.status !== undefined && apiError.status >= 500))) {
          networkRetry += 1;
          await new Promise((resolve) => window.setTimeout(resolve, 300));
          continue;
        }
        throw apiError;
      }
    }
  }

  private unwrap<T>(response: AxiosResponse<ApiEnvelope<T>>): T {
    const envelope = response.data;
    if (!envelope.ok || envelope.data === undefined) {
      throw new ApiError(
        envelope.error?.message || envelope.message || "请求失败",
        envelope.error?.code || envelope.code || "API_ERROR",
        response.status,
        envelope.error?.requestId || envelope.requestId || envelope.meta?.requestId
      );
    }
    return envelope.data;
  }

  private csrfHeaders(token = this.csrfToken): Record<string, string> {
    return token ? { "X-Admin-CSRF": token } : {};
  }

  private refreshSessionOnce(authEpoch: number, sessionRevision: number): Promise<void> {
    if (this.refreshOperation) {
      if (this.refreshOperation.authEpoch === authEpoch && this.refreshOperation.sessionRevision === sessionRevision) {
        return this.refreshOperation.promise;
      }
      return Promise.reject(this.authTransitionSuperseded());
    }

    const refresh = this.enqueueAuthTransition(() => this.performRefresh(authEpoch, sessionRevision));
    const trackedRefresh = refresh.finally(() => {
      if (this.refreshOperation?.authEpoch === authEpoch
        && this.refreshOperation.sessionRevision === sessionRevision) {
        this.refreshOperation = null;
      }
    });
    this.refreshOperation = { authEpoch, sessionRevision, promise: trackedRefresh };
    return trackedRefresh;
  }

  private async performRefresh(authEpoch: number, sessionRevision: number): Promise<void> {
    this.assertSessionRevision(authEpoch, sessionRevision);
    const csrfToken = this.csrfToken;
    const response = await this.client.post<ApiEnvelope<AuthSessionData>>("/auth/refresh", {}, {
      headers: this.csrfHeaders(csrfToken)
    });
    const session = this.unwrap(response);
    this.recordServerSession(session);
    this.assertSessionRevision(authEpoch, sessionRevision);
    this.saveSession(session);
  }

  private recordServerSession(session: AuthSessionData): void {
    if (!session.accessToken || !session.csrfToken) {
      throw new ApiError("认证响应无效", "INVALID_AUTH_RESPONSE", 502);
    }
    this.serverCsrfToken = session.csrfToken;
  }

  private saveSession(session: AuthSessionData): void {
    this.accessToken = session.accessToken;
    this.csrfToken = session.csrfToken;
    window.sessionStorage.setItem("admin-web.csrf-token", session.csrfToken);
    this.sessionRevision += 1;
    this.sessionInvalidationNotified = false;
  }

  private beginAuthTransition(): number {
    this.authEpoch += 1;
    this.clearSession();
    this.sessionInvalidationNotified = false;
    return this.authEpoch;
  }

  private enqueueAuthTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.authTransitionQueue.then(operation, operation);
    this.authTransitionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertAuthEpoch(expected: number): void {
    if (expected !== this.authEpoch) throw this.authTransitionSuperseded();
  }

  private assertSessionRevision(authEpoch: number, sessionRevision: number): void {
    this.assertAuthEpoch(authEpoch);
    if (sessionRevision !== this.sessionRevision || !this.hasSessionMaterial()) {
      throw this.authTransitionSuperseded();
    }
  }

  private authTransitionSuperseded(): ApiError {
    return new ApiError("认证状态已切换", "AUTH_TRANSITION_SUPERSEDED", 409);
  }

  private hasSessionMaterial(): boolean {
    return Boolean(this.accessToken || this.csrfToken);
  }

  private clearSession(): void {
    const hadSession = this.hasSessionMaterial();
    this.accessToken = "";
    this.csrfToken = "";
    window.sessionStorage.removeItem("admin-web.csrf-token");
    if (hadSession) this.sessionRevision += 1;
  }

  private isTerminalSessionError(error: ApiError): boolean {
    return error.status === 401 || error.code === "CSRF_VALIDATION_FAILED";
  }

  private invalidateSession(error: ApiError): void {
    const hadSession = this.hasSessionMaterial();
    this.authEpoch += 1;
    this.clearSession();
    if (!hadSession || this.sessionInvalidationNotified) return;
    this.sessionInvalidationNotified = true;
    this.sessionInvalidationHandler?.({
      code: error.code || "SESSION_EXPIRED",
      message: "登录状态已失效，请重新登录",
      status: 401,
      requestId: error.requestId
    });
  }

  private normalizeProfile(raw: RawAdminProfile): AdminProfile {
    if (!isAdminRole(raw.role)) throw new ApiError("管理员角色无效", "FORBIDDEN", 403);
    const id = typeof raw.id === "string" && raw.id ? raw.id : "";
    const displayName = typeof raw.displayName === "string" && raw.displayName
      ? raw.displayName
      : typeof raw.name === "string" && raw.name
        ? raw.name
        : ROLE_LABELS[raw.role];
    const username = typeof raw.username === "string" && raw.username
      ? raw.username
      : typeof raw.phoneMasked === "string" && raw.phoneMasked
        ? raw.phoneMasked
        : id;
    const isActive = typeof raw.isActive === "boolean" ? raw.isActive : raw.status === "active";
    return {
      id,
      username,
      displayName,
      role: raw.role,
      roleName: typeof raw.roleName === "string" && raw.roleName ? raw.roleName : ROLE_LABELS[raw.role],
      permissions: Array.isArray(raw.permissions) ? raw.permissions.filter((item): item is string => typeof item === "string") : [],
      isActive,
      sessionExpiresAt: typeof raw.sessionExpiresAt === "string" ? raw.sessionExpiresAt : undefined
    };
  }
}

interface AuthSessionData {
  accessToken: string;
  accessExpiresAt: string;
  csrfToken: string;
  sessionId: string;
  profile: RawAdminProfile;
}

interface RefreshOperation {
  authEpoch: number;
  sessionRevision: number;
  promise: Promise<void>;
}

interface ProfileData {
  sessionId: string;
  accessExpiresAt: string;
  profile: RawAdminProfile;
}

interface RawAdminProfile {
  id?: unknown;
  name?: unknown;
  phoneMasked?: unknown;
  username?: unknown;
  displayName?: unknown;
  role?: unknown;
  roleName?: unknown;
  permissions?: unknown;
  status?: unknown;
  isActive?: unknown;
  sessionExpiresAt?: unknown;
}
