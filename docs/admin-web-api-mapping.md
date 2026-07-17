# 网页后台 API 与 CloudBase 数据映射审计

> **退款写映射更新（2026-07-18，local-only）：** `POST /refunds/process` 与 `POST /refunds/reject` 已通过 BFF 严格 DTO 接入 canonical `refundMutationService`，小程序 `afterSales` 旧 action 使用同一服务的兼容 adapter；unsupported Web create/WeChat 路由保持 `404 MUTATION_NOT_SUPPORTED`，微信退款入口 fail closed 且零业务写。Web 硬门禁为 active `finance/super_admin` 加 `refund:process`（或 `*`），canonical 状态为 `pending/processing/refunded/partial_refunded/failed/rejected/cancelled`。事务使用 immutable admin journal 与 refund/account/after-sale logs 作为恢复证据，账款重算按 journal owner/version/completion key 重试并 compare-before-clear；同事务写 owner/admin 双 audience 的最小 `sync_events`。
>
> 历史确认退款如缺少 `order_items.refundQuantityAppliedAfterSaleIds` 对当前售后的数量归属，必须先人工对账，服务以 `REFUND_ITEM_QUANTITY_RECONCILIATION_REQUIRED` 零写失败。部署前必须审计五个 partial unique 索引：`admin_operation_logs.businessKey`、`account_logs.businessKey`、`refund_logs.businessKey`、`after_sale_logs.businessKey`、`sync_events.eventId`。当前 19 函数 guarded 包仅为本地候选，真实 CloudBase 事务/索引、Cookie/CSRF BFF、双端同步、1～3 秒延迟、上传、部署和发布均未验证。

> **退货验收更新（2026-07-16）：** `adminWebApi` 的 `POST /after-sales/receive|inspect` 与小程序旧入口已共享 canonical `returnInspectionService`；客服/超级管理员允许，财务/采购硬拒绝。最新本地证据为 Cloud `558/558`、Web `412/412`、TypeScript、ESLint、Mock/Real build、Real 资产扫描和部署包 hash 校验通过；Real/CloudBase 与双端仍未验证。

> **2026-07-16 付款审核映射更新：** `POST /payments/confirm`、`POST /payments/reject` 与 `adminUpdatePayment` 已在本地收口到 canonical `paymentMutationService`；Web 严格请求不含金额、订单 ID、actor/openid、凭证 URL、交易号或账款字段。`paymentQueryService` 只把订单当前 `latestPaymentRecordId` 且订单仍待确认的凭证视为可审核，并返回 `version/updatedAt` 并发快照。Web 写入硬门禁为 active `finance/super_admin` 加精确权限；canonical 事务拥有付款、订单、账款/唯一流水、配送日志、不可变管理员 journal 和最小 outbox，驳回不创建收款流水；旧四类状态、别名和同客户批次语义保持兼容。
>
> **历史候选与部署前置（2026-07-16，已过期）：** 当时 18 函数包只保留付款审核阶段证据，已被顶部 19 函数候选替代且不得部署。真实 CloudBase、索引、上传、部署和真实写入仍未执行。

> **2026-07-13 付款与账款只读切片更新：** `GET /accounts`、`GET /accounts/:id` 与 `GET /payments`、`GET /payments/:id` 已接入 canonical `accountQueryService/paymentQueryService`，复用 `customer_accounts/payment_records` 及受限关联数据，Web 使用严格 DTO、稳定游标、四种权威账款状态和付款状态白名单。旧账款入口保持兼容适配；账款重算、修改、结清、导出、付款确认/驳回及凭证预览继续关闭。最终 16 函数 local-only 保护包 `.codex-cloudfunction-deploy/admin-web-seventeen-functions-guarded-20260713-202500/` 含 149 个 JS、25 个 JSON、0 个禁止目录，`uploadPerformed=false`；真实 CloudBase、索引、上传、部署和双端验证均未执行。

> **2026-07-13 合并发货单查询更新：** `GET /shipments` 与 `GET /shipments/:id` 已从通用单集合读取迁移到 canonical `shipmentQueryService`；`shipmentGroups` 的旧列表/详情 action 同时成为兼容 read adapters。Web 使用严格 DTO、`updatedAt DESC + _id DESC` 游标、精确编号搜索、关联 orders/items/logs 和权限投影；Mock/HTTP cursor、合并发货单列表与专用只读详情页已本地完成。单订单发货未接，所有发货写操作和导出在 Real 模式均保持关闭；已登记的 `merge/ship/edit` 返回 501，未登记的 `cancel/complete/export` 返回 404。最终 14 函数 local-only 保护包为 `.codex-cloudfunction-deploy/admin-web-fourteen-functions-guarded-final-20260713-185637053/`，含 129 个 JS、23 个 JSON、0 个禁止目录，`uploadPerformed=false`；云函数 `392/392`、Web `285/285`、TypeScript、ESLint、Mock/Real 构建和 Real 资产扫描通过。真实 CloudBase 查询、索引、上传、部署与双端验证均未执行。

> **2026-07-13 订单查询/审核更新：** `GET /orders` 与 `GET /orders/:id` 已迁移到 canonical `orderQueryService`，订单审核/驳回也已通过 canonical `orderReviewService` 本地接通并保留旧入口兼容。订单备注、Web 取消等剩余动作仍未完整迁移。

> **2026-07-12 库存写映射历史：** 当时已完成严格库存详情、两个 `adjust` 路由及 `cancelOrder` 回补修复；对应十一函数包现已过期，尚未上传。

> **历史商品写切片记录：** 商品创建/metadata 编辑、`system_counters/product_index` 和唯一性审计要求仍有效；`191343` 十函数包已被上方十一函数包替代。

> 审计日期：2026-07-11  
> 范围：`admin-web/`、`cloudfunctions/`、`cloudfunctions/common/`、`miniprogram/` 的本地代码。  
> 性质：第一轮只读静态审计，第三轮已补充单商品库存预警值、商品改价、商品显式上下架、商品显式批量上架、批量公开标签和商品分析 canonical 服务的本地状态。当前仍未连接云环境、创建集合或索引、写入真实数据、上传云函数、部署 Web 或发布小程序。

## 1. 结论

网页版后台应继续使用小程序现有 CloudBase 业务集合，不得新建平行的商品、订单、库存、付款、账款、发货、售后或退款数据模型。

当前可以确认的实现边界如下：

