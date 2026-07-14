# 网页后台 Mock 与硬编码业务数据审计

> **2026-07-13 付款与账款只读切片更新：** `/accounts` 已由 canonical `accountQueryService` 提供真实 `customer_accounts` 列表、受限 `account_logs/orders` 详情；`/payments` 已由 canonical `paymentQueryService` 提供 `payment_records` 严格安全列表/详情 DTO。BFF 专用路由、Mock/HTTP 状态筛选、稳定游标和付款只读详情已本地完成；账款重算、修改、结清、导出、付款确认/驳回及凭证预览继续关闭。最终 16 函数 local-only 保护包 `.codex-cloudfunction-deploy/admin-web-seventeen-functions-guarded-20260713-202500/` 包含 149 个 JS、25 个 JSON、0 个禁止目录，`uploadPerformed=false`；真实 CloudBase、索引、上传、部署和双端验证均未执行。

> **2026-07-13 合并发货单只读切片更新：** Web 已通过 canonical `shipmentQueryService` 和 `shipmentGroups` legacy read adapters 复用现有 `shipment_groups`、`shipment_group_items`、`shipment_logs`、`orders`；BFF 已提供专用 `GET /shipments`、`GET /shipments/:id`，Web 使用严格 DTO、稳定游标，并完成 Mock/HTTP cursor 对齐、合并发货单列表和专用只读详情页。该范围不包含单订单发货；所有发货写操作与导出在 Real 模式均保持关闭，其中已登记的 `merge/ship/edit` 返回 `501 SERVICE_NOT_MIGRATED`，未登记的 `cancel/complete/export` 返回 `404 MUTATION_NOT_SUPPORTED`。该切片使用 14 函数历史保护包，当前候选已扩展为 16 函数包；真实 CloudBase 查询、索引、上传、部署和双端验证均未执行。

> **2026-07-13 订单切片更新：** HTTP 模式订单列表与详情已改用 canonical `orderQueryService`；订单审核/驳回也已通过 canonical `orderReviewService` 本地接通并保留旧入口兼容。订单备注、Web 取消、发货等其余动作仍未形成完整闭环，真实 CloudBase 与小程序双端验证仍未执行。

> **2026-07-12 库存写切片历史结论：** 当时 HTTP 模式已本地迁移 `GET /inventory/:id`、`POST /inventory/adjust` 和 `POST /inventory-alerts/adjust`，并完成 Web `215/215`、后端 `180/180` 等本地验证；当时的十一函数包现已过期，不能作为当前部署候选。真实 CloudBase 和双端测试仍未执行。

> **历史商品写切片记录：** 商品详情、创建和 metadata-only 编辑的结论仍有效；其中 `188/188` 与 `191343` 十函数包是当时证据，已被上方库存写切片的新计数与十一函数包替代。

> 初始审计时间：2026-07-11；当前事实补充：2026-07-13。  
> 审计性质：第一轮只读代码审计，后续按已完成或已锁定的业务切片更新当前状态；始终未连接 CloudBase，未读取或写入测试/生产数据。  
> 主范围：`admin-web/src/**`、`admin-web/public/**`、前端根配置与当前构建产物。  
> 只读对照：`cloudfunctions/adminWebApi/**`、现有 `docs/web-admin-*.md` 与 `docs/realtime-sync.md`。  
> 结论口径：下文“已支持”只表示本地代码存在对应读取契约，不表示已部署、已连通测试环境或已通过双端验证。

## 1. 结论摘要

1. 初始审计发现的“缺省配置下全站使用 `MockTransport`”已修复。当前默认命令固定使用 `test + real` 和 `HttpBffTransport`；只有显式 `dev:mock` / `build:mock` 才启用 Mock。本文第 3、5 节仍保留部分初始风险链作为历史证据，不能再当作当前运行结论。
2. HTTP 模式已有统一 BFF transport，登录、profile、工作台、商品、库存、库存预警、订单、付款、账款、发货、售后、退款、管理员、操作日志、设置和同步的读取路由已存在。证据：`admin-web/src/services/transport/http-transport.ts:24-91`、`cloudfunctions/adminWebApi/lib/core.js:1-16`。
3. HTTP 模式已本地接通受控的商品新增/metadata 编辑、改价、状态、公开标签、库存预警、人工库存调整，以及订单审核/驳回；相关入口使用 canonical service 和严格 DTO。付款与账款目前只接通安全只读，确认/驳回、重算、结清、导出等业务 mutation 继续返回 `501 SERVICE_NOT_MIGRATED`；售后、退款仍未迁移；发货已登记的 `merge/ship/edit` 返回 501，未登记的 `cancel/complete/export` 返回 `404 MUTATION_NOT_SUPPORTED`。
4. 商品分析的 Mock 仍是演示数据；HTTP 模式已接入 canonical `productAnalyticsQueryService`，只使用真实订单快照和 `price_logs` / `inventory_logs`，不再返回固定空数组，也不合成假历史。该能力仍未连接真实 CloudBase 验证。
5. 两个导入页没有读取文件内容。当前仅根据文件名是否包含 `invalid/error` 决定是否追加一条错误行，并用 `650ms setTimeout` 模拟解析；HTTP 模式直接禁用。证据：`admin-web/src/modules/imports/mock-import-preview.ts:13-33`、`admin-web/src/modules/imports/ImportView.vue:38-68`。
6. 未发现 `localStorage`、IndexedDB、Cache Storage 或前端 JSON 业务库。`sessionStorage` 仅存 Mock 角色、CSRF token、同步 cursor 和界面密度；Mock 业务行、幂等结果和假事件只保存在当前 JS 内存，刷新页面即重置。
7. 初始默认构建误部署风险已由 Real build fail-closed 和 `verify-real-build` 门禁修复。每次最新 UI、Mock 契约或业务切片变更后仍必须重新执行最终 Real build 和文本资产扫描，不能复用旧 `dist` 证据。
8. 真实模式接口失败不会偷偷回退到 Mock，这一点符合要求，应保留。迁移应按模块显式切换并在失败时展示错误/重试，不能混合真假数据。
9. 本条为 2026-07-12 历史证据；当时的十一函数包已过期。当前验证和部署候选以文首 2026-07-13 记录为准。

