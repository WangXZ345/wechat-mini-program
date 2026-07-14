# 网页后台测试环境部署与回滚

> **2026-07-13 订单只读部署增量：** 目标函数新增 `getOrders`，并将 canonical `orderQueryService` flatten 到 `adminWebApi/lib/orderQueryService.js` 与 `getOrders/orderQueryService.js`，打包脚本增加 SHA256 一致性门禁。当前唯一候选包为 `.codex-cloudfunction-deploy/admin-web-twelve-functions-guarded-final-20260713-143016/`：12 函数、104 JS、20 JSON、0 禁止目录，订单服务 SHA256 `3A74A12B052C4E135680FD8465DDC2ADF68794F4051532EA6C99A958C0C1AAB8`，`uploadPerformed=false`。订单 mutation 仍不在本轮部署开放范围；未经用户确认不得上传任何函数。

> **2026-07-12 库存写切片历史包（已过期）：** `.codex-cloudfunction-deploy/admin-web-eleven-functions-guarded-20260712-201743/` 含 11 个函数；已被上方十二函数订单只读包替代，不得再作为当前候选部署。

> **历史商品写切片记录：** `191343` 十函数包已被上方 `201743` 十一函数包替代，不得部署。商品 metadata-only 编辑与 `system_counters/product_index` 的部署前置仍然有效。

> [!CAUTION]
> 本文只适用于已由负责人明确确认的隔离测试环境。当前商品写、库存预警、行级库存调整和取消订单库存回补已完成本地实现；对应回归和十一函数打包校验已通过。订单审核、付款、发货、售后、退款等其他 Web 业务写仍按设计返回 `501 SERVICE_NOT_MIGRATED`。本地 Mock、单元测试或内存事务测试不代表 CloudBase 真实验证。CloudBase 集合/索引、双端同步和在线 1-3 秒延迟均未完成真实环境验证。严禁把本文步骤用于生产环境，严禁未经确认上传、部署或发布。

## 1. 当前状态与部署目的

本次测试部署只验证以下基础能力：

- Web 静态构建可在测试 HTTPS 域名加载。
- 同源 `/api` 网关可以转发到管理员认证函数和只读 BFF。
- `admin_users` 仍是管理员身份、启用状态、角色和权限的唯一可信来源。
- Web 会话、字段投影、只读接口、错误边界和事件游标可以在隔离测试环境验证。
- Web `adminWebApi -> getOverview()` 与小程序 `adminDashboard -> getProductDetail()` 共用商品分析 canonical 查询服务，可在同一真实数据集验证时区、退款口径、权限投影和日志数据质量。
- Web `products/change-price` 与小程序 `updateProductPrice` 共用 canonical `productPriceService`，可验证整数分、价格/version 冲突、幂等、`price_logs` 和最小 outbox。
- Web `products/toggle-status`、`products/batch-enable`、小程序 `manageProduct/delete`、`manageProduct.bulkActivate` 与 `getUnsoldProducts/deactivate` 已共用 canonical `productStatusService`，可验证显式 set、状态/version 冲突、逐项部分成功、`admin_operation_logs` 和最小 outbox。
- Web `products/batch-tags` 与小程序 `batchUpdateProductTags` 已共用 canonical `productTagService`，可验证公开标签显式 set、version/presence 冲突、部分成功、事务日志/outbox、Web 严格公开字段写入、legacy 内部标签兼容和字段隔离。
- Web `products/create`、metadata-only `products/edit` 与小程序 `manageProduct.create/update` 已共用 canonical `productWriteService`，可验证整数分、事务日志、标签日志、预警、version、幂等恢复、最小 outbox 和严格字段所有权。
- 小程序可以通过 `getSyncEvents` 执行游标拉取、断线补偿和局部缓存失效。
- `cleanupSyncEvents` 只清理超过保留期的同步事件。

当前不具备完整后台上线条件：

- 当前已完成本地迁移的写入口为 `POST /products/create`、`POST /products/edit`、`POST /products/change-price`、`POST /products/toggle-status`、`POST /products/batch-enable`、`POST /products/batch-tags`、`POST /inventory/set-warning` 与 `POST /inventory-alerts/set-warning`。订单、付款、发货、售后和退款写请求仍应返回 `501 SERVICE_NOT_MIGRATED`。
- 商品分析、商品写、库存预警和库存调整只有在最终十一函数包完整部署、集合前置满足并完成负向安全检查后，才允许在隔离测试数据上验收。
- 不得把 `admin-web` 的 mock 数据、mock 登录、mock 写入或本地 `4173/4174` 服务作为真实环境验收证据。
- 未迁移到共享业务服务的写操作不得通过临时直连旧云函数、浏览器数据库权限或伪造 `openid` 绕过。
- 双端各业务模块的 1-3 秒目标只能在真实隔离测试环境采集时间戳后判定。

