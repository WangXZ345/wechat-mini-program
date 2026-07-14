# 微信小程序第二阶段性能分析报告

> 日期：2026-07-11  
> 阶段：三轮热循环完成（第一轮分析、第二轮优化、第三轮回归）  
> 范围：页面生命周期、请求、缓存、动效、图片、列表和高频云函数  
> 约束：不改变订单、库存、付款、退款、发货、权限或角色业务语义

## 1. 结论摘要

当前项目并不是从零开始优化：上一阶段已经建立 `performanceCache.js`、全局 Motion token、骨架屏、首页与购物车缓存、订单分页，以及部分后台静默刷新。本轮最有价值的工作不是继续大改视觉，而是修复现有体系中的残余高开销路径和一致性问题。

静态分析确认的最高优先级问题如下：

1. 商品详情为获取一个商品调用 `getProducts`，后端最多读取 2000 个商品，再由前端 `find`。
2. 首页静默刷新没有独立请求锁，`onLoad` / `onShow` 在缓存过期或 dirty 时可能并发请求；搜索还存在旧响应覆盖新条件的竞态。
3. 首页和订单列表在 `onShow` 时重新套用只含第一页的持久缓存，可能把已经加载的后续分页截回第一页，造成滚动跳动。
4. 订单详情首次进入时 `onLoad` 和 `onShow` 可并发请求两次 `getOrders`。
5. 购物车已经缓存先显，但同一生命周期重复应用缓存；有效缓存还会完全跳过后台校准，不完全符合 stale-while-revalidate。
6. 普通订单、后台订单、后台商品、后台 dashboard 和个人页把状态、付款、库存、备注、地址、权限或财务数据写入持久缓存，与本轮缓存边界冲突。
7. 多个页面初始 `loading: false` 且没有 `initialized`，请求真正开始前会短暂显示“暂无数据”或“对象不存在”。
8. Motion 基础已存在，但缺少 `utils/motion.js`，按钮反馈、stagger、弹层和 fixed 页面兼容没有完全统一。
9. 后台订单付款截图、后台商品缩略图和商品分析搜索图未懒加载，长列表存在网络、解码内存和滚动压力。
10. `getOrders`、`getHomeRecommendations`、`getAdminDashboardStats` 和搜索函数仍有大规模扫描或 N+1；其中只有商品详情按 ID 查询适合本轮低风险落地，其余需要更完整的数据规模与索引验证。

## 2. 子智能体分工

| 智能体 | 专项 | 第一轮输出 |
| --- | --- | --- |
| A | 页面性能 | 生命周期、重复请求、`setData`、首屏和后台重列表 |
| B | Motion | 全局动画 token、页面接入、fixed 定位、stagger 和弹层 |
| C | 数据加载 | 首页、商品详情、购物车、订单分页和缓存先显 |
| D | 云函数 | 高频函数查询次数、字段、分页、N+1 和冷启动风险 |
| E | 缓存策略 | TTL、用户隔离、dirty、异常回退、敏感缓存边界 |
| F | 图片资源 | lazy-load、占位、图片裁切、缩略图和分包机会 |
| G | 体验回归 | 普通用户、客服、财务、采购和超级管理员路径矩阵 |

## 3. 验证基线

第一轮没有修改业务代码，也没有连接生产环境或执行真实写操作。

- 小程序 JS：80 个文件通过 bundled Node `--check`。
- 高频云函数入口：9 个文件通过 bundled Node `--check`。
- 小程序 JSON：60 个文件通过 PowerShell `ConvertFrom-Json`。
- Git：当前工作区的 Git 元数据不可用于可靠 diff，后续继续采用逐文件检查和静态扫描。
- 微信开发者工具 / 真机：第一轮未运行，因此没有伪造毫秒、FPS、白屏时长或 P50/P95 数据。

## 4. 页面打开风险

以下“耗时”是源码路径的相对风险，不是实测毫秒。

