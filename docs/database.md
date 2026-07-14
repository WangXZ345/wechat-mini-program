# 数据库集合设计

所有金额字段均使用整数“分”为单位。

## users

```json
{
  "_id": "自动生成",
  "openid": "微信 openid",
  "nickname": "客户昵称",
  "phone": "手机号",
  "createdAt": "创建时间",
  "updatedAt": "更新时间"
}
```

## admin_users

```json
{
  "_id": "自动生成",
  "openid": "管理员 openid",
  "isActive": true,
  "createdAt": "创建时间"
}
```

## products

```json
{
  "_id": "自动生成",
  "name": "商品名称",
  "imageUrl": "云存储 fileID 或图片 URL",
  "specification": "规格",
  "price": 19900,
  "productionDate": "2026-06-06",
  "stock": 100,
  "description": "商品说明",
  "isActive": true,
  "createdAt": "创建时间",
  "updatedAt": "更新时间"
}
```

## orders

```json
{
  "_id": "自动生成",
  "orderNo": "PO202606062300001234",
  "userId": "users._id",
  "userOpenid": "客户 openid",
  "productId": "products._id",
  "productName": "商品名称快照",
  "quantity": 2,
  "unitPrice": 19900,
  "totalAmount": 39800,
  "status": "auto_reviewing",
  "reviewType": "auto",
  "paymentMethod": "",
  "paymentScreenshotUrl": "",
  "paymentStatus": "none",
  "deliveryType": "shipping",
  "pickupInfo": null,
  "shippingAddress": {
    "receiverName": "张三",
    "receiverPhone": "13800000000",
    "province": "广东省",
    "city": "广州市",
    "district": "天河区",
    "detailAddress": "某街道 1 号",
    "fullAddress": "广东省广州市天河区某街道 1 号",
    "remark": "可选备注"
  },
  "deliveryStatus": "pending",
  "expressCompany": "",
  "expressNo": "",
  "shippedAt": null,
  "pickedUpAt": null,
  "completedAt": null,
  "deliveryRemark": "",
  "deliveryImageUrl": "",
  "createdAt": "创建时间",
  "approvedAt": null,
  "paidMarkedAt": null,
  "updatedAt": "更新时间"
}
```

订单状态：

- `pending_system`：待系统判断
- `auto_reviewing`：自动审核中
- `pending_admin`：待管理员审核
- `approved_pending_payment`：已通过待支付
- `pending_payment_confirm`：待确认付款
- `paid`：已付款
- `unpaid`：未付款
- `rejected`：已拒绝
- `cancelled`：已取消

付款状态：

- `none`
- `pending_confirm`
- `paid`
- `unpaid`
- `partial`
- `abnormal`

## order_items

购物车提交订单时会把每个商品明细写入 `order_items`。如果云开发环境尚未创建该集合，当前 `submitCartOrder` 会在事务前尝试自动创建；仍建议初始化数据库时手动创建，便于设置权限和索引。

```json
{
  "_id": "自动生成",
  "orderId": "orders._id",
  "productId": "products._id",
  "productName": "商品名称快照",
  "productImage": "商品图片快照",
  "specification": "规格快照",
  "productionDate": "生产日期快照",
  "quantity": 2,
  "unitPrice": 11500,
  "totalAmount": 23000,
  "stockCheckStatus": "enough",
  "createdAt": "创建时间"
}
```

## inventory_logs

```json
{
  "_id": "自动生成",
  "productId": "products._id",
  "beforeStock": 100,
  "afterStock": 98,
  "changeAmount": -2,
  "reason": "订单扣减",
  "relatedOrderId": "orders._id",
  "operatorId": "system 或管理员 openid",
  "createdAt": "创建时间"
}
```

## customer_accounts

```json
{
  "_id": "自动生成",
  "userId": "users._id",
  "userOpenid": "客户 openid",
  "nickname": "客户昵称",
  "phone": "手机号",
  "totalOrderAmount": 39800,
  "totalPaidAmount": 0,
  "totalUnpaidAmount": 39800,
  "todayOrderAmount": 39800,
  "historyUnpaidAmount": 0,
  "pendingConfirmAmount": 0,
  "abnormalAmount": 0,
  "abnormalCount": 0,
  "orderCount": 1,
  "paidOrderCount": 0,
  "unpaidOrderCount": 1,
  "partialPaidOrderCount": 0,
  "lastOrderAt": "最近一次订单通过时间",
  "lastPaymentAt": "最近一次付款确认时间",
  "riskLevel": "normal",
  "isSettled": false,
  "adminRemark": "",
  "createdAt": "创建时间",
  "updatedAt": "更新时间"
}
```

兼容旧字段：`totalReceivableAmount`、`paidAmount`、`unpaidAmount` 仍会同步写入，便于旧页面或旧导出逻辑读取。

风险等级：

