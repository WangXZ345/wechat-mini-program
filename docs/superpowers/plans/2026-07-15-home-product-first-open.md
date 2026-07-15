# 首页商品首次打开提速 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户首次从首页点击商品时立即启动详情页转场，并用脱敏内存快照完成详情首帧，随后再执行服务端商品和配送数据校准。

**Architecture:** 在现有 `performanceCache` 中增加按用户和商品隔离、短 TTL、读取即消费的进程内商品预览，并给底层缓存增加 best-effort 异步写入。首页先暂存内存快照并立即导航，导航成功后异步持久化；详情页先消费内存快照、再回退持久缓存，并把鉴权、商品精确查询和配送请求调度到首帧提交之后。

**Tech Stack:** 微信小程序原生 JavaScript、CommonJS、`wx.navigateTo`、`wx.nextTick`、`wx.setStorage`、Node.js `node:test` / `node:assert`。

## Global Constraints

- 兼容现有商品、价格、收藏、配送、地址、加购和预下单业务语义。
- 服务端 `getProducts({ onlyActive: true, productId })` 仍是商品上下架和最新公开数据的最终来源。
- 普通用户快照不得包含真实库存、成本、供应商、`internalTags`、管理员备注或客户信息。
- 快照不得绕过下单、加购、地址归属、账号状态或库存的服务端校验。
- 不修改任何云函数、数据库集合、业务字段、权限、导出或生产配置。
- 不新增外部依赖，不迁移商品详情路由，不改商品详情 UI 结构。
- 未经用户明确确认，不上传云函数、不发布小程序、不执行生产写操作。
- Windows 验证使用 bundled Node：`C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`。

## File Structure

- Modify: `miniprogram/utils/cache.js` — 为现有统一缓存 envelope 增加异步 best-effort 写入，保持同步 API 不变。
- Modify: `miniprogram/utils/performanceCache.js` — 提供内存商品预览暂存/消费和异步持久预览 API；继续负责公开字段白名单。
- Create: `miniprogram/utils/performanceCache.test.js` — 验证内存快照 TTL、消费、用户/商品隔离、异步持久化和敏感字段剥离。
- Modify: `miniprogram/pages/index/index.js` — 首页点击时先暂存内存快照、立即导航，成功后异步持久化。
- Create: `miniprogram/pages/index/index.test.js` — 验证首页列表与推荐入口的导航顺序和失败回退。
- Modify: `miniprogram/pages/product/detail.js` — 优先消费内存快照，并把网络初始化推迟到首帧后。
- Create: `miniprogram/pages/product/detail.test.js` — 验证快照首显、持久缓存回退、首帧调度和服务端校准。

---

### Task 1: 建立非阻塞商品预览通道

**Files:**
- Modify: `miniprogram/utils/cache.js:17-69`
- Modify: `miniprogram/utils/performanceCache.js:1-8, 323-376, 378-409`
- Create: `miniprogram/utils/performanceCache.test.js`

**Interfaces:**
- Produces: `cache.setAsync(key, data, options): Promise<boolean>`。
- Produces: `stageProductPreview(product, options): PublicProductPreview | null`。
- Produces: `consumeProductPreview(productId, options): CacheEnvelope | null`，返回结构与 `readProductPreview` 一致。
- Produces: `writeProductPreviewAsync(product, options): Promise<PublicProductPreview | null>`。
- Preserves: `writeProductPreview`、`readProductPreview`、`clearProductPreview` 的现有调用方式。

- [ ] **Step 1: 写出失败的缓存测试**

创建 `miniprogram/utils/performanceCache.test.js`，使用受控时钟、内存 storage 和异步 storage 调用记录：

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const storage = new Map();
const asyncWrites = [];
let now = 1_000;

