# 网页后台合并发货单只读接入设计

## 1. 目标与范围

本切片把网页版 `/shipments` 从通用 `shipment_groups` 单集合投影升级为真实、严格、可审计的“合并发货单列表 + 专用详情”。网页和小程序继续读取同一组 CloudBase 集合，并复用同一个 canonical 查询服务。

本切片只做读取，不开放任何发货写操作。Real 模式下以下按钮继续保持禁用：合并发货、合并所选、确认发货、物流信息、取消发货单、完成发货和导出。

本切片不包含单订单发货。`shipment_groups` 只代表合并发货单，页面标题和说明必须明确这一点，不能把当前列表描述成完整待发货订单工作台。单订单发货将在后续独立切片中接入 `orders`、`delivery_logs` 和 `shipment_logs`。

## 2. 方案选择

采用“canonical 查询服务 + 双端适配器 + Web 严格 DTO”方案：

- 新增 `cloudfunctions/common/services/shipmentQueryService.js`，集中处理权限、状态、分页、关联查询、脱敏和读取上限。
- `adminWebApi` 只调用 Web projector，返回严格白名单 DTO。
- 小程序 `shipmentGroups` 的两个读取 action 改为兼容适配器，保持现有 `{groups, hasMore}` 与详情返回结构，不改变写 action。
- Web 增加独立 contract parser 和专用详情页。

不选择直接调用旧 `getShipmentGroupDetail`，因为它会返回原始 group、items 和 logs，包含内部标识、幂等字段、操作人、原始 before/after、完整地址、运单和备注。也不选择只扩展当前 BFF 通用 projector，因为它无法安全表达关联订单、商品汇总和日志。

## 3. 数据来源

### 3.1 主记录

`shipment_groups` 是合并发货单主记录，权威状态为：

- `created`
- `pending_shipment`
- `shipped`
- `completed`
- `cancelled`
- `abnormal`

### 3.2 关联数据

- `orders`：关联订单状态、付款状态、下单时间和按权限投影的金额。
- `shipment_group_items`：发货时商品快照，用于商品数量汇总；不作为库存、售价或账款权威来源。
- `shipment_logs`：发货操作流水，只返回安全摘要，不返回原始操作人标识和 before/after 数据。

### 3.3 单订单发货边界

未进入 `shipment_groups` 的单订单发货状态仍在 `orders`，本切片不把它们混入合并发货单列表。页面提供清晰说明，避免管理员误认为当前列表覆盖全部待发货订单。

## 4. 权限与字段边界

### 4.1 访问矩阵

| 角色 | 列表/基础详情 | 地址 | 客户信息 | 金额 | 运单 |
| --- | --- | --- | --- | --- | --- |
| `super_admin` | 允许 | 仅具 `shipment:view_address_full` 时完整 | 脱敏手机号；本切片不新增完整手机号 | 允许 | 完整 |
| `customer_service` | 允许 | 脱敏 | 脱敏 | 不返回 | 具 `shipment:update` 或 `shipment:ship` 时详情可完整，列表仍脱敏 |
| `finance` | 允许 | 仅脱敏 | 脱敏 | 允许 | 脱敏 |
| `procurement` | 默认拒绝 | 不返回 | 不返回 | 不返回 | 不返回 |
| 普通用户/无效管理员 | 拒绝 | 不返回 | 不返回 | 不返回 | 不返回 |

Web 发货地址只认 `shipment:view_address_full`，不得使用通用 `customer:view_address_full` 自动升级权限，避免财务看到完整收货地址。采购可见性以当前更严格的权限代码为准，不因旧文档描述而放宽。

### 4.2 永不返回的字段

- `openid`、`userId`
- `idempotencyKey`、`businessKey`
- `operatorOpenid`、原始 `operatorId`
- `createdBy`、`updatedBy`、`shippedBy`、`cancelledBy`
- 原始 `beforeData`、`afterData`
- 列表中的完整 `orderIds`
- `shippingAddressSnapshot`
- 未授权的原始 `trackingNo`、`trackingNoList`
- `shipmentImages` 云文件 ID
- 未授权的 `adminRemark`、`cancelReason` 和日志 `remark`
- `shipment_group_items.unitPrice`、`subtotal` 和原始 `tags`