| 页面 | 热缓存风险 | 冷启动风险 | 主要原因 |
| --- | --- | --- | --- |
| 首页 | 低到中 | 高 | 初始最多同时触发推荐、商品、购物车、最近搜索、热门搜索 5 路请求；静默刷新锁失效 |
| 商品详情 | 中 | 极高 | 全量 `getProducts` 后前端查单品；同时加载配送偏好、设置、地址和收藏 |
| 购物车 | 低 | 中 | 已有缓存先显；冷启动仍需权限检查后请求，商品出现后再取 3 路配送信息 |
| 订单列表 | 中 | 中 | 已有 20 条摘要分页；首屏会假空态，持久缓存包含实时状态 |
| 订单详情 | 中 | 高 | 首次 `onLoad` / `onShow` 双请求，无 Promise 锁 |
| 我的 | 低 | 中 | 用户资料后再取管理员资料；缓存混入权限展示状态 |
| 后台 dashboard | 低 | 中到高 | 热缓存快但缓存包含财务/库存敏感数据；服务端统计扫描重 |
| 后台订单 | 高 | 极高 | 默认最多 100 个完整订单，嵌套商品、地址、备注和多张截图 |
| 后台库存 | 高 | 极高 | 全量商品最多 2000 条并发库存日志，普通 `wx:for` 全量渲染 |
| 后台账款/发货/售后/退款 | 中到高 | 高 | 多数列表缺少完整分页或返回页刷新策略 |

## 5. 页面生命周期与请求问题

### P0

1. 商品详情全量拉取
   - 前端：`miniprogram/pages/product/detail.js:116`
   - 后端：`cloudfunctions/getProducts/index.js:21`
   - 建议：`getProducts` 增加可选 `productId` 精确分支，仍返回 `{ products: [] }`；公开 `onlyActive` 请求不再先查管理员。

2. 首页请求锁与竞态
   - `miniprogram/pages/index/index.js:111`
   - `silent: true` 时视觉 `loading` 为 false，不能承担 in-flight 锁。
   - 请求开始时没有固定参数快照和 cache key，旧搜索响应可能写进新条件缓存。
   - 建议：独立 Promise 锁、参数签名、请求 token、固定 cache key；有新参数时排队一次 trailing reload。

3. 首屏缓存覆盖已分页内存
   - 首页：`miniprogram/pages/index/index.js:135`
   - 订单：`miniprogram/pages/order/list.js:123`
   - 建议：只有当前内存列表为空时才 hydrate 持久缓存；返回详情保留已有多页数据并按 TTL/dirty 静默刷新。

4. 订单详情双请求
   - `miniprogram/pages/order/detail.js:85`
   - 建议：增加初始化门控和 Promise 请求锁；首次 `onShow` 不重复加载。

5. 购物车缓存应用重复
   - `miniprogram/pages/cart/index.js:132`
   - 同一个 `onLoad` / `onShow` 链路两次读取、规范化和 `setData`。
   - 建议：首帧同步读取一次，鉴权后只进行一次合并的后台校准；保留 1 秒最小间隔和请求锁。

6. 假空态闪烁
   - 首页、商品详情、订单列表/详情、后台库存等页面初值为 `loading: false`。
   - 建议：增加 `initialized`，空态只能在首轮请求完成后显示；无缓存时第一帧显示局部 skeleton。

### P1

- 最近搜索和热门搜索延迟到首次聚焦搜索框，不占首页首屏网络并发。
- dashboard 快速切时间范围增加 range token，旧请求不得覆盖新范围。
- 客户空列表不能以 `length === 0` 作为每次 `onShow` 重刷依据，应使用 initialized/TTL。
- 购物车数量连续修改需要请求序列化或防抖；本轮不改变服务端幂等和库存校验。

## 6. 缓存策略审计

### 可持久缓存

- 脱敏公共商品名称、价格、缩略图和标签。
- 首页推荐区，按用户隔离，短 TTL。
- 购物车脱敏快照，用于先显；真实价格、上下架和可购买状态仍由后台校准。
- 脱敏用户基本资料，不包含权限或后台入口状态。

### 禁止持久缓存