const originalGetApp = global.getApp;
const originalWx = global.wx;
global.getApp = () => ({ globalData: { user: { userId: "user-1" } } });
global.wx = {
  getStorageSync(key) { return storage.get(key); },
  setStorageSync(key, value) { storage.set(key, value); },
  removeStorageSync(key) { storage.delete(key); },
  setStorage({ key, data, success }) {
    asyncWrites.push({ key, data });
    storage.set(key, data);
    success();
  }
};

const realNow = Date.now;
Date.now = () => now;
const cache = require("./performanceCache");

test.after(() => {
  Date.now = realNow;
  global.getApp = originalGetApp;
  global.wx = originalWx;
});

function product(overrides = {}) {
  return {
    _id: "p1",
    name: "公开商品",
    price: 1234,
    imageUrl: "thumb.jpg",
    tags: ["热销", "internal"],
    stock: 88,
    costPrice: 456,
    supplier: "secret",
    internalTags: ["secret"],
    adminRemark: "secret",
    ...overrides
  };
}

test("staged preview is public, isolated and consumed once", () => {
  const staged = cache.stageProductPreview(product());
  assert.equal(staged.productId, "p1");
  ["stock", "costPrice", "supplier", "internalTags", "adminRemark"]
    .forEach((key) => assert.equal(key in staged, false));
  assert.deepEqual(staged.tags, ["热销"]);

  assert.equal(cache.consumeProductPreview("p2"), null);
  const hit = cache.consumeProductPreview("p1");
  assert.equal(hit.data.name, "公开商品");
  assert.equal(cache.consumeProductPreview("p1"), null);
});

test("expired staged preview is rejected", () => {
  cache.stageProductPreview(product(), { ttlMs: 50 });
  now += 51;
  assert.equal(cache.consumeProductPreview("p1"), null);
});

test("async persistence uses wx.setStorage and keeps the cache envelope", async () => {
  asyncWrites.length = 0;
  const preview = await cache.writeProductPreviewAsync(product());
  assert.equal(preview.productId, "p1");
  assert.equal(asyncWrites.length, 1);
  assert.match(asyncWrites[0].key, /^product_preview_v1_user-1_/);
  assert.equal(asyncWrites[0].data.data.productId, "p1");
});

test("clearProductPreview clears memory and persistent layers", () => {
  cache.stageProductPreview(product());
  cache.writeProductPreview(product());
  cache.clearProductPreview("p1");
  assert.equal(cache.consumeProductPreview("p1"), null);
  assert.equal(cache.readProductPreview("p1"), null);
});
```

- [ ] **Step 2: 运行测试并确认它因接口缺失而失败**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test miniprogram/utils/performanceCache.test.js
```

Expected: FAIL，错误包含 `cache.stageProductPreview is not a function` 或 `cache.writeProductPreviewAsync is not a function`。

- [ ] **Step 3: 在统一缓存层增加异步写入**

在 `miniprogram/utils/cache.js` 中把 envelope 构造抽成纯函数，并增加 `rawSetAsync` / `setAsync`：

```js
function rawSetAsync(key, value) {
  if (typeof wx.setStorage !== "function") return Promise.resolve(rawSet(key, value));
  return new Promise((resolve) => {
    try {
      wx.setStorage({
        key,
        data: value,
        success: () => resolve(true),
        fail: () => resolve(false)
      });
    } catch (err) {
      resolve(false);
    }
  });
}

function cacheEnvelope(data, options = {}) {
  if (data === undefined) return null;
  let cacheData = data;
  if (typeof options.sanitize === "function") {
    try {
      cacheData = options.sanitize(data);
    } catch (err) {
      return null;
    }
  }
  if (cacheData === undefined) return null;
  const updatedAt = Date.now();
  const ttlMs = positiveNumber(options.ttlMs);
  return {
    __cacheVersion: positiveNumber(options.version) || CACHE_VERSION,
    data: cacheData,
    updatedAt,
    expiresAt: ttlMs ? updatedAt + ttlMs : 0
  };
}

function set(key, data, options = {}) {
  if (!key) return false;
  const envelope = cacheEnvelope(data, options);
  return envelope ? rawSet(key, envelope) : false;
}

function setAsync(key, data, options = {}) {
  if (!key) return Promise.resolve(false);
  const envelope = cacheEnvelope(data, options);
  return envelope ? rawSetAsync(key, envelope) : Promise.resolve(false);
}
```

