<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElTooltip } from "element-plus";
import { CheckCircle2, CloudOff, LoaderCircle, RefreshCw, Sparkles } from "lucide-vue-next";
import { useRealtimeStore } from "@/stores/realtime";

const realtime = useRealtimeStore();
const icon = computed(() => {
  if (realtime.dataUpdated) return Sparkles;
  if (realtime.status === "synced") return CheckCircle2;
  if (realtime.status === "offline") return CloudOff;
  if (realtime.status === "reconnecting") return RefreshCw;
  return LoaderCircle;
});
const detail = computed(() => {
  if (!realtime.lastSyncedAt) return "尚未完成同步";
  return `最近同步 ${new Date(realtime.lastSyncedAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
});
</script>

<template>
  <el-tooltip :content="`${realtime.label} · ${detail}`" placement="bottom">
    <el-button class="sync-status" text :class="`is-${realtime.status}`" @click="realtime.syncNow">
      <component :is="icon" :size="16" :class="{ spinning: ['connecting', 'catching_up', 'reconnecting'].includes(realtime.status) }" />
      <span>{{ realtime.label }}</span>
    </el-button>
  </el-tooltip>
</template>

<style scoped>
.sync-status {
  min-width: 102px;
  color: var(--color-text-secondary);
}

.sync-status.is-synced {
  color: var(--color-success);
}

.sync-status.is-offline,
.sync-status.is-reconnecting {
  color: var(--color-warning);
}

.spinning {
  animation: spin 1.1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>