- 实时库存、成本、供应商、内部标签。
- 付款状态、退款状态、订单最终状态、物流最终状态。
- 付款截图、完整地址、管理员备注、客户风险和财务汇总。
- 角色、权限数组和权限敏感页面结果。

### 当前冲突

- `miniprogram/pages/order/list.js` 持久化订单状态和付款状态。
- `miniprogram/pages/admin/orders.js` 持久化付款截图、地址、风险和管理员备注。
- `miniprogram/pages/admin/products.js` 持久化库存与内部商品字段。
- `miniprogram/pages/admin/dashboard/index.js` 和旧 dashboard 持久化财务与库存统计。
- `miniprogram/pages/profile/index.js` 把 `adminProfile` 和入口可见性写入页面性能缓存。
- `miniprogram/utils/session.js` 的退出清理遗漏上述页面缓存前缀。

### 本轮设计

新增 `miniprogram/utils/cache.js` 作为唯一底层存储封装，负责：

- schema version、更新时间、TTL 和异常 envelope 删除；
- 安全的读取、写入、删除和按前缀清理；
- 主动失效和旧敏感页面缓存迁移清理。

现有 `performanceCache.js` 保留对外 API，内部复用 `cache.js`，继续承载购物车字段白名单等领域逻辑，避免出现两套并行缓存。

后台订单、商品、dashboard 和普通订单状态停止持久化，只保留当前已授权页面实例的内存数据和静默刷新。

`auth.js` / 登录会话已有的权限缓存属于权限体系。本轮只记录风险，不改变角色、权限点或后端鉴权语义；应另开权限专项决定是否移除会话权限快路径。

## 7. Motion Design System 审计

现有基础：

- `theme.wxss` 已有 120/160/220/280ms、统一 easing 和 24ms/120ms stagger token。
- `motion.wxss` 已有 page、fade、card、press、modal、bottom bar 和 tab pill 动画。
- 51 个页面中绝大多数已经使用全局进入类。

本轮需要修复：

1. 新增 `utils/motion.js`，用纯函数提供 `pageEnter`、`fadeIn`、`slideUp`、`scaleIn`、`staggerList`、`pressEffect`。
2. 页面进入位移统一为 20rpx、220ms、`cubic-bezier(0.22,1,0.36,1)`。
3. 按钮反馈统一为 scale 0.97、120ms。
4. stagger 仅作用于前 6 项，最大延迟 120ms；长列表后续项不动画。
5. `admin/import` 只有 delay 类而没有基础动画；订单与商品分析循环项没有按 index 延迟。
6. 支付方式自定义弹层接入统一 overlay + scale 0.96 动画。
7. `login/password` 与 `profile/bind-phone` 补统一页面进入类。
8. fixed 操作栏页面继续使用纯 fade。历史真机结果表明根节点长期保留 transform 会改变 fixed 定位上下文，不能机械套用 translateY。
9. 页面退出继续使用微信原生导航转场，不为自定义退出动画延迟 `navigateTo` / `switchTab`。

## 8. 图片和资源

基线：

- 23 处 `<image>`，其中 8 处懒加载、15 处立即加载。
- 包内没有本地 PNG/JPG/WebP/SVG，也没有 WXSS 背景图。
- 图片容器尺寸总体稳定，暂未发现明显布局跳动。

本轮低风险改动：

- 后台商品列表缩略图、后台订单付款截图、商品分析搜索结果启用 `lazy-load`。
- 商品详情首屏主图保持立即加载。
- 二维码、付款/退款/售后凭证使用 `aspectFit`，避免裁掉关键信息；商品图继续 `aspectFill`。
- 先补高频列表和凭证页的失败占位，不引入复杂图片组件。

暂缓：

- 代码虽然兼容 `thumbnailUrl`，但项目没有生成缩略图的入口，也无法静态确认云存储图片变换能力；不能盲目拼接转换参数。
- 后台 28 页约 544.8 KB 未压缩源码，可作为后续独立分包专项；本轮不在没有开发者工具运行验证时调整全部路由打包结构。