## 2. 审计方法与覆盖结果

本次执行了以下静态复核：

- 对 `admin-web/src`、`admin-web/public`、前端根配置搜索 `mock`、`demo`、`fake`、`fixture`、`sample`、`testData`、`setTimeout`、`Math.random`、`hardcode`、`example`、`模拟`、`测试数据`、`假数据`、`localStorage`、`sessionStorage`。
- 从 `router/index.ts` 和 `config/navigation.ts` 反向追踪所有路由到 view、store、transport。
- 从 `mock-data.ts`、`mock-transport.ts` 和 `mock-import-preview.ts` 枚举所有运行时 Mock 字段。
- 用 `adminWebApi/lib/core.js` 的 `RESOURCE_POLICIES` 和 `projectResource` 核对当前真实读取集合与 DTO 投影，不把字段名猜测写成已确认事实。
- 检查 `package.json`、`.env.example`、`env.ts` 和当前 `dist`，核对默认构建是否会启用/包含 Mock。

覆盖统计：

- 导航入口 16 个；另有登录、商品详情、订单详情、403 和 catch-all 404，共 21 个路由表面，均在第 6 节逐项列出。
- `admin-web/src` 当前共 31 个 `.ts`、13 个 `.vue`、3 个 `.css` 和 1 个 `.webp`；视觉图片不是业务数据源。
- `admin-web/public` 文件数为 0。
- 前端根目录 JSON 只有 `package.json`、`package-lock.json` 和 3 个 TypeScript 配置文件，未发现业务 fixture JSON。

## 3. 运行时 Mock 与静态内容清单

### 3.1 会影响运行时业务数据的文件

| 文件与证据 | 内容 | 影响范围 | 迁移判断 |
| --- | --- | --- | --- |
| `src/config/env.ts`、构建 mode | 初始版本缺省选择 Mock；当前默认命令固定 `test + real` | 全站 | 历史风险已修复；继续由 Real build 门禁防止回退 |
| `.env.example`、Vite mode 配置 | Mock 与 Real 使用显式独立 mode | 开发与构建 | Mock 只用于显式演示/测试，不得作为真实失败降级 |
| `src/services/transport/index.ts:1-6` | 全局实例化 `MockTransport` 或 `HttpBffTransport` | 全站 | 统一入口可保留，但真实构建不得默认选择 Mock |
| `src/services/transport/mock-data.ts:8-89` | 11 类硬编码业务行：商品、库存、预警、订单、付款、账款、发货、售后、退款、管理员、日志、设置 | 所有资源页与详情 | 只能用于显式 Mock/组件测试，不能进入真实构建路径 |
| `src/services/transport/mock-transport.ts:21-303` | 假登录、假统计、假图表、内存分页、内存写、假幂等、假同步事件；`batch-tags` 已按后端角色/权限门禁并投影真实商品 DTO | 全站 | 只能用于显式 Mock；不能作为真实失败降级，Mock 权限通过也不能替代 BFF 授权 |
| `src/modules/imports/mock-import-preview.ts:13-33` | 固定报价/库存预览，文件名控制错误行 | 两个导入页 | 必须由服务端解析与预校验结果替代 |
| `src/modules/imports/ImportView.vue:38-97` | 假预览、650ms 假解析、Mock `import-confirm` | 两个导入页 | 需要真实上传、预览、确认三阶段接口 |
| `src/modules/auth/LoginView.vue:13-24` | 默认账号/密码与四个演示账号 | 登录页 | 真实模式已显示普通输入框；真实构建必须关闭 Mock 分支 |
| `src/modules/resources/OperationsView.vue:62-64,107-151` | 只有 Mock 才开放通用 mutation | 11 个资源列表页 | 当前是正确的安全闸；后续应按已迁移服务能力逐项开放 |
| `src/stores/realtime.ts:14,64-104` | Mock cursor 从 `0` 开始；事件内容由 Mock transport 产生 | 全站同步 | 真实模式可走 HTTP cursor，但仍需测试环境验证 |

`src/services/transport/mock-data.ts:6` 的 `MOCK_DATA_NOTICE` 当前未被引用；真正的演示提示来自 `AdminLayout.vue:135,158-160` 和 `LoginView.vue:54-65`。

### 3.2 测试专用 Mock，不是正式运行数据源

- `src/config/access.spec.ts`
- `src/services/transport/mock-transport.spec.ts`
- `src/services/realtime/cursor-sync.spec.ts`
- `src/modules/imports/ImportView.spec.ts`
- `src/modules/imports/mock-import-preview.spec.ts`
- `src/test/setup.ts`

这些文件可以继续使用 fixture，但测试/正式构建必须能证明不会以它们作为业务数据源。

### 3.3 命中但不属于业务 Mock 的定时器与硬编码

