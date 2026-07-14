<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElAlert, ElButton, ElEmpty, ElSkeleton, ElTag } from "element-plus";
import { ArrowLeft, RefreshCw } from "lucide-vue-next";
import PageHeader from "@/components/PageHeader.vue";
import { statusLabels } from "@/config/resources";
import { toApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import type { ApiError } from "@/services/http/api-error";
import type { ShipmentDetail } from "@/services/transport/shipment-query-contract";
import type { SyncEvent } from "@/types/realtime";
import { formatDateTime, formatMoney } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const detail = ref<ShipmentDetail | null>(null);
const loading = ref(false);
const error = ref<ApiError | null>(null);
let loadPromise: Promise<void> | null = null;

const shipment = computed(() => detail.value?.shipment || null);
const address = computed(() => shipment.value?.shippingAddress || shipment.value?.shippingAddressMasked || null);
const initialLoading = computed(() => loading.value && !detail.value);

function statusLabel(value: string): string {
  return value === "abnormal" ? "异常" : statusLabels[value] || value || "-";
}

function statusType(value: string): "success" | "warning" | "danger" | "info" {
  if (["completed", "paid", "shipped"].includes(value)) return "success";
  if (["cancelled", "rejected", "abnormal"].includes(value)) return "danger";
  if (["created", "pending_shipment", "partial_paid", "unpaid"].includes(value)) return "warning";
  return "info";
}

function load(): Promise<void> {
  if (loadPromise) return loadPromise;
  loading.value = true;
  error.value = null;
  loadPromise = transport.getShipmentDetail(String(route.params.id))
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
  if (!events?.some((item) => item.entityType === "shipment" && (!item.entityId || item.entityId === shipment.value?.id))) return;
  void load();
}

onMounted(() => {
  window.addEventListener("admin-web:sync-events", handleSync);
  void load();
});

onBeforeUnmount(() => window.removeEventListener("admin-web:sync-events", handleSync));
</script>

<template>
  <main class="page-shell shipment-detail-page">
    <page-header title="合并发货单详情" description="查看当前角色有权访问的合并发货、订单、商品和操作记录">
      <el-button :icon="ArrowLeft" @click="router.back()">返回合并发货单</el-button>
      <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
    </page-header>

    <section v-if="initialLoading" class="surface detail-state" aria-label="合并发货单详情加载中">
      <el-skeleton animated :rows="9" />
    </section>

    <section v-else-if="error && !detail" class="surface detail-state">
      <el-alert :title="error.message" :description="error.code" type="error" :closable="false" show-icon />
      <el-button @click="load">重新加载</el-button>
    </section>

    <section v-else-if="!detail || !shipment" class="surface detail-state">
      <el-empty description="合并发货单不存在或已不可见" />
    </section>

    <template v-else>
      <el-alert v-if="error" class="refresh-error" :title="error.message" :description="error.code" type="error" :closable="false" show-icon>
        <template #default><el-button text @click="load">重新加载</el-button></template>
      </el-alert>
      <el-alert
        v-if="detail.relatedDataStatus === 'partial'"
        title="部分关联订单缺失，数据可能不完整"
        type="warning"
        :closable="false"
        show-icon
      />

      <section class="surface overview" data-testid="shipment-summary">
        <div class="identity-row">
          <div><span>合并发货单号</span><h2>{{ shipment.shipmentNo || shipment.id }}</h2></div>
          <div class="identity-tags"><el-tag :type="statusType(shipment.status)">{{ statusLabel(shipment.status) }}</el-tag><el-tag effect="plain" type="info">版本 {{ shipment.version }}</el-tag></div>
        </div>
        <dl class="summary-grid">
          <div><dt>客户</dt><dd>{{ shipment.customerMasked || "-" }}</dd></div>
          <div><dt>订单 / 商品</dt><dd class="numeric">{{ shipment.orderCount }} 单 / {{ shipment.totalProductCount }} 种 / {{ shipment.totalItemCount }} 件</dd></div>
          <div><dt>承运商</dt><dd>{{ shipment.carrier || "-" }}</dd></div>
          <div><dt>运单号</dt><dd class="numeric">{{ shipment.trackingNo || shipment.trackingMasked || "-" }}</dd></div>
          <div><dt>地址一致</dt><dd>{{ shipment.addressConsistent ? "是" : "否" }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ formatDateTime(shipment.createdAt) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ formatDateTime(shipment.updatedAt) }}</dd></div>
          <div v-if="shipment.shippedAt"><dt>发货时间</dt><dd>{{ formatDateTime(shipment.shippedAt) }}</dd></div>
          <div v-if="shipment.completedAt"><dt>完成时间</dt><dd>{{ formatDateTime(shipment.completedAt) }}</dd></div>
          <div v-if="shipment.cancelledAt"><dt>取消时间</dt><dd>{{ formatDateTime(shipment.cancelledAt) }}</dd></div>
          <div v-if="shipment.totalOrderAmountCents !== undefined"><dt>订单总额</dt><dd class="money">{{ formatMoney(shipment.totalOrderAmountCents) }}</dd></div>
          <div v-if="shipment.totalPaidAmountCents !== undefined"><dt>已付金额</dt><dd class="money">{{ formatMoney(shipment.totalPaidAmountCents) }}</dd></div>
          <div v-if="shipment.totalUnpaidAmountCents !== undefined"><dt>未付金额</dt><dd class="money">{{ formatMoney(shipment.totalUnpaidAmountCents) }}</dd></div>
          <div v-if="shipment.adminRemark"><dt>内部备注</dt><dd>{{ shipment.adminRemark }}</dd></div>
          <div v-if="shipment.cancelReason"><dt>取消原因</dt><dd>{{ shipment.cancelReason }}</dd></div>
        </dl>
      </section>

      <section class="surface detail-section" data-testid="shipment-address">
        <div class="section-heading"><h2>收货地址</h2></div>
        <dl v-if="address" class="compact-list">
          <div><dt>收货人</dt><dd>{{ address.receiverName }}</dd></div>
          <div><dt>联系电话</dt><dd class="numeric">{{ address.receiverPhoneMasked }}</dd></div>
          <div><dt>所在地区</dt><dd>{{ address.regionText }}</dd></div>
          <div><dt>详细地址</dt><dd>{{ "detailAddress" in address ? address.detailAddress : address.detailAddressMasked }}</dd></div>
        </dl>
        <p v-else class="section-empty">暂无可见收货地址</p>
      </section>

      <section class="surface detail-section" data-testid="shipment-orders">
        <div class="section-heading"><h2>关联订单</h2><span>{{ detail.orders.length }} 条</span></div>
        <div v-if="detail.orders.length" class="table-wrap">
          <table>
            <thead><tr><th>订单号</th><th>订单状态</th><th>付款状态</th><th>发货状态</th><th>下单时间</th><th class="numeric">订单金额</th></tr></thead>
            <tbody><tr v-for="order in detail.orders" :key="order.id"><td>{{ order.orderNo }}</td><td>{{ statusLabel(order.status) }}</td><td>{{ statusLabel(order.paymentStatus) }}</td><td>{{ statusLabel(order.shippingStatus) }}</td><td>{{ formatDateTime(order.createdAt) }}</td><td class="numeric">{{ order.totalAmountCents === undefined ? "-" : formatMoney(order.totalAmountCents) }}</td></tr></tbody>
          </table>
        </div>
        <p v-else class="section-empty">暂无关联订单</p>
      </section>

      <section class="surface detail-section" data-testid="shipment-items">
        <div class="section-heading"><h2>商品汇总</h2><span>{{ detail.itemSummary.length }} 种</span></div>
        <div v-if="detail.itemSummary.length" class="table-wrap">
          <table>
            <thead><tr><th>商品</th><th>品牌 / 分类</th><th>规格 / 生产日期</th><th class="numeric">数量</th><th>关联订单</th></tr></thead>
            <tbody><tr v-for="item in detail.itemSummary" :key="`${item.productId}:${item.specification}:${item.productionDate}`"><td>{{ item.productName || "-" }}</td><td>{{ [item.brand, item.category].filter(Boolean).join(" / ") || "-" }}</td><td>{{ [item.specification, item.productionDate].filter(Boolean).join(" / ") || "-" }}</td><td class="numeric">{{ item.totalQuantity }}</td><td>{{ item.orderNos.join("、") || "-" }}</td></tr></tbody>
          </table>
        </div>
        <p v-else class="section-empty">暂无商品汇总</p>
      </section>

      <section class="surface detail-section" data-testid="shipment-logs">
        <div class="section-heading"><h2>操作记录</h2><span v-if="detail.logsHasMore">仅显示最近 100 条记录</span></div>
        <div v-if="detail.logs.length" class="log-list">
          <article v-for="log in detail.logs" :key="log.id"><div><strong>{{ log.action }}</strong><span>{{ log.operatorRole }}</span></div><time>{{ formatDateTime(log.createdAt) }}</time><p v-if="log.remark">{{ log.remark }}</p></article>
        </div>
        <p v-else class="section-empty">暂无可见操作记录</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.shipment-detail-page { width: 100%; min-width: 0; }
