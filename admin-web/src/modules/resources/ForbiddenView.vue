<script setup lang="ts">
import { useRouter } from "vue-router";
import { ElButton, ElResult } from "element-plus";
import { ArrowLeft, LayoutDashboard } from "lucide-vue-next";

const router = useRouter();
</script>

<template>
  <div class="result-page">
    <el-result icon="warning" title="无权访问" sub-title="当前角色没有该页面权限，服务端请求也不会发送。">
      <template #extra>
        <el-button :icon="ArrowLeft" @click="router.back()">返回</el-button>
        <el-button type="primary" :icon="LayoutDashboard" @click="router.push('/dashboard')">工作台</el-button>
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
