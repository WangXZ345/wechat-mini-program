<script setup lang="ts">
import { computed, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElOption, ElSelect, ElTag } from "element-plus";
import { ArrowRight, LockKeyhole, ShieldCheck, UserRound } from "lucide-vue-next";
import beautyShowroom from "@/assets/beauty-showroom.webp";
import { dataEnvironmentLabel, isDevBffProxyMissing, useMockTransport } from "@/config/env";
import { selectedLoginDemo } from "@/services/transport";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const form = reactive({
  account: selectedLoginDemo?.defaultAccount || "",
  password: selectedLoginDemo?.defaultPassword || ""
});

const backgroundStyle = computed(() => ({ backgroundImage: `url(${beautyShowroom})` }));
const demoAccounts = selectedLoginDemo?.accounts || [];

function safeRedirect(): string {
  const value = route.query.redirect;
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

async function submit(): Promise<void> {
  auth.clearError();
  try {
    await auth.login(form);
    await router.replace(safeRedirect());
  } catch {
    // Store exposes the normalized error below the form.
  }
}
</script>

<template>
  <main class="login-view" :style="backgroundStyle">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-brand">
        <span class="login-brand__mark">美</span>
        <div>
          <strong>美妆订货管理</strong>
          <small>BEAUTY WHOLESALE OPERATIONS</small>
        </div>
      </div>

      <div class="login-heading">
        <el-tag :type="useMockTransport ? 'warning' : 'info'" effect="plain" size="small">{{ dataEnvironmentLabel }}</el-tag>
        <h1 id="login-title">管理员登录</h1>
        <p>电脑端运营工作台</p>
      </div>

      <el-alert
        v-if="useMockTransport"
        title="当前仅使用虚构演示数据，不连接业务数据库"
        type="warning"
        :closable="false"
        show-icon
      />

      <el-alert
        v-else-if="isDevBffProxyMissing"
        title="未配置测试 BFF 连接"
        description="当前为真实数据模式，本地开发服务器不会回退到演示数据。"
        type="warning"
        :closable="false"
        show-icon
      />

      <el-alert
        v-if="auth.error"
        :title="auth.error.message"
        type="error"
        :closable="false"
        show-icon
      />

      <el-form class="login-form" label-position="top" @submit.prevent="submit">
        <el-form-item label="管理员账号">
          <el-select v-if="useMockTransport" v-model="form.account" size="large" style="width: 100%">
            <template #prefix><user-round :size="17" /></template>
            <el-option v-for="account in demoAccounts" :key="account.value" :label="account.label" :value="account.value" />
          </el-select>
          <el-input v-else v-model.trim="form.account" size="large" autocomplete="username" placeholder="请输入管理员账号">
            <template #prefix><user-round :size="17" /></template>
          </el-input>
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            size="large"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="请输入密码"
            @keyup.enter="submit"
          >
            <template #prefix><lock-keyhole :size="17" /></template>
          </el-input>
        </el-form-item>
        <el-button
          class="login-submit"
          type="primary"
          size="large"
          native-type="submit"
          :loading="auth.authenticating"
          :disabled="!form.account || !form.password"
        >
          安全登录
          <arrow-right :size="17" />
        </el-button>
      </el-form>

      <div class="login-security">
        <shield-check :size="17" />
        <span>管理员专用，请勿共享账号</span>
      </div>
    </section>
  </main>
</template>

<style scoped>
.login-view {
  display: flex;
  width: 100vw;
  min-width: 900px;
  min-height: 100vh;
  align-items: center;
  padding: 48px clamp(48px, 8vw, 144px);
  background-color: #f2eee7;
  background-position: center;
  background-size: cover;
}

.login-panel {
  width: min(430px, 42vw);
  padding: 32px;
  border: 1px solid rgba(213, 194, 170, 0.82);
  border-radius: 8px;
  background: rgba(255, 253, 249, 0.94);
  box-shadow: 0 18px 50px rgba(45, 37, 29, 0.13);
  backdrop-filter: blur(10px);
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 11px;
}

.login-brand__mark {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 6px;
  color: #fff;
  background: #1f1a15;
  font-family: Georgia, serif;
  font-size: 23px;
  font-weight: 700;
}

.login-brand strong,
.login-brand small {
  display: block;
}

.login-brand strong {
  font-size: 16px;
}

.login-brand small {
  margin-top: 3px;
  color: var(--color-text-muted);
  font-size: 9px;
}

.login-heading {
  margin: 38px 0 20px;
}

.login-heading h1 {
  margin-top: 12px;
  font-size: 28px;
  line-height: 38px;
}

.login-heading p {
  margin-top: 5px;
  color: var(--color-text-secondary);
  line-height: 21px;
}

.login-form {
  margin-top: 20px;
}

.login-submit {
  width: 100%;
  margin-top: 4px;
}

.login-security {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 22px;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 18px;
}

@media (max-width: 1100px) {
  .login-view {
    padding: 36px 48px;
    background-position: 64% center;
  }

  .login-panel {
    width: 420px;
  }
}

@media (max-width: 640px) {
  .login-view {
    min-width: 0;
    padding: 20px 16px;
    background-position: center;
  }

  .login-panel {
    width: 100%;
    padding: 24px 20px;
  }

  .login-heading {
    margin-top: 28px;
  }
}
</style>
