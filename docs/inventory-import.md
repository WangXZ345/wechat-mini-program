# 自动导入库存表功能说明

## 新增文件

- `cloudfunctions/uploadInventoryFile/index.js`
- `cloudfunctions/parseInventoryFile/index.js`
- `cloudfunctions/parseInventoryFile/utils/parseProductName.js`
- `cloudfunctions/confirmInventoryImport/index.js`
- `cloudfunctions/getInventoryImports/index.js`
- `miniprogram/pages/admin/import/index.*`
- `miniprogram/pages/admin/import/preview/index.*`
- `miniprogram/pages/admin/import/history/index.*`

同时修改：

- `miniprogram/app.json`：注册库存导入页面，并修复原有乱码导致的 JSON 无效问题。
- `miniprogram/pages/admin/dashboard.wxml`：新增“库存导入”入口，并修复原有乱码导致的 WXML 标签损坏问题。

## 新增数据库集合

### import_records

```json
{
  "_id": "自动生成",
  "fileName": "上传文件名",
  "fileType": "xlsx / xls / txt",
  "fileUrl": "文件 URL，可为空",
  "fileID": "云存储 fileID",
  "operatorId": "管理员 openid",
  "totalRows": 10,
  "successRows": 0,
  "failedRows": 0,
  "skippedRows": 0,
  "mode": "override / add",
  "status": "parsed / imported / failed",
  "createdAt": "创建时间",
  "importedAt": "确认导入时间"
}
```

### import_record_items

```json
{
  "_id": "自动生成",
  "importRecordId": "import_records._id",
  "rowNo": 1,
  "rawName": "原始商品名称",
  "baseName": "清洗后商品名称",
  "specification": "400ml",
  "productionDate": "2026-03-01",
  "stock": 12,
  "matchedProductId": "匹配商品 ID",
  "matchedProductName": "匹配商品名称",
  "matchLevel": "exact / sameNameSameSpecDifferentDate / fuzzy / multiple / none",
  "candidates": [],
  "action": "update / create / error / ignore",
  "errorMessage": "",
  "selected": true,
  "finalProductId": "最终写入商品 ID",
  "createdAt": "创建时间"
}
```

## 云函数

### uploadInventoryFile

小程序端先用 `wx.cloud.uploadFile` 上传本地临时文件，再调用该函数做管理员权限校验、文件格式校验和元数据返回。支持 `xlsx`、`xls`、`txt`。

### parseInventoryFile

接收 `fileID`、`fileName`、`mode`，下载云存储文件并解析：

- Excel：使用 `xlsx` 读取首个工作表，自动匹配商品名称列和库存列。
- TXT：逐行调用 `parseInventoryLine` 识别商品名称、规格、生产日期、库存。
- 解析后匹配 `products` 集合，生成 `import_records` 和 `import_record_items`。
- 只生成预览数据，不写入商品库存。

### confirmInventoryImport

接收 `importRecordId`、管理员编辑后的 `items` 和 `mode`：

- `update`：再次读取商品并校验规格，按覆盖或增加模式更新 `products.stock`。
- `create`：创建新商品。若 Excel 识别到价格，直接写入 `price` 并设置 `isActive = true`；未识别到价格时 `price = 0`、`isActive = false`。
- 若导入行匹配到已有商品，并且 Excel 识别到价格，会同步更新已有商品 `price`。
- `ignore` / 未勾选：跳过。
- 每次库存变化写入 `inventory_logs`，`reason` 为 `import_override`、`import_add` 或 `import_create`。
- 使用 `db.runTransaction` 防止重复确认和关键库存写入不一致。

### getInventoryImports

管理员查询导入历史和某次导入明细。

## 商品名称解析工具

`cloudfunctions/parseInventoryFile/utils/parseProductName.js` 包含：

- `normalizeText(text)`
- `extractSpecification(text)`
- `extractProductionDate(text)`
- `extractStock(text)`
- `cleanBaseName(text)`
- `parseInventoryLine(line)`

支持示例：

- `兰蔻粉水 400ml 2026-03-01 库存 12`
- `雅诗兰黛小棕瓶50ml 生产日期2025.12 数量8`
- `SK-II神仙水 230ml 10瓶`

## 后台页面

### pages/admin/import/index

- 选择 Excel / TXT 文件。
- 选择覆盖库存或增加库存。
- 上传到云存储后调用解析云函数。
- 跳转预览页。

### pages/admin/import/preview

- 展示 rawName、baseName、specification、productionDate、stock、匹配信息、action、errorMessage。
- 展示并允许修改 price，单位为分。
- 支持编辑识别结果。
- 支持勾选行。
- 支持选择更新、创建、忽略。
- 点击确认导入后才写入数据库。

### pages/admin/import/history

- 展示导入历史。
- 可查看每次导入明细和失败原因。

## 前台读取最新库存

当前项目已经满足同步要求：

- 前台商品列表调用 `getProducts`，只展示 `isActive: true` 商品，并对客户删除 `stock` 字段。
- 下单云函数 `createOrder` 每次实时读取 `products.stock` 判断库存是否足够。
- 导入确认后直接更新 `products.stock`，所以已有商品的前台库存判断会自动使用最新值。
- 新建商品如果导入价格大于 0，会直接 `isActive: true` 并在前台展示；没有价格时仍保持 `isActive: false`。

## 测试用例

1. Excel 正常解析：列名为 `商品名称`、`库存`，确认预览行正确生成。
2. Excel 英文列名：列名为 `productName`、`quantity`，确认可识别。
3. Excel 缺少商品列：应返回 `Excel 没有识别到商品名称列`。
4. Excel 缺少库存列：应返回 `Excel 没有识别到库存列`。
5. TXT 正常解析：`兰蔻粉水 400ml 2026-03-01 库存 12`。
6. TXT 数量后缀：`SK-II神仙水 230ml 10瓶` 应识别库存 10。
7. TXT 无库存：该行 action 为 `error`，不能确认入库。
8. 库存小于 0 或非整数：确认导入时后端拒绝该行。
9. 精确匹配：同 `name + specification + productionDate` 时 action 为 `update`。
10. 同名同规格不同日期：默认 action 为 `create`，并给出新批次提示。
11. 模糊匹配：默认 action 为 `error`，必须管理员人工改 action。
12. 覆盖库存：原库存 5，导入 12，确认后库存为 12。
13. 增加库存：原库存 5，导入 12，确认后库存为 17。
14. 新建商品：有价格时写入价格并上架；无价格时 `price = 0`、`isActive = false`。
15. 重复点击确认：第二次应返回该导入记录已确认。
16. 非管理员调用任意导入云函数：应返回无管理员权限。
