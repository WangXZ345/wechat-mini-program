<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElAlert, ElButton, ElEmpty, ElSkeleton, ElTag } from "element-plus";
import { ArrowLeft, RefreshCw } from "lucide-vue-next";
import PageHeader from "@/components/PageHeader.vue";
import { statusLabels } from "@/config/resources";
import { toApiError } from "@/services/http/api-error";
import type { ApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import type { AccountDetail } from "@/services/transport/account-query-contract";
import type { SyncEvent } from "@/types/realtime";
import { formatDateTime, formatMoney } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const detail = ref<AccountDetail | null>(null);
const loading = ref(false);
const error = ref<ApiError | null>(null);
let loadPromise: Promise<void> | null = null;

const account = computed(() => detail.value?.account || null);
const initialLoading = computed(() => loading.value && !detail.value);

function accountStatusLabel(value: string): string {
  return {
    unpaid: "未结清",
    pending_confirm: "待确认",
    abnormal: "异常",
    settled: "已结清"
  }[value] || value || "-";
}

function statusLabel(value: string): string {
  return statusLabels[value] || value || "-";
}

function statusType(value: string): "success" | "warning" | "danger" | "info" {
  if (["settled", "paid", "completed"].includes(value)) return "success";
  if (["abnormal", "rejected", "cancelled"].includes(value)) return "danger";
  if (["unpaid", "pending_confirm", "pending_payment_confirm", "partial_paid"].includes(value)) return "warning";
  return "info";
}

function load(): Promise<void> {
  if (loadPromise) return loadPromise;
  loading.value = true;
  error.value = null;
  loadPromise = transport.getAccountDetail(String(route.params.id))
    .then((value) => {
      detail.value = value || null;
    })
    .catch((reason: unknown) => {
      error.value = toApiError(reason);
      if (!detail.value) detail.value = null;
    })
    .finally(() => {
      loading.value = false;
      loadPromise = null;
    });
  return loadPromise;
}

function handleSync(event: Event): void {
  const events = (event as CustomEvent<{ events?: SyncEvent[] }>).detail?.events;
  if (!events?.some((item) => item.entityType === "account" && (!item.entityId || item.entityId === account.value?.id))) return;
  void load();
}

onMounted(() => {
  window.addEventListener("admin-web:sync-events", handleSync);
  void load();
});

onBeforeUnmount(() => window.removeEventListener("admin-web:sync-events", handleSync));
</script>

<template>
  <main class="page-shell account-detail-page">
    <page-header title="客户账款详情" description="查看当前角色有权访问的账款摘要、关联订单与账款流水">
      <el-button :icon="ArrowLeft" @click="router.back()">返回客户账款</el-button>
      <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
    </page-header>

    <section v-if="initialLoading" class="surface detail-state" aria-label="客户账款详情加载中">
      <el-skeleton animated :rows="9" />
    </section>

    <section v-else-if="error && !detail" class="surface detail-state">
      <el-alert :title="error.message" :description="error.code" type="error" :closable="false" show-icon />
      <el-button @click="load">重新加载</el-button>
    </section>

    <section v-else-if="!detail || !account" class="surface detail-state">
      <el-empty description="客户账款不存在或已不可见" />
    </section>

    <template v-else>
      <el-alert v-if="error" class="refresh-error" :title="error.message" :description="error.code" type="error" :closable="false" show-icon>
        <template #default><el-button text @click="load">重新加载</el-button></template>
      </el-alert>
      <el-alert
        v-if="detail.relatedDataStatus === 'partial'"
        title="部分关联账款数据暂时不可用"
        type="warning"
        :closable="false"
        show-icon
      />

      <section class="surface overview" data-testid="account-summary">
        <div class="identity-row">
          <div><span>客户</span><h2>{{ account.customerMasked || account.id }}</h2></div>
          <el-tag :type="statusType(account.status)">{{ accountStatusLabel(account.status) }}</el-tag>
        </div>
        <dl class="summary-grid">
          <div><dt>订单数</dt><dd class="numeric">{{ account.totalOrders }}</dd></div>
          <div><dt>应收</dt><dd class="money">{{ formatMoney(account.receivableCents) }}</dd></div>
          <div><dt>已收</dt><dd class="money">{{ formatMoney(account.receivedCents) }}</dd></div>
          <div><dt>未收</dt><dd class="money">{{ formatMoney(account.unpaidAmountCents) }}</dd></div>
          <div><dt>待确认</dt><dd class="money">{{ formatMoney(account.pendingConfirmAmountCents) }}</dd></div>
          <div><dt>异常数</dt><dd class="numeric">{{ account.abnormalCount }}</dd></div>
          <div><dt>最近订单</dt><dd>{{ formatDateTime(account.lastOrderAt) }}</dd></div>
          <div><dt>最近付款</dt><dd>{{ formatDateTime(account.lastPaymentAt) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ formatDateTime(account.updatedAt) }}</dd></div>
        </dl>
      </section>

      <section class="surface detail-section" data-testid="account-orders">
        <div class="section-heading">
          <h2>关联订单</h2>
          <span v-if="detail.ordersHasMore">仅显示最近 50 条订单</span>
          <span v-else>{{ detail.orders.length }} 条</span>
        </div>
        <div v-if="detail.orders.length" class="table-wrap">
          <table>
            <thead><tr><th>订单号</th><th>订单状态</th><th>付款状态</th><th class="numeric">订单金额</th><th>下单时间</th></tr></thead>
            <tbody><tr v-for="order in detail.orders" :key="order.id"><td>{{ order.orderNo || "-" }}</td><td>{{ statusLabel(order.status) }}</td><td>{{ statusLabel(order.paymentStatus) }}</td><td class="numeric">{{ formatMoney(order.totalAmountCents) }}</td><td>{{ formatDateTime(order.createdAt) }}</td></tr></tbody>
          </table>
        </div>
        <p v-else class="section-empty">暂无关联订单</p>
      </section>

      <section class="surface detail-section" data-testid="account-logs">
        <div class="section-heading">
          <h2>账款流水</h2>
          <span v-if="detail.logsHasMore">仅显示最近 100 条流水</span>
          <span v-else>{{ detail.logs.length }} 条</span>
        </div>
        <div v-if="detail.logs.length" class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>类型 / 订单</th><th class="numeric">应收变化</th><th class="numeric">已收变化</th><th class="numeric">未收变化</th><th class="numeric">本次变动</th><th>时间 / 摘要</th></tr></thead>
            <tbody>
              <tr v-for="log in detail.logs" :key="log.id">
                <td><strong>{{ log.changeType || "-" }}</strong><small>{{ log.orderNo || "-" }}</small></td>
                <td class="numeric">{{ formatMoney(log.beforeReceivableCents) }} → {{ formatMoney(log.afterReceivableCents) }}</td>
                <td class="numeric">{{ formatMoney(log.beforeReceivedCents) }} → {{ formatMoney(log.afterReceivedCents) }}</td>
                <td class="numeric">{{ formatMoney(log.beforeUnpaidCents) }} → {{ formatMoney(log.afterUnpaidCents) }}</td>
                <td class="numeric">{{ formatMoney(log.changeAmountCents) }}</td>
                <td><span>{{ formatDateTime(log.createdAt) }}</span><small>{{ log.summary || "-" }}</small></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="section-empty">暂无可见账款流水</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.account-detail-page { width: 100%; min-width: 0; }
.detail-state { display: flex; min-height: 320px; flex-direction: column; justify-content: center; gap: 16px; padding: 24px; }
.detail-state :deep(.el-button) { align-self: center; }
.refresh-error { margin-bottom: 0; }
.overview, .detail-section { min-width: 0; padding: 16px; }
.identity-row, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.identity-row { padding-bottom: 14px; border-bottom: 1px solid var(--color-border); }
.identity-row > div { min-width: 0; }
.identity-row span, dt { color: var(--color-text-secondary); font-size: 12px; }
.identity-row h2 { margin-top: 3px; overflow-wrap: anywhere; font-size: 20px; line-height: 26px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); margin: 0; }
.summary-grid > div { min-width: 0; padding: 14px 12px 2px 0; }
dd { margin: 5px 0 0; overflow-wrap: anywhere; line-height: 20px; }
.section-heading { min-height: 28px; margin-bottom: 10px; }
.section-heading h2 { font-size: 16px; line-height: 24px; }
.section-heading span { color: var(--color-text-secondary); font-size: 12px; }
.table-wrap { width: 100%; max-width: 100%; overflow-x: auto; border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
table { width: 100%; min-width: 760px; border-collapse: collapse; table-layout: fixed; }
.ledger-table { min-width: 1040px; }
th, td { min-width: 0; height: 44px; padding: 9px 12px; border-bottom: 1px solid var(--color-border); overflow-wrap: anywhere; text-align: left; vertical-align: middle; }
th { color: var(--color-text-secondary); background: var(--color-card-warm); font-size: 12px; font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td strong, td small { display: block; }
td small { margin-top: 3px; color: var(--color-text-secondary); font-size: 12px; font-weight: 400; }
.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.section-empty { padding: 16px 0; color: var(--color-text-secondary); line-height: 20px; }
@media (max-width: 900px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 480px) {
  .overview, .detail-section, .detail-state { padding: 14px; }
  .identity-row { align-items: flex-start; flex-direction: column; }
  .summary-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
