# 库存预警功能

## 新增和修改文件

- `cloudfunctions/_utils/stockAlert.js`
- `cloudfunctions/*/stockAlert.js`（使用预警工具的云函数目录内副本，便于单函数部署）
- `miniprogram/utils/stockAlert.js`
- `cloudfunctions/updateStockAlertStatus`
- `cloudfunctions/getStockAlerts`
- `cloudfunctions/updateProductWarningStock`
- `cloudfunctions/batchUpdateWarningStock`
- `cloudfunctions/manageProduct/index.js`
- `cloudfunctions/adminSearchProducts/index.js`
- `cloudfunctions/adminDashboard/index.js`
- `cloudfunctions/parseInventoryFile/index.js`
- `cloudfunctions/confirmInventoryImport/index.js`
- `cloudfunctions/adminReviewOrder/index.js`
- `cloudfunctions/autoReviewOrder/index.js`
- `cloudfunctions/getUnsoldProducts/index.js`
- `cloudfunctions/getProducts/index.js`
- `miniprogram/pages/admin/dashboard.*`
- `miniprogram/pages/admin/products.*`
- `miniprogram/pages/admin/import/preview/*`
- `miniprogram/pages/admin/stock-alerts/index.*`
- `miniprogram/app.json`

## products 新增字段

```json
{
  "stock": 8,
  "warningStock": 10,
  "stockStatus": "warning",
  "autoHideWhenOutOfStock": false,
  "lastStockCheckAt": "serverDate",
  "updatedAt": "serverDate"
}
```

`stockStatus` 规则：

- `stock <= 0`: `out_of_stock`
- `stock > 0 && stock <= warningStock`: `warning`
- `stock > warningStock`: `normal`

## stock_alert_records 集合

```json
{
  "productId": "products._id",
  "productIndex": "P000001",
  "productName": "商品名称",
  "specification": "400ml",
  "productionDate": "2026-06",
  "stock": 8,
  "warningStock": 10,
  "alertType": "warning",
  "status": "active",
  "firstTriggeredAt": "serverDate",
  "lastTriggeredAt": "serverDate",
  "resolvedAt": null,
  "resolvedBy": "",
  "createdAt": "serverDate",
  "updatedAt": "serverDate"
}
```

商品进入 `warning` 或 `out_of_stock` 时创建或更新 active 记录；恢复 `normal` 时标记为 `resolved`。

## inventory_logs 增强字段

```json
{
  "stockStatusBefore": "normal",
  "stockStatusAfter": "warning",
  "warningStock": 10,
  "triggeredAlert": true
}
```

## 测试流程

1. 后台新建商品，不填预警库存，确认 `warningStock = 10` 且 `stockStatus` 正确。
2. 后台新建商品，填写 `warningStock = 5`，确认商品级阈值生效。
3. 设置 `stock = 8, warningStock = 10`，确认状态为 `warning`。
4. 设置 `stock = 8, warningStock = 5`，确认状态为 `normal`。
5. 设置 `stock = 0`，确认状态为 `out_of_stock`。
6. 在商品管理页筛选全部、库存正常、库存预警、已缺货。
7. 在库存预警页修改单个商品预警值，确认状态立即重算。
8. 在库存预警页批量修改预警值，确认最多 200 个商品。
9. 使用一键检查库存状态，确认已有商品补齐 `stockStatus`。
10. Excel 导入包含 `预警库存` 或 `warningStock` 列，确认预览和确认导入后写入字段。
11. Excel/TXT 导入不包含预警列，确认新商品默认 `warningStock = 10`。
12. 审核通过订单扣减库存后，确认商品状态和 `inventory_logs` 增强字段更新。
13. 自动审核通过订单扣减库存后，确认商品状态和预警记录更新。
14. 手动补库存使商品恢复正常，确认 active 预警记录变为 resolved。
15. 普通用户商品首页、搜索、详情、购物车接口不返回 `stock`、`warningStock`、`stockStatus`。
16. 普通用户调用 `getStockAlerts`、`updateProductWarningStock`、`batchUpdateWarningStock` 应返回无管理员权限。
17. 输入小数、负数、文本或超过 99999 的 `warningStock`，后台应拒绝保存。
