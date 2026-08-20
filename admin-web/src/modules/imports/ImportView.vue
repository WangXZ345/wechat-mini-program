<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElEmpty,
  ElMessage,
  ElProgress,
  ElOption,
  ElSelect,
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
import {
  fileToImportPayload,
  parseImportExecutionResult,
  parseImportPreviewResult,
  type ImportFilePayload,
  type ImportExecutionData,
  type ImportMapping,
  type ImportPreviewData,
  type ImportReadyPreviewData
} from "@/services/transport/import-contract";
import { createIdempotencyKey, formatMoney } from "@/utils/format";

const props = defineProps<{ mode: "quotes" | "inventory" }>();
const fileList = ref<UploadUserFile[]>([]);
const parsing = ref(false);
const parseError = ref("");
const parsed = ref(false);
const confirmOpen = ref(false);
const confirming = ref(false);
const serverPreview = ref<ImportPreviewData | null>(null);
const selectedMapping = ref<ImportMapping>({});
const mappingDirty = ref(false);
const preparedFile = ref<ImportFilePayload | null>(null);
const resumeAvailable = ref(false);
const mappingRequired = computed(() => serverPreview.value?.status === "mapping_required");
const readyPreview = computed<ImportReadyPreviewData | null>(() => serverPreview.value?.status === "mapping_required" ? null : serverPreview.value);

const config = computed(() => props.mode === "quotes"
  ? { title: "报价导入", description: "校验商品报价文件并在确认前预览差异", permissionText: "商品售价与报价变更" }
  : { title: "库存导入", description: "校验库存文件并在确认前预览数量变化", permissionText: "商品库存与库存日志" });

interface DisplayPreviewRow {
  row: number;
  sku: string;
  name: string;
  before: number;
  after: number;
  status: "ready" | "changed" | "unchanged" | "new" | "error";
  message: string;
}

const previewRows = computed<DisplayPreviewRow[]>(() => {
  if (useMockTransport) return buildMockImportPreview(props.mode, fileList.value[0]?.name);
  return (readyPreview.value?.rows || []).map((row) => {
    const rawValue = row.after ?? row.values.value;
    const after = typeof rawValue === "number" ? rawValue : Number(rawValue);
    return {
      row: row.row,
      sku: String(row.sku ?? row.values.sku ?? ""),
      name: String(row.name ?? row.values.name ?? ""),
      before: Number.isSafeInteger(row.before) ? Number(row.before) : 0,
      after: Number.isSafeInteger(after) ? after : 0,
      status: row.status === "validation" ? "error" : "ready",
      message: row.message
    };
  });
});

const mappingFields = computed(() => [
  { key: "sku", label: "SKU", required: false },
  { key: "name", label: "商品", required: true },
  { key: "value", label: props.mode === "quotes" ? "报价" : "库存", required: true }
]);

const validCount = computed(() => useMockTransport
  ? previewRows.value.filter((row) => row.status !== "error").length
  : readyPreview.value?.counts.valid || 0);
const errorCount = computed(() => useMockTransport
  ? previewRows.value.filter((row) => row.status === "error").length
  : serverPreview.value?.status === "mapping_required" ? serverPreview.value.mappingErrors.length : readyPreview.value?.counts.failed || 0);
const previewTotal = computed(() => useMockTransport ? previewRows.value.length : readyPreview.value?.counts.total || 0);
const previewProgress = computed(() => previewTotal.value ? Math.round(validCount.value / previewTotal.value * 100) : 0);

function validateFile(file: UploadFile): string {
  const raw = file.raw;
  if (!raw) return "无法读取文件";
  const extension = raw.name.split(".").pop()?.toLowerCase();
  if (!extension || !["xlsx", "csv", "txt"].includes(extension)) return "仅支持 .xlsx、.csv 或 .txt 文件";
  if (raw.size > 10 * 1024 * 1024) return "文件不能超过 10 MB";
  if (!raw.size) return "文件不能为空";
  const allowedMime: Record<string, string[]> = {
    xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"],
    csv: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"],
    txt: ["text/plain", "text/tab-separated-values"]
  };
  if (!allowedMime[extension]?.includes(raw.type)) return "文件 MIME 类型与格式不匹配";
  return "";
}

function onFileChange(file: UploadFile, files: UploadFiles): void {
  fileList.value = files.slice(-1);
  parsed.value = false;
  parseError.value = validateFile(file);
  serverPreview.value = null;
  selectedMapping.value = {};
  mappingDirty.value = false;
  preparedFile.value = null;
  resumeAvailable.value = false;
}

async function parseFile(): Promise<void> {
  if (!fileList.value.length || parseError.value) return;
  parsing.value = true;
  try {
    if (useMockTransport) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      parsed.value = true;
      return;
    }
    const raw = fileList.value[0]?.raw;
    if (!raw) throw new Error("无法读取文件");
    const file = await fileToImportPayload(raw);
    const result = await transport.mutate<ImportPreviewData>("imports", "preview", {
      type: props.mode,
      file,
      mapping: { ...selectedMapping.value }
    }, { idempotencyKey: createIdempotencyKey(`${props.mode}:import-preview`) });
    const preview = parseImportPreviewResult(result);
    serverPreview.value = preview;
    selectedMapping.value = preview.status === "mapping_required" ? { ...preview.suggestedMapping } : { ...preview.mapping };
    preparedFile.value = file;
    mappingDirty.value = false;
    resumeAvailable.value = false;
    parsed.value = true;
    parseError.value = "";
  } catch (reason) {
    parseError.value = toApiError(reason).message;
    parsed.value = false;
  } finally {
    parsing.value = false;
  }
}

function markMappingDirty(): void {
  mappingDirty.value = true;
}

