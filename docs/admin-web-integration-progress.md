# 网页后台真实数据接入进度

> **2026-07-13 付款与账款只读切片：** canonical `accountQueryService`/`paymentQueryService`、账款旧入口兼容 adapters、BFF `GET /accounts`/`GET /accounts/:id`/`GET /payments`/`GET /payments/:id`、严格 Web DTO、Mock/HTTP 状态筛选和两个只读详情页已本地完成。账款重算、修改、结清、导出、付款确认/驳回及凭证预览继续关闭。当前 16 函数 local-only 保护包 `.codex-cloudfunction-deploy/admin-web-seventeen-functions-guarded-20260713-202500/` 含 149 个 JS、25 个 JSON、0 个禁止目录，manifest 为 `uploadPerformed=false`；真实 CloudBase、索引、上传、部署和双端验证仍未执行。

> **最新状态（2026-07-13 合并发货单只读切片）：** canonical `shipmentQueryService` 已供 Web BFF 和 `shipmentGroups` legacy read actions 复用；BFF `GET /shipments`、`GET /shipments/:id`、严格 Web DTO、Mock/HTTP cursor、合并发货单列表与专用只读详情页已本地完成。该范围不含单订单发货；所有发货写操作与导出在 Real 模式均保持关闭，`merge/ship/edit` 返回 501，未登记的 `cancel/complete/export` 返回 404。该切片使用 14 函数历史保护包；当前候选已扩展为上方 16 函数包。未连接 CloudBase、未创建或验证索引、未上传、未部署、未发布，真实双端测试仍未执行。

> **订单状态补充：** canonical `orderQueryService` 和 `orderReviewService` 已分别承载订单列表/详情与审核/驳回，旧入口保持兼容；不能再写成“订单全部写操作仍 501”。订单备注、Web 取消、发货等剩余动作仍未完整迁移。

> **历史状态（2026-07-12 20:28）：** 商品与库存写切片当时完成 Web `215/215`、后端 `180/180` 等本地验证；对应十一函数包及后续十二/十三函数包均已被当前 16 函数候选范围替代。未连接 CloudBase、未上传、未部署、未发布，真实双端 1-3 秒验证仍未执行。

> **历史状态（2026-07-12 19:13）：** 商品写切片的功能结论仍有效；`188/188` 和 `191343` 十函数包已被上方 20:28 库存写状态替代。未预建 `system_counters`、未验证唯一索引和未做真实双端测试的边界仍有效。

> 创建：2026-07-11  
> 当前阶段：第一、二轮本地基础设施完成；第三轮受控商品/库存写、商品分析、订单列表/详情与审核/驳回、合并发货单列表/只读详情已完成；第四轮付款记录与客户账款只读已完成本地实现，付款审核写入、售后退款和各类财务写入仍未完成。  
> 环境边界：只允许确认后的 `cloud1-d7g4mbc5r2fac4a77` 测试环境；当前未上传云函数、未部署 Web、未发布小程序、未写真实数据。

## 1. 完成条件

最终以用户给出的 25 项验收标准为准，不把“页面已有 UI”“Mock 可操作”“BFF 只读”或“单元测试通过”替代真实数据和双端证据。

## 2. 热循环进度

| 轮次 | 范围 | 状态 | 证据 |
| --- | --- | --- | --- |
| 第一轮 | Mock 审计、云函数映射、认证、同步和五份文档 | 已完成 | A/B/C 审计、五份文档、中心复核 |
| 第二轮 | 真实模式、认证、API、路由、环境、连接状态 | 本地完成，待测试环境验证 | 三条执行线 + 独立安全复审 + 中心回归 |
| 第三轮 | 商品、库存、分析、订单、发货、付款、售后退款 | 进行中；受控商品/库存写、商品分析、订单查询及审核/驳回、合并发货单只读本地完成 | canonical service、旧入口适配、BFF/Web 契约测试；真实 CloudBase/双端未执行 |
| 第四轮 | 权限、一致性、断线、缓存、幂等、构建和回归 | 未开始 | 自动化 + 测试环境记录 |

## 3. 当前权威事实

