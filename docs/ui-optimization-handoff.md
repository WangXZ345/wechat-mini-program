# UI 优化交付说明

## 风格基准

- 主题：沙漠金、沙漠钛金、奶油白、高级圆角、轻奢商务、干净克制。
- 代码 token 来源：`miniprogram/styles/theme.wxss`。
- 业务边界：本轮只调整前端 UI/UX，不修改云函数、权限、订单、库存、付款、退款、发货和售后状态流转。

## Figma 结构建议

Figma 文件：<https://www.figma.com/design/VmTlUGbL6ntXk7YqN6YAfr>

说明：本轮已成功创建 Figma 文件，但后续写入设计系统和页面稿时被 Starter 计划 MCP 调用上限拦截。2026-07-09 复查时只确认账号状态，未继续重试读写类 Figma 调用；当前 Figma 连接仅返回一个 Starter 团队，且席位为 View，没有可自动切换的可编辑团队或更高计划。因此当前以本地代码改动和本文档作为交付；需要在 Figma 侧升级计划/授予可编辑席位，或切换到有可用 MCP 额度和编辑权限的团队账号后，才能继续把下列结构写入 Figma。

本轮修复尝试：再次确认 Figma 连接器仍可返回账号身份，但没有暴露自动清空额度、升级计划、切换账号或重连授权的工具；同时检查本地插件端点、Codex 登录缓存、主要状态库和 OAuth 安装恢复状态，未发现可通过本地文件修复的 Figma 团队/席位/额度配置。因此该阻塞仍需在 Figma / Codex 连接侧处理，不能通过本地小程序代码修复。

最新执行决策：Figma 插件当前不可用，本轮改为使用 `docs/figma.md` 作为设计规范，并在代码中落地设计系统；后续插件恢复后可根据 `docs/figma.md` 再同步到 Figma。

建议页面结构：

1. `00 Foundations`
   - 色彩：pageBg、cardBg、cardWarm、primary、primaryDeep、border、tagBg、textMain、muted、price、success、warning、danger。
   - 字体层级：页面标题、模块标题、正文、辅助说明、金额。
   - 圆角：xs、sm、md、lg、xl、pill。
   - 阴影：card、soft、floating、tabBar。
2. `01 Components`
   - `Button / Primary`
   - `Button / Secondary`
   - `Button / Danger`
   - `Card / Product`
   - `Card / Order`
   - `Badge / Status`
   - `Input / Search`
   - `Input / Textarea`
   - `Control / Stepper`
   - `Upload / Proof`
   - `Layout / AdminDashboard`
3. `02 Customer App`
   - 商品首页、商品详情、购物车、订单详情、付款页、售后申请。
4. `03 Admin Console`
   - 后台首页、商品管理、库存管理、付款审核、售后退款、商品数据分析。

## 本轮已落地的页面方向

- 首页：收敛首屏操作，保留收藏、常购、购物车主入口；找货文案改为联系商家。
- 商品详情：数量输入改为与购物车一致的加减控件；横屏分栏改为命中 `.product-card`。
- 购物车：提交按钮改为“提交预订单”；横屏右侧结算栏修正为真实分栏。
- 购物车续跑：新增待提交商品分区标题，商品行、配送方式和悬浮结算面板进一步轻量化；保留选中、删除、数量、地址和提交预订单逻辑。
- 订单详情：新增顶部“当前进度”主行动卡；实际自提时间单独命名。
- 付款页：金额标题改为“账户待付合计”，增加待确认说明和截图数量提示。
- 售后申请：按步骤组织订单、原因、说明、商品、金额和凭证。
- 后台首页：指标、功能入口、常用操作拆分；功能入口按订单履约、商品库存、财务账款、系统配置分组。
- 后台首页收口：待发货入口补齐发货权限过滤；客户欠款提醒改为脱敏用户 ID 和备注短摘要。
- 商品数据分析：新增 App Store-like 工作台 hero、当前范围/商品胶囊、横向时间范围胶囊、选中商品主卡、指标摘要卡和图表卡网格；宽屏下图表进入双列工作台布局。
- 库存管理：新增工作台 hero、库存数量胶囊、库存行卡片、日志行卡片和宽屏双列布局；保留清空库存的权限、二次确认和倒计时。
- 库存管理清理：合并页面卸载清理逻辑，确保清空库存倒计时和横竖屏监听都能正确释放。
- 商品详情续跑：新增 `detail-layout`，横屏/宽屏下左侧商品大图、右侧信息/数量/配送聚合，竖屏顺序保持不变；保留收藏、数量、加购、立即预下单、配送和地址选择绑定。
- 订单列表续跑：新增“订单动态”分区标题、筛选笔数提示、状态色顶部细线、金额摘要面板、种类/数量指标和“查看详情”行动胶囊；保留筛选、刷新、进入详情、缓存和 `getOrders` 查询逻辑。
- 后台订单管理续跑：新增订单队列工作台 hero、筛选汇总胶囊、客户/履约信息面板、付款状态面板和卡内横屏双列结构；保留筛选、导出、审核、付款确认、取消订单、备注和合并发货逻辑。
- 商品管理续跑：新增商品工作台 hero、当前商品/已选商品指标、筛选汇总胶囊、表单分组网格、批量工具箱和缩略图商品卡；保留新建、编辑、搜索、筛选、上下架、调价、标签、库存预警和补齐索引逻辑。
- 发货履约续跑：新增发货工作台、履约工作台、发货单详情 hero、筛选汇总胶囊、物流表单分区、订单/商品队列卡片和日志分区；保留发货、自提、完成、售后、导出、取消和复制相关事件绑定。
- 报价/库存导入续跑：新增导入工作台 hero、文件状态指标、上传步骤卡、处理方式卡、导入预览指标、商品队列卡、历史记录卡和详情明细网格；保留解析、预览缓存、二次确认、分批导入、幂等键、错误/警告和历史详情逻辑。
- 售后退款续跑：新增售后工作台、退款记录工作台、售后/退款队列卡、详情 hero、金额摘要网格、操作侧栏、凭证面板和日志面板；保留审核、验货、创建退款、确认退款、微信退款、拒绝退款、导出和详情跳转逻辑。
- 财务账款续跑：新增客户账款中心 hero、筛选汇总、账款队列卡、客户详情 hero、账款汇总侧栏、订单明细、付款记录和流水分区；保留筛选、排序、搜索、详情、重算、风险、结清、备注、导出对账单和打开文件逻辑。

## 修改文件清单

- `miniprogram/styles/theme.wxss`
- `miniprogram/styles/components.wxss`
- `miniprogram/styles/landscape.wxss`
- `miniprogram/custom-tab-bar/index.wxss`
- `miniprogram/components/ui-tag/index.wxss`
- `miniprogram/components/ui-empty/index.wxss`
- `miniprogram/components/ui-loading/index.wxss`
- `miniprogram/components/ui-status-step/index.wxss`
- `miniprogram/pages/index/index.wxml`
- `miniprogram/pages/index/index.js`
- `miniprogram/pages/index/index.wxss`
- `miniprogram/pages/product/detail.wxml`
- `miniprogram/pages/product/detail.js`
- `miniprogram/pages/product/detail.wxss`
- `miniprogram/pages/cart/index.wxml`
- `miniprogram/pages/cart/index.wxss`
- `miniprogram/pages/order/list.wxml`
- `miniprogram/pages/order/list.wxss`
- `miniprogram/pages/order/detail.wxml`
- `miniprogram/pages/order/detail.wxss`
- `miniprogram/pages/payment/payment.wxml`
- `miniprogram/pages/payment/payment.wxss`
- `miniprogram/pages/after-sale/apply.wxml`
- `miniprogram/pages/after-sale/apply.wxss`
- `miniprogram/pages/address/list.wxss`
- `miniprogram/pages/admin/dashboard/index.wxml`
- `miniprogram/pages/admin/dashboard/index.js`
- `miniprogram/pages/admin/dashboard/index.wxss`
- `miniprogram/pages/admin/products.wxml`
- `miniprogram/pages/admin/products.wxss`
- `miniprogram/pages/admin/inventory.js`
- `miniprogram/pages/admin/inventory.wxml`
- `miniprogram/pages/admin/inventory.wxss`
- `miniprogram/pages/admin/orders.wxml`
- `miniprogram/pages/admin/orders.wxss`
- `miniprogram/pages/admin/delivery/index.wxml`
- `miniprogram/pages/admin/delivery/index.wxss`
- `miniprogram/pages/admin/shipments/index.wxml`
- `miniprogram/pages/admin/shipments/index.wxss`
- `miniprogram/pages/admin/shipments/detail.wxml`
- `miniprogram/pages/admin/shipments/detail.wxss`
- `miniprogram/pages/admin/import/index.wxml`
- `miniprogram/pages/admin/import/index.wxss`
- `miniprogram/pages/admin/import/preview/index.wxml`
- `miniprogram/pages/admin/import/preview/index.wxss`
- `miniprogram/pages/admin/import/history/index.wxml`
- `miniprogram/pages/admin/import/history/index.wxss`
- `miniprogram/pages/admin/after-sales/index/index.wxml`
- `miniprogram/pages/admin/after-sales/index/index.wxss`
- `miniprogram/pages/admin/after-sales/detail/index.wxml`
- `miniprogram/pages/admin/after-sales/detail/index.wxss`
- `miniprogram/pages/admin/refunds/index/index.wxml`
- `miniprogram/pages/admin/refunds/index/index.wxss`
- `miniprogram/pages/admin/refunds/detail/index.wxml`
- `miniprogram/pages/admin/refunds/detail/index.wxss`
- `miniprogram/pages/admin/accounts/index.wxml`
- `miniprogram/pages/admin/accounts/index.wxss`
- `miniprogram/pages/admin/accounts/detail.wxml`
- `miniprogram/pages/admin/accounts/detail.wxss`
- `miniprogram/pages/admin/payment-methods/index.wxss`
- `miniprogram/pages/admin/product-analytics/index.wxml`
- `miniprogram/pages/admin/product-analytics/index.wxss`
- `docs/ui-optimization-handoff.md`
- `docs/figma.md`

