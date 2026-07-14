<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElDrawer,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElPagination,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElOption,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTooltip
} from "element-plus";
import { Eye, FilterX, Plus, RefreshCw, Search, SlidersHorizontal } from "lucide-vue-next";
import PageHeader from "@/components/PageHeader.vue";
import ProductEditorDialog from "@/modules/products/ProductEditorDialog.vue";
import InventoryAdjustDialog from "@/modules/inventory/InventoryAdjustDialog.vue";
import { resourceDefinitions, statusLabels } from "@/config/resources";
import { toApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import {
  PUBLIC_PRODUCT_TAGS,
  buildProductTagMutationPayload,
  isProductTagSnapshotRow,
  parseProductTagMutationResult,
  type ProductTagSnapshotRow,
  type PublicProductTag
} from "@/services/transport/product-tag-contract";
import { useAppStore } from "@/stores/app";
import { useAuthStore } from "@/stores/auth";
import type { ApiError } from "@/services/http/api-error";
import type { ResourceActionDefinition, ResourceDefinition, TableColumnDefinition } from "@/types/resource";
import type { SyncEvent } from "@/types/realtime";
import type { InventoryResource } from "@/services/transport/inventory-adjustment-contract";
import { createIdempotencyKey, formatDateTime, formatMoney } from "@/utils/format";

type Row = Record<string, unknown> & { id: string; version?: number };

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const app = useAppStore();
const fallbackDefinition = resourceDefinitions.products as ResourceDefinition;
const definition = computed(() => resourceDefinitions[String(route.meta.resource || "")] || fallbackDefinition);

const rows = ref<Row[]>([]);
const loading = ref(false);
const operationLoading = ref(false);
const error = ref<ApiError | null>(null);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const search = ref("");
const status = ref("");
const selection = ref<Row[]>([]);
const detailOpen = ref(false);
const selectedRow = ref<Row | null>(null);
const actionOpen = ref(false);
const productEditorOpen = ref(false);
const productEditorMode = ref<"create" | "edit">("create");
const productEditorId = ref("");
const inventoryAdjustOpen = ref(false);
const inventoryAdjustTarget = reactive<{
  id: string;
  name: string;
  sku: string;
  resource: InventoryResource;
}>({ id: "", name: "", sku: "", resource: "inventory" });
const activeAction = ref<ResourceActionDefinition | null>(null);
const actionForm = reactive<{ value: number | null; note: string }>({ value: null, note: "" });
const actionIdempotencyKey = ref("");
const actionAttemptFingerprint = ref("");
const actionExpectedWarningThreshold = ref<number | null>(null);
const actionExpectedPriceCents = ref<number | null>(null);
const actionExpectedIsActive = ref<boolean | null>(null);
const actionTargetIsActive = ref<boolean | null>(null);
const productTagForm = reactive<{ tag: PublicProductTag; present: boolean }>({ tag: "新货", present: true });
let searchTimer: number | null = null;
let syncRefreshPending = false;

const hasWriteActions = computed(() => Boolean(definition.value.primaryAction || definition.value.rowActions.length || definition.value.bulkActions.length));
const actions = computed(() => [
  ...(definition.value.primaryAction ? [definition.value.primaryAction] : []),
  ...definition.value.rowActions,
  ...definition.value.bulkActions
]);
const hasUnavailableWriteActions = computed(() => transport.mode === "http" && actions.value.some((action) => !action.realEnabled));
const hasAvailableWriteActions = computed(() => actions.value.some(isActionServiceAvailable));
const canUseAvailableWriteAction = computed(() => actions.value.some((action) => isActionServiceAvailable(action)
  && (!action.permission || auth.can(action.permission))));
const actionTitle = computed(() => activeAction.value?.key === "toggle-status" && typeof actionTargetIsActive.value === "boolean"
  ? `${actionTargetIsActive.value ? "上架" : "下架"}商品`
  : activeAction.value?.confirmTitle || activeAction.value?.label || "确认操作");
const actionConfirmText = computed(() => activeAction.value?.key === "toggle-status" && typeof actionTargetIsActive.value === "boolean"
  ? `确认${actionTargetIsActive.value ? "上架" : "下架"}`
  : activeAction.value?.key === "batch-tags"
    ? `确认${productTagForm.present ? "添加" : "移除"}`
    : "确认提交");

function isActionServiceAvailable(action: ResourceActionDefinition): boolean {
  return transport.mode === "mock" || action.realEnabled === true;
}

function isValidWarningThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 99_999;
}

function isValidPriceCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isValidProductBatchRow(row: Row): row is Row & { id: string; isActive: boolean; version: number } {
  return typeof row.id === "string"
    && row.id.trim().length > 0
    && row.id.trim().length <= 128
    && isBoolean(row.isActive)
    && typeof row.version === "number"
    && Number.isSafeInteger(row.version)
    && row.version >= 0;
}

function isValidProductTagSelection(value: Row[]): value is ProductTagSnapshotRow[] {
  if (value.length < 1 || value.length > 100 || value.some((row) => !isProductTagSnapshotRow(row))) return false;
  return new Set(value.map((row) => row.id.trim())).size === value.length;
}

function productStatusLabel(value: unknown): string {
  return value === true ? "上架" : value === false ? "下架" : "状态异常";
}

function rowActionLabel(action: ResourceActionDefinition, row: Record<string, unknown>): string {
  if (action.key !== "toggle-status") return action.label;
  return isBoolean(row.isActive) ? row.isActive ? "下架" : "上架" : action.label;
}

function yuanToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 1e-6) return null;
  return cents;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const result = await transport.list<Row>(definition.value.key, {
      page: page.value,
      pageSize: pageSize.value,
      search: search.value,
      status: status.value
    });
    rows.value = result.items;
    total.value = result.total;
    selection.value = [];
  } catch (reason) {
    error.value = toApiError(reason);
  } finally {
    loading.value = false;
  }
}

function scheduleSearch(): void {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    page.value = 1;
    void load();
  }, 300);
}

function resetFilters(): void {
  search.value = "";
  status.value = "";
  page.value = 1;
  void load();
}

function openDetails(row: Record<string, unknown>): void {
  selectedRow.value = row as Row;
  detailOpen.value = true;
}

function beginAction(action: ResourceActionDefinition, row?: Record<string, unknown>): void {
  if (!isActionServiceAvailable(action)) {
    ElMessage.warning("当前页面暂不支持网页写操作");
    return;
  }
  if (action.permission && !auth.can(action.permission)) return;
  if (action.key === "adjust" && ["inventory", "inventory-alerts"].includes(definition.value.key)) {
    if (!row || typeof row.id !== "string" || !row.id.trim()) {
      ElMessage.warning("请从商品所在行发起库存调整");
      return;
    }
    inventoryAdjustTarget.id = row.id.trim();
    inventoryAdjustTarget.name = typeof row.name === "string" ? row.name : "";
    inventoryAdjustTarget.sku = typeof row.sku === "string" ? row.sku : "";
    inventoryAdjustTarget.resource = definition.value.key as InventoryResource;
    inventoryAdjustOpen.value = true;
    return;
  }
  if (["view", "view-log", "view-ledger"].includes(action.key) && row) {
    openDetails(row);
    return;
  }
  if (definition.value.key === "products" && (action.key === "create" || action.key === "edit")) {
    if (action.key === "edit" && (!row || typeof row.id !== "string" || !row.id.trim())) {
      ElMessage.error("缺少需要编辑的商品");
      return;
    }
    productEditorMode.value = action.key;
    productEditorId.value = action.key === "edit" ? String(row?.id || "") : "";
    productEditorOpen.value = true;
    return;
  }
  if (action.bulk && !selection.value.length) {
    ElMessage.warning("请先选择至少一条记录");
    return;
  }
  if (action.key === "toggle-status" && !isBoolean(row?.isActive)) {
    ElMessage.error("当前商品状态异常，请刷新后重试");
    return;
  }
  if (action.key === "batch-tags" && !isValidProductTagSelection(selection.value)) {
    ElMessage.error("所选商品的标签或版本数据异常，请刷新后重试");
    return;
  }
  activeAction.value = action;
  selectedRow.value = row ? row as Row : null;
  const currentValue = action.key.includes("warning") ? row?.warningThreshold : 0;
  actionExpectedPriceCents.value = action.key === "change-price" && isValidPriceCents(row?.salePriceCents)
    ? row.salePriceCents
    : null;
  actionExpectedIsActive.value = action.key === "toggle-status" && isBoolean(row?.isActive)
    ? row.isActive
    : null;
  actionTargetIsActive.value = action.key === "toggle-status" && isBoolean(row?.isActive)
    ? !row.isActive
    : null;
  actionForm.value = action.key === "change-price"
    ? actionExpectedPriceCents.value === null ? null : actionExpectedPriceCents.value / 100
    : action.key.includes("warning")
      ? isValidWarningThreshold(currentValue) ? currentValue : null
      : typeof currentValue === "number" && Number.isSafeInteger(currentValue) ? currentValue : null;
  actionExpectedWarningThreshold.value = action.key === "set-warning" && isValidWarningThreshold(row?.warningThreshold)
    ? row.warningThreshold
    : null;
  productTagForm.tag = "新货";
  productTagForm.present = true;
  actionForm.note = "";
  actionIdempotencyKey.value = createIdempotencyKey(`${definition.value.key}:${action.key}`);
  actionAttemptFingerprint.value = "";
  actionOpen.value = true;
}