并在 `module.exports` 中加入 `setAsync`，不得改变 `get`、`remove`、`purgeSensitivePageCaches` 的行为。

- [ ] **Step 4: 在性能缓存层实现内存快照和异步持久化**

在 `miniprogram/utils/performanceCache.js` 顶部增加：

```js
const stagedProductPreviews = new Map();
```

在现有 `publicProductPreview` 后增加：

```js
function stageProductPreview(product = {}, options = {}) {
  const preview = publicProductPreview(product);
  const key = productPreviewCacheKey(preview.productId, options.openid);
  if (!key || !preview.productId) return null;
  const updatedAt = now();
  const ttlMs = Number(options.ttlMs || PRODUCT_PREVIEW_TTL_MS);
  stagedProductPreviews.set(key, {
    data: preview,
    updatedAt,
    expiresAt: updatedAt + Math.max(1, ttlMs)
  });
  return preview;
}

function consumeProductPreview(productId, options = {}) {
  const id = String(productId || "").trim();
  const key = productPreviewCacheKey(id, options.openid);
  if (!key) return null;
  const cached = stagedProductPreviews.get(key);
  stagedProductPreviews.delete(key);
  if (!cached || cached.expiresAt < now()) return null;
  if (!cached.data || String(cached.data.productId || cached.data._id || "") !== id) return null;
  return { ...cached, expired: false, version: 1 };
}

function writeProductPreviewAsync(product = {}, options = {}) {
  const preview = publicProductPreview(product);
  const key = productPreviewCacheKey(preview.productId, options.openid);
  if (!key || !preview.productId) return Promise.resolve(null);
  return cache.setAsync(key, preview, { ttlMs: PRODUCT_PREVIEW_TTL_MS })
    .then((written) => written ? preview : null)
    .catch(() => null);
}
```

把 `clearProductPreview` 改为同时清理内存和持久缓存：

```js
function clearProductPreview(productId, options = {}) {
  const key = productPreviewCacheKey(productId, options.openid);
  if (!key) return;
  stagedProductPreviews.delete(key);
  cache.remove(key);
}
```

在 `module.exports` 中加入 `stageProductPreview`、`consumeProductPreview`、`writeProductPreviewAsync`。

- [ ] **Step 5: 运行缓存测试和语法检查**

Run:

```powershell
$node='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test miniprogram/utils/performanceCache.test.js
& $node --check miniprogram/utils/cache.js
& $node --check miniprogram/utils/performanceCache.js
```

Expected: 所有测试 PASS，两个 `--check` 均退出码 `0`。

- [ ] **Step 6: 提交 Task 1**

```powershell
git add -- miniprogram/utils/cache.js miniprogram/utils/performanceCache.js miniprogram/utils/performanceCache.test.js
git commit -m "perf: add transient product previews"
```

---

### Task 2: 让首页商品点击立即开始导航

**Files:**
- Modify: `miniprogram/pages/index/index.js:1-21, 636-655`
- Create: `miniprogram/pages/index/index.test.js`

**Interfaces:**
- Consumes: `stageProductPreview(product): PublicProductPreview | null`。
- Consumes: `writeProductPreviewAsync(product): Promise<PublicProductPreview | null>`。
- Preserves: `findProductForCart(productId)` 对首页列表和当前可见推荐区的查找语义。

- [ ] **Step 1: 写出首页导航顺序失败测试**

