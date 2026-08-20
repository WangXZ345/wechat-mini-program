<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElDialog,
  ElDivider,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElSkeleton,
  ElSwitch,
  type InputInstance
} from "element-plus";
import { toApiError } from "@/services/http/api-error";
import { PUBLIC_PRODUCT_TAGS, type PublicProductTag } from "@/services/transport/product-tag-contract";
import {
  normalizeCreateProductInput,
  normalizeEditProductInput,
  type CreateProductInput,
  type EditProductInput,
  type ProductDetail,
  type ProductMetadataInput
} from "@/services/transport/product-write-contract";
import type { AdminTransport } from "@/types/api";
import { createIdempotencyKey, formatMoney } from "@/utils/format";

type EditorMode = "create" | "edit";
type FieldName = keyof ProductMetadataInput | "salePriceYuan" | "stock" | "warningThreshold" | "reason";

const props = defineProps<{
  modelValue: boolean;
  mode: EditorMode;
  productId?: string;
  transport: AdminTransport;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [message: string];
}>();

interface EditorState extends ProductMetadataInput {
  keywordsText: string;
  salePriceYuan: number | null;
  stock: number | null;
  warningThreshold: number | null;
  isActive: boolean;
  tags: PublicProductTag[];
  reason: string;
}

function emptyState(): EditorState {
  return {
    name: "",
    baseName: "",
    imageUrl: "",
    specification: "",
    productionDate: "",
    description: "",
    productIndex: "",
    skuCode: "",
    keywords: [],
    keywordsText: "",
    salePriceYuan: 0,
    stock: 0,
    warningThreshold: 10,
    isActive: false,
    tags: [],
    reason: ""
  };
}

const form = reactive<EditorState>(emptyState());
const loading = ref(false);
const saving = ref(false);
const loadError = ref("");
const formError = ref("");
const conflictMessage = ref("");
const detail = ref<ProductDetail | null>(null);
const fieldErrors = reactive<Partial<Record<FieldName, string>>>({});
const nameInput = ref<InputInstance>();
const idempotencyKey = ref("");
const attemptFingerprint = ref("");

const title = computed(() => props.mode === "create" ? "新增商品" : "编辑商品资料");
const submitLabel = computed(() => props.mode === "create" ? "新增商品" : "保存资料");
const canSubmit = computed(() => !loading.value && !saving.value && !loadError.value && (props.mode === "create" || Boolean(detail.value)));

function resetForm(): void {
  Object.assign(form, emptyState());
  detail.value = null;
  loadError.value = "";
  formError.value = "";
  conflictMessage.value = "";
  idempotencyKey.value = createIdempotencyKey(`products:${props.mode}`);
  attemptFingerprint.value = "";
  for (const key of Object.keys(fieldErrors) as FieldName[]) delete fieldErrors[key];
}

function applyDetail(value: ProductDetail, preserveDraft = false): void {
  detail.value = value;
  if (preserveDraft) return;
  Object.assign(form, value.metadata, {
    keywordsText: value.metadata.keywords.join(" "),
    salePriceYuan: value.initial.salePriceCents / 100,
    stock: value.initial.stock,
    warningThreshold: value.initial.warningThreshold,
    isActive: value.initial.isActive,
    tags: [...value.initial.tags],
    reason: ""
  });
}

async function loadDetail(preserveDraft = false): Promise<void> {
  if (props.mode !== "edit") return;
  if (!props.productId) {
    loadError.value = "缺少商品 ID，无法加载商品资料";
    return;
  }
  loading.value = true;
  loadError.value = "";
  try {
    applyDetail(await props.transport.getProductDetail(props.productId), preserveDraft);
  } catch (reason) {
    loadError.value = toApiError(reason).message;
  } finally {
    loading.value = false;
  }
}

async function loadCreateWarningDefault(): Promise<void> {
  if (props.mode !== "create") return;
  try {
    const settings = await props.transport.get<{ lowStockDefaultThreshold: number }>("settings", "system");
    if (form.warningThreshold === 10 && Number.isSafeInteger(settings.lowStockDefaultThreshold) && settings.lowStockDefaultThreshold >= 0) {
      form.warningThreshold = settings.lowStockDefaultThreshold;
    }
  } catch {
    // A settings read must not prevent an operator from creating a product.
  }
}

