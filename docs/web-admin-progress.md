# 网页后台实施进度

> **2026-07-13 订单只读增量：** HTTP 模式订单列表/详情已从通用单集合读取迁移到 canonical 关联查询服务；Web 加入严格合同、稳定游标与专用详情页，Mock 按角色对齐金额/电话/地址。当前 Web `234/234`、目标后端 `330/330`、双模式构建及客服桌面/390px 浏览器验收通过；12 函数保护包 `.codex-cloudfunction-deploy/admin-web-twelve-functions-guarded-final-20260713-143016/` 尚未上传。订单审核、付款、发货、售后和退款等 Web 写入口仍未迁移，真实 CloudBase/小程序双端验证未执行。

> **2026-07-12 库存写历史：** 当时已本地完成行级库存调整与取消订单恢复库存；对应十一函数包现已过期。订单审核、付款、发货、售后和退款等其他 Web 写入口仍未迁移。

> **历史商品写进度：** 商品改价、状态、标签、预警、详情、创建和 metadata-only 编辑均仍有效；旧测试计数和 `191343` 十函数包已被顶部库存写增量替代。

> 更新：2026-07-11  
> 当前阶段：四轮本地实现与独立回归完成，隔离测试环境部署验收待执行。  
> 部署状态：尚未上传云函数、尚未部署 Web、尚未发布小程序、尚未连接生产数据。

## 1. 目标与冻结边界

微信小程序继续作为客户订货端，新增电脑端网页后台。两端复用同一 CloudBase 业务数据与逐步抽取的服务端规则，不建立第二套业务数据库。

本轮没有改变订单、库存扣减、付款、账款、发货、售后或退款状态机。真实 Web mutation 在共享业务服务未迁移前固定返回 `SERVICE_NOT_MIGRATED`；HTTP 模式是安全只读后台，不能作为完整生产写后台交付。

## 2. 子智能体分工与产出

| 子智能体 | 职责 | 产出 |
| --- | --- | --- |
| A | 现有架构审查 | OPENID 依赖、可复用事务入口、共享 service 顺序、索引与环境风险 |
| B | Web 架构与工程 | Vue 3/Vite/TS、Router、Pinia、transport、布局和构建配置 |
| C | 登录与安全 | `adminWebAuth`、scrypt、限流、短 access + 轮换 refresh、吊销与审计 |
| D | Web API/共享边界 | `adminWebApi`、固定路由/权限表、分页、字段白名单和 501 迁移边界 |
| E | 实时同步 | v3 opaque cursor、角色 scope、collection fallback、Web/小程序补拉和清理 |
| F | Web 页面 | 登录、工作台及完整后台模块、loading/empty/error/confirm 状态 |
| G | 权限与安全复审 | 五角色、DTO、敏感字段、mutation 权限、CSRF、cursor 和同步主题复审 |
| H | 完整回归 | Web/云函数/JSON/语法、角色/API/字段/断网/打包 dry run 回归 |
| I | 部署与回滚 | 隔离测试环境部署、索引、密钥、备份、验收和回滚文档 |

I 因平台 agent 线程上限复用已完成的 A 线程执行，职责和禁止上传/发布边界不变。

## 3. 四轮热循环记录

### 第一轮：审查与架构

完成项目扫描、五份设计文档、单一数据源、Web Session/BFF、渐进共享 service 和 outbox + 游标轮询方案。确认当前环境不能证明为隔离测试环境，因此冻结所有上传和生产写入。

### 第二轮：基础设施

完成 `admin-web`、路由/Pinia/API、独立管理员认证、只读 BFF、权限菜单、路由守卫、同步状态和四个云函数。本轮问题经 G/H 回查并修正为固定 action 权限、恒定时间 CSRF 比较、最小 profile/DTO 和 fail-closed 认证集合。

### 第三轮：MVP 模块