1. `adminWebAuth` 已提供独立 Web session；`adminWebApi` 已提供基于该 session 的 HTTP 只读 BFF。这两个入口是 Web 可以直接使用的身份和读取入口。
2. `adminWebApi` 当前已本地迁移受控商品写、库存预警/人工调整、订单审核/驳回、当前付款凭证确认/驳回、售后审核、确认退货收货、退货验货和线下退款处理/驳回，以及商品、库存、订单、合并发货单、付款记录专用详情读取。账款结清/导出、凭证预览继续返回 `501 SERVICE_NOT_MIGRATED`；退款 create/WeChat 和发货未支持路由按已登记边界返回 404/501。不能将 Mock 交互视为真实写能力。
3. 商品分析已接入 `cloudfunctions/common/services/productAnalyticsQueryService.js`：Web 的 `GET /analytics/products` 由 `adminWebApi` 调用 `getOverview()`，小程序聚合入口 `adminDashboard -> getProductAnalytics` 调用 `getProductDetail()`。服务按上海时区处理 7/30/90 天及小程序兼容的自定义周期，Web 环比使用前一等长周期；销量和销售额按有效订单快照毛额统计，全额退款订单排除，部分退款暂不冲减。
4. 小程序后台云函数普遍通过 `cloud.getWXContext().OPENID -> admin_users.openid` 鉴权，见 `cloudfunctions/common/auth.js:16-18`、`cloudfunctions/common/auth.js:63-103`。它们不能原样暴露给 Web，也不能由浏览器传入 `openid`、`role` 或 `permissions` 冒充身份。
5. 写能力必须把现有完整事务抽成接受可信 `ActorContext` 的共享 service，再由小程序 WXContext adapter 和 Web session adapter 调用。不得在 BFF 中重写一份简化状态机。
6. `sync_events` 已有读取、清理及单商品预警值、单商品改价、单商品显式上下架、显式批量上架和批量公开标签逐项事务内写入；状态/标签变化与商品及对应业务日志同事务。其他业务入口尚未覆盖，整体仍是 `outbox_with_collection_fallback`，不能声称全业务事务性 outbox 或 1-3 秒双端同步已完成。
7. `adminWebApi` 的 `settings/system` 读取现已映射到 `settings` 集合中 `_id = system_settings` 的固定文档；公开 DTO 的 `id` 固定为 `system`，任意其他 URL ID 和通用 settings 列表枚举均被拒绝。真实模型证据见 `cloudfunctions/getSettings/index.js:15-16`、`cloudfunctions/updateSettings/index.js:164-174`；写入仍为 501。
8. 旧 `batchUpdateWarningStock`、`manageProduct` 和旧库存导入会写 `warningStock` 但不统一递增 version。新 Web service 同时比较 `expectedVersion` 与 `expectedWarningThreshold`，可阻止 Web 覆盖先发生的旧写入；旧整商品快照在 Web 成功后的反向覆盖仍需后续统一迁移所有 writer 才能彻底消除。
9. 商品分析只使用真实 `price_logs` 和 `inventory_logs`，不再用商品当前价合成历史报价；查询按 `createdAt + _id` 稳定游标扫描并设置行数/查询次数上限。非法数组、时间戳、金额/数量、库存变化或同一 `businessKey` 下相互冲突的库存记录会 fail closed，其中源数据冲突映射为 `422 ANALYTICS_DATA_INVALID`，不会静默少算。
10. Web 商品分析入口固定只允许 active `procurement` 和 `super_admin` 且仍要求 `product:analytics:view`；销售额摘要仅 `super_admin` 可见，库存变化还要求 `inventory:view`。小程序 `adminDashboard` 保留既有可分配权限兼容，不套用 Web 的硬角色限制。
11. 商品列表 DTO 的售价只读取权威 `products.price`，不再优先读取没有当前真实写入证据的 `salePrice/unitPrice`，并已增加布尔 `isActive`。改价使用 `expectedVersion + expectedPriceCents`，单条与批量状态写均使用 `expectedVersion + expectedIsActive`；这些都是并发守卫，不能替代服务端读取当前商品。

## 2. 复用分类与身份边界

| 分类 | 含义 | 当前入口 |
| --- | --- | --- |
| Web 可直接复用 | 已使用 Web session 构造服务端 principal，不依赖浏览器提供 OPENID | `adminWebAuth`、`adminWebApi` 的现有只读路由 |
| 小程序可保持不变 | 保留当前云函数名和响应兼容，由真实 WXContext 解析身份 | `getOrders`、`adminReviewOrder`、`paymentMethods` 等小程序入口 |
| 需要 Web actor/session adapter | 逻辑可复用，但鉴权、审计操作者和 owner 不能继续只取 WXContext | 所有后台读写领域 service |
| 必须抽取共享 service | 涉及状态机、金额、库存、账款、退款上限、幂等或多集合事务，禁止在 BFF 复制 | 订单审核、付款确认、库存导入、发货、售后退款等写入口 |
| 当前缺失 | 现有 HTTP BFF 没有真实实现 | 除单商品改价、显式上下架、显式批量上架、批量公开标签和两个预警值入口外的 mutation；其余业务事务性同步事件写入 |

推荐的可信 actor 仍使用架构文档中的形态：`adminId`、`role`、`permissions`、`authType`、`sessionId`、`sourceClient`、`requestId`。业务 service 必须根据 `adminId` 再读取 `admin_users`，校验 `isActive != false`、`status != disabled`、角色和权限；不能信任浏览器 payload 中的身份字段。

`afterSales` 和 `paymentMethods` 目前存在 `event._callerOpenid` 回退，见 `cloudfunctions/afterSales/index.js:102-105`、`cloudfunctions/paymentMethods/index.js:25-28`。该字段只用于现有云函数包装兼容，Web 路径禁止接受或转发浏览器提供的 `_callerOpenid`。

## 3. 页面到云函数与集合矩阵

说明：

- “当前 Web 读取”表示当前本地 `adminWebApi` 实际行为。
- “小程序现有入口”来自页面真实 `call(...)` 调用及 `miniprogram/utils/api.js:50-95` 的聚合函数路由。
- “建议共享 service”是未来迁移边界，不表示已经实现；表中明确写“已迁移”的切片除外。