## 静态检查

- 使用 Codex bundled Node 对 `miniprogram/pages/index/index.js`、`miniprogram/pages/product/detail.js`、`miniprogram/pages/admin/dashboard/index.js` 执行语法检查，通过。
- 使用 Codex bundled Node 对 `miniprogram/pages/admin/inventory.js`、`miniprogram/pages/admin/product-analytics/index.js` 执行语法检查，通过。
- 使用 Codex bundled Node 对 `miniprogram/pages/product/detail.js`、`miniprogram/pages/cart/index.js` 执行语法检查，通过。
- `miniprogram` 下 JSON 文件 UTF-8 解析通过。
- `miniprogram/pages/admin/inventory.json`、`miniprogram/pages/admin/product-analytics/index.json`、`project.config.json` JSON 解析通过。
- `miniprogram/pages/product/detail.json`、`miniprogram/pages/cart/index.json`、`project.config.json` JSON 解析通过。
- `miniprogram/pages/product/detail.wxml`、`miniprogram/pages/cart/index.wxml` 的 `view` 标签计数平衡。
- `miniprogram/pages/order/list.js` 语法检查通过。
- `miniprogram/pages/order/list.json`、`project.config.json` JSON 解析通过。
- `miniprogram/pages/order/list.wxml` 的 `view` 标签计数平衡。
- `miniprogram/pages/order/list.wxml` 关键绑定 `selectOrderFilter`、`refreshOrders`、`goDetail` 粗查通过。
- `miniprogram/pages/admin/orders.js` 语法检查通过。
- `miniprogram/pages/admin/orders.json`、`project.config.json` JSON 解析通过。
- `miniprogram/pages/admin/orders.wxml` 的 `view` 标签计数平衡。
- `miniprogram/pages/admin/orders.wxml` 关键绑定 `goShipments`、`load`、`confirmExport`、`review`、`markPayment`、`cancelOrder`、`toggleSelectOrder`、`createMergeShipmentFromSelection`、`saveOrderNote`、`clearOrderNote`、`loadOrderNoteLogs`、`resetFilters` 粗查通过。
- `miniprogram/pages/admin/products.js` 语法检查通过。
- `miniprogram/pages/admin/products.json`、`project.config.json` JSON 解析通过。
- `miniprogram/pages/admin/products.wxml` 的 `view` 标签计数平衡。
- `miniprogram/pages/admin/products.wxml` 关键绑定 `newProduct`、`saveProduct`、`searchNow`、`toggleSelectAll`、`bulkActivate`、`runBatchPrice`、`runBatchWarningStock`、`runBatchTag`、`runBatchInternalTag`、`generateIndexes`、`savePrice`、`editProduct`、`deleteProduct` 粗查通过。
- `miniprogram/pages/admin/delivery/index.js`、`miniprogram/pages/admin/shipments/index.js`、`miniprogram/pages/admin/shipments/detail.js` 语法检查通过。
- `miniprogram/pages/admin/delivery/index.json`、`miniprogram/pages/admin/shipments/index.json`、`miniprogram/pages/admin/shipments/detail.json`、`project.config.json` JSON 解析通过。
- `miniprogram/pages/admin/delivery/index.wxml`、`miniprogram/pages/admin/shipments/index.wxml`、`miniprogram/pages/admin/shipments/detail.wxml` 的 `view` 标签计数平衡。
- 发货链路关键绑定 `load`、`onDeliveryTypeChange`、`onDeliveryStatusChange`、`onPaymentStatusChange`、`onDraftInput`、`uploadImage`、`updateDelivery`、`goOrders`、`onKeyword`、`onStatusChange`、`search`、`goDetail`、`loadMore`、`onInput`、`saveInfo`、`confirmShipment`、`cancelShipment`、`completeShipment`、`exportPickingList`、`copyTrackingNo`、`copyExportLink`、`openExportFile` 粗查通过。
- `miniprogram/pages/admin/import/index.js`、`miniprogram/pages/admin/import/preview/index.js`、`miniprogram/pages/admin/import/history/index.js` 语法检查通过。
- `miniprogram/pages/admin/import/index.json`、`miniprogram/pages/admin/import/preview/index.json`、`miniprogram/pages/admin/import/history/index.json`、`project.config.json` JSON 解析通过。
- `miniprogram/pages/admin/import/index.wxml`、`miniprogram/pages/admin/import/preview/index.wxml`、`miniprogram/pages/admin/import/history/index.wxml` 的 `view` 标签计数平衡。
- 导入链路关键绑定 `goHistory`、`parseFile`、`chooseFile`、`choosePriceFile`、`onStockModeChange`、`onPriceModeChange`、`confirmImport`、`backToImport`、`onSelectedChange`、`onFieldInput`、`onActionChange`、`showDetail`、`backList` 粗查通过。
- `miniprogram/pages/admin/after-sales/index/index.js`、`miniprogram/pages/admin/after-sales/detail/index.js`、`miniprogram/pages/admin/refunds/index/index.js`、`miniprogram/pages/admin/refunds/detail/index.js` 语法检查通过。
- `miniprogram/pages/admin/after-sales/index/index.json`、`miniprogram/pages/admin/after-sales/detail/index.json`、`miniprogram/pages/admin/refunds/index/index.json`、`miniprogram/pages/admin/refunds/detail/index.json`、`project.config.json` JSON 解析通过。
- `miniprogram/pages/admin/after-sales/index/index.wxml`、`miniprogram/pages/admin/after-sales/detail/index.wxml`、`miniprogram/pages/admin/refunds/index/index.wxml`、`miniprogram/pages/admin/refunds/detail/index.wxml` 标签检查通过，自闭合 `input` / `switch` 按 WXML 规则单独检查。
- 售后退款关键绑定和 `data-*` 粗查通过：`goDetail`、`goRefunds`、`load`、`exportExcel`、`copyExportLink`、`review`、`confirmReceived`、`inspect`、`createRefund`、`complete`、`goRefund`、`chooseProofImages`、`removeProof`、`processRefund`、`wechatRefund`、`rejectRefund`、`data-field`、`data-action`、`data-id`、`data-index` 均保留。
- `miniprogram/pages/admin/after-sales/index/index.wxss`、`miniprogram/pages/admin/after-sales/detail/index.wxss`、`miniprogram/pages/admin/refunds/index/index.wxss`、`miniprogram/pages/admin/refunds/detail/index.wxss` 大括号检查通过。
- `miniprogram/pages/admin/accounts/index.js`、`miniprogram/pages/admin/accounts/detail.js` 语法检查通过。
- `miniprogram/pages/admin/accounts/index.json`、`miniprogram/pages/admin/accounts/detail.json`、`project.config.json` JSON 解析通过。
- `miniprogram/pages/admin/accounts/index.wxml`、`miniprogram/pages/admin/accounts/detail.wxml` 标签检查通过。
- 财务账款关键绑定和 `data-id` 粗查通过：`load`、`onFilterChange`、`onSortChange`、`onKeyword`、`search`、`goDetail`、`recalc`、`markRisk`、`markSettled`、`updateRemark`、`updateRisk`、`exportStatement`、`openExportFile`、`data-id="{{item._id}}"` 均保留。
- 财务账款敏感字段扫描通过，未新增 `phoneNumber`、`paymentScreenshot`、`transaction`、`fileUrl`、`shippingAddress`、`operatorOpenid`、`receiverPhone`、`detailAddress`、`paymentProof`、`proofUrl`。
- `miniprogram/pages/admin/accounts/index.wxss`、`miniprogram/pages/admin/accounts/detail.wxss` 大括号检查通过。
- `docs/ui-optimization-handoff.md` UTF-8 检查通过，无替换字符。
- 本轮改动文件 UTF-8 检查通过，无替换字符。
- 关键 WXML 事件绑定粗查通过，未发现新增绑定缺失方法。
- 当前目录 `git status` 返回 `fatal: not a git repository`，无法用 Git diff 严格列出本轮差异。

## 2026-07-09 主界面与底部导航优先修订