| 命中 | 性质 | 是否应删除 |
| --- | --- | --- |
| `OperationsView.vue:87-93` 的 300ms `setTimeout` | 搜索 debounce | 否 |
| `http-transport.ts:116,144` 的 300ms `setTimeout` | 网络/5xx 单次重试退避 | 否 |
| `stores/realtime.ts:11-13,47-61` 的定时器数组 | 轮询、重连退避、更新提示 | 否；需真实验证 |
| `config/navigation.ts`、`config/resources.ts` 的数组 | 导航、列定义、状态文案与动作 schema | 否；不是业务记录 |
| `config/access.ts:9-79` 的 `ROLE_PERMISSIONS` | Mock profile 和前端体验权限矩阵 | 真实模式不得把它当授权真值；真实权限来自 profile/BFF |
| `SettingsView.vue:41-53` 的表单初值 | loading 前的本地表单初值 | 不是数据源；真实加载失败时页面会显示错误 |
| `ResourceDetailView.vue:73-82` 的“最近活动” | 静态安全说明，不是活动日志 | 不应误认为真实时间线 |

未发现 `Math.random`。假图表改用确定性的 `Math.sin/Math.cos`，仍然是假业务数据，证据见 `mock-transport.ts:138-149`。

## 4. Transport、Store 与浏览器存储审计

### 4.1 Transport 方法级来源

| 方法 | Mock 来源 | HTTP 路由 | 当前真实能力 |
| --- | --- | --- | --- |
| `login` | 账号后缀推导角色，密码固定 `demo-pass` | `POST /auth/login` | 本地契约已有；需部署与真实凭证初始化 |
| `logout` | 清内存 profile 和 Mock role | `POST /auth/logout` | 本地契约已有 |
| `getCurrentProfile` | `makeProfile` 生成 | `POST /auth/profile` | 本地契约已有，profile 由 BFF 白名单归一 |
| `getDashboard` | 角色硬编码指标、待办、趋势、排行 | `GET /dashboard` | 基础 count/排行读取已有；趋势和部分金额指标未实现 |
| `getProductAnalytics` | 固定摘要、公式趋势、固定排行 | `GET /analytics/products` | canonical 真实聚合契约已本地接通；仍待 CloudBase 验证 |
| `list(resource)` | `mockRows[resource]` 内存筛选分页 | `GET /:resource` | 11 个资源读取骨架已有 |
| `get(resource,id)` | 内存数组查找 | `GET /:resource/:id` | 商品、库存、订单、合并发货单已有专用详情读取；其他资源仍未真正调用详情读取 |
| `mutate` | 内存改状态/库存/价格/公开标签，按 payload fingerprint 模拟幂等；标签写强制 `super_admin` 或具备 `product:tag:batch_update` 的 `procurement` | `POST /:resource/:action` | 商品受控写、库存预警/人工调整和订单审核/驳回已本地迁移；发货 `merge/ship/edit` 返回 `501 SERVICE_NOT_MIGRATED`，未登记的 `cancel/complete/export` 返回 `404 MUTATION_NOT_SUPPORTED` |
| `catchUp` | 每 3 次调用造一条事件 | `GET /sync/events` | 本地 cursor 契约已有；未云端验证 |

证据：`admin-web/src/types/api.ts:93-108`、`mock-transport.ts:47-251`、`http-transport.ts:24-91`。

### 4.2 Store 数据边界

| Store | 保存内容 | 是否业务真值 | 证据 |
| --- | --- | --- | --- |
| `auth` | 当前 profile、初始化/登录/error 状态 | 否；真实 profile 必须来自 BFF | `src/stores/auth.ts:9-80` |
| `app` | 侧栏折叠与表格密度 | 否，纯 UI | `src/stores/app.ts:6-25` |
| `realtime` | cursor、连接状态、重试次数、最近同步时间 | 否；事件只触发重新查询 | `src/stores/realtime.ts:16-148` |

### 4.3 `sessionStorage` / Cookie / 内存用途

| 键或位置 | 模式 | 内容 | 风险与结论 |
| --- | --- | --- | --- |
| `admin-web.mock-role` | Mock | 四种演示角色之一 | 只用于假会话；真实构建不能出现 |
| `admin-web.csrf-token` | HTTP | CSRF token | 标签页级保存；logout 会清除；不是业务数据 |
| `admin-web.sync-cursor.${appEnv}.${role}` | 两者 | Mock 数字 cursor 或真实 opaque cursor | 不含业务值；当前只按环境+角色分键，后续应评估是否需加入管理员/权限指纹，避免同角色切换账号复用高水位 |
| `admin-web.density` | 两者 | `compact/comfortable` | 纯 UI 偏好 |
| `HttpBffTransport.accessToken` | HTTP 内存 | access token | 不落浏览器持久存储，刷新后依赖 refresh |
| refresh Cookie | HTTP，由同源服务写 | refresh token | 应为 `HttpOnly; Secure; SameSite`，前端代码不可读 |
| `MockTransport.rows/mutationResults/eventLog` | Mock 内存 | 全部假业务行、假幂等结果、假事件 | 页面刷新即重置，绝不能视为持久化测试数据 |

未发现任何 `localStorage` 调用；也未发现浏览器侧长期缓存库存、订单状态、付款、退款、账款或客户敏感信息。

## 5. 正式构建默认 Mock 风险

以下是 2026-07-11 初始审计时的历史风险链条，现已修复，保留用于解释构建门禁来源：

1. `env.ts:4,12`：没有 `VITE_APP_ENV` 时取 `mock`。
2. `env.ts:19`：`mock` 与 `local` 都实例化 Mock。
3. `.env.example:2,5`：示例也显式指定 Mock。
4. `package.json:12`：`npm run build` 只是 `vue-tsc && vite build`，没有模式校验或真实数据开关。
5. 当前 `dist/assets/index-*.js`、`LoginView-*.js`、`ImportView-*.js` 中已查到 `procurement.demo`、`demo-pass`、`演示柔雾唇釉`。