## 9. 云函数性能

### 本轮建议实施

- `getProducts`：增加 `productId` 精确查询，公开请求跳过管理员查询，保持返回结构。

### 已经合理

- `getCartList`：购物车一次查询 + 商品 `_.in` 批量查询，已有字段投影，没有旧版逐条查商品问题。本轮不缓存云端结果，避免价格和上下架状态变旧。

### 高价值但需更完整验证

- `getOrders`：管理员完整列表存在 order -> items -> products -> user -> account 的 N+1，100 单可能产生数百次数据库往返。
- `getHomeRecommendations`：每次尝试建集合、重复查配置并最多扫描 3000 商品。
- `getAdminDashboardStats`：today/range 重复扫描、批次串行，缓存 TTL 为 0；不能直接开启共享缓存，否则不同权限管理员可能复用敏感结果。
- `searchProducts` / `adminSearchProducts`：分页发生在内存，先扫描 2000/3000 商品。

这些函数的深度优化涉及索引、旧数据兼容、字段投影和权限整形。本轮只在能保持结果顺序、返回结构和权限输出完全不变时实施；否则列入 P2，不为速度牺牲正确性。

## 10. 第二轮优化范围

### P0

1. 商品详情按 ID 查询 + 公共商品快照先显。
2. 首页独立请求锁、token、固定 cache key、初始化门控和非首屏请求懒加载。
3. 订单详情去双请求；普通订单停止持久化实时状态。
4. 购物车同步缓存先显、去重复读取、合并后台校准。
5. 停止后台订单、商品和 dashboard 敏感数据持久化，并清除旧缓存键。
6. 落地 `cache.js` 底层与兼容 `performanceCache.js`。
7. 补统一 Motion helper、按钮/弹层/stagger 和缺失页面接入。
8. 后台重列表图片懒加载和凭证图片完整显示。

### P1

- 首页搜索历史/热词首次聚焦再加载。
- dashboard 切范围请求 token。
- 骨架 shimmer 改为 transform 合成动画。
- 后台部分空态增加 initialized 门控。

### P2 / 暂缓

- 所有后台页分包。
- 搜索游标分页与数据库索引改造。
- dashboard 增量聚合。
- 超过 100 个复杂节点后的虚拟列表。
- `auth.js` / 登录会话权限缓存重构。

## 11. 第三轮验收指标

本地静态检查：

- 所有改动 JS 通过 `node --check`。
- 所有改动 JSON 可解析。
- 后台页面不再调用通用持久缓存写入完整订单、库存、财务或权限数据。
- 商品详情请求带 `productId`，云函数仍返回 `products` 数组。
- 首页、推荐、购物车和订单请求均有独立 in-flight 锁。
- 空态受 `initialized` 门控。
- 云函数和前端返回结构、错误码、订单/库存/付款/退款/发货/权限分支保持不变。

微信开发者工具 / 真机待测：

| 场景 | 记录项 |
| --- | --- |
| 清缓存冷启动首页 | 首个结构绘制、首个商品出现、云函数数量、白屏时长 |
| 热缓存首页 | 缓存命中、后台刷新次数、列表是否跳回首屏 |
| 首页进入购物车 | 首帧结构、缓存商品出现、后台校准次数、空白时间 |
| 商品详情 | 列表快照出现、精确请求耗时、主图加载、价格更新 |
| 订单列表/详情 | 假空态、首次请求次数、返回列表是否保持滚动位置 |
| 后台订单/商品 | 网络图片数、解码内存、滚动 FPS、是否存在旧敏感缓存 |
| dashboard 切范围 | 旧响应是否覆盖新范围、卡片动画与权限可见性 |
| iOS / Android | fixed 底栏位置、modal、长列表滚动和二维码完整性 |

第一轮尚未取得开发者工具和真机数据，因此当时只给出静态基线；最终结论仍不以单次运行数据宣称具体提速比例或 FPS 改善。

## 12. 第二轮优化结果

### 12.1 页面加载与请求

