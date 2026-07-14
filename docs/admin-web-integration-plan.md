# 网页后台真实数据接入计划

> **2026-07-13 付款与账款只读进度：** 第四批已本地完成 canonical `accountQueryService`/`paymentQueryService`、账款旧入口兼容 adapters、BFF `GET /accounts`、`GET /accounts/:id`、`GET /payments` 与 `GET /payments/:id`、严格 Web DTO、Mock/HTTP 筛选和只读详情页。账款重算、修改、结清、导出、付款确认/驳回及凭证预览继续关闭。当前 16 函数 local-only 保护包 `.codex-cloudfunction-deploy/admin-web-seventeen-functions-guarded-20260713-202500/` 包含 16 个函数、149 个 JS、25 个 JSON、0 个禁止目录，`uploadPerformed=false`；真实 CloudBase 查询、索引、上传、部署和双端验证均未执行。

> **2026-07-13 合并发货单只读进度：** 第三批已本地完成 canonical `shipmentQueryService`、`shipmentGroups` legacy read adapters、BFF `GET /shipments` 与 `GET /shipments/:id`、严格 Web DTO、Mock/HTTP cursor、合并发货单列表和专用只读详情页。该范围不含单订单发货；所有发货写操作和导出在 Real 模式均保持关闭，`merge/ship/edit` 返回 501，未登记的 `cancel/complete/export` 返回 404。该切片使用 14 函数历史保护包，当前候选已扩展为上方 16 函数包；真实 CloudBase 查询、索引、上传、部署与双端验证均未执行。

> **2026-07-13 订单进度：** 订单列表/详情和审核/驳回已分别收口到 canonical `orderQueryService`、`orderReviewService`，旧小程序入口保持兼容。订单备注、Web 取消、发货等剩余动作尚未形成完整闭环。

> **2026-07-12 库存写切片历史：** 第二批已本地完成 Web 行级人工库存调整等能力；当时的十一函数 guarded 包现已过期。真实 CloudBase 事务、索引和双端同步仍需批准后验证。

> **2026-07-12 商品写切片历史：** 第二批已在本地增加商品详情、新建和 metadata-only 编辑，并把 `manageProduct.create/update` 收口到同一 `productWriteService`。Web 编辑不拥有售价、库存、预警、上下架或标签字段；当前小程序商品页已传 `expectedVersion` 和稳定 `Idempotency-Key`，adapter 仍允许真正旧客户端缺失以保持兼容。新增部署前置为 `system_counters/product_index` 的审批、预置和 `products.productIndex` 唯一性审计。当时的 `admin-web-ten-functions-guarded-20260712-191343` 已过期，不能作为当前部署候选。

> 创建：2026-07-11  
> 当前阶段：第一、二轮本地基础设施完成；第三轮已完成受控商品/库存写、商品分析、订单列表/详情与审核/驳回、合并发货单列表/只读详情；第四轮已完成付款记录与客户账款安全只读本地实现，付款写入、售后退款和财务写入仍未完成。本文不代表云函数已上传、Web 已部署或真实双端测试已通过。

## 1. 目标与环境结论

网页版后台保留现有 Vue 3 UI，通过受认证的 Web BFF 访问微信小程序同一套 CloudBase 业务集合和服务端规则，不建立第二套业务数据库。

项目当前可确认的小程序云环境 ID 为 `cloud1-d7g4mbc5r2fac4a77`，来源是 `miniprogram/app.js`。网页版不得继续在代码中硬编码环境，接入后使用：

```text
VITE_DATA_MODE=real
VITE_APP_ENV=test
VITE_CLOUDBASE_ENV_ID=cloud1-d7g4mbc5r2fac4a77
VITE_API_BASE_URL=<测试环境同源 /api/admin/v1 或 HTTPS BFF 地址>
VITE_REALTIME_MODE=polling
```

`VITE_*` 只保存公开客户端配置，不能包含 token、pepper、Cookie secret、数据库凭据或云函数管理密钥。

