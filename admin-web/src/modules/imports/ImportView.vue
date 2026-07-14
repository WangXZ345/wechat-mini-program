<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElEmpty,
  ElMessage,
  ElProgress,
  ElTable,
  ElTableColumn,
  ElTag,
  ElUpload,
  type UploadFile,
  type UploadFiles,
  type UploadUserFile
} from "element-plus";
import { CheckCircle2, FileSpreadsheet, RefreshCw, Trash2, UploadCloud } from "lucide-vue-next";
import PageHeader from "@/components/PageHeader.vue";
import { useMockTransport } from "@/config/env";
import { buildMockImportPreview } from "./mock-import-preview";
import { toApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import { createIdempotencyKey, formatMoney } from "@/utils/format";

const props = defineProps<{ mode: "quotes" | "inventory" }>();
const fileList = ref<UploadUserFile[]>([]);
const parsing = ref(false);
const parseError = ref("");
const parsed = ref(false);
const confirmOpen = ref(false);
const confirming = ref(false);

const config = computed(() => props.mode === "quotes"
  ? { title: "报价导入", description: "校验商品报价文件并在确认前预览差异", permissionText: "商品售价与报价变更" }
  : { title: "库存导入", description: "校验库存文件并在确认前预览数量变化", permissionText: "商品库存与库存日志" });

const previewRows = computed(() => buildMockImportPreview(props.mode, fileList.value[0]?.name));

const validCount = computed(() => previewRows.value.filter((row) => row.status !== "error").length);
const errorCount = computed(() => previewRows.value.filter((row) => row.status === "error").length);

function validateFile(file: UploadFile): string {
  const raw = file.raw;
  if (!raw) return "无法读取文件";
  const extension = raw.name.split(".").pop()?.toLowerCase();
  if (!extension || !["xlsx", "xls", "csv"].includes(extension)) return "仅支持 .xlsx、.xls 或 .csv 文件";
  if (raw.size > 10 * 1024 * 1024) return "文件不能超过 10 MB";
  return "";
}

function onFileChange(file: UploadFile, files: UploadFiles): void {
  fileList.value = files.slice(-1);
  parsed.value = false;
  parseError.value = validateFile(file);
}

async function parseFile(): Promise<void> {
  if (!fileList.value.length || parseError.value) return;
  if (!useMockTransport) {
    parseError.value = "网页版导入服务尚未启用";
    return;
  }
  parsing.value = true;
  await new Promise((resolve) => window.setTimeout(resolve, 650));
  parsed.value = true;
  parsing.value = false;
}

function clearFile(): void {
  fileList.value = [];
  parsed.value = false;
  parseError.value = "";
}

async function confirmImport(): Promise<void> {
  if (errorCount.value) {
    ElMessage.warning("请先修复错误行，再确认导入");
    return;
  }
  confirming.value = true;
  try {
    const resource = props.mode === "quotes" ? "products" : "inventory";
    const result = await transport.mutate(resource, "import-confirm", {
      ids: previewRows.value.map((row) => row.sku),
      rowCount: validCount.value,
      fileName: fileList.value[0]?.name
    }, { idempotencyKey: createIdempotencyKey(`${props.mode}:import`) });
    ElMessage.success(result.message);
    confirmOpen.value = false;
    clearFile();
  } catch (reason) {
    ElMessage.error(toApiError(reason).message);
  } finally {
    confirming.value = false;
  }
}

function rowTag(status: string): { label: string; type: "success" | "warning" | "danger" | "info" } {
  const map: Record<string, { label: string; type: "success" | "warning" | "danger" | "info" }> = {
    changed: { label: "有变化", type: "warning" },
    unchanged: { label: "无变化", type: "info" },
    new: { label: "新记录", type: "success" },
    error: { label: "错误", type: "danger" }
  };
  return map[status] || map.error!;
}
</script>

<template>
  <div class="page-shell import-page">
    <page-header :title="config.title" :description="config.description">
      <el-button v-if="fileList.length" :icon="Trash2" @click="clearFile">清除文件</el-button>
    </page-header>

    <el-alert
      v-if="!useMockTransport"
      title="当前仅支持查看，网页版导入服务尚未启用"
      type="warning"
      :closable="false"
      show-icon
    />

    <section class="surface import-tool">
      <div class="step-bar">
        <div :class="['step', { active: !parsed, done: parsed }]">
          <span>{{ parsed ? '✓' : '1' }}</span><div><strong>选择文件</strong><small>本地校验格式与大小</small></div>
        </div>
        <div :class="['step', { active: parsed }]">
          <span>2</span><div><strong>预览差异</strong><small>检查错误行和变化</small></div>
        </div>
        <div class="step">
          <span>3</span><div><strong>确认导入</strong><small>服务端再次校验</small></div>
        </div>
      </div>

      <div v-if="!parsed" class="upload-stage">
        <el-upload
          v-model:file-list="fileList"
          drag
          :auto-upload="false"
          :disabled="!useMockTransport"
          :limit="1"
          accept=".xlsx,.xls,.csv"
          :on-change="onFileChange"
          :on-remove="clearFile"
        >
          <upload-cloud :size="34" />
          <div class="upload-copy"><strong>选择或拖入文件</strong><span>支持 .xlsx、.xls、.csv，最大 10 MB</span></div>
        </el-upload>
        <el-alert v-if="parseError" :title="parseError" type="error" :closable="false" show-icon />
        <div v-if="fileList.length && !parseError" class="file-ready">
          <file-spreadsheet :size="22" />
          <div><strong>{{ fileList[0]?.name }}</strong><span>等待本地预校验</span></div>
          <el-button type="primary" :loading="parsing" @click="parseFile">开始校验</el-button>
        </div>
      </div>

      <template v-else>
        <div class="preview-summary">
          <div><check-circle-2 :size="20" /><span><strong>{{ validCount }}</strong> 条可处理</span></div>
          <div class="has-error"><span><strong>{{ errorCount }}</strong> 条错误</span></div>
          <div class="preview-summary__progress"><el-progress :percentage="Math.round(validCount / previewRows.length * 100)" :stroke-width="8" /></div>
          <el-button :icon="RefreshCw" @click="clearFile">重新选择</el-button>
        </div>
        <el-alert
          v-if="errorCount"
          title="预览中包含错误行，请修复源文件后重新校验。"
          type="error"
          :closable="false"
          show-icon
        />
        <el-table :data="previewRows" height="420" stripe>
          <el-table-column prop="row" label="行号" width="72" />
          <el-table-column prop="sku" label="SKU" width="130" />
          <el-table-column prop="name" label="商品" min-width="210" />
          <el-table-column label="原值" width="130">
            <template #default="{ row }">{{ props.mode === 'quotes' ? formatMoney(row.before) : row.before }}</template>
          </el-table-column>
          <el-table-column label="新值" width="130">
            <template #default="{ row }"><span :class="{ money: props.mode === 'quotes' }">{{ props.mode === 'quotes' ? formatMoney(row.after) : row.after }}</span></template>
          </el-table-column>
          <el-table-column label="校验" width="100">
            <template #default="{ row }"><el-tag :type="rowTag(row.status).type" size="small">{{ rowTag(row.status).label }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="message" label="说明" min-width="180" />
          <template #empty><el-empty description="没有可预览的记录" /></template>
        </el-table>
        <footer class="preview-footer">
          <span>导入将影响：{{ config.permissionText }}</span>
          <el-button type="primary" :disabled="Boolean(errorCount)" @click="confirmOpen = true">确认导入 {{ validCount }} 条</el-button>
        </footer>
      </template>
    </section>

    <el-dialog v-model="confirmOpen" title="确认导入" width="480px">
      <el-alert title="提交前请再次核对文件和影响范围" type="warning" :closable="false" show-icon />
      <div class="confirm-copy">
        <p>文件：{{ fileList[0]?.name }}</p>
        <p>可处理记录：{{ validCount }} 条</p>
        <p>影响范围：{{ config.permissionText }}</p>
      </div>
      <template #footer>
        <el-button @click="confirmOpen = false">取消</el-button>
        <el-button type="primary" :loading="confirming" @click="confirmImport">确认提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.import-tool {
  min-height: 590px;
  overflow: hidden;
}

.step-bar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-bottom: 1px solid var(--color-border);
  background: #faf8f5;
}

