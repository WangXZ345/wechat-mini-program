# 支付配置增强说明

## 集合设计

### payment_methods

- `paymentName`: 支付方式名称。
- `paymentType`: `wechat_qr` / `alipay_qr` / `bank_transfer` / `wechat_pay` / `custom`。
- `description`: 支付说明。
- `qrCodeFileID`, `qrCodeUrl`, `qrCodeCloudPath`: 收款二维码云存储信息。
- `bankAccountName`, `bankName`, `bankBranchName`, `bankCardNo`, `bankCardNoMasked`: 银行卡转账信息。
- `transferRemark`: 转账备注。
- `enabled`, `isDefault`, `sortIndex`, `minAmount`, `maxAmount`, `extraTips`: 展示和可用范围。
- `wechatPayConfigStatus`: `not_configured` / `configured` / `invalid`。
- `status`: `active` / `disabled` / `deleted`。
- `createdAt`, `updatedAt`, `createdBy`, `updatedBy`: 审计字段。

### payment_method_logs

- `paymentMethodId`
- `action`: `create` / `update` / `enable` / `disable` / `delete` / `upload_qrcode` / `update_bank_info`
- `beforeDataMasked`, `afterDataMasked`: 银行卡号和二维码信息已脱敏。
- `operatorId`, `operatorOpenid`, `operatorRole`
- `createdAt`

### payment_records

- `orderId`, `orderNo`, `userId`, `userOpenid`
- `paymentMethodId`, `paymentMethodType`, `paymentMethodName`
- `amount`
- `status`: `pending_confirm` / `pending` / `paid` / `partial` / `partial_paid` / `abnormal` / `failed` / `cancelled`
- `screenshotUrls`
- `wechatPayTransactionId`, `wechatPayOutTradeNo`
- `submittedAt`, `confirmedAt`, `confirmedBy`
- `remark`, `createdAt`, `updatedAt`

## orders 支付字段

订单选择支付方式时写入：

- `paymentMethodId`
- `paymentMethodType`
- `paymentMethodName`
- `paymentMethodSnapshot`

提交离线付款凭证时写入：

- `paymentStatus = pending_confirm`
- `status = pending_payment_confirm`
- `paymentSubmittedAt`
- `paymentScreenshotUrls`
- `paymentScreenshotUrl`
- `latestPaymentRecordId`

财务确认仍通过现有 `adminUpdatePayment` / `confirmPayment` 流程完成，并补充写入 `payment_records` 中的支付方式和截图列表字段。

## 权限点

新增或补齐：

- `payment:config`
- `payment_method:view`
- `payment_method:create`
- `payment_method:update`
- `payment_method:disable`
- `payment_method:delete`
- `payment_method:upload_qrcode`
- `payment_method:view_sensitive`
- `payment:wechat_pay_config`

`finance` 默认拥有支付方式维护、敏感银行卡查看、付款确认和截图查看权限。`procurement` 不拥有支付配置、付款截图和付款确认权限。

## 微信支付边界

当前实现不会伪造微信支付成功。`enableWechatPay = false` 时 `createWechatPayOrder` 返回 `WECHAT_PAY_DISABLED`；商户配置不完整时返回 `WECHAT_PAY_NOT_CONFIGURED`。官方预支付、回调验签和主动查询接口保留入口，但在未完成安全商户配置前不会更新订单为已付款。

## 部署范围

需要上传的云函数：

- `paymentMethods`
- `getEnabledPaymentMethods`
- `getAdminPaymentMethods`
- `createPaymentMethod`
- `updatePaymentMethod`
- `uploadPaymentQrCode`
- `enablePaymentMethod`
- `disablePaymentMethod`
- `deletePaymentMethod`
- `selectOrderPaymentMethod`
- `submitOfflinePaymentProof`
- `createWechatPayOrder`
- `handleWechatPayNotify`
- `queryWechatPayOrder`
- `getSettings`
- `updateSettings`
- `getOrders`
- `adminUpdatePayment`
- `getCurrentAdminProfile`
- `getAdminUsers`
- `createAdminUser`
- `updateAdminRole`

需要重新编译或预览的小程序前端：

- `pages/admin/payment-methods/index`
- `pages/payment/payment`
- `pages/admin/orders`
- `pages/admin/dashboard/index`
- `app.json`

## 验收重点

1. 财务可以新增微信收款码、上传二维码、启用支付方式。
2. 客户支付页只显示启用且完整的支付方式。
3. 二维码和银行卡支付必须上传至少一张付款截图。
4. 提交截图后订单为待财务确认，不会自动变成已付款。
5. 财务确认付款后，订单、账款、付款记录和后台操作日志同步更新。
6. 采购账号不能看到付款截图字段。
7. 银行卡号在后台列表脱敏，在客户支付页对应订单流程中可复制完整值。
8. 微信支付未启用或未配置时返回明确错误，不改变订单付款状态。