| Web 页面/资源 | 当前 Web 读取 | 小程序现有入口 | 真实集合 | 未来共享写/查询 service 与当前缺口 |
| --- | --- | --- | --- | --- |
| 登录/当前管理员 | `adminWebAuth` 的 login/refresh/profile/logout；凭证关联 `admin_users` | `getCurrentAdminProfile`、`loginWithWechat`、`loginWithPassword` 仍是微信身份流程 | `admin_users`、`admin_web_credentials`、`admin_web_sessions`、`admin_login_attempts`、`admin_security_logs` | Web 认证可直接复用；管理员禁用、改角色、改密必须递增 `authVersion` 并吊销 session |
| 工作台 `/dashboard` | `adminWebApi.readDashboard` 直接按权限计数业务集合，仅返回数量、待办和商品榜；趋势为空 | `getAdminDashboardStats` | `products`、`import_records`、`orders`、`payment_records`、`shipment_groups`、`after_sales`、`refund_records`、`customer_accounts`、`order_items` | 抽 `dashboardQueryService`。现有小程序函数的缓存键只有 `range + timezone`，却缓存按角色投影后的结果，见 `cloudfunctions/getAdminDashboardStats/index.js:680-694`；直接复用会有跨角色数据泄漏风险，必须按权限指纹隔离或只缓存原始聚合后逐请求投影 |
| 商品 `/products` | `adminWebApi` 读取并安全投影 `products`，另有严格详情 | `adminSearchProducts`、`getProducts`、`manageProduct`、`updateProductPrice`、`batchUpdateProductTags` 等旧入口 | `products`、`price_logs`、`product_tag_logs`、`inventory_logs`、`admin_operation_logs`、`sync_events` | create/metadata edit 已接 `productWriteService`；改价、状态、公开标签分别接 canonical service，旧入口保留兼容适配。独立 `updateProductTags`、缺货自动下架等 writer 仍待单独迁移 |
| 库存 `/inventory` | `adminWebApi` 读取库存投影和严格详情，并开放服务端 delta 调整 | `getProducts`、`getInventoryLogs` | `products`、`inventory_logs`、`stock_alert_records`、`sync_events` | 单商品预警值和人工库存调整已接 canonical service；调整由服务端基于当前库存计算并写流水/预警，禁止前端提交最终库存。导入和独立日志分页仍未迁移 |
| 库存预警 `/inventory/alerts` | `adminWebApi` 对 `products.stockStatus` 做 `warning/out_of_stock` 过滤 | `getStockAlerts` | `products`、`stock_alert_records`、`inventory_logs`、`sync_events` | 单商品 `set-warning` 与旧 `updateProductWarningStock` 已共用 canonical service；预警页人工调整也已本地接通，`batch-warning` 与检查动作仍未迁移 |
| 报价/库存导入 `/imports/*` | BFF 声明 `imports -> import_records` 的只读资源；HTTP UI 目前保持只读 | `uploadImportFile`、`parseMergedInventoryImport`、`getImportHistory`、`getImportDetail`、`confirmMergedInventoryImport`、`runImportSelfCheck` | `import_records`、`import_record_items`、`products`、`inventory_logs`、`price_logs`、`product_tag_logs`、`idempotency_records`、`admin_operation_logs` | 直接复用 `common/mergedImportService.js` 的领域逻辑，但先把 `requirePermission` 改为 actor adapter。确认导入必须保持全批次幂等和事务；不能由 Web 逐行直写产品 |
| 商品分析 `/analytics/products` | `adminWebApi` 调用 canonical `productAnalyticsQueryService.getOverview()`；只允许 active `procurement/super_admin`，销售额仅超管可见，库存变化还要求 `inventory:view`；前端验证严格 DTO、切换 7/30/90 天并在页面可见且空闲时每 60 秒静默刷新 | 小程序 API 路由到 `adminDashboard` action，再由 adapter 调用同一服务的 `getProductDetail()`；保留现有细粒度权限兼容。独立 `getProductAnalytics` 云函数仍存在但不是当前小程序源码主路径 | `products`、`orders`、`order_items`、`price_logs`、`inventory_logs` | canonical 查询已本地实现：上海时区、前一等长周期、全额退款排除、部分退款不冲减、真实日志、`createdAt + _id` 游标和安全上限；单品详情只扫描当前周期。独立 `getProductAnalytics` 仍会合成 `current_product` 报价点，属于待迁移 legacy，不能纳入本轮部署 |
| 订单 `/orders` | `adminWebApi` 通过 canonical `orderQueryService` 提供稳定游标列表和专用详情，并通过 `orderReviewService` 处理审核/驳回 | `getOrders`、`adminReviewOrder` 已成为兼容 adapters；备注、取消、导出仍走既有入口 | `orders`、`order_items`、`users`、`customer_accounts`、`account_logs`、`products`、`inventory_logs`、`note_logs` | 关联、旧订单 item fallback、角色字段剥离和审核/扣库存/入账事务已本地收口；备注、Web 取消、导出及真实 CloudBase/双端验证仍待完成 |
| 付款 `/payments` | canonical `paymentQueryService` 读取当前权威 `payment_records`；canonical `paymentMutationService` 处理确认/驳回 | 小程序订单页 `adminUpdatePayment` 已成为同一 canonical 服务的兼容 adapter；付款方式页仍用 `paymentMethods` actions | `payment_records`、`orders`、`customer_accounts`、`account_logs`、`delivery_logs`、`admin_operation_logs`、`sync_events` | 列表/详情和当前凭证确认/驳回已本地接通；不返回永久凭证 URL，Web 不提交金额/订单/actor/账款值；真实 CloudBase 未验证 |
| 客户账款 `/accounts` | `adminWebApi` 通过 canonical `accountQueryService` 提供稳定列表/专用详情 | `adminListCustomerAccounts`、`adminGetCustomerAccountDetail` 保留兼容 adapters；`getAccountSummary` 不用于 Web 读取 | `customer_accounts`、受限 `account_logs`、`orders`，必要时安全补充 `users` 掩码信息 | 当前 Web 已有四状态列表、金额分投影、订单/流水上限和 partial；重算、修改、结清、导出保持关闭，不复用 `recalculateCustomerAccount` |
| 发货 `/shipments` | `adminWebApi` 通过 canonical `shipmentQueryService` 提供合并发货单稳定游标列表和专用只读详情；Web 使用严格 DTO，Mock/HTTP cursor 对齐 | `shipmentGroups` 的列表/详情 action 已成为兼容 read adapters；创建、确认、物流编辑、取消、完成、导出仍走既有入口；单订单发货另用 `adminUpdateDeliveryStatus` | `shipment_groups`、`shipment_group_items`、`shipment_logs`、`orders`、`settings/system_settings`、`counters` | 合并发货单读取已关联 items/orders/logs 并按权限投影地址、运单、备注；单订单发货未接。所有发货写/导出在 Real 模式均保持关闭：`merge/ship/edit` 返回 501，`cancel/complete/export` 返回 404；后续迁移必须保留付款前置、地址一致性、状态守卫、计数器、订单联动和日志事务 |
| 售后 `/after-sales` | `adminWebApi` 直接读 `after_sales`，写入通过 canonical service | `getAdminAfterSales`、`getAdminAfterSaleDetail`、`reviewAfterSale`、`confirmReturnReceived`、`inspectReturnItems`、`completeAfterSale`、`exportAfterSalesExcel`，最终路由到 `afterSales` | `after_sales`、`after_sale_logs`、`orders`、`order_items`、`products`、`inventory_logs`、`stock_alert_records`、`admin_operation_logs`、`sync_events`、`idempotency_records` | `afterSaleReviewService` 已接入 `approve/reject`，`returnInspectionService` 已接入 `receive/inspect` 并供 Web 与小程序旧入口共享；仅客服/超级管理员可执行，财务/采购硬拒绝。可售退货才能回补库存；退款阶段由独立 `refundMutationService` 承担 |
| 退款 `/refunds` | `adminWebApi` 直接读 `refund_records`；`POST /refunds/process|reject` 调用 canonical service | `getAdminRefunds`、`getAdminRefundDetail`、`createRefundRecord`、`processOfflineRefund`、`createWechatPayRefund`、`rejectRefund`、`exportAfterSalesExcel`，最终路由到 `afterSales` | `refund_records`、`refund_logs`、`after_sales`、`after_sale_logs`、`orders`、`order_items`、`customer_accounts`、`account_logs`、`admin_operation_logs`、`sync_events`、`idempotency_records` | `refundMutationService` 已本地实现线下确认/驳回；active 财务/超管硬门禁，累计退款不得超过已付和审批金额，退货必须完成验货。create/WeChat Web 路由不开放，微信入口 fail closed |
| 管理员 `/admins` | `adminWebApi` 直接读 `admin_users` 白名单字段 | `getAdminUsers`、`createAdminUser`、`updateAdminRole`、`disableAdminUser` | `admin_users`、`role_permissions`、`permission_logs`、`admin_operation_logs`，以及 Web session/credential 集合 | `adminQueryService` + `adminService`。当前 `createAdminUser` 和 `updateAdminRole` 含无条件 `Invalid operation` 阻断，见各自 `index.js`，不能标为可用；恢复前需邀请/设密、最后超级管理员保护、`authVersion`、session 吊销和审计 |
| 操作日志 `/audit` | `adminWebApi` 直接读 `admin_operation_logs` 并返回安全摘要 | `getAdminOperationLogs` 同时读取 `admin_operation_logs` 和 `permission_logs` | `admin_operation_logs`、`permission_logs` | `auditQueryService`。当前 BFF 只有资源权限，没有按职责域/操作者做行级过滤；非超级管理员即使只看到摘要，也不应看到其他业务域的日志数量和动作 |
| 系统设置 `/settings` | `GET /settings/system` 已固定映射到 `settings/system_settings`，只返回白名单 DTO；通用列表和其他 ID 被拒绝 | `getSettings`、`updateSettings`；付款方式配置另走 `paymentMethods` | `settings` 固定文档 `payment_methods`、`pickup_settings`、`system_settings`；另有 `payment_methods` 集合 | 真实读取已接通到现有固定文档；`settingsService` 写入仍未迁移并保持 501。未来写入要按字段白名单合并，保留付款、售后、发货、幂等配置语义；不能创建新的 `system_settings` 集合 |
| 同步状态 | `adminWebApi /sync/events` 使用 Web principal 读取 | 小程序 `getSyncEvents` 使用 WXContext principal | `sync_events` 加各业务集合的 fallback 时间字段 | 单商品预警值、改价、显式上下架、批量上架和批量公开标签逐项写入最小 outbox；其他共享 service 仍需事务内接入。`cleanupSyncEvents` 只删除过期事件，不生产事件 |