创建 `miniprogram/pages/index/index.test.js`。按现有 `order/list.test.js` 的 `Module._load` 模式加载 Page 定义，只保留本任务需要的依赖桩。测试核心代码如下：

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const events = [];
let definition;
let persistResolve;
const originalWx = global.wx;
const wxMock = {
  navigateTo(options) {
    events.push("navigate");
    options.success({});
  }
};

function loadPageDefinition() {
  const originalLoad = Module._load;
  const originalPage = global.Page;
  global.Page = (value) => { definition = value; };
  global.wx = wxMock;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.endsWith("utils/performanceCache")) return {
      stageProductPreview(product) { events.push(`stage:${product._id}`); return { productId: product._id }; },
      writeProductPreviewAsync() {
        events.push("persist-start");
        return new Promise((resolve) => { persistResolve = resolve; });
      },
      readCache() { return null; }, readCartCache() { return null; }, scopedCacheKey() { return "k"; },
      clearDirty() {}, isDirty() { return false; }, writeCache() {}, writeCartCache() {},
      cartItemFromAddResult() {}, cartCountFromPayload() { return 0; }, upsertCartCacheItem() {}
    };
    if (request.endsWith("utils/api")) return { call: () => Promise.resolve({}), moneyText: String, toast() {}, feedback: { showInfo() {} } };
    if (request.endsWith("utils/auth")) return { ensureFrontendAccess: () => Promise.resolve(), ensureLogin: () => Promise.resolve(), redirectDefaultEntry: () => Promise.resolve({}) };
    if (request.endsWith("utils/searchNormalize")) return { normalizeSearchText: String };
    if (request.endsWith("utils/tabbar")) return { setTabBarCartBadge() {}, setTabBarSelected() {} };
    if (request.endsWith("utils/orientation")) return { initOrientation() {}, cleanupOrientation() {} };
    if (request.endsWith("utils/sync")) return { subscribe: () => () => {} };
    if (request.endsWith("utils/haptics")) return { selection() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./index.js")];
    require("./index.js");
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
  }
}

loadPageDefinition();
test.after(() => { global.wx = originalWx; });

function pageWith(products, visibleRecommendSections = []) {
  return { ...definition, data: { ...definition.data, products, visibleRecommendSections } };
}

test("home list stages preview, starts navigation, then persists asynchronously", async () => {
  events.length = 0;
  const page = pageWith([{ _id: "p1", name: "商品" }]);
  page.goDetail({ currentTarget: { dataset: { id: "p1" } } });
  assert.deepEqual(events, ["stage:p1", "navigate", "persist-start"]);
  persistResolve(null);
  await Promise.resolve();
});

test("visible recommendation uses the same non-blocking path", () => {
  events.length = 0;
  const page = pageWith([], [{ products: [{ _id: "p2", name: "推荐商品" }] }]);
  page.goDetail({ currentTarget: { dataset: { id: "p2" } } });
  assert.deepEqual(events.slice(0, 3), ["stage:p2", "navigate", "persist-start"]);
  persistResolve(null);
});

test("missing product still navigates without attempting persistence", () => {
  events.length = 0;
  const page = pageWith([]);
  page.goDetail({ currentTarget: { dataset: { id: "missing" } } });
  assert.deepEqual(events, ["navigate"]);
});
```

- [ ] **Step 2: 运行测试并确认旧同步实现不符合接口或顺序**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test miniprogram/pages/index/index.test.js
```

Expected: FAIL，原因是页面仍导入/调用 `writeProductPreview`，或事件中没有 `stage` / `persist-start`。

- [ ] **Step 3: 修改首页导入和 `goDetail`**

在 `performanceCache` 解构导入中，用以下接口替换 `writeProductPreview`：

```js
stageProductPreview,
writeProductPreviewAsync,
```

用以下实现替换 `goDetail`：

```js
goDetail(e) {
  haptics.selection();
  const productId = String(e.currentTarget.dataset.id || "");
  const product = this.findProductForCart(productId);
  const preview = product && (product._id || product.productId)
    ? stageProductPreview(product)
    : null;
  wx.navigateTo({
    url: `/pages/product/detail?id=${productId}`,
    success: () => {
      if (preview) writeProductPreviewAsync(preview).catch(() => null);
    }
  });
},
```