- 范围：按用户最新截图反馈，优先处理 `miniprogram/pages/index/index.wxml`、`miniprogram/pages/index/index.wxss`、`miniprogram/custom-tab-bar/index.wxml`、`miniprogram/custom-tab-bar/index.wxss`。
- 首页：将冗余的 hero、搜索卡、分类标题和推荐标题收敛为 App Store-like 顶部频道区；保留大标题、收藏/常购/购物车入口、单行搜索、横向分类、今日精选大卡、横向推荐和普通商品列表。
- 底部导航：沿用现有 `custom-tab-bar` 路由和 badge 机制，移除自绘 home indicator，改为更轻的半透明浮动胶囊和浅色选中 pill。
- 业务保护：未改首页 JS、底部导航 JS、云函数、权限、商品查询、推荐查询、购物车角标、页面路由；保留 `goFavorite`、`goFrequent`、`goCart`、`onSearchFocus`、`onSearchInput`、`onSearchConfirm`、`clearSearch`、`onCategoryTap`、`onRecommendTabTap`、`goRecommend`、`goDetail`、`addToCart`、`toggleFavorite`。
- 本轮检查：`pages/index/index.js`、`custom-tab-bar/index.js` 语法检查通过；`pages/index/index.json`、`custom-tab-bar/index.json`、`project.config.json` JSON 解析通过；两处 WXML 标签检查通过；两处 WXSS 大括号和 UTF-8 检查通过；首页与底部导航敏感字段扫描通过。

## 2026-07-09 主界面混乱热修

- 问题：截图中首页顶部快捷入口撑开布局，导致标题逐字竖排、购物车入口右侧溢出、首屏空白过大。
- 修复：将顶部收藏/常购/购物车快捷入口从原生 `button` 改为 `view` 点击区，避免微信默认按钮宽度干扰；顶部标题区改为块级布局，快捷入口绝对定位并固定宽度。
- 保留：`goFavorite`、`goFrequent`、`goCart`、搜索、分类、推荐、商品详情、加购和收藏绑定均保留。
- 验证：首页 JS 与底部导航 JS 语法检查通过；WXML 标签、WXSS 大括号、JSON 解析、关键绑定、敏感字段扫描通过。

## 2026-07-09 首页首屏密度修订

- 问题：用户反馈首屏只显示一个产品，当前“精选大卡优先”占用过多空间。
- 修复：首页改为“紧凑商品流优先”；压缩顶部频道、搜索、分类、推荐标题、精选商品卡、普通商品卡和底部导航高度。
- 关键变化：精选商品卡从大封面卡改成横向紧凑卡；普通商品卡缩小图片和按钮；首页底部留白与浮动 tabBar 高度同步降低。
- 保留：未改首页 JS、底部导航 JS、云函数、权限、商品查询、推荐查询、购物车角标、加购、收藏或路由。
- 验证：首页与底部导航 JS 语法检查通过；WXML 标签、WXSS 大括号、JSON 解析、关键绑定、敏感字段扫描通过。

## 2026-07-09 首页多横向商品分区修订

- 问题：单个精选大卡仍然过强，首页不够像 App Store 连续横向分区的信息流。
- 修复：推荐区从单个 `visibleRecommendSections` 改为展示全部 `recommendSections`；每个推荐频道都渲染为横向商品 rail。
- 关键变化：移除推荐区首个商品放大卡逻辑，新增 `home-product-rail`、`home-rail-row`、`home-rail-card` 紧凑样式；每张卡固定图片比例、两行标题、单行辅助信息、底部价格和加购按钮。
- 保留：`goRecommend`、`goDetail`、`addToCart`、商品图、标签、价格、禁用态绑定均保留；未改首页 JS、云函数、权限或路由。
- 验证：首页与底部导航 JS 语法检查通过；WXML 标签、WXSS 大括号、JSON 解析、关键绑定、敏感字段扫描通过。

## 2026-07-09 首页推荐频道三选一修订

- 问题：用户明确要求常购 / 新货 / 热销由用户三选一显示，不要三个推荐分区全部堆叠。
- 修复：推荐区重新接回 `recommendTabs`、`activeRecommendKey`、`visibleRecommendSections` 和 `onRecommendTabTap`；顶部显示三段单选频道，下面只显示当前选中的一个推荐频道。
- 样式：新增 `home-recommend-switch` 三段控件，选中态深沙漠金底白字，未选中态奶油白。
- 保留：仅改首页 JS 展示整形层，按 `frequent_purchase`、`new_arrivals`、`hot_selling` 过滤和排序；切换选择会写回首页推荐缓存，返回首页不跳回默认频道；未改推荐接口、加购、商品详情、权限、路由或云函数。
- 验证：首页 JS 语法检查通过；WXML 标签、WXSS 大括号、JSON 解析、关键绑定和敏感字段扫描通过。

## 2026-07-09 购物车主流程打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/cart/index.wxml`、`miniprogram/pages/cart/index.wxss`、`miniprogram/pages/cart/index.js`。
- 修复：购物车顶部从大渐变横幅改为白底大标题 + 右侧轻胶囊操作；商品分区和配送分区文案改成中文；商品卡、图片、数量控件、配送卡和底部留白同步压缩，减少冗余和首屏遮挡。
- 隐私：移除永不渲染的旧地址直填模板；新增 `receiverPhoneDisplay`，当地址来源只有完整手机号时只在页面显示脱敏文本。
- 保留：`clearCart`、`retryLoad`、`goShop`、`toggleItem`、`removeItem`、`changeQty`、`onQtyInput`、`onQtyBlur`、`onDeliveryTypeChange`、`chooseAddress`、`addAddress`、`toggleAll`、`submitCartOrder` 绑定均保留；未改提交订单、幂等、地址 ID、金额、数量、云函数或权限逻辑。
- 验证：购物车 JS 语法检查通过；`pages/cart/index.json`、`project.config.json` JSON 解析通过；购物车 WXML 标签检查通过；关键绑定和 WXML 直接敏感字段显示检查通过；购物车 WXSS 大括号和 UTF-8 检查通过。

## 2026-07-09 商品详情转化页打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/product/detail.wxml`、`miniprogram/pages/product/detail.wxss`、`miniprogram/pages/product/detail.js`。
- 修复：商品名集中到页面大标题区，商品图改为干净媒体卡，详情卡只承载价格、标签、规格、品类、品牌、生产日期和说明，减少重复信息；底部操作栏从贴边整条底栏改为轻浮动胶囊。
- 隐私：移除永不渲染的旧地址直填模板；新增 `receiverPhoneDisplay`，当地址来源只有完整手机号时只在页面显示脱敏文本。
- 保留：`toggleFavorite`、`changeQty`、`onQtyInput`、`onQtyBlur`、`onDeliveryTypeChange`、`chooseAddress`、`addAddress`、`addToCart`、`submitOrder`、`goShop` 绑定均保留；未改 `createOrder`、`addToCart`、幂等、地址 ID、金额、数量、云函数或权限逻辑。
- 验证：商品详情 JS 语法检查通过；`pages/product/detail.json`、`project.config.json` JSON 解析通过；商品详情 WXML 标签检查通过；关键绑定和 WXML 直接完整手机号兜底检查通过；商品详情 WXSS 大括号和 UTF-8 检查通过。

## 2026-07-09 前台订单列表打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/order/list.wxml`、`miniprogram/pages/order/list.wxss`。
- 修复：订单列表顶部从渐变横幅改为白底大标题 + 订单数量胶囊；筛选胶囊保持横向滚动；分区文案从 `ORDER FLOW` 改为中文；订单卡改为左侧状态色条和更紧凑的信息面板。
- 保留：`selectOrderFilter`、`refreshOrders`、`goDetail`、`data-id="{{item._id}}"`、`data-filter="{{item.value}}"` 绑定均保留；未改 `getOrders` 调用、订单状态、付款状态、发货状态、筛选派生、缓存、分页、下拉刷新或 tabBar 同步逻辑。
- 验证：订单列表 JS 语法检查通过；`pages/order/list.json`、`project.config.json` JSON 解析通过；订单列表 WXML 标签检查通过；关键绑定检查通过；订单列表 WXSS 大括号和 UTF-8 检查通过。

## 2026-07-09 前台订单详情打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/order/detail.wxml`、`miniprogram/pages/order/detail.wxss`、`miniprogram/pages/order/detail.js`。
- 修复：订单详情顶部从渐变 hero 改为白底大标题 + 状态胶囊；卡片圆角、边框、阴影、`kv` 行距和按钮间距同步收紧，让进度、商品明细、配送、合并发货、售后和取消入口更清晰。
- 隐私：新增 `shippingAddressDisplay`，优先使用 `shippingAddressMasked`，否则本地脱敏手机号和地址；WXML 不再直接绑定完整手机号、完整地址或详细地址字段。
- 保留：`triggerAutoReview`、`goPayment`、`goAfterSaleApply`、`goAfterSaleDetail`、`copyTrackingNo`、`cancelOrder` 绑定均保留；未改 `getOrders`、`autoReviewOrder`、`cancelOrder`、付款入口、售后入口、快递单号复制、订单状态、取消条件、幂等或云函数逻辑。
- 验证：订单详情 JS 语法检查通过；`pages/order/detail.json`、`project.config.json` JSON 解析通过；订单详情 WXML 标签检查通过；关键绑定和 WXML 直接敏感字段显示检查通过；订单详情 WXSS 大括号和 UTF-8 检查通过。