## 2. 当前本地证据

以下结果是本地验证证据，不等同于测试环境部署证据：

| 项目 | 结果 |
| --- | --- |
| 历史基线 | 商品分析阶段和显式上下架阶段的旧测试计数、静态检查及旧包曾通过；后续显式批量上架、跨页选择、原始 100 项上限和幂等冲突修复已扩大范围，该证据不能作为当前最终发布依据 |
| 商品改价浏览器局部证据 | Mock 模式改价后列表刷新；390px 弹窗不裁切；保存中禁止改变 payload；幂等 key 随 payload/version 变化正确轮换。未连接 BFF、CloudBase 或小程序 |
| 商品状态后端回归 | `manageProduct 31/31`、`getUnsoldProducts 3/3`、`adminWebApi 90/90`；另有 `updateProductPrice 17/17`、`updateProductWarningStock 24/24`，相关后端合计 `165/165`；Mock transport `16/16`，小程序逻辑 `5/5` |
| 批量上架浏览器局部证据 | Mock 混选 active `DEMO-101` 与 inactive `DEMO-103`，提示按当前版本且冲突不覆盖，结果为上架 1 个，刷新后 `DEMO-103` 在售；390x844 无横向溢出；Mock/Real 控制台无 warn/error；Real 登录页可访问。未连接 BFF、CloudBase 或小程序 |
| 批量公开标签后端回归 | `adminWebApi 99/99`、`batchUpdateProductTags 16/16`，当前切片合计 `115/115`；包含严格公开字段白名单、无关内部字段原样保留、no-op 零写、legacy 去重后 200 上限、角色矩阵、冲突、部分失败、事务回滚和幂等重放/恢复 |
| Web 当前全量回归 | `234/234` 用例通过；`vue-tsc`、全仓 ESLint、Mock build、Real/test build 和 57 个 Real 文本资产扫描通过 |
| 商品写后端回归 | canonical services `28/28`、`adminWebApi 107/107`、`manageProduct 34/34`；包含事务、幂等恢复、patch/no-op、权限、严格 DTO、标签日志和内部事件隔离 |
| 十二函数 guarded 包 | `.codex-cloudfunction-deploy/admin-web-twelve-functions-guarded-final-20260713-143016/`；脚本与独立检查通过，12 个函数、104 个 JS、20 个 JSON、0 个禁止目录，JS/JSON 全部通过，`uploadPerformed=false` |

十二函数 manifest 已确认订单、库存、商品及共享安全实现的部署副本同源；同 key 异 payload 只返回冲突，不得覆盖原 success/processing 记录。分析入口 `timeout=60` 与 `cancelOrder timeout=20` 仍只是运行边界，不代表真实 CloudBase 性能、索引或超时压测通过。

任何交付记录都必须继续区分“本地通过”“已上传测试环境”“真实双端通过”和“生产可用”；当前仅确认第一项。

## 3. 部署前硬门槛

满足全部条件后才能进入测试部署：

1. 负责人书面确认测试 CloudBase 环境标识、用途和数据隔离边界；不能仅根据代码中的环境标识推断。
2. 确认目标不是生产环境，且测试 Web、测试 BFF、小程序体验版指向同一套隔离测试业务数据。
3. 备份上一版静态站点、网关、十个目标云函数、环境变量、触发器、集合和索引清单。
4. 以只读方式盘点现有集合、权限规则、索引、数据量和过期数据；盘点前不创建或修改索引。
5. 建立测试域名、有效 HTTPS 证书和同源 `/api` 网关；禁止使用本地 mock 服务作为部署目标。
6. 服务端 secret 已在受控密钥存储中生成并完成最小授权；构建日志、命令历史和前端产物均不包含 secret。
7. 明确维护窗口、负责人、回滚负责人、上一版版本号和本次 release 标识。

任一项不满足时停止，不采用“先部署再确认”的方式继续。

## 4. 云函数部署清单与打包边界

以下清单严格按目录名 A-Z 排序：