不得在 `wx.navigateTo` 之前调用 `writeProductPreview`、`writeProductPreviewAsync`、`wx.setStorageSync` 或其他持久化接口。

- [ ] **Step 4: 运行首页测试和语法检查**

Run:

```powershell
$node='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test miniprogram/pages/index/index.test.js
& $node --check miniprogram/pages/index/index.js
```

Expected: 所有测试 PASS，语法检查退出码 `0`。

- [ ] **Step 5: 提交 Task 2**

```powershell
git add -- miniprogram/pages/index/index.js miniprogram/pages/index/index.test.js
git commit -m "perf: navigate before persisting product preview"
```

---

### Task 3: 详情页用快照完成首帧并延后网络初始化

**Files:**
- Modify: `miniprogram/pages/product/detail.js:5-12, 110-135, 150-184`
- Create: `miniprogram/pages/product/detail.test.js`

**Interfaces:**
- Consumes: `consumeProductPreview(productId): CacheEnvelope | null`。
- Consumes: `readProductPreview(productId): CacheEnvelope | null`。
- Produces page method: `afterFirstPaint(callback): void`。
- Preserves: `loadProduct` 的精确查询参数、商品不存在处理、收藏状态刷新和配送默认值。

- [ ] **Step 1: 写出详情首帧失败测试**

创建 `miniprogram/pages/product/detail.test.js`，使用 `Module._load` 隔离页面依赖，并让 `wx.nextTick` 只记录回调而不立即执行：

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const state = { calls: [], nextTicks: [], staged: null, persisted: null };
let definition;
const originalWx = global.wx;
const wxMock = {
  nextTick(callback) { state.nextTicks.push(callback); },
  getStorageSync() { return null; }
};

function loadDefinition() {
  const originalLoad = Module._load;
  const originalPage = global.Page;
  global.Page = (value) => { definition = value; };
  global.wx = wxMock;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.endsWith("utils/api")) return {
      call(name, payload) { state.calls.push({ name, payload }); return Promise.resolve(name === "getProducts" ? { products: [] } : {}); },
      moneyText(value) { return (Number(value) / 100).toFixed(2); }, toast() {},
      feedback: { showWarning() {}, showError() {} }
    };
    if (request.endsWith("utils/auth")) return { ensureFrontendAccess: () => Promise.resolve(), ensureLogin: () => Promise.resolve() };
    if (request.endsWith("utils/delivery")) return { DELIVERY_TYPE_OPTIONS: [], EMPTY_SHIPPING_ADDRESS: {}, normalizeShippingAddress: (value) => value || {} };
    if (request.endsWith("utils/idempotency")) return { createSubmitKey() {}, clearSubmitKey() {}, generateIdempotencyKey() {} };
    if (request.endsWith("utils/performanceCache")) return {
      consumeProductPreview() { return state.staged; },
      readProductPreview() { return state.persisted; },
      clearProductPreview() {}, writeProductPreview() {}, markDirty() {},
      cartItemFromAddResult() {}, upsertCartCacheItem() {}
    };
    if (request.endsWith("utils/orientation")) return { initOrientation() {}, cleanupOrientation() {} };
    if (request.endsWith("utils/sync")) return { subscribe: () => () => {} };
    if (request.endsWith("utils/haptics")) return { selection() {} };
    if (request.endsWith("utils/phone")) return { ensurePhoneBeforeOrder: () => Promise.resolve(true), handlePhoneRequiredError() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./detail.js")];
    require("./detail.js");
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
  }
}

loadDefinition();
test.after(() => { global.wx = originalWx; });

function createPage() {
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  page.setData = function setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  page.updateTotal = function updateTotal() { this.data.totalUpdated = true; };
  return page;
}

