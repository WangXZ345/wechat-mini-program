<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElAlert, ElButton, ElEmpty, ElProgress, ElSkeleton, ElSkeletonItem, ElTag } from "element-plus";
import { ArrowRight, RefreshCw, TrendingDown, TrendingUp } from "lucide-vue-next";
import PageHeader from "@/components/PageHeader.vue";
import { hasAccess } from "@/config/access";
import { navigationEntries } from "@/config/navigation";
import { toApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import { useAuthStore } from "@/stores/auth";
import type { ApiError } from "@/services/http/api-error";
import type { DashboardData, DashboardMetric } from "@/types/api";
import type { SyncEvent } from "@/types/realtime";
import { formatDateTime, formatMoney } from "@/utils/format";

const auth = useAuthStore();
const router = useRouter();
const data = ref<DashboardData | null>(null);
const loading = ref(false);
const error = ref<ApiError | null>(null);

const roleGreeting = computed(() => {
  const labels = {
    procurement: "商品与库存概览",
    finance: "付款与账款概览",
    customer_service: "订单履约概览",
    super_admin: "全局运营概览"
  };
  return auth.profile ? labels[auth.profile.role] : "运营概览";
});

const visibleQuickLinks = computed(() => navigationEntries
  .filter((entry) => entry.path !== "/dashboard" && hasAccess(auth.profile, entry.access))
  .slice(0, 6));

const maxTrend = computed(() => Math.max(...(data.value?.trend.map((item) => item.value) || [1]), 1));

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    data.value = await transport.getDashboard();
  } catch (reason) {
    error.value = toApiError(reason);
  } finally {
    loading.value = false;
  }
}

function metricText(metric: DashboardMetric): string {
  return metric.kind === "money" ? formatMoney(metric.value) : `${metric.value.toLocaleString("zh-CN")}${metric.unit || ""}`;
}

function handleSync(event: Event): void {
  const detail = (event as CustomEvent<{ events: SyncEvent[] }>).detail;
  if (detail?.events.length) void load();
}

onMounted(() => {
  window.addEventListener("admin-web:sync-events", handleSync);
  void load();
});

onBeforeUnmount(() => window.removeEventListener("admin-web:sync-events", handleSync));
</script>