async function confirmAction(): Promise<void> {
  const action = activeAction.value;
  if (!action || operationLoading.value) return;
  if (action.key === "change-price" && !isValidPriceCents(actionExpectedPriceCents.value)) {
    ElMessage.error("当前售价数据异常，请刷新后重试");
    return;
  }
  const newPriceCents = action.key === "change-price" ? yuanToCents(actionForm.value) : null;
  if (action.key === "change-price" && newPriceCents === null) {
    ElMessage.warning("新售价必须是非负金额，最多两位小数");
    return;
  }
  if (action.key === "change-price" && !selectedRow.value?.id) {
    ElMessage.error("缺少需要改价的商品");
    return;
  }
  if (action.key === "toggle-status" && (!isBoolean(actionExpectedIsActive.value) || !isBoolean(actionTargetIsActive.value))) {
    ElMessage.error("当前商品状态异常，请刷新后重试");
    return;
  }
  if (action.key === "toggle-status" && !selectedRow.value?.id) {
    ElMessage.error("缺少需要上下架的商品");
    return;
  }
  if (action.key === "batch-enable"
    && (selection.value.length === 0
      || selection.value.length > 100
      || selection.value.some((row) => !isValidProductBatchRow(row)))) {
    ElMessage.error("所选商品的状态或版本异常，请刷新后重试");
    return;
  }
  if (action.key === "batch-tags" && !isValidProductTagSelection(selection.value)) {
    ElMessage.error("所选商品的标签或版本数据异常，请刷新后重试");
    return;
  }
  if (action.key === "set-warning" && !isValidWarningThreshold(actionExpectedWarningThreshold.value)) {
    ElMessage.error("当前预警值数据异常，请刷新后重试");
    return;
  }
  if (action.key === "set-warning"
    && !isValidWarningThreshold(actionForm.value)) {
    ElMessage.warning("预警值必须是 0 到 99999 的整数");
    return;
  }
  if (action.key === "set-warning" && !selectedRow.value?.id) {
    ElMessage.error("缺少需要设置预警值的商品");
    return;
  }
  if ((action.key === "review" || action.key === "reject") && !selectedRow.value?.id) {
    ElMessage.error("缺少需要审核的订单");
    return;
  }
  if ((action.key === "review" || action.key === "reject")
    && !["pending_admin", "auto_reviewing"].includes(String(selectedRow.value?.status || ""))) {
    ElMessage.error("当前订单状态不可审核，请刷新后重试");
    return;
  }
  if (action.key === "reject" && !actionForm.note.trim()) {
    ElMessage.warning("请填写驳回原因");
    return;
  }
  operationLoading.value = true;
  try {
    const payload: Record<string, unknown> = action.key === "change-price"
      ? {
          id: selectedRow.value!.id,
          newPriceCents,
          expectedPriceCents: actionExpectedPriceCents.value,
          reason: actionForm.note
        }
      : action.key === "toggle-status"
        ? {
            id: selectedRow.value!.id,
            isActive: actionTargetIsActive.value,
            expectedIsActive: actionExpectedIsActive.value,
            reason: actionForm.note
          }
      : action.key === "batch-enable"
        ? {
            isActive: true,
            items: selection.value.map((item) => ({
              id: item.id.trim(),
              expectedIsActive: item.isActive,
              expectedVersion: item.version
            })),
            reason: actionForm.note
          }
      : action.key === "batch-tags"
        ? buildProductTagMutationPayload(
            selection.value as ProductTagSnapshotRow[],
            productTagForm.tag,
            productTagForm.present,
            actionForm.note
          )
      : action.key === "set-warning"
      ? {
          id: selectedRow.value!.id,
          warningThreshold: actionForm.value,
          expectedWarningThreshold: actionExpectedWarningThreshold.value,
          reason: actionForm.note
        }
      : (action.key === "review" || action.key === "reject")
      ? {
          id: selectedRow.value!.id,
          expectedStatus: selectedRow.value!.status,
          reason: actionForm.note
        }
      : {
          id: selectedRow.value?.id,
          ids: action.bulk ? selection.value.map((item) => item.id) : undefined,
          value: actionForm.value,
          remark: actionForm.note
        };
    const expectedVersion = selectedRow.value?.version;
    const attemptFingerprint = JSON.stringify({
      resource: definition.value.key,
      action: action.key,
      payload,
      expectedVersion: expectedVersion ?? null
    });
    if (actionAttemptFingerprint.value && actionAttemptFingerprint.value !== attemptFingerprint) {
      actionIdempotencyKey.value = createIdempotencyKey(`${definition.value.key}:${action.key}`);
    }
    actionAttemptFingerprint.value = attemptFingerprint;
    const rawResult = await transport.mutate<Row>(definition.value.key, action.key, payload, {
      idempotencyKey: actionIdempotencyKey.value,
      expectedVersion
    });
    const result = action.key === "batch-tags"
      ? parseProductTagMutationResult(rawResult, selection.value.map((item) => item.id.trim()))
      : rawResult;
    if ((action.key === "review" || action.key === "reject") && result.accountRecalculationPending === true) {
      ElMessage.warning("订单已审核，客户账款汇总将在稍后更新");
    } else if ((result.failedCount ?? result.failures?.length ?? 0) > 0) {
      ElMessage.warning(result.message);
    } else {
      ElMessage.success(result.message);
    }
    syncRefreshPending = false;
    actionOpen.value = false;
    await load();
  } catch (reason) {
    const apiError = toApiError(reason);
    if (apiError.code === "DATA_VERSION_CONFLICT") {
      if (action.key === "batch-tags") {
        syncRefreshPending = false;
        actionOpen.value = false;
        await load();
        ElMessage.error(error.value ? "标签数据已变化且刷新失败，请重新加载" : "标签数据已变化，请重新选择商品后提交");
        return;
      }
      const selectedId = selectedRow.value?.id;
      syncRefreshPending = false;
      await load();
      const refreshedRow = !error.value && selectedId ? rows.value.find((row) => row.id === selectedId) : undefined;
      if (refreshedRow) {
        selectedRow.value = refreshedRow;
        if (action.key === "change-price" && isValidPriceCents(refreshedRow.salePriceCents)) {
          actionExpectedPriceCents.value = refreshedRow.salePriceCents;
          actionIdempotencyKey.value = createIdempotencyKey(`${definition.value.key}:${action.key}`);
          actionAttemptFingerprint.value = "";
          ElMessage.error("记录已变化，已刷新最新售价，请重新确认");
        } else if (action.key === "change-price") {
          actionExpectedPriceCents.value = null;
          ElMessage.error("记录已变化，但最新售价数据异常，暂不能修改");
        } else if (action.key === "toggle-status" && isBoolean(refreshedRow.isActive)) {
          actionExpectedIsActive.value = refreshedRow.isActive;
          actionIdempotencyKey.value = createIdempotencyKey(`${definition.value.key}:${action.key}`);
          actionAttemptFingerprint.value = "";
          ElMessage.error(`记录已变化，已刷新最新状态，请重新确认${actionTargetIsActive.value ? "上架" : "下架"}`);
        } else if (action.key === "toggle-status") {
          actionExpectedIsActive.value = null;
          ElMessage.error("记录已变化，但最新商品状态异常，暂不能修改");
        } else if (action.key === "set-warning" && isValidWarningThreshold(refreshedRow.warningThreshold)) {
          actionExpectedWarningThreshold.value = refreshedRow.warningThreshold;
          actionIdempotencyKey.value = createIdempotencyKey(`${definition.value.key}:${action.key}`);
          actionAttemptFingerprint.value = "";
          ElMessage.error("记录已变化，已刷新最新数据，请重新确认");
        } else if (action.key === "set-warning") {
          actionExpectedWarningThreshold.value = null;
          ElMessage.error("记录已变化，但最新预警值数据异常，暂不能修改");
        } else {
          actionIdempotencyKey.value = createIdempotencyKey(`${definition.value.key}:${action.key}`);
          actionAttemptFingerprint.value = "";
          ElMessage.error("记录已变化，已刷新最新数据，请重新确认");
        }
      } else {
        ElMessage.error(error.value ? "记录已变化，但刷新失败，请重新加载" : "记录已变化，最新记录不可用，请重新加载");
      }
    } else {
      ElMessage.error(apiError.message);
    }
  } finally {
    operationLoading.value = false;
  }
}