test("staged preview wins over persistent cache and renders before network", () => {
  state.calls.length = 0;
  state.nextTicks.length = 0;
  state.staged = { data: { _id: "p1", productId: "p1", name: "内存商品", price: 100 } };
  state.persisted = { data: { _id: "p1", productId: "p1", name: "旧商品", price: 100 } };
  const page = createPage();
  page.onLoad({ id: "p1" });
  assert.equal(page.data.product.name, "内存商品");
  assert.equal(page.data.loading, false);
  assert.equal(page.data.initialized, true);
  assert.equal(state.calls.length, 0);
  assert.equal(state.nextTicks.length >= 1, true);
});

test("persistent preview remains the fallback", () => {
  state.staged = null;
  state.persisted = { data: { _id: "p1", productId: "p1", name: "持久商品", price: 100 } };
  const page = createPage();
  assert.equal(page.applyProductPreview("p1"), true);
  assert.equal(page.data.product.name, "持久商品");
});

test("network initialization begins only after nextTick", async () => {
  state.calls.length = 0;
  state.nextTicks.length = 0;
  state.staged = { data: { _id: "p1", productId: "p1", name: "内存商品", price: 100 } };
  state.persisted = null;
  const page = createPage();
  page.onLoad({ id: "p1" });
  assert.equal(state.calls.length, 0);
  const callbacks = state.nextTicks.splice(0);
  callbacks.forEach((callback) => callback());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls.some((item) => item.name === "getProducts" && item.payload.productId === "p1"), true);
  ["getUserDeliveryPreference", "getSettings", "getDefaultAddress"]
    .forEach((name) => assert.equal(state.calls.some((item) => item.name === name), true));
});
```

- [ ] **Step 2: 运行测试并确认内存接口和首帧调度尚未实现**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test miniprogram/pages/product/detail.test.js
```

Expected: FAIL，原因包含 `consumeProductPreview` 未被使用，或 `getProducts` 在 `nextTick` 执行前已经开始。

- [ ] **Step 3: 修改详情页快照读取顺序**

在 `performanceCache` 解构导入中加入 `consumeProductPreview`。用以下实现替换 `applyProductPreview`：

```js
applyProductPreview(productId = this.data.id) {
  const cached = consumeProductPreview(productId) || readProductPreview(productId);
  if (!cached || !cached.data) return false;
  const product = this.shapeProduct(cached.data);
  this.setData({ product, loading: false, initialized: true }, () => this.updateTotal());
  return true;
},
```

- [ ] **Step 4: 增加首帧调度并重排 `onLoad` / `onShow`**

在 Page 定义中加入：

```js
afterFirstPaint(callback) {
  if (typeof wx.nextTick === "function") {
    wx.nextTick(callback);
    return;
  }
  setTimeout(callback, 0);
},

initializeAfterFirstPaint(hasPreview) {
  return ensureLogin({ showLoading: false })
    .then(() => ensureFrontendAccess())
    .then(() => Promise.all([
      this.loadProduct({ silent: hasPreview }),
      this.loadDeliveryOptions()
    ]))
    .catch((err) => toast(err.message));
},
```

把 `onLoad` 中快照读取后的同步 Promise 链替换为：

```js
const hasPreview = this.applyProductPreview(id);
this.afterFirstPaint(() => this.initializeAfterFirstPaint(hasPreview));
```

把 `onShow` 改为同样在首帧后应用地址，避免首次 `onShow` 在渲染前启动鉴权：

```js
onShow() {
  this.afterFirstPaint(() => {
    ensureFrontendAccess()
      .then(() => this.applySelectedAddressFromStorage())
      .catch(() => null);
  });
},
```

不得改动 `loadProduct` 的 `{ onlyActive: true, productId: this.data.id }`、商品不存在处理、`loadFavoriteStatus` 或 `loadDeliveryOptions` 的三个云函数参数。

- [ ] **Step 5: 运行详情测试、全部新增测试和语法检查**