## 5. API 合同

### 5.1 列表

`GET /shipments`

查询参数：

- `pageSize`：默认 20，最大 100。
- `cursor`：服务端生成的 opaque cursor，包含 `updatedAt + _id` 高水位。
- `status`：只能是六个权威状态之一或空值。
- `search`：最长 100；本切片支持完整发货单号、完整订单号或完整运单号匹配。UI 占位文案必须明确“输入完整编号”，不承诺未建立索引的任意模糊搜索。

列表按 `updatedAt DESC, _id DESC` 稳定排序。不得使用 `skip` 作为实际翻页边界。集合缺失、查询失败或索引缺失必须返回安全的 503，不能伪装成空列表。

列表 DTO：

```text
id
shipmentNo
status
orderCount
totalItemCount
customerMasked
carrier
trackingMasked
addressConsistent
orderNosPreview      // 最多 3 个
createdAt
updatedAt
shippedAt
completedAt
version              // 旧记录允许 0，仅用于展示，不代表写并发保护已完成
totalOrderAmountCents // 仅具金额权限时存在
```

### 5.2 详情

`GET /shipments/:id`

详情 DTO：

```text
shipment:
  id, shipmentNo, status, version
  orderCount, totalItemCount, totalProductCount
  customerMasked
  shippingAddressMasked 或 shippingAddress
  carrier
  trackingMasked 或 trackingNo
  addressConsistent
  createdAt, updatedAt, shippedAt, completedAt, cancelledAt
  adminRemark/cancelReason（仅具对应发货操作权限）
  totalOrderAmountCents/totalPaidAmountCents/totalUnpaidAmountCents（仅金额权限）

orders[]:
  id, orderNo, status, paymentStatus, shippingStatus, createdAt
  totalAmountCents（仅金额权限）

itemSummary[]:
  productId, productName, brand, category, specification, productionDate
  totalQuantity, orderNos

logs[]:
  id, action, operatorRole, createdAt
  remark（仅具对应发货操作权限，且再次清除手机号序列）

logsHasMore
relatedDataStatus: complete | partial
warnings[] // 只含固定安全文案，不含内部 ID
```

不存在的发货单返回 `404 SHIPMENT_NOT_FOUND`。数据库、索引或关联查询失败返回安全 `503 SHIPMENT_READ_FAILED`。

关联读取上限：

- 订单最多 100；超过时 fail closed。
- 商品快照最多读取 500 行；超过时 fail closed，不能返回不完整商品汇总。
- 日志读取最新 101 行，返回前 100 行并用 `logsHasMore` 表示还有记录。
- 关联订单缺失时返回 `relatedDataStatus=partial` 和固定警告，不暴露缺失 ID；主记录仍可查看。

## 6. Web 页面

### 6.1 列表

- `/shipments` 页面标题改为“合并发货单”。
- 说明文字明确“当前仅展示已创建的合并发货单；单订单发货将在后续接入”。
- 状态筛选补齐 `created`、`pending_shipment`、`shipped`、`completed`、`cancelled`、`abnormal`。
- HTTP 与 Mock 都必须经过相同 `ShipmentSummary` parser。
- Mock transport 在 list/get 内部强制检查 `shipment:view`。
- 表格保留 loading、空状态、错误状态和重试。
- 所有写按钮在 Real 模式继续禁用；“合并所选”不能连接到现有 API，因为当前选中的是 shipment group ID，而真实合并接口需要 order ID。

### 6.2 详情

- 新增 `/shipments/:id` 与 `ShipmentDetailView.vue`。
- 路由要求 `shipment:view`。
- 列表 Drawer 只显示概要，并提供“打开详情页”。
- 详情包含独立 skeleton、404、失败重试、空订单、空商品、空日志和 partial warning 状态。
- 页面只读，不出现保存、发货、合并、完成或导出按钮。
- 同步事件只触发重新读取，不执行任何写操作。

