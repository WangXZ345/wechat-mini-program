# 订单审核 P0/P1 修复执行简报

## 目标

修复独立复核指出的订单审核账款兼容、业务防重、库存共享 primitive、同步 outbox、旧入口兼容、Mock 权限和打包门禁问题。不得扩大到发货、付款、生产上传或真实数据写入。

## 必须先写失败测试

1. `order_debt:<orderId>` 使用 `limit(2)`；重复流水或字段冲突必须 fail closed，合法已有流水不得再次增加账户。
2. 客户账户按 `userId` 后备 `userOpenid` 查找；现有账户保留备注、标签、风险等无关字段，并更新旧合同中的 `totalOrderAmount`、`totalReceivableAmount`、`totalUnpaidAmount`、`unpaidAmount`、`todayOrderAmount`、`todayDate`、`orderCount`、`unpaidOrderCount`、`lastOrderAt`、`updatedAt`。
3. 新账户初始化旧合同字段：`nickname/phone/totalPaidAmount/historyUnpaidAmount/pendingConfirmAmount/abnormalAmount/abnormalCount/paidOrderCount/partialPaidOrderCount/lastPaymentAt/riskLevel/isSettled/adminRemark/adminNote/adminTags/paidAmount` 等。
4. `account_logs` 保留 `businessKey/sourceType/sourceId/userId/userOpenid/relatedOrderId/relatedPaymentRecordId/changeType/before*/after*/changeAmount/operator*/remark/createdAt`。
5. `accountIncluded=true` 但订单仍处于待审状态必须报冲突，不能伪装成已审核复用。
6. 订单审核扣库存调用 canonical `applyInventoryMutationInTransaction`；库存流水重复 businessKey 必须 `limit(2)` fail closed，并验证 `sourceType/sourceId/relatedOrderId/changeAmount`。
7. 审核通过同时产生 inventory admin outbox、必要的 product availability public outbox，以及带正确 `ownerKey` 的 order owner outbox；事件不携带金额、电话、地址、库存值。
8. 事务任一中间写失败时，订单/库存/账款/日志/outbox 全部回滚。测试数据库必须真实模拟 rollback。
9. 旧 `adminReviewOrder` 成功响应继续兼容 `status/userId/userOpenid/reused`；Web 继续使用严格安全 DTO。
10. Mock transport 必须在内部校验 `order:review` / `order:reject`，finance/procurement 直接调用也返回 403。
11. `adminWebApi` 完整 `dispatch` 测试覆盖 approve/reject 权限、CSRF、service 参数与错误映射。
12. 打包脚本把 canonical `common/idempotency.js` 复制到 `adminReviewOrder/common/idempotency.js`，并单独 hash gate；canonical order review service 与 inventory service 也必须 flatten 并校验。

## 复用要求

- 复用 `cloudfunctions/common/services/inventoryMutationService.js` 的 `applyInventoryMutationInTransaction`，不得复制另一套库存写逻辑。
- `ownerKey` 使用 `cloudfunctions/common/syncEvents.js` 的 `ownerKeyFor`，由 BFF/旧入口注入 `SYNC_OWNER_PEPPER`，不得写原始 openid 到事件。
- 账户重算通过可注入 callback 在幂等结果成功后执行；失败必须可重试，不能让已提交业务被再次写入。
- 金额仍为安全整数分；审核通过状态仍为 `approved_pending_payment`；驳回不动库存和账款。
- 不上传云函数、不发布、不连接 CloudBase。

## 允许修改

- `cloudfunctions/common/services/orderReviewService.js` 及测试
- `cloudfunctions/common/services/inventoryMutationService.js` 及测试
- `cloudfunctions/adminReviewOrder/*`
- `cloudfunctions/adminWebApi/index.js`、本地 lib proxy 和相关测试
- `admin-web/src/services/transport/mock-transport.ts` 及测试
- `scripts/package-admin-web-cloudfunctions.ps1`

## 不要修改

- 发货、付款、售后、退款业务代码
- 订单状态名称、库存扣减时机、金额计算语义
- 生产配置、数据库或云环境

## 汇报

完成后写明：变更摘要、修改文件、RED/GREEN 命令与结果、未覆盖风险、是否有需要主线程决策的问题。不要上传或发布。
