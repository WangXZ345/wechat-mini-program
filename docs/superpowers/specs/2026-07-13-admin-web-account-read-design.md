# 网页后台客户账款只读接入设计

## 1. 目标与范围

本切片把网页版 `/accounts` 从通用 `customer_accounts` 单集合投影升级为真实、严格、可审计的“账款列表 + 专用只读详情”。网页、小程序继续读取同一份 `customer_accounts`、`account_logs` 和 `orders` 数据，不创建网页专用账款模型。

本切片只做读取，不开放账款重算、人工修改、结清、导出或任何付款写操作。任何页面刷新、详情读取和同步事件都不得调用 `recalculateCustomerAccount`，不得创建集合或修正真实数据。

付款审核不在本切片。现有 `payment_records` 是追加式凭证/确认记录，不能直接当作当前审核队列；付款读取将在后续以 `orders` 当前付款状态为主重新设计。

## 2. 方案选择

采用“canonical 查询服务 + 双端适配器 + Web 严格 DTO”方案：

- 新增 `cloudfunctions/common/services/accountQueryService.js`，集中处理权限、金额兼容、状态、稳定分页、关联上限、脱敏和错误映射。
- `adminWebApi` 使用专用 Web projector 和 `GET /accounts`、`GET /accounts/:id`。
- `adminListCustomerAccounts` 与 `adminGetCustomerAccountDetail` 变为兼容适配器，保留既有参数、权限语义和 `{ok,data}` 外层结构。
- Web 增加独立 Zod contract、严格 transport 和专用只读详情页。

不直接复用 `getAccountSummary`，因为普通用户读取会触发重算写入；不直接复用旧详情返回，因为它会透传原始订单、付款记录和流水，可能包含 openid、完整手机号/地址、凭证地址、交易号、操作人标识和内部备注。

## 3. 权威数据与金额口径

- `customer_accounts`：账款物化汇总，是列表和详情摘要的权威来源。
- `account_logs`：追加式账款流水，只用于展示受限历史，不反向重算摘要。
- `orders`：关联订单号、订单状态、付款状态和金额快照。
- `users`：仅在现有账户记录缺少可展示客户信息时批量补充掩码信息；原始标识和完整手机号永不进入 Web DTO。

金额字段统一为安全整数分。优先使用当前字段：

- 应收：`totalOrderAmount`，旧数据回退 `totalReceivableAmount`。
- 已收：`totalPaidAmount`，旧数据回退 `paidAmount`。
- 未收：`totalUnpaidAmount`，旧数据回退 `unpaidAmount`。
- 待确认：`pendingConfirmAmount`。

若字段存在但不是安全整数、为负数，返回安全的数据异常错误，不把脏值默认为 0。不得在前端用“应收 - 已收”覆盖服务端物化值。

## 4. 权限与字段边界

### 4.1 Web 访问矩阵

| 角色 | 列表/详情 | 金额 | 账款流水 | 完整手机号/地址 | 风险/内部备注 |
| --- | --- | --- | --- | --- | --- |
| `super_admin` | 允许 | 允许 | 允许 | 不在本切片返回 | 不返回 |
| `finance` | 允许 | 允许 | 允许 | 不返回 | 不返回 |
| `customer_service` | 拒绝 | 不返回 | 不返回 | 不返回 | 不返回 |
| `procurement` | 拒绝 | 不返回 | 不返回 | 不返回 | 不返回 |
| 普通用户/无效管理员 | 拒绝 | 不返回 | 不返回 | 不返回 | 不返回 |

Web 还必须显式具备 `customer:view_account`。`customer:view_basic`、菜单可见性或前端传入 role 均不能替代服务端权限。

### 4.2 Web 永不返回的字段

- 任意 `openid`、`userId`、`operatorId`、`createdBy`、`updatedBy`
- 完整手机号、完整地址、地址快照
- `paymentScreenshotUrl`、`screenshotUrls`、云文件 ID
- 微信/银行交易号、银行卡号、退款账户
- `adminRemark`、`adminNote`、管理员标签、客户风险等级及风险原因
- `idempotencyKey`、`businessKey`
- 原始 `beforeData`、`afterData`

所有 `*Masked` 手机字段仍须重新脱敏，防止历史脏值中存放完整号码；流水安全摘要再次清除手机号序列。

## 5. 状态、搜索与分页

Web 筛选只支持：

- `unpaid`：权威未收字段大于 0。
- `pending_confirm`：`pendingConfirmAmount > 0`。
- `abnormal`：`abnormalCount > 0`。
- `settled`：`isSettled === true`。

暂不提供“逾期”，因为项目没有稳定账期/到期日规则；也不把客户风险等级混入财务状态。

列表按 `updatedAt DESC, _id DESC` 排序，cursor 是绑定 `status + search + pageSize` 的 opaque 高水位；非法、超长或跨筛选复用返回 400。不得使用 `skip` 作为真实翻页边界。