## 2. 当前 Mock 页面清单

当前全局 transport 由 `admin-web/src/config/env.ts` 和构建别名决定。默认命令固定使用 `test + real` 和 `HttpBffTransport`；`MockTransport` 只在显式 `dev:mock` / `build:mock` 中启用。详细文件和字段证据见 `docs/admin-web-data-audit.md`。

| 页面/模块 | 当前 Mock 来源 | 真实接入目标 |
| --- | --- | --- |
| 登录/角色 | `MockTransport.login`、演示账号下拉 | `adminWebAuth` + `admin_users` |
| 工作台 | `MockTransport.getDashboard` 假统计/趋势/热销 | `adminWebApi/dashboard` + 真实聚合 |
| 商品/库存/预警 | `mock-data.ts` | `products`、`inventory_logs`、真实投影 |
| 报价/库存导入 | `ImportView` 静态预览 | 现有上传、解析、确认导入服务 |
| 订单/付款/账款/发货/售后/退款 | `mock-data.ts` | 对应业务集合与共享服务 |
| 商品分析 | `MockTransport.getProductAnalytics` 公式生成 | Web `adminWebApi -> productAnalyticsQueryService.getOverview()`；小程序 `adminDashboard -> getProductDetail()` |
| 管理员/日志/设置 | `mock-data.ts` 或组件临时状态 | `admin_users`、`admin_operation_logs`、`getSettings/updateSettings` |
| 同步 | `MockTransport.catchUp` 人造事件 | `getSyncEvents` + `sync_events`/collection fallback |

真实模式请求失败时只显示错误、重试和旧缓存，不允许回退或混入 Mock 数据。

## 3. 真实接口映射

完整代码证据和集合命名差异见 `docs/admin-web-api-mapping.md`。当前主路径如下：

| Web 模块 | 真实读取 | 真实写入/共享规则 |
| --- | --- | --- |
| 认证 | `adminWebAuth` profile/refresh | login/logout/revoke/credential bootstrap |
| 工作台 | `adminWebApi/dashboard` | 无前端写入 |
| 商品 | `products` 最小投影；售价只读 `products.price`，DTO 含 `isActive`，公开标签只投影 `新货/瑕疵/热销` | create 和 metadata-only edit 走 `productWriteService`；改价走 `productPriceService`；上下架走 `productStatusService`；公开标签走 `productTagService`；库存与预警仍由专用服务维护 |
| 库存 | `products` 库存投影、`getInventoryLogs/getStockAlerts` | `updateProductWarningStock`、库存调整与导入确认服务 |
| 订单 | `getOrders`/订单详情投影 | `adminReviewOrder`、订单拒绝/备注/既有取消规则 |
| 付款 | `payment_records`/付款详情投影 | `adminUpdatePayment`/`confirmPayment`/驳回服务 |
| 账款 | `adminListCustomerAccounts`、detail/summary | 仅复用既有账款聚合与受控操作 |
| 发货 | `getAdminShipmentGroups`/detail | `shipmentGroups`、确认/合并/取消/完成服务 |
| 售后退款 | `afterSales` 聚合 action | review/验收/refund 既有事务与幂等服务 |
| 分析 | Web `GET /analytics/products -> adminWebApi -> getOverview()`；小程序 `adminDashboard:getProductAnalytics -> getProductDetail()` | 共用 canonical 查询服务，只返回聚合/商品投影，不返回订单、客户、操作者或原始日志 |
| 管理员/日志 | `getAdminUsers/getAdminOperationLogs` | 既有角色/禁用服务，仍以 `admin_users` 为权威 |
| 设置 | `settings` 集合固定文档 `_id=system_settings` | `getSettings/updateSettings`；BFF 固定文档映射已修正，写入仍未迁移 |
| 同步 | `getSyncEvents` 或 BFF `/sync/events` | 只失效缓存，不执行业务写 |

