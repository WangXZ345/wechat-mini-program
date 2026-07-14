<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElAlert, ElButton, ElDialog, ElForm, ElFormItem, ElInput, ElInputNumber, ElSkeleton } from "element-plus";
import { toApiError } from "@/services/http/api-error";
import {
  MAX_INVENTORY_STOCK,
  normalizeInventoryAdjustmentInput,
  type InventoryResource,
  type InventorySnapshot
} from "@/services/transport/inventory-adjustment-contract";
import type { AdminTransport } from "@/types/api";
import { createIdempotencyKey, formatDateTime } from "@/utils/format";

const props = defineProps<{
  modelValue: boolean;
  productId: string;
  productName: string;
  sku: string;
  resource: InventoryResource;
  transport: AdminTransport;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [message: string];
}>();

const form = reactive<{ delta: number | null; reason: string }>({ delta: null, reason: "" });
const snapshot = ref<InventorySnapshot | null>(null);
const loading = ref(false);
const saving = ref(false);
const loadError = ref("");
const formError = ref("");
const deltaError = ref("");
const reasonError = ref("");
const conflictMessage = ref("");
const idempotencyKey = ref("");
const attemptFingerprint = ref("");

const afterStock = computed(() => {
  if (!snapshot.value || typeof form.delta !== "number" || !Number.isSafeInteger(form.delta)) return null;
  return snapshot.value.stock + form.delta;
});
const directionLabel = computed(() => typeof form.delta !== "number" || form.delta === 0
  ? "库存调整"
  : form.delta > 0 ? `增加 ${form.delta} 件` : `减少 ${Math.abs(form.delta)} 件`);
const submitLabel = computed(() => typeof form.delta !== "number" || form.delta === 0
  ? "确认调整"
  : `确认${directionLabel.value}`);
const statusLabel = computed(() => ({ normal: "正常", low: "低库存", out: "缺货" })[snapshot.value?.status || "normal"]);
const canSubmit = computed(() => Boolean(snapshot.value) && !loading.value && !saving.value && !loadError.value);

function reset(): void {
  form.delta = null;
  form.reason = "";
  snapshot.value = null;
  loadError.value = "";
  formError.value = "";
  deltaError.value = "";
  reasonError.value = "";
  conflictMessage.value = "";
  idempotencyKey.value = createIdempotencyKey(`${props.resource}:adjust`);
  attemptFingerprint.value = "";
}

async function loadSnapshot(preserveDraft = false): Promise<void> {
  if (!props.productId) {
    loadError.value = "缺少商品 ID，无法核对库存";
    return;
  }
  loading.value = true;
  loadError.value = "";
  try {
    snapshot.value = await props.transport.getInventorySnapshot(props.productId);
    if (!preserveDraft) {
      form.delta = null;
      form.reason = "";
    }
  } catch (reason) {
    loadError.value = toApiError(reason).message;
  } finally {
    loading.value = false;
  }
}

function validate(): boolean {
  deltaError.value = "";
  reasonError.value = "";
  formError.value = "";
  if (typeof form.delta !== "number" || !Number.isSafeInteger(form.delta) || form.delta === 0) {
    deltaError.value = "请输入非零整数，正数增加库存，负数减少库存";
  } else if (Math.abs(form.delta) > MAX_INVENTORY_STOCK) {
    deltaError.value = `调整数量不能超过 ${MAX_INVENTORY_STOCK}`;
  } else if (afterStock.value === null || afterStock.value < 0 || afterStock.value > MAX_INVENTORY_STOCK) {
    deltaError.value = `调整后库存必须在 0 到 ${MAX_INVENTORY_STOCK} 之间`;
  }
  if (!form.reason.trim()) reasonError.value = "请填写本次库存调整原因";
  else if (form.reason.trim().length > 120) reasonError.value = "调整原因最多 120 个字符";
  return !deltaError.value && !reasonError.value;
}

function clearDeltaError(): void {
  deltaError.value = "";
}

function clearReasonError(): void {
  reasonError.value = "";
}

