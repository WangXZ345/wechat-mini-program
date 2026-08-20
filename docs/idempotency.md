# Idempotency

本说明记录本项目的幂等设计，以及当前 canonical helper 的迁移边界。仓库中的下单、付款、商品状态、库存、发货、售后退款等写操作都存在幂等处理，但部分旧云函数仍携带独立历史副本；除非已明确迁移并验证，不能假定它们都与 `cloudfunctions/common/idempotency.js` 完全一致。本说明不包含大宗订单人工审核，也未新增相关页面、规则或字段。

## idempotency_records

新增集合 `idempotency_records`，用于记录一次写操作的处理状态和可复用结果。文档 `_id` 由 `actionType + operatorIdentity + idempotencyKey` 计算得到，避免同一操作被重复执行。

主要字段（P1-04 起的新记录）：

- `idempotencyKeyDigest`：操作凭证的 16 位 SHA-256 摘要；不保存原始 key。
- `actionType`：操作类型，例如 `submit_order`、`confirm_payment`、`import_inventory`。
- `operatorIdentityDigest` / `operatorType`：操作人分区摘要和类型；不保存原始 `openid`、`adminId` 或其他身份值。
- `scope` / `scopeId`：业务范围，例如订单、商品、发货单、售后单。
- `requestId`：仅接受安全字符集的请求关联 ID；非法值写为空字符串。
- `requestHash`：去除 `idempotencyKey` 等临时字段后的请求摘要。
- `status`：canonical `cloudfunctions/common/idempotency.js` 的持久状态为 `processing`、`success`、`failed`、`expired`；`conflict` 仅作为当前响应状态和历史记录兼容值，不得覆盖原 success/processing 记录。
- `resultRef` / `resultDataMasked`：首次成功结果的引用和脱敏结果。
- `errorCode` / `retryable`：失败分类和是否允许同 key 重试；不保存原始异常 message 或堆栈。
- `executionLeaseDigest` / `executionAttempt`：当前执行租约摘要与代次；原始 lease token 只在本次函数内存中传递。
- `lockedAt` / `finishedAt` / `expiresAt` / `retryCount`：锁定、完成、过期和重试信息。

使用 canonical helper 时，同一个 `idempotencyKey` 在同一操作人和 `actionType` 下重复提交：

- 请求内容一致且首次已成功：返回首次结果，并带 `duplicate: true`。
- 请求内容不同：返回 `IDEMPOTENCY_KEY_CONFLICT`，但不修改同 key 原请求的持久记录；随后重放原 payload 仍应得到原结果或继续原处理流程。
- 首次仍在处理中：返回 `IDEMPOTENCY_PROCESSING`。

当数据库支持 `runTransaction` 时，首次认领、`expired` 重领和 `failed` 重试都在事务内读取并更新同一记录，避免两个并发请求同时取得执行权。超时但仍为 `processing` 的记录不会直接重领：先尝试用业务日志恢复已提交结果，否则继续返回 `IDEMPOTENCY_PROCESSING`，等待清理任务确认超时并标记 `expired`。每次认领都会生成新 lease；成功/失败回写必须在事务内核对 lease 与 `processing` 状态，旧执行者不能覆盖新代次结果。

非重试型失败保持 `failed`；网络超时、连接中断、限流和数据库瞬态冲突等失败可使用同 key 重试。没有 `retryable` 字段的旧 `failed` 记录会根据历史 `errorCode` 推断，避免把旧 `NETWORK_ERROR` 永久锁死。

## optimistic concurrency / CAS

`cloudfunctions/common/idempotency.js` 同时导出 `runVersionedTransaction`。调用方必须提供集合、文档 ID 和非负安全整数 `expectedVersion`；工具在同一个数据库事务中读取当前文档、校验存储版本并执行写入回调。版本不一致返回 `DATA_VERSION_CONFLICT`，只附带 `{ currentVersion, refreshRequired: true }`，不返回完整记录或敏感字段。

