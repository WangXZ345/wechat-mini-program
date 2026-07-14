# 后台首页数据看板

## 新增入口

- 页面：`pages/admin/dashboard/index`
- 云函数：`getAdminDashboardStats`
- 后台 tab 已指向新页面，旧 `pages/admin/dashboard` 文件保留。

## 数据兼容方案

- 金额全部按“分”计算，前端只负责格式化为 `¥12,345.00`。
- 有效订单兼容英文状态和中文状态：`auto_reviewing`、`pending_admin`、`approved_pending_payment`、`pending_payment_confirm`、`paid`、`unpaid`、`partial_paid`，以及对应中文状态。
- 无效订单排除：`rejected`、`cancelled`、`refunded`，以及对应中文状态。
- 热销商品优先使用 `order_items`；旧单没有 `order_items` 时回退读取 `orders.productId`、`quantity`、`totalAmount`。
- 商品已删除时，热销排行使用订单明细里的商品快照，名称显示为订单中的商品名或“商品已删除”。
- 库存预警优先使用 `products.warningStock`，没有时使用默认值 `10`。
- 欠款优先使用 `customer_accounts.totalUnpaidAmount` / `unpaidAmount`；如果集合为空，则回退从未付款订单按客户聚合。
- 临期商品优先使用 `expiryDate`，90 天内计入提醒、30 天内标记严重临期；没有 `expiryDate` 时，`productionDate` 超过 18 个月只提示“生产日期较早”。

## 建议索引

`orders`

- `createdAt`
- `status`
- `paymentStatus`
- `deliveryStatus`
- `userId`
- `createdAt + status`
- `createdAt + paymentStatus`

`order_items`

- `orderId`
- `productId`
- `createdAt`
- `stockCheckStatus`
- `productId + createdAt`

`products`

- `stock`
- `isActive`
- `warningStock`
- `productionDate`
- `expiryDate`
- `updatedAt`

`customer_accounts`

- `unpaidAmount`
- `totalUnpaidAmount`
- `updatedAt`
- `userId`
- `userOpenid`

## 测试流程

1. 部署 `getAdminDashboardStats` 云函数。
2. 管理员打开后台 tab，确认进入“后台数据看板”。
3. 普通用户打开后台 tab，确认提示无管理员权限。
4. 切换“今日 / 近 3 日 / 近 7 日 / 近 30 日”，确认热销、滞销、趋势数据随范围刷新。
5. 下拉刷新页面，确认数据重新加载且不会重复报错。
6. 检查今日订单数、今日销售额、今日已付款、今日未付款是否与订单数据一致。
7. 检查待审核订单、待确认付款、待发货订单数量是否与订单管理页一致。
8. 检查库存预警和库存为 0 商品数量是否与库存预警页一致。
9. 检查热销排行是否兼容多商品订单和旧单商品订单。
10. 检查滞销商品是否只包含上架、库存大于 0、指定范围内无有效销售记录的商品。
11. 检查客户欠款排行是否按未付金额降序展示。
12. 点击待审核、待确认付款、库存预警、客户欠款等卡片，确认能跳到对应后台页面。
13. 清空测试数据库或使用无数据账号，确认页面显示空状态且不报错。