- 首页先恢复商品和推荐公开缓存，再静默刷新；商品请求使用独立 Promise 锁、固定请求 scope 和 trailing reset，旧搜索响应不能写入新筛选结果。
- 搜索历史、热门词和建议改为首次聚焦后加载，避免占用首屏请求预算。
- 商品详情先显示公开商品快照，再调用 `getProducts({ productId })` 精确校准；不缓存真实库存、成本、供应商或后台字段。
- 购物车保留缓存秒开和后台校准，并增加全局服务端 mutation FIFO、`item + field` sequence、confirmed 值局部回滚、数量草稿门控和合并 trailing revalidate。
- 订单详情、售后列表和售后详情增加初始化门控与 Promise 锁，消除首次 `onLoad` / `onShow` 双请求。
- 普通订单列表不再持久化订单状态、付款状态或物流状态，只保留当前页面内存数据和 dirty 标记。
- 后台订单、商品和 dashboard 停止写入完整订单、库存、财务或权限数据到通用持久缓存。
- dashboard 范围切换、商品分析搜索和分析请求增加 latest-request token，旧响应不能覆盖新范围。
- 后台商品分页请求绑定筛选快照；分页中切换筛选会丢弃旧页，并为最新筛选合并一次 trailing reset。
- 库存页鉴权失败会正确结束 skeleton，不改变 `inventory:view` 权限判断或角色规则。

### 12.2 缓存系统

- 新增 `miniprogram/utils/cache.js`：统一版本 envelope、TTL、过期判断、异常回退、校验器和主动删除。
- `performanceCache.js` 保留原 API 并复用新底层，继续承载购物车白名单、公开商品快照、用户 scope 和 dirty 标记。
- 用户 scope 兼容标准登录对象的 `userId` / `id`，不同登录用户不能命中彼此的购物车、首页、个人页或商品预览缓存。
- 敏感旧页面缓存清理在 Storage 枚举失败时不会写完成 marker；后续启动会重试。
- 合并发货资格预览改用 `EventChannel` 内存传递，确认页仍重新调用 `checkMergeShipmentEligibility`，不再持久化付款和订单状态。
- 个人页只缓存昵称、头像、脱敏手机号等公开白名单字段，不缓存 `adminProfile`、权限或后台入口判断。

### 12.3 Motion Design System

- 新增 `miniprogram/utils/motion.js`，统一提供 `pageEnter`、`fadeIn`、`slideUp`、`scaleIn`、`staggerList` 和 `pressEffect`。
- 页面进入统一为 `20rpx / 220ms / cubic-bezier(0.22, 1, 0.36, 1)`；含 fixed 操作区的页面使用纯 fade，动画结束后不保留根 transform。
- 按钮按压统一为 `scale(0.97) / 120ms`；卡片按压为 `scale(0.985) / 120ms`。
- stagger 只作用于前 6 项，最大延迟 120ms，避免长列表批量动画阻塞滚动。
- `app.json` 的 51 个页面全部有统一根进入动画；登录密码页、绑定手机号页和导入页缺失接入已补齐。
- 支付方式弹层接入统一 overlay fade 与 `0.96 -> 1` scale 动画；自定义 tabBar 不再整条重复入场。

### 12.4 图片与资源

- 后台商品列表、订单付款截图和商品分析搜索结果启用图片懒加载。
- 付款二维码、退款和售后凭证使用 `aspectFit`，避免裁掉关键信息；商品图继续使用稳定尺寸的 `aspectFill`。
- 商品详情主图保持首屏立即加载，其他长列表图片延后解码。
- 当前没有可靠的云存储缩略图生成入口，因此没有盲目拼接图片转换参数。

### 12.5 云函数

- 仅修改 `getProducts`：新增可选 `productId` 精确读取分支，保留 `onlyActive` 默认值、管理员校验、上下架/删除过滤、脱敏和 `{ ok, data: { products } }` 返回结构。
- 公开商品精确查询不再先查管理员；后台 `onlyActive: false` 仍按原规则鉴权和返回后台字段。
- `getOrders`、`getHomeRecommendations`、`getAdminDashboardStats`、`searchProducts` 和 `adminSearchProducts` 的大扫描/N+1 仅记录为 P2，本轮没有在缺少索引和真实规模基线时改变查询语义。