## 4. 当前真实集合名与需求术语对照

| 需求术语 | 当前真实实现 | 结论 |
| --- | --- | --- |
| `products` | `products` | 直接使用 |
| `orders` | `orders` | 直接使用 |
| `order_items` | `order_items` | 直接使用；旧单可能只有订单内联商品字段，查询需保留 fallback |
| `users` | `users` | 直接使用；Web 不应提供通用原始用户集合浏览 |
| `admin_users` | `admin_users` | 管理员 principal 唯一权威 |
| `cart` | 实际为 `carts` | 不存在 `cart` 集合；客户购物车不属于 Web 管理页面，不要新建单数集合 |
| `payment_methods` | `payment_methods`，另有旧配置文档 `settings/payment_methods` | 需保持兼容，不能混为一张无版本表 |
| `payment_records` | `payment_records` | 直接使用 |
| `customer_accounts` | `customer_accounts` | 直接使用 |
| `customer_account_logs` | 实际为 `account_logs` | 仓库扫描没有 `customer_account_logs` 集合引用，不要新建平行流水 |
| `customer_addresses` | `customer_addresses`，操作日志为 `address_logs` | 直接使用；归属和完整字段只在服务端校验/投影 |
| `inventory_logs` | `inventory_logs` | 直接使用 |
| `import_records` | `import_records`，明细为 `import_record_items` | 直接使用 |
| `idempotency_records` | `idempotency_records` | 仅服务端使用，不作为 Web 列表资源 |
| `after_sales` | `after_sales`，日志为 `after_sale_logs` | 直接使用 |
| `refund_records` | `refund_records`，日志为 `refund_logs` | 直接使用 |
| `shipment_groups` / `shipment_logs` | `shipment_groups`、`shipment_group_items`、`shipment_logs` | 直接使用 |
| `admin_operation_logs` | `admin_operation_logs` | 直接使用，但必须安全投影和行级过滤 |
| `product_price_logs` | 实际为 `price_logs` | 仓库扫描没有 `product_price_logs` 集合引用，不要新建平行价格流水 |
| `system_settings` | 实际为 `settings` 集合的 `_id = system_settings` 文档 | 不应创建独立集合 |
| `sync_events` | `sync_events` | 读取/清理已实现；单商品预警值、改价、显式上下架、显式批量上架和批量公开标签逐项事务已写入最小事件，其他业务入口尚缺失 |

## 5. 关键字段、金额、状态与敏感边界