搜索最长 80 字符，只查询账户内已有的 `nickname/customerName/phoneMasked` 白名单字段；不允许 Web 用完整手机号、openid、内部备注或标签搜索。页面文案必须与实际支持字段一致。

## 6. API 合同

### 6.1 `GET /accounts`

列表 DTO：

```text
items[]:
  id
  customerMasked
  totalOrders
  receivableCents
  receivedCents
  unpaidAmountCents
  pendingConfirmAmountCents
  abnormalCount
  status                  // unpaid | pending_confirm | abnormal | settled
  lastOrderAt
  lastPaymentAt
  updatedAt
nextCursor
```

主集合缺失、索引缺失或查询失败返回安全 503，不能伪装成空数据；集合存在且确实无记录时返回空列表。

### 6.2 `GET /accounts/:id`

详情 DTO：

```text
account:
  列表全部字段

orders[]:
  id, orderNo, status, paymentStatus, totalAmountCents, createdAt

logs[]:
  id, changeType
  beforeReceivableCents, afterReceivableCents
  beforeReceivedCents, afterReceivedCents
  beforeUnpaidCents, afterUnpaidCents
  changeAmountCents
  orderNo, createdAt, summary

ordersHasMore
logsHasMore
relatedDataStatus: complete | partial
warnings[]
```

关联订单最多读取 51 条并返回前 50 条；账款流水最多读取 101 条并返回前 100 条。关联集合缺失或部分关联失败返回 `partial` 和固定安全警告；主账户不存在返回 `404 ACCOUNT_NOT_FOUND`。

## 7. Web 页面

- `/accounts` 保留现有高密度表格布局。
- 状态筛选改为“全部、未结清、待确认、异常、已结清”，移除无权威规则的“逾期/关注”。
- 增加待确认金额、最近订单和最近付款时间列；小屏继续使用已有横向表格容器，不允许页面级横向溢出。
- 通用 Drawer 只显示安全列表概要，并提供“打开详情页”。
- 新增 `/accounts/:id` 与 `AccountDetailView.vue`，包含 skeleton、成功、空关联、partial、404、503 重试和同步刷新状态。
- 详情页只读，不出现重算、修改、结清、导出或付款操作。
- Real 模式导出及所有账款/付款写按钮继续禁用；Mock 也不得模拟可误认为真实入账的写行为。

## 8. 小程序兼容

- `adminListCustomerAccounts` 保留既有 `filter/keyword/sortBy/page/pageSize` 参数和 `{accounts,page,pageSize,hasMore,total}` 结构。
- `adminGetCustomerAccountDetail` 保留通过 `accountId/userId/userOpenid` 定位账户和 `{account,orders,paymentRecords,accountLogs}` 结构。
- legacy projector 按旧权限继续脱敏，不将 Web 更严格 DTO 强行套给小程序，也不扩大旧角色权限。
- 旧入口不得新增重算、集合创建或业务写入。
- 兼容测试必须固定 wrapper 名称、权限和主要返回键，避免小程序页面回归。

## 9. 测试与验收

- canonical：finance/super_admin 允许，customer_service/procurement/无效管理员拒绝；金额新字段优先、旧字段回退、脏值拒绝；四种状态；稳定 cursor；敏感字段剥离；关联上限/partial；缺集合和索引安全错误。
- legacy：列表/详情参数、权限与外层合同保持兼容，原始敏感字段不因适配而扩大。
- BFF：只有专用 `/accounts` 与 `/accounts/:id` 使用 canonical 服务；写/导出继续 fail closed。
- Web：严格 Zod 拒绝额外字段、完整手机号、地址、凭证 URL、交易号、openid、内部备注；Mock/HTTP 搜索、筛选、权限一致。
- UI：列表 loading/empty/error/retry，详情 skeleton/success/partial/404/503；390/1024/1280 无页面级横向溢出。
- 回归：全量云函数测试、Web 测试、TypeScript、ESLint、Mock/Real build、Real 资产扫描、JS 语法、JSON、UTF-8。
- 独立安全审查不得有 P0/P1。

## 10. 部署和索引边界

测试环境候选索引：

- `customer_accounts(updatedAt DESC, _id DESC)`
- `customer_accounts(isSettled, updatedAt DESC, _id DESC)`
- `customer_accounts(pendingConfirmAmount, updatedAt DESC, _id DESC)`
- `customer_accounts(abnormalCount, updatedAt DESC, _id DESC)`
- `account_logs(userId, createdAt DESC, _id DESC)` 与兼容 `userOpenid`
- `orders(userId, createdAt DESC, _id DESC)` 与兼容 `userOpenid`

索引仅记录建议，不在本切片创建或验证。未经明确确认，不上传云函数、不部署 Web、不发布小程序、不连接生产环境、不执行真实数据写入。

## 11. 完成条件

本切片本地完成需同时满足：canonical 服务与旧入口兼容、BFF 专用路由、严格 Web DTO、列表/详情 UI、全量回归、浏览器验证、独立安全审查和 guarded 包门禁。真实 CloudBase、索引与双端验证仍是部署阶段独立条件，不能用本地测试替代。
