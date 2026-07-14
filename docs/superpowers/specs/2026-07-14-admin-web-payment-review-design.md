# 付款审核共享写入设计

## 目标

在不改变微信小程序现有付款状态、金额计算、批次兼容和配送联动语义的前提下，把付款确认与驳回收敛到 Web 与小程序共用的 `paymentMutationService`，并开放 Web 单笔全额确认与驳回。

本切片不开放 Web 部分付款、异常标记、批量确认、付款凭证短期预览、账款结清或导出。旧小程序的 `partial_paid`、`abnormal` 和付款批次入口继续兼容，但由同一共享服务执行。

## 已确认问题

现有 `adminUpdatePayment` 具备订单、付款结果、账款流水和配送日志的事务骨架，但存在以下问题：

- 管理员操作会新增确认结果记录，却不关闭订单当前 `latestPaymentRecordId` 指向的 `pending_confirm` 凭证，旧凭证可能永久留在待审核队列。
- `idempotencyKey` 只进入记录字段，没有调用共享 `runIdempotentAction`；当前 `businessKey` 查询使用 `limit(1)` 且吞掉查询失败，不能证明并发单写。
- 管理员审计在事务外；审计失败可能把已提交业务误报成失败。
- 没有事务内 `sync_events`，网页和小程序无法依靠安全 outbox 收到付款变更。
- Web 列表使用付款记录 ID，旧入口使用订单 ID，不能直接转发。
- 旧 `paidAmount` 中带小数的文本按元、整数文本按分解释，Web 不能沿用该歧义合同。
- 付款批次最多读取 100 单后静默截断，也没有明确拒绝跨客户批次。

## 推荐架构

新增 `cloudfunctions/common/services/paymentMutationService.js`，并把完全相同的部署副本打入：

- `cloudfunctions/adminUpdatePayment/paymentMutationService.js`
- `cloudfunctions/adminWebApi/lib/paymentMutationService.js`

服务公开两个入口：

```js
createPaymentMutationService(dependencies).reviewWebPayment({
  actor,
  input: {
    paymentId,
    decision: "confirm" | "reject",
    expectedStatus: "pending_confirm",
    expectedVersion,
    expectedUpdatedAt,
    reason
  },
  idempotencyKey
})
```

```js
createPaymentMutationService(dependencies).updateLegacyPayment({
  actor,
  input: {
    orderId,
    paymentStatus,
    paidAmount,
    paidAmountCents,
    remark,
    applyBatch
  },
  idempotencyKey,
  allowMissingIdempotencyKey: true
})
```

`adminUpdatePayment` 只负责从 WXContext/`admin_users` 取得 actor、保留旧参数别名和 `{ok,data|message}`；`adminWebApi` 只负责 session、角色/权限、CSRF、严格字段白名单和安全响应投影。两端不得复制付款金额或账款计算逻辑。

## Web 严格合同

保留现有资源动作：

- `POST /payments/confirm`
- `POST /payments/reject`

请求正文精确为：

```json
{
  "id": "payment-record-id",
  "expectedStatus": "pending_confirm",
  "expectedVersion": 2,
  "expectedUpdatedAt": "2026-07-14T00:00:00.000Z",
  "reason": "已核对到账"
}
```

规则：

- `id` 是付款记录 ID，服务端从记录解析订单；浏览器不得发送 `orderId`。
- `expectedStatus` 固定为 `pending_confirm`。
- `expectedVersion` 为非负安全整数；兼容旧记录时版本按 `0` 处理。
- `expectedUpdatedAt` 必须与当前记录时间完全一致，防止旧页面审核已经变化的凭证。
- `Idempotency-Key` 必填；正文和 header 中不得出现第二份幂等键。
- `reject` 的 `reason` 去空格后必填且最长 300 字；`confirm` 原因可空。
- 禁止金额、最终状态、订单 ID、客户、actor、openid、凭证 URL、交易号、账款字段和所有未知字段。

响应精确为：

```js
{
  item: { id, orderNo, status, version, updatedAt },
  affected,
  reused,
  decision,
  accountRecalculationPending,
  message,
  requestId
}
```

响应不得包含 `orderId`、`userId`、openid、手机号、地址、凭证 URL、交易号、付款方式敏感配置、账款金额或内部流水。

## 状态和金额规则

### 全额确认

1. 事务内读取付款记录和关联订单。
2. 付款记录必须仍为 `pending_confirm`，且必须是订单当前 `latestPaymentRecordId`。
3. 订单必须仍为 `paymentStatus=pending_confirm` 且 `status=pending_payment_confirm`；已付款、已驳回、已取消或已发货状态拒绝。
4. 金额只从订单当前 `totalAmount/paidAmount/unpaidAmount` 计算，均须是非负安全整数分；客户端金额完全忽略并禁止传入。
5. 本次入账金额等于服务端当前未付金额；不得超付。
6. 订单更新为 `paymentStatus=paid`、`status=paid`，并按现有 `deliveryType` 进入 `waiting_pickup` 或 `waiting_shipping`。
7. 原付款记录原地更新为 `paid/confirmed`，保留原凭证与提交信息，不新增第二条确认记录。