| 云函数 | 部署来源 | 边界 |
| --- | --- | --- |
| `adminDashboard` | 最终十二函数临时输出目录中的 `adminDashboard/` | 小程序商品分析聚合入口；必须包含与 BFF 同 hash 的 canonical `productAnalyticsQueryService` |
| `adminWebApi` | 同一最终临时输出目录中的 `adminWebApi/` | 必须上传临时打包输出，不得直接上传源目录 |
| `adminWebAuth` | 同一最终临时输出目录中的 `adminWebAuth/` | 必须上传临时打包输出，不得直接上传源目录 |
| `batchUpdateProductTags` | 同一最终临时输出目录中的 `batchUpdateProductTags/` | 小程序批量标签薄适配器；必须与 BFF 使用同一 `productTagService`、idempotency、permissions 和 recommend helper |
| `cancelOrder` | 同一最终临时输出目录中的 `cancelOrder/` | 事务内按扣减流水恢复库存并保留账款重算待办；不得绕过原取消条件 |
| `cleanupSyncEvents` | 同一最终临时输出目录中的 `cleanupSyncEvents/` | 必须保留完整函数目录并配置受控定时触发；只清理已过期 `sync_events` |
| `getOrders` | 同一最终临时输出目录中的 `getOrders/` | 旧小程序订单读取兼容入口；必须包含 canonical `orderQueryService` 与 permissions 副本 |
| `getSyncEvents` | 同一最终临时输出目录中的 `getSyncEvents/` | 小程序同步读取入口，必须保留完整嵌套依赖和 canonical sync helper |
| `getUnsoldProducts` | 同一最终临时输出目录中的 `getUnsoldProducts/` | `deactivate` 显式停用薄适配器；缺货自动下架路径仍未统一，不得扩大迁移范围 |
| `manageProduct` | 同一最终临时输出目录中的 `manageProduct/` | `create/update` 为商品写 canonical service 兼容适配器；`delete/bulkActivate` 为商品状态 service 适配器；legacy 缺少强制版本/幂等仍是风险 |
| `updateProductPrice` | 同一最终临时输出目录中的 `updateProductPrice/` | 旧小程序改价入口薄适配器；必须与 BFF 使用同一 canonical `productPriceService` |
| `updateProductWarningStock` | 同一最终临时输出目录中的 `updateProductWarningStock/` | 旧小程序入口薄适配器；必须与 BFF 使用同一 canonical service，不得直接上传未打包代理 |

### 4.1 临时打包规则

`cloudfunctions/adminDashboard/productAnalyticsQueryService.js`、`adminWebApi/security.js`、`adminWebApi/permissions.js`、`adminWebApi/lib/*` 的共享 service proxy，以及各旧入口的 canonical service proxy 是开发期引用。独立部署时相对路径不再可靠，直接上传源目录可能缺失实现，因此禁止这样做。十二个函数必须由同一打包结果生成，保证 order、analytics、price、status、tags、inventory、idempotency、recommend、sync、security 和 permissions 实现一致。

当前已验证 dry-run 目录为：

```text
D:\王希哲\NEW\.codex-cloudfunction-deploy\admin-web-twelve-functions-guarded-final-20260713-143016
```

后续源码变化后必须使用空输出目录，由脚本重新一次生成十二函数：

```powershell
.\scripts\package-admin-web-cloudfunctions.ps1 -OutputDirectory <empty-test-package-directory>
```

脚本必须校验 security、permissions、inventory warning、product price、product status、product tag、product write、recommend、analytics、idempotency、stock alert 和 sync 等 canonical 实现及所有部署副本；`productWriteService` 必须覆盖 `adminWebApi/lib` 与 `manageProduct`，stock alert 也必须覆盖 `manageProduct`。生成后继续检查生产 JS/JSON，并确认排除 `test/`、`node_modules/`；仅有部分函数的中间输出不得作为部署包。

检查 `package-manifest.json`：

- `functions` 必须按 A-Z 恰好包含 `adminDashboard`、`adminWebApi`、`adminWebAuth`、`batchUpdateProductTags`、`cleanupSyncEvents`、`getSyncEvents`、`getUnsoldProducts`、`manageProduct`、`updateProductPrice`、`updateProductWarningStock`。
- manifest 已记录并由最终打包流程校验 security、permissions、inventory warning、product price、product status、product tag、recommend、product analytics、idempotency、stock alert 和 sync canonical hash。
- `analyticsTimeoutSeconds` 必须为 `60`，并记录 `adminDashboardConfigSha256`、`adminWebApiConfigSha256`；源文件与包内共四份 config 的 hash 必须一致。
- `uploadPerformed` 必须为 `false`；脚本只打包，不上传。
- 临时包只能用于本次已确认测试环境，不得上传到生产。

所有早于当前十二函数最终包的 guarded 包均已过期不得部署。当前候选仅为 `.codex-cloudfunction-deploy/admin-web-twelve-functions-guarded-final-20260713-143016/`，且仍需用户明确批准后才能上传隔离测试环境。

上传属于高风险动作。本文件只描述流程，不授权执行；实际上传仍需用户明确确认测试环境和范围。