| 集合 | 代码中确认的关键字段/关系 | 必须保持的边界 |
| --- | --- | --- |
| `products` | `_id`、`name/productName`、`sku/productCode/productIndex/skuCode`、权威售价 `price`、`stock`、`warningStock`、`stockStatus`、`isActive`、`version`、`tags/internalTags`、`updatedAt` | 价格为整数分；Web 商品 DTO 不以 `salePrice/unitPrice` 覆盖 `price`；真实库存只给采购/超级管理员；成本、供应商、`internalTags` 不进入普通 Web DTO |
| `orders` | `orderNo`、`userId/userOpenid`、`status`、`paymentStatus`、`deliveryStatus/shippingStatus`、`totalAmount`、`paidAmount`、`unpaidAmount`、`riskLevelSnapshot`、`shippingAddressSnapshot`、`shippingAddressMasked` | 金额为分；历史地址/风险语义来自下单快照；OPENID、完整地址、后台备注按权限隐藏 |
| `order_items` | `orderId`、`productId`、`productName`、`quantity`、`unitPrice`、`totalAmount`、`stockCheckStatus` | 单价/小计为分；审核必须以服务端商品和订单快照复核；旧订单 fallback 不得删除 |
| `users` | `openid`、`nickname`、`phone/phoneMasked`、`phoneVerified` | Web 只通过职责内查询投影使用；不返回 OPENID、完整手机号或密码字段 |
| `admin_users` | `openid`、`name`、`role`、`permissions`、`status`、`isActive`、`authVersion` | 浏览器传入 role/permissions 不可信；凭证和 token 永不存入此集合的可返回字段 |
| `carts` | `userOpenid`、`productId`、`quantity`、`selected` | 客户 owner 数据；下单由 `submitCartOrder` 事务读取并清理，Web 后台不直接写 |
| `payment_methods` | `paymentType`、`paymentName`、`enabled/status`、`sortIndex`、金额范围及银行卡/二维码配置 | 金额范围为分；账号、卡号、二维码、商户号是敏感字段；列表与详情投影不同 |
| `payment_records` | `orderId`、`businessKey`、`idempotencyKey`、`paymentStatus/status`、`paidAmount`、`unpaidAmount`、`screenshotUrls/paymentScreenshotUrl`、交易号 | 金额为分；截图 URL、交易号只给财务/超级管理员详情，使用短期 URL并审计 |
| `customer_accounts` / `account_logs` | 按 `userId` 或兼容 `userOpenid` 关联；`totalOrderAmount/totalReceivableAmount`、`totalPaidAmount/paidAmount`、`totalUnpaidAmount/unpaidAmount`；流水 `businessKey` | 金额为分；账款只给财务/超级管理员；流水必须和订单/付款/退款业务键一致 |
| `customer_addresses` | `openid/userId`、`status`、`isDefault`、收货人、电话、地区、详细地址 | 地址归属和启用状态在服务端校验；完整字段仅在明确权限的订单详情/导出出现 |
| `inventory_logs` | `businessKey`、`productId`、`beforeStock`、`afterStock`、`changeAmount`、`reason/sourceType`、关联订单/导入/售后 ID | 数量必须为整数；流水防重键不能由浏览器决定；采购职责外不返回真实库存变化 |
| `import_records` / `import_record_items` | 文件/批次、`status`、总行/成功/失败/跳过计数、行号、匹配商品、处理 action | 文件 ID、原始内容和错误行可能含供应信息，只给导入权限；确认前必须重新服务端校验 |
| `idempotency_records` | `actionType`、`operatorIdentity`、`idempotencyKey`、`scope/scopeId`、`requestHash`、状态、锁和过期时间 | 只允许服务端构造 operator；同 key 不同 payload 必须冲突；不对 Web 暴露记录详情 |
| `after_sales` / `refund_records` | 订单关联、售后/退款状态、申请/审批/实退金额、退货商品、凭证、物流、退款账户 | 金额为分；职责分离、审批上限、累计已付上限和隐私投影必须保留 |
| `shipment_groups` / `shipment_logs` | `shipmentNo`、`orderIds/orderNos`、地址快照、`shippingStatus`、承运商/运单号、`businessKey` | 地址和运单按角色脱敏；合并资格、付款前置、状态守卫必须服务端执行 |
| `admin_operation_logs` | 操作人、action、resource type/id、before/after、description、时间 | 原始 before/after 可能含隐私，不直接返回；Web 当前安全摘要方向正确，但还需行级职责过滤 |
| `price_logs` | `businessKey`、`productId`、`beforePrice`、`afterPrice`、source、operator、时间 | 金额为分；价格写入和流水同事务；成本/供应价另按权限隔离 |
| `settings/system_settings` | 付款、售后、合并发货、幂等、地址/手机号等开关与阈值 | 固定文档；按字段白名单更新，不允许浏览器覆盖未知字段或安全 secret |
| `sync_events` | `eventId`、`eventType`、`entityType`、`entityId`、`action`、`version`、`changedFields`、`sourceClient`、`createdAt`、`expiresAt`、owner/audience | `changedFields` 只允许字段名白名单；不放值、OPENID、手机号、地址、截图或退款账户；游标为 AES-GCM v3 opaque token |

## 6. 写操作的事务与幂等边界

| 业务 | 当前事务/防重证据 | Web 迁移必须保持 |
| --- | --- | --- |
| 订单审核 | `adminReviewOrder` 在 `db.runTransaction` 内读取订单/items、校验并扣 `products.stock`、更新 `order_items`、写 `inventory_logs`、更新订单并写 `customer_accounts/account_logs`，见 `cloudfunctions/adminReviewOrder/index.js:138-248`；使用 `order_deduct:*`、`order_debt:*` 业务键 | 作为一个 `orderReviewService.review()` 用例迁移；不能拆成“改状态、扣库存、入账”三个请求。现有入口主要依赖状态和业务键防重，Web service 还应统一接入 `idempotency_records` |
| 付款确认 | `adminUpdatePayment` 同一事务更新订单、`payment_records`、`customer_accounts/account_logs`，并用 `payment_confirm:*` 业务键防重；见 `cloudfunctions/adminUpdatePayment/index.js:46-121`、`cloudfunctions/adminUpdatePayment/index.js:236-302` | 服务端重新计算本次实收和未收，拒绝超付；前端只传整数分意图和 idempotency key，不能传最终账款值 |
| 库存/报价导入 | `common/mergedImportService` 先 `beginIdempotentAction`，再在事务内更新商品、库存/价格/标签日志和导入记录，见 `cloudfunctions/common/mergedImportService.js:694-730`、`:808-1028` | 整批/分批 key、请求 hash、导入记录状态和日志必须保留；不能在 Web 客户端逐行提交独立数据库写入 |
| 商品改价 | 单商品改价已使用 canonical `productPriceService`；Web 校验 active `procurement/super_admin`、`product:update_price`、CSRF、`Idempotency-Key`、`expectedVersion + expectedPriceCents`。同事务更新 `products.price/version` 并写 `price_logs/sync_events`；相同售价零写入，提交后幂等状态滞后可由 `price_logs` 恢复 | 旧 `updateProductPrice` 保持参数/返回兼容的薄适配器；批量改价和其他可能写价格的旧入口仍需逐一统一。当前服务不写 `admin_operation_logs`，不得在文档中虚构该日志 |
| 商品预警 | 单商品预警值已使用 canonical service，同时比较 `expectedVersion + expectedWarningThreshold`，并在事务内写日志/outbox；旧批量预警仍各自实现 | 继续统一旧 `warningStock` writer；原阈值守卫用于防止未递增 version 的旧写静默覆盖 |
| 商品显式上下架 | canonical `productStatusService` 已本地实现并通过回归。Web 合同为 `id/isActive/expectedIsActive/expectedVersion/reason`，要求 active 合法角色、`product:update_status`、CSRF 和 `Idempotency-Key`；同事务写 `products/admin_operation_logs/sync_events`，no-op 零写 | 显式 set，不读取后 toggle。单条路由为 `products/toggle-status`；`manageProduct/delete` 与 `getUnsoldProducts/deactivate` 为薄适配器。`manageProduct.update` 已由后续 `productWriteService` 收口；缺货自动下架仍是未统一路径 |
| 商品显式批量上架 | Web `POST /products/batch-enable` 固定 `isActive=true`，严格要求最多 100 个原始 `items[{id,expectedIsActive,expectedVersion}]`，原始长度在去重前校验；session、`product:update_status`、CSRF 和 `Idempotency-Key` 缺一不可。canonical service 逐项事务执行并允许部分成功，只返回安全计数与 `{id,code}` 失败项；同 key 同 payload 可重放/恢复，同 key 异 payload 只返回冲突，不覆盖原成功或处理中记录 | `manageProduct.bulkActivate` 已成为同一 service 的兼容薄适配器，继续接受旧 `productIds` 和缺失 key 的小程序旧调用。每个变化商品同事务写 `products/admin_operation_logs/sync_events`，no-op 零业务写；`manageProduct.update` 已由后续 `productWriteService` 收口，缺货自动下架仍未统一 |
| 合并发货 | `shipmentGroups` 在 `runIdempotentAction + db.runTransaction` 中创建 group/items、更新所有订单、写 `shipment_logs`，见 `cloudfunctions/shipmentGroups/index.js:552-699` | 合并资格与写入必须在同一服务端用例重新校验；确认、取消、完成继续使用全局幂等记录和 `shipment_logs.businessKey` |
| 单订单发货 | `adminUpdateDeliveryStatus` 在事务内检查付款/配送类型/售后状态，更新订单并写 delivery/shipment log | 保留状态守卫；不能让 Web 直接提交最终 `deliveryStatus` 覆盖订单 |
| 售后/退款 | `afterSales` 的申请、审核、验收、回库、退款创建/确认/拒绝/完成普遍使用 `runIdempotentAction` 或 begin/finish/fail，并在事务联动订单、商品、库存、账款和日志 | 整体抽 `afterSaleService/refundService`；财务不能审核售后、客服不能最终退款、采购不能访问退款；累计退款不得超过已付与审批金额 |
| 同步事件 | 单商品预警值、改价、显式上下架、显式批量上架和批量公开标签已在各自事务写 `sync_events`；两个批量动作均按商品逐项事务；其他业务仍无 outbox | 每个共享 service 在同一业务事务最后追加最小 outbox 事件；事务提交后再由客户端补拉。不能先发事件后写业务数据 |

