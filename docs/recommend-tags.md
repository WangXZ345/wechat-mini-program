# 首页推荐区 + 商品标签系统

## 推荐区范围

首页和后台推荐配置只允许以下 4 个 `sectionKey`：

- `new_arrivals`：新货
- `defective`：瑕疵
- `hot_selling`：热销推荐
- `frequent_purchase`：常购

其它推荐区即使存在于数据库，也不会被 `getHomeRecommendations`、`getRecommendProducts`、`getAdminRecommendSections` 返回。

## products 字段

- `tags`：前台可见标签，只允许 `新货`、`瑕疵`、`热销`，最多 4 个。
- `internalTags`：后台内部标签，最多 20 个，用户端接口不返回。
- `isNew`、`isDefective`、`isHot`：商品推荐标签布尔标记。
- `isFrequent`：不再由后台手动维护，常购推荐只按当前用户的 `user_product_purchase_stats` 生成。
- `defectDescription`：瑕疵说明。
- `tagUpdatedAt`、`tagUpdatedBy`：标签更新时间和操作人。

用户端推荐和搜索接口不返回 `stock`、`realStock`、`availableStock`、`costPrice`、`supplier`、`supplierInfo`、`internalTags`、`adminRemark`、`inventoryLogs`、`priceLogs`。

## 常购规则

`frequent_purchase` 使用当前用户 `user_product_purchase_stats` 中的购买频率和最近购买时间排序。没有购买统计时返回空列表，不再使用商品上的 `isFrequent` 或“常购”标签兜底。

商品编辑页、商品筛选和批量标签只保留 `新货`、`瑕疵`、`热销`。Excel/批量导入也不再把“常购”识别为前台商品标签。

## home_recommend_sections

字段：

- `sectionKey`
- `sectionTitle`
- `subtitle`
- `displayType`
- `sourceType`
- `ruleConfig`
- `fallbackTag`
- `enabled`
- `sortIndex`
- `maxItems`
- `showMore`
- `createdAt`
- `updatedAt`
- `createdBy`
- `updatedBy`

`getAdminRecommendSections` 和 `getHomeRecommendations` 会在缺失时自动补齐 4 个默认配置。后台推荐配置页里的常购区是用户个性化数据，后台预览商品列表为空。

## 日志集合

`product_tag_logs`：

- `productId`
- `productName`
- `beforeTags`
- `afterTags`
- `beforeInternalTags`
- `afterInternalTags`
- `beforeFlags`
- `afterFlags`
- `beforeDefectDescription`
- `afterDefectDescription`
- `operatorId`
- `operatorOpenid`
- `operatorRole`
- `createdAt`

`home_recommend_logs`：

- `sectionKey`
- `sectionTitle`
- `action`
- `beforeData`
- `afterData`
- `operatorId`
- `operatorOpenid`
- `operatorRole`
- `createdAt`

关键操作也写入 `admin_operation_logs`。

## 权限点

新增权限：

- `product:tag:view`
- `product:tag:update`
- `product:tag:batch_update`
- `home_recommend:view`
- `home_recommend:manage`

默认角色：

- `super_admin`：全部权限。
- `procurement`：可管理商品标签和推荐区。
- `customer_service`：只读商品标签和推荐区。
- `finance`：默认没有标签和推荐区管理权限。

## 部署范围

需要上传的云函数：

- `getHomeRecommendations`
- `getRecommendProducts`
- `updateProductTags`
- `batchUpdateProductTags`
- `getAdminRecommendSections`
- `updateRecommendSection`
- `enableRecommendSection`
- `disableRecommendSection`
- `sortRecommendSections`
- `searchProducts`
- `getProducts`
- `adminSearchProducts`
- `manageProduct`
- `parseMergedInventoryImport`
- `confirmMergedInventoryImport`
- `getImportDetail`
- `getImportHistory`
- `runImportSelfCheck`
- 涉及权限读取的后台云函数副本，包括已同步的 `permissions.js` 和 `common/recommend.js`

需要重新编译或预览的小程序前端：

- `pages/index/index`
- `pages/recommend/list`
- `pages/product/detail`
- `pages/admin/products`
- `pages/admin/recommend/index`
- `pages/admin/dashboard/index`
- `pages/admin/import/preview/index`
- `app.json`

## 验收重点

1. 首页可在新货、瑕疵、热销推荐、常购之间切换。
2. 常购区只展示当前用户下过单的商品；没有购买记录时不显示旧的手动常购商品。
3. 推荐商品只包含上架、未删除、`price > 0` 的商品。
4. 推荐和搜索接口不返回库存、内部标签、成本价、供应商和后台备注。
5. 瑕疵商品详情页展示 `defectDescription`；为空时展示默认提示。
6. 商品编辑页不再出现常购勾选、常购开关、常购筛选或批量常购按钮。
7. 商品标签更新写入 `product_tag_logs` 和 `admin_operation_logs`。
8. 推荐配置更新写入 `home_recommend_logs` 和 `admin_operation_logs`。
9. 导入预览只识别并展示新货、瑕疵、热销和瑕疵说明，不再把常购当成商品标签。
