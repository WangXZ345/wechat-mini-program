# 多管理员角色权限系统

## 集合设计

### admin_users

字段：

- `_id`
- `openid`
- `name`
- `phone`
- `role`: `super_admin` / `customer_service` / `finance` / `procurement`
- `permissions`: 最终权限数组
- `status`: `active` / `disabled`
- `isActive`: 兼容旧字段，`status=disabled` 时为 `false`
- `createdAt`
- `updatedAt`
- `createdBy`
- `lastLoginAt`

### role_permissions

字段：

- `_id`
- `role`
- `roleName`
- `permissions`
- `description`
- `createdAt`
- `updatedAt`

`getCurrentAdminProfile` 会初始化/更新默认角色权限配置。

### permission_logs

字段：

- `_id`
- `targetAdminId`
- `targetOpenid`
- `beforeRole`
- `afterRole`
- `beforePermissions`
- `afterPermissions`
- `operatorId`
- `operatorOpenid`
- `reason`
- `createdAt`

### admin_operation_logs

字段：

- `_id`
- `operatorId`
- `operatorOpenid`
- `operatorRole`
- `action`
- `resourceType`
- `resourceId`
- `beforeData`
- `afterData`
- `description`
- `createdAt`

## 权限点

订单：

- `order:view`
- `order:review`
- `order:reject`
- `order:edit_remark`
- `order:export`

付款：

- `payment:view_screenshot`
- `payment:confirm`
- `payment:update_status`
- `payment:export`

客户：

- `customer:view_basic`
- `customer:view_account`
- `customer:edit_remark`
- `customer:export_account`

商品：

- `product:view`
- `product:create`
- `product:update`
- `product:delete`
- `product:update_price`
- `product:update_status`

库存：

- `inventory:view`
- `inventory:update`
- `inventory:import`
- `inventory:view_log`
- `inventory:set_warning`
- `inventory:delete_all`

看板：

- `dashboard:view_basic`
- `dashboard:view_sales`
- `dashboard:view_finance`
- `dashboard:view_inventory`

管理员：

- `admin:view`
- `admin:create`
- `admin:update_role`
- `admin:disable`

系统：

- `system:settings`
- `system:payment_methods`

## 默认角色映射

`super_admin`: 全部权限。

`customer_service`:

- `dashboard:view_basic`
- `order:view`
- `order:review`
- `order:reject`
- `order:edit_remark`
- `customer:view_basic`
- `customer:edit_remark`
- `product:view`

`finance`:

- `dashboard:view_basic`
- `dashboard:view_sales`
- `dashboard:view_finance`
- `order:view`
- `payment:view_screenshot`
- `payment:confirm`
- `payment:update_status`
- `payment:export`
- `customer:view_basic`
- `customer:view_account`
- `customer:export_account`
- `order:export`

`procurement`:

- `dashboard:view_basic`
- `dashboard:view_inventory`
- `product:view`
- `product:create`
- `product:update`
- `product:update_status`
- `inventory:view`
- `inventory:update`
- `inventory:import`
- `inventory:view_log`
- `inventory:set_warning`

采购默认不包含 `product:update_price`。

## 关键代码位置

- 权限配置：`cloudfunctions/common/permissions.js`
- 后端鉴权：`cloudfunctions/common/auth.js`
- 当前管理员信息：`cloudfunctions/getCurrentAdminProfile/index.js`
- 管理员列表：`cloudfunctions/getAdminUsers/index.js`
- 新增管理员：`cloudfunctions/createAdminUser/index.js`
- 修改管理员角色：`cloudfunctions/updateAdminRole/index.js`
- 禁用/启用管理员：`cloudfunctions/disableAdminUser/index.js`
- 管理员日志：`cloudfunctions/getAdminOperationLogs/index.js`
- 前端权限工具：`miniprogram/utils/auth.js`
- 动态后台菜单：`miniprogram/pages/admin/dashboard.js`
- 管理员页面：`miniprogram/pages/admin/admins/index`

## 现有云函数权限示例

- `getOrders` 后台模式：`order:view`
- `adminReviewOrder`: `order:review` / `order:reject`
- `updateOrderAdminNote`: `order:edit_remark`
- `exportOrdersExcel`: `order:export`
- `adminUpdatePayment`: `payment:confirm` / `payment:update_status`
- `updateProductPrice`: `product:update_price`
- `batchUpdateProductPrices`: `product:update_price`
- `manageProduct`: `product:create` / `product:update` / `product:delete` / `product:update_status` / `inventory:delete_all`
- `adminSearchProducts`: `product:view`
- `getInventoryLogs`: `inventory:view_log`
- `uploadInventoryFile`: `inventory:import`
- `parseInventoryFile`: `inventory:import`
- `confirmInventoryImport`: `inventory:import`
- `adminListCustomerAccounts`: `customer:view_account`
- `exportCustomerStatement`: `customer:export_account`
- `updateSettings`: `system:settings`

## 数据脱敏方案

- 普通前台接口继续通过 `stripAdminFields` 移除管理员备注、风险等级、管理员标签等字段。
- 后台订单接口 `getOrders` 会根据管理员权限裁剪数据。
- 没有 `payment:view_screenshot` 时，不返回付款截图和完整付款金额字段。
- 没有 `customer:view_account` 时，不返回完整客户账款对象和历史欠款字段。
- `super_admin` 不脱敏。

## 页面访问控制

后台页面在 `onLoad` 阶段调用 `ensureAdmin(permission)`。

没有权限时：

- 显示“你没有权限访问此页面”。
- 不执行页面数据加载。
- 云函数仍会再次校验权限，前端隐藏菜单不是安全边界。

## 测试流程

1. 用普通用户进入后台，应提示无权限。
2. 用客服角色进入后台，只看到后台首页、订单、客户、商品查看相关入口。
3. 客服能查看订单，不能确认付款、不能修改库存、不能导出对账。
4. 用财务角色进入后台，能查看付款截图、确认付款、查看账款、导出账单。
5. 财务不能新增商品、不能修改库存、不能导入库存。
6. 用采购角色进入后台，能查看商品/库存、导入库存、设置库存预警。
7. 采购不能查看付款截图、不能确认付款、不能查看完整客户账款。
8. 超级管理员能进入管理员管理页。
9. 超级管理员新增客服/财务/采购管理员后，新账号权限立即生效。
10. 修改管理员角色后，`permission_logs` 有记录。
11. 禁用管理员后，该管理员无法进入后台或调用后台云函数。
12. 禁用超级管理员时，系统必须至少保留一个 active 的 `super_admin`。
13. 审核订单、拒绝订单、修改备注、付款更新、库存导入、新增/修改/删除商品等关键操作写入 `admin_operation_logs` 或对应业务日志。
14. 手动调用无权限云函数时，应返回失败。