<template>
  <div class="page-shell dashboard">
    <page-header :title="roleGreeting" :description="`${auth.profile?.roleName || ''}职责范围内的实时待办与业务摘要`">
      <span v-if="data" class="updated-at">更新于 {{ formatDateTime(data.updatedAt) }}</span>
      <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
    </page-header>

    <div v-if="error" class="dashboard-state surface">
      <el-alert :title="error.message" :description="`错误码：${error.code}`" type="error" :closable="false" show-icon />
      <el-button :icon="RefreshCw" @click="load">重新加载</el-button>
    </div>

    <template v-else-if="loading && !data">
      <div class="metric-grid">
        <div v-for="index in 4" :key="index" class="metric-card surface"><el-skeleton animated><template #template><el-skeleton-item variant="text" style="width: 48%" /><el-skeleton-item variant="h1" style="width: 70%; margin-top: 18px" /></template></el-skeleton></div>
      </div>
      <div class="dashboard-grid"><section class="surface skeleton-panel"><el-skeleton animated :rows="7" /></section><section class="surface skeleton-panel"><el-skeleton animated :rows="7" /></section></div>
    </template>

    <template v-else-if="data">
      <section class="metric-grid" aria-label="关键指标">
        <button
          v-for="metric in data.metrics"
          :key="metric.key"
          type="button"
          class="metric-card surface"
          :class="`tone-${metric.tone}`"
          @click="router.push(metric.route)"
        >
          <span class="metric-card__label">{{ metric.label }}</span>
          <strong :class="{ money: metric.kind === 'money' }">{{ metricText(metric) }}</strong>
          <span class="metric-card__link">查看详情 <arrow-right :size="14" /></span>
        </button>
      </section>

      <div class="dashboard-grid">
        <section class="surface panel">
          <header class="panel__header">
            <div><h2>近 7 日工作量</h2><p>按当前角色职责汇总</p></div>
            <el-tag effect="plain" type="info">7 天</el-tag>
          </header>
          <div v-if="data.trend.length" class="trend-chart" aria-label="近 7 日趋势图">
            <div v-for="point in data.trend" :key="point.label" class="trend-chart__item">
              <span class="trend-chart__value">{{ point.value }}</span>
              <div class="trend-chart__bar-wrap"><span class="trend-chart__bar" :style="{ height: `${Math.max(12, point.value / maxTrend * 100)}%` }" /></div>
              <span class="trend-chart__label">{{ point.label }}</span>
            </div>
          </div>
          <el-empty v-else description="暂无趋势数据" :image-size="68" />
        </section>

        <section class="surface panel">
          <header class="panel__header">
            <div><h2>待办队列</h2><p>按优先级处理当前职责事项</p></div>
          </header>
          <div v-if="data.tasks.length" class="task-list">
            <button v-for="task in data.tasks" :key="task.id" type="button" class="task-row" @click="router.push(task.route)">
              <span class="task-row__count" :class="`tone-${task.tone}`">{{ task.count }}</span>
              <span class="task-row__text"><strong>{{ task.title }}</strong><small>{{ task.detail }}</small></span>
              <arrow-right :size="16" />
            </button>
          </div>
          <el-empty v-else description="当前没有待办" :image-size="68" />
        </section>
      </div>

      <div class="dashboard-grid lower-grid">
        <section class="surface panel">
          <header class="panel__header">
            <div><h2>商品动向</h2><p>按销量查看近期重点商品</p></div>
          </header>
          <div v-if="data.topProducts.length" class="product-rank">
            <div v-for="(product, index) in data.topProducts" :key="product.sku" class="product-rank__row">
              <span class="rank">{{ index + 1 }}</span>
              <span class="product-rank__name"><strong>{{ product.name }}</strong><small>{{ product.sku }}</small></span>
              <el-progress :percentage="Math.round(product.value / Math.max(data.topProducts[0]?.value || 1, 1) * 100)" :stroke-width="7" :show-text="false" />
              <span class="product-rank__value">{{ product.value }}</span>
              <span :class="product.change >= 0 ? 'change-up' : 'change-down'">
                <component :is="product.change >= 0 ? TrendingUp : TrendingDown" :size="14" />{{ Math.abs(product.change) }}%
              </span>
            </div>
          </div>
          <el-empty v-else description="暂无商品动向" :image-size="68" />
        </section>

        <section class="surface panel">
          <header class="panel__header">
            <div><h2>快捷入口</h2><p>仅显示当前角色可访问页面</p></div>
          </header>
          <div class="quick-links">
            <router-link v-for="item in visibleQuickLinks" :key="item.key" :to="item.path" class="quick-link">
              <span>{{ item.title }}</span><arrow-right :size="15" />
            </router-link>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.updated-at {
  align-self: center;
  color: var(--color-text-muted);
  font-size: 12px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.metric-card {
  position: relative;
  min-height: 124px;
  padding: 18px;
  overflow: hidden;
  border-top: 3px solid var(--color-primary);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: transform var(--transition-fast), box-shadow var(--transition-fast);
}

.metric-card:hover {
  box-shadow: 0 8px 24px rgba(42, 35, 28, 0.11);
  transform: translateY(-1px);
}

.metric-card.tone-success { border-top-color: var(--color-success); }
.metric-card.tone-warning { border-top-color: var(--color-warning); }
.metric-card.tone-danger { border-top-color: var(--color-danger); }
.metric-card.tone-info { border-top-color: var(--color-info); }

.metric-card__label {
  display: block;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.metric-card > strong {
  display: block;
  margin-top: 9px;
  font-size: 25px;
  font-variant-numeric: tabular-nums;
}

.metric-card__link {
  position: absolute;
  right: 15px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-muted);
  font-size: 11px;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(340px, 0.85fr);
  gap: 14px;
}

.panel {
  min-height: 316px;
  padding: 18px;
}

.panel__header {
  display: flex;
  min-height: 44px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.panel__header h2 {
  font-size: 16px;
}

.panel__header p {
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.trend-chart {
  display: grid;
  height: 218px;
  grid-template-columns: repeat(7, 1fr);
  align-items: end;
  gap: 12px;
  padding-top: 18px;
  border-bottom: 1px solid var(--color-border);
}

.trend-chart__item {
  display: grid;
  height: 100%;
  grid-template-rows: 20px 1fr 28px;
  align-items: end;
  text-align: center;
}

.trend-chart__value,
.trend-chart__label {
  color: var(--color-text-muted);
  font-size: 11px;
}

.trend-chart__bar-wrap {
  display: flex;
  height: 100%;
  align-items: flex-end;
  justify-content: center;
}

.trend-chart__bar {
  display: block;
  width: min(34px, 64%);
  border-radius: 4px 4px 0 0;
  background: #6f8997;
}

.task-list {
  margin-top: 8px;
}

.task-row {
  display: grid;
  width: 100%;
  min-height: 66px;
  grid-template-columns: 38px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 11px;
  padding: 9px 4px;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.task-row:last-child { border-bottom: 0; }
.task-row:hover { background: #fcfaf7; }

.task-row__count {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 6px;
  color: #4d6070;
  background: #edf3f6;
  font-weight: 700;
}

.task-row__count.tone-warning { color: #7b4b1d; background: #fff1d8; }
.task-row__count.tone-danger { color: #8c3432; background: #f8e6e4; }
.task-row__count.tone-info { color: #3f6578; background: #eaf2f6; }

.task-row__text strong,
.task-row__text small {
  display: block;
}

.task-row__text small {
  margin-top: 4px;
  color: var(--color-text-muted);
}

.lower-grid {
  grid-template-columns: minmax(0, 1.4fr) minmax(300px, 0.8fr);
}

.product-rank__row {
  display: grid;
  min-height: 51px;
  grid-template-columns: 28px minmax(150px, 1fr) minmax(100px, 0.8fr) 44px 58px;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--color-border);
}

.product-rank__row:last-child { border-bottom: 0; }

.rank {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.product-rank__name strong,
.product-rank__name small {
  display: block;
}

.product-rank__name small {
  margin-top: 2px;
  color: var(--color-text-muted);
  font-size: 10px;
}

.product-rank__value {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.change-up,
.change-down {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  font-size: 11px;
}

.change-up { color: var(--color-success); }
.change-down { color: var(--color-danger); }

.quick-links {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.quick-link {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: #fcfbf9;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.quick-link:hover {
  border-color: var(--color-primary);
  background: var(--color-card-warm);
}

.dashboard-state {
  display: flex;
  min-height: 420px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px;
}

.skeleton-panel {
  min-height: 316px;
  padding: 20px;
}

@media (max-width: 1180px) {
  .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dashboard-grid,
  .lower-grid { grid-template-columns: 1fr; }
}
</style>
