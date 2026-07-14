# 网页后台与小程序实时同步设计

> 状态：本地实现完成，隔离测试环境验收待执行（2026-07-11）  
> 当前事实：仓库已包含 `sync_events` helper、受认证游标拉取、Web/小程序轮询客户端、断线补拉和清理函数。关键业务写入口尚未全部迁入事务性 outbox，且未上传到云环境，因此 1-3 秒双端同步仍是目标，不能标记为已通过。

## 1. 单一数据源

小程序和网页版共同使用现有 CloudBase 业务集合与同一套服务端业务服务。`sync_events` 只用于通知、断线补偿和缓存失效：

- 不保存商品、订单、付款或退款的完整快照。
- 不参与金额、库存、付款或退款的最终判断。
- 客户端收到事件后按权限重新读取业务数据。
- 不创建网页专用业务数据库，不做定时复制或 Excel 同步。

## 2. 当前实现现状

- 小程序新增 `miniprogram/utils/sync.js`，在前台按 topic 拉取事件，在 `onShow`、网络恢复和无效游标时补拉或重置游标，并继续复用页面刷新、TTL、dirty flag 和敏感字段剥离逻辑。
- Web 新增 `CursorSyncClient` 与 Pinia realtime store，前台 2 秒轮询，断网指数退避，页面恢复后补拉；事件只触发对应资源重新查询。
- `getSyncEvents` 与 `adminWebApi` 共用同一份同步 helper；`sync_events` 不存在时可读取既有业务集合的 `updatedAt/createdAt` 作为兼容通知源。
- collection fallback 不是事务性 outbox 的替代品。订单审核、付款、发货、售后和退款等关键写入口仍需逐个迁移为“业务写 + 事件写”同事务提交。

## 3. 同步通道

### 3.1 可靠基线

第一阶段使用受认证的事件 API + 复合游标短轮询：

- Web 前台可见时每 1-2 秒查询一次；后台标签退避到 5-15 秒或暂停。
- 小程序前台运行时按相同思路拉取，并在 `onShow`、网络恢复时立即补齐。
- API 根据 Web session 或微信用户身份过滤事件 scope。
- 断线期间的事件通过 cursor 分页补齐。

### 3.2 可选加速

CloudBase 数据库 `watch()` 只有在测试环境验证以下条件后才启用：

- 环境地域支持实时数据库。
- Web 身份能在安全规则中可靠映射到管理员。
- `sync_events` 的读取规则能按角色/用户隔离。
- Web 安全来源、连接配额、重连和浏览器后台行为通过测试。

`watch()` 仅加速通知，短轮询仍负责补洞。浏览器不得通过开放 `sync_events` 读取权限换取实时性。

## 4. 事件结构

部署时需新增集合：`sync_events`。本地代码已实现读取和清理；集合缺失时同步读取会优雅降级到业务集合兼容源，但不会自动证明所有业务变化都可可靠补齐。

```js
{
  _id,
  eventId,
  cursorAt,
  eventType,
  entityType,
  entityId,
  action,
  version,
  changedFields,
  audience,
  ownerUserIdHash,
  actorType,
  actorRole,
  sourceClient,
  businessKey,
  requestId,
  createdAt,
  expiresAt
}
```

约束：

- `changedFields` 只允许字段名白名单，不包含值。
- 不写 password、token、openid、完整手机号、完整地址、付款截图 fileID、交易号、退款账户或管理员备注。
- `audience` 由服务端生成，例如 `admin:orders`、`admin:finance`、`admin:inventory`、`user:<opaque>`。
- 采购永远不返回 `payment`、`refund`、`account` audience。
- `businessKey` 沿用现有业务幂等语义。

服务端内部对每个来源分别维护 `(时间字段, _id)` 复合 mark，并按时间升序、`_id` 升序补齐同毫秒多条记录。客户端只看到 AES-256-GCM 加密的 v3 opaque cursor，不返回内部 mark、原始 `_id` 或可伪造游标。`SYNC_CURSOR_SECRET` 必须至少 32 字符；缺失时 fail closed，旧版或篡改游标返回 `INVALID_SYNC_CURSOR`，客户端清除本地游标后重新补拉。

测试环境部署前需核对并创建：

- `sync_events: createdAt ASC, _id ASC`
- `expiresAt ASC`
- `entityType ASC, entityId ASC, createdAt DESC`
- 各兼容业务源按其时间字段与 `_id` 建复合索引；普通用户 owner 查询还需 `openid/userOpenid + 时间字段 + _id`

实际索引必须在已确认测试环境中创建并记录。

## 5. 写入顺序与事务性 outbox

关键写入顺序：

```text
身份与权限校验
-> 参数与状态校验
-> 幂等锁/业务键
-> 事务内业务写入
-> 事务内写 sync_event
-> 提交事务
-> 完成幂等结果
-> 返回
```

- 事务回滚时不得留下事件。
- 重复幂等请求不得重复扣库存、入账、退款、发货或产生多个逻辑事件。
- 对不能同事务写入的场景，使用确定性 event id + reconciliation 重试，不能先发事件再写业务数据。
- 薄包装云函数不能重复发事件；只由真实聚合写入口发事件。

## 6. 事件类型与同步场景

### 商品

- `product.created`
- `product.updated`
- `product.price_changed`
- `product.status_changed`
- `product.tags_changed`
- `product.recommendation_changed`

处理：清商品详情、首页、推荐和搜索预览缓存，标记 products dirty；当前商品详情和可见列表局部重取。下架后服务端加购/下单仍需重新校验状态。

### 库存

