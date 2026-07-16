# Simplification Task 1 执行报告

## Status

完成。首页商品点击只写脱敏内存快照并立即导航；异步持久化状态机及其底层异步 cache API 已删除。详情页精确网络结果仍通过同步 `writeProductPreview` 写持久缓存。

## 变更摘要

- `miniprogram/pages/index/index.js`
  - `goDetail` 保留 `stageProductPreview(product)` 和 `wx.navigateTo(...)`。
  - 删除 `writeProductPreviewAsync` 导入及 `navigateTo.success` 持久化回调。
- `miniprogram/utils/performanceCache.js`
  - 删除 `writeProductPreviewAsync`、pending generation、authoritative preview、tombstone/reconcile 状态。
  - 保留脱敏内存快照、同步精确快照写入和双层清理。
  - `readProductPreview` 使用 `allowExpired: false`，过期持久快照由 cache 层拒绝并删除。
- `miniprogram/utils/cache.js`
  - 删除已无调用方的 `rawSetAsync` / `setAsync`，保留同步 envelope `set/get/remove`。
- 测试
  - 首页三条路径覆盖列表商品、当前可见推荐商品和缺失商品。
  - 删除异步完成顺序与 generation/reconcile 测试。
  - 保留公开字段白名单/敏感字段剥离、商品与用户隔离、一次消费、TTL、同步精确写入、持久过期删除和双层清理契约。

## TDD RED

先仅修改测试，然后运行：

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test miniprogram/utils/performanceCache.test.js miniprogram/pages/index/index.test.js
```

结果：退出码 `1`，`8 pass / 2 fail`。两条首页路径均因旧实现仍在 `navigateTo.success` 调用 `writeProductPreviewAsync` 而失败：`TypeError: writeProductPreviewAsync is not a function`。失败原因与目标行为一致。

## TDD GREEN 与验证

聚焦测试：

```powershell
& $node --test miniprogram/utils/performanceCache.test.js miniprogram/pages/index/index.test.js miniprogram/pages/product/detail.test.js
```

结果：退出码 `0`，`22/22 PASS`。

全量小程序测试：

```powershell
$tests=rg --files miniprogram | Where-Object { $_ -match '\.test\.js$' } | Sort-Object
& $node --test $tests
```

结果：退出码 `0`，`50/50 PASS`。

语法检查：

```powershell
& $node --check miniprogram/utils/cache.js
& $node --check miniprogram/utils/performanceCache.js
& $node --check miniprogram/pages/index/index.js
& $node --check miniprogram/pages/product/detail.js
```

结果：四条命令退出码均为 `0`。

静态边界：

- `writeProductPreviewAsync|setAsync|productPreviewGenerations|authoritative|reconcile`：`miniprogram` 无命中。
- 敏感字段搜索只命中 `miniprogram/utils/performanceCache.js` 的剥离名单；`miniprogram/pages/product/detail.wxml` 无命中。
- `git diff --check`：无输出。
- UTF-8 严格解码与替换字符检查：相关 7 个实现/测试文件全部通过。
- 变更范围：5 个计划内实现/测试文件和本报告；`detail.js`、`detail.test.js` 仅验证，未修改。

## 自审

- 首页点击路径不存在同步或异步 storage 写入。
- 详情 `loadProduct` 的精确网络结果仍同步调用 `writeProductPreview(shapedProduct)`。
- 过期持久快照继续由 `cache.get(... allowExpired: false ...)` 返回 `null` 并删除 storage key。
- `clearProductPreview` 同时删除内存和持久层。
- 详情同步订阅首帧门禁、unload guard 与真实 rejection 测试均通过。
- 未修改详情业务逻辑、WXML/WXSS、云函数或生产配置。

## 风险与部署

- 未在微信开发者工具或真机执行运行时预览；当前证据为 Node 测试、语法与静态检查。
- 本次仅本地前端代码修改；无需上传云函数，尚未发布小程序。
