<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElAlert, ElButton, ElEmpty, ElRadioButton, ElRadioGroup, ElSkeleton, ElTable, ElTableColumn, ElTag } from "element-plus";
import { RefreshCw, TrendingDown, TrendingUp } from "lucide-vue-next";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import VChart from "vue-echarts";
import PageHeader from "@/components/PageHeader.vue";
import { ApiError, toApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import type { ProductAnalyticsData } from "@/types/api";
import type { SyncEvent } from "@/types/realtime";
import { formatDateTime, formatMoney } from "@/utils/format";

use([CanvasRenderer, LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent]);

const range = ref<"7d" | "30d" | "90d">("30d");
const data = ref<ProductAnalyticsData | null>(null);
const loading = ref(false);
const error = ref<ApiError | null>(null);
const analyticsSyncScopes = new Set(["product", "inventory", "order"]);
const ANALYTICS_FALLBACK_REFRESH_MS = 60_000;
let requestRevision = 0;
let syncRefreshTimer: number | null = null;
let fallbackRefreshTimer: number | null = null;

const chartOption = computed(() => ({
  animationDuration: 280,
  color: ["#496F82", "#9A2D2D", "#B7793A", "#5E7C58"],
  tooltip: { trigger: "axis", backgroundColor: "#1F1A15", borderWidth: 0, textStyle: { color: "#FFF" } },
  legend: { top: 0, right: 0, itemWidth: 14, itemHeight: 8, textStyle: { color: "#6F675F" } },
  grid: { left: 48, right: 54, top: 48, bottom: 36 },
  xAxis: {
    type: "category",
    boundaryGap: false,
    data: data.value?.series.map((item) => item.date) || [],
    axisLine: { lineStyle: { color: "#D8CEC2" } },
    axisLabel: { color: "#776F66" }
  },
  yAxis: [
    { type: "value", name: "数量", splitLine: { lineStyle: { color: "#EEE8E0" } }, axisLabel: { color: "#776F66" } },
    { type: "value", name: "价格(元)", splitLine: { show: false }, axisLabel: { color: "#776F66" } }
  ],
  series: [
    { name: "销量", type: "line", smooth: true, symbolSize: 6, areaStyle: { opacity: 0.08 }, data: data.value?.series.map((item) => item.salesCount) || [] },
    { name: "成交均价", type: "line", smooth: true, yAxisIndex: 1, data: data.value?.series.map((item) => item.averagePriceCents === null ? null : item.averagePriceCents / 100) || [] },
    { name: "报价", type: "line", smooth: true, yAxisIndex: 1, lineStyle: { type: "dashed" }, data: data.value?.series.map((item) => item.quotePriceCents === null ? null : item.quotePriceCents / 100) || [] },
    { name: "库存变化", type: "bar", barMaxWidth: 18, data: data.value?.series.map((item) => item.inventoryChange) || [] }
  ]
}));

async function load(): Promise<void> {
  const requestedRange = range.value;
  const revision = ++requestRevision;
  loading.value = true;
  error.value = null;
  try {
    const response = await transport.getProductAnalytics(requestedRange);
    if (revision !== requestRevision) return;
    if (response.range !== requestedRange) {
      throw new ApiError("商品分析响应范围不匹配", "PRODUCT_ANALYTICS_RANGE_MISMATCH", 502);
    }
    data.value = response;
  } catch (reason) {
    if (revision !== requestRevision) return;
    error.value = toApiError(reason);
  } finally {
    if (revision === requestRevision) loading.value = false;
  }
}

function summaryText(item: ProductAnalyticsData["summary"][number]): string {
  if (item.value === null) return "-";
  return item.kind === "money" ? formatMoney(item.value) : item.value.toLocaleString("zh-CN");
}

function rangeText(value: ProductAnalyticsData["range"]): string {
  return value === "7d" ? "近 7 天" : value === "30d" ? "近 30 天" : "近 90 天";
}

function handleSync(event: Event): void {
  const events = (event as CustomEvent<{ events?: SyncEvent[] }>).detail?.events;
  if (!Array.isArray(events) || !events.some((item) => analyticsSyncScopes.has(item?.entityType))) return;
  if (syncRefreshTimer !== null) window.clearTimeout(syncRefreshTimer);
  syncRefreshTimer = window.setTimeout(() => {
    syncRefreshTimer = null;
    void load();
  }, 250);
}

onMounted(() => {
  window.addEventListener("admin-web:sync-events", handleSync);
  fallbackRefreshTimer = window.setInterval(() => {
    if (!document.hidden && !loading.value) void load();
  }, ANALYTICS_FALLBACK_REFRESH_MS);
  void load();
});

onBeforeUnmount(() => {
  requestRevision += 1;
  window.removeEventListener("admin-web:sync-events", handleSync);
  if (syncRefreshTimer !== null) window.clearTimeout(syncRefreshTimer);
  if (fallbackRefreshTimer !== null) window.clearInterval(fallbackRefreshTimer);
  syncRefreshTimer = null;
  fallbackRefreshTimer = null;
});
</script>

<template>
  <div class="page-shell analytics-page">
    <page-header title="商品分析" description="查看销量、成交均价、报价与库存变化">
      <span v-if="data" class="updated-at">更新于 {{ formatDateTime(data.updatedAt) }}</span>
      <el-radio-group v-model="range" @change="load">
        <el-radio-button value="7d">近 7 天</el-radio-button>
        <el-radio-button value="30d">近 30 天</el-radio-button>
        <el-radio-button value="90d">近 90 天</el-radio-button>
      </el-radio-group>
      <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
    </page-header>

    <div v-if="error && !data" class="analytics-state surface">
      <el-alert :title="error.message" :description="`错误码：${error.code}`" type="error" :closable="false" show-icon />
      <el-button @click="load">重新加载</el-button>
    </div>

    <template v-else-if="loading && !data">
      <section class="summary-grid"><div v-for="index in 4" :key="index" class="summary-card surface"><el-skeleton animated :rows="2" /></div></section>
      <section class="chart-panel surface"><el-skeleton animated :rows="10" /></section>
    </template>

    <template v-else-if="data">
      <div v-if="error" class="analytics-refresh-error">
        <el-alert :title="error.message" :description="`错误码：${error.code}；当前仍显示上次成功数据`" type="error" :closable="false" show-icon />
        <el-button :icon="RefreshCw" :loading="loading" @click="load">重试刷新</el-button>
      </div>

      <div v-if="data.status === 'unavailable'" class="analytics-state surface">
        <el-empty :description="data.message || '分析服务暂不可用'" />
        <el-button :icon="RefreshCw" :loading="loading" @click="load">重新加载</el-button>
      </div>

      <div v-else-if="data.status === 'empty'" class="analytics-state surface" data-testid="analytics-empty">
        <el-empty :description="data.message || '当前范围暂无分析数据'" />
        <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
      </div>

      <template v-else>
        <el-alert v-if="data.message" class="analytics-notice" :title="data.message" type="info" :closable="false" show-icon />

        <section class="summary-grid" aria-label="分析摘要">
          <div v-for="item in data.summary" :key="item.key" class="summary-card surface" :data-testid="`summary-${item.key}`">
            <span>{{ item.label }}</span>
            <strong :class="{ money: item.kind === 'money' }" :data-testid="`summary-value-${item.key}`">{{ summaryText(item) }}</strong>
            <small v-if="item.change !== null" :class="item.change >= 0 ? 'change-up' : 'change-down'">
              <component :is="item.change >= 0 ? TrendingUp : TrendingDown" :size="14" />
              {{ Math.abs(item.change) }}%
            </small>
            <small v-else class="change-neutral">-</small>
          </div>
        </section>

        <section class="chart-panel surface">
          <header class="section-heading">
            <div><h2>趋势对比</h2><p>销量、价格与库存变化</p></div>
            <el-tag type="info" effect="plain" data-testid="analytics-range-label">{{ rangeText(data.range) }}</el-tag>
          </header>
          <v-chart v-if="data.series.length" class="analytics-chart" :option="chartOption" autoresize />
          <el-empty v-else description="暂无趋势数据" />
        </section>

        <section class="ranking-panel surface">
          <header class="section-heading">
            <div><h2>商品表现</h2><p>按销量排序</p></div>
          </header>
          <el-table :data="data.ranking" height="310">
            <el-table-column type="index" label="#" width="58" />
            <el-table-column label="SKU" width="130"><template #default="{ row }"><span :data-testid="`ranking-sku-${row.id}`">{{ row.sku || '-' }}</span></template></el-table-column>
            <el-table-column prop="name" label="商品" min-width="220" />
            <el-table-column prop="salesCount" label="销量" width="110" align="right" />
            <el-table-column label="成交均价" width="140" align="right"><template #default="{ row }"><span class="money" :data-testid="`ranking-average-${row.id}`">{{ row.averagePriceCents === null ? '-' : formatMoney(row.averagePriceCents) }}</span></template></el-table-column>
            <el-table-column label="当前售价" width="140" align="right"><template #default="{ row }"><span class="money" :data-testid="`ranking-current-${row.id}`">{{ row.currentPriceCents === null ? '-' : formatMoney(row.currentPriceCents) }}</span></template></el-table-column>
            <el-table-column label="环比" width="110" align="right">
              <template #default="{ row }">
                <span v-if="row.change === null" class="change-neutral" :data-testid="`ranking-change-${row.id}`">-</span>
                <span v-else :class="row.change >= 0 ? 'change-up' : 'change-down'" :data-testid="`ranking-change-${row.id}`">{{ row.change >= 0 ? '+' : '' }}{{ row.change }}%</span>
              </template>
            </el-table-column>
            <template #empty><el-empty description="暂无分析数据" /></template>
          </el-table>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.updated-at {
  align-self: center;
  color: var(--color-text-muted);
  font-size: 12px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.summary-card {
  position: relative;
  min-height: 112px;
  padding: 17px;
  border-left: 3px solid #58798a;
}

.summary-card > span {
  display: block;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.summary-card > strong {
  display: block;
  margin-top: 10px;
  font-size: 23px;
  font-variant-numeric: tabular-nums;
}

.summary-card small {
  position: absolute;
  right: 15px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 3px;
}

.change-up { color: var(--color-success); }
.change-down { color: var(--color-danger); }
.change-neutral { color: var(--color-text-muted); }

.analytics-notice {
  margin-bottom: 14px;
}

.analytics-refresh-error {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.analytics-refresh-error .el-alert {
  flex: 1;
}

.chart-panel,
.ranking-panel {
  padding: 18px;
}

.section-heading {
  display: flex;
  min-height: 46px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.section-heading h2 {
  font-size: 16px;
}

.section-heading p {
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.analytics-chart {
  width: 100%;
  height: 360px;
}

.analytics-state {
  display: flex;
  min-height: 460px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px;
}

@media (max-width: 1180px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 640px) {
  .summary-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .analytics-page :deep(.el-radio-group) {
    display: grid;
    min-width: 220px;
    flex: 1;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .analytics-page :deep(.el-radio-button__inner) {
    width: 100%;
    padding-inline: 8px;
  }

  .chart-panel,
  .ranking-panel {
    min-width: 0;
    padding: 12px;
  }

  .analytics-chart {
    height: 300px;
  }

  .analytics-refresh-error {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