完成工作台、商品、库存、预警、报价/库存导入、订单和商品分析。商品分析在真实历史服务未迁移时返回 unavailable，不生成伪造趋势；mock 导入同时保留正常可确认与显式错误文件路径。

### 第四轮：完整业务与打磨

完成付款、账款、发货/合并发货、售后、退款、管理员、操作日志、设置、详情、403/404，以及权限、安全、同步、响应式和业务回归。真实写服务仍按模块渐进迁移，不在本轮复制业务逻辑。

## 4. 当前技术架构

```text
admin-web (Vue 3)
  -> same-origin HTTPS BFF
  -> adminWebAuth / adminWebApi / getSyncEvents
  -> shared CloudBase collections and existing business entrypoints

miniprogram
  -> existing cloud functions + getSyncEvents
  -> same CloudBase collections
```

- Web 不直接读写 CloudBase 业务集合。
- `admin_users` 是角色、状态和权限唯一权威；`users.isAdmin` 与浏览器传入 role/openid 不可信。
- 金额继续使用整数分，库存/付款/退款继续以服务端事务、状态守卫和幂等为准。
- `sync_events` 只做通知和缓存失效，不是业务真值。

## 5. 已完成模块

- 登录、工作台、商品、库存、库存预警、报价导入、库存导入、商品分析。
- 订单、付款、客户账款、发货、合并发货、售后、退款。
- 管理员、操作日志、系统设置、详情抽屉/详情路由、403 和 404。
- 搜索、筛选、分页、批量选择、确认弹窗、loading、空状态、错误重试和同步状态。
- mock 模式提供完整演示交互；HTTP 模式写按钮、导入和设置保持只读。

## 6. 登录与会话

- `admin_web_credentials` 保存随机盐 scrypt 记录，不保存明文密码。
- `admin_web_sessions` 保存 access/refresh token hash、到期、轮换、family 和吊销信息。
- access token 只在 Web 内存；refresh token 仅同源 `HttpOnly; Secure; SameSite` Cookie。
- 登录失败由 `admin_login_attempts` 持久限流；`admin_security_logs` 记录脱敏安全事件。
- 禁用、非法角色、角色/权限指纹变化、refresh 重放和主动吊销均使会话失效。
- 认证集合只在显式凭证初始化时创建；普通请求缺集合返回 `AUTH_STORAGE_NOT_READY`。

## 7. 权限与字段隔离结论

- `user` 不能登录 Web；四种管理员只能看到职责菜单和后端允许的字段。
- 采购仅有商品、库存、导入和商品分析；付款、退款、账款、完整客户联系方式全部拒绝。
- 客服可处理订单、发货、售后；付款确认和最终退款拒绝。
- 财务可处理付款、账款和已审核退款；订单/发货/售后只读，售后审核、商品和库存写拒绝。
- 超级管理员可访问合法后台模块，但 mutation 仍受固定 permission、状态机、幂等和金额/库存规则约束。
- 付款、售后、退款、审计 DTO 使用白名单，不返回 raw id、openid、完整地址、内部备注或不必要的关联 ID。

## 8. 实时同步实现

- `getSyncEvents` 使用角色边界与实际 permission 交集过滤 topic。
- v3 cursor 使用 AES-256-GCM 加密每个来源的复合 mark；`SYNC_CURSOR_SECRET` 缺失时 fail closed。
- 旧/篡改 cursor 返回 `INVALID_SYNC_CURSOR`；Web 和小程序清除本地 cursor 后重新补拉。
- 事件只含字段名白名单，不含密码、token、完整手机号/地址、付款截图、退款账户或原始数据库 ID。
- Web 前台 2 秒轮询、断网退避和恢复补拉；小程序在前台、`onShow` 和网络恢复时补拉。
- `sync_events` 缺失时可从业务集合时间字段生成兼容通知，但关键写入口仍需迁入事务性 outbox 后才具备完整可靠性。

## 9. 本地验证证据

### 自动化