## 2026-07-09 前台付款页打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/payment/payment.wxml`、`miniprogram/pages/payment/payment.wxss`。
- 修复：新增付款页白底大标题和状态胶囊；账款合计、付款方式、收款二维码/银行卡、微信支付提示、付款凭证上传区统一成更清晰的 `payment-card` 操作流；横屏下标题跨两列，金额卡左侧 sticky，操作区右侧滚动。
- 保留：`selectMethod`、`previewQr`、`copyText`、`copyAllBankInfo`、`startWechatPay`、`previewScreenshot`、`removeScreenshot`、`chooseImages`、`onRemarkInput`、`submitOfflineProof` 绑定均保留；未改付款方式读取、选中付款方式、截图上传、线下凭证提交、微信支付、幂等、付款状态或云函数逻辑。
- 付款语义：继续明确“上传凭证后等待财务确认”，不把线下付款暗示为已到账。
- 验证：付款页 JS 语法检查通过；`pages/payment/payment.json`、`project.config.json` JSON 解析通过；付款页 WXML 标签检查通过；关键绑定、`submitOfflinePaymentProof` 和等待财务确认文案检查通过；付款页 WXSS 大括号和 UTF-8 检查通过。

## 2026-07-09 前台售后申请打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/after-sale/apply.wxml`、`miniprogram/pages/after-sale/apply.wxss`。
- 修复：新增售后申请白底大标题和状态胶囊；订单信息改为可退金额突出的主摘要卡；售后类型、原因、详细说明、商品选择、退款金额、凭证上传按步骤表单呈现；提交区补充“等待客服审核，退款不会自动完成”提示。
- 保留：`onTypeChange`、`onReasonChange`、`onInput`、`toggleItem`、`onQuantityInput`、`chooseImages`、`removeImage`、`submit` 绑定均保留；未改订单读取、售后申请创建、凭证上传、退款金额校验、原因字数校验、幂等或售后状态逻辑。
- 售后语义：提交成功仍提示等待客服审核，不弱化客服审核和后续退款流程。
- 验证：售后申请 JS 语法检查通过；`pages/after-sale/apply.json`、`project.config.json` JSON 解析通过；WXML 标签检查通过（`input` 按 WXML 自闭合单独检查）；关键绑定、`createAfterSaleRequest` 和等待客服审核文案检查通过；WXSS 大括号和 UTF-8 检查通过。

## 2026-07-09 前台售后详情打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/after-sale/detail.wxml`、`miniprogram/pages/after-sale/detail.wxss`。
- 修复：新增售后详情白底大标题和状态胶囊；首卡改为售后单号、订单号、申请金额和退款状态的摘要卡；申请内容、售后商品、审核信息、退货物流和时间线统一为更清晰的状态页模块。
- 保留：`onInput`、`submitLogistics` 绑定均保留；未改售后详情读取、退货物流提交、状态映射、金额格式化、退款状态或售后流程逻辑。
- 验证：售后详情 JS 语法检查通过；`pages/after-sale/detail.json`、`project.config.json` JSON 解析通过；WXML 标签检查通过（`input` 按 WXML 自闭合单独检查）；关键绑定、`getMyAfterSaleDetail` 和 `submitReturnLogistics` 调用检查通过；WXSS 大括号和 UTF-8 检查通过。

## 2026-07-09 库存预警与未售分析打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/admin/stock-alerts/index.wxml`、`miniprogram/pages/admin/stock-alerts/index.wxss`、`miniprogram/pages/admin/unsold/index.wxml`、`miniprogram/pages/admin/unsold/index.wxss`。
- 库存预警：改为库存工作台大标题、低库存/缺货摘要、预警筛选卡、批量修改卡和带状态线的商品队列；保留一键检查、缺货自动下架、批量预警、单品预警、自动下架开关、编辑商品和库存日志。
- 未售分析：从旧表单堆叠改为商品运营工作台、四个摘要指标、横向时间范围胶囊、筛选排序卡、商品队列标题和更可扫描的商品卡；保留导出、自定义时间查询、所有筛选、排序、改价、调库存、重点关注、清仓标记和下架确认。
- 权限与敏感字段：未改 `ensureAdmin("inventory:view")`、`ensureAdmin("product:view")`、云函数调用、商品上下架、价格按分、库存数量、推荐/标签/权限规则；未新增客户、付款、账款、地址、openid、付款截图或交易号展示。
- 验证：库存预警和未售分析 JS 语法检查通过；对应 JSON 和 `project.config.json` 解析通过；两页 WXML 标签检查通过；关键绑定检查通过；两页 WXSS 大括号和 UTF-8 检查通过；敏感字段扫描未命中客户/付款/账款类字段。
- 部署：仅后台页面 WXML/WXSS 本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 支付配置、法律页和兼容入口打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/admin/payment-methods/index.wxml`、`miniprogram/pages/admin/payment-methods/index.wxss`、五个 `miniprogram/pages/legal/**/index.wxss`、`miniprogram/pages/admin/dashboard.wxml`、`miniprogram/pages/admin/dashboard.wxss`、`miniprogram/pages/admin/accounts.wxml`、`miniprogram/pages/admin/accounts.wxss`。
- 支付配置：从旧卡片表单改为财务配置工作台、支付方式摘要、微信支付状态卡、支付方式状态线卡片和分组弹层表单；保留新增、编辑、启停、删除、二维码预览、二维码上传、银行卡字段、保存和敏感变更确认。
- 法律页：不改正文，仅统一隐私保护、用户协议、付款说明、售后规则、瑕疵商品说明的标题卡、文档卡、长文本行距和宽屏阅读宽度。
- 兼容入口：旧 `pages/admin/dashboard` 改为轻工作台布局，旧 `pages/admin/accounts` 改为账款摘要卡布局；保留旧入口菜单、库存一键检查、未售入口、刷新和标记历史已付绑定。
- 验证：支付配置、五个法律页、旧后台首页、旧账款入口 JS 语法检查通过；对应 JSON 和 `project.config.json` 解析通过；WXML 标签与关键绑定检查通过；WXSS 大括号和 UTF-8 检查通过。
- 部署：仅前端 WXML/WXSS 本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 合并发货确认页打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/admin/shipments/merge-confirm.wxml`、`miniprogram/pages/admin/shipments/merge-confirm.wxss`。
- 修复：将旧确认页改为发货履约大标题、客户摘要卡、订单/商品/地址信息卡、地址一致性状态胶囊和底部确认主按钮；订单金额、已付、未付和商品汇总改为可扫描指标块。
- 保留：`eligibility.canMerge` 禁用条件、失败原因展示、收货地址不一致提醒、`summary.orders`、`itemSummary`、`createShipment`、幂等键、二次确认弹窗和跳转到发货单详情逻辑均保持不变。
- 验证：合并发货确认页 JS 语法检查通过；`pages/admin/shipments/merge-confirm.json` 和 `project.config.json` 解析通过；WXML 标签、关键绑定、WXSS 大括号和 UTF-8 检查通过。
- 部署：仅前端 WXML/WXSS 本地修改，尚未上传云函数，尚未发布小程序。

## 需要微信开发者工具验收

- 竖屏：商品首页、底部导航栏、商品详情、推荐列表页、收藏页、常购页、购物车、订单列表、订单详情、付款页、售后申请、后台首页、后台订单管理、商品管理、发货管理、合并发货单列表、合并发货确认、发货单详情、库存导入、导入预览、导入历史、售后管理、售后详情、退款记录、退款详情、客户账款中心、客户账款详情、库存预警、未售商品分析、支付配置、法律说明页、旧后台首页、旧账款入口。
- 横屏/宽屏：商品首页、底部导航栏、商品详情、推荐列表页、收藏页、常购页、购物车、订单列表、付款配置弹层、后台首页、后台订单管理、商品管理、发货管理、合并发货单列表、合并发货确认、发货单详情、库存导入、导入预览、导入历史、售后管理、售后详情、退款记录、退款详情、客户账款中心、客户账款详情、库存预警、未售商品分析、支付配置、法律说明页、旧后台首页、旧账款入口。
- 角色：普通用户、客服、财务、采购、超级管理员入口可见性保持不变。

## 本轮未做

- 未上传云函数。
- 未发布小程序。
- 未改数据库结构。
- 未改后台真实状态操作确认逻辑。
- 未改金额单位存储或提交换算逻辑。

## 2026-07-09 登录与账号安全页样式收口