## 7. 当前读取、分页和投影缺口

### 7.1 `adminWebApi` 当前限制

1. 通用资源列表分页仍是 `skip + limit`，cursor 只编码页码，最大 skip 10000，见 `cloudfunctions/adminWebApi/lib/core.js`。订单、合并发货单和商品分析已成为例外，分别使用时间字段 + `_id` 的稳定游标；其余通用资源仍可能在并发插入时重复或漏项。
2. 通用 BFF 仍仅按单集合读取；订单、合并发货单和客户账款已迁移到专用关联查询服务。付款仍没有订单/客户关联，售后退款没有流程日志；单订单发货也尚未接入合并发货单页面。
3. 搜索使用跨字段正则，见 `cloudfunctions/adminWebApi/index.js:160-174`。大数据量下通常无法稳定命中普通索引，应改为标准化 `searchText`、精确字段或专用前缀键。
4. 通用 `sort` 只能选择升/降序，不能选择业务排序字段。订单时间范围、付款提交时间、售后类型、退款方式、导入类型等筛选没有专用校验。
5. `getResource()` 只按原始 document id 查单集合并复用列表投影，见 `cloudfunctions/adminWebApi/index.js:284-298`；不足以支撑真实详情页。
6. `audit` 没有按 principal 的职责域做行级过滤；`admins`、付款凭证、完整地址等详情也需要专用 endpoint，不应继续扩大通用 raw collection handler。
7. `settings` 已从通用 collection/id 读取中隔离：policy 指向 `settings` 集合，公开 `system` 只解析为内部 `system_settings`，并拒绝列表枚举或任意文档 ID；其他资源的通用 list/get 行为不变。

### 7.2 现有小程序查询也不能原样搬运

- `getAdminDashboardStats` 的欠款客户结果保留 `openid`，见 `cloudfunctions/getAdminDashboardStats/index.js:490-518`、`:522-561`；结合未按权限隔离的模块级缓存，其现有响应不能直接成为 Web DTO。
- `adminSearchProducts` 分批拉取全部商品后在内存过滤和分页，见 `cloudfunctions/adminSearchProducts/index.js:49-62`、`:139-168`。
- 旧 `adminListCustomerAccounts` 兼容适配仍保留最多读取 1000 条的历史边界；Web 已不再走该页码型路径，改用 canonical 稳定游标。
- `getInventoryLogs` 固定最近 100 条，没有 cursor，见 `cloudfunctions/getInventoryLogs/index.js:17-19`。
- `getAdminAfterSales` 只有 limit、没有 offset/cursor；`getAdminRefunds` 固定最多 200 条，见 `cloudfunctions/afterSales/index.js:888-895`、`:1738-1755`。
- `getImportHistory` 固定最近 100 条，详情最多读取当前 service 的 item 上限，见 `cloudfunctions/common/mergedImportService.js:1089-1106`。
- `getAdminOperationLogs` 要求宽泛的 `admin:view` 并返回原始 `admin_operation_logs/permission_logs` 行，见 `cloudfunctions/getAdminOperationLogs/index.js:11-17`；Web 需要 `operation_log:view`、职责域行级过滤和安全 DTO。
- `getAdminUsers` 当前返回 `admin_users` 原始行，见 `cloudfunctions/getAdminUsers/index.js:16-25`；Web 必须继续使用白名单投影，永不返回 openid、完整电话、凭证或 session 字段。
- `getSettings` 当前没有管理员鉴权，因为其中部分开关服务于小程序公共读取；Web 管理设置页仍必须要求 `system:settings`，不能因旧入口可公开调用而扩大管理权限。
- `getOrders` 已改为 canonical 查询服务的兼容 adapter，保留 page/pageSize、旧 item fallback、`summaryOnly` 和小程序响应形状；Web 专用入口已升级为稳定游标。legacy adapter 为兼容旧调用仍保留 offset 分页。

## 8. 索引建议

以下仅是根据当前查询形态给出的测试环境候选，不代表云端已存在，也不得在未确认的环境直接创建。部署前应先盘点真实数据量、现有索引和查询计划。

| 集合 | 候选复合索引/唯一约束用途 |
| --- | --- |
| `admin_web_credentials` | `loginIdHash + status` 用于登录；`adminId + status` 用于初始化/轮换时检查唯一 active credential。后者为本轮新增查询，必须在隔离测试环境确认查询计划和事务冲突行为 |
| `products` | `isActive + updatedAt + _id`；`stockStatus + updatedAt + _id`；业务确认后评估 `sku/productIndex` 唯一性 |
| `orders` | `status + createdAt + _id`；`paymentStatus + createdAt + _id`；`deliveryStatus + createdAt + _id`；`userId + createdAt`；兼容期保留 `userOpenid + createdAt` |
| `order_items` | `orderId`；`productId + createdAt`；库存不足待办可用 `stockCheckStatus + createdAt` |
| `payment_records` | `paymentStatus + createdAt + _id`；`orderId + createdAt`；`businessKey` 防重；批次查询用 `paymentBatchId` |
| `customer_accounts` | `userId`、兼容 `userOpenid`；`status + updatedAt + _id`；账款排序按实际字段增加复合索引 |
| `account_logs` | `userId + createdAt + _id`；`relatedOrderId + createdAt`；`businessKey` 防重 |
| `customer_addresses` | `openid + status + isDefault`；如完成 userId 迁移再增加 `userId + status` |
| `inventory_logs` | `productId + createdAt + _id`；`businessKey` 防重；`sourceType + createdAt` |
| `import_records` / `import_record_items` | `status + createdAt + _id`；`importRecordId + rowNo` |
| `idempotency_records` | `_id` 已由 action/operator/key 派生；清理用 `status + expiresAt` |
| `after_sales` | `afterSaleStatus + createdAt + _id`；`orderId + createdAt`；客户查询用 `openid + createdAt` |
| `refund_records` | `refundStatus + createdAt + _id`；`afterSaleId + createdAt`；`orderId + createdAt` |
| `shipment_groups` / `shipment_group_items` / `shipment_logs` | `shippingStatus + createdAt + _id`；group items 用 `shipmentGroupId`；logs 用 `shipmentGroupId + createdAt` 与 `businessKey` |
| `admin_operation_logs` | `operatorId + createdAt`；`resourceType + createdAt`；`action + createdAt`；实际行级职责过滤字段需先确定 |
| `price_logs` | `productId + createdAt + _id`；`businessKey` 防重；`sourceType + createdAt` |
| `sync_events` | `createdAt + _id`；`expiresAt`；`entityType + createdAt + _id`；普通用户 outbox 若按 owner 查询则增加 `ownerKey + entityType + createdAt + _id` |