## 7. 小程序兼容

- `getAdminShipmentGroups` 和 `getShipmentGroupDetail` wrapper 名称、参数与 `{ok,data}` 外层结构保持不变。
- `shipmentGroups` 的写 action 完全不动。
- canonical 查询服务返回内部标准模型；legacy projector 继续生成小程序需要的旧字段。
- 旧小程序的完整地址权限语义不在本切片中扩大或收紧；Web projector 使用独立且更严格的权限边界。
- 小程序列表的 `page/pageSize/hasMore` 兼容合同保留，并新增回归测试防止字段丢失。

## 8. 测试与验收

### 8.1 canonical 服务

- 六种状态、权限、稳定游标、完整编号搜索。
- customer_service、finance、super_admin、procurement、无效管理员矩阵。
- 地址、金额、运单、备注和日志分层投影。
- 脏 `*Masked` 字段再次脱敏。
- 订单/商品/日志上限与 partial 数据。
- 数据库、集合和索引错误安全映射。
- legacy list/detail 返回兼容。

### 8.2 BFF/transport

- BFF 只路由 `/shipments` 与 `/shipments/:id` 到 canonical service。
- HTTP parser 拒绝额外字段和原始敏感字段。
- Mock/Real DTO 键一致，Mock 权限与 Real 一致。
- 403 不错误注销会话；404/503 保留安全错误码。
- 真实写路由继续返回 `501 SERVICE_NOT_MIGRATED`。

### 8.3 UI

- 列表状态、完整编号搜索提示、loading/empty/error/retry。
- Drawer 能跳转专用详情页。
- 详情 skeleton、成功、404、503 重试、partial、空关联项。
- 无 `shipment:view` 跳转 403。
- HTTP 模式所有写按钮禁用，详情页不调用 `mutate`。
- 390px、1024px 和 1280px 不出现页面级横向溢出。

### 8.4 回归门禁

- 全量云函数测试。
- 全量 Web 测试、TypeScript、ESLint。
- Mock build、Real/test build 和真实产物文本扫描。
- 所有新增/修改 JS `node --check`，JSON 解析和 UTF-8 replacement-character 扫描。
- 新 guarded 包包含当前 13 函数加 `shipmentGroups`（按最终依赖清单确定），包内 canonical 副本哈希一致，无 tests、无 `node_modules`，`uploadPerformed=false`。

## 9. 索引建议与部署边界

测试环境建议索引：

- `shipment_groups(shippingStatus, updatedAt DESC, _id DESC)`
- `shipment_groups(updatedAt DESC, _id DESC)`
- `shipment_groups(shipmentNo)`
- `shipment_group_items(shipmentGroupId, _id)`
- `shipment_logs(shipmentGroupId, createdAt DESC, _id DESC)`

如完整订单号搜索通过 `orders.mergeShipmentId/orderNo` 解析，还需要对应组合索引。索引必须先在测试环境 dry run/查询计划验证，不能直接改生产。

本设计不授权上传云函数、创建索引、部署 Web、发布小程序或执行真实数据写入。任何测试环境上传仍需用户明确确认。正式发货写切片开始前，必须先统一发货目录的幂等 helper 副本并增加哈希门禁。

## 10. 完成条件

本切片只有在以下条件全部满足时才算本地完成：

1. Web 列表与详情均使用 canonical 查询服务。
2. 小程序两个旧读取入口通过兼容回归。
3. Web DTO 无原始敏感字段。
4. 页面明确只覆盖合并发货单。
5. 所有 Real 写操作保持禁用。
6. 目标测试、全量测试、类型、规范和双构建全部通过。
7. 独立安全审查无 P0/P1。
8. guarded 包门禁通过且明确未上传。

真实 CloudBase、索引和双端验证仍是后续部署阶段的独立完成条件，不能由本地测试替代。