真实付款审核入口已接入该 CAS 工具。该入口先在事务外完成兼容旧数据所需的 `where` 预检，事务内只使用 CloudBase 支持的确定性 `doc` 读取/写入，并再次比较付款 `version`、订单状态、账款版本和确定性流水 ID。新审核写入只持久化客户端幂等 key 的摘要；后台既有 `operatorId` / `operatorOpenid` 仍按受权限保护的业务审计链保留，不作为幂等 key 使用。P2-P7 后续写路由应直接复用该工具，不再在路由中另写“先查后改”的非原子版本判断。

### 当前迁移边界

- 当前 guarded 包会把 canonical helper 复制并做 SHA-256 gate：`adminReviewOrder`、`adminUpdatePayment`、`adminWebApi`、`afterSales`、`batchUpdateProductTags`、`getUnsoldProducts`、`manageProduct`、`updateProductPrice`、`updateProductWarningStock`。其中 `afterSales` 的顶层实际导入和 `common` 副本均受 gate 保护；开发态代理继续解析到 `cloudfunctions/common/idempotency.js`。
- 上述清单之外的旧云函数内嵌副本不在本切片迁移范围；后续仍需逐函数审计和回归，当前不得宣称全项目所有写入口均已统一。

## 业务流水防重

为防止幂等记录之外的重复流水，以下集合新增或复用业务唯一键：

- `inventory_logs.businessKey`：订单扣库存、导入库存、售后回补、批量预警库存等库存类流水防重。
- `account_logs.businessKey`：订单入账、付款确认、退款确认等账款流水防重。
- `payment_records.idempotencyKey` / `payment_records.requestHash`：仅描述付款截图提交及旧数据兼容字段；新财务确认写入使用 `reviewIdempotencyKeyDigest` / `idempotencyKeyDigest` 摘要和 `reviewBusinessKey` / `businessKey`，不写原始客户端 key。
- `refund_records.idempotencyKey` / `refund_records.requestHash`：退款创建和线下退款确认防重。
- `product_tag_logs.businessKey`：批量标签更新防重。
- `price_logs.businessKey`：批量改价和导入改价防重。
- `shipment_logs.businessKey`：合并发货创建、确认、取消、完成流水防重。

## 清理函数

新增 `cleanupIdempotencyRecords` 云函数：

- 将超过 `idempotencyProcessingTimeoutSeconds` 的 `processing` 记录标记为 `expired`。
- 删除 `expiresAt` 已过期且非 `processing` 的记录。
- 默认每次处理 100 条，可用 `settings/system_settings.idempotencyCleanupLimit` 调整到 1-500。

建议上线后配置定时触发器，例如每小时执行一次。当前代码只新增函数，未自动配置生产触发器。

## 涉及入口

用户端：

- 商品详情提交单品订单、加入购物车。
- 购物车修改数量、选择项提交订单。
- 付款页提交线下付款凭证。
- 售后申请页提交售后申请。

后台：

- 订单审核通过、审核拒绝、付款确认、付款拒绝。
- 库存导入确认、库存价格合并导入确认。
- 批量改价、批量标签、批量预警库存、单个预警库存、商品显式上下架和显式批量上架。
- 合并发货创建、确认发货、取消、完成。
- 售后审核、验货回补、创建退款、线下确认退款、售后完成。

## 验收建议

1. 在微信开发者工具中提交同一个订单按钮连续点击，确认只生成一张订单，第二次返回相同 `orderId/orderNo`。
2. 对同一订单重复点击审核通过，确认库存只扣一次，`inventory_logs.businessKey = order_deduct:{orderId}:{productId}` 只出现一次。
3. 对同一付款记录重复确认，确认 `payment_records` 和 `account_logs` 不重复增加账款流水。
4. 重复确认同一库存导入，确认商品库存和 `inventory_logs` 不重复累加。
5. 重复确认同一线下退款，确认退款记录、订单退款字段和客户账款只更新一次。
6. 手工调用 `cleanupIdempotencyRecords`，确认过期记录被标记或清理。

## 部署注意

本地代码修改不会自动上传云函数，也不会发布小程序。上传云函数前请按最终交付清单逐一上传，并在云开发环境中确认 `idempotency_records` 集合可自动创建或已手工创建。
