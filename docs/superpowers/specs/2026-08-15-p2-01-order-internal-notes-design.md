# P2-01 订单内部备注真实写入设计

## 目标与边界

把 admin-web 订单详情现有只读 `adminRemark` 接入真实追加写入。浏览器只调用 `adminWebApi`，服务端重验 active 管理员与 `order:edit_remark`；不新增集合、不连接生产、不上传云函数、不发布小程序。

复用 `orders`、`note_logs`、`admin_operation_logs`、`sync_events` 与 P1-03～P1-05 的错误、幂等、version、outbox 契约。订单内部备注绝不复用客户留言、通知文案或客户可见字段。

## 接口与 DTO

- `GET /orders/:id`：仅对拥有 `order:edit_remark` 的 active 管理员返回 `internalNotes`。该字段即使为空也返回 `[]`，让前端可靠判断当前角色可编辑；未授权角色同时拿不到 `internalNotes` 与 `adminRemark`。
- `POST /orders/remark`：严格接收 `{ id, content, expectedVersion }`，并要求 `Idempotency-Key` 与有效 CSRF。未知字段、非字符串、去空白后为空、超过 500 字、非法 version 都返回明确的 4xx 错误。
- 成功结果返回新备注条目、订单最新 version 与 updatedAt。重复相同幂等请求返回同一条目，不重复写 `note_logs`、审计或同步事件。
- `internalNotes` 条目采用 `{ id, content, authorId, authorRole, authorName, createdAt }`；`authorName` 是后台展示名，不返回 openid。

## 服务端写入

新增 canonical `orderNoteService`，由 `adminWebApi` 使用。服务在幂等保护下开启 CloudBase 事务：读取订单、校验当前 version、追加 `note_logs`、更新订单兼容字段与 version，并通过 `operationOutbox` 同事务写入 `admin_operation_logs` 和 `sync_events`。

`note_logs` 保留既有稳定字段，并新增追加记录所需的 `content`、`authorId`、`authorRole`、`authorName`、`versionBefore`、`versionAfter`、`idempotencyDigest`。兼容字段 `orders.adminNote/adminRemark` 保存最新内容摘要，旧后台读取逻辑继续可用；并发请求使用同一 expectedVersion 时只有一个成功，另一个返回 `DATA_VERSION_CONFLICT`，不会覆盖已成功的追加记录。

审计和同步事件只记录资源、动作、version 与安全 changedFields，不记录备注正文、openid、手机号、地址或原始幂等 key。任一日志/outbox 写入失败导致整个事务失败。

## 查询、权限与客户隔离

`orderQueryService` 只在 `order:edit_remark` 通过时读取并投影 `note_logs`，集合不存在时兼容返回空数组。历史覆盖式日志通过 `content || afterNote` 归一化为只读条目；无有效内容的记录忽略。

`getOrders` 普通用户查询维持现有敏感字段剥离，并新增对 `internalNotes`/备注条目字段的防御性剥离测试。admin-web 使用 Vue 文本插值渲染 content，禁止 `v-html`；XSS 字符串按纯文本展示。

## 前端交互

订单详情在 DTO 包含 `internalNotes` 时显示紧凑备注区：textarea、字数、提交按钮、保存中状态、错误提示和按时间倒序的备注记录。空白输入禁用；每次内容变化创建新的幂等意图，网络失败重试复用同一 key；成功后清空输入并刷新/合并服务端返回的最新条目与 version。409 冲突明确提示刷新后重试，不伪装成功。

## 验证边界

必须保留 RED→GREEN：先证明真实模式按钮/API 未接通，再实现。覆盖成功、空白、超长、XSS、订单不存在、未授权、CSRF、幂等重放、version 冲突、并发不覆盖、outbox 失败回滚、客户投影剥离、前端刷新后可见。运行相关 Node/Vitest 套件、typecheck、lint、真实模式 build 与 `git diff --check`；CloudBase、浏览器端到端、微信开发者工具、真机和生产均不在本地验证范围。