- 小程序环境 ID：`cloud1-d7g4mbc5r2fac4a77`，来源 `miniprogram/app.js`。
- `admin-web` 默认使用 `test + real`；只有显式 `dev:mock` / `build:mock` 才包含 `MockTransport` 和虚构演示数据。
- `HttpBffTransport` 已实现登录、profile、refresh、退出、通用读取/写入和 sync 契约；login/logout/refresh 串行化，旧代 401 和迟到 refresh 不会覆盖新会话。
- `adminWebAuth` 已完成内部网关 secret、严格 Origin、凭证唯一性、凭证与 `authVersion` 事务、会话撤销确认和密码轮换并发保护的本地实现。
- `adminWebApi` 已完成严格路由、固定设置文档、角色字段投影、客户字段二次脱敏和安全 OPTIONS 边界；客服订单/售后 DTO 不含金额。
- `adminWebApi` 已能按角色读取真实集合并做 DTO 投影；受控商品写、库存预警/人工调整和订单审核/驳回已接入共享 service，付款记录与账款安全只读也已接入 canonical query service。付款确认/驳回、账款重算/结清/导出、售后、退款等 mutation 继续返回 `501 SERVICE_NOT_MIGRATED`；发货已登记的 `merge/ship/edit` 返回 501，未登记的 `cancel/complete/export` 返回 `404 MUTATION_NOT_SUPPORTED`。
- `updateProductWarningStock` 已改为旧小程序薄适配器，与 Web BFF 共用 `cloudfunctions/common/services/inventoryWarningService.js`；旧 event 和 `{ok,data}` / `{ok:false}` 返回保持兼容。
- `updateProductPrice` 已改为旧小程序薄适配器，与 Web BFF 共用 `cloudfunctions/common/services/productPriceService.js`；Web 使用严格 version/旧价格/幂等合同，旧入口只保持旧参数和返回兼容。
- `manageProduct.create/update` 已改为 `productWriteService` 兼容适配器；`delete/bulkActivate` 与 `getUnsoldProducts/deactivate` 继续共用 `productStatusService`。legacy create/update 不强制版本/幂等，缺货自动下架仍未统一。
- 人工库存调整已通过 canonical `inventoryMutationService` 本地接通严格详情与两个调整入口；服务端按当前库存处理 delta 并写既有库存日志/预警，导入仍未迁移。
- 订单列表/详情由 canonical `orderQueryService` 提供，审核/驳回由 `orderReviewService` 提供；`getOrders`、`adminReviewOrder` 保持兼容 adapters，真实 CloudBase 事务与双端验证未执行。
- 合并发货单列表/详情由 canonical `shipmentQueryService` 提供，`shipmentGroups` 保留 legacy read adapters；Web 只消费严格 DTO。单订单发货未接，所有发货写/导出均关闭；`merge/ship/edit` 返回 501，`cancel/complete/export` 返回 404。
- 单商品预警值写入在同一事务内比较 `expectedVersion` 与 `expectedWarningThreshold`，并更新商品、库存预警记录、库存日志和最小化 `sync_events` 事件；事务失败不返回伪成功。
- 商品分析已由 `cloudfunctions/common/services/productAnalyticsQueryService.js` 提供 canonical 查询：Web `adminWebApi` 调用 `getOverview()`，小程序 `adminDashboard` 调用 `getProductDetail()`。
- Web 商品分析仅 active `procurement/super_admin` 且需 `product:analytics:view`；销售额摘要只给 `super_admin`，库存变化还需 `inventory:view`。小程序保留既有可分配权限兼容。
- 聚合按上海时区、前一等长周期、有效订单快照毛额处理；全额退款排除，部分退款不冲减。报价与库存序列只来自真实日志，并使用 `createdAt + _id` 稳定游标、扫描上限和 fail-closed 数据校验。
- 仓库没有已确认可用的 Web 测试 BFF URL/同源网关配置。
- 设置读取已修正为 `settings` 集合的 `_id=system_settings` 固定文档；公开 ID 固定为 `system`，其他 ID 和列表枚举被拒绝。
- `getAdminDashboardStats` 的缓存键未包含角色/权限，不能直接作为 Web 共享查询服务复用。
- `sync_events` 目前由单商品预警值、商品改价、显式上下架、显式批量上架和批量公开标签共享 service 在业务事务内写 outbox；两个批量动作均按商品逐项事务。其他业务写入口尚未覆盖，因此仍不能宣称事务性 outbox 已完成。

