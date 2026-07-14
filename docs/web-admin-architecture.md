# 网页后台架构设计

> **2026-07-13 订单查询架构更新：** 新增 canonical `orderQueryService`，Web BFF 与小程序 `getOrders` 兼容入口共用同一查询/投影层。Web 使用稳定游标和严格最小 DTO，旧入口保留原响应结构；金额、电话、地址、备注与风险字段均在服务端按权限裁剪。此变更只覆盖查询，不改变订单状态机或写入语义。

> **2026-07-12 库存架构更新：** 新增 canonical `inventoryMutationService`，供 Web BFF、`manageProduct`、`getUnsoldProducts` 和 `cancelOrder` 复用。Web 只提交增减量与并发快照，最终库存、告警、自动缺货下架、日志、版本和 outbox 均在服务端事务内决定。`cancelOrder` 复用事务 primitive，但以订单扣减流水作为恢复证据，不复制前端或订单快照中的库存逻辑。

> **2026-07-12 架构实现更新：** 商品创建和 metadata-only 编辑已通过 canonical `productWriteService` 本地落地，`manageProduct.create/update` 为同一服务的兼容 adapter。Web 不通过完整商品快照修改售价、库存、预警、状态或标签。编号使用 `system_counters/product_index` 事务计数器，但显式编号并发的最终唯一保障仍依赖部署前 `products.productIndex` 唯一性审计与约束。旧小程序缺少强制版本/幂等字段的兼容边界仍保留。

> 状态：架构冻结，本地实现完成，隔离测试环境验收待执行（2026-07-11）  
> 范围：新增电脑端后台，不复制客户商城，不创建第二套业务数据库，不改变现有订单、库存、付款、退款和发货语义。

## 1. 设计结论

网页版采用 Vue 3 + Vite + TypeScript + Vue Router + Pinia。浏览器只访问受认证的同源 BFF/API，不直接读写 CloudBase 数据库，也不把 `openid`、`role` 或 `permissions` 当作可信入参。

```text
微信小程序入口 -- WXContext.OPENID --\
                                     +--> ActorContext --> 共享业务服务 --> 现有 CloudBase 数据库
网页 BFF ------ Web Session --------/                         |
                                                               +--> sync_events/outbox
```

- 商品、库存、订单、付款、账款、发货、售后和退款继续只有一份数据。
- 小程序旧云函数名和兼容响应保留；逐模块改为调用共享服务。
- Web BFF 负责会话、CSRF、限流、DTO 校验、请求追踪和响应整形，不复制领域规则。
- `sync_events` 是缓存失效通知和断线补偿日志，不是业务真值。
- 当前代码无法证明所配置云环境是隔离测试环境。确认测试环境前，不部署、不上传、不执行真实数据写入。

## 2. 当前项目架构

### 2.1 前端

- `miniprogram/` 是微信原生小程序。
- 页面通过 `wx.cloud.callFunction` 调用 `cloudfunctions/`。
- 管理页面已覆盖工作台、商品、库存、导入、订单、付款、账款、发货、售后、退款、管理员和设置。
- 现有缓存主要依靠 TTL、页面 `onShow` 和本机 dirty flag；没有全局实时订阅。
- 现有视觉变量位于 `miniprogram/styles/theme.wxss`，网页版复用颜色和语义，不直接复用 rpx 布局。

### 2.2 云函数与身份

现有后台鉴权通常执行：

```text
cloud.getWXContext().OPENID
  -> admin_users.openid
  -> isActive/status/role
  -> permission
```

因此现有后台函数不能原样作为 Web API。`loginWithPassword` 面向 `users`，仍要求微信 OPENID，并且没有持久、可验证、可撤销的 Web 会话。

仓库存在大量独立部署副本：约 125 份同版 `auth.js`、118 份同版 `permissions.js`，另有不同版本的 auth/idempotency。后续以根 `cloudfunctions/common/` 为唯一源码，通过打包脚本复制到目标函数，并增加一致性检查。

### 2.3 可复用业务实现