因此初始版本即使命令名叫“production build”，未提供环境变量时产物仍是演示后台。当前实现已落实以下门禁：

- 引入明确的数据模式开关（需求建议为 `VITE_DATA_MODE=real|mock`），与 `VITE_APP_ENV` 解耦。
- `build:test`、`build:staging`、`build:production` 显式要求 `real`；缺少 API/环境配置时构建失败，而不是回退 Mock。
- Mock 只由显式 `dev:mock` 或测试配置启用。
- 构建后增加字符串/模块审计，真实产物出现演示账号、`demo-pass` 或 `mock-data` 即失败。
- 真实 API 失败只显示错误、重试和保留的真实旧缓存，不导入 Mock 数据。

## 6. 逐路由页面数据来源与迁移状态

| 路由/页面 | 默认 Mock 来源 | HTTP 模式当前来源/状态 | 判断与缺口 | 关键证据 |
| --- | --- | --- | --- | --- |
| `/login` 登录 | `makeProfile` + 四个固定账号 | `adminWebAuth` 登录/profile/refresh/logout | 可切真实认证；仍需测试网关、Cookie、CSRF、限流、吊销 | `LoginView.vue:13-35`; `mock-transport.ts:21-67` |
| `/dashboard` 工作台 | `getDashboard` 全部硬编码 | 真实集合 count + `products.totalSales` 排行 | 基础数量可读；`trend=[]`，金额类 Mock 指标没有真实等价实现 | `DashboardView.vue:39-65`; `adminWebApi/index.js:213-266` |
| `/products` 商品 | `mockRows.products`；公开标签 mutation 会更新版本/flags/搜索文本/事件，但 list/get 先投影为真实 BFF 商品 DTO | `products` 安全投影；售价只读权威 `products.price`；DTO 含布尔 `isActive` 和仅公开标签 | 商品新增、metadata-only 编辑、改价、显式上下架、显式批量上架和批量公开标签已接 canonical service；Mock 与真实商品 DTO 均不暴露内部 mutation 字段 | `resources.ts`; `core.js`; `productWriteService.js`; `productPriceService.js`; `productStatusService.js`; `productTagService.js` |
| `/products/:id` 商品详情 | 同一 Mock 行 | `GET /products/:id` -> `products` | 可切真实读取；当前详情只展示列表列，不含价格日志/标签/推荐历史 | `ResourceDetailView.vue:22-42`; `router/index.ts:69-73` |
| `/inventory` 库存 | `mockRows.inventory` | `products` 的库存字段投影和严格详情 DTO | 行级人工库存调整与预警值调整已接 canonical service；导入和独立日志分页仍未迁移，真实 CloudBase 未验证 | `resources.ts`; `inventoryMutationService.js`; `inventoryWarningService.js` |
| `/inventory/alerts` 预警 | `mockRows.inventory-alerts` | `products.stockStatus in warning/out_of_stock` | 可读；Mock 建议文字和真实规则不完全相同 | `adminWebApi/index.js:145-167`; `core.js:5,191-193` |
| `/imports/quotes` 报价导入 | 固定三行/可选错误行 | HTTP 模式禁用 | 需要上传、服务端解析、差异预览、确认、幂等和真实 `price_logs`；不得新建 `product_price_logs` | `ImportView.vue:34-97`; `mock-import-preview.ts:13-17` |
| `/imports/inventory` 库存导入 | 固定三行/可选错误行 | HTTP 模式禁用 | 需要上传、服务端解析、差异预览、确认、幂等和 `inventory_logs` | `ImportView.vue:34-97`; `mock-import-preview.ts:19-27` |
| `/analytics/products` 商品分析 | 固定摘要、公式趋势、固定排行 | canonical `getOverview()` 本地接通 | 只使用真实订单快照与 `price_logs/inventory_logs`；不从商品快照补造历史；仍待 CloudBase 验证 | `ProductAnalyticsView.vue`; `productAnalyticsQueryService.js` |
| `/orders` 订单 | `mockRows.orders`（仅显式 Mock） | `GET /orders` -> canonical `orderQueryService` | 已关联真实订单、明细和客户上下文，稳定游标分页并按角色脱敏；审核/驳回已接 canonical `orderReviewService`，备注等其余写服务仍未迁移 | `orderQueryService.js`; `orderReviewService.js`; `http-transport.ts`; `OperationsView.vue` |
| `/orders/:id` 订单详情 | 合同一致的本地演示 DTO（仅显式 Mock） | `GET /orders/:id` -> canonical `orderQueryService` | 已 join `order_items` 并提供受权限控制的客户、地址、金额、备注、风险字段；付款/履约日志尚未并入详情 | `OrderDetailView.vue`; `order-query-contract.ts`; `orderQueryService.js` |
| `/shipments` 合并发货单 | 合同一致的本地演示 DTO（仅显式 Mock） | `GET /shipments` -> canonical `shipmentQueryService` | 已按 `updatedAt + _id` 稳定游标读取合并发货单，并以严格 DTO 投影状态、计数、脱敏客户和物流摘要；不代表单订单发货已接入 | `shipment-query-contract.ts`; `shipmentQueryService.js`; `http-transport.ts`; `OperationsView.vue` |
| `/shipments/:id` 合并发货单详情 | 合同一致的本地演示 DTO（仅显式 Mock） | `GET /shipments/:id` -> canonical `shipmentQueryService` | 已关联 group items、orders 与受限日志，按权限投影地址、运单和运营备注；页面只读，所有发货写/导出均保持关闭，已登记动作返回 501、未登记动作返回 404 | `ShipmentDetailView.vue`; `shipment-query-contract.ts`; `shipmentQueryService.js` |
| `/payments` 付款审核 | `mockRows.payments` | canonical `paymentQueryService` 读取 `payment_records`，仅返回状态、金额、凭证有无/数量和掩码客户 | 列表/详情只读已接通；不返回凭证 URL，确认/驳回未迁移 | `resources.ts:160-188`; `paymentQueryService.js`; `core.js` |
| `/accounts` 客户账款 | `mockRows.accounts`（仅显式 Mock） | `GET /accounts` -> canonical `accountQueryService` | 列表使用稳定游标和四种权威状态；金额按分投影；详情受限关联 `account_logs/orders` 并有 partial/上限；重算、修改、结清、导出保持关闭 | `accountQueryService.js`; `account-query-contract.ts`; `AccountDetailView.vue` |
| `/after-sales` 售后 | `mockRows.after-sales` | `after_sales` 安全投影 | 列表可读；详情、审核、退货验收和日志未迁移 | `resources.ts:246-277`; `core.js:10,206-207` |
| `/refunds` 退款 | `mockRows.refunds` | `refund_records` 安全投影 | 列表可读；审核金额上限、账户详情和处理写服务未迁移 | `resources.ts:278-308`; `core.js:11,208-209` |
| `/admins` 管理员 | `mockRows.admins` | `admin_users` 最小投影 | 列表可读；新增、改角色、停用必须联动真实认证会话撤销 | `resources.ts:309-337`; `core.js:12,210-211` |
| `/audit` 操作日志 | `mockRows.audit` | `admin_operation_logs` 安全摘要 | 列表可读；当前不返回 raw description/targetId/operatorId；详情尚无专用 DTO | `resources.ts:338-361`; `core.js:13,212-213` |
| `/settings` 系统设置 | `mockRows.settings` | `system_settings/system` 安全投影 | 读取可切真实；保存固定 501；需核对会话配置是否由同一设置权威控制 | `SettingsView.vue:22-94`; `core.js:16,218-230` |
| `/403` | 无业务数据 | 无业务请求 | 纯权限状态页 | `router/index.ts:82-87` |
| catch-all 404 | 无业务数据 | 无业务请求 | 纯路由状态页 | `router/index.ts:88-92` |

