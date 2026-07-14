<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElAlert, ElButton, ElEmpty, ElSkeleton, ElTag } from "element-plus";
import { ArrowLeft, RefreshCw } from "lucide-vue-next";
import PageHeader from "@/components/PageHeader.vue";
import { resourceDefinitions, statusLabels } from "@/config/resources";
import { toApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import type { ApiError } from "@/services/http/api-error";
import type { ResourceDefinition } from "@/types/resource";
import { formatDateTime, formatMoney } from "@/utils/format";

const props = defineProps<{ resource: string }>();
const route = useRoute();
const router = useRouter();
const definition = computed(() => resourceDefinitions[props.resource] as ResourceDefinition);
const item = ref<Record<string, unknown> | null>(null);
const loading = ref(false);
const error = ref<ApiError | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    item.value = await transport.get(props.resource, String(route.params.id));
  } catch (reason) {
    error.value = toApiError(reason);
  } finally {
    loading.value = false;
  }
}

function display(key: string, kind?: string): string {
  const value = item.value?.[key];
  if (kind === "money") return formatMoney(value);
  if (kind === "date") return formatDateTime(value);
  if (kind === "status") return statusLabels[String(value)] || String(value || "-");
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

onMounted(() => void load());
</script>

<template>
  <div class="page-shell">
    <page-header :title="definition.title + '详情'" description="查看服务端安全投影与当前版本">
      <el-button :icon="ArrowLeft" @click="router.back()">返回</el-button>
      <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
    </page-header>

    <section class="surface detail-page">
      <el-skeleton v-if="loading" animated :rows="7" />
      <div v-else-if="error" class="detail-state">
        <el-alert :title="error.message" :description="error.code" type="error" :closable="false" show-icon />
        <el-button @click="load">重新加载</el-button>
      </div>
      <el-empty v-else-if="!item" description="记录不存在" />
      <template v-else>
        <div class="detail-page__title">
          <div>
            <span>记录标识</span>
            <strong>{{ item.name || item.orderNo || item.id }}</strong>
          </div>
          <el-tag effect="plain">版本 {{ item.version || 1 }}</el-tag>
        </div>
        <dl class="detail-list">
          <template v-for="column in definition.columns" :key="column.key">
            <dt>{{ column.label }}</dt>
            <dd :class="{ money: column.kind === 'money' }">{{ display(column.key, column.kind) }}</dd>
          </template>
        </dl>
        <div class="timeline">
          <h2>最近活动</h2>
          <div class="timeline__item">
            <span />
            <div><strong>当前安全投影已载入</strong><p>本页不会展示当前角色无权访问的字段。</p></div>
          </div>
          <div class="timeline__item muted">
            <span />
            <div><strong>同步事件仅触发重新查询</strong><p>事件本身不携带完整业务数据，也不会触发写操作。</p></div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.detail-page {
  max-width: 1100px;
  padding: 24px;
}

.detail-state {
  display: flex;
  min-height: 360px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.detail-page__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 22px;
}

.detail-page__title span,
.detail-page__title strong {
  display: block;
}

.detail-page__title span {
  color: var(--color-text-muted);
  font-size: 12px;
}

.detail-page__title strong {
  margin-top: 4px;
  font-size: 20px;
}

.detail-list {
  display: grid;
  grid-template-columns: repeat(2, 150px minmax(180px, 1fr));
  margin: 0;
  border-top: 1px solid var(--color-border);
  border-left: 1px solid var(--color-border);
}

.detail-list dt,
.detail-list dd {
  min-height: 46px;
  margin: 0;
  padding: 12px 14px;
  border-right: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
}

.detail-list dt {
  color: var(--color-text-secondary);
  background: #faf8f5;
}

.timeline {
  margin-top: 28px;
  padding-top: 22px;
  border-top: 1px solid var(--color-border);
}

.timeline h2 {
  margin-bottom: 16px;
  font-size: 16px;
}

.timeline__item {
  display: grid;
  grid-template-columns: 12px 1fr;
  gap: 11px;
  padding: 8px 0;
}

.timeline__item > span {
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--color-success);
}

.timeline__item p {
  margin-top: 3px;
  color: var(--color-text-secondary);
  line-height: 20px;
}

.timeline__item.muted > span {
  background: var(--color-text-muted);
}
</style>