async function submit(): Promise<void> {
  if (!canSubmit.value || !snapshot.value || !validate()) {
    if (!snapshot.value) formError.value = "最新库存尚未加载完成";
    return;
  }
  let input;
  try {
    input = normalizeInventoryAdjustmentInput({
      id: snapshot.value.id,
      mode: "delta",
      delta: form.delta,
      expectedStock: snapshot.value.stock,
      expectedVersion: snapshot.value.version,
      reason: form.reason
    });
  } catch (reason) {
    formError.value = toApiError(reason).message;
    return;
  }
  const fingerprint = JSON.stringify(input);
  if (attemptFingerprint.value && attemptFingerprint.value !== fingerprint) {
    idempotencyKey.value = createIdempotencyKey(`${props.resource}:adjust`);
  }
  attemptFingerprint.value = fingerprint;
  saving.value = true;
  formError.value = "";
  conflictMessage.value = "";
  try {
    const result = await props.transport.adjustInventory(props.resource, input, {
      idempotencyKey: idempotencyKey.value,
      expectedVersion: input.expectedVersion
    });
    emit("saved", result.message);
    emit("update:modelValue", false);
  } catch (reason) {
    const error = toApiError(reason);
    if (error.code === "DATA_VERSION_CONFLICT") {
      await loadSnapshot(true);
      idempotencyKey.value = createIdempotencyKey(`${props.resource}:adjust`);
      attemptFingerprint.value = "";
      conflictMessage.value = loadError.value
        ? "库存已变化，但最新库存加载失败。请关闭后重新打开。"
        : "库存已被其他操作更新。已保留调整数量和原因，请核对新的调整后库存再提交。";
    } else {
      formError.value = error.message;
    }
  } finally {
    saving.value = false;
  }
}

function close(): void {
  if (!saving.value) emit("update:modelValue", false);
}

function guardClose(done: () => void): void {
  if (!saving.value) done();
}

watch(() => props.modelValue, (open) => {
  if (!open) return;
  reset();
  void loadSnapshot();
});
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="人工调整库存"
    width="min(520px, calc(100vw - 24px))"
    class="inventory-adjust-dialog"
    destroy-on-close
    :before-close="guardClose"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="product-heading">
      <strong>{{ productName || '未命名商品' }}</strong>
      <span>{{ sku || '无 SKU' }}</span>
    </div>

    <el-skeleton v-if="loading && !snapshot" :rows="4" animated />
    <div v-else-if="loadError" class="load-state">
      <el-alert :title="loadError" type="error" :closable="false" show-icon />
      <el-button :disabled="saving" @click="loadSnapshot(false)">重新加载</el-button>
    </div>
    <el-form v-else class="adjust-form" label-position="top" @submit.prevent="submit">
      <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon />
      <el-alert v-if="conflictMessage" :title="conflictMessage" type="warning" :closable="false" show-icon />

      <dl v-if="snapshot" class="snapshot-grid" aria-label="当前库存快照">
        <div><dt>当前库存</dt><dd data-testid="inventory-current-stock">{{ snapshot.stock }}</dd></div>
        <div><dt>预警值</dt><dd>{{ snapshot.warningThreshold }}</dd></div>
        <div><dt>库存状态</dt><dd>{{ statusLabel }}</dd></div>
        <div><dt>更新时间</dt><dd>{{ formatDateTime(snapshot.updatedAt) }}</dd></div>
      </dl>

      <el-form-item label="增加或减少数量" :error="deltaError" required>
        <el-input-number
          v-model="form.delta"
          data-testid="inventory-delta"
          :min="-MAX_INVENTORY_STOCK"
          :max="MAX_INVENTORY_STOCK"
          :step="1"
          :disabled="saving"
          controls-position="right"
          style="width: 100%"
          @change="clearDeltaError"
          @blur="validate"
        />
        <span class="field-help">正数增加库存，负数减少库存</span>
      </el-form-item>

      <div class="stock-preview" :class="{ invalid: afterStock !== null && (afterStock < 0 || afterStock > MAX_INVENTORY_STOCK) }">
        <span>调整后库存</span>
        <strong data-testid="inventory-after-stock">{{ snapshot && afterStock !== null ? `${snapshot.stock} → ${afterStock}` : '待输入' }}</strong>
      </div>

      <el-form-item label="调整原因" :error="reasonError" required>
        <el-input
          v-model="form.reason"
          data-testid="inventory-reason"
          type="textarea"
          :rows="3"
          maxlength="120"
          show-word-limit
          :disabled="saving"
          placeholder="例如：到货入库、盘点修正、报损出库"
          @input="clearReasonError"
          @blur="validate"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button :disabled="saving" @click="close">取消</el-button>
      <el-button
        type="primary"
        :loading="saving"
        :disabled="!canSubmit"
        data-testid="inventory-adjust-submit"
        @click="submit"
      >
        {{ submitLabel }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.product-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border);
}

.product-heading strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-heading span,
.field-help {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.load-state {
  display: grid;
  justify-items: start;
  gap: 12px;
}

.adjust-form {
  display: grid;
  gap: 12px;
}

.snapshot-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-card);
}

.snapshot-grid > div {
  min-width: 0;
  padding: 10px 12px;
}

.snapshot-grid dt {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.snapshot-grid dd {
  margin: 4px 0 0;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stock-preview {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-card-warm);
}

.stock-preview strong {
  font-variant-numeric: tabular-nums;
}

.stock-preview.invalid {
  color: var(--color-danger);
  border-color: var(--color-danger);
}

@media (max-width: 640px) {
  .product-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .snapshot-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  :deep(.el-dialog__footer) {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  :deep(.el-dialog__footer .el-button) {
    min-height: 44px;
    margin: 0;
  }
}
</style>
