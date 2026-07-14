# 多收货地址功能说明

## 集合

### customer_addresses

- `_id`
- `userId`
- `openid`
- `receiverName`
- `receiverPhone`
- `receiverPhoneMasked`
- `province`
- `city`
- `district`
- `regionText`
- `detailAddress`
- `fullAddress`
- `addressTag`
- `isDefault`
- `status`: `active` / `deleted`
- `createdAt`
- `updatedAt`
- `deletedAt`

### address_logs

- `_id`
- `userId`
- `openid`
- `addressId`
- `action`: `create` / `update` / `delete` / `set_default`
- `beforeDataMasked`
- `afterDataMasked`
- `operatorType`: `user` / `admin`
- `operatorId`
- `operatorOpenid`
- `createdAt`

## 订单字段

发货订单创建时，前端只传 `addressId`，云函数从 `customer_addresses` 读取地址后写入订单快照：

- `shippingType`: `delivery` / `pickup`
- `addressId`
- `shippingAddressSnapshot`
- `shippingAddressMasked`
- `addressSelectedAt`

为兼容现有配送页面，订单仍保留旧字段：

- `deliveryType`: `shipping` / `self_pickup`
- `shippingAddress`
- `pickupInfo`

## 权限

新增权限点：

- `customer:view_address_masked`
- `customer:view_address_full`
- `customer:export_address`
- `customer:manage_address_admin`

默认角色：

- `super_admin`: 全部地址权限
- `customer_service`: 查看完整地址、导出地址
- `finance`: 查看完整地址、导出地址
- `procurement`: 仅查看脱敏地址

## 配置默认值

`settings/system_settings` 读取时增加默认值：

- `requireAddressBeforeDeliveryOrder`: `true`
- `maxAddressCountPerUser`: `20`
- `allowPickupWithoutAddress`: `true`
- `defaultShippingType`: `delivery`

## 验收重点

1. 新用户地址列表为空，页面显示空状态。
2. 新增第一条地址后自动成为默认地址。
3. 新增第二条地址不影响默认地址；主动设默认会取消旧默认。
4. 编辑、删除、设默认只能操作自己的地址。
5. 删除地址为软删除，不影响历史订单快照。
6. 商品详情和购物车发货下单必须选择地址，只传 `addressId`。
7. 自提订单不需要收货地址。
8. 订单创建后保存完整快照和脱敏快照。
9. 后台订单列表按权限显示完整或脱敏地址。
10. 订单导出按 `customer:export_address` 权限导出完整或脱敏地址。