浏览器不能直接调用依赖 `WXContext.OPENID` 的旧写入口。共享 service 需接收服务端解析的 actor：小程序 actor 来自 WXContext，Web actor 来自可吊销会话。

## 4. 接入顺序

### 第一批：基础设施

1. 新增 `VITE_DATA_MODE` 与 `VITE_CLOUDBASE_ENV_ID`，正式/测试构建默认 `real`。
2. Mock 仅在显式 `dev:mock`/组件测试模式启用。
3. 完善真实 API client、401 refresh、403、取消请求、错误归一和连接状态。
4. 验证 `adminWebAuth`、`adminWebApi` 的测试 HTTPS/同源网关；未配置网关时显示明确连接错误。

真实测试环境接入前，认证还必须完成以下安全门槛：

- `test/staging/production` 缺少 pepper、精确 Origin 或 action secret 时 fail closed；只有显式 local/unit-test 可使用测试默认值。
- 非 HTTP Action 的无 secret 放行只能由本地开关显式启用，`ADMIN_WEB_ALLOW_TEST_ACTION_TRANSPORT=false` 必须实际生效。
- 前端所有请求共用 refresh single-flight，避免并发 401 触发 refresh 重放并撤销自身会话。
- refresh 最终失败时清 access/CSRF/profile、停止同步并进入登录；mutation 也只允许刷新一次。
- revoke 和后续所有 Web mutation 校验 CSRF；Origin、Bearer 和 CSRF 共同形成边界。
- 远程环境 bootstrap secret 至少 32 字符，凭证初始化完成后立即关闭 bootstrap。

以上门槛已完成本地实现和自动化复审；真实网关的 secret/Origin 注入、HTTPS Cookie、CloudBase 事务冲突和索引仍必须在隔离测试环境验证后才能标记部署通过。

### 第二批：商品、库存、导入、分析

先完成真实只读，再逐个迁移低风险写服务。改价必须写项目现有 `price_logs`（需求术语中的 `product_price_logs`，不得新建平行集合），库存调整必须写 `inventory_logs`，导入继续使用幂等记录。

首个写切片是单商品预警阈值：`inventory/set-warning` 与 `inventory-alerts/set-warning` 共用 `inventoryWarningService`，旧 `updateProductWarningStock` 保持薄适配器。Web 必须提交 `expectedVersion`、`expectedWarningThreshold` 和 header 幂等键；服务在同一事务写商品、预警记录、库存日志和最小 outbox。

单商品改价已完成本地实现：Web 仅开放 `products/change-price`，请求合同为 `id/newPriceCents/expectedPriceCents/expectedVersion/reason`。active `procurement/super_admin` 还需满足 `product:update_price`，并通过 CSRF 与 `Idempotency-Key`。canonical `productPriceService` 以 `products.price` 的整数分为权威，在同一事务更新价格和 version、写 `price_logs` 与最小 `sync_events`；相同售价不递增版本、不写日志或事件。旧 `updateProductPrice` 只作为小程序薄适配器，保持旧参数和返回兼容。

单商品显式上下架已完成本地实现并通过回归：Web 开放 `products/toggle-status`，请求为 `id/isActive/expectedIsActive/expectedVersion/reason`，要求 `product:update_status`、CSRF 和 `Idempotency-Key`。canonical `productStatusService` 显式 set，不读取后 toggle；商品、`admin_operation_logs` 和 `sync_events` 同事务，目标状态与当前一致时零写入。`manageProduct/delete` 与 `getUnsoldProducts/deactivate` 已改为薄适配器。