固定文档 `settings/system_settings` 不需要独立集合索引。

## 9. 建议迁移顺序

1. 修正只读 query service：设置固定文档、订单关联、付款详情短期 URL、审计行级过滤、稳定游标。
2. `orderReviewService` 及 Web 审核/驳回已本地完成；继续迁移订单备注、Web 取消和导出，并完成真实事务/双端验证。
3. 按相同方式迁移 `paymentService`，完成付款记录、订单、账款、流水和 outbox 一致性。
4. 在已完成 canonical 合并发货单读取的基础上迁移 `shipmentService`，覆盖单订单发货及合并发货全部写操作；导出单独受控开放。
5. 迁移 `afterSaleService/refundService`，保留审核与财务职责分离。
6. 保持商品分析 canonical 查询契约并完成真实 CloudBase 验证；单商品改价、单商品显式上下架、显式批量上架和批量公开标签均已本地迁移。其他商品、库存和导入写服务逐项完成后才开放对应 HTTP 按钮。
7. 每迁移一个模块，分别回归小程序旧入口、Web session 入口、重复请求、权限、敏感字段和断网补拉；未完成本地实现与最终回归的动作保持 501，真实双端通过仍必须单独采证。

## 10. 未来可能修改/复用的云函数清单（A-Z）

以下是迁移时可能涉及的现有入口，不表示本轮已修改或需要立即全部上传。包装函数应继续保留名称兼容，领域逻辑逐步委托给共享 service。

| 云函数 | 未来用途 |
| --- | --- |
| `adminDashboard` | 当前小程序商品分析聚合入口；通过 adapter 调用 canonical `getProductDetail()`，保留小程序权限兼容 |
| `adminGetCustomerAccountDetail` | 账款详情 query adapter |
| `adminListCustomerAccounts` | 账款列表 query adapter |
| `adminReviewOrder` | 订单审核旧入口，委托 `orderReviewService` |
| `adminSearchProducts` | 商品搜索旧入口，委托稳定分页 query service |
| `adminUpdateDeliveryStatus` | 单订单发货旧入口 |
| `adminUpdatePayment` | 付款确认旧入口，委托 `paymentService` |
| `adminWebApi` | Web BFF、DTO、固定路由；商品分析已调用 canonical `getOverview()`，单商品改价、显式 `toggle-status`、显式 `batch-enable`、显式 `batch-tags` 和两个单商品预警值入口已本地解除 501，其余 mutation 逐项迁移 |
| `adminWebAuth` | Web session；管理员变更时配合吊销和 authVersion |
| `afterSales` | 售后/退款聚合旧入口，委托共享 service |
| `batchUpdateProductPrices` | 批量改价旧入口 |
| `batchUpdateProductTags` | 批量标签旧入口；已改为 canonical `productTagService` 的小程序兼容薄适配器，保留公开/内部标签，并恢复为清洗去重后最多 200 个唯一商品；Web 路由仍按原始请求最多 100 项且只开放公开标签 |
| `batchUpdateWarningStock` | 批量预警值旧入口 |
| `cancelMergeShipment` | 合并发货兼容包装入口 |
| `cancelOrder` | 订单取消状态机旧入口；现已本地改为事务内按唯一扣减流水原子回补，并持久化账款重算待办；真实 CloudBase/双端未验证，Web 取消仍不开放 |
| `checkMergeShipmentEligibility` | 合并发货资格兼容包装入口 |
| `cleanupSyncEvents` | outbox 过期清理，仅在真正生产事件后启用计划任务 |
| `completeAfterSale` | 售后完成兼容包装入口 |
| `completeShipment` | 合并发货完成兼容包装入口 |
| `confirmInventoryImport` | 旧库存导入确认路径 |
| `confirmMergedInventoryImport` | 合并库存/报价导入确认入口 |
| `confirmReturnReceived` | 退货收货兼容包装入口 |
| `confirmShipment` | 合并发货确认兼容包装入口 |
| `createAdminUser` | 管理员创建；当前阻断，恢复前补齐凭证/session 规则 |
| `createMergeShipment` | 合并发货创建兼容包装入口 |
| `createRefundRecord` | 退款记录创建兼容包装入口 |
| `disableAdminUser` | 管理员启停及 Web session 吊销 |
| `exportAfterSalesExcel` | 售后/退款导出兼容入口 |
| `exportCustomerStatement` | 账款导出兼容入口 |
| `exportOrdersExcel` | 订单导出兼容入口 |
| `exportShipmentPickingList` | 发货拣货单导出兼容入口 |
| `getAdminAfterSaleDetail` | 售后详情兼容包装入口 |
| `getAdminAfterSales` | 售后列表兼容包装入口 |
| `getAdminDashboardStats` | 小程序看板；修正权限缓存后抽 query service |
| `getAdminOperationLogs` | 操作日志旧查询入口 |
| `getAdminPaymentMethods` | 付款方式配置兼容包装入口 |
| `getAdminRefundDetail` | 退款详情兼容包装入口 |
| `getAdminRefunds` | 退款列表兼容包装入口 |
| `getAdminShipmentGroups` | 发货列表兼容包装入口 |
| `getAdminUsers` | 管理员列表旧查询入口 |
| `getImportDetail` | 导入详情旧查询入口 |
| `getImportHistory` | 导入历史旧查询入口 |
| `getInventoryLogs` | 库存流水旧查询入口 |
| `getOrders` | 订单关联和脱敏查询基础 |
| `getProductAnalytics` | 独立 legacy 旧入口；仍可能追加 `source: current_product` 合成报价点，不是当前小程序源码主路径，也不纳入本轮部署 |
| `getSettings` | `settings/*` 固定文档读取基础 |
| `getShipmentGroupDetail` | 发货详情兼容包装入口 |
| `getStockAlerts` | 库存预警旧查询入口 |
| `getSyncEvents` | 小程序同步读取入口 |
| `getUnsoldProducts` | 缺货商品读取及 `deactivate` 旧入口；显式停用动作改为 `productStatusService` 薄适配器，缺货自动下架路径仍待统一 |
| `inspectReturnItems` | 退货验货和回库兼容包装入口 |
| `manageProduct` | 商品创建/编辑/上下架旧入口；`create/update` 已改为 `productWriteService` 兼容适配器，`delete/bulkActivate` 为 `productStatusService` 适配器；legacy create/update 仍允许缺少版本/幂等字段 |
| `markCustomerSettled` | 账款结清旧入口 |
| `parseMergedInventoryImport` | 合并导入解析入口 |
| `paymentMethods` | 付款方式及线下凭证聚合入口 |
| `processOfflineRefund` | 线下退款确认兼容包装入口 |
| `recalculateCustomerAccount` | 账款重算兼容入口；不能代替主事务一致性 |
| `rejectRefund` | 退款驳回兼容包装入口 |
| `reviewAfterSale` | 售后审核兼容包装入口 |
| `shipmentGroups` | 合并发货聚合旧入口，委托共享 service |
| `updateAdminRole` | 管理员角色变更；当前阻断，恢复时吊销 session |
| `updateCustomerAccount` | 客户账款维护旧入口 |
| `updateOrderAdminNote` | 订单备注及 note log 旧入口 |
| `updateProductPrice` | 单商品改价旧入口；现为 canonical `productPriceService` 的小程序薄适配器，保持旧参数/返回兼容，不宣称与 Web 使用相同并发合同 |
| `updateProductTags` | 单商品标签旧入口 |
| `updateProductWarningStock` | 单商品预警值旧入口；现为 canonical service 的小程序薄适配器，保持旧 event/响应兼容 |
| `updateSettings` | 系统固定文档写入旧入口 |
| `updateShipmentInfo` | 发货物流编辑兼容包装入口 |
| `uploadImportFile` | 导入文件上传入口，需 Web 文件边界适配 |