- 范围：收口 `miniprogram/pages/login/index.wxml`、`miniprogram/pages/login/index.wxss`、`miniprogram/pages/login/password.wxml`、`miniprogram/pages/login/password.wxss` 的前台账号入口样式。
- 修复：为已新增的 `login-hero`、`login-card-head`、`login-card-title`、`security-card-head`、`section-kicker`、`mode-pill` 补齐样式，使登录页和密码设置页继续沿用白底大标题、奶油白卡片、沙漠金胶囊的 App Store-like 信息层级。
- 保留：未改 `loginWechat`、`loginPassword`、`goPasswordSettings`、`showResetForm`、`submitReset`、`goLegal`、`submit` 等登录、密码、协议跳转和重置申请逻辑。
- 部署：仅前端 WXML/WXSS 本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 我的页主入口打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/profile/index.wxml`、`miniprogram/pages/profile/index.wxss`。
- 修复：将身份主卡、手机号状态、常用入口、后台管理、账号安全和协议说明统一成更清晰的分组标题行；账号状态和后台角色改为轻量胶囊；常用入口卡片进一步压缩高度，减少“多卡片堆叠”的拥挤感。
- 保留：`load`、`startEditNickname`、`saveNickname`、`goBindPhone`、`goOrders`、`goAddressList`、`goAfterSales`、`goAdmin`、`goPasswordSettings`、`logout`、`goLegal` 绑定均保留；`showAdminEntry`、`showCustomerEntries`、`backendOnly` 条件显示保持不变。
- 验证：我的页 JS 语法检查通过；`pages/profile/index.json`、`project.config.json` JSON 解析通过；WXML 标签检查通过；关键绑定和权限可见性条件检查通过；WXSS 大括号和 UTF-8 检查通过。
- 部署：仅前端 WXML/WXSS 本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 收藏与常购列表打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/favorite/index.wxml`、`miniprogram/pages/favorite/index.wxss`、`miniprogram/pages/frequent/index.wxml`、`miniprogram/pages/frequent/index.wxss`、`miniprogram/pages/frequent/index.js`。
- 修复：收藏页和常购页从旧渐变横幅改为白底大标题、轻量返回首页胶囊和紧凑商品行；商品卡统一奶油白背景、稳定图片比例、状态胶囊、突出价格和小型加购按钮。
- 交互：收藏页继续整卡进入详情，按钮区使用 `catchtap="stopTap"`；常购页同步改为整卡进入详情，去掉单独“详情”按钮，新增 `stopTap` 阻止收藏/加购按钮冒泡。
- 保留：`getFavoriteList`、`getFrequentPurchaseList`、`removeFavorite`、`toggleFavorite`、`addToCart`、排序、分页、下拉刷新、空状态和首页跳转逻辑均保持不变；未改云函数、权限、真实库存展示规则或商品详情路由。
- 验证：收藏/常购 JS 语法检查通过；两页 JSON 和 `project.config.json` 解析通过；两页 WXML 标签检查通过；关键绑定检查通过；两页 WXSS 大括号和 UTF-8 检查通过。
- 部署：仅前端 WXML/WXSS 和常购页非业务交互 JS 本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 推荐列表页打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/recommend/list.wxml`、`miniprogram/pages/recommend/list.wxss`。
- 修复：首页推荐区“查看更多”的下钻页从旧渐变横幅和厚搜索卡，改为白底大标题、轻量搜索胶囊、横向分类胶囊、列表统计/排序行和紧凑商品行。
- 保留：`goHome`、`onSearchInput`、`searchNow`、`clearSearch`、`onCategoryTap`、`onSortChange`、`goDetail`、`addToCart` 绑定均保留；未改 `getRecommendProducts`、`sectionKey` 校验、推荐分类、搜索、排序、分页、加购或商品详情路由。
- 验证：推荐列表页 JS 语法检查通过；`pages/recommend/list.json`、`project.config.json` JSON 解析通过；WXML 标签检查通过；关键绑定和推荐逻辑标记检查通过；WXSS 大括号和 UTF-8 检查通过。
- 部署：仅前端 WXML/WXSS 本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 地址、绑定手机号与售后列表打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/address/list.wxml`、`miniprogram/pages/address/list.wxss`、`miniprogram/pages/address/list.js`、`miniprogram/pages/address/edit.wxml`、`miniprogram/pages/address/edit.wxss`、`miniprogram/pages/profile/bind-phone.wxml`、`miniprogram/pages/profile/bind-phone.wxss`、`miniprogram/pages/after-sale/list.wxml`、`miniprogram/pages/after-sale/list.wxss`。
- 修复：地址列表补齐大标题、地址数量胶囊、状态线地址卡和轻浮动新增按钮；地址编辑页补齐配送信息大标题、选择模式胶囊和分组表单卡；绑定手机号页改为账号安全大标题、绑定状态卡、微信授权主卡和手动绑定备用卡；售后列表补齐大标题、数量胶囊和更可扫描的售后状态卡。
- 隐私：地址列表新增页面内 `receiverPhoneDisplay`，当后端未返回 `receiverPhoneMasked` 时本地脱敏手机号后再渲染；未改地址保存、订单提交或云函数返回结构。
- 保留：`selectAddress`、`addAddress`、`editAddress`、`setDefault`、`deleteAddress`、`onInput`、`onRegionChange`、`onDefaultChange`、`saveAddress`、`onGetPhoneNumber`、`submitManual`、`goDetail` 等绑定均保留；未改 `getMyAddresses`、`addMyAddress`、`updateMyAddress`、`deleteMyAddress`、`setDefaultAddress`、`bindPhoneByWechat`、`bindPhoneManual`、`getMyAfterSales` 或页面路由。
- 验证：地址列表/地址编辑/绑定手机号/售后列表 JS 语法检查通过；对应 JSON 和 `project.config.json` 解析通过；WXML 标签检查通过；关键绑定检查通过；WXSS 大括号和 UTF-8 检查通过。
- 部署：仅前端 WXML/WXSS 和地址列表展示整形 JS 本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 后台配置页打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/admin/recommend/index.wxml`、`miniprogram/pages/admin/recommend/index.wxss`、`miniprogram/pages/admin/settings.wxml`、`miniprogram/pages/admin/settings.wxss`、`miniprogram/pages/admin/admins/index.wxml`、`miniprogram/pages/admin/admins/index.wxss`。
- 修复：推荐配置页改为推荐工作台大标题、频道概览胶囊、推荐区配置卡和横向商品预览；业务配置页改为系统配置大标题、支付/自提/合并发货分组卡和开关说明行；管理员管理页改为系统权限大标题、管理员数量胶囊、管理员状态卡、角色/权限指标和日志列表。
- 保留：`load`、`onEnabledChange`、`onFieldInput`、`onDisplayTypeChange`、`saveSection`、`sortByCurrentInputs`、`onInput`、`save`、`onPickupInput`、`savePickup`、`onMergeSwitch`、`onMergeInput`、`saveMergeSettings`、`onRoleChange`、`createAdmin`、`startEditRole`、`saveRole`、`toggleStatus` 等绑定均保留；未改 `ensureAdmin` 权限点、云函数调用、角色选项、配置字段、推荐区保存结构或禁用管理员确认。
- 验证：推荐配置/业务配置/管理员管理 JS 语法检查通过；对应 JSON 和 `project.config.json` 解析通过；WXML 标签检查通过；关键绑定检查通过；WXSS 大括号和 UTF-8 检查通过。
- 部署：仅后台配置页面 WXML/WXSS 本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 客户管理页打磨

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/admin/customers/index.wxml`、`miniprogram/pages/admin/customers/index.wxss`、`miniprogram/pages/admin/customers/detail.wxml`、`miniprogram/pages/admin/customers/detail.wxss`。
- 修复：客户列表改为客户工作台大标题、客户检索卡、风险状态线客户卡、指标格、标签和备注短摘要；客户详情改为客户详情大标题、手机号卡、账款指标卡、后台备注编辑卡、最近订单、手机号绑定记录和备注修改记录分区。
- 隐私：客户详情手机号展示改为 `phoneMasked` 优先，避免有脱敏字段时仍优先渲染完整手机号；未新增付款截图、完整地址、退款账户、交易号或其他敏感字段。
- 保留：`searchNow`、`onKeyword`、`openDetail`、`load`、`onNoteInput`、`onTagInput`、`removeTag`、`addPresetTag`、`onRiskChange`、`save`、`clearNote` 等绑定均保留；未改 `getAccountSummary`、`getAdminCustomerDetail`、`updateCustomerAdminNote`、风险等级语义、备注清空确认、搜索、分页或页面路由；`finance` 角色仍被客户管理页拦截。
- 验证：客户列表/客户详情 JS 语法检查通过；对应 JSON 和 `project.config.json` 解析通过；WXML 标签检查通过；关键绑定检查通过；WXSS 大括号和 UTF-8 检查通过；客户详情手机号脱敏优先表达式检查通过。
- 部署：仅后台客户页面 WXML/WXSS 本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 法律页内联样式与圆角收口