## 4. 模块状态

| 模块 | UI | 真实读取 | 真实写入 | 双端验证 |
| --- | --- | --- | --- | --- |
| 认证 | 完成 | 本地代码和安全复审通过；真实管理员/BFF 未部署 | login/refresh/logout/bootstrap 已实现 | 未执行 |
| 工作台 | 完成 | BFF 代码可读真实统计 | 不适用 | 未执行 |
| 商品/库存 | 完成一个受控子集 | BFF 可读严格列表/详情；商品 create、metadata-only edit、改价、上下架、批量公开标签、预警值和人工库存调整本地完成 | 导入、批量预警等仍未迁移；真实 CloudBase/双端未执行 | 未执行 |
| 导入 | 完成 | 未完整接入 | 501/Mock 预览 | 未执行 |
| 商品分析 | 完成 | canonical 查询本地接通；真实 CloudBase 未验证 | 不适用 | 未执行 |
| 订单 | 本地完成列表/详情与审核/驳回 UI | canonical 查询关联订单、明细、客户上下文并按角色脱敏 | 审核/驳回本地完成；备注、Web 取消等仍未迁移 | Mock 浏览器通过；CloudBase/双端未执行 |
| 发货 | 本地完成合并发货单列表/专用只读详情 | canonical 查询关联 groups/items/orders/logs，严格 DTO 和稳定游标 | 所有发货写/导出均关闭；已登记动作 501、未登记动作 404；单订单发货未接 | 本地契约/UI 完成；CloudBase/双端未执行 |
| 付款 | 未完成 | 仍为通用 `payment_records` 投影，未解决当前付款状态归并 | 确认/驳回/导出关闭 | 未执行 |
| 账款 | 本地完成只读列表/详情 | canonical `accountQueryService`、稳定游标、严格 DTO、订单/流水受限关联 | 重算、修改、结清、导出关闭 | CloudBase/双端未执行 |
| 售后/退款 | 完成 | BFF 代码可读真实集合 | 501 | 未执行 |
| 管理员/日志/设置 | 完成 | 管理员/日志部分可读；设置固定文档已修正 | 501 | 未执行 |
| 实时同步 | 完成基础层 | 未部署 | outbox 未覆盖全部写入口 | 未执行 |

## 5. 第一、二轮完成记录

- [x] 完成 `docs/admin-web-data-audit.md`，覆盖 21/21 个路由与当前构建产物。
- [x] 完成 `docs/admin-web-api-mapping.md`，覆盖 Web 页面、真实集合、小程序入口、共享 service 和索引候选。
- [x] 创建 `docs/admin-web-integration-plan.md`。
- [x] 创建 `docs/admin-web-realtime-test.md`。
- [x] 创建本进度文档。
- [x] 中心智能体合并 A/B/C 结论并冻结第二轮改动范围。

- [x] 默认构建切换为 `test + real`；Mock 仅保留显式开发入口，真实失败不回退 Mock。
- [x] 无 BFF 代理时返回结构化 `503 BFF_PROXY_NOT_CONFIGURED`，登录页保持可访问。
- [x] 内部网关要求服务端注入 `X-Admin-Action-Secret` 和允许的 `Origin`；secret 不使用 `VITE_*`，也不进入浏览器产物。
- [x] 修复 refresh/logout/relogin Cookie 顺序、旧代 401、即时本地退出和原幂等键重放。
- [x] 专用 `403 CSRF_VALIDATION_FAILED` 只失效当前代会话；迟到旧代错误和普通 `403 FORBIDDEN` 不清理新会话。
- [x] 修复凭证初始化、轮换、唯一性、并发旧密码登录和会话撤销失败语义。
- [x] 修复客服金额投影、伪脱敏地址、手机号变体、OPTIONS、错误码和宽松路由。
- [x] 金额 DTO 仅在源字段为有效整数分时返回；缺失/非法值省略并显示 `-`，真实 `0` 保留为 `¥0.00`。
- [x] 独立安全复审经历两次退回；最终代码层未发现 P0/P1。