.step {
  position: relative;
  display: flex;
  min-height: 78px;
  align-items: center;
  justify-content: center;
  gap: 11px;
  color: var(--color-text-muted);
}

.step + .step::before {
  position: absolute;
  width: 1px;
  background: var(--color-border);
  content: "";
  inset: 14px auto 14px 0;
}

.step > span {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--color-border-strong);
  border-radius: 50%;
  background: #fff;
  font-weight: 700;
}

.step strong,
.step small {
  display: block;
}

.step small {
  margin-top: 3px;
  font-size: 11px;
}

.step.active,
.step.done {
  color: var(--color-text);
}

.step.active > span {
  color: #fff;
  border-color: var(--color-primary-deep);
  background: var(--color-primary-deep);
}

.step.done > span {
  color: #fff;
  border-color: var(--color-success);
  background: var(--color-success);
}

.upload-stage {
  max-width: 760px;
  margin: 48px auto;
  padding: 0 24px;
}

.upload-stage :deep(.el-upload-dragger) {
  display: flex;
  min-height: 230px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 14px;
  border-radius: 8px;
  border-color: var(--color-border-strong);
  background: #fffdf9;
}

.upload-copy strong,
.upload-copy span {
  display: block;
}

.upload-copy strong {
  font-size: 16px;
}

.upload-copy span {
  margin-top: 5px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.file-ready {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  padding: 13px 14px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.file-ready strong,
.file-ready span {
  display: block;
}

.file-ready span {
  margin-top: 3px;
  color: var(--color-text-muted);
  font-size: 11px;
}

.preview-summary {
  display: flex;
  min-height: 68px;
  align-items: center;
  gap: 22px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.preview-summary > div {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--color-success);
}

.preview-summary > .has-error {
  color: var(--color-danger);
}

.preview-summary__progress {
  flex: 1;
}

.preview-summary__progress :deep(.el-progress) {
  width: 100%;
}

.preview-footer {
  display: flex;
  min-height: 64px;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  color: var(--color-text-secondary);
  border-top: 1px solid var(--color-border);
}

.confirm-copy {
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  line-height: 28px;
}
</style>