补充风险：`OperationsView.vue:318-324` 在 HTTP 模式会禁用所有 row action，包括语义上只读的 `view-log`、`view-ledger` 和 `view`。真实读取接入时需把“查看详情”和“业务写入”能力拆开，不能继续用 `transport.mode` 一刀切。

## 7. Mock 字段到当前真实 DTO/集合的确认映射

下列映射来自当前 `adminWebApi.projectResource`，是“当前代码已确认映射”，不是对数据库历史数据完整性的证明。公共转换：`id <- _id || id`，时间统一转 ISO，金额保持整数分；证据：`cloudfunctions/adminWebApi/lib/core.js:150-165,186-235`。

### 7.1 商品、库存与预警

| Mock/Web 字段 | 当前真实来源 | 差异与风险 |
| --- | --- | --- |
| `id` | `products._id || id` | 内部 ID 只用于请求，不应作为运营文案 |
| `version` | `version ?? dataVersion` | 仅乐观并发；不能替代库存/改价幂等 |
| `sku` | `sku || productCode` | 旧字段兼容已存在 |
| `name` | `name || productName` | 旧字段兼容已存在 |
| `brand` | `brand` | 无品牌时为空字符串 |
| `salePriceCents` | `products.price` | 权威售价为整数分；不再优先读取无真实写入证据的 `salePrice/unitPrice` |
| `isActive` | `products.isActive !== false` | BFF 商品 DTO 已增加该布尔值；状态写显式 set，不做读取后 toggle |
| `status` | `status/draft` + `isActive/status` 归一为 `draft/active/inactive` | 不得把草稿等同下架 |
| `tags` | `tags[]`，最多 20 项 | Mock list/get 已投影为与真实 BFF 一致的公开标签数组；`isNew/isDefective/isHot/searchText` 可留在 Mock 内部 mutation 行，但不进入商品 DTO |
| `stock` | `stock` | 仅有库存权限的管理员可读 |
| `warningThreshold` | `warningStock ?? warningThreshold` | 兼容旧字段 |
| 库存 `status` | `stock`、`warningStock/warningThreshold`、`stockStatus` 计算 | Mock 已存结果，真实值由 BFF重新计算 |
| `lastChange` | `lastStockChangeReason` | 不是 `inventory_logs` 最新一条查询；字段未维护时会空 |
| `suggestion` | BFF 按 `out/low/normal` 生成“尽快补货/关注库存/空” | Mock 包含精确补货数量，真实 DTO 当前不计算补货差额 |
| `updatedAt` | `updatedAt` | CloudBase Date/Timestamp 转 ISO |

证据：`mock-data.ts:9-30`、`core.js:173-193`。

### 7.2 订单

| Mock/Web 字段 | 当前真实来源 | 差异与风险 |
| --- | --- | --- |
| `id`、`version` | `orders._id/id`、`version/dataVersion` | 版本不能替代审核幂等与库存事务 |
| `orderNo` | `orderNo` | 不允许回退内部 ID |
| `customerMasked` | 已有 `customerMasked`，否则由 `customerName/nickname/userName/phone` 脱敏 | Mock 拼接姓名和手机号；真实投影不会返回完整联系方式 |
| `itemSummary` | `itemSummary || productName || productSummary` | 当前 BFF 不 join `order_items`；旧订单缺少冗余摘要时可能为空/不完整 |
| `totalAmountCents` | `totalAmount` | 按整数分展示，不能由 Web 重算最终金额 |
| `status` | `status` | 必须保留现有订单状态机 |
| `paymentStatus` | `paymentStatus` | 上传凭证不等于 `paid` |
| `createdAt` | `createdAt` | 转 ISO |
| 真实 DTO 额外字段 | `deliveryStatus`、`updatedAt`；详情按权限可加 `shippingAddressMasked/adminRemark` | 当前详情 view 只按列表列展示，额外字段未渲染 |