- 范围：继续按附件 App Store-like 简洁层级收尾，处理五个法律说明页 WXML/WXSS、订单详情局部状态样式、后台首页指标胶囊和后台订单备注区域圆角。
- 修复：五个法律页的章节标题、小节标题、生效日期从 WXML 内联 `style` 收敛为 `legal-heading`、`legal-subheading`、`legal-footnote` 等 class；状态徽标改为胶囊，通知、输入和日志区域统一为更接近新版 UI 的圆角。
- 保留：法律页正文内容、页面路由、JS 生命周期、订单详情业务流程、后台订单备注保存/日志读取、后台首页统计数据来源均未修改；`profile` 的 12rpx 命中属于手绘图标，不作为卡片圆角问题处理。
- 验证：五个法律页 WXML 的 `style=` 计数为 0；残留小圆角扫描仅剩 `miniprogram/pages/profile/index.wxss` 的手绘图标；UTF-8 替换字符检查通过，后续还需微信开发者工具做真实视觉预览。
- 部署：仅前端 WXML/WXSS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 页面标题命名与窄屏显示收口

- 范围：继续清理 App Store-like 大标题体系里的旧命名，处理售后申请/详情、购物车、订单列表/详情、付款页、密码页、法律页和部分后台 hero 标题。
- 修复：页面级大标题从泛化 `title` 改为 `page-title`、`legal-title`、`card-title` 或对应业务标题类；后台发货、订单、商品、履约、发货单详情标题类补齐字号、字重、行高，不再依赖全局 `.title`；首页旧 `.header-copy .title` selector 改为 `.home-title`，并允许自然换行。
- 保留：所有按钮、picker、input、textarea、订单/售后/付款/发货/后台操作绑定和云函数调用均未修改；`product/detail.wxss` 的 `title-row` 是组合布局类，不属于全局标题依赖。
- 验证：WXML 精确 `class="title"` 计数为 0；`style=`、旧 `class="page"`、旧 `class="container"`、`class="card section"` 扫描无命中；残留 `.title` 仅为 `title-row` 组合类；残留小圆角仅为 `profile` 手绘图标。
- 部署：仅前端 WXML/WXSS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 底部导航样式折叠收口

- 范围：回到用户最初重点反馈的底部导航，处理 `miniprogram/custom-tab-bar/index.wxss` 和底部导航主题 token。
- 修复：将多轮追加形成的三段覆盖式 tabBar WXSS 折叠为单一最终样式，保留当前轻量浮动导航、选中胶囊、购物车角标、横屏安全区和宽屏居中规则；同步 `--tabbar-height` 为 98rpx、`--tabbar-shell-height` 为 140rpx。
- 保留：`custom-tab-bar/index.wxml`、`custom-tab-bar/index.js`、`switchTab`、`setSelected`、`setBadge`、管理员可见性判断、购物车角标逻辑和 tab 路由均未修改。
- 验证：custom tabBar JS 语法检查通过；tabBar WXSS 大括号和 UTF-8 检查通过；关键 selector 只保留一份最终定义，后续调试不再依赖历史覆盖块。
- 部署：仅前端 WXSS/token 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 首页满意版冻结记录

- 结论：用户确认当前商品首页截图“比较满意”，该版本作为首页主界面当前基准，不再继续压缩、重构或替换首页布局。
- 保留：`miniprogram/pages/index/index.wxml`、`miniprogram/pages/index/index.wxss`、`miniprogram/pages/index/index.js` 当前主页结构和交互不改；保留常购/新货/热销三选一、横向商品 rail、普通商品列表和当前浮动底部导航视觉。
- 占位检查：首页继续使用 140rpx tabBar 留白；购物车因存在固定结算栏继续保留 300rpx 留白，避免结算栏和底部导航互相遮挡。
- 验证：首页 JS、custom tabBar JS 语法检查通过；首页/custom tabBar JSON 解析通过；首页/custom tabBar WXML `view` 标签平衡；首页、custom tabBar、layout、theme、landscape WXSS 大括号和 UTF-8 检查通过；首页、custom tabBar、公共样式未命中 `style=`、精确 `class="title"`、旧 `class="page"`、旧 `class="container"`、`class="card section"`、`class="grid section"`。
- 部署：仅记录验收结论和文档，本次未改首页代码、未上传云函数、未发布小程序。

## 2026-07-09 非首页颜色 token 收口

- 范围：在首页已冻结的前提下，只处理非首页的低风险颜色一致性：`miniprogram/pages/admin/dashboard/index.wxss`、`miniprogram/pages/admin/product-analytics/index.wxss`、`miniprogram/pages/after-sale/apply.wxss`、`miniprogram/pages/profile/index.wxss`。
- 修复：后台首页残留的黑色主操作、黑色时间范围选中态和旧浅红警告色改为沙漠金/项目危险色 token；商品数据分析页选中态文字和错误边框统一；售后申请与我的页的小写白色统一为 `#FFFFFF`。
- 保留：未改首页；未改后台首页、商品数据分析、售后申请、我的页的 WXML/JS；未改权限、云函数、图表绘制、售后申请提交、个人资料、tabBar 或页面路由。
- 验证：四个页面 JS 语法检查通过；四个页面 JSON 和 `project.config.json` 解析通过；四个页面 WXML `view` 标签平衡；四个 WXSS 大括号和 UTF-8 检查通过；目标颜色扫描未再命中 `color: #fff`、`#ffffff`、`#fecaca`、`#fff7f7`、黑色主背景或黑色边框。
- 部署：仅前端 WXSS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 订单与退款颜色一致性收口

- 范围：继续在首页冻结前提下，处理目标扫描中剩余的小写白色：`miniprogram/pages/order/detail.wxss`、`miniprogram/pages/admin/orders.wxss`、`miniprogram/pages/admin/refunds/detail/index.wxss`。
- 修复：订单详情已付款徽标、取消按钮、后台订单已付款徽标和退款详情凭证删除按钮的文字颜色统一为 `#FFFFFF`。
- 保留：未改首页；未改订单详情、后台订单、退款详情的 WXML/JS；未改订单状态、付款状态、取消订单、退款处理、凭证上传/删除、权限、云函数或路由。
- 验证：三页 JS 语法检查通过；三页 JSON 和 `project.config.json` 解析通过；三页 WXML `view` 标签平衡；三页 WXSS 大括号和 UTF-8 检查通过；全 `miniprogram/pages`、`miniprogram/components`、`miniprogram/custom-tab-bar` 目标扫描未再命中 `color: #fff`、`#ffffff`、`#fecaca`、`#fff7f7`、黑色主背景或黑色边框。
- 部署：仅前端 WXSS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 全量静态验收补充

- 范围：按原始任务的回归测试要求，对当前本地小程序代码做全量静态验收；未调用 Figma，未改首页。
- 子智能体复核：复用已完成的只读审查结果，重点关注权限/业务边界、商品详情/购物车、发货履约、售后退款和商品数据分析；当前硬性问题已在主线程重新验证，地址页 `ui-empty` / `ui-skeleton` 组件注册在当前状态下已通过。
- 验证结果：`miniprogram` 下 61 个 JSON 与 `project.config.json` 解析通过；64 个 WXSS 大括号和 UTF-8 检查通过；`app.json` 中 51 个页面的 `.wxml/.js/.json/.wxss` 文件完整；51 个页面 WXML 的 `view` 标签平衡；80 个小程序 JS 文件 `node --check` 通过；51 个页面 WXML 事件绑定未发现缺失 JS 方法；51 个路由页根节点均已接入 `page-enter`，带横竖屏监听的页面根节点均有 `isLandscape/isWideScreen` 类。
- 组件注册：全量扫描 WXML 中的 `ui-*` 组件后，对应页面 JSON `usingComponents` 注册完整。
- 剩余风险：本地未运行微信开发者工具真实编译/真机预览；仍需手动检查首页冻结版、四个 tab 页底部遮挡、商品详情横屏、购物车结算栏、地址页、后台首页、商品数据分析、发货履约和售后退款关键状态。
- 部署：仅文档记录和本地静态验收，尚未上传云函数，尚未发布小程序。

## 2026-07-09 商品详情横屏决策面板收口

- 范围：在首页冻结前提下，处理 `miniprogram/pages/product/detail.wxml`、`miniprogram/pages/product/detail.wxss` 的横屏/宽屏布局细节。
- 修复：商品详情根节点新增 `product-detail-page` 专属类，避免横屏样式外溢；横屏商品图高度从 560rpx 收紧为 500rpx，宽屏保留 560rpx；横屏/宽屏右侧商品信息、数量、配送卡片改为紧凑垂直决策面板，卡片间距统一，减少横屏下信息被商品图挤压的风险。
- 保留：未改首页；未改商品详情 JS、云函数调用、商品读取、收藏、加购、数量、配送方式、地址选择、预下单、幂等、自动审核或页面路由；未新增真实库存、成本价、供应商、`internalTags` 展示。
- 验证：商品详情 JS 语法检查通过；`pages/product/detail.json` 和 `project.config.json` 解析通过；商品详情 WXML `view` 标签平衡且关键绑定 `toggleFavorite`、`changeQty`、`onQtyInput`、`onQtyBlur`、`onDeliveryTypeChange`、`chooseAddress`、`addAddress`、`addToCart`、`submitOrder`、`goShop` 均保留；商品详情 WXSS 大括号和 UTF-8 检查通过；敏感字段展示扫描未发现 WXML 直接展示真实库存、成本、供应商或 `internalTags`。
- 部署：仅前端 WXML/WXSS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 订单列表下一步提示收口