## 13. 修改文件

### 文档

- `docs/performance-report.md`
- `docs/figma.md`

### 公共层和全局样式

- `miniprogram/app.js`
- `miniprogram/utils/cache.js`
- `miniprogram/utils/motion.js`
- `miniprogram/utils/performanceCache.js`
- `miniprogram/utils/session.js`
- `miniprogram/styles/components.wxss`
- `miniprogram/styles/motion.wxss`
- `miniprogram/custom-tab-bar/index.wxml`
- `miniprogram/custom-tab-bar/index.wxss`

### 前台页面

- `miniprogram/pages/index/index.js`
- `miniprogram/pages/index/index.wxml`
- `miniprogram/pages/index/index.wxss`
- `miniprogram/pages/cart/index.js`
- `miniprogram/pages/product/detail.js`
- `miniprogram/pages/product/detail.wxml`
- `miniprogram/pages/recommend/list.js`
- `miniprogram/pages/favorite/index.js`
- `miniprogram/pages/frequent/index.js`
- `miniprogram/pages/order/list.js`
- `miniprogram/pages/order/list.wxml`
- `miniprogram/pages/order/detail.js`
- `miniprogram/pages/order/detail.wxml`
- `miniprogram/pages/after-sale/list.js`
- `miniprogram/pages/after-sale/list.wxml`
- `miniprogram/pages/after-sale/detail.js`
- `miniprogram/pages/after-sale/detail.wxml`
- `miniprogram/pages/profile/index.js`
- `miniprogram/pages/profile/bind-phone.wxml`
- `miniprogram/pages/login/password.wxml`
- `miniprogram/pages/payment/payment.js`

### 后台页面

- `miniprogram/pages/admin/dashboard.js`
- `miniprogram/pages/admin/dashboard/index.js`
- `miniprogram/pages/admin/products.js`
- `miniprogram/pages/admin/products.wxml`
- `miniprogram/pages/admin/orders.js`
- `miniprogram/pages/admin/orders.wxml`
- `miniprogram/pages/admin/inventory.js`
- `miniprogram/pages/admin/inventory.json`
- `miniprogram/pages/admin/inventory.wxml`
- `miniprogram/pages/admin/product-analytics/index.js`
- `miniprogram/pages/admin/product-analytics/index.wxml`
- `miniprogram/pages/admin/import/index.wxml`
- `miniprogram/pages/admin/payment-methods/index.wxml`
- `miniprogram/pages/admin/after-sales/detail/index.wxml`
- `miniprogram/pages/admin/refunds/detail/index.wxml`
- `miniprogram/pages/admin/shipments/merge-confirm.js`

### 云函数

- `cloudfunctions/getProducts/index.js`

## 14. 第三轮回归结果

### 14.1 全量静态门禁

- 83 个 JS 通过 bundled Node `--check`，其中包含 82 个小程序 JS 和 `getProducts/index.js`。
- 60 个小程序 JSON 全部可解析。
- 58 个 WXML 通过 `view` / `block` 结构配平检查。
- 64 个 WXSS 通过大括号结构检查。
- 267 个交付文件通过严格 UTF-8 解码，无替换字符。
- 51 / 51 个页面通过统一根 Motion 接入扫描。

### 14.2 行为和竞态测试