显式批量上架已完成本地实现并通过回归：Web `POST /products/batch-enable` 固定 `isActive=true`，严格接收最多 100 个原始 `items[{id,expectedIsActive,expectedVersion}]`，并在去重前执行原始数量上限。该入口强制 session、`product:update_status`、CSRF 和 `Idempotency-Key`；canonical service 按商品逐项事务、允许部分成功，只返回安全计数及 `{id,code}` 失败项。每个实际变化商品同事务写 `products/admin_operation_logs/sync_events`，no-op 零业务写；同 key 异 payload 只返回冲突，不覆盖原成功或处理中幂等记录。小程序 `manageProduct.bulkActivate` 已改为同一 service 的兼容薄适配器。create/metadata edit 已由后续 `productWriteService` 切片迁移；独立 `updateProductTags` 与缺货自动下架仍是未统一路径。

批量公开标签已完成本地实现并通过回归：Web `POST /products/batch-tags` 只接受 `scope=public`、`tag=新货/瑕疵/热销`、显式 `present` 和最多 100 个原始 `items[{id,expectedVersion,expectedPresent}]`。权限、CSRF 与 header `Idempotency-Key` 在业务字段校验前生效；内部标签、自由文本、完整标签替换、flags、瑕疵说明及价格/库存/状态字段均被拒绝。canonical `productTagService` 逐项事务写 `products/product_tag_logs/admin_operation_logs/sync_events`；严格公开模式只更新 `tags/isNew/isDefective/isHot/tagUpdatedAt/tagUpdatedBy/updatedAt/version/searchText`，保留 `internalTags/isFrequent/defectDescription` 原值并将其排除在 change detection 之外，异常内部标签不阻断公开写，no-op 零业务写。失败只返回安全 `{id,code}`，Web failure code 和嵌套字段严格校验。旧 `batchUpdateProductTags` 保留公开/内部标签，200 项上限按清洗去重后的唯一商品数计算；Web 仍按原始最多 100 项计算。`updateProductTags` 与完整商品保存本切片不迁移。

兼容限制：旧 `batchUpdateWarningStock`、`manageProduct`、旧库存导入等入口尚未统一递增 version。本切片用原阈值比较防止 Web 静默覆盖先发生的旧写入；彻底消除旧整商品快照在 Web 成功后的反向覆盖，需要后续把所有 `warningStock` writer 迁移到 canonical service/统一版本守卫。

商品分析只读接入已完成本地实现：上海时区边界，Web 7/30/90 天和前一等长周期环比，全额退款订单排除、部分退款不冲减，真实 `price_logs/inventory_logs`，`createdAt + _id` 稳定游标和扫描安全上限。单品详情仅扫描当前周期；同一库存防重键出现冲突内容时返回 `422 ANALYTICS_DATA_INVALID`，集合缺失、超限或查询异常返回安全的 503，不生成假历史。Web DTO 会严格拒绝损坏数组、日期和非安全整数，并在页面可见且空闲时每 60 秒静默兜底刷新。

### 第三批：订单与发货

订单列表/详情已迁移到 canonical `orderQueryService`；审核/驳回已迁移到 canonical `orderReviewService` 并保留旧小程序入口兼容。订单备注、Web 取消等后续动作仍只适配 actor，不改变状态机、扣/还库存时机或幂等语义。`cancelOrder` 已在本地改为事务内按扣减流水原子回补，且账款重算失败可持久化并在重试时再次执行；开放 Web 取消前仍必须完成真实 CloudBase 和小程序回归。

合并发货单读取已迁移到 canonical `shipmentQueryService`：Web 和 `shipmentGroups` legacy read actions 共用查询服务；BFF 提供专用列表/详情，Web 只消费严格 DTO，并按 `updatedAt + _id` 使用稳定游标。当前页面只代表 `shipment_groups` 合并发货单，不包含单订单发货；创建、确认、物流编辑在 Real 模式返回 501，未登记的取消、完成、导出返回 404。后续迁移写服务时必须继续保留付款前置、地址一致性、状态守卫、订单联动、日志和幂等语义。