## 6. 第三轮业务切片

### 6.1 单商品库存预警值

- [x] 三路只读审计比较商品、库存、Web 契约和权限边界，选择不改变真实库存或金额的单商品预警值作为首迁动作。
- [x] 新增 canonical `inventoryWarningService`，Web actor 只来自已校验会话，小程序 actor 只来自 `WXContext` 权限适配器。
- [x] Web 请求正文固定为 `{id, warningThreshold, expectedWarningThreshold, reason?, expectedVersion}`；幂等键只从 `Idempotency-Key` header 读取。
- [x] 仅 active `procurement`（具 `inventory:set_warning`）和 `super_admin` 可执行；`finance`、`customer_service`、普通用户及注入权限均被服务端拒绝。
- [x] 同事务写 `products`、`stock_alert_records`、`inventory_logs` 和 `sync_events`；outbox 不携带库存数值或 openid。
- [x] 增加旧 writer 兼容守卫：即使旧批量预警或商品编辑没有递增 `version`，Web 也会比较原预警值并拒绝静默覆盖。
- [x] Web 真实模式只启用两个单条 `set-warning` 按钮；网络失败和幂等处理中保持原 key，只有明确版本冲突且刷新成功后才轮换 key。
- [x] 独立复审发现并修复预警值操作可能归一化回写真实库存的 P1：持久化库存异常时安全返回 `409 DATA_STOCK_INVALID` 且事务零写入；正常路径使用显式更新白名单，`products.stock` 不会被本操作改写。

该切片完成时的历史本地回归为：Web `81/81`、`adminWebApi` `49/49`、`adminWebAuth` `24/24`、`updateProductWarningStock` `24/24`、`getSyncEvents` `11/11`、`cleanupSyncEvents` `2/2`；TypeScript、ESLint、相关 JS 语法检查和当时的三函数临时打包 dry-run 通过。该结果只证明当时范围，已被后续商品分析改动扩展，不能作为当前最终发布包证据。

2026-07-11 P1 修复后的早期版本曾完成 Web 测试、TypeScript、ESLint、Mock/Real build、32 个生产 JS 语法检查、9 个 JSON 解析和 dry-run 打包，且 `uploadPerformed=false`。该旧包早于商品分析、改价和显式上下架切片，现已过期，只能作为历史记录，禁止作为部署包使用。

本地浏览器回归只作为 UI/契约局部证据：真实模式登录页显示未配置 BFF 的 fail-closed 提示；Mock 模式可用虚构采购账号验证预警值交互。商品分析页已验证 7/30/90 天切换、当前售价列和图表 canvas；1280x720、1024x768 无横向溢出，390x844 商品分析页已修复到 `scrollWidth === clientWidth === 375`。这些操作均未访问 CloudBase、未写测试库，不能替代真实双端验收。

该预警值切片当时仍未完成九函数目标包生成；当前最终包已由 6.5 节记录，但上传仍未执行。真实 CloudBase 事务/索引、测试 BFF、真实管理员登录、Web 修改后小程序刷新、小程序旧入口修改后 Web 刷新及 1-3 秒延迟测量至今仍未完成。旧 `manageProduct` 若在 Web 成功后提交更早的整商品快照，仍可能反向覆盖阈值；彻底消除需要后续把所有 `warningStock` writer 迁移到 canonical service/版本守卫。本切片写入 `inventory_logs`，但操作日志页只读 `admin_operation_logs`，跨日志聚合尚未接入。

第二轮基线回归结果：Web Vitest `58/58`、`adminWebAuth` `24/24`、`adminWebApi` `35/35`、`getSyncEvents` `11/11`、`cleanupSyncEvents` `2/2`；TypeScript、ESLint、27 个目标 JS 的 `node --check`、Mock build、Real build 均通过。该结果是历史基线，不是当前十函数目标切片的最终证据。

### 6.2 商品分析 canonical 查询