- `CACHE_SECURITY_RETRY_OK`：`userId` 隔离、公开商品白名单、枚举失败不写 marker、恢复后重试清理。
- `MERGE_EVENTCHANNEL_REVALIDATE_OK`：资格预览只走内存，确认页仍由服务端重新校验。
- `HOME_REQUEST_TRAILING_OK`：首页旧请求不覆盖新搜索，最新 scope 会补发。
- `ORDER_DETAIL_LOCK_OK`：首次进入只共享一个详情请求。
- `DASHBOARD_LATEST_RANGE_OK`：快速切换范围时仅最新响应落地。
- `GET_PRODUCTS_EXACT_BRANCH_OK`：公开精确查询、不可见商品过滤、后台鉴权和返回结构通过。
- `MOTION_API_OK`：统一 API、fixed 页面纯 fade 和最多 6 项 stagger 通过。
- `ADMIN_PRODUCTS_REQUEST_RACE_OK`：旧分页丢弃、最新筛选第一页、正常下一页和 pull-down Promise 通过。
- `INVENTORY_AUTH_LOADING_OK`：鉴权失败后退出 skeleton。
- `CART_TRAILING_AND_MUTATION_ORDER_OK`：旧校准不会覆盖本地操作，价格会由 trailing 请求校准。
- `CART_SAME_ITEM_FAIL_THEN_SUCCESS_OK`：同商品连续数量写入按 FIFO 到达服务端，旧失败不回滚新值。
- `CART_SKIPPED_FETCH_TRAILING_OK`：首次校准因 pending/draft 被跳过时，操作完成后恰好补发一次。
- 独立回归线程 `CART_FINAL_HARNESS_OK`：A 商品失败只局部回滚 A，B 商品的 optimistic/成功状态保留，并合并一次 recovery fetch。

### 14.3 微信开发者工具

- 已通过本机微信开发者工具 Stable `v2.01.2510280` 重新打开并编译当前项目，模拟器成功渲染首页。
- 面板显示 `Errors: 0`、`问题: 0`。
- 当前有 10 条运行时 warning，来源为 `wx.getSystemInfoSync` 废弃提示、灰度基础库提示、自动热重载提示和一次性能提示；没有编译错误。
- 本次单次运行记录 `App.onLaunch 93ms`、系统 `Launch Time 2638ms`。这不是同设备前后对照基准，不用于宣称具体提速比例。

## 15. 独立审查结论

- 缓存安全审查最终未发现 P0/P1：跨用户 key 隔离、敏感旧缓存重试和合并发货内存传递均通过 mock。
- 回归审查先后发现并推动修复购物车校准覆盖、mutation 自身乱序、首次校准被 pending 跳过、后台商品筛选错页和库存页永久 skeleton。
- 最终独立回归未发现新的 P0/P1/P2，可以交付本地代码。

## 16. 业务影响

- 没有改变订单状态、库存扣减、付款、退款、发货、售后、权限点或角色可见范围。
- 购物车只改变请求调度、失败回滚和校准时序；API 名称、参数、幂等键、金额计算和提交订单语义不变。
- `getProducts` 只增加可选精确查询入口，旧的无 `productId` 调用继续兼容。
- 没有删除已有页面、按钮、筛选或后台功能。

## 17. 仍可优化和剩余风险

- 需要在 iOS / Android 真机继续验证快速点击、输入框 blur/tap 顺序、弱网 trailing loading、fixed 底栏和长列表滚动手感。
- `getOrders` N+1、推荐和搜索大扫描、dashboard 聚合仍是服务端 P2，需要真实数据规模、索引和权限输出基线后单独优化。
- 若退出时 `getStorageInfoSync()` 持续异常，旧动态 key 可能物理残留；新用户因 `userId` scope 不会命中，后续枚举恢复时会重试清理。
- `orientation.js` 仍使用已废弃的 `wx.getSystemInfoSync`，开发者工具会重复 warning；应另开基础 API 兼容专项处理，避免和本轮性能竞态回修混在一起。
- 本轮没有形成同设备冷/热启动 P50/P95、FPS 或内存前后对照，因此只确认路径减少、竞态正确和编译通过，不宣称具体百分比提升。

## 18. 部署说明

- 需要上传的云函数（A-Z）：`getProducts`。
- 小程序前端已在本地开发者工具重新编译并渲染；发布前仍需按修改文件重新预览/体验版验收。
- 其他订单、购物车、库存、付款、退款、发货、权限和后台云函数均未修改，旧入口保持兼容。
- 尚未上传云函数，尚未生成预览二维码，尚未发布小程序，也未执行生产写操作。