| 业务 | 代表入口 | 可复用内容 | Web 适配边界 |
| --- | --- | --- | --- |
| 商品/库存 | `manageProduct`、`confirmInventoryImport` | 商品校验、价格/库存日志、导入事务 | 抽成 `productService`、`inventoryService` |
| 订单审核 | `adminReviewOrder` | 状态守卫、库存扣减、账款写入、幂等 | 整体抽取，不能拆成多次请求 |
| 付款 | `adminUpdatePayment`、`paymentMethods` | 付款记录、账款日志、批次状态、事务 | Web 只接受整数分，禁止信任前端金额状态 |
| 发货 | `shipmentGroups` | 合并发货、物流状态、事务和业务键 | 保留聚合用例及旧包装入口 |
| 售后退款 | `afterSales` | 审核状态机、退款上限、库存恢复、账款联动 | 保留审核与财务处理的职责分离 |
| 查询/投影 | `getOrders`、`getAdminDashboardStats` | 分页、关联数据、字段剥离 | 归一分页与字段级投影，避免全量扫描 |

### 2.4 数据库关系

网页版继续使用现有业务集合，包括：

- `products`、`orders`、`order_items`、`users`、`admin_users`
- `payment_records`、`customer_accounts`、`account_logs`
- `inventory_logs`、`shipment_groups`、`shipment_group_items`、`shipment_logs`
- `after_sales`、`after_sale_logs`、`refund_records`、`refund_logs`
- `price_logs`、`admin_operation_logs`
- 系统设置当前实现为 `settings` 集合中的 `system_settings` 文档，不另建同名集合。

本地代码预期新增的基础设施集合：

- `admin_web_credentials`：管理员 Web 凭证，只保存慢哈希及参数，不混入会被展开返回的管理员资料。
- `admin_web_sessions`：可撤销、可轮换会话。
- `admin_login_attempts`：持久登录限流。
- `admin_security_logs`：认证安全审计，不含密码、令牌和完整隐私数据。
- `sync_events`：最小化同步事件/outbox。

本地仓库没有可证明已部署的数据库索引配置。实际云端索引必须在用户确认的测试环境中只读盘点后再创建。

## 3. 网页技术选型

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 | Composition API，单一 Web 框架 |
| 构建 | Vite | 独立构建与静态资源输出 |
| 语言 | TypeScript strict | API、权限、状态和事件契约类型化 |
| 路由 | Vue Router 4 | 路由 meta 与菜单共用权限配置 |
| 状态 | Pinia | 认证、应用、同步及模块查询状态 |
| UI | Element Plus 按需引入 | 表格、分页、表单、上传、抽屉和弹窗 |
| 图标 | lucide-vue-next | 单一图标来源，按钮优先使用图标 |
| HTTP | Axios | 同源 BFF、拦截器、超时和请求 ID |
| 校验 | Zod | 环境变量和关键 DTO 运行时校验 |
| 图表 | ECharts 按路由懒加载 | 仅商品分析页面加载 |
| 测试 | Vitest、Vue Test Utils、MSW、Playwright | 单元、契约、组件和浏览器验收 |

第一版不让浏览器直连 CloudBase 数据库。只有测试环境确认 CloudBase Web Auth、安全规则、地域和配额后，才评估 Web SDK 的只读订阅加速。

## 4. `admin-web` 目录

```text
admin-web/
├─ public/
├─ src/
│  ├─ app/                 # 启动和全局 provider
│  ├─ router/              # routes、guards、route meta
│  ├─ layouts/             # AuthLayout、AdminLayout
│  ├─ config/              # env、menu、feature flags
│  ├─ stores/              # auth、app、realtime
│  ├─ services/
│  │  ├─ http/             # client、interceptors、errors
│  │  ├─ auth/
│  │  ├─ realtime/
│  │  └─ transport/        # HttpBffTransport
│  ├─ modules/             # dashboard/products/inventory/... 
│  ├─ components/          # DataTable、FilterBar、SyncStatus
│  ├─ styles/              # tokens、base、Element Plus overrides
│  ├─ types/               # API、分页、权限、同步事件
│  └─ test/
├─ .env.example
├─ package.json
├─ tsconfig*.json
└─ vite.config.ts
```

模块采用 `api.ts + types.ts + store.ts + views/ + components/`。Pinia 不保存库存扣减、付款确认或退款计算等业务规则。

