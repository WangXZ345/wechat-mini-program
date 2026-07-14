<script setup lang="ts">
import { useRouter } from "vue-router";
import { ElButton, ElResult } from "element-plus";
import { LayoutDashboard } from "lucide-vue-next";

const router = useRouter();
</script>

<template>
  <div class="result-page">
    <el-result icon="info" title="页面不存在" sub-title="地址可能已变更，返回工作台继续操作。">
      <template #extra>
        <el-button type="primary" :icon="LayoutDashboard" @click="router.push('/dashboard')">返回工作台</el-button>
      </template>
    </el-result>
  </div>
</template>

<style scoped>
.result-page {
  display: grid;
  min-height: calc(100vh - var(--topbar-height) - 28px);
  place-items: center;
  padding: 24px;
}
</style>