- `inventory.changed`
- `inventory.warning_changed`
- `inventory.import_confirmed`

处理：后台库存、预警、分析局部刷新。普通用户端仅失效价格/可售性相关缓存，不返回或显示真实库存。订单审核扣库存后发一个聚合事件或受控批次事件，避免刷新风暴。

### 订单

- `order.created`
- `order.reviewed`
- `order.rejected`
- `order.cancelled`
- `order.status_changed`
- `order.note_changed`

处理：订单列表按 ID 插入/更新，当前详情重取。小程序下单后 Web 列表目标在 1-3 秒内出现；网页审核后小程序详情局部刷新。

### 付款与账款

- `payment.proof_submitted`
- `payment.confirmed`
- `payment.rejected`
- `payment.abnormal`
- `account.changed`

处理：finance/super_admin 的付款待办和账款失效；客户本人订单付款状态重取；采购不收到事件内容。

### 发货

- `shipment.created`
- `shipment.updated`
- `shipment.confirmed`
- `shipment.cancelled`
- `shipment.completed`

处理：Web 发货列表和订单详情局部更新；客户本人订单物流重取；合并发货使用业务键防止重复。

### 售后退款

- `after_sale.created`
- `after_sale.reviewed`
- `after_sale.return_submitted`
- `after_sale.return_received`
- `after_sale.inspected`
- `after_sale.status_changed`
- `after_sale.completed`
- `refund.created`
- `refund.confirmed`
- `refund.rejected`

处理：客服售后待办、财务已审核退款待办和客户本人详情分别按权限失效；事件不含退款账户或凭证地址。

## 7. 客户端状态机

```text
connecting -> catching_up -> synced
      |             |          |
      +----------> offline <----+
                       |
                  reconnecting
                       |
                  catching_up
```

用户可见状态：`已同步`、`正在同步`、`连接中断`、`正在重新连接`、`数据已更新`。短暂正常同步不弹 toast，只在状态栏轻量显示。

重连策略：

1. cursor 按 `environment + principal` 持久化，不包含敏感信息。
2. 网络恢复、页面重新可见或 watcher error 后先 `catchUp(cursor)`。
3. 每页 100-200 条，按复合游标顺序循环补齐。
4. 指数退避 1/2/4/8/15/30 秒并增加 jitter。
5. 补齐完成后更新 high watermark，再恢复实时加速。
6. cursor 过期、事件缺口或积压超过上限时，服务端返回 `CURSOR_EXPIRED`，客户端按受影响模块做增量/全量刷新并重置 high watermark。

## 8. 缓存失效与去重

- 事件只触发 invalidate + refetch，不触发任何业务写。
- 客户端按 `eventId` 去重，保存有限窗口。
- 同一实体 250-500ms 内的多个事件合并为一次刷新。
- 只刷新当前可见实体、列表页或相关指标，不全局 reload。
- 多标签页可通过 `BroadcastChannel` 共享 cursor/失效通知；每个标签仍按自身身份校验数据。
- 收到自己发出的事件也只重取服务器状态，不重复提交写操作。

## 9. 版本冲突

逐步为以下人工编辑引入整数 `version`：

- 商品价格和上下架
- 人工库存调整
- 订单后台备注
- 发货信息
- 售后审核

客户端提交 `expectedVersion`；服务端事务内比较，不一致返回 `DATA_VERSION_CONFLICT` 和最新安全摘要，页面展示冲突并要求重新确认。

库存扣减、付款确认和退款确认仍以事务、状态守卫、业务键和幂等记录为主，version 不能替代这些保护。

## 10. 延迟目标

- 在线、正常网络下，普通事件从业务提交到另一端完成局部重取目标为 1-3 秒。
- API 请求和页面重取时间计入总延迟。
- 冷启动、弱网、浏览器后台和批量导入可能超过 3 秒。
- 记录 `event.createdAt`、客户端收到时间和 refetch 完成时间，报告 P50、P95 和超过 3 秒比例。
- 在真实双端测试前只能写“设计目标”，不能写“已通过”。

## 11. 清理与保留

- `expiresAt` 建议保留 7-14 天，最终值由测试流量和断线需求决定。
- 定时清理函数分批删除，保留审计统计，不清理仍被最慢有效 cursor 依赖的窗口。
- cleanup 失败不得影响业务写入；需监控事件数量、最老事件、清理耗时和失败次数。

## 12. 实现边界

本地已新增：

- canonical `cloudfunctions/common/syncEvents.js` 及 `adminWebApi`、`getSyncEvents` 部署副本，并以测试校验哈希一致。
- `getSyncEvents`、`cleanupSyncEvents`、Web `CursorSyncClient/realtimeStore` 和小程序 `miniprogram/utils/sync.js`。
- 角色 + 实际 permission 双重过滤、敏感字段白名单、opaque owner key、事件去重和无效游标恢复。

仍未完成：

- 云端创建 `sync_events` 及索引，配置 `SYNC_CURSOR_SECRET`、`SYNC_OWNER_PEPPER` 和 `SYNC_CLEANUP_SECRET`。
- 将所有关键业务写入口接入事务性 outbox；当前单商品改价、单商品显式上下架、显式批量上架和两个单商品预警值入口已在本地接入共享 service/outbox，其余未迁移 Web mutation 继续返回 `SERVICE_NOT_MIGRATED`，不会假装写成功。
- 在同一隔离测试库上执行 Web 与小程序双向 1-3 秒、断线补齐、重复事件和冲突验收。

当前尚未上传云函数、创建集合/索引、部署 Web 或发布小程序。