客户账款读取已迁移到 canonical `accountQueryService`：Web 和两个旧小程序账款入口共用查询服务；BFF 专用列表/详情使用 `updatedAt + _id` 稳定游标、整数分和严格脱敏 DTO。Web 只允许 active `finance/super_admin` 且具 `customer:view_account`；不调用重算，不开放修改、结清、导出或付款操作。详情的订单/流水有硬上限，缺失关联只返回固定 partial 警告。

### 第四批：付款、账款、售后退款

最后迁移财务和退款入口。财务不能审核售后，退款不能超过已付款金额和 `approvedRefundAmount`，重复请求不能重复入账或恢复库存。

## 5. 权限要求

- `user`：不能建立 Web 会话或调用管理员 API。
- `customer_service`：订单、脱敏客户、发货、售后；不能确认付款或最终退款。
- `finance`：付款、账款、对账、已审核退款；不能商品/库存写或售后审核。
- `procurement`：商品、库存、导入、标签、推荐、商品分析；不得返回付款、退款、账款或完整客户信息。Web 商品分析只允许该角色和 `super_admin`，仍需 `product:analytics:view`。
- `super_admin`：完整合法后台，但不能绕过状态机、金额上限、库存事务和幂等。

菜单、路由和按钮只改善体验；每个 BFF handler 必须重新读取 `admin_users` 并按固定 `resource + action -> permission` 校验。

商品分析另有字段级边界：Web 销售额摘要仅 `super_admin` 可见，日库存变化仍要求 `inventory:view`。小程序 `adminDashboard` 继续使用既有 `product:analytics:view` / `dashboard:view_product` 可分配权限，不把 Web 的硬角色限制反向套到旧小程序流程。

## 6. 实时同步要求

- 事件只含最小标识、version 和安全字段名，不携带业务敏感值。
- 收到事件后失效对应缓存，并按权限重新获取真实数据。
- Web 前台目标 1-3 秒；后台/断网使用退避和 cursor 补拉。
- 事件不得触发同一业务写，避免同步循环。
- 所有关键写入口最终在业务事务内写 outbox；当前 collection fallback 仅是兼容通知源。
- 真实双端结果记录在 `docs/admin-web-realtime-test.md`，没有证据时状态保持“未执行”。

## 7. 需要新增或调整的后端能力

### 当前测试部署目标（A-Z）

- `adminDashboard`（小程序商品分析 adapter）
- `adminWebApi`
- `adminWebAuth`
- `batchUpdateProductTags`（批量标签共享 service 的旧入口适配器）
- `cleanupSyncEvents`
- `getSyncEvents`
- `getUnsoldProducts`（显式 `deactivate` 的旧入口适配器）
- `manageProduct`（显式 `delete` 与 `bulkActivate` 的旧入口适配器）
- `updateProductPrice`（单商品改价共享 service 的旧入口适配器）
- `updateProductWarningStock`（单商品预警值共享 service 的旧入口适配器）

该段记录的是 2026-07-12 历史验证与已过期十一函数包；当前候选范围、最终 local-only 保护包和最终本地回归结果以文首 2026-07-13 合并发货单只读进度为准。实际上传仍需用户明确确认隔离测试环境和范围。

### 当前不新增平行业务云函数

优先把既有业务入口的核心逻辑抽成 `cloudfunctions/common/services/` 可复用 service，并由小程序旧入口与 Web BFF 共用。只有现有聚合入口无法安全承载时，才新增薄适配函数；不得复制库存、付款或退款逻辑。

### 需要修改的范围

- `adminWebApi`：商品分析已接入 canonical `getOverview()`；单商品改价、显式 `products/toggle-status`、显式 `products/batch-enable`、显式 `products/batch-tags` 和两个预警值动作已接入共享 service。其余 mutation 从 501 边界逐模块迁移。
- `adminDashboard`：商品分析 action 已接入 canonical `getProductDetail()`，保留小程序现有权限语义和响应兼容。
- `batchUpdateProductTags`、`updateProductPrice`、`updateProductWarningStock`：保留旧调用参数/返回的薄适配器。
- `manageProduct/create`、`manageProduct.update`：已成为 `productWriteService` 兼容适配器；旧客户端仍可缺少版本/幂等字段。`delete`、`bulkActivate`、`getUnsoldProducts/deactivate` 继续为显式状态 service 适配器；缺货自动下架仍需单独审计。
- `adminWebAuth`：若审计发现缺口，只做最小安全修复。
- `getSyncEvents`/小程序同步层：按真实事件来源补齐 topic 与失效映射。