function closeActionDialog(): void {
  if (!operationLoading.value) actionOpen.value = false;
}

function guardActionClose(done: () => void): void {
  if (!operationLoading.value) done();
}

function handleSync(event: Event): void {
  const detail = (event as CustomEvent<{ events: SyncEvent[] }>).detail;
  if (!detail?.events.some((item) => item.entityType === definition.value.entityType)) return;
  if (selection.value.length || detailOpen.value || actionOpen.value || inventoryAdjustOpen.value) {
    syncRefreshPending = true;
    return;
  }
  void load();
}

function tagType(value: unknown): "success" | "warning" | "danger" | "info" | "primary" {
  if (["active", "normal", "paid", "approved", "completed", "enabled", "success", "shipped"].includes(String(value))) return "success";
  if (["low", "warning", "pending_confirm", "pending_admin", "pending_review", "pending_refund", "processing", "approved_pending_payment", "pending_shipment"].includes(String(value))) return "warning";
  if (["out", "rejected", "cancelled", "disabled", "overdue"].includes(String(value))) return "danger";
  return "info";
}

function cellText(row: Record<string, unknown>, column: TableColumnDefinition): string {
  const value = row[column.key];
  if (column.kind === "money") return formatMoney(value);
  if (column.kind === "date") return formatDateTime(value);
  if (column.kind === "status") {
    if (definition.value.key === "shipments" && value === "abnormal") return "异常";
    if (definition.value.key === "accounts") {
      const labels: Record<string, string> = {
        unpaid: "未结清",
        pending_confirm: "待确认",
        abnormal: "异常",
        settled: "已结清"
      };
      return labels[String(value)] || String(value || "-");
    }
    return statusLabels[String(value)] || String(value || "-");
  }
  if (column.kind === "role") {
    const labels: Record<string, string> = { super_admin: "超级管理员", customer_service: "客服", finance: "财务", procurement: "采购" };
    return labels[String(value)] || String(value || "-");
  }
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function openStandaloneDetail(): void {
  if (!selectedRow.value) return;
  if (["products", "orders", "shipments", "accounts"].includes(definition.value.key)) {
    void router.push(`/${definition.value.key}/${selectedRow.value.id}`);
  }
}

async function handleProductSaved(message: string): Promise<void> {
  ElMessage.success(message);
  syncRefreshPending = false;
  await load();
}

async function handleInventoryAdjusted(message: string): Promise<void> {
  ElMessage.success(message);
  syncRefreshPending = false;
  await load();
}

watch(() => route.meta.resource, () => {
  page.value = 1;
  search.value = "";
  status.value = "";
  void load();
});

watch([() => selection.value.length, detailOpen, actionOpen, productEditorOpen, inventoryAdjustOpen], ([selectedCount, detailsVisible, actionVisible, editorVisible, inventoryAdjustVisible]) => {
  if (!syncRefreshPending || selectedCount || detailsVisible || actionVisible || editorVisible || inventoryAdjustVisible) return;
  syncRefreshPending = false;
  void load();
});

onMounted(() => {
  window.addEventListener("admin-web:sync-events", handleSync);
  void load();
});

onBeforeUnmount(() => {
  window.removeEventListener("admin-web:sync-events", handleSync);
  if (searchTimer) window.clearTimeout(searchTimer);
});
</script>

<template>
  <div class="page-shell" :class="`density-${app.density}`">
    <page-header :title="definition.title" :description="definition.description">
      <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
      <el-button
        v-if="definition.primaryAction"
        :type="definition.primaryAction.type || 'primary'"
        :icon="Plus"
        :data-action-key="definition.primaryAction.key"
        data-action-scope="primary"
        :disabled="!isActionServiceAvailable(definition.primaryAction) || Boolean(definition.primaryAction.permission && !auth.can(definition.primaryAction.permission))"
        @click="beginAction(definition.primaryAction)"
      >
        {{ definition.primaryAction.label }}
      </el-button>
    </page-header>

    <el-alert
      v-if="hasUnavailableWriteActions && hasWriteActions"
      :title="hasAvailableWriteActions ? '部分写操作尚未开放' : '当前页面为只读，写操作尚未开放'"
      type="warning"
      :closable="false"
      show-icon
    />

    <el-alert
      v-if="hasAvailableWriteActions && !canUseAvailableWriteAction"
      title="当前角色为只读访问，写操作仍会由服务端再次校验"
      type="info"
      :closable="false"
      show-icon
    />

    <section class="surface table-surface">
      <div class="toolbar">
        <el-input
          v-model="search"
          :placeholder="definition.searchPlaceholder"
          clearable
          class="search-input"
          @input="scheduleSearch"
          @clear="scheduleSearch"
        >
          <template #prefix><Search :size="16" /></template>
        </el-input>
        <el-select v-model="status" class="status-filter" @change="page = 1; load()">
          <template #prefix><sliders-horizontal :size="15" /></template>
          <el-option v-for="option in definition.statusOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-tooltip content="清除全部筛选" placement="top">
          <el-button :icon="FilterX" circle @click="resetFilters"><span class="sr-only">清除筛选</span></el-button>
        </el-tooltip>
        <div class="toolbar__spacer" />
        <span v-if="selection.length" class="selection-count">已选 {{ selection.length }} 项</span>
        <el-button
          v-for="action in definition.bulkActions"
          :key="action.key"
          :data-action-key="action.key"
          data-action-scope="bulk"
          :disabled="!isActionServiceAvailable(action) || !selection.length || Boolean(action.permission && !auth.can(action.permission))"
          @click="beginAction(action)"
        >
          {{ action.label }}
        </el-button>
      </div>

      <div v-if="error" class="state-panel">
        <el-alert :title="error.message" :description="`错误码：${error.code}`" type="error" :closable="false" show-icon />
        <el-button :icon="RefreshCw" @click="load">重新加载</el-button>
      </div>

      <el-table
        v-else
        v-loading="loading"
        :data="rows"
        row-key="id"
        height="calc(100vh - 316px)"
        :empty-text="definition.emptyText"
        highlight-current-row
        @selection-change="selection = $event"
        @row-dblclick="openDetails"
      >
        <el-table-column v-if="definition.bulkActions.length" type="selection" width="46" fixed="left" />
        <el-table-column
          v-for="column in definition.columns"
          :key="column.key"
          :prop="column.key"
          :label="column.label"
          :width="column.width"
          :min-width="column.minWidth"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <el-tag v-if="column.kind === 'status'" :type="tagType(row[column.key])" effect="light" size="small">
              {{ cellText(row, column) }}
            </el-tag>
            <span v-else :class="{ money: column.kind === 'money', numeric: column.kind === 'number' }">
              {{ cellText(row, column) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="224" fixed="right" align="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-tooltip content="查看详情" placement="top">
                <el-button text circle :icon="Eye" @click="openDetails(row)"><span class="sr-only">查看详情</span></el-button>
              </el-tooltip>
              <el-button
                v-for="action in definition.rowActions.slice(0, 3)"
                :key="action.key"
                text
                :type="action.type || 'primary'"
                :data-action-key="action.key"
                data-action-scope="row"
                :disabled="!isActionServiceAvailable(action) || Boolean(action.permission && !auth.can(action.permission))"
                @click="beginAction(action, row)"
              >
                {{ rowActionLabel(action, row) }}
              </el-button>
            </div>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :description="definition.emptyText" :image-size="76">
            <el-button @click="resetFilters">重置筛选</el-button>
          </el-empty>
        </template>
      </el-table>

      <footer v-if="!error" class="pagination-bar">
        <span>共 {{ total }} 条</span>
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="sizes, prev, pager, next"
          background
          @current-change="load"
          @size-change="page = 1; load()"
        />
      </footer>
    </section>

    <el-drawer v-model="detailOpen" :title="`${definition.title}详情`" size="min(760px, 76vw)" destroy-on-close>
      <div v-if="selectedRow" class="detail-drawer">
        <div class="detail-drawer__heading">
          <div>
            <strong>{{ selectedRow.name || selectedRow.orderNo || selectedRow.shipmentNo || selectedRow.refundNo || selectedRow.id }}</strong>
            <span>版本 {{ selectedRow.version ?? 0 }}</span>
          </div>
          <el-button v-if="['products', 'orders', 'shipments', 'accounts'].includes(definition.key)" @click="openStandaloneDetail">打开详情页</el-button>
        </div>
        <dl class="detail-grid">
          <template v-for="column in definition.columns" :key="column.key">
            <dt>{{ column.label }}</dt>
            <dd :class="{ money: column.kind === 'money' }">{{ cellText(selectedRow, column) }}</dd>
          </template>
        </dl>
      </div>
    </el-drawer>

    <el-dialog
      v-model="actionOpen"
      :title="actionTitle"
      width="min(480px, calc(100vw - 32px))"
      destroy-on-close
      :before-close="guardActionClose"
      :close-on-click-modal="!operationLoading"
      :close-on-press-escape="!operationLoading"
      :show-close="!operationLoading"
    >
      <el-alert
        :title="activeAction?.confirmText || '请确认本次操作信息。'"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-form class="action-form" label-position="top">
        <el-form-item v-if="activeAction?.key === 'toggle-status'" label="状态变更">
          <strong data-testid="status-change">
            {{ productStatusLabel(actionExpectedIsActive) }} → {{ productStatusLabel(actionTargetIsActive) }}
          </strong>
        </el-form-item>
        <el-form-item v-if="activeAction?.key === 'change-price'" label="当前售价">
          <strong data-testid="current-price">{{ formatMoney(actionExpectedPriceCents) }}</strong>
        </el-form-item>
        <el-form-item v-if="activeAction?.key === 'change-price'" label="新售价（元）">
          <el-input-number
            v-model="actionForm.value"
            data-testid="price-input"
            :min="0"
            :precision="2"
            :step="0.01"
            :disabled="operationLoading"
            controls-position="right"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item v-if="activeAction && ['adjust', 'set-warning', 'batch-warning'].includes(activeAction.key)" label="调整值（整数）">
          <el-input-number v-model="actionForm.value" :min="activeAction?.key === 'set-warning' ? undefined : 0" :step="1" :disabled="operationLoading" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-form-item v-if="activeAction?.key === 'batch-tags'" label="公开标签">
          <el-select v-model="productTagForm.tag" data-testid="product-tag-select" :disabled="operationLoading" style="width: 100%">
            <el-option v-for="tag in PUBLIC_PRODUCT_TAGS" :key="tag" :label="tag" :value="tag" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="activeAction?.key === 'batch-tags'" label="标签操作">
          <el-radio-group v-model="productTagForm.present" data-testid="product-tag-present" :disabled="operationLoading">
            <el-radio-button :value="true">添加</el-radio-button>
            <el-radio-button :value="false">移除</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="activeAction?.key === 'batch-tags'" label="影响范围">
          <strong>{{ selection.length }} 个商品 · {{ productTagForm.present ? '添加' : '移除' }}“{{ productTagForm.tag }}”</strong>
        </el-form-item>
        <el-form-item label="操作说明">
          <el-input v-model="actionForm.note" type="textarea" :rows="3" maxlength="120" show-word-limit :disabled="operationLoading" placeholder="填写本次操作说明" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="operationLoading" @click="closeActionDialog">取消</el-button>
        <el-button data-testid="action-confirm" :type="activeAction?.type || 'primary'" :loading="operationLoading" @click="confirmAction">{{ actionConfirmText }}</el-button>
      </template>
    </el-dialog>

    <product-editor-dialog
      v-model="productEditorOpen"
      :mode="productEditorMode"
      :product-id="productEditorId"
      :transport="transport"
      @saved="handleProductSaved"
    />

    <inventory-adjust-dialog
      v-model="inventoryAdjustOpen"
      :product-id="inventoryAdjustTarget.id"
      :product-name="inventoryAdjustTarget.name"
      :sku="inventoryAdjustTarget.sku"
      :resource="inventoryAdjustTarget.resource"
      :transport="transport"
      @saved="handleInventoryAdjusted"
    />
  </div>
</template>

<style scoped>
.table-surface {
  min-height: 420px;
  overflow: hidden;
}

.search-input {
  width: min(360px, 34vw);
}

.status-filter {
  width: 164px;
}

.selection-count {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.row-actions {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  white-space: nowrap;
}

.pagination-bar {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  color: var(--color-text-secondary);
  border-top: 1px solid var(--color-border);
  font-size: 12px;
}

.state-panel {
  display: flex;
  min-height: 360px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 16px;
  padding: 40px;
}

.state-panel :deep(.el-alert) {
  max-width: 560px;
}

.detail-drawer {
  padding: 0 4px 24px;
}

.detail-drawer__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  padding: 14px 0 18px;
  border-bottom: 1px solid var(--color-border);
}

.detail-drawer__heading strong,
.detail-drawer__heading span {
  display: block;
}

.detail-drawer__heading strong {
  font-size: 18px;
}

.detail-drawer__heading span {
  margin-top: 5px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.detail-grid {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr);
  margin: 0;
  border-top: 1px solid var(--color-border);
  border-left: 1px solid var(--color-border);
}

.detail-grid dt,
.detail-grid dd {
  min-height: 44px;
  margin: 0;
  padding: 11px 13px;
  border-right: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  line-height: 20px;
}

.detail-grid dt {
  color: var(--color-text-secondary);
  background: #faf8f5;
}

.action-form {
  margin-top: 18px;
}

.density-compact :deep(.el-table__cell) {
  padding: 8px 0;
}

.density-comfortable :deep(.el-table__cell) {
  padding: 13px 0;
}
</style>