- `normal`：正常
- `watch`：关注
- `risky`：订单默认进入人工审核
- `blocked`：禁止提交订单

## payment_records

```json
{
  "_id": "自动生成",
  "orderId": "orders._id",
  "userId": "users._id",
  "userOpenid": "客户 openid",
  "orderAmount": 39800,
  "paidAmount": 39800,
  "unpaidAmount": 0,
  "paymentMethod": "微信转账",
  "paymentScreenshotUrl": "cloud://...",
  "paymentStatus": "paid",
  "confirmStatus": "confirmed",
  "confirmedBy": "管理员 openid",
  "confirmedAt": "确认时间",
  "remark": "备注",
  "createdAt": "创建时间",
  "updatedAt": "更新时间"
}
```

`confirmStatus` 可选值：`pending`、`confirmed`、`rejected`、`abnormal`。

## account_logs

```json
{
  "_id": "自动生成",
  "userId": "users._id",
  "userOpenid": "客户 openid",
  "relatedOrderId": "orders._id",
  "relatedPaymentRecordId": "payment_records._id",
  "changeType": "order_approved",
  "beforeTotalOrderAmount": 0,
  "afterTotalOrderAmount": 39800,
  "beforeTotalPaidAmount": 0,
  "afterTotalPaidAmount": 0,
  "beforeTotalUnpaidAmount": 0,
  "afterTotalUnpaidAmount": 39800,
  "changeAmount": 39800,
  "operatorId": "管理员 ID 或 system",
  "operatorOpenid": "管理员 openid 或 system",
  "remark": "流水备注",
  "createdAt": "创建时间"
}
```

`changeType` 可选值：`order_approved`、`payment_confirmed`、`partial_payment_confirmed`、`payment_abnormal`、`order_cancelled_restore`、`manual_settled`、`manual_adjustment`。

## 订单新增账款字段

`orders` 集合新增或补齐：

```json
{
  "paidAmount": 0,
  "unpaidAmount": 39800,
  "paymentSubmittedAt": "付款截图提交时间",
  "paymentConfirmedAt": "付款确认时间",
  "paymentConfirmedBy": "确认管理员 openid",
  "paymentRemark": "付款备注",
  "accountIncluded": true,
  "settlementStatus": "normal",
  "settledBy": "",
  "settledAt": null,
  "settledRemark": "",
  "riskLevelSnapshot": "normal"
}
```

订单金额继续使用下单时写入的 `totalAmount` 快照，后续商品价格变化不会影响历史账款。

## 配送相关字段

`users` 新增字段：

```json
{
  "defaultDeliveryType": "shipping 或 self_pickup",
  "lastShippingAddress": {
    "receiverName": "张三",
    "receiverPhone": "13800000000",
    "province": "广东省",
    "city": "广州市",
    "district": "天河区",
    "detailAddress": "某街道 1 号",
    "fullAddress": "广东省广州市天河区某街道 1 号",
    "remark": "可选备注"
  },
  "updatedAt": "更新时间"
}
```

`orders.deliveryType` 可选值：

- `self_pickup`：自提
- `shipping`：发货

`orders.deliveryStatus` 可选值：

- `pending`：待处理，订单刚创建或未付款时使用
- `waiting_pickup`：待自提，付款确认后进入
- `picked_up`：已自提
- `waiting_shipping`：待发货，付款确认后进入
- `shipped`：已发货
- `completed`：已完成
- `after_sales`：售后中

`orders.pickupInfo` 是自提配置快照，订单提交时由后端从 `settings/pickup_settings` 读取，用户不能直接提交该字段。

## settings/pickup_settings

自提配置保存在 `settings` 集合的固定文档 ID：`pickup_settings`。这样无需额外部署自提配置读取/保存云函数。

```json
{
  "_id": "pickup_settings",
  "pickupLocation": "自提地址",
  "pickupTimeNote": "自提时间说明",
  "pickupContact": "联系人",
  "pickupPhone": "联系电话",
  "pickupRemark": "自提备注",
  "updatedAt": "更新时间",
  "updatedBy": "admin_users._id",
  "updatedByOpenid": "管理员 openid"
}
```

## delivery_logs

所有配送状态变化都会写入日志，包括付款确认后进入待发货/待自提、确认发货、标记已自提、完成和售后。

```json
{
  "_id": "自动生成",
  "orderId": "orders._id",
  "orderNo": "订单号",
  "deliveryType": "shipping 或 self_pickup",
  "beforeStatus": "pending",
  "afterStatus": "waiting_shipping",
  "expressCompany": "顺丰",
  "expressNo": "SF123456",
  "remark": "备注",
  "imageUrl": "云存储 fileID 或图片 URL",
  "operatorId": "admin_users._id",
  "operatorOpenid": "管理员 openid",
  "action": "payment_confirmed / confirm_shipping / mark_picked_up / complete / after_sales",
  "createdAt": "创建时间"
}
```

## settings