## 5. 路由与前端状态

第一阶段路由：

- `/login`、`/dashboard`
- `/products`、`/products/:id`
- `/inventory`、`/inventory/alerts`
- `/imports/quotes`、`/imports/inventory`
- `/orders`、`/orders/:id`
- `/analytics/products`、`/audit`
- `/403` 和 404

第二阶段增加：`/payments`、`/accounts`、`/shipments`、`/after-sales`、`/refunds`、`/admins`、`/settings`。

路由 meta 至少包含：`requiresAuth`、`permissionsAny`、`permissionsAll`、`roles`、`menuGroup`、`sensitive`。菜单和路由读取同一份配置。

Pinia 分工：

- `authStore`：当前管理员、权限、初始化和会话失效。
- `appStore`：侧栏、密度和非敏感偏好。
- `realtimeStore`：连接状态、cursor、最后同步时间和重试次数。
- 模块 store：筛选、分页、选择集、实体缓存和局部失效。

令牌不写入 `localStorage`。同源 BFF 使用 `HttpOnly; Secure; SameSite=Lax` 刷新 Cookie；访问凭证仅内存保存。仅非敏感 UI 偏好与同步 cursor 可持久化。

## 6. API 和共享业务服务

### 6.1 BFF 契约

```text
admin-web -> /api/admin/v1/* -> adminWebApi/BFF -> shared services -> CloudBase DB
```

成功响应：

```json
{
  "ok": true,
  "data": {},
  "meta": { "requestId": "...", "serverTime": "...", "version": 1 }
}
```

失败响应：

```json
{
  "ok": false,
  "error": { "code": "VALIDATION_ERROR", "message": "参数不正确", "requestId": "..." }
}
```

稳定错误码包括：`AUTH_REQUIRED`、`SESSION_EXPIRED`、`SESSION_REVOKED`、`FORBIDDEN`、`VALIDATION_ERROR`、`NOT_FOUND`、`STATE_TRANSITION_INVALID`、`INSUFFICIENT_STOCK`、`REFUND_AMOUNT_EXCEEDED`、`DATA_VERSION_CONFLICT`、`IDEMPOTENCY_KEY_REQUIRED`、`IDEMPOTENCY_KEY_CONFLICT`、`RATE_LIMITED` 和 `INTERNAL_ERROR`。

列表使用 `createdAt + _id` 稳定游标，默认 20、最大 100。关键写入必须有 `Idempotency-Key`；可并发编辑使用 `expectedVersion`。金额 API 只接受整数分字段，例如 `paidAmountCents`。

### 6.2 可信 Actor

```ts
type ActorContext = {
  adminId: string
  role: "customer_service" | "finance" | "procurement" | "super_admin"
  permissions: string[]
  authType: "wechat" | "web_session"
  sessionId?: string
  sourceClient: "miniprogram" | "admin_web"
  requestId: string
}
```

小程序适配器由真实 WXContext 解析 actor；Web BFF 由会话解析 actor。业务服务必须再次校验权限和系统级规则。

### 6.3 渐进迁移顺序

1. 固化旧入口 contract、错误和回归样例。
2. 建立 `authorization`、`errors`、`idempotency`、`syncEvent` 基础能力。
3. 上线只读 BFF 与管理员会话。
4. 抽取完整 `orderReviewService`，先让旧入口调用，再开放 Web。
5. 同样迁移 `paymentService`。
6. 适配 `shipmentService` 与 `afterSaleService/refundService`。
7. 迁移商品、人工库存与分析。
8. 每完成一个模块，加入事务 outbox 和双端回归，不一次性重构所有云函数。

## 7. 桌面布局与设计系统

- 侧栏展开 240px、收起 72px；顶栏 64px。
- 1366px 宽时内容边距 16px，1440/1920px 为 24px。
- 1180px 以下默认收起侧栏；平板横屏筛选区换行。
- 表头和高频筛选固定，详情抽屉 720-880px。
- 页面区域不做浮动卡片；卡片只用于指标、重复条目、弹窗和真正的工具面板。
- 桌面后台圆角以 6-8px 为主，保留沙漠金、奶油白与语义色，但不做营销式大标题。
- 表格、筛选、分页、确认弹窗、loading、空状态、错误重试和同步状态必须完整。

