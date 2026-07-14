# Idempotency

本说明记录本项目的幂等设计，以及当前 canonical helper 的迁移边界。仓库中的下单、付款、商品状态、库存、发货、售后退款等写操作都存在幂等处理，但部分旧云函数仍携带独立历史副本；除非已明确迁移并验证，不能假定它们都与 `cloudfunctions/common/idempotency.js` 完全一致。本说明不包含大宗订单人工审核，也未新增相关页面、规则或字段。

## idempotency_records

新增集合 `idempotency_records`，用于记录一次写操作的处理状态和可复用结果。文档 `_id` 由 `actionType + operatorIdentity + idempotencyKey` 计算得到，避免同一操作被重复执行。

主要字段：

- `idempotencyKey`：前端或调用方生成的操作凭证。
- `actionType`：操作类型，例如 `submit_order`、`confirm_payment`、`import_inventory`。
- `operatorIdentity` / `operatorType` / `openid` / `adminId`：操作人范围。
- `scope` / `scopeId`：业务范围，例如订单、商品、发货单、售后单。
- `requestHash`：去除 `idempotencyKey` 等临时字段后的请求摘要。
- `requestPayloadMasked`：脱敏后的请求快照。
- `status`：canonical `cloudfunctions/common/idempotency.js` 的持久状态为 `processing`、`success`、`failed`、`expired`；`conflict` 仅作为当前响应状态和历史记录兼容值，不得覆盖原 success/processing 记录。
- `resultRef` / `resultDataMasked`：首次成功结果的引用和脱敏结果。
- `lockedAt` / `finishedAt` / `expiresAt` / `retryCount`：锁定、完成、过期和重试信息。

使用 canonical helper 时，同一个 `idempotencyKey` 在同一操作人和 `actionType` 下重复提交：

- 请求内容一致且首次已成功：返回首次结果，并带 `duplicate: true`。
- 请求内容不同：返回 `IDEMPOTENCY_KEY_CONFLICT`，但不修改同 key 原请求的持久记录；随后重放原 payload 仍应得到原结果或继续原处理流程。
- 首次仍在处理中：返回 `IDEMPOTENCY_PROCESSING`。

### 当前迁移边界

- 2026-07-12 的九函数 guarded 包会把 canonical helper 复制到 `adminWebApi`、`getUnsoldProducts`、`manageProduct`、`updateProductPrice`、`updateProductWarningStock`，这五个目标函数已纳入本轮冲突不污染回归。
- 其他旧云函数的内嵌 `idempotency.js` 副本未在本切片统一；其中部分历史实现仍会把异 payload 冲突持久写为 `status=conflict`。这些副本未上传、未改动，后续必须逐函数审计和回归后再迁移，当前不得宣称全项目已消除此风险。

## 业务流水防重

为防止幂等记录之外的重复流水，以下集合新增或复用业务唯一键：

- `inventory_logs.businessKey`：订单扣库存、导入库存、售后回补、批量预警库存等库存类流水防重。
- `account_logs.businessKey`：订单入账、付款确认、退款确认等账款流水防重。
- `payment_records.idempotencyKey` / `payment_records.requestHash` / `payment_records.businessKey`：付款截图提交和财务确认防重。
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