支付方式配置使用固定文档 ID：`payment_methods`。

```json
{
  "_id": "payment_methods",
  "methods": ["微信转账", "支付宝", "银行转账"],
  "updatedAt": "更新时间"
}
```

## admin_notifications

```json
{
  "_id": "自动生成",
  "type": "manual_order_review",
  "orderId": "orders._id",
  "productId": "products._id",
  "userOpenid": "客户 openid",
  "isRead": false,
  "createdAt": "创建时间"
}
```

## user_search_history

用户端最近搜索记录。云函数必须使用后端 `OPENID` 写入和查询，前端传入的 `openid` 不可信。

```json
{
  "_id": "自动生成",
  "openid": "客户 openid",
  "userId": "unionid 或 openid",
  "keyword": "展示用搜索词，已 trim，最长 30 字符",
  "normalizedKeyword": "去重用搜索词，小写并去除空格",
  "searchCount": 1,
  "lastSearchedAt": "最近搜索时间",
  "createdAt": "创建时间",
  "updatedAt": "更新时间"
}
```

建议索引：

- `openid + lastSearchedAt desc`：读取当前用户最近搜索。
- `openid + normalizedKeyword`：同一用户搜索词去重。

每个用户最多保留 20 条，重复搜索只更新 `searchCount` 和 `lastSearchedAt`。

## search_stats

搜索统计和热门搜索词。该集合不保存用户维度明细，只保存关键词聚合结果；疑似手机号、长数字串、地址类关键词不进入热门统计。

```json
{
  "_id": "自动生成",
  "keyword": "展示用搜索词",
  "normalizedKeyword": "去重用搜索词",
  "searchCount": 1,
  "resultCount": 12,
  "lastSearchedAt": "最近搜索时间",
  "createdAt": "创建时间",
  "updatedAt": "更新时间"
}
```

建议索引：

- `normalizedKeyword`：统计去重。
- `searchCount desc`：热门搜索读取。

## export_records

每次后台订单 Excel 导出都会写入一条记录，成功和失败都会记录。

```json
{
  "_id": "自动生成",
  "exportType": "summary 或 detail",
  "fileName": "订单导出_汇总_20260614_153000.xlsx",
  "fileID": "云存储 fileID，失败时为空",
  "fileUrl": "临时下载链接，失败时为空",
  "filters": {
    "startDate": "筛选开始时间",
    "endDate": "筛选结束时间",
    "orderStatus": "订单状态或 all",
    "paymentStatus": "付款状态或 all",
    "customerKeyword": "客户关键词",
    "productKeyword": "商品关键词",
    "includeCancelled": false
  },
  "totalOrders": 100,
  "totalRows": 120,
  "operatorId": "admin_users._id",
  "operatorOpenid": "管理员 openid",
  "status": "success 或 failed",
  "errorMessage": "失败原因，成功时为空",
  "createdAt": "创建时间"
}
```

## note_logs

管理员备注修改日志。每次修改订单备注或客户备注、清空备注、修改客户标签或风险等级，都需要写入一条记录。

```json
{
  "_id": "自动生成",
  "targetType": "order 或 customer",
  "targetId": "orders._id 或 users._id",
  "userId": "users._id",
  "orderId": "orders._id，客户备注为空",
  "beforeNote": "修改前备注",
  "afterNote": "修改后备注",
  "beforeTags": ["修改前标签"],
  "afterTags": ["修改后标签"],
  "beforeRiskLevel": "normal",
  "afterRiskLevel": "risk",
  "operatorId": "admin_users._id",
  "operatorOpenid": "管理员 openid",
  "operatorName": "管理员名称或 openid",
  "createdAt": "创建时间"
}
```

## 管理员备注字段

`orders` 新增字段：

```json
{
  "adminNote": "仅后台可见的订单备注",
  "adminNoteUpdatedAt": "最后修改时间",
  "adminNoteUpdatedBy": "最后修改人",
  "adminNoteUpdatedByOpenid": "最后修改管理员 openid",
  "riskLevelSnapshot": "创建订单时的客户风险等级"
}
```

`customer_accounts` 新增字段：

```json
{
  "adminNote": "仅后台可见的客户备注",
  "adminTags": ["老客户", "付款慢"],
  "riskLevel": "normal / important / slow_pay / risk / blocked",
  "adminNoteUpdatedAt": "最后修改时间",
  "adminNoteUpdatedBy": "最后修改人",
  "adminNoteUpdatedByOpenid": "最后修改管理员 openid"
}
```

风险等级规则：

- `normal`：正常走原有下单和审核逻辑。
- `important`：正常走原有逻辑，后台展示重要客户标识。
- `slow_pay`：正常提交订单，后台展示付款慢提醒。
- `risk`：订单进入待管理员审核，不执行自动审核。
- `blocked`：拒绝创建订单，用户端只提示“当前账号暂无法下单，请联系商家。”。