证据：`mock-data.ts:32-36`、`core.js:194-198`。

### 7.3 付款与账款

| Mock/Web 字段 | 当前真实来源 | 差异与风险 |
| --- | --- | --- |
| 付款 `id` | `payment_records._id/id` | 不返回多余 `orderId` |
| `orderNo` | `orderNo` | 无值时保持空，不用内部 ID 冒充 |
| `customerMasked` | 服务端脱敏投影 | 采购无此资源权限 |
| `amountCents` | `paidAmount ?? amount` | 必须以服务端记录为准 |
| `proofLabel` | 是否存在 `paymentScreenshotUrl/screenshotUrls` -> “已提交凭证/无凭证” | 仅存在状态，不是可预览 URL |
| 真实 DTO 额外 `proofCount` | `screenshotUrls.length` 或单图 1 | Mock 没有该字段，当前表格也未展示 |
| 付款 `status` | `paymentStatus || status` | 待确认不能显示为已到账 |
| `submittedAt` | `submittedAt || createdAt` | 转 ISO |
| 账款 `totalOrders` | `orderCount` | Web 只读摘要，详情另列受限订单 |
| `receivableCents` | `totalOrderAmount ?? totalReceivableAmount` | 当前字段优先，旧字段仅兼容回退，脏值 fail closed |
| `receivedCents` | `totalPaidAmount ?? paidAmount` | 不从付款列表前端聚合 |
| `unpaidAmountCents` | `totalUnpaidAmount ?? unpaidAmount` | 不由 Web 计算 |
| 账款 `status` | canonical 归一为 `unpaid/pending_confirm/abnormal/settled` | 暂不使用无明确账期规则的 overdue，也不把客户风险混入财务状态 |

证据：`mock-data.ts:38-46`、`core.js:200-203`。

### 7.4 发货、售后与退款

| Mock/Web 字段 | 当前真实来源 | 差异与风险 |
| --- | --- | --- |
| 发货 `shipmentNo` | canonical `shipmentQueryService` 从 `shipment_groups.shipmentNo` 白名单投影 | 不回退内部 ID；当前页面语义明确为合并发货单 |
| `ordersCount/itemsCount` | 服务端关联并校验 group/order/item 关系后返回计数 | 列表不返回原始订单 ID；详情只返回严格订单/商品摘要 |
| 发货 `customerMasked` | 服务端从关联订单安全投影 | 多订单/客户场景只返回脱敏摘要；完整地址仅在显式 `shipment:view_address_full` 权限下返回 |
| `carrier/trackingMasked` | canonical 服务兼容既有物流字段后投影 | 列表只返回掩码；详情完整运单需对应权限，不能由 finance 通用地址权限继承 |
| 发货 `status` | canonical 六状态白名单 | `created/pending_shipment/shipped/completed/cancelled/abnormal`；未知或损坏数据 fail closed |
| 售后 `caseNo` | `afterSaleNo || caseNo` | Web 名称与集合字段不同但已归一 |
| 售后 `orderNo` | `orderNo` | 无值不回退 ID |
| 售后 `type` | `afterSaleType || type` | 需按既有枚举展示 |
| 售后 `amountCents` | `requestedRefundAmount ?? refundAmount ?? approvedRefundAmount` | 三种金额语义不同；列表申请金额与最终批准上限必须拆清，不能继续模糊回退 |
| 售后 `status` | `afterSaleStatus || status` | 财务不能越权审核售后 |
| 退款 `refundNo` | `refundNo` | 不回退内部 ID |
| 退款 `amountCents` | `refundAmount` | 最终处理仍需校验已付款额和 `approvedRefundAmount` |
| 退款 `method` | `refundMethod` | 列表只显示必要摘要；账户详情需更严格权限 |
| 退款 `status` | `refundStatus || status` | 重复处理必须幂等 |

三类资源的 `id/createdAt/updatedAt/version` 由各投影按需返回；付款/退款 DTO 当前不返回 `version`。证据：`mock-data.ts:48-61`、`core.js:204-209`。

### 7.5 管理员与操作日志

| Mock/Web 字段 | 当前真实来源 | 差异与风险 |
| --- | --- | --- |
| 管理员 `name` | `admin_users.name || nickname` | 仅最小资料 |
| `username` | `username || loginIdMasked` | 不返回凭证 hash 或完整敏感登录标识 |
| `role` | `role` | 合法性仍由服务端角色模型校验 |
| `permissionSummary` | `permissions` 前 5 项连接 | Mock 是中文职责摘要；真实页面可能显示权限 key，需单独格式化但不能扩大权限 |
| 管理员 `status` | `status/disabled` 或 `isActive=false` -> `disabled`，否则 `enabled` | 项目核心规则通常使用 `isActive != false`；需确保历史状态归一一致 |
| `lastLoginAt` | `lastWebLoginAt || lastLoginAt` | 转 ISO |
| 日志 `operator` | `operatorName || operatorRole || 管理员` | 不返回 `operatorId/openid` |
| `action` | `action` | 安全动作名 |
| `targetType` | `resourceType || targetType` | 不返回 `targetId` |
| `summary` | `publicSummary || safeSummary`，否则生成安全占位摘要 | 不返回 raw `description` |
| 日志 `status`、`createdAt` | `status || success`、`createdAt` | 只读投影 |

