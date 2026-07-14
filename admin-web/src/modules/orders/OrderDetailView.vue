<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElAlert, ElButton, ElEmpty, ElSkeleton, ElTag } from "element-plus";
import { ArrowLeft, RefreshCw } from "lucide-vue-next";
import PageHeader from "@/components/PageHeader.vue";
import { statusLabels } from "@/config/resources";
import { toApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import type { ApiError } from "@/services/http/api-error";
import type { OrderDetail, OrderLine } from "@/services/transport/order-query-contract";
import { formatDateTime, formatMoney } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const order = ref<OrderDetail | null>(null);
const loading = ref(false);
const error = ref<ApiError | null>(null);

const address = computed(() => order.value?.shippingAddress || order.value?.shippingAddressMasked || null);
const hasSensitiveSection = computed(() => Boolean(order.value?.adminRemark || order.value?.riskLevelSnapshot));

function statusLabel(value: string): string {
  return statusLabels[value] || value || "-";
}

function statusType(value: string): "success" | "warning" | "danger" | "info" {
  if (["completed", "paid", "approved", "delivered"].includes(value)) return "success";
  if (["rejected", "cancelled", "failed", "blocked"].includes(value)) return "danger";
  if (["pending", "pending_review", "pending_admin", "pending_confirm", "unpaid", "important", "risk"].includes(value)) return "warning";
  return "info";
}

function lineSpecification(line: OrderLine): string {
  return [line.specification, line.productionDate ? `生产日期 ${line.productionDate}` : ""].filter(Boolean).join(" · ") || "-";
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    order.value = await transport.get<OrderDetail>("orders", String(route.params.id));
  } catch (reason) {
    order.value = null;
    error.value = toApiError(reason);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <main class="page-shell order-detail-page">
    <page-header title="订单详情" description="查看当前角色有权访问的订单资料与商品明细">
      <el-button :icon="ArrowLeft" @click="router.back()">返回订单列表</el-button>
      <el-button :icon="RefreshCw" :loading="loading" @click="load">刷新</el-button>
    </page-header>

    <section v-if="loading" class="surface detail-state" aria-label="订单详情加载中">
      <el-skeleton animated :rows="9" />
    </section>

    <section v-else-if="error" class="surface detail-state">
      <el-alert :title="error.message" :description="error.code" type="error" :closable="false" show-icon />
      <el-button @click="load">重新加载</el-button>
    </section>

    <section v-else-if="!order" class="surface detail-state">
      <el-empty description="订单不存在或已不可见" />
    </section>

    <template v-else>
      <section class="surface order-overview" data-testid="order-summary">
        <div class="order-heading" data-testid="order-heading">
          <div class="order-heading__identity">
            <span>订单号</span>
            <h2>{{ order.orderNo || order.id }}</h2>
          </div>
          <el-tag effect="plain" type="info">版本 {{ order.version }}</el-tag>
        </div>

        <dl class="summary-grid">
          <div><dt>订单状态</dt><dd><el-tag :type="statusType(order.status)" effect="light">{{ statusLabel(order.status) }}</el-tag></dd></div>
          <div><dt>付款状态</dt><dd><el-tag :type="statusType(order.paymentStatus)" effect="light">{{ statusLabel(order.paymentStatus) }}</el-tag></dd></div>
          <div><dt>配送状态</dt><dd><el-tag :type="statusType(order.deliveryStatus)" effect="light">{{ statusLabel(order.deliveryStatus) }}</el-tag></dd></div>
          <div><dt>商品数量</dt><dd class="numeric">{{ order.itemCount }} 种 / {{ order.totalQuantity }} 件</dd></div>
          <div><dt>创建时间</dt><dd>{{ formatDateTime(order.createdAt) }}</dd></div>
          <div><dt>更新时间</dt><dd>{{ formatDateTime(order.updatedAt) }}</dd></div>
          <div v-if="order.totalAmountCents !== undefined" data-testid="order-total-amount">
            <dt>订单金额</dt><dd class="money">{{ formatMoney(order.totalAmountCents) }}</dd>
          </div>
        </dl>
      </section>

      <section class="surface detail-section" data-testid="order-items">
        <div class="section-heading">
          <h2>商品明细</h2>
          <span>{{ order.totalQuantity }} 件</span>
        </div>
        <div class="item-table-wrap">
          <table class="item-table">
            <thead><tr><th>商品</th><th>规格</th><th class="numeric">数量</th><th class="numeric">单价</th><th class="numeric">小计</th></tr></thead>
            <tbody>
              <tr v-for="line in order.items" :key="line.id">
                <td><strong>{{ line.productName || "未命名商品" }}</strong></td>
                <td class="item-specification">{{ lineSpecification(line) }}</td>
                <td class="numeric">{{ line.quantity }}</td>
                <td class="numeric">{{ line.unitPriceCents === undefined ? "-" : formatMoney(line.unitPriceCents) }}</td>
                <td v-if="line.totalAmountCents !== undefined" :data-testid="`line-amount-${line.id}`" class="money numeric">{{ formatMoney(line.totalAmountCents) }}</td>
                <td v-else class="numeric">-</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="information-grid">
        <section class="surface detail-section" data-testid="order-customer">
          <div class="section-heading"><h2>客户信息</h2></div>
          <dl class="compact-list">
            <div><dt>客户</dt><dd>{{ order.customer.nameMasked || order.customerMasked }}</dd></div>
            <div><dt>联系电话</dt><dd class="numeric">{{ order.customer.phone || order.customer.phoneMasked }}</dd></div>
          </dl>
        </section>

        <section class="surface detail-section" data-testid="order-address">
          <div class="section-heading"><h2>收货地址</h2></div>
          <dl v-if="address" class="compact-list">
            <div><dt>收货人</dt><dd>{{ address.receiverName }}</dd></div>
            <div><dt>联系电话</dt><dd class="numeric">{{ "receiverPhone" in address ? address.receiverPhone : address.receiverPhoneMasked }}</dd></div>
            <div><dt>地址</dt><dd>{{ address.regionText }} {{ "detailAddress" in address ? address.detailAddress : address.detailAddressMasked }}</dd></div>
          </dl>
          <p v-else class="section-empty">当前订单没有可见的收货地址。</p>
        </section>
      </div>

      <section v-if="hasSensitiveSection" class="surface detail-section" data-testid="order-sensitive">
        <div class="section-heading"><h2>内部信息</h2></div>
        <dl class="compact-list">
          <div v-if="order.riskLevelSnapshot"><dt>下单时风险等级</dt><dd><el-tag :type="statusType(order.riskLevelSnapshot)" effect="light">{{ statusLabel(order.riskLevelSnapshot) }}</el-tag></dd></div>
          <div v-if="order.adminRemark"><dt>管理员备注</dt><dd>{{ order.adminRemark }}</dd></div>
        </dl>
      </section>
    </template>
  </main>
</template>

<style scoped>
.order-detail-page {
  width: 100%;
  min-width: 0;
}

.detail-state {
  display: flex;
  min-height: 320px;
  flex-direction: column;
  justify-content: center;
  gap: 16px;
  padding: 24px;
}

.detail-state :deep(.el-button) {
  align-self: center;
}

.order-overview,
.detail-section {
  min-width: 0;
  padding: 16px;
}

.order-heading,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.order-heading {
  padding-bottom: 14px;
  border-bottom: 1px solid var(--color-border);
}

.order-heading__identity {
  min-width: 0;
}

.order-heading__identity span,
.summary-grid dt,
.compact-list dt {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.order-heading h2 {
  margin-top: 3px;
  overflow-wrap: anywhere;
  font-size: 20px;
  line-height: 26px;
  letter-spacing: 0;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(130px, 1fr));
  margin: 0;
}

.summary-grid > div {
  min-width: 0;
  padding: 14px 12px 2px 0;
}

.summary-grid dd,
.compact-list dd {
  margin: 5px 0 0;
  overflow-wrap: anywhere;
  line-height: 20px;
}

.section-heading {
  min-height: 28px;
  margin-bottom: 10px;
}

.section-heading h2 {
  font-size: 16px;
  line-height: 24px;
}

.section-heading span {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.item-table-wrap {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.item-table {
  width: 100%;
  min-width: 680px;
  border-collapse: collapse;
  table-layout: fixed;
}

.item-table th,
.item-table td {
  height: 44px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  vertical-align: middle;
}

.item-table th {
  color: var(--color-text-secondary);
  background: var(--color-card-warm);
  font-size: 12px;
  font-weight: 600;
}

.item-table tr:last-child td {
  border-bottom: 0;
}

.item-table th:first-child,
.item-table td:first-child {
  width: 25%;
}

.item-table th:nth-child(2),
.item-table td:nth-child(2) {
  width: 35%;
}

.item-table th.numeric,
.item-table td.numeric {
  text-align: right;
}

.item-specification {
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

.information-grid {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.compact-list {
  margin: 0;
}

.compact-list > div {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 12px;
  padding: 9px 0;
  border-top: 1px solid var(--color-border);
}

.section-empty {
  padding: 16px 0;
  color: var(--color-text-secondary);
  line-height: 20px;
}

@media (max-width: 900px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .information-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 480px) {
  .order-overview,
  .detail-section,
  .detail-state {
    padding: 14px;
  }

  .order-heading {
    align-items: flex-start;
  }

  .summary-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .compact-list > div {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}
</style>