## 5. Web 构建与同源网关

### 5.1 构建

在 `admin-web/` 使用锁文件安装并验证：

```powershell
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

测试构建只允许以下公开变量：

| 变量 | 测试值原则 |
| --- | --- |
| `VITE_APP_ENV` | 使用 `test`，不能是 `mock` 或 `local` |
| `VITE_API_BASE_URL` | 使用同源 `/api/admin/v1` |
| `VITE_REQUEST_TIMEOUT_MS` | 使用经测试确认的有限超时 |
| `VITE_REALTIME_MODE` | 使用 `polling` |
| `VITE_RELEASE` | 使用不含敏感信息的 release/commit 标识 |

所有 `VITE_*` 都会进入浏览器产物。密码、哈希 pepper、Cookie secret、数据库凭据、云环境管理凭据和清理 secret 一律不得放入 `VITE_*`。

构建产物为 `admin-web/dist/`。发布前检查 source map、构建日志和静态资源中没有 token、secret、真实账号或客户 PII。

### 5.2 测试域名与 HTTPS

- 只使用测试专用域名和有效 HTTPS。
- 静态站点与 `/api` 应同源，避免跨站 refresh Cookie。
- SPA fallback 只能处理前端页面，不能吞掉 `/api` 的 401、403、404、501 或 5xx。
- API 响应不得由 CDN、浏览器或反向代理缓存。
- 保留请求 ID，日志不得记录 Authorization、Cookie、CSRF token、密码或完整 PII。

### 5.3 `/api` 路由

建议网关关系：

```text
https://<test-admin-host>/api/admin/v1/auth/* -> adminWebAuth
https://<test-admin-host>/api/admin/v1/*      -> adminWebApi
```

网关必须正确转发 `Origin`、`Authorization`、`Cookie`、`Set-Cookie`、`X-Admin-CSRF`、`Idempotency-Key` 和请求 ID。外部客户端不得自行设置内部 action/bootstrap secret 头；网关需剥离非受信来源的内部头。

### 5.4 Cookie、Origin、CORS 与 CSRF

- refresh Cookie 必须为 host-only、`HttpOnly; Secure; SameSite=Lax; Path=/`，不得设置 `Domain`。
- access token 只保存在内存；CSRF token 只保存在当前标签页 `sessionStorage`；两者都不得长期写入 `localStorage`。
- `ADMIN_WEB_ALLOWED_ORIGINS` 只列精确测试 origin，不使用 `*`、通配子域或生产域。
- CORS 只在确有跨源测试需要时允许精确测试 origin，并允许凭据；同源仍是首选。
- login、profile、refresh、logout、session revoke 及所有非 GET 请求必须验证 Origin；refresh/logout/revoke 必须验证 CSRF。
- refresh token 每次刷新轮换；复用旧 refresh token 时撤销相关管理员会话并记录安全日志。
- 管理员禁用、角色/权限变化或密码轮换后，旧会话应失效。

## 6. 服务端配置与 secret

只记录变量名，不在文档、仓库、前端变量、截图、日志或部署命令中记录真实值。

### 6.1 管理员认证/BFF

- `ADMIN_WEB_ENV`
- `ADMIN_WEB_TOKEN_PEPPER`
- `ADMIN_WEB_PASSWORD_PEPPER`
- `ADMIN_WEB_ALLOWED_ORIGINS`
- `ADMIN_WEB_ACCESS_TTL_MS`
- `ADMIN_WEB_REFRESH_TTL_MS`
- `ADMIN_WEB_ABSOLUTE_TTL_MS`
- `ADMIN_WEB_ALLOW_BOOTSTRAP`
- `ADMIN_WEB_BOOTSTRAP_SECRET`
- `ADMIN_WEB_ACTION_SECRET`
- `ADMIN_WEB_ALLOW_TEST_ACTION_TRANSPORT`

测试环境也应使用密码学安全随机值，pepper/secret 至少 32 字节、每环境独立、由密钥管理服务或受控云函数环境变量保存。默认设置：`ADMIN_WEB_ALLOW_BOOTSTRAP=false`、`ADMIN_WEB_ALLOW_TEST_ACTION_TRANSPORT=false`。如测试管理员凭证初始化确有必要，只在短维护窗口启用 bootstrap，完成后立即关闭并审查安全日志。

### 6.2 同步与清理

- `SYNC_CURSOR_SECRET`
- `SYNC_OWNER_PEPPER`
- `SYNC_CLEANUP_SECRET`

三个值必须环境隔离且不能互相复用。清理触发器使用受控 secret 调用 `cleanupSyncEvents`，不得把 secret 输出到日志。轮换 cursor/owner secret 会影响既有游标或 owner key，必须安排测试窗口并验证客户端能安全重置游标。

## 7. 集合、保留期与索引

### 7.1 集合边界

现有业务集合继续作为唯一数据源，不复制到 Web 专用数据库。测试部署涉及或新增的基础集合：

| 集合 | 用途 | 保留/清理原则 |
| --- | --- | --- |
| `admin_users` | 管理员权威身份和角色 | 既有业务集合，不由 Web 部署重建 |
| `admin_web_credentials` | 登录标识哈希、密码哈希参数和状态 | 不保存明文密码；禁用/轮换需留审计依据 |
| `admin_web_sessions` | access/refresh 哈希、CSRF 哈希、会话期限与吊销状态 | 受 access/refresh/absolute TTL 控制；过期清理机制上线前需另行验证 |
| `admin_login_attempts` | 账号/IP 限流状态 | 按安全策略保留短周期；不得包含原始登录标识或 IP 明文 |
| `admin_security_logs` | 登录、失败、锁定、刷新复用、退出和吊销审计 | 按审计政策限制访问和保留；不得记录 token、密码或完整 PII |
| `sync_events` | 最小化失效通知和断线补偿 | 建议保留 7-14 天；只由受控清理函数分批删除过期记录 |
| `system_counters` | `product_index` 固定文档分配自动商品编号 | 需审批后预建并按现有最大 `Pxxxxxx` 序号初始化；不得让首次业务请求无记录地建表 |

商品创建/legacy 完整更新依赖 `products`、`system_counters`、`inventory_logs`、`price_logs`、`product_tag_logs`、`stock_alert_records`、`admin_operation_logs` 和 `sync_events`；metadata edit 只写商品、审计和 outbox。其他预警、改价、状态和标签服务继续依赖各自既有集合。部署前必须只读确认集合、权限和索引。幂等 helper 可能尝试确保支持集合存在，集合创建本身属于环境变更，必须在已确认测试环境预先评审和授权，不能让首次业务请求成为未经记录的建表步骤。`idempotency_records` 继续沿用项目既有 helper 行为，不新增第二套幂等集合。

当前十二函数目标清单只提供 `cleanupSyncEvents`，没有独立的会话/限流/安全日志清理函数。因此 session 和安全集合的自动清理是运维缺口；在补齐、审查和测试前，不得声称完整运维闭环。

### 7.2 只读盘点先行

在负责人确认的测试环境中，先只读导出以下元数据：

- 集合是否存在、权限规则、文档数量级和最旧/最新时间。
- 当前全部单字段、复合和唯一索引定义。
- 典型查询的字段、排序、分页和查询计划。
- 是否存在旧同名集合、字段或索引冲突。

完成盘点、评审和备份后才能创建索引。本文列的是建议，不代表索引已经创建。

### 7.3 建议索引

| 集合 | 建议索引 |
| --- | --- |
| `admin_web_credentials` | `loginIdHash + status`；评估 `loginIdHash` 唯一性 |
| `admin_web_sessions` | `accessTokenHash`、`refreshTokenHash`、`adminId + lastActivityAt DESC`、`refreshExpiresAt`、`absoluteExpiresAt` |
| `admin_login_attempts` | 以确定性 `_id` 查询为主；若增加定时清理，再按过期/更新时间建索引 |
| `admin_security_logs` | `createdAt DESC`、`adminId + createdAt DESC`、`eventType + createdAt DESC` |
| `sync_events` | 按当前 reader 验证 `createdAt ASC + _id ASC`、`expiresAt ASC`；按实际过滤评估 `entityType + createdAt + _id`、`ownerKey + createdAt + _id` |
| `orders` / `order_items` | 商品分析按订单 `createdAt ASC + _id ASC` 扫描，并按订单 ID 分批读取明细；需结合真实数据量验证现有索引与查询计划 |
| `price_logs` | 商品分析按 `createdAt ASC + _id ASC`，单品详情再带 `productId`；评估 `productId + createdAt ASC + _id ASC` 及全局周期查询 |
| `inventory_logs` | 评估 `productId + createdAt DESC + _id`；确认 `businessKey` 查询可用且防重不只依赖非唯一普通索引 |
| `stock_alert_records` | `productId + status`，用于事务内查找 active 预警记录 |
| `system_counters` | 固定 `_id=product_index` 文档读取/事务更新；预置值必须不小于现有最大自动编号序号 |
| `products` | 先盘点空值与重复值，再评审 `productIndex` 唯一约束；同时评估 `stockStatus + updatedAt DESC + _id`、`isActive + updatedAt DESC + _id`；不得为 Web 改坏小程序旧查询 |

业务集合索引必须按实际 Web 只读查询和小程序旧入口共同评估，不能为 Web 改坏旧查询。库存、付款和退款仍依赖事务、状态守卫与幂等，不能以索引或乐观版本替代。

### 7.4 清理规则

- `cleanupSyncEvents` 每批最多处理受限数量的 `expiresAt < now` 事件，重复运行应安全。
- 监控事件总量、最老未过期事件、每批删除数、`hasMore`、耗时和失败次数。
- 清理失败不得阻断业务读取或写入。
- 回滚过程中不手工删除 `sync_events`；需要清理时只能使用已审查、受控授权的 `cleanupSyncEvents`。
- 不清空或批量删除任何业务集合。

## 8. 建议测试部署顺序

1. 冻结本次 release，记录源码版本、本地测试证据和变更清单。
2. 确认隔离测试环境并完成第 10 节备份。
3. 只读盘点集合、权限规则和索引；审批后再创建必要测试索引。
4. 配置测试专用服务端变量和 secret，不写入 `VITE_*`。
5. 运行临时打包脚本，核对 manifest 与 canonical hash。
6. 在维护状态下按第 4 节 A-Z 清单部署十个测试云函数；不要开放流量直到十项和配置均完成。
7. 配置 HTTPS 测试域名、同源 `/api` 网关、精确 Origin、Cookie 和安全响应头。
8. 使用 `VITE_APP_ENV=test`、同源 API 和 polling 构建 Web，发布 `dist/` 到测试静态托管。
9. 只重新编译/预览小程序，确认 `miniprogram/utils/sync.js` 调用 `getSyncEvents`；获得明确确认后才上传该云函数，未经确认不发布小程序。
10. 先做负向安全和错误码测试，再做只读/同步测试；未迁移动作必须继续得到 501。商品分析先验证角色、字段投影、非法范围、损坏源数据和上海时区口径；两个预警值动作验证 401/403/CSRF/幂等/version/原阈值冲突；改价验证整数分、旧价格/version 冲突、同 key 不同 payload、no-op 零写和日志恢复；显式上下架验证 `expectedIsActive + expectedVersion`、明确 set、no-op 零写、操作日志和旧薄适配器；显式批量上架再验证原始 100 项上限、重复项、逐项快照冲突、部分成功、安全失败 DTO、同 key 重放/恢复及异 payload 不污染原记录；批量公开标签验证 Web 原始 100 项上限、严格公开字段白名单、无关内部字段不参与 change detection、no-op 零写、角色矩阵、安全 failure DTO，以及 legacy 清洗去重后 200 个唯一商品上限。通过负向检查后才可对明确的隔离测试商品执行写入。
11. 观察测试日志和指标，形成脱敏验收记录；不合格立即按第 11 节回滚。

## 9. 小程序部署边界

- 小程序端不需要复制 Web 会话或管理员 Cookie。
- 小程序继续由微信上下文识别身份，通过 `getSyncEvents` 获取权限过滤后的最小事件。
- 本轮只要求重新编译/预览并验证登录、页面前后台切换、网络恢复、游标补齐和局部刷新。
- `getSyncEvents` 上传仍需用户明确确认测试环境；未经确认不上传。
- 未经用户明确确认，不上传体验版、不发布正式版、不修改生产配置。
- Web 和小程序都不能直接读取开放权限的 `sync_events`；必须经过受认证服务端入口。

## 10. 部署前备份

备份必须在已确认测试环境中进行，保存到受控位置并记录恢复方法：

### 10.1 静态与网关

- 上一版 Web 静态构建产物、release 标识和文件校验值。
- 测试域名、HTTPS 证书引用、静态托管、CDN缓存、SPA fallback 和 `/api` 路由配置。
- CORS、Origin、安全响应头、超时和请求大小限制。

### 10.2 云函数

按 A-Z 备份 `adminDashboard`、`adminWebApi`、`adminWebAuth`、`batchUpdateProductTags`、`cleanupSyncEvents`、`getSyncEvents`、`getUnsoldProducts`、`manageProduct`、`updateProductPrice`、`updateProductWarningStock` 的已部署版本或可恢复包，以及：

- 运行时版本、内存、超时、并发和网络配置。
- 环境变量的名称与受控版本引用，不导出明文 secret。
- HTTP/网关绑定、定时触发器、权限和部署时间。
- 当前函数日志基线和健康检查结果。

### 10.3 数据库

- 保存现有集合清单、权限规则、文档数量级、索引清单和索引状态。
- 对此次涉及的认证/同步集合创建测试环境快照或受控导出。
- 对 Web 只读涉及的业务集合记录恢复点和备份状态，包括商品、订单/明细、用户/管理员、付款、账款、库存日志、发货、售后、退款和设置集合；不得把含 PII 的导出放入仓库。
- 备份过程不得更改数据；无法完成可验证恢复的备份时停止部署。

## 11. 回滚

### 11.1 触发条件

出现任一情况立即停止测试并回滚：

- 环境标识不一致、疑似触达生产或测试数据边界不明。
- 未认证/越权请求获得 2xx，采购看到付款/退款/账款或完整 PII。
- 未迁移的真实 Web 写没有返回预期 501，或预警值、改价、显式上下架、显式批量上架、批量公开标签任一入口绕过权限、CSRF、幂等、version/当前值守卫，说明边界被意外绕过。
- 商品分析允许 `customer_service/finance` 通过注入权限访问，采购得到销售额，缺少 `inventory:view` 的会话得到库存变化，或损坏数据被静默转为空/零。
- refresh Cookie、Origin、CORS、CSRF、轮换或吊销失效。
- 持续 5xx、登录异常锁定、会话复用未撤销或日志出现 secret/PII。
- 游标篡改未拒绝、断线后漏事件/重复业务写、事件积压失控或清理误删未过期事件。
- 小程序既有商品、购物车、下单、付款、发货、售后、退款、地址或权限流程回归失败。
- 无法证明真实测试流量和日志均留在隔离测试环境。

### 11.2 回滚顺序

1. 关闭测试入口或置为维护状态，阻止新 Web 请求；不要删除数据。
2. 恢复上一版静态站点，清理 CDN 缓存并验证 release 标识。
3. 恢复上一版 `/api` 网关、Origin/CORS、Cookie 和安全头配置。
4. 从备份恢复十个目标云函数的上一可用版本、运行配置和触发器；保持测试环境限定。
5. 恢复上一版服务端变量引用；如怀疑 secret 泄露，在密钥系统中轮换并受控撤销相关 Web 会话，而不是删除业务数据。
6. 数据库集合保持原状。新认证集合可以暂时闲置；不得清空或批量删除业务数据。
7. 不删除 `sync_events`。若确需释放已过期事件，只能恢复并调用受控 `cleanupSyncEvents`，先以小批量验证。
8. 重新编译/预览小程序，确认旧业务入口和同步降级行为正常；未经确认不发布。
9. 执行回滚后健康检查，记录原因、版本、时间、操作者、影响和后续修复项，内容必须脱敏。

回滚不是数据库清理。任何数据修复、批量状态变更、库存/账款调整或集合删除都需要单独方案和用户明确授权。

## 12. 测试环境验收

### 12.1 五角色与错误边界

- `user`：不能登录 Web 后台，不能调用管理员接口。
- `customer_service`：只能访问客服授权模块；不能改库存、确认付款或最终退款。
- `finance`：只能处理付款、账款和已审核退款；不能改商品/库存或审核售后。
- `procurement`：只能访问商品、价格、库存、导入、标签、推荐和商品分析；付款、退款、账款和完整 PII 必须为 403/字段缺失。商品分析不得返回销售额，库存变化仍以 `inventory:view` 为必要条件。
- `super_admin`：可以访问合法模块，但库存不足、退款上限、非法状态和幂等规则仍不能绕过。

必须验证：

- 401：未登录、过期、吊销、复用 refresh、disabled 或身份指纹变化。
- 403：角色权限、字段权限、Origin 和 CSRF 失败。
- 404：不存在的路由或资源，不泄漏内部结构。
- 501：所有尚未迁移的合法 Web 业务写稳定返回 `SERVICE_NOT_MIGRATED`；商品 create、metadata edit、改价、上下架、批量上架、批量公开标签和两个预警值入口不在此列。

### 12.2 字段与会话

- 普通用户和采购不得得到付款截图、交易号、退款账户、账款、成本、供应商、内部标签、后台备注、完整手机号或完整地址；库存数值/变化只向具有 `inventory:view` 的合法后台角色投影。
- 客服和财务只得到职责所需字段；日志、同步事件和错误消息同样执行最小投影。
- 验证 access 过期、refresh 轮换、旧 refresh 复用检测、退出、单会话吊销、全会话吊销、管理员禁用、角色变化和改密。
- Cookie 必须符合 host-only、HttpOnly、Secure、SameSite 和 Path 约束；浏览器存储不得出现 refresh token。

### 12.3 游标、断网与同步

- 篡改、截断、跨身份复用游标必须返回安全错误，不泄漏事件。
- Web 和小程序断网后恢复，应从最后游标补齐；游标失效时执行受影响模块增量刷新。
- 重复事件只能触发 refetch/缓存失效，不能再次提交业务写或重复扣库存、付款、退款。
- 分别覆盖商品、库存、订单、付款、发货、售后和退款模块的“小程序到 Web”及“Web 到小程序”路径。
- 当前改价、显式上下架、显式批量上架、批量公开标签和预警值动作具备本地共享写 service；它们的“Web 到小程序”和“小程序到 Web”仍必须在真实隔离测试环境验证。其他模块仍以 501 为阻断项，不能用 Mock 通过替代。
- 商品分析页面收到商品、订单或库存事件后只重新查询，不提交业务写；250ms 合并刷新和可见页 60 秒兜底只能作为本地行为证据，真实事件路径仍需采集。
- 记录业务提交、事件可见、客户端收到和 refetch 完成四个时间点。1-3 秒只在真实隔离测试环境连续测量并达到目标后标记通过。

### 12.4 日志、清理与回归

- 验证认证成功/失败、限流、refresh 复用、退出、吊销、403/404/501、同步错误和清理结果均有脱敏日志与请求 ID。
- 验证日志不含密码、token、Cookie、secret、完整手机号、地址、付款截图或退款账户。
- 使用已过期的测试事件验证 `cleanupSyncEvents` 小批量删除、`hasMore` 和重复调用；未过期事件保持不变。
- 验证会话/限流/安全日志保留与清理缺口已登记，不能误报为已自动治理。
- 回归小程序登录、商品、搜索、购物车、下单、订单、取消、付款凭证、物流、售后、退款、地址和手机号，以及旧后台商品/库存/导入、审核、付款、发货、售后、退款、账款和权限。

## 13. 通过标准与交付记录

测试部署只有在以下记录齐全时才可保留：

- 明确的隔离测试环境、release、静态版本、十一函数版本和网关版本。
- 本地检查、测试环境 API、浏览器、小程序和双端同步证据分开记录。
- 五角色和 401/403/404/501 全部符合预期，无敏感字段泄漏。
- 会话轮换、吊销、Origin、CSRF、Cookie 和日志检查通过。
- 集合、索引和保留期有实际测试环境盘点记录；不能写“索引已建”而没有证据。
- 除单商品改价、两个单商品预警值、显式上下架、显式批量上架和批量公开标签外，Web 业务写仍明确标记为未迁移；完整后台和双向业务同步不得标记完成。
- 1-3 秒指标附真实测试时间点与样本；mock 或本地轮询不算。
- 回滚包、恢复步骤和责任人已验证可用。

## 14. 当前剩余风险

- 真实 CloudBase 环境、索引、权限规则和数据规模尚未验证。
- 测试 HTTPS 域名、同源网关、Cookie 转发和 secret 管理尚未验证。
- 单商品改价、显式上下架、显式批量上架、批量公开标签和预警值已完成本地迁移；其他 Web 业务写仍为 501，完整后台不可执行。
- 旧 `manageProduct` 等 writer 尚未统一版本守卫，可能在 Web 成功后用更早的整商品快照反向覆盖预警值；测试期间应避免并发编辑，后续需统一迁移全部 `warningStock` writer。
- `manageProduct.create/update` 已收口到 `productWriteService`，但旧小程序不强制 `expectedVersion` / `Idempotency-Key`，整对象兼容写仍可能覆盖并发变化或重复创建；缺货自动下架仍需单独审计。
- canonical 幂等 helper 的冲突不污染修复只覆盖本 guarded 包中的 `adminWebApi`、`batchUpdateProductTags`、`getUnsoldProducts`、`manageProduct`、`updateProductPrice`、`updateProductWarningStock`；其他旧云函数仍有独立 helper 副本，部分会持久写 `status=conflict`，本轮未统一、未上传，必须作为后续跨业务高风险迁移单独审计。
- `sync_events` outbox 尚需随各共享写服务逐模块接入；当前 fallback 读取不等于完整事件发布闭环。
- 双端各业务模块和在线 1-3 秒目标尚未真实测量。
- Web 会话、登录限流和安全日志缺少已验证的定时清理函数。
- 独立 `cloudfunctions/getProductAnalytics` 仍会追加 `source: current_product` 的合成报价点，是未迁移 legacy；当前小程序源码走 `adminDashboard` canonical 入口，该 legacy 函数不在十二函数目标清单中。
- `cancelOrder` 的本地原子库存回补和账款重算可重试标记已经实现并通过内存事务测试；真实 CloudBase 事务、历史数据和双端验收仍未执行。
- 本文没有授权任何上传、部署、发布、生产操作或真实数据写入。