## 8. 构建与部署

本地脚本：`dev`、`typecheck`、`lint`、`test`、`test:e2e`、`build`、`preview`。

测试部署建议：

1. 用户明确确认独立测试 CloudBase 环境及用途。
2. 小程序体验版与 Web 测试版共同连接同一套测试业务库。
3. Web 静态资源使用 HTTPS 托管并配置 SPA fallback。
4. `/api` 同源转发到测试 BFF，Cookie、CORS、CSRF 和安全来源只允许测试域名。
5. 服务端密钥、Cookie 签名密钥、密码哈希参数不进入 `VITE_*`。
6. 本轮不部署正式环境，不导入正式数据。

云函数测试环境至少配置：

```text
ADMIN_WEB_ENV
ADMIN_WEB_ALLOWED_ORIGINS
ADMIN_WEB_TOKEN_PEPPER
ADMIN_WEB_PASSWORD_PEPPER
ADMIN_WEB_ACTION_SECRET
SYNC_CURSOR_SECRET
SYNC_OWNER_PEPPER
SYNC_CLEANUP_SECRET
```

首次凭证初始化才临时启用 `ADMIN_WEB_ALLOW_BOOTSTRAP` 与一次性 `ADMIN_WEB_BOOTSTRAP_SECRET`；初始化完成后立即关闭并轮换。所有 secret 不少于 32 字符，不进入 Web 构建或仓库。

部署前核对索引：`admin_web_credentials(loginIdHash,status)`、`admin_web_sessions(accessTokenHash)`、`admin_web_sessions(refreshTokenHash)`、`admin_web_sessions(adminId)`、`sync_events(createdAt,_id)`、`sync_events(expiresAt)`，以及同步 collection fallback 使用的各业务时间字段 + `_id` 复合索引。索引必须在确认的隔离测试环境中创建并记录实际查询计划。

客户端环境变量仅允许：

```text
VITE_APP_ENV
VITE_API_BASE_URL
VITE_REQUEST_TIMEOUT_MS
VITE_REALTIME_MODE
VITE_RELEASE
```

## 9. 风险清单

| 风险 | 当前状态 | 控制措施 |
| --- | --- | --- |
| 现有函数依赖 OPENID | 已确认 | Web Session + BFF + actor adapter |
| auth/permissions 副本漂移 | 已确认 | canonical 源、打包复制、hash 校验 |
| `_callerOpenid` 可伪造边界 | 已确认 | Web 路径禁用；不接受浏览器身份字段 |
| `getAdminUsers` 展开原记录 | 已确认 | 凭证单独集合；响应白名单 |
| 采购完整地址兼容逻辑 | 已发现 | Web projection 明确拒绝；后续修正共享规则 |
| 索引未知 | 未确认 | 测试环境只读盘点后创建版本化索引 |
| 测试环境身份未知 | 未确认 | 部署前人工确认并加环境保护 |
| 实时能力/地域/配额未知 | 未确认 | 游标轮询为基线；watch 仅验证后加速 |
| 全量查询/N+1 | 已发现 | 游标分页、批量查询、性能基线 |
| 大范围重构回归 | 高风险 | 按模块迁移、旧入口适配、每模块回归 |

## 10. 当前实现边界

已完成 `admin-web` 工程、独立 Web 认证、只读 BFF、角色与字段投影、全部第一版管理页面、Web/小程序游标同步客户端及目标云函数的本地实现。HTTP 模式已本地迁移单商品改价、单商品显式上下架、显式批量上架和两个单商品预警值入口，商品分析也已接 canonical 查询；create/edit/batch-tags 及其他未迁移业务 mutation 仍返回 `SERVICE_NOT_MIGRATED`，不会用 mock 数据伪装为生产能力。

尚未创建云端集合或索引，尚未上传云函数、部署 Web、发布小程序或连接生产数据。真实 Cookie/HTTPS 网关、CloudBase 会话、事务性 outbox 全入口、五角色云端字段隔离和 1-3 秒双端同步仍需在隔离测试环境验收。