function keywords(): string[] {
  return form.keywordsText
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function metadata(): ProductMetadataInput {
  return {
    name: form.name,
    baseName: form.baseName,
    imageUrl: form.imageUrl,
    specification: form.specification,
    productionDate: form.productionDate,
    description: form.description,
    productIndex: form.productIndex,
    skuCode: form.skuCode,
    keywords: keywords()
  };
}

function yuanToCents(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const scaled = value * 100;
  const cents = Math.round(scaled);
  return Number.isSafeInteger(cents) && Math.abs(scaled - cents) <= 1e-6 ? cents : null;
}

function validateField(field: FieldName): string {
  const limits: Partial<Record<keyof ProductMetadataInput, number>> = {
    name: 160,
    baseName: 160,
    imageUrl: 500,
    specification: 120,
    productionDate: 40,
    description: 1000,
    productIndex: 80,
    skuCode: 80
  };
  if (field === "name" && !form.name.trim()) return "请输入商品名称";
  if (field === "productIndex" && props.mode === "edit" && !form.productIndex.trim()) return "编辑商品时必须填写商品索引";
  if (field in limits) {
    const value = String(form[field as keyof ProductMetadataInput] || "").trim();
    const max = limits[field as keyof ProductMetadataInput] || 0;
    if (value.length > max) return `最多输入 ${max} 个字符`;
  }
  if (field === "imageUrl" && form.imageUrl.trim()) {
    try {
      const url = new URL(form.imageUrl.trim());
      if (!["http:", "https:", "cloud:"].includes(url.protocol)) return "请输入有效的 HTTP、HTTPS 或 CloudBase fileID";
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return "HTTP 或 HTTPS 图片地址必须包含有效域名";
      if (url.protocol === "cloud:" && (!url.hostname || !url.pathname || url.pathname === "/")) {
        return "CloudBase fileID 必须包含环境标识和文件路径";
      }
    } catch {
      return "请输入完整的图片地址，例如 https://example.com/image.jpg 或 cloud://env-id/path/image.jpg";
    }
  }
  if (field === "keywords") {
    const list = keywords();
    if (list.length > 20) return "最多填写 20 个关键词";
    if (list.some((item) => item.length > 40)) return "每个关键词最多 40 个字符";
    if (new Set(list).size !== list.length) return "请删除重复关键词";
  }
  if (field === "salePriceYuan" && yuanToCents(form.salePriceYuan) === null) return "销售价必须为非负金额，最多两位小数";
  if (field === "stock" && (typeof form.stock !== "number" || !Number.isSafeInteger(form.stock) || form.stock < 0 || form.stock > 9_999_999)) {
    return "初始库存必须是 0 到 9999999 的整数";
  }
  if (field === "warningThreshold" && (typeof form.warningThreshold !== "number" || !Number.isSafeInteger(form.warningThreshold) || form.warningThreshold < 0 || form.warningThreshold > 99_999)) {
    return "预警值必须是 0 到 99999 的整数";
  }
  if (field === "reason" && form.reason.trim().length > 120) return "操作说明最多 120 个字符";
  return "";
}

function checkField(field: FieldName): void {
  const message = validateField(field);
  if (message) fieldErrors[field] = message;
  else delete fieldErrors[field];
}

function validateAll(): boolean {
  const fields: FieldName[] = ["name", "baseName", "imageUrl", "specification", "productionDate", "description", "productIndex", "skuCode", "keywords", "reason"];
  if (props.mode === "create") fields.push("salePriceYuan", "stock", "warningThreshold");
  fields.forEach(checkField);
  return fields.every((field) => !fieldErrors[field]);
}

function buildInput(): CreateProductInput | EditProductInput {
  if (props.mode === "create") {
    const salePriceCents = yuanToCents(form.salePriceYuan);
    return normalizeCreateProductInput({
      metadata: metadata(),
      initial: {
        salePriceCents,
        stock: form.stock,
        warningThreshold: form.warningThreshold,
        isActive: form.isActive,
        tags: [...form.tags]
      },
      reason: form.reason
    });
  }
  if (!detail.value) throw new Error("商品详情尚未加载");
  return normalizeEditProductInput({
    id: detail.value.id,
    expectedVersion: detail.value.version,
    metadata: metadata(),
    reason: form.reason
  });
}

async function submit(): Promise<void> {
  if (!canSubmit.value || !validateAll()) {
    formError.value = "请修正表单中的错误后再保存";
    return;
  }
  formError.value = "";
  conflictMessage.value = "";
  let input: CreateProductInput | EditProductInput;
  try {
    input = buildInput();
  } catch (reason) {
    formError.value = toApiError(reason).message;
    return;
  }
  const fingerprint = JSON.stringify(input);
  if (attemptFingerprint.value && attemptFingerprint.value !== fingerprint) {
    idempotencyKey.value = createIdempotencyKey(`products:${props.mode}`);
  }
  attemptFingerprint.value = fingerprint;
  saving.value = true;
  try {
    const result = props.mode === "create"
      ? await props.transport.createProduct(input as CreateProductInput, { idempotencyKey: idempotencyKey.value })
      : await props.transport.editProduct(input as EditProductInput, {
          idempotencyKey: idempotencyKey.value,
          expectedVersion: (input as EditProductInput).expectedVersion
        });
    emit("saved", result.message);
    emit("update:modelValue", false);
  } catch (reason) {
    const error = toApiError(reason);
    if (props.mode === "edit" && error.code === "DATA_VERSION_CONFLICT") {
      await loadDetail(true);
      idempotencyKey.value = createIdempotencyKey("products:edit");
      attemptFingerprint.value = "";
      conflictMessage.value = loadError.value
        ? "商品资料已变化，但最新数据加载失败。请关闭后重新打开。"
        : "商品资料已被其他管理员更新。已保留当前填写内容，请核对后重新保存。";
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

function focusName(): void {
  void nextTick(() => nameInput.value?.focus());
}

watch(() => props.modelValue, (open) => {
  if (!open) return;
  resetForm();
  if (props.mode === "edit") void loadDetail();
  else void loadCreateWarningDefault();
});
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="min(760px, calc(100vw - 32px))"
    class="product-editor-dialog"
    destroy-on-close
    :before-close="guardClose"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    @opened="focusName"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-skeleton v-if="loading" :rows="7" animated aria-label="正在加载商品资料" />

    <div v-else-if="loadError" class="editor-state" role="alert">
      <el-alert :title="loadError" type="error" :closable="false" show-icon />
      <el-button @click="loadDetail(false)">重新加载</el-button>
    </div>

    <el-form v-else class="product-editor-form" label-position="top" @submit.prevent="submit">
      <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon class="form-alert" />
      <el-alert v-if="conflictMessage" :title="conflictMessage" type="warning" :closable="false" show-icon class="form-alert" />
      <el-alert
        v-if="mode === 'edit'"
        title="本窗口只修改商品资料。售价、库存、预警值、上下架和公开标签请使用列表中的专用操作。"
        type="info"
        :closable="false"
        show-icon
        class="form-alert"
      />

      <fieldset class="form-section">
        <legend>基础资料</legend>
        <div class="form-grid">
          <el-form-item label="商品名称" required :error="fieldErrors.name">
            <el-input ref="nameInput" v-model="form.name" data-testid="product-name" maxlength="160" show-word-limit :disabled="saving" @blur="checkField('name')" />
          </el-form-item>
          <el-form-item label="基础名称" :error="fieldErrors.baseName">
            <el-input v-model="form.baseName" data-testid="product-base-name" maxlength="160" :disabled="saving" @blur="checkField('baseName')" />
          </el-form-item>
          <el-form-item label="商品索引" :required="mode === 'edit'" :error="fieldErrors.productIndex">
            <el-input v-model="form.productIndex" data-testid="product-index" maxlength="80" :disabled="saving" :placeholder="mode === 'create' ? '留空时由服务端生成' : '编辑时不可留空'" @blur="checkField('productIndex')" />
          </el-form-item>
          <el-form-item label="SKU" :error="fieldErrors.skuCode">
            <el-input v-model="form.skuCode" data-testid="product-sku" maxlength="80" :disabled="saving" @blur="checkField('skuCode')" />
          </el-form-item>
          <el-form-item label="规格" :error="fieldErrors.specification">
            <el-input v-model="form.specification" maxlength="120" :disabled="saving" @blur="checkField('specification')" />
          </el-form-item>
          <el-form-item label="生产日期" :error="fieldErrors.productionDate">
            <el-input v-model="form.productionDate" maxlength="40" :disabled="saving" placeholder="例如 2026-07" @blur="checkField('productionDate')" />
          </el-form-item>
          <el-form-item class="span-2" label="商品图片地址" :error="fieldErrors.imageUrl">
            <el-input v-model="form.imageUrl" maxlength="500" :disabled="saving" placeholder="https://..." @blur="checkField('imageUrl')" />
            <div class="field-help">当前仅支持图片地址，不会上传文件到云存储。</div>
          </el-form-item>
          <el-form-item class="span-2" label="关键词" :error="fieldErrors.keywords">
            <el-input v-model="form.keywordsText" maxlength="500" :disabled="saving" placeholder="用空格或逗号分隔，最多 20 个" @blur="checkField('keywords')" />
          </el-form-item>
          <el-form-item class="span-2" label="商品说明" :error="fieldErrors.description">
            <el-input v-model="form.description" type="textarea" :rows="3" maxlength="1000" show-word-limit :disabled="saving" @blur="checkField('description')" />
          </el-form-item>
        </div>
      </fieldset>

      <fieldset v-if="mode === 'create'" class="form-section">
        <legend>初始业务字段</legend>
        <el-alert title="这些值只在新增时写入。新增后请使用列表中的专用操作调整。" type="warning" :closable="false" show-icon class="section-alert" />
        <div class="form-grid form-grid-3">
          <el-form-item label="销售价（元）" required :error="fieldErrors.salePriceYuan">
            <el-input-number v-model="form.salePriceYuan" data-testid="product-price" :min="0" :precision="2" :step="0.01" :disabled="saving" controls-position="right" @blur="checkField('salePriceYuan')" />
          </el-form-item>
          <el-form-item label="初始库存" required :error="fieldErrors.stock">
            <el-input-number v-model="form.stock" data-testid="product-stock" :min="0" :max="9999999" :step="1" :disabled="saving" controls-position="right" @blur="checkField('stock')" />
          </el-form-item>
          <el-form-item label="库存预警值" required :error="fieldErrors.warningThreshold">
            <el-input-number v-model="form.warningThreshold" data-testid="product-warning" :min="0" :max="99999" :step="1" :disabled="saving" controls-position="right" @blur="checkField('warningThreshold')" />
          </el-form-item>
          <el-form-item label="销售状态">
            <div class="switch-field">
              <el-switch v-model="form.isActive" :disabled="saving" />
              <span>{{ form.isActive ? '新增后上架' : '新增为草稿' }}</span>
            </div>
          </el-form-item>
          <el-form-item class="span-2" label="公开标签">
            <el-checkbox-group v-model="form.tags" :disabled="saving" class="tag-options">
              <el-checkbox v-for="tag in PUBLIC_PRODUCT_TAGS" :key="tag" :value="tag">{{ tag }}</el-checkbox>
            </el-checkbox-group>
          </el-form-item>
        </div>
      </fieldset>

      <section v-else-if="detail" class="business-snapshot" aria-label="当前业务状态">
        <div><span>当前售价</span><strong>{{ formatMoney(detail.initial.salePriceCents) }}</strong></div>
        <div><span>当前库存</span><strong>{{ detail.initial.stock }}</strong></div>
        <div><span>预警值</span><strong>{{ detail.initial.warningThreshold }}</strong></div>
        <div><span>销售状态</span><strong>{{ detail.initial.isActive ? '在售' : '未上架' }}</strong></div>
      </section>

      <el-divider />
      <el-form-item label="操作说明" :error="fieldErrors.reason">
        <el-input v-model="form.reason" type="textarea" :rows="2" maxlength="120" show-word-limit :disabled="saving" placeholder="记录本次新增或资料修改原因" @blur="checkField('reason')" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button :disabled="saving" @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!canSubmit" data-testid="product-editor-submit" @click="submit">
        {{ submitLabel }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.product-editor-form {
  max-height: min(68vh, 720px);
  overflow-y: auto;
  padding-right: 4px;
}

.form-alert,
.section-alert {
  margin-bottom: 16px;
}

.form-section {
  margin: 0;
  padding: 0;
  border: 0;
}

.form-section + .form-section {
  margin-top: 24px;
}

.form-section legend {
  margin-bottom: 12px;
  color: var(--color-text);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}

.form-grid-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.span-2 {
  grid-column: 1 / -1;
}

.product-editor-form :deep(.el-input-number) {
  width: 100%;
}

.field-help {
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 18px;
}

.switch-field,
.tag-options {
  display: flex;
  min-height: 32px;
  align-items: center;
  gap: 12px;
}

.business-snapshot {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin-top: 20px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-border);
}

.business-snapshot div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  background: var(--color-card-warm);
}

.business-snapshot span {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.business-snapshot strong {
  overflow: hidden;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-state {
  display: flex;
  min-height: 180px;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 16px;
}

@media (max-width: 640px) {
  .product-editor-form {
    max-height: 66vh;
  }

  .form-grid,
  .form-grid-3 {
    grid-template-columns: minmax(0, 1fr);
  }

  .span-2 {
    grid-column: auto;
  }

  .business-snapshot {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