## 11. 扫描证据

- Web 页面资源：`admin-web/src/config/navigation.ts:19-34`、`admin-web/src/config/resources.ts`。
- Web HTTP transport：`admin-web/src/services/transport/http-transport.ts`。
- BFF 资源/权限/集合映射：`cloudfunctions/adminWebApi/lib/core.js:1-53`。
- BFF 字段白名单：`cloudfunctions/adminWebApi/lib/core.js:186-235`。
- BFF 通用列表、筛选和分页：`cloudfunctions/adminWebApi/index.js:145-199`。
- 商品分析 canonical 服务：`cloudfunctions/common/services/productAnalyticsQueryService.js`；Web adapter/DTO：`cloudfunctions/adminWebApi/index.js`；小程序 adapter：`cloudfunctions/adminDashboard/productAnalytics.js`。
- 商品改价 canonical 服务：`cloudfunctions/common/services/productPriceService.js`；Web route/DTO：`cloudfunctions/adminWebApi/index.js`；小程序薄适配：`cloudfunctions/updateProductPrice/`。
- 商品状态 canonical 服务：`cloudfunctions/common/services/productStatusService.js`；Web 开放 `products/toggle-status` 与 `products/batch-enable`；小程序薄适配入口为 `manageProduct/delete`、`manageProduct.bulkActivate` 与 `getUnsoldProducts/deactivate`。
- 商品分析前端严格契约和可见状态兜底刷新：`admin-web/src/services/transport/product-analytics-contract.ts`、`admin-web/src/modules/analytics/ProductAnalyticsView.vue`。
- 小程序 API 聚合路由：`miniprogram/utils/api.js:1-95`。
- 小程序真实后台调用：`miniprogram/pages/admin/products.js`、`orders.js`、`inventory.js`、`settings.js` 及 `pages/admin/**` 的各业务页。
- OPENID 管理员鉴权：`cloudfunctions/common/auth.js:16-18`、`:63-103`；合并导入使用的同类逻辑见 `cloudfunctions/common/cleanAuth.js:157-196`。
- 订单事务：`cloudfunctions/adminReviewOrder/index.js:116-248`。
- 导入事务与幂等：`cloudfunctions/common/mergedImportService.js:694-730`、`:808-1035`。
- 发货事务与幂等：`cloudfunctions/shipmentGroups/index.js:552-699`。
- 售后退款状态机：`cloudfunctions/afterSales/index.js`；审核通过/驳回由 `afterSaleReviewService` 共享，确认收货/验货由 `returnInspectionService` 共享，退款创建/线下确认/驳回由 canonical `refundMutationService` 共享；Web 仅开放线下确认与驳回。
- 同步 source、角色 scope、字段白名单和 v3 cursor：`cloudfunctions/common/syncEvents.js:3-57`、`:112-167`、`:213-259`、`:416-472`。
- 当前设置真值：`cloudfunctions/getSettings/index.js`、`cloudfunctions/updateSettings/index.js`。

## 12. 未验证边界

- 本轮没有读取真实 CloudBase 集合、数据量、索引、查询计划、权限规则、地域或配额。
- 没有验证真实 Cookie/HTTPS 网关、Web session、CSRF、临时文件 URL、CloudBase 云函数互调或五角色云端字段隔离。
- 没有执行任何 CloudBase 或真实数据写操作。商品受控写、库存预警/人工调整、订单审核/驳回、付款审核、售后审核、退货验收和线下退款处理/驳回只有本地事务/契约/回归证据，不能证明其云端查询计划或 outbox 表现；账款结清/导出、发货写和微信退款仍未迁移。
- 商品分析只完成本地实现和自动化/浏览器局部验证，尚未使用真实 CloudBase 数据验证查询计划、数据质量、角色投影或性能；独立 `getProductAnalytics` legacy 仍未收敛。`cancelOrder` 本地缺口已修复，但真实验证尚未执行。
- 商品分析阶段及旧切片计数只属于历史证据；合并发货单切片的最终本地全量结果为云函数 `392/392`、Web `285/285`，TypeScript、ESLint、Mock/Real 构建和 Real 资产扫描通过。这些仍只构成本地证据。
- 严格公开标签模式只更新 `tags/isNew/isDefective/isHot/tagUpdatedAt/tagUpdatedBy/updatedAt/version/searchText`，保留 `internalTags/isFrequent/defectDescription` 原值并从公开模式 change detection 排除；异常内部标签不阻断公开标签写，no-op 零业务写。legacy 小程序入口仍可处理公开/内部标签，但 200 项上限按清洗去重后的唯一商品数计算；Web 继续按去重前原始最多 100 项计算。
- 没有上传或部署任何云函数。当前唯一 19 函数 local-only 保护包 `.codex-cloudfunction-deploy/admin-web-nineteen-functions-guarded-20260718-030709/` 的 manifest 为 `uploadPerformed=false`；`022011` 及所有更早旧包与失败包均已过期，不是可部署候选。
