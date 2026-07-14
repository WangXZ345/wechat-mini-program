# 订单审核真实写入设计

## 目标

在不改变微信小程序既有订单状态机、审核通过扣库存时机、账款语义和旧云函数响应的前提下，将订单人工审核/驳回抽取为 Web 与小程序共用的 `orderReviewService`，再开放 Web 单笔审核动作。

本设计只覆盖审核通过与驳回，不开放批量审核、付款确认、发货、售后或退款。

## 现状与风险

旧 `adminReviewOrder` 已把订单、明细、商品库存、库存流水、客户账款放进一个事务，但存在：

- 明细固定 `limit(100)` 后静默截断；
- 同一商品多行时重复使用 `order_deduct:<orderId>:<productId>`；
- 数量、金额未严格验证；
- Web 缺少版本快照与全局幂等；
- 事务后审计日志失败会把已提交业务误报为失败；
- 没有最小 `sync_events` outbox。

## 架构

新增 `cloudfunctions/common/services/orderReviewService.js`，提供一个完整事务用例：

```js
reviewOrder({
  actor,
  input: {
    orderId,
    decision: "approve" | "reject",
    expectedVersion,
    expectedStatus,
    reason
  },
  idempotencyKey,
  strict: true | false
})
```

`strict=true` 仅用于 Web，要求 `expectedVersion`、`expectedStatus`、幂等键和驳回原因；`strict=false` 由旧 `adminReviewOrder` 兼容适配器使用，允许旧客户端缺少快照和幂等字段，但仍执行服务端状态守卫、业务键防重和严格数据校验。

旧 `cloudfunctions/adminReviewOrder/index.js` 只负责解析 WXContext、兼容旧参数和转换 `{ok,data/message}`，不得继续复制事务逻辑。`adminWebApi` 只负责 session、CSRF、权限、严格字段白名单和安全结果 DTO。

## 审核通过

1. 仅允许 `pending_admin`、`auto_reviewing`；已通过或 `accountIncluded=true` 的重复通过返回 `reused=true`，不产生第二次业务写入。
2. 读取全部 `order_items`，超过安全上限、缺少商品、数量不是正安全整数、订单金额不是非负安全整数时 fail closed。
3. 按 `productId` 聚合数量，再一次性预检商品存在、启用状态和库存。
4. 每个商品只使用一个 `order_deduct:<orderId>:<productId>`，已有流水必须验证订单、商品、数量和前后库存一致；冲突流水 fail closed。
5. 事务内更新商品库存/销售统计、库存预警、`inventory_logs`、明细 `stockCheckStatus`、订单状态和版本、`customer_accounts`、`account_logs`、审计日志和最小 `sync_events`。
6. 订单结果保持 `approved_pending_payment`、`paymentStatus=unpaid`，不改变金额，不触发付款成功。
7. 事务提交后的账款校准失败只能记录可重试标记，不能把已经提交的审核伪装成失败。

## 驳回

1. 仅允许 `pending_admin`、`auto_reviewing`；已拒绝重复驳回返回 `reused=true`。
2. 已通过、已付款、已取消订单拒绝。
3. 事务内只更新订单状态、审核元数据、版本、审计日志和最小 `sync_events`，不碰库存或账款。
4. Web 要求原因；旧小程序原因可为空以保持兼容。原因只进入受权限保护的审计记录，不进入普通用户 DTO。

## Web 合同

保留资源动作：

- `POST /orders/review`
- `POST /orders/reject`

请求白名单：

```json
{ "id": "order-id", "expectedVersion": 2, "expectedStatus": "pending_admin", "reason": "可选或必填" }
```

禁止 actor、openid、金额、库存、商品、客户、付款字段和未知字段。响应只返回 `{ item: { id, orderNo, status, reviewType, paymentStatus, version, updatedAt }, affected, reused, decision, requestId }`。

## 权限

- `order:review` 才能通过；`order:reject` 才能驳回。
- 客服按已有权限矩阵执行；财务、采购和禁用管理员拒绝。
- super_admin 可通过统一权限评估器访问，但仍受状态、库存、金额和幂等校验约束。

## 测试门槛

必须覆盖状态守卫、角色矩阵、严格字段、CSRF、版本冲突、同键重放/异 payload 冲突、processing 恢复、同商品多行聚合、超限明细、脏数量/金额、库存不足、旧流水一致性、事务回滚、审计/outbox 单写、旧入口响应和 Web 安全 DTO。批量审核保持禁用。

## 未覆盖范围

发货、合并发货、付款、账款、售后、退款以及真实 CloudBase/小程序双端运行验收留在后续切片；本设计不授权上传或生产写入。