- 范围：在首页冻结前提下，处理 `miniprogram/pages/order/list.wxml`、`miniprogram/pages/order/list.wxss`、`miniprogram/pages/order/list.js` 的展示层层级。
- 修复：订单卡在金额摘要下新增紧凑“下一步”提示条，按现有 `orderFilter`、订单状态和付款状态派生展示文案；付款状态和“详情”行动继续保留在卡片底部，减少用户扫卡时只看到金额和标签、不知道下一步的断层。
- 保留：未改首页；未改 `getOrders` 调用参数、分页、缓存、下拉刷新、tabBar 同步、订单状态码、付款状态码、发货状态派生、云函数、权限或路由；未新增付款截图、交易号、完整地址、完整手机号、后台备注、风险标签等敏感字段展示。
- 验证：订单列表 JS 语法检查通过；`pages/order/list.json` 和 `project.config.json` JSON 解析通过；订单列表 WXML `view` 标签平衡且关键绑定 `selectOrderFilter`、`refreshOrders`、`goDetail` 均保留；订单列表 WXSS 大括号和 UTF-8 检查通过；订单列表改动文件敏感字段扫描通过。
- 部署：仅前端 WXML/WXSS/展示整形 JS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-09 首页关联入口列表收口

- 范围：在首页满意版冻结前提下，处理 `miniprogram/pages/favorite/index.wxml`、`miniprogram/pages/favorite/index.wxss`、`miniprogram/pages/frequent/index.wxml`、`miniprogram/pages/frequent/index.wxss`、`miniprogram/pages/recommend/list.wxml`、`miniprogram/pages/recommend/list.wxss`。
- 修复：收藏、常购和推荐列表统一为“频道大标题 + 右侧数量胶囊 + 列表分区标题 + 紧凑商品队列”的结构，让首页快捷入口和“查看更多”承接页保持同一套 App Store-like 信息层级。
- 保留：未改首页；未改三页 JS、`getFavoriteList`、`getFrequentPurchaseList`、`getRecommendProducts`、搜索、分类、排序、整卡详情、加购、收藏/取消收藏、分页、下拉刷新、云函数、权限或路由。
- 验证：收藏/常购/推荐列表 JS 语法检查通过；三页 JSON 和 `project.config.json` JSON 解析通过；三页 WXML `view` 标签平衡且关键绑定保留；三页 WXSS 大括号和 UTF-8 检查通过；改动 WXML/WXSS 敏感字段扫描通过。
- 部署：仅前端 WXML/WXSS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-10 售后详情进度层级收口

- 范围：继续按附件 App Store-like 信息层级，处理 `miniprogram/pages/after-sale/detail.wxml`、`miniprogram/pages/after-sale/detail.wxss`。
- 修复：售后详情顶部状态卡新增三段进度条和金额/原因指标格；申请内容、售后商品、审核信息、退货物流、时间线补齐分区标题和数量胶囊；待退货状态下物流填写区改为独立提示面板。
- 保留：未改首页；未改售后详情 JS、`getMyAfterSaleDetail`、`submitReturnLogistics`、售后状态、退款状态、金额字段、物流提交参数、日志读取、云函数、权限或路由。
- 验证：售后详情 JS 语法检查通过；`pages/after-sale/detail.json` 和 `project.config.json` JSON 解析通过；售后详情 WXML `view` 标签平衡且 `onInput`、`submitLogistics` 绑定保留；售后详情 WXSS 大括号和 UTF-8 检查通过；改动 WXML/WXSS 敏感字段扫描通过。
- 部署：仅前端 WXML/WXSS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-10 固定操作栏真实预览修复

- 范围：保持首页满意版冻结，处理 `pages/cart/index`、`pages/product/detail`、`pages/address/list`、`pages/admin/import/preview/index`、`pages/admin/orders`、`pages/admin/payment-methods/index` 六个包含固定操作区的页面根节点。
- 根因：根节点 `page-enter` 动画在结束后通过 `animation-fill-mode: both` 保留 `transform: translateY(0)`；这会改变后代 `position: fixed` 的定位上下文，导致购物车结算栏、商品详情操作栏等落到长页面底部而不是手机视口底部。
- 修复：六页根节点由带位移的 `page-enter` 改为只改变透明度的 `fade-in`；未修改固定栏尺寸、按钮、事件绑定、页面 JS、路由、权限或云函数。
- 真实预览：在微信开发者工具 Stable `v2.01.2510280`、iPhone 15 Pro 模拟器中确认首页仍为冻结版；四个主 tab 可切换且高亮同步；购物车修复前结算栏不可见，修复后“全选 / 合计 / 提交预订单”稳定显示在浮动 tabBar 上方；商品详情修复前底部操作栏不可见，修复后“加入购物车 / 立即预下单”稳定显示；最终调试器为 `Errors: 0`，保留的 warnings 为现有弃用/运行环境提示。
- 静态验证：六页仍包含各自 `position: fixed` 组件，根节点已全部移除 `page-enter` 并接入 `fade-in`；后续全量检查不再以“所有页面根节点必须是 `page-enter`”为条件，带固定后代的页面允许并应使用无位移根动画。
- 业务保护：未改首页；未改购物车计算、配送、地址、加购、预下单、导入、批量订单、支付方式保存或敏感字段展示；未触发提交、上传、删除或生产写操作。
- 部署：仅六个前端 WXML 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-10 付款页决策层级收口

- 范围：保持首页满意版冻结，处理 `miniprogram/pages/payment/payment.wxml`、`miniprogram/pages/payment/payment.wxss`；未修改付款页 JS、JSON、云函数或支付配置。
- 金额层级：付款页是单个订单入口，主金额由“账户待付合计”调整为“本订单待付”并展示 `account.unpaidText`；账户待付、历史未付、订单已付降为三项紧凑辅助指标，账户待确认仅在存在待确认金额且当前订单尚未进入待确认时显示。
- 方式选择：支付方式从卡片内再次嵌套小卡改为单列表，新增清晰的单选圆点和推荐标记；支付方式名称、类型、说明、额外提示、服务端选择动作和禁用状态均保留。
- 文案收口：首屏说明缩短为“核对本订单金额，选择一种付款方式”，未提交状态统一为“待付款”；线下付款仍明确提示凭证提交后由财务确认，不会自动标记为已付款。
- 真实预览：在微信开发者工具 Stable `v2.01.2510280`、iPhone 15 Pro 模拟器中从待付款订单真实进入付款页；首屏可同时看到本订单待付金额、三项账户摘要、一个可用付款方式和收款信息开头；向下滚动后二维码、预览按钮、上传截图、备注和提交按钮均无遮挡，调试器为 `Errors: 0`。
- 业务保护：保留 `getOrders`、`getAccountSummary`、`getEnabledPaymentMethods`、`selectOrderPaymentMethod`、`submitOfflinePaymentProof`、`createWechatPayOrder`、截图上传、预览、删除、复制、幂等和 `pending_confirm` 语义；未触发付款、上传凭证、复制敏感信息、修改支付配置或生产写操作。
- 验证：付款页 JS 语法检查通过；页面 JSON 与 `project.config.json` 解析通过；WXML `view` 标签 73/73、10 个事件绑定均可在 JS 中找到；WXSS 大括号 66/66、UTF-8 检查通过。当前环境仅有微信收款码一种可用方式，银行卡和微信原生支付分支完成静态保留检查，未做运行时切换。
- 部署：仅付款页 WXML/WXSS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-10 售后申请页表单压缩

- 范围：保持首页满意版冻结，处理 `miniprogram/pages/after-sale/apply.wxml`、`miniprogram/pages/after-sale/apply.wxss`；售后列表和详情页本轮只做真实/静态复核，未改代码。
- 结构压缩：原“确认订单、选择原因、说明问题、选择商品、填写金额、上传凭证”六张步骤卡压缩为“订单摘要、申请信息、售后范围、问题凭证”四个区块；不再使用步骤胶囊描述操作流程。
- 去重：订单号只显示一次；订单金额、已付金额、已退金额改为三列摘要，可退金额保留为右侧主指标；移除五行重复订单金额明细。
- 表单合并：售后类型、售后原因、详细原因和客户备注合并到申请信息区；售后商品和申请退款金额合并到售后范围区；所有原字段、默认值和输入绑定保留。
- 真实预览：从真实已付款订单进入申请页，iPhone 15 Pro 首屏由原先仅显示前三个步骤调整为可同时看到订单摘要、申请信息和售后范围开头；下半页可在同屏看到商品、退款金额、问题凭证和提交区，无遮挡、无文本溢出；最终调试器为 `Errors: 0`。
- 列表/详情边界：从个人中心真实进入“我的售后”，当前账号为 0 条记录，空状态、大标题和数量胶囊正常；由于没有现成售后记录，无法运行时打开详情页，详情页继续保留此前 JS、WXML、WXSS 静态验证结论。
- 业务保护：保留 `getOrders`、售后类型/原因选项、最少原因字数、商品选择、申请数量、退款金额上限、最多 6 张凭证、`createAfterSaleRequest`、图片上传和幂等逻辑；未触发上传、提交、退款或生产写操作。
- 验证：申请页 JS 语法检查通过；页面 JSON 与 `project.config.json` 解析通过；WXML `view` 标签 58/58、8 个事件绑定均可在 JS 中找到、订单号表达式仅 1 处；WXSS 大括号 55/55、UTF-8 检查通过；页面 WXSS 已清理本次触发警告的标签选择器。
- 部署：仅售后申请页 WXML/WXSS 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-10 地址操作区收口