第一轮还确认了两项复用前置：`getAdminDashboardStats` 的缓存键必须加入角色/权限指纹或改为缓存原始聚合后逐请求投影，避免跨角色复用已投影结果；`admin_operation_logs` 的 Web 查询必须增加职责域行级过滤，不能只依赖安全摘要字段。

## 8. 数据库集合与索引建议

认证/同步基础集合：`admin_web_credentials`、`admin_web_sessions`、`admin_login_attempts`、`admin_security_logs`、`sync_events`。这些不是第二套业务数据库。

部署前只读盘点并按实际查询计划评审：

- `admin_web_credentials(loginIdHash, status)`
- `admin_web_credentials(adminId, status)`：凭证初始化和轮换的管理员唯一 active credential 检查；必须先在隔离测试环境确认查询计划
- `admin_web_sessions(accessTokenHash)`、`(refreshTokenHash)`、`(adminId, lastActivityAt DESC)`
- `sync_events(createdAt ASC, _id ASC)`、`(expiresAt ASC)`、必要的 entity/owner 复合索引
- `products(updatedAt, _id)`、状态/搜索字段索引
- `orders(status, createdAt, _id)`
- `payment_records(paymentStatus, createdAt, _id)`
- `shipment_groups(shippingStatus, updatedAt, _id)`
- `after_sales(afterSaleStatus, createdAt, _id)`
- `refund_records(refundStatus, updatedAt, _id)`
- 分析查询所需 `order_items/productId/createdAt`、价格日志和库存日志时间索引

不能未经测试环境确认直接创建或修改索引。

## 9. 风险与回滚

| 风险 | 控制与回滚 |
| --- | --- |
| 默认 Mock 混入真实页面 | `VITE_DATA_MODE` 单一选择；真实模式禁止 fallback；回滚到上一 Web 静态包 |
| BFF 网关/会话未配置 | fail closed；不开放浏览器数据库权限；回滚网关和十个目标云函数 |
| 并发 refresh 误判重放 | 单飞 refresh + 并发 401 自动化测试；失败统一退出 |
| 测试环境使用固定安全默认值 | test 与 staging/production 同样强制 secret/origin，禁止默认 pepper |
| 旧 OPENID 入口被 Web 伪造 | Web 只传业务参数，actor 由会话解析；未知调用拒绝 |
| 写服务迁移破坏旧流程 | 单模块迁移、旧入口 contract 回归、保留上版云函数包 |
| legacy 商品整对象写并发覆盖 | Web 仅允许 metadata patch 并要求 `expectedVersion`；`manageProduct.update` 已收口但旧客户端不强制版本/幂等，缺货自动下架也仍需单独审计 |
| outbox 不完整 | 不宣称实时通过；事件失败不伪造业务成功；按模块回滚 |
| 敏感字段泄漏 | 服务端 DTO 白名单、角色矩阵测试、日志脱敏 |
| 独立 `getProductAnalytics` 仍合成 `current_product` 报价点 | 将其登记为 legacy，不纳入本轮十函数目标清单；当前小程序源码继续走 `adminDashboard` canonical 入口，后续单独迁移/下线 |
| `cancelOrder` 真实环境未验收 | 本地已补齐事务回补、幂等证据和失败可观测；真实 CloudBase 与双端验证通过前仍不开放 Web 取消 |

完整测试部署和不删除数据的回滚步骤见 `docs/web-admin-test-deployment-and-rollback.md`。