.detail-state { display: flex; min-height: 320px; flex-direction: column; justify-content: center; gap: 16px; padding: 24px; }
.detail-state :deep(.el-button) { align-self: center; }
.refresh-error { margin-bottom: 0; }
.overview, .detail-section { min-width: 0; padding: 16px; }
.identity-row, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.identity-row { padding-bottom: 14px; border-bottom: 1px solid var(--color-border); }
.identity-row > div:first-child { min-width: 0; }
.identity-row span, dt { color: var(--color-text-secondary); font-size: 12px; }
.identity-row h2 { margin-top: 3px; overflow-wrap: anywhere; font-size: 20px; line-height: 26px; }
.identity-tags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); margin: 0; }
.summary-grid > div { min-width: 0; padding: 14px 12px 2px 0; }
dd { margin: 5px 0 0; overflow-wrap: anywhere; line-height: 20px; }
.section-heading { min-height: 28px; margin-bottom: 10px; }
.section-heading h2 { font-size: 16px; line-height: 24px; }
.section-heading span { color: var(--color-text-secondary); font-size: 12px; }
.compact-list { margin: 0; }
.compact-list > div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px; padding: 9px 0; border-top: 1px solid var(--color-border); }
.table-wrap { width: 100%; max-width: 100%; overflow-x: auto; border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
table { width: 100%; min-width: 760px; border-collapse: collapse; table-layout: fixed; }
th, td { min-width: 0; height: 44px; padding: 9px 12px; border-bottom: 1px solid var(--color-border); overflow-wrap: anywhere; text-align: left; vertical-align: middle; }
th { color: var(--color-text-secondary); background: var(--color-card-warm); font-size: 12px; font-weight: 600; }
tr:last-child td { border-bottom: 0; }
.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.section-empty { padding: 16px 0; color: var(--color-text-secondary); line-height: 20px; }
.log-list article { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; padding: 12px 0; border-top: 1px solid var(--color-border); }
.log-list article div { display: flex; min-width: 0; gap: 10px; }
.log-list article span, .log-list time { color: var(--color-text-secondary); font-size: 12px; }
.log-list p { grid-column: 1 / -1; margin: 0; overflow-wrap: anywhere; color: var(--color-text-secondary); }
@media (max-width: 900px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 480px) {
  .overview, .detail-section, .detail-state { padding: 14px; }
  .identity-row { align-items: flex-start; flex-direction: column; }
  .identity-tags { justify-content: flex-start; }
  .summary-grid { grid-template-columns: minmax(0, 1fr); }
  .compact-list > div { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
</style>