function clearFile(): void {
  fileList.value = [];
  parsed.value = false;
  parseError.value = "";
  serverPreview.value = null;
  selectedMapping.value = {};
  mappingDirty.value = false;
  preparedFile.value = null;
  resumeAvailable.value = false;
}

async function confirmImport(): Promise<void> {
  if (errorCount.value) {
    ElMessage.warning("请先修复错误行，再确认导入");
    return;
  }
  confirming.value = true;
  try {
    if (useMockTransport) {
      const resource = props.mode === "quotes" ? "products" : "inventory";
      const result = await transport.mutate(resource, "import-confirm", {
        ids: previewRows.value.map((row) => row.sku),
        rowCount: validCount.value,
        fileName: fileList.value[0]?.name
      }, { idempotencyKey: createIdempotencyKey(`${props.mode}:import`) });
      ElMessage.success(result.message);
      confirmOpen.value = false;
      clearFile();
      return;
    }
    if (!readyPreview.value || mappingDirty.value) throw new Error("请重新生成服务端预览");
    const raw = fileList.value[0]?.raw;
    const file = raw ? await fileToImportPayload(raw) : preparedFile.value;
    if (!file) throw new Error("无法读取文件");
    const action = resumeAvailable.value ? "resume" : "confirm";
    const result = await transport.mutate<ImportExecutionData>("imports", action, {
      type: props.mode,
      file,
      mapping: { ...selectedMapping.value },
      previewRecordId: readyPreview.value.importRecordId,
      expectedFileHash: readyPreview.value.fileHash,
      expectedParseHash: readyPreview.value.parseHash
    }, { idempotencyKey: createIdempotencyKey(`${props.mode}:import-${action}`) });
    const execution = parseImportExecutionResult(result);
    if (execution.status === "partial") {
      resumeAvailable.value = true;
      ElMessage.warning(result.message);
    } else if (execution.status === "failed") {
      resumeAvailable.value = true;
      ElMessage.error(result.message);
    } else {
      ElMessage.success(result.message);
      clearFile();
    }
    confirmOpen.value = false;
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
    ready: { label: "可处理", type: "success" },
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
          :limit="1"
          accept=".xlsx,.csv,.txt"
          :on-change="onFileChange"
          :on-remove="clearFile"
        >
          <upload-cloud :size="34" />
          <div class="upload-copy"><strong>选择或拖入文件</strong><span>支持 .xlsx、.csv、.txt，最大 10 MB；旧版 .xls 不支持安全解析</span></div>
        </el-upload>
        <el-alert v-if="parseError" :title="parseError" type="error" :closable="false" show-icon />
        <div v-if="fileList.length && !parseError" class="file-ready">
          <file-spreadsheet :size="22" />
          <div><strong>{{ fileList[0]?.name }}</strong><span>等待服务端安全校验</span></div>
          <el-button type="primary" :loading="parsing" @click="parseFile">开始校验</el-button>
        </div>
      </div>

      <template v-else>
        <div v-if="!useMockTransport && serverPreview" class="mapping-bar">
          <label v-for="field in mappingFields" :key="field.key">
            <span>{{ field.label }}<em v-if="field.required">必填</em></span>
            <el-select
              v-model="selectedMapping[field.key]"
              :clearable="!field.required"
              placeholder="选择表头"
              @change="markMappingDirty"
            >
              <el-option v-for="header in serverPreview.headers" :key="header" :label="header" :value="header" />
            </el-select>
          </label>
          <el-button :loading="parsing" :disabled="!mappingDirty" @click="parseFile">更新预览</el-button>
        </div>
        <el-alert
          v-if="mappingRequired"
          title="请完成表头映射，再使用同一文件重新校验。"
          type="warning"
          :closable="false"
          show-icon
        />
        <div class="preview-summary">
          <div><check-circle-2 :size="20" /><span><strong>{{ validCount }}</strong> 条可处理</span></div>
          <div class="has-error"><span><strong>{{ errorCount }}</strong> 条错误</span></div>
          <div class="preview-summary__progress"><el-progress :percentage="previewProgress" :stroke-width="8" /></div>
          <el-button :icon="RefreshCw" @click="clearFile">重新选择</el-button>
        </div>
        <el-alert
          v-if="errorCount && !mappingRequired"
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
          <el-button type="primary" :disabled="mappingRequired || Boolean(errorCount) || mappingDirty" @click="confirmOpen = true">
            {{ resumeAvailable ? '恢复失败行' : `确认导入 ${validCount} 条` }}
          </el-button>
        </footer>
      </template>
    </section>

    <el-dialog v-model="confirmOpen" :title="resumeAvailable ? '恢复导入' : '确认导入'" width="480px">
      <el-alert title="提交前请再次核对文件和影响范围" type="warning" :closable="false" show-icon />
      <div class="confirm-copy">
        <p>文件：{{ fileList[0]?.name }}</p>
        <p>可处理记录：{{ validCount }} 条</p>
        <p>影响范围：{{ config.permissionText }}</p>
      </div>
      <template #footer>
        <el-button @click="confirmOpen = false">取消</el-button>
        <el-button type="primary" :loading="confirming" @click="confirmImport">{{ resumeAvailable ? '确认恢复' : '确认提交' }}</el-button>
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

.mapping-bar {
  display: grid;
  grid-template-columns: repeat(3, minmax(150px, 1fr)) auto;
  align-items: end;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
  background: #fffdf9;
}

.mapping-bar label > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 5px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.mapping-bar em {
  color: var(--color-danger);
  font-size: 11px;
  font-style: normal;
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

@media (max-width: 760px) {
  .mapping-bar {
    grid-template-columns: 1fr;
  }

  .preview-summary,
  .preview-footer {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