- [x] Web `GET /analytics/products` 通过 `adminWebApi` 调用 `getOverview()`；小程序 `adminDashboard -> getProductAnalytics` 调用同一服务的 `getProductDetail()`。
- [x] 上海时区边界、7/30/90 天、Web 前一等长周期环比、全额退款排除、部分退款不冲减、真实 `price_logs/inventory_logs` 已固化为查询规则。
- [x] 单品详情仅扫描当前周期；所有分页按 `createdAt + _id` 稳定游标并设置行数/查询次数上限。
- [x] 重复库存流水按 `_id` 或 `businessKey` 防重；同一防重键内容冲突返回 `422 ANALYTICS_DATA_INVALID`，集合缺失/超限/查询异常映射为安全 503。
- [x] BFF 严格拒绝损坏数组、时间戳和非安全整数；前后端增长率统一为百分数值，前期为 0 时返回 `null`。
- [x] Web 页面保持旧数据防抖，相关同步事件 250ms 合并刷新，并在页面可见且非加载中时每 60 秒静默兜底刷新；390px 商品分析页横向溢出已修复。

商品分析切片当时的历史本地回归为：Web `106/106`、`adminWebApi` `58/58`、`adminWebAuth` `24/24`、`adminDashboard` `4/4`、`updateProductWarningStock` `24/24`、`getSyncEvents` `11/11`、`cleanupSyncEvents` `2/2`；typecheck、ESLint、当时的 JS 检查和 Mock 后 Real(test) build 通过。该证据早于商品改价、最新 UI/Mock 幂等修复和显式上下架切片，不能作为当前最终发布证据。

当时的六函数 guarded 包和七函数中间包均已过期，不得部署。`scripts/package-admin-web-cloudfunctions.ps1` 已在显式上下架回归后生成新的九函数 guarded 包；包证据见 6.4 节。

所有旧 dry-run，包括名称中带 `final` 的六函数包与七函数中间包，都不得部署。

仍未完成：真实 BFF 的 HTTPS/Cookie/CORS/CSRF、CloudBase 事务冲突、`admin_web_credentials(adminId,status)` 查询计划、真实角色字段矩阵和双端数据同步。

### 6.3 单商品改价

- [x] 新增 canonical `productPriceService`，Web 与旧小程序 `updateProductPrice` 共享服务端改价规则。
- [x] Web 只开放 `products/change-price`；active `procurement/super_admin` 需 `product:update_price`，并强制 CSRF、`Idempotency-Key`、`expectedVersion` 和 `expectedPriceCents`。
- [x] 权威售价固定为整数分 `products.price`；BFF 商品 DTO 不再优先读取 `salePrice/unitPrice`。
- [x] 同一事务更新 `products.price/version`，写 `price_logs` 和最小 `sync_events`；相同售价 no-op 零写，提交后幂等状态滞后可由价格日志恢复。
- [x] Web 成功 DTO 严格校验 `productId/afterPrice/version/changed/isActive`；Real 模式的 create/edit/toggle-status/batch-enable/batch-tags 当时继续 501。
- [x] 390px 弹窗裁切已修复；保存中禁用表单；相同 payload 失败重试复用旧 key，payload 或 `expectedVersion` 改变后换新 key。

该切片只有本地自动化、静态和 Mock 浏览器证据。未连接 CloudBase、未写测试数据、未完成小程序与 Web 双端同步，不得写成“真实改价已验收”。

### 6.4 单商品显式上下架

- [x] 合同锁定：`id/isActive/expectedIsActive/expectedVersion/reason`；显式 set，不做读取后 toggle。
- [x] 权限与安全锁定：`product:update_status`、CSRF、`Idempotency-Key`，actor 只能来自服务端校验后的 Web session 或 WXContext。
- [x] 一致性锁定：`products`、`admin_operation_logs`、`sync_events` 同事务；目标状态未变化时不递增 version、不写日志或事件。
- [x] 完成 canonical `productStatusService`、Web 仅 `products/toggle-status`、BFF 商品/成功 DTO 的布尔 `isActive` 严格校验与前端冲突恢复。
- [x] 将 `manageProduct/delete` 与 `getUnsoldProducts/deactivate` 改为薄适配器并完成旧入口 contract 回归。
- [x] 该单商品切片当时的后端定向回归为：`manageProduct` `14/14`、`getUnsoldProducts` `3/3`、`adminWebApi` `82/82`，合计 `99/99`；变更 JS `node --check` `20/20`。
- [x] 当时生成的 `.codex-cloudfunction-deploy/admin-web-nine-functions-guarded-20260712-132947/` 已被后续批量上架和幂等冲突修复淘汰，现为过期包，禁止部署。