Run:

```powershell
$node='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test miniprogram/pages/product/detail.test.js
& $node --test miniprogram/utils/performanceCache.test.js miniprogram/pages/index/index.test.js miniprogram/pages/product/detail.test.js
& $node --check miniprogram/pages/product/detail.js
```

Expected: 所有测试 PASS，语法检查退出码 `0`。

- [ ] **Step 6: 做敏感字段和调用结构静态检查**

Run:

```powershell
rg -n "stock|realStock|availableStock|costPrice|supplier|internalTags|adminRemark|adminNote" miniprogram/pages/product/detail.wxml miniprogram/utils/performanceCache.js
rg -n "getProducts|getUserDeliveryPreference|getSettings|getDefaultAddress|getFavoriteStatus" miniprogram/pages/product/detail.js
```

Expected:

- 第一条只命中 `performanceCache.js` 的敏感字段剥离白名单，不在 `detail.wxml` 命中展示。
- 第二条保留五个现有调用，`getProducts` 仍携带 `productId`，配送调用名称不变。

- [ ] **Step 7: 做 UTF-8 和工作区范围检查**

Run:

```powershell
$files=@(
  'miniprogram/utils/cache.js',
  'miniprogram/utils/performanceCache.js',
  'miniprogram/utils/performanceCache.test.js',
  'miniprogram/pages/index/index.js',
  'miniprogram/pages/index/index.test.js',
  'miniprogram/pages/product/detail.js',
  'miniprogram/pages/product/detail.test.js'
)
$files | ForEach-Object {
  $raw=Get-Content -LiteralPath $_ -Raw -Encoding UTF8
  if ($raw.Contains([char]0xFFFD)) { throw "UTF-8 replacement character found: $_" }
}
git diff --check
git status --short
```

Expected: 无替换字符、`git diff --check` 无输出；状态只包含本计划列出的文件。

- [ ] **Step 8: 提交 Task 3**

```powershell
git add -- miniprogram/pages/product/detail.js miniprogram/pages/product/detail.test.js
git commit -m "perf: render product detail before network calibration"
```

- [ ] **Step 9: 微信开发者工具手动验收并记录边界**

在本地重新编译但不上传、不发布，依次验证：

1. 重新编译后首次从首页点击任意商品，详情转场立即开始，不再停留首页等待同步缓存。
2. 返回首页后打开另一个商品，标题和价格不得串用上一个商品。
3. 再次打开同一商品，快照先显后服务端精确结果正常校准。
4. 详情页收藏、配送方式、默认地址、加入购物车和立即预下单入口保持可用；不要提交真实订单。
5. Console 无新增 error；Network 中 `getProducts` 每次详情打开最多一条，参数含正确 `productId`。

若无法完成开发者工具或真机验证，交付时明确列出已完成静态检查和待用户验收步骤，不宣称具体毫秒或提速比例。

---

## Final Verification

执行以下命令作为最终交付门禁：

```powershell
$node='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test miniprogram/utils/performanceCache.test.js miniprogram/pages/index/index.test.js miniprogram/pages/product/detail.test.js
& $node --check miniprogram/utils/cache.js
& $node --check miniprogram/utils/performanceCache.js
& $node --check miniprogram/pages/index/index.js
& $node --check miniprogram/pages/product/detail.js
git diff --check HEAD~3..HEAD
```

Expected: 所有测试 PASS；四个语法检查退出码 `0`；diff check 无输出。

最终汇报必须包含：

- `改了什么`：内存公开快照、导航后异步持久化、详情首帧后校准。
- `影响范围`：仅商品首页、商品详情和前端公共缓存工具；无云函数、集合、字段或权限变化。
- `验证`：逐条列出实际执行的测试、语法检查和开发者工具/真机结果；未执行的不得写成通过。
- `部署`：没有需要上传的云函数；前端需要重新编译/预览；明确尚未发布小程序。
