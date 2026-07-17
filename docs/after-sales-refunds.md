# 售后退款功能说明

> **2026-07-18 Web 退款 local-only 更新：** 线下退款处理与驳回已收口到 canonical `refundMutationService`，Web 路由为 `POST /api/admin/v1/refunds/process` 和 `POST /api/admin/v1/refunds/reject`，小程序旧 `afterSales` action 保留兼容 adapter。Web 只允许 active `finance` / `super_admin` 且具备 `refund:process`（或 `*`）的主体；`customer_service`、`procurement` 以及只注入权限字符串的其他角色均硬拒绝。canonical 退款状态固定为 `pending`、`processing`、`refunded`、`partial_refunded`、`failed`、`rejected`、`cancelled`。
>
> 线下退款在同一业务事务内更新退款、售后、订单、订单明细、账款日志、退款/售后日志和不可变管理员 journal，并写 owner/admin 两个 audience 的最小 `sync_events`。提交后的账款重算使用 journal 中的 account/owner/version/completion business key 恢复，清理 marker 前执行 owner/version/evidence compare-before-clear；不能从后来已变化的订单或账款状态反推既有成功。历史已确认部分退款若 `order_items.refundQuantityAppliedAfterSaleIds` 缺少当前售后归属，必须先人工对账数量归属并补齐证据；服务返回 `REFUND_ITEM_QUANTITY_RECONCILIATION_REQUIRED` 且零业务写，禁止猜测或重复累计。
>
> 部署前必须审计并审批五个 partial unique 索引：`admin_operation_logs.businessKey`、`account_logs.businessKey`、`refund_logs.businessKey`、`after_sale_logs.businessKey`、`sync_events.eventId`。当前仅有本地测试与 guarded 包证据；真实 CloudBase 事务/索引、Cookie/CSRF BFF、Web+小程序双端、1～3 秒延迟、上传、部署和发布均未验证。`createWechatPayRefund` / `handleWechatRefundNotify` 继续 fail closed 且零业务写。

## 业务边界

- 所有售后申请必须先由后台人工审核，系统不会自动同意售后，也不会自动退款。
- 客户申请时必须填写 `customerReasonDetail`，默认去掉空格后至少 5 个字符，并会拦截过短、重复字符、纯符号等无意义内容。
- 审核和退款分离：客服可以审核售后；财务只能处理已审核通过且进入退款阶段的记录。
- 退货退款必须先确认收货，再验货。只有验货结论为可售并选择回补时，才会增加库存并写入 `inventory_logs`。
- 金额字段继续统一按整数“分”存储，页面展示时再格式化为元。
- 微信原路退款入口已保留，但默认返回 `WECHAT_REFUND_NOT_CONFIGURED`，不会伪造微信退款成功。

## 数据集合

### after_sales

售后主记录，核心字段：

- `afterSaleNo`、`orderId`、`orderNo`、`userId`、`userOpenid`
- `afterSaleType`: `refund_only` / `return_refund` / `exchange` / `price_adjustment_refund`
- `reasonType`、`customerReasonDetail`、`evidenceImages`
- `afterSaleStatus`: `pending_review` / `approved` / `waiting_return` / `received` / `inspecting` / `refund_pending` / `refunded` / `rejected` / `completed` / `cancelled`
- `refundStatus`: `none` 或 canonical `pending` / `processing` / `refunded` / `partial_refunded` / `failed` / `rejected` / `cancelled`
- `requestedRefundAmount`、`approvedRefundAmount`、`actualRefundAmount`
- `returnItems`、`returnLogistics`、`inspectionResult`
- `adminReviewRemark`、`rejectReason`、`reviewedBy`、`reviewedAt`

### refund_records

退款执行记录，核心字段：

- `refundNo`、`afterSaleId`、`orderId`、`orderNo`
- `refundMethod`: `offline` / `wechat_pay` / `balance`
- `refundAmount`、`refundStatus`（canonical 值为 `pending` / `processing` / `refunded` / `partial_refunded` / `failed` / `rejected` / `cancelled`）
- `refundProofImages`、`financeRemark`
- `processedBy`、`processedAt`

### after_sale_logs / refund_logs

分别记录售后流转和退款执行日志，用于后台追溯。

## 订单字段

售后链路会在 `orders` 上维护以下字段：

- `hasAfterSale`
- `afterSaleIds`
- `afterSaleStatus`
- `refundStatus`
- `totalRefundAmount`
- `refundableAmount`
- `netPaidAmount`
- `lastAfterSaleAt`
- `lastRefundAt`