- Web ESLint：通过，0 warning。
- Web TypeScript strict：通过。
- Web Vitest：6 个文件、13 个用例通过；其中导入组件用例实际覆盖选文件、校验、可用确认按钮和确认弹窗。
- Web production build：通过；主入口 gzip 105.57 kB，图表独立 chunk gzip 169.53 kB。
- `adminWebApi`：10/10；`adminWebAuth`：7/7；`getSyncEvents`：11/11；`cleanupSyncEvents`：2/2。
- 四个新增云函数 20 个 JS 文件 `node --check` 通过；小程序同步入口和三份 helper 额外检查通过。
- 三份同步 helper SHA-256 一致；10 份本轮关键 JSON 解析通过。
- H 的独立扩大回归：46 个相关 JS、71 个 JSON、五角色矩阵、33 个 mutation action、14 类 DTO、断网退避和 cursor 篡改场景通过。

### 浏览器

- 采购、客服、财务、超级管理员登录和菜单通过；普通 user 不在可登录账号列表且 transport 明确拒绝。
- 客服访问付款、财务访问商品、采购访问财务模块均进入 `/403`，受限页面不发业务请求。
- 商品搜索、空状态、清除筛选、详情中文状态、批量选择保留和确认弹窗通过。
- 商品分析 7/30/90 天切换、摘要、表格和 canvas 渲染通过。
- 1024x768、1366x768、1440x900、1920x1080 无页面级横向溢出、侧栏/主区或顶栏/主区重叠；1024 档侧栏自动收窄。
- 4174 当前验收时段无新增 Vue warn/error。截图捕获接口在 1024 档超时，因此本轮响应式证据为真实 DOM 尺寸与交互检查，不冒充像素级截图回归。

## 10. 数据库集合与索引

部署前新增并设置为仅服务端访问：

- `admin_web_credentials`
- `admin_web_sessions`
- `admin_login_attempts`
- `admin_security_logs`
- `sync_events`

至少核对：credentials 的 `loginIdHash + status`；sessions 的 `accessTokenHash`、`refreshTokenHash`、`adminId`；sync events 的 `createdAt + _id`、`expiresAt`；各同步兼容业务源的时间字段 + `_id`，以及普通用户 owner 字段复合索引。实际索引只能在用户确认的隔离测试环境创建。

## 11. 部署清单

需要上传的云函数，A-Z：

1. `adminWebApi`
2. `adminWebAuth`
3. `cleanupSyncEvents`
4. `getSyncEvents`

`adminWebAuth`/`adminWebApi` 使用认证与权限临时打包目录；`getSyncEvents`/`cleanupSyncEvents` 应完整上传。当前全部只做本地修改和打包 dry run，`UploadPerformed=false`。

Web 产物位于 `admin-web/dist/`，但尚未部署。小程序同步文件只需在后续体验版重新编译/预览；旧业务云函数和旧后台入口未删除，仍保持兼容。

## 12. 未完成风险与后续顺序

1. 确认独立测试 CloudBase 环境、测试域名、Web 安全来源和回滚责任人。
2. 创建五个基础设施集合和版本化索引，配置所有 secret，初始化 Web 管理员凭证后关闭 bootstrap。
3. 部署同源 HTTPS 网关和四个云函数，执行真实 Cookie、CSRF、会话吊销及五角色字段隔离测试。
4. 按订单审核 -> 付款 -> 发货 -> 售后退款顺序迁移共享 mutation service，并在同一事务写 outbox；迁移一项开放一项 Web 写能力。
5. 在 Web 测试版 + 小程序体验版执行商品、库存、订单、付款、发货、售后退款双向同步、断网、重复事件和冲突用例，记录 P50/P95。
6. 真实商品历史分析服务、真实 1-3 秒同步、CloudBase 配额/索引命中和完整小程序业务回归通过后，才可考虑生产发布。

当前不能声称：真实写后台已完成、真实双端同步已通过、测试环境已部署或生产可发布。
