# 合并发货功能

本功能用于把同一客户的多个发货订单关联到一个合并发货单，统一填写快递公司和快递单号。合并发货只管理物流，不合并订单本身，不重算订单金额，不修改付款记录、客户账款和库存。

## 新增集合

### shipment_groups

- `shipmentNo`: 合并发货单号，例如 `MS202606250001`。
- `userId` / `openid`: 客户标识。
- `customerName` / `customerPhoneMasked`: 后台展示用客户信息。
- `orderIds` / `orderNos` / `orderCount`: 关联订单。
- `totalItemCount` / `totalProductCount`: 商品件数和聚合商品数。
- `totalOrderAmount` / `totalPaidAmount` / `totalUnpaidAmount`: 展示统计，不回写财务。
- `shippingAddressSnapshot` / `shippingAddressMasked`: 发货时地址快照。
- `addressConsistent`: 所选订单地址是否一致。
- `shippingCompany` / `trackingNo` / `trackingNoList`: 物流信息。
- `shippingStatus`: `created` / `pending_shipment` / `shipped` / `completed` / `cancelled` / `abnormal`。
- `shippedAt` / `completedAt` / `cancelledAt` / `cancelledBy` / `cancelReason` / `shippedBy`。
- `createdBy` / `updatedBy` / `adminRemark` / `shipmentImages` / `createdAt` / `updatedAt`。

### shipment_group_items

- `shipmentGroupId` / `shipmentNo`: 所属合并发货单。
- `orderId` / `orderNo`: 来源订单。
- `productId` / `productName` / `brand` / `category` / `specification` / `productionDate`。
- `quantity` / `unitPrice` / `subtotal` / `imageUrl` / `tags` / `createdAt`。

该集合是商品快照，只用于查看和导出拣货单，不参与扣库存或账款计算。

### shipment_logs

- `shipmentGroupId` / `shipmentNo` / `orderIds`。
- `action`: `create` / `update` / `ship` / `cancel` / `complete` / `remove_order` / `add_order` / `abnormal`。
- `beforeData` / `afterData`: 脱敏后的操作前后数据。
- `operatorId` / `operatorOpenid` / `operatorRole` / `remark` / `createdAt`。

关键操作同时写入 `admin_operation_logs`。

## orders 字段

合并发货创建后，关联订单写入：

- `mergeShipmentId`
- `mergeShipmentNo`
- `isMergedShipment`
- `mergeShipmentStatus`
- `shippingStatus`
- `shipmentRemark`
- `shipmentUpdatedAt`

确认发货后，关联订单同步写入：

- `shippingStatus = shipped`
- `deliveryStatus = shipped`
- `shippingCompany`
- `trackingNo`
- `expressCompany`
- `expressNo`
- `shippedAt`
- `shippedBy`
- `mergeShipmentStatus = shipped`

取消未发货合并单后，只清除发货关联并把订单恢复到待发货物流状态，不取消订单、不恢复库存、不改变付款和账款。

## 云函数

主实现为 `shipmentGroups`，以下云函数为兼容入口：

- `checkMergeShipmentEligibility`
- `createMergeShipment`
- `getAdminShipmentGroups`
- `getShipmentGroupDetail`
- `updateShipmentInfo`
- `confirmShipment`
- `cancelMergeShipment`
- `completeShipment`
- `exportShipmentPickingList`

校验规则包括同一客户、发货订单、允许发货状态、付款状态、未加入其他有效合并发货单、未发货、地址一致、最大订单数和最大商品件数。

## 权限点

新增：

- `shipment:view`
- `shipment:merge`
- `shipment:update`
- `shipment:ship`
- `shipment:cancel`
- `shipment:complete`
- `shipment:export`
- `shipment:view_address_full`
- `shipment:view_address_masked`
- `order:ship`

默认角色：

- `super_admin`: 全部权限。
- `customer_service`: 可查看、创建、更新、确认、取消、完成、导出，并查看完整地址。
- `finance`: 可查看合并发货和脱敏地址，默认不能确认或取消发货。
- `procurement`: 可查看合并发货和脱敏地址，可导出拣货单但不确认发货。

## 前端页面

- `pages/admin/orders`: 增加发货筛选、多选、底部“合并发货”批量操作。
- `pages/admin/shipments/merge-confirm`: 合并发货确认页。
- `pages/admin/shipments/index`: 合并发货单列表页。
- `pages/admin/shipments/detail`: 合并发货单详情、物流维护、确认发货、取消、完成和导出。
- `pages/order/list`: 用户订单列表展示已合并发货和物流摘要。
- `pages/order/detail`: 用户订单详情展示合并发货模块和复制快递单号。
- `pages/admin/settings`: 增加合并发货配置。

## 部署范围

需要上传云函数：

- `shipmentGroups`
- `checkMergeShipmentEligibility`
- `createMergeShipment`
- `getAdminShipmentGroups`
- `getShipmentGroupDetail`
- `updateShipmentInfo`
- `confirmShipment`
- `cancelMergeShipment`
- `completeShipment`
- `exportShipmentPickingList`
- `getOrders`
- `getSettings`
- `updateSettings`
- `exportOrdersExcel`
- 管理员权限相关云函数如果线上已有旧权限表，也建议同步上传 `getCurrentAdminProfile`、`getAdminUsers`、`createAdminUser`、`updateAdminRole`。

小程序前端需要重新编译或预览：

- `miniprogram/app.json`
- `pages/admin/orders`
- `pages/admin/shipments/*`
- `pages/admin/settings`
- `pages/order/list`
- `pages/order/detail`

旧入口保留兼容：

- `adminUpdateDeliveryStatus`
- 旧订单字段 `deliveryStatus`、`expressCompany`、`expressNo`

本次没有上传云函数，也没有发布小程序。

## 验收建议

1. 用同一客户两个已付款发货订单，在后台订单页勾选并创建合并发货单。
2. 确认 `orders` 只新增合并发货关联字段，订单金额、付款记录、客户账款和库存不变化。
3. 选择不同客户、自提、未付款、已发货、已取消、地址不一致订单，确认被拦截并显示原因。
4. 在发货单详情填写快递公司和快递单号，确认发货后检查所有关联订单 `shippingStatus` 和 `deliveryStatus` 为 `shipped`。
5. 用户端订单详情查看合并发货模块，并复制快递单号。
6. 未发货的合并发货单可取消，取消后订单恢复待发货关联状态。
7. 已发货合并单不能取消，可以标记完成。
8. 导出拣货单，检查商品数量和订单号汇总正确，地址/手机号按权限导出。