`recalculateCustomerAccount` 已按 `netPaidAmount` 或 `paidAmount - totalRefundAmount` 重算客户账款，避免退款后账款重新统计回原付款金额。

## 云函数入口

核心函数为 `afterSales`，前端优先调用同名包装函数；如果包装函数未上传，`miniprogram/utils/api.js` 会回退调用 `afterSales` 的 `action` 模式。

客户侧：

- `createAfterSaleRequest`
- `getMyAfterSales`
- `getMyAfterSaleDetail`
- `submitReturnLogistics`

后台售后：

- `getAdminAfterSales`
- `getAdminAfterSaleDetail`
- `reviewAfterSale`
- `confirmReturnReceived`
- `inspectReturnItems`
- `completeAfterSale`

财务退款：

- `getAdminRefunds`
- `getAdminRefundDetail`
- `createRefundRecord`
- `processOfflineRefund`
- `createWechatPayRefund`
- `handleWechatRefundNotify`
- `rejectRefund`

导出：

- `exportAfterSalesExcel`

## 权限

新增权限点：

- `after_sale:view`
- `after_sale:review`
- `after_sale:receive_return`
- `after_sale:inspect`
- `after_sale:update`
- `after_sale:complete`
- `after_sale:cancel`
- `refund:view`
- `refund:create`
- `refund:process`
- `refund:wechat_pay`
- `refund:export`
- `refund:view_sensitive`

默认角色：

- `customer_service`: 查看、审核、确认退货收货、执行验货、更新和完成允许状态的售后；不能执行最终退款。
- `finance`: 查看售后，创建和处理退款，导出退款，查看敏感退款信息，具备微信退款入口权限。
- `procurement`: 不具备售后审核、退货验收或退款权限。
- `super_admin`: 全部权限。

如果已有管理员账号保存了显式 `permissions` 数组，上线后需要在后台角色/管理员权限中补齐以上权限。

## 前端页面

客户侧：

- `pages/after-sale/apply`
- `pages/after-sale/list`
- `pages/after-sale/detail`
- 订单详情页增加申请售后、查看售后和重复申请拦截。
- 个人资料页增加“我的售后”入口。

后台：

- `pages/admin/after-sales/index/index`
- `pages/admin/after-sales/detail/index`
- `pages/admin/refunds/index/index`
- `pages/admin/refunds/detail/index`
- 后台首页增加售后待审核和退款待处理入口。

## 验收建议

1. 创建并付款一笔订单。
2. 在订单详情申请售后，原因详情少于要求时应提交失败。
3. 正常提交后，订单详情应提示已有售后处理中，不能重复申请。
4. 客服进入后台售后详情，未填写审核备注时不能同意申请。
5. 同意退货退款后，客户提交物流，后台确认收货并验货。
6. 财务创建退款记录，再执行线下退款；退款金额不得超过审核金额和订单可退金额。
7. 退款完成后检查订单 `totalRefundAmount`、`refundableAmount`、`netPaidAmount` 和客户账款重算结果。
8. 验货未选择可售回补时，库存不应自动增加。
9. 普通用户不能访问后台售后和退款接口。
10. 导出售后/退款 Excel 时，应生成导出记录并返回云文件地址。

## 部署范围

本轮 Web 退款增量若经负责人确认后需要上传，改动云函数按 A-Z 为：

- `adminWebApi`
- `afterSales`
- `recalculateCustomerAccount`

当前 guarded 包只是本地部署候选，尚未上传云函数、部署 Web 或发布小程序。以下是完整售后功能的历史云函数清单，不代表本轮已部署：

- `afterSales`
- `completeAfterSale`
- `confirmReturnReceived`
- `createAdminUser`
- `createAfterSaleRequest`
- `createRefundRecord`
- `createWechatPayRefund`
- `exportAfterSalesExcel`
- `getAdminAfterSaleDetail`
- `getAdminAfterSales`
- `getAdminRefundDetail`
- `getAdminRefunds`
- `getAdminUsers`
- `getCurrentAdminProfile`
- `getMyAfterSaleDetail`
- `getMyAfterSales`
- `getSettings`
- `handleWechatRefundNotify`
- `inspectReturnItems`
- `processOfflineRefund`
- `recalculateCustomerAccount`
- `rejectRefund`
- `reviewAfterSale`
- `submitReturnLogistics`
- `updateAdminRole`
- `updateSettings`

小程序前端重新编译或预览即可。上线前不要跳过后台权限复查和微信开发者工具里的完整下单、售后、退款验收。