该单商品切片当时明确不含 `batch-enable/create/edit/batch-tags`；这些动作后来均已在后续切片迁移。`manageProduct.update` 也已由 `productWriteService` 收口，缺货自动下架仍为未统一路径。该阶段 Web `132/132` 只是历史计数，不能作为当前最终回归证据。

### 6.5 商品显式批量上架

- [x] Web 新增 `POST /products/batch-enable`，固定 `isActive=true`，只接受最多 100 个原始 `items[{id,expectedIsActive,expectedVersion}]`；原始数量在去重前校验，101 个重复项也会被拒绝。
- [x] 入口强制有效 Web session、`product:update_status`、CSRF 与 `Idempotency-Key`；同 key 同 payload 支持结果重放/恢复，同 key 异 payload 仅返回 `IDEMPOTENCY_KEY_CONFLICT`，不会覆盖原 success/processing 记录。
- [x] canonical `productStatusService` 按商品逐项事务执行并允许部分成功；每个实际变化商品同事务写 `products`、`admin_operation_logs`、`sync_events`，no-op 零业务写。响应只含安全计数和 `{id,code}` 失败项。
- [x] 小程序 `manageProduct.bulkActivate` 已成为同一 service 的兼容薄适配器；旧 `productIds` 和缺失幂等 key 的调用仍保持兼容。跨页全选继续加载时保留未渲染页 ID，批次按当前快照提交，冲突不覆盖。
- [x] 最终本地回归：Web 全量 `137/137`；后端 `manageProduct 31/31`、`adminWebApi 90/90`、`getUnsoldProducts 3/3`，另有 `updateProductPrice 17/17`、`updateProductWarningStock 24/24`，相关后端合计 `165/165`；Mock transport `16/16`；小程序逻辑 `5/5`。`vue-tsc`、ESLint、JS 语法和 UTF-8 replacement-char 扫描通过。
- [x] 浏览器局部证据：Mock 混选 active `DEMO-101` 与 inactive `DEMO-103`，页面明确提示“按当前版本”“冲突不覆盖”，提交后显示“已上架 1 个商品”，刷新后 `DEMO-103` 为在售；390x844 无横向溢出，Mock/Real 控制台无 warn/error，Real 登录页可访问。
- [x] 最终九函数 guarded 包为 `.codex-cloudfunction-deploy/admin-web-nine-functions-guarded-20260712-145328/`：9 个函数、66 个 JS、15 个 JSON、0 个禁止目录，`uploadPerformed=false`。四份 `productStatusService` SHA256 均为 `0E537352A1336D191A7865FEF449B8EBAB231972DCAF0C6FA9029998FF1DF0A7`；canonical idempotency SHA256 为 `CC88961F31A619414F00BEC68BF59E1E6822BE627E5147AB15FFF3FDC210C974`。

该阶段没有连接 CloudBase、没有执行真实事务或数据写入，也没有上传、部署或发布。Web 批量上架后小程序刷新、小程序批量上架后 Web 刷新及在线 1-3 秒延迟均未执行；create/edit、batch-tags 与 `manageProduct.update` 后来已迁移，缺货自动下架至今仍不在已迁移范围。

### 6.6 商品批量公开标签

