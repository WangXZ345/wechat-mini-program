<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  ElAlert,
  ElButton,
  ElForm,
  ElFormItem,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElSkeleton,
  ElSwitch,
  ElTag
} from "element-plus";
import { RefreshCw, Save } from "lucide-vue-next";
import PageHeader from "@/components/PageHeader.vue";
import { toApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import type { ApiError } from "@/services/http/api-error";
import { createIdempotencyKey, formatDateTime } from "@/utils/format";

interface SettingsRecord extends Record<string, unknown> {
  id: string;
  version: number;
  enableOfflineQrPayment: boolean;
  enableBankTransfer: boolean;
  enableWechatPay: boolean;
  requirePaymentProofForOfflinePayment: boolean;
  allowMultiplePaymentRecords: boolean;
  maxPaymentScreenshotCount: number;
  lowStockDefaultThreshold: number;
  sessionIdleMinutes: number;
  updatedAt: string;
}

const loading = ref(false);
const saving = ref(false);
const error = ref<ApiError | null>(null);
const loaded = ref(false);
const readOnly = computed(() => transport.mode === "http");
const form = reactive<SettingsRecord>({
  id: "system",
  version: 0,
  enableOfflineQrPayment: false,
  enableBankTransfer: false,
  enableWechatPay: false,
  requirePaymentProofForOfflinePayment: true,
  allowMultiplePaymentRecords: false,
  maxPaymentScreenshotCount: 3,
  lowStockDefaultThreshold: 50,
  sessionIdleMinutes: 30,
  updatedAt: ""
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    Object.assign(form, await transport.get<SettingsRecord>("settings", "system"));
    loaded.value = true;
  } catch (reason) {
    error.value = toApiError(reason);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      "这些设置会影响付款、库存预警或管理员会话。",
      "确认保存系统设置",
      { type: "warning", confirmButtonText: "确认保存", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  saving.value = true;
  try {
    const result = await transport.mutate<SettingsRecord>("settings", "update", { ...form }, {
      idempotencyKey: createIdempotencyKey("settings:update"),
      expectedVersion: form.version
    });
    if (result.item) Object.assign(form, result.item);
    ElMessage.success(result.message);
  } catch (reason) {
    const apiError = toApiError(reason);
    ElMessage.error(apiError.code === "DATA_VERSION_CONFLICT" ? "设置已被其他管理员更新，请重新加载" : apiError.message);
  } finally {
    saving.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="page-shell settings-page">
    <page-header title="系统设置" description="维护付款、库存预警和管理员会话的基础规则">
      <span v-if="loaded" class="updated-at">版本 {{ form.version }} · {{ formatDateTime(form.updatedAt) }}</span>
      <el-button :icon="RefreshCw" :loading="loading" @click="load">重新加载</el-button>
      <el-button type="primary" :icon="Save" :loading="saving" :disabled="!loaded || readOnly" @click="save">保存设置</el-button>
    </page-header>

    <el-alert v-if="readOnly" title="当前页面为只读，设置写入尚未开放" type="warning" :closable="false" show-icon />

    <div v-if="error" class="settings-state surface">
      <el-alert :title="error.message" :description="`错误码：${error.code}`" type="error" :closable="false" show-icon />
      <el-button @click="load">重新加载</el-button>
    </div>

    <section v-else class="surface settings-surface">
      <el-skeleton v-if="loading && !loaded" animated :rows="10" />
      <el-form v-else label-position="left" label-width="290px" :disabled="readOnly">
        <section class="settings-section">
          <header><div><h2>付款规则</h2><p>配置付款方式与凭证要求</p></div><el-tag type="warning" effect="plain">敏感设置</el-tag></header>
          <el-form-item label="允许线下二维码付款"><el-switch v-model="form.enableOfflineQrPayment" /></el-form-item>
          <el-form-item label="允许银行卡转账"><el-switch v-model="form.enableBankTransfer" /></el-form-item>
          <el-form-item label="启用微信支付"><el-switch v-model="form.enableWechatPay" /></el-form-item>
          <el-form-item label="线下付款必须上传凭证"><el-switch v-model="form.requirePaymentProofForOfflinePayment" /></el-form-item>
          <el-form-item label="允许同一订单多笔付款记录"><el-switch v-model="form.allowMultiplePaymentRecords" /></el-form-item>
          <el-form-item label="单次最多付款截图数"><el-input-number v-model="form.maxPaymentScreenshotCount" :min="1" :max="9" controls-position="right" /></el-form-item>
        </section>

        <section class="settings-section">
          <header><div><h2>库存与预警</h2><p>设置默认预警阈值</p></div></header>
          <el-form-item label="默认低库存预警值"><el-input-number v-model="form.lowStockDefaultThreshold" :min="0" :max="99999" controls-position="right" /></el-form-item>
        </section>

        <section class="settings-section">
          <header><div><h2>管理员会话</h2><p>设置无操作自动锁定时间</p></div></header>
          <el-form-item label="无操作自动锁定（分钟）"><el-input-number v-model="form.sessionIdleMinutes" :min="5" :max="240" :step="5" controls-position="right" /></el-form-item>
        </section>
      </el-form>
    </section>
  </div>
</template>

<style scoped>
.updated-at {
  align-self: center;
  color: var(--color-text-muted);
  font-size: 12px;
}

.settings-surface {
  max-width: 1080px;
  padding: 8px 24px 24px;
}

.settings-section {
  padding: 22px 0 8px;
}

.settings-section + .settings-section {
  border-top: 1px solid var(--color-border);
}

.settings-section header {
  display: flex;
  min-height: 60px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.settings-section h2 {
  font-size: 16px;
}

.settings-section p {
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.settings-section :deep(.el-form-item) {
  min-height: 48px;
  margin: 0;
  padding: 8px 0;
  border-top: 1px solid #f0e9e1;
}

.settings-section :deep(.el-form-item__content) {
  justify-content: flex-end;
}

.settings-state {
  display: flex;
  min-height: 420px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px;
}
</style>
