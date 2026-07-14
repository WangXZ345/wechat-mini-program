# 手机号绑定功能说明

## users 字段

- `phoneNumber`: 完整手机号，仅云函数写入，普通前端不返回。
- `phoneMasked`: 脱敏手机号，例如 `138****8888`。
- `phoneVerified`: 是否已通过微信授权或短信验证。
- `phoneBindMethod`: `wechat`、`manual_verified`、`manual_unverified`。
- `phoneBoundAt`: 首次绑定时间。
- `phoneUpdatedAt`: 最近更新时间。
- `phoneChangeCount`: 更换次数。

## phone_bind_logs

- `userId`
- `openid`
- `beforePhoneMasked`
- `afterPhoneMasked`
- `beforePhoneVerified`
- `afterPhoneVerified`
- `bindMethod`
- `action`: `bind`、`update`、`unbind`
- `operatorType`: `user`、`admin`
- `operatorId`
- `operatorOpenid`
- `ipInfo`
- `userAgent`
- `createdAt`

## settings/system_settings

默认值由云函数兜底，不存在时按以下配置执行：

- `requirePhoneBeforeOrder = true`
- `requireVerifiedPhoneBeforeOrder = false`
- `allowManualPhoneBinding = true`
- `maxPhoneChangePerDay = 3`

## 权限点

- `customer:view_phone_masked`
- `customer:view_phone_full`
- `customer:search_by_phone`
- `customer:update_phone_admin`
- `customer:view_phone_log`

默认角色：

- `super_admin`: 全部手机号权限。
- `customer_service`: 脱敏、完整、按手机号搜索。
- `finance`: 脱敏、完整、按手机号搜索。
- `procurement`: 仅脱敏。

## 验收步骤

1. 上传 `getMyProfile`、`bindPhoneByWechat`、`bindPhoneManual`、`updateMyPhone`，并上传改动过的下单、订单、客户、导出相关云函数。
2. 重新编译小程序，进入“我的订单”页，点击“资料”，确认未绑定状态展示正常。
3. 通过微信授权绑定手机号，确认页面提示成功，`users` 写入 `phoneNumber`、`phoneMasked`、`phoneVerified=true`，`phone_bind_logs` 有记录。
4. 手动填写手机号，确认写入 `phoneVerified=false`、`phoneBindMethod=manual_unverified`。
5. 未绑定手机号时提交单品订单和购物车订单，确认弹窗引导到绑定页。
6. 绑定后提交订单，确认 `orders` 写入 `customerPhoneMasked`、`customerPhoneSnapshot`、`customerPhoneBindMethod`。
7. 用客服/财务/采购角色分别查看客户、订单和导出结果，确认完整或脱敏手机号符合权限。