证据：`mock-data.ts:63-73`、`core.js:210-213`。

### 7.6 系统设置

Mock 与真实投影字段一一对应：

- `id <- _id/id`，缺省 `system`
- `version <- version/dataVersion`
- `enableOfflineQrPayment`
- `enableBankTransfer`
- `enableWechatPay`
- `requirePaymentProofForOfflinePayment`（缺失时为 true）
- `allowMultiplePaymentRecords`
- `maxPaymentScreenshotCount`（至少 1）
- `lowStockDefaultThreshold`（至少 0）
- `sessionIdleMinutes`（至少 5）
- `updatedAt`

风险：这些字段当前由 `system_settings/system` 读取，但付款方式仍有 `payment_methods` 专门模型，Web 设置保存前必须确认权威来源和 `updateSettings/paymentMethods` 既有语义，不能只写一个文档就认为全局配置已生效。证据：`mock-data.ts:75-89`、`SettingsView.vue:22-52`、`core.js:218-230`。

### 7.7 工作台、商品分析、导入与同步的非行式数据

| DTO | Mock 字段/生成方式 | HTTP 当前事实 | 所需真实来源 |
| --- | --- | --- | --- |
| `DashboardData.metrics` | 每角色 4 个固定指标，财务/超管含固定金额 | 当前由权限允许的真实 count 构造，`kind` 目前均为 `number` | 现有集合 count；如增加金额必须单独做财务权限聚合 |
| `DashboardData.tasks` | 固定 3 条待办 | 当前按非零 count 生成 | 现有集合状态 count |
| `DashboardData.trend` | 周一至今日固定 7 点 | HTTP 明确 `[]` | 按角色职责定义真实聚合口径 |
| `DashboardData.topProducts` | 固定 4 商品及变化率 | `products.totalSales` 前 8，`change` 固定 0 | 若要环比需订单明细历史聚合 |
| `ProductAnalyticsData.summary` | 固定销量/均价/报价/商品数 | canonical `getOverview()` 本地接通 | `orders`、`order_items`、真实 `price_logs/inventory_logs` 聚合；仍待真实 CloudBase 验证 |
| `series` | `Math.sin/Math.cos` 公式 | 真实日志时间桶契约已实现 | 不合成当前价历史点；损坏数据 fail closed |
| `ranking` | 固定商品乘区间倍数 | 真实聚合商品投影 | 不返回订单客户信息、操作者或原始日志 |
| 导入预览行 | `row/sku/name/before/after/status/message` 固定数组 | 无 HTTP preview | 服务端解析文件后返回逐行安全校验结果 |
| 同步事件 | 内存 `eventId/entityType/entityId/action/version/changedFields/sourceClient/createdAt/cursor` | `/sync/events` 返回受权限过滤事件 | `sync_events` + 兼容业务源；事件只触发 refetch |

证据：`mock-transport.ts:70-152,233-272`、`adminWebApi/index.js:213-266`、`core.js:237-300`。

## 8. 可直接切换的真实读取模块

以下模块已有本地 HTTP/BFF 读取契约，可作为第二轮优先接入项：

1. 登录、profile、refresh、logout。
2. 工作台基础数量、待办数量和基于 `products.totalSales` 的排行。
3. 商品、库存、库存预警列表；商品详情。
4. 订单、付款、账款、合并发货单、售后、退款、管理员、操作日志列表；订单和合并发货单详情。
5. 系统设置读取。
6. 同步 cursor 拉取。

但“可直接切换”仍须同时满足：

- 确认隔离测试环境与同源 HTTPS 网关；
- 上传/配置认证与 BFF 云函数；
- 用真实测试数据核对字段单位、状态枚举、索引和空字段；
- 做角色字段投影测试；
- 明确错误、loading、空状态和重试；
- 不把读取成功扩大描述成写入或双端同步已完成。

## 9. 必须新增或迁移的后端能力

### 9.1 已迁移与仍待迁移的写操作

mutation permission 表只是权限白名单，不等于业务实现。当前切片和剩余能力如下：

- 单商品改价已迁移到 canonical `productPriceService`：Web 严格提交 `id/newPriceCents/expectedPriceCents/expectedVersion/reason`，服务端以 `products.price` 为准，在同一事务更新商品并写 `price_logs`、`sync_events`；相同售价零写入。
- 单商品显式上下架已迁移到 canonical `productStatusService` 并通过本地回归：Web 合同为 `id/isActive/expectedIsActive/expectedVersion/reason`，同事务写 `products/admin_operation_logs/sync_events`，no-op 零写。`manageProduct/delete` 与 `getUnsoldProducts/deactivate` 已改为薄适配器。
- 显式批量上架已迁移到同一 canonical `productStatusService`：Web `POST /products/batch-enable` 固定 `isActive=true`，严格接收最多 100 个原始 `items[{id,expectedIsActive,expectedVersion}]`，并在去重前校验原始数量；同时强制 session、权限、CSRF 和 `Idempotency-Key`。服务逐项事务执行、允许部分成功，只返回安全计数和 `{id,code}` 失败项；每个实际变化商品同事务写 `products/admin_operation_logs/sync_events`，no-op 零业务写。小程序 `manageProduct.bulkActivate` 已改为同一服务的兼容薄适配器。
- 批量公开标签已迁移到 canonical `productTagService`：Web 原始最多 100 项并逐项提交 `expectedVersion + expectedPresent`；严格公开模式只写 `tags/isNew/isDefective/isHot/tagUpdatedAt/tagUpdatedBy/updatedAt/version/searchText`，不读取、规范化或覆盖 `internalTags/isFrequent/defectDescription`，异常内部标签也不阻断公开标签写。小程序 legacy 入口在清洗去重后按最多 200 个唯一商品校验。
- 商品新增与 metadata 编辑已本地迁移；小程序 `manageProduct.create/update` 已收口。独立 `updateProductTags`、首页推荐、导入和缺货自动下架等 writer 仍需逐项审计；legacy 小程序缺少强制版本/幂等字段的并发风险仍保留。
- 库存导入、批量预警及独立日志分页；行级人工库存调整和单商品预警值已本地接通，调整继续写 `inventory_logs`。
- 订单取消、备注等剩余动作；审核/驳回已本地接通 canonical service，审核通过继续按既有时机扣库存。
- 付款确认/驳回与账款入账。
- 单订单发货，以及合并发货创建、确认、物流编辑、取消、完成和导出；当前仅完成合并发货单读取。
- 售后审核、驳回、退货验收。
- 退款处理/驳回及金额上限、重复处理保护。
- 管理员新增、角色修改、停用及相关 Web session 吊销。
- 系统设置保存。

