# 首页商品首次打开简化收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement and review this remediation as one focused task.

**Goal:** 保留“脱敏内存快照立即导航、详情首帧后精确校准”，删除没有首帧必要性的首页异步持久化和 generation/reconcile 状态机。

**Architecture:** 首页只把公开商品快照暂存在当前进程内并立即 `wx.navigateTo`。详情页优先消费内存快照、回退到仍在有效期内的持久预览，并在首帧后调用 `getProducts({ onlyActive: true, productId })`；只有服务端精确结果使用现有同步 `writeProductPreview` 更新持久缓存。

**Tech Stack:** 微信小程序原生 JavaScript、CommonJS、Node.js `node:test` / `node:assert`。

## Global Constraints

- 不修改云函数、集合、字段、权限、路由、WXML/WXSS 或生产配置。
- 普通用户快照不得包含库存、成本、供应商、`internalTags`、管理员备注或客户信息。
- `getProducts({ onlyActive: true, productId })` 仍是最终商品来源；下架或不存在仍清除内存和持久预览。
- 保留已经通过审查的首帧后同步订阅、卸载 guard、配送三请求、收藏刷新和错误回退。
- 不新增外部依赖，不上传云函数，不发布小程序，不执行生产写操作。

## Task 1: 删除异步持久化状态机并保留最小快照路径

**Files:**

- Modify: `miniprogram/utils/cache.js`
- Modify: `miniprogram/utils/performanceCache.js`
- Modify: `miniprogram/utils/performanceCache.test.js`
- Modify: `miniprogram/pages/index/index.js`
- Modify: `miniprogram/pages/index/index.test.js`
- Verify only: `miniprogram/pages/product/detail.js`
- Verify only: `miniprogram/pages/product/detail.test.js`

**Required final interfaces:**

- Keep: `stageProductPreview(product, options): PublicProductPreview | null`。
- Keep: `consumeProductPreview(productId, options): CacheEnvelope | null`。
- Keep: `writeProductPreview(product, options): PublicProductPreview | null`，只用于精确结果或其他现有同步调用。
- Keep: `readProductPreview(productId, options): CacheEnvelope | null`，必须拒绝并删除过期持久预览。
- Keep: `clearProductPreview(productId, options): void`，同时清内存和持久层。
- Remove: `writeProductPreviewAsync`、`cache.setAsync` 及其 generation、authoritative preview、tombstone、reconcile 状态。

- [ ] **Step 1: 调整失败测试以描述简化架构**

在首页测试中断言 `goDetail` 的事件只有 `stage`、`navigate`，不存在 `persist-start`；列表、当前可见推荐和缺失商品三条路径保持。

在缓存测试中删除异步写完成顺序和 generation/reconcile 测试，保留并通过以下真实契约：

- 公开字段白名单与敏感字段剥离。
- 商品 ID 隔离、显式跨用户隔离、读取即消费。
- 合法 TTL 过期；非法/无限 TTL 回退默认值。
- 同步精确 `writeProductPreview` 可读取。
- 持久预览过期后 `readProductPreview` 返回 `null` 并删除 storage key。
- `clearProductPreview` 同时清除内存和持久层。

先运行测试，确认当前首页仍触发异步持久化，测试 RED。

- [ ] **Step 2: 删除首页异步持久化**

`miniprogram/pages/index/index.js` 的 `goDetail` 最终形态：

```js
goDetail(e) {
  haptics.selection();
  const productId = String(e.currentTarget.dataset.id || "");
  const product = this.findProductForCart(productId);
  if (product && (product._id || product.productId)) stageProductPreview(product);
  wx.navigateTo({ url: `/pages/product/detail?id=${productId}` });
},
```

移除 `writeProductPreviewAsync` 导入。不得在 `goDetail` 或 `navigateTo.success` 写持久缓存。

- [ ] **Step 3: 简化缓存实现**

从 `miniprogram/utils/performanceCache.js` 删除 `writeProductPreviewAsync`、generation、authoritative preview、tombstone 和 reconcile 相关 Map/函数。保留短 TTL 内存 Map、公开字段白名单、同步精确写入和双层清除。

`readProductPreview` 必须继续使用：

```js
return cache.get(key, {
  ttlMs: PRODUCT_PREVIEW_TTL_MS,
  allowExpired: false,
  validate: (data) => Boolean(data && typeof data === "object" && String(data.productId || data._id || "") === id)
});
```

从 `miniprogram/utils/cache.js` 删除仅由本功能新增且已无调用方的 `rawSetAsync` / `setAsync`；保留同步 `set/get/remove` envelope 行为。

- [ ] **Step 4: 运行聚焦与全量验证**

```powershell
$node='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test miniprogram/utils/performanceCache.test.js miniprogram/pages/index/index.test.js miniprogram/pages/product/detail.test.js
$tests=rg --files miniprogram | Where-Object { $_ -match '\.test\.js$' } | Sort-Object
& $node --test $tests
& $node --check miniprogram/utils/cache.js
& $node --check miniprogram/utils/performanceCache.js
& $node --check miniprogram/pages/index/index.js
& $node --check miniprogram/pages/product/detail.js
```

Expected: 聚焦和全量测试全部 PASS；四个语法检查退出码 `0`。

- [ ] **Step 5: 静态边界验证**

```powershell
rg -n "writeProductPreviewAsync|setAsync|productPreviewGenerations|authoritative|reconcile" miniprogram
rg -n "stock|realStock|availableStock|costPrice|supplier|internalTags|adminRemark|adminNote" miniprogram/pages/product/detail.wxml miniprogram/utils/performanceCache.js
git diff --check
git status --short
```

Expected:

- 第一条无命中。
- 第二条只命中 `performanceCache.js` 的敏感字段剥离列表，不在 WXML 命中。
- diff check 无输出，工作树只包含本计划列出的实现/测试文件和本次文档修订。

- [ ] **Step 6: 提交并独立复审**

提交信息：`refactor: simplify product preview handoff`。

复审必须确认：点击路径没有同步或异步 storage；详情精确结果仍写持久预览；过期持久预览仍被拒绝；卸载 guard 和全部业务调用未回退。