- [x] Web `products/batch-tags` 只允许 `新货/瑕疵/热销`，使用显式 `present` 与 `expectedVersion + expectedPresent`，原始 items 去重前上限为 100；重复一致快照去重，冲突快照整请求拒绝。
- [x] `productTagService` 严格公开模式只写 `tags/isNew/isDefective/isHot/tagUpdatedAt/tagUpdatedBy/updatedAt/version/searchText`；保留 `internalTags/isFrequent/defectDescription` 原值并将其排除在 change detection 之外，异常内部标签不阻断公开写，no-op 零业务写。
- [x] 每个变化项在同一事务写 `products/product_tag_logs/admin_operation_logs/sync_events`；no-op 不写四个业务集合，事件只用于失效通知且不携带标签值。
- [x] canonical 幂等支持相同 key 重放、异 payload 冲突不污染、processing 结果按确定性 `businessKey` 恢复；部分失败只返回安全 `{id,code}`。
- [x] 小程序旧 `batchUpdateProductTags` 已改为薄适配器，保留公开/内部标签和原返回结构；旧 200 项上限恢复为按清洗去重后的唯一商品数计算，Web 仍按去重前原始最多 100 项计算。独立 `updateProductTags`、导入与推荐区函数未迁移；`manageProduct.update` 已由后续 `productWriteService` 收口。
- [x] Mock `batch-tags` 使用后端式权限门禁：`super_admin` 可用，`procurement` 还必须具备 `product:tag:batch_update`，`finance/customer_service` 禁止；Mock list/get 商品 DTO 与真实 BFF 对齐，Web failure code 和嵌套字段严格验证。
- [x] 该标签切片当时的 Web `215/215`、后端定向 `180/180`、TypeScript、ESLint、构建和资产扫描均通过；这些是历史证据，不是合并发货单切片的最终数字。
- [x] 2026-07-13 付款与账款只读切片保护包已生成：16 个函数 local-only 包 `.codex-cloudfunction-deploy/admin-web-seventeen-functions-guarded-20260713-202500/`，149 个 JS、25 个 JSON、0 个禁止目录，`uploadPerformed=false`；此前十六函数包不再是当前候选。

本切片仍没有连接 CloudBase、执行真实数据写入、上传云函数、部署 Web 或发布小程序。Web create/edit 后小程序刷新、小程序 `manageProduct` 写后 Web 刷新及在线 1-3 秒延迟均为“未执行”；独立 `updateProductTags` 和其他业务模块仍保持既有边界。

## 7. 部署与风险边界

- 任何云函数上传、测试网关变更、数据库集合/索引创建和真实写用例前，都需要按项目高风险规则明确确认范围并准备回滚。
- 测试环境未确认、HTTP 网关未配置或 secret 不完整时必须 fail closed，不得回退 Mock。
- 未迁移写服务的页面按钮继续禁用或明确提示，不得显示伪成功；当前本地例外是单商品改价、显式上下架、显式批量上架、批量公开标签和两个单商品预警值入口。
- 真实双端用例未完成前，不得写“实时同步已通过”。
- 本轮 canonical 幂等冲突修复只随 guarded 包进入 `adminWebApi`、`batchUpdateProductTags`、`getUnsoldProducts`、`manageProduct`、`updateProductPrice`、`updateProductWarningStock`；其他旧云函数仍有独立 helper 副本，部分保留冲突持久化旧行为，未逐函数审计前不得宣称全仓统一。
- 当前 16 函数候选部署清单按 A-Z 为：`adminDashboard`、`adminGetCustomerAccountDetail`、`adminListCustomerAccounts`、`adminReviewOrder`、`adminWebApi`、`adminWebAuth`、`batchUpdateProductTags`、`cancelOrder`、`cleanupSyncEvents`、`getOrders`、`getSyncEvents`、`getUnsoldProducts`、`manageProduct`、`shipmentGroups`、`updateProductPrice`、`updateProductWarningStock`。当前 local-only 保护包 `.codex-cloudfunction-deploy/admin-web-seventeen-functions-guarded-20260713-202500/` 的 manifest 为 `uploadPerformed=false`；尚未上传云函数、尚未部署 Web、尚未发布小程序。
- 独立 `cloudfunctions/getProductAnalytics` 仍是 legacy 旧实现，会合成 `source: current_product` 报价点；当前小程序源码不走该入口，本轮不部署也未迁移。
- `cancelOrder` 已完成本地事务回补、付款/发货保护和账款重算可重试修复；真实 CloudBase 与双端验收仍保持阻断。