### 9.2 专用读取/预处理接口

- 报价/库存文件上传、服务端解析、差异预览、错误行与确认导入；`import_records` 当前虽有 BFF policy，但导入页没有使用它。
- 真实商品分析聚合已完成本地 canonical 查询；7/30/90 天口径、真实日志和权限投影仍待 CloudBase 数据与查询计划验证。
- 订单详情的付款/发货/状态日志补充；`order_items` 与必要地址安全投影已本地接通。
- 库存日志与价格日志分页。
- 付款凭证临时授权访问；列表不得返回永久 URL。
- `account_logs` 流水已通过 canonical 账款详情受限接入；受权限控制的账款导出仍未迁移。
- 售后、退款详情与日志；合并发货单详情及受限日志已本地接通，单订单发货详情仍未接；退款账户只在必要步骤按权限返回。
- 操作日志详情安全 DTO（如果产品确需详情），仍不返回 raw identifier/description。

## 10. 不能直接替换的风险清单

| 优先级 | 风险 | 证据/影响 | 下一轮门禁 |
| --- | --- | --- | --- |
| 已修复门禁 | 初始默认构建启用并打包 Mock | 当前已改为 Real build fail-closed | 每次最新变更后仍须重新构建和扫描 |
| P0 | 大部分 HTTP 写操作仍为 501 | 当前仅改价、显式上下架、显式批量上架、批量公开标签和两个预警值入口已本地迁移 | 未迁移动作不得开放或宣称完整后台 |
| P1 | 导入没有解析文件内容 | `ImportView.vue:38-68`、`mock-import-preview.ts` | 必须服务端解析、复核和幂等确认 |
| P1 | 商品分析真实环境数据质量和性能未验证 | canonical 服务仅有本地证据 | 保持 fail closed，完成真实索引、数据和权限验证 |
| P1 | Mock 与真实字段形状仍未全站对齐 | 商品 list/get DTO 已对齐；客户显示、其他资源状态归一和建议文本仍有差异 | 用真实测试记录继续做跨资源 DTO contract test |
| 已修复 | 订单详情未查询 `order_items` | canonical 服务现按订单 ID 分批关联 `order_items`，并兼容旧单商品快照 | 严格详情 DTO 与列表 DTO 分离；真实 CloudBase 大数据量仍需验证 |
| P1 | 付款凭证只有存在状态 | `core.js:200-201` | 新增临时授权预览，严守财务权限 |
| P1 | 售后金额回退混合三种语义 | `requested/refund/approved` | 申请金额、批准金额、可退上限分字段与规则 |
| P1 | 工作台真实实现只是部分契约 | `trend=[]`、金额 Mock 无真实等价 | 页面需接受空趋势，财务聚合单独定义 |
| P1 | 真实 row action 被 mode 一并禁用 | `OperationsView.vue:318-324` | 拆分 read capability 与 mutation capability |
| P2 | 同步 cursor 仅按环境+角色存储 | `realtime.ts:42-45` | 测试同角色切换账号/权限变化是否漏拉，必要时加入 principal 指纹 |
| P2 | `lastChange` 并非查询日志 | `core.js:191-193` | 若产品要求“最近变动”，应从权威日志/快照可靠维护 |

## 11. 第一轮交付边界（历史记录）

- 本文只记录当前代码事实、确认映射和迁移风险。
- 以下“未修改代码”只描述 2026-07-11 第一轮审计当时，不是当前仓库状态；后续已实施认证、Real transport、预警值、商品分析、商品改价、显式上下架、显式批量上架和批量公开标签切片。
- 本轮没有连接测试/生产云环境，没有上传云函数、部署 Web、发布小程序或执行真实数据写入。
- 真实字段完整性、索引命中、Cookie/CSRF、真实角色数据隔离、事务幂等和 1-3 秒双端同步仍需后续在已确认的隔离测试环境验证。

## 12. 后续审计输入

下一轮 API 映射与接入计划应直接引用本文的三个边界：

1. 先修复“默认构建为 Mock”的基础设施门禁，再切任何业务读取。
2. 读取模块可以按资源逐个切换；写模块只有在共享业务服务迁移、权限、状态机、事务、幂等和 outbox 同时就绪后才开放。
3. 每个模块完成后立即做 Web 读/写、小程序反向变化、字段脱敏和同步延迟验证，不能用 Mock 测试代替真实双端结果。