### 驳回

1. 使用与确认相同的当前凭证和状态快照守卫。
2. 原付款记录原地更新为 `rejected`，记录受权限保护的驳回原因和审核元数据。
3. 订单恢复为 `paymentStatus=unpaid`、`status=approved_pending_payment`。
4. 不增加 `paidAmount`，不写收款账款流水，不进入配送流程。

### 旧入口兼容

- `paid`、`partial_paid`/`partial`、`abnormal`、`unpaid` 的现有状态含义不变。
- `paidAmountCents` 继续按整数分；`paidAmount` 保留历史解析，仅用于旧小程序适配，Web 永远不发送。
- `partial_paid` 必须大于 0 且不超过当前未付金额。
- `abnormal` 不改变已付/未付金额。
- `unpaid` 按驳回语义关闭当前凭证。
- `applyBatch=false` 只处理单订单；旧入口其他情况保持默认批次联动，但批次超过 100 单或跨客户时 fail closed，不允许静默截断或跨客户重算。

## 事务、幂等和恢复

单次用例在同一事务内完成：

- 更新当前 `payment_records`；必要的无凭证旧入口才允许创建一条结果记录。
- 更新订单金额、状态、配送状态、版本和 `accountRecalculationPending`。
- 确认付款时更新/创建 `customer_accounts` 并写唯一 `account_logs`；驳回不写收款流水。
- 配送状态变化时写 `delivery_logs`。
- 写 `admin_operation_logs`。
- 写最小 `sync_events`，只包含实体、动作、版本和字段名，不含金额、客户隐私、凭证 URL或交易号。

幂等使用共享 `idempotency_records`。同键同 payload 返回原结果且 `affected=0/reused=true`；同键异 payload 返回 409；`processing` 状态通过事务内 `admin_operation_logs.businessKey` 恢复已提交结果。业务键查询必须 `limit(2)` 并对重复或冲突记录 fail closed。

事务提交后的 `recalculateCustomerAccount` 仅作校准。失败时保留 `accountRecalculationPending=true` 并返回固定警告，不得把已提交付款伪装成失败；成功后再清除该标记。

## 权限

- Web 仅允许 active `finance` 或 `super_admin`。
- 确认还需显式 `payment:confirm`；驳回还需显式 `payment:update_status`。
- `procurement`、`customer_service`、普通用户和禁用管理员即使请求中伪造权限或 actor 也拒绝。
- `super_admin` 仍不能绕过状态、金额、并发和幂等规则。
- 小程序旧入口的 actor 只从 `admin_users` 获取；浏览器/事件中的 actor、role、openid 不可信。

## 付款队列读取修正

`pending_confirm` 不是单纯的历史记录状态。付款列表和详情必须验证：

- 记录 ID 等于关联订单的 `latestPaymentRecordId`；
- 订单当前仍为待确认状态；
- 已被确认或驳回的历史凭证不能继续出现在待确认筛选中。

读取仍返回严格掩码 DTO。新增 `version` 作为 Web 并发快照，不返回凭证地址。

## Web UI

保留现有密集表格和通用确认弹窗：

- 只在待确认记录显示/启用确认和驳回。
- 提交 `id/expectedStatus/expectedVersion/expectedUpdatedAt/reason`。
- 驳回原因必填。
- 409 冲突时关闭弹窗、刷新列表并提示重新核对；不能继续复用旧页面快照。
- 网络重试复用原幂等键；用户修改 payload 后生成新键。
- Mock 使用纯内存状态验证合同，但明确显示本地演示环境，不与 Real 数据混合。

## 测试门槛

必须覆盖：

- 四个付款状态分支和服务端金额校验；
- 当前凭证、订单状态、记录版本和更新时间冲突；
- 原凭证原地关闭、重复确认/驳回不新增记录或账款流水；
- 同键重放、同键异 payload、processing 恢复和重复业务日志 fail closed；
- 事务中任一付款、订单、账款、配送、审计或 outbox 写失败时整体回滚；
- 批次超过 100、跨客户和单订单模式；
- 账款校准成功/失败；
- legacy 参数、状态、返回 envelope 和权限兼容；
- BFF CSRF、严格字段、四角色矩阵、安全错误和响应脱敏；
- Web/Mock 精确 payload、驳回原因、冲突刷新和按钮状态；
- package canonical hash 门禁。

## 部署边界

本设计只授权本地代码、测试、构建、文档和保护包。不得上传云函数、创建生产索引、连接生产环境、执行真实付款、发布 Web 或小程序。真实 CloudBase 与双端 1～3 秒同步验收继续保留为未执行项。