- 范围：保持首页满意版冻结，处理 `miniprogram/pages/address/list.wxml`、`miniprogram/pages/address/list.wxss`、`miniprogram/pages/address/edit.wxml`；未修改地址 JS、JSON、云函数或地址数据。
- 真实问题：地址卡三个按钮受小程序按钮默认宽度影响，“删除”被挤到第二行；默认地址仍显示不可用的“设为默认”，编辑页也重复显示同一操作。
- 修复：地址卡操作按钮改为同排等宽弹性布局；默认地址仅显示“编辑 / 删除”，非默认地址保留“编辑 / 设为默认 / 删除”；编辑默认地址时隐藏“设为默认地址”。
- 真实预览：在个人中心进入地址列表，iPhone 15 Pro 中真实默认地址的手机号继续显示掩码，地址卡两项操作同排，固定“新增收货地址”稳定显示在安全区上方；进入编辑页后表单字段完整，默认地址只显示保存和删除，调试器为 `Errors: 0`。
- 业务保护：保留 `getMyAddresses`、`selectedShippingAddress`、选择模式、编辑、新增、设为默认、删除确认、保存、返回层级和默认地址自动管理语义；未点击保存、设为默认、删除或新增，未产生地址写操作。
- 验证：地址列表/编辑页 JS 语法检查通过；两页 JSON 与 `project.config.json` 解析通过；列表 WXML `view` 19/19、WXSS 24/24、6 个事件绑定通过；编辑页 WXML `view` 28/28、WXSS 19/19、6 个事件绑定通过；UTF-8、手机号脱敏优先表达式和默认操作条件检查通过。
- 部署：仅地址列表 WXML/WXSS、地址编辑 WXML 和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-10 账号操作页信息密度收口

- 范围：保持首页满意版和底部导航冻结，处理 `miniprogram/pages/profile/bind-phone.wxml`、`miniprogram/pages/profile/bind-phone.wxss`、`miniprogram/pages/profile/bind-phone.js`、`miniprogram/pages/profile/bind-phone.json`、`miniprogram/pages/login/password.wxml`、`miniprogram/pages/login/password.wxss`。
- 手机号页：原“当前状态 / 微信授权 / 手动填写”三张卡合并为“动态页头 + 当前号码行 + 单一绑定方式面板”；微信授权保留为主操作，手动号码输入和提交同排，已绑定用户的页面大标题及导航标题动态显示“更换手机号”。
- 密码页：保留页面级“设置密码 / 修改密码”标题，移除卡片内重复标题、模式胶囊和重复说明；表单改为带字段标签的紧凑单卡，首次设置显示两项，修改状态显示原密码、新密码、确认新密码三项。
- 即时展示：两个页面移除根节点位移动画，避免进入账号操作页时先出现整页空白；未改变页面生命周期、横竖屏判断或表单数据。
- 业务保护：保留 `onGetPhoneNumber`、`submitManual`、`bindPhoneByWechat`、`bindPhoneManual`、`confirmChangeIfNeeded`、密码长度/一致性/原密码校验、`setPassword`、`changePassword` 和成功后返回逻辑；手机号 JS 仅增加基于 `phoneMasked` 的导航标题派生。未触发微信授权、号码提交、密码保存或生产写操作。
- 真实预览：在微信开发者工具 Stable `v2.01.2510280`、iPhone 15 Pro 模拟器中确认已绑定手机号状态、首次设置密码状态和修改密码状态均可在首屏完整显示，输入框、按钮、长标题无溢出或重叠；最终调试器为 `Errors: 0, Warnings: 29`，问题面板为 0，warnings 为现有弃用和模拟器环境提示。
- 验证：两页 JS 语法检查通过；页面 JSON 与 `project.config.json` 解析通过；两页 WXML 的 `view`、`button`、`input` 标签平衡，`onGetPhoneNumber`、`onPhoneInput`、`submitManual`、`onOldPasswordInput`、`onPasswordInput`、`onConfirmPasswordInput`、`submit` 绑定均可在 JS 中找到；两页 WXSS 大括号和 UTF-8 检查通过。
- 部署：仅前端账号页面和文档本地修改，尚未上传云函数，尚未发布小程序。

## 2026-07-11 四个主 Tab 参考图续优化

- 范围：用户通过新一轮明确请求重新开放此前冻结的商品首页，并同时优化购物车、订单列表、“我的”、共享样式、空状态和 `custom-tab-bar`。本轮改动只涉及 `miniprogram/` 的 WXML/WXSS 与本文档，不包含 JS、JSON、`app.json`、路由或云函数。
- 参考图映射：图 1 -> 首页标题/快捷入口/搜索/推荐/商品队列；图 2 -> 购物车清单/配送/地址/结算；图 3 -> 订单筛选/摘要卡/下一步；图 4 -> 用户资料/服务入口/设置列表。未复制 VIP、企业认证、参考图示例商品、虚构分类、假订单操作或参考图中的敏感身份信息。
- 共享系统：新增深墨 action、可读标签与 tabBar token，补充 `.btn-dark`，统一暖白卡面、细边框、低阴影、红棕金额、沙金选择态和红色角标；空状态主 CTA 改为高对比深墨按钮；全局加入 `prefers-reduced-motion` 和 skeleton fallback。
- 首页：清理历史覆盖层，保留真实动态分类、常购/新货/热销、搜索联想、推荐横轨与完整商品列表；提高快捷入口与搜索操作的点击热区，保留收藏、详情、加购和购物车入口；按用户确认将推荐频道恢复为旧版三段式胶囊，推荐卡恢复浅金圆形 `+`，完整商品列表恢复浅金长胶囊 `+ 加购`。
- 购物车：保留全部选择、删除、数量输入、不可用/改价、配送、自提、脱敏地址、幂等提交；勾选与 radio 改为更深沙金，提交操作达 88rpx；宽屏使用商品主栏 + 结算侧栏，并对卡片图片列、文字、金额和数量器做防碰撞处理。
- 订单：保留 `summaryOnly: true`、动态 `orderFilters`、分页与真实状态；筛选操作达 88rpx，灰色状态标签加深；超宽屏双列补齐 `display: grid`，摘要改为金额在上、种类/数量在下，避免真实长单号和金额碰撞。
- “我的”：仅突出真实昵称和脱敏手机号，不再显示 `openidSuffix`；保留昵称编辑、手机号管理、订单/地址/售后、条件后台入口、密码、五项协议和退出；刷新按钮固定为 88rpx 正圆，底部内容可完整滚动越过 tabBar。
- 底部导航：保持四个既有路由、选中态和购物车角标合同；按用户最新确认改为暖色毛玻璃，使用 `rgba(255, 253, 249, 0.86)`、单层 `blur(26rpx) saturate(135%)`、暖白实色回退、浅金沙选中面和红色角标，保留安全区、真实数量和 `99+`。
- 性能与动效：未引入新依赖或远程资源；继续使用现有缓存、请求和生命周期；动效只保留短促进入/按压反馈，并为 reduced-motion 关闭位移、过渡和 skeleton shimmer。
- 业务与安全：未改商品、购物车、下单、付款、发货、退款、账款、地址、权限或脱敏语义；未新增真实库存、成本、供应商、`internalTags`、后台备注、风险原因、完整手机号/地址、付款截图或交易号展示。
- 运行时验证：微信开发者工具 Stable `v2.01.2510290` 已检查 iPhone 15 Pro 竖屏、iPad 和 iPad Pro 12.9-inch；最新一轮重新编译后，常购/新货/热销三段胶囊可实际切换，推荐卡浅金圆形 `+`、完整商品列表浅金长胶囊 `+ 加购`、毛玻璃底栏和真实角标 `4` 均正常显示；宽屏按钮规则已移除旧 `88rpx` 裁切。首页、购物车、订单和个人页均能加载，固定结算栏/tabBar 无结构性遮挡。最后读取为 `Errors: 0`、问题面板 0；warnings 为环境/弃用提示，数量会随页面加载变化。
- 仍需真机：软键盘弹出后的搜索面板、极端系统字体、低端机 reduced-motion/动画表现以及真实物理横屏安全区仍应在真机补验；数量 stepper 视觉尺寸保持参考稿要求的 56rpx，并通过透明伪元素将加减按钮热区扩展到 88rpx。
- 部署：无需上传云函数；前端只需在微信开发者工具重新编译/预览。当前尚未上传云函数、尚未发布小程序，也未执行任何生产写操作。
