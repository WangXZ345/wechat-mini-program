# Figma UI 设计规范：美妆批发小程序 App Store 风格优化

本文件是本轮 UI / UX 优化的唯一设计源。后续 WXML、WXSS、页面内非业务交互 JS、公共样式、自定义 tabBar、动效和 Figma 交付说明，都必须以本文件为准。

## 1. 设计目标

本轮目标是将当前美妆批发订货微信小程序，从普通电商列表感升级为更成熟的 App Store-like 高级应用界面。参考附件中的 App Store 页面结构：大标题、横向胶囊频道、精选大卡片、清晰列表层级、轻盈浮动底部导航和克制动效。

整体不能照抄 App Store 蓝色体系、图标、图片和内容资产，必须保持项目现有的沙漠金、奶油白、高级圆角、轻奢商务风格。业务目标不变，不新增业务功能，不改变云函数、权限、订单、库存、付款、退款、发货和售后流程。

## 2. 参考图拆解

参考图的高级感主要来自信息层级，而不是单纯圆角或阴影。页面节奏是：

1. 超大标题建立一级入口。
2. 横向胶囊承载分类。
3. 精选大卡片承载重点内容。
4. 列表行承载高频浏览与操作。
5. 浮动底部导航提供稳定主入口。

可以借鉴：

- 大标题和副标题的层级。
- 横向滚动胶囊频道。
- 精选大卡片与列表区分。
- 大留白和清晰分区。
- 浮动底部导航的轻盈感。
- 页面进入、按钮按压、弹窗出现的克制动效。

不能照抄：

- 不照抄 App Store 蓝色主色。
- 不照抄参考图中的图标、图片、栏目文案和商店内容。
- 不把小程序改成娱乐内容流。
- 不隐藏关键业务状态来追求视觉简洁。
- 不使用过重毛玻璃、强阴影、大面积冷色渐变或夸张弹跳动画。
- 不新建第二套 tabBar 或替代现有页面路径。

## 3. 设计原则

1. 大标题优先：一级页面首屏使用 56rpx-72rpx 大标题建立层级，副标题控制在 26rpx-30rpx。
2. 信息分区清楚：推荐、新货、热销、常购、后台待办、统计指标都按频道分区，不把所有内容塞进同一种卡片。
3. 横向滑动承载精选内容：精选商品、频道胶囊、后台统计卡片可横向滚动，纵向保留主流程。
4. 大卡片负责推荐感：首页精选卡片使用稳定图片比例，圆角大，阴影轻，图片不拉伸。
5. 胶囊标签负责筛选：未选中态柔和，选中态沙漠金填充，支持横向滚动。
6. 浮动底部导航：继续复用 `custom-tab-bar`，不新增第二套 tabBar；普通用户和超级管理员显示前台 tabBar，客服、财务、采购保持原权限规则。
7. 后台要像工作台：后台页面更密集、清晰、可扫描，避免营销式页面。
8. 动效轻量：160ms-280ms，fade、slide、scale 为主，不做夸张弹跳。
9. 横竖屏都可用：竖屏单列为主，横屏/宽屏使用 2-4 列网格，但不能影响竖屏。
10. 不破坏业务逻辑：UI 只改变视觉、布局和非业务交互反馈，不改变状态流转、字段含义、权限判断和接口返回。

## 4. Design Tokens

### 4.1 色彩

```js
const DESIGN_TOKENS = {
  color: {
    pageBg: "#F8F4ED",
    pageBgDeep: "#F3E9DA",
    cardBg: "#FFFDF9",
    cardBgWarm: "#FCF7EF",
    primary: "#B99C74",
    primaryDeep: "#9A856B",
    primaryActive: "#A8793A",
    primaryLight: "#C7AE8B",
    secondaryBg: "#EFE6DA",
    searchBg: "#FFFCF7",
    border: "#E6D8C7",
    borderLight: "#F0E5D7",
    tagBg: "#F3E7D6",
    tagText: "#8A6A43",
    textMain: "#1F1A15",
    textSecondary: "#82776B",
    textMuted: "#A79B8B",
    price: "#9A2D2D",
    success: "#5E7C58",
    successBg: "#E9F0E1",
    warning: "#B7793A",
    warningBg: "#FFF7EA",
    danger: "#A94442",
    dangerBg: "#F6E5DE",
    white: "#FFFFFF",
    overlay: "rgba(31, 26, 21, 0.36)"
  },
  radius: {
    xs: "8rpx",
    sm: "12rpx",
    md: "20rpx",
    lg: "28rpx",
    xl: "36rpx",
    xxl: "48rpx",
    pill: "999rpx"
  },
  motion: {
    press: "120ms",
    fast: "160ms",
    normal: "220ms",
    slow: "280ms",
    easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
    easeInOut: "cubic-bezier(0.4, 0, 0.2, 1)"
  }
}
```

### 4.2 字体与字号

- 页面大标题：60rpx，font-weight 800，line-height 1.12。
- 页面副标题：28rpx，font-weight 400，line-height 1.45。
- 分区标题：38rpx，font-weight 800，line-height 1.25。
- 卡片标题：32rpx，font-weight 700，line-height 1.35，最多 2 行。
- 正文：28rpx，font-weight 400，line-height 1.55。
- 辅助文字：24rpx，font-weight 400，line-height 1.45。
- 标签文字：22rpx，font-weight 600。
- 金额/价格：34rpx-42rpx，font-weight 800，颜色 `price`。
- 后台统计数字：44rpx-56rpx，font-weight 800。

### 4.3 间距

- 页面左右边距：24rpx，宽屏最大内容宽度 1400rpx。
- 大标题底部间距：28rpx。
- 分区上下间距：32rpx。
- 卡片内边距：24rpx；后台密集卡片可用 20rpx。
- 横向频道间距：16rpx。
- 商品卡片网格间距：20rpx。
- 底部 tabBar 页面安全留白：168rpx + safe-area-inset-bottom。
- 浮动结算栏页面留白：176rpx + safe-area-inset-bottom。

### 4.4 圆角

- xs：8rpx，用于细小图标底、输入框内部。
- sm：12rpx，用于小按钮、状态徽章。
- md：20rpx，用于普通卡片、搜索框。
- lg：28rpx，用于商品卡片、订单卡片。
- xl：36rpx，用于精选大卡、弹窗、浮动条。
- xxl：48rpx，用于首屏大卡、浮动底部导航。
- pill：999rpx，用于胶囊、圆形按钮。

### 4.5 阴影

- card：`0 12rpx 32rpx rgba(142, 116, 86, 0.10)`。
- soft：`0 8rpx 20rpx rgba(142, 116, 86, 0.08)`。
- float：`0 20rpx 48rpx rgba(142, 116, 86, 0.16)`。
- button：`0 10rpx 22rpx rgba(142, 116, 86, 0.18)`。
- tabBar：`0 -8rpx 28rpx rgba(120, 95, 62, 0.08)`。
- 禁止使用重阴影堆叠；同一屏中最多 2 层明显 elevation。

### 4.6 卡片规格

- 精选大卡：宽 620rpx，图片区高 330rpx-380rpx，圆角 36rpx，padding 24rpx。
- 横向商品小卡：宽 260rpx-300rpx，图片比例 1:1，圆角 28rpx。
- 普通商品列表卡：双列时单卡宽 `calc((100% - 20rpx) / 2)`，单列时通栏。
- 订单卡：通栏，圆角 28rpx，padding 24rpx，状态徽章置顶右。
- 后台统计卡：最小宽 220rpx，高 150rpx，横屏 3-4 列。
- 图表卡：最小高度 360rpx，padding 24rpx，圆角 28rpx。

### 4.7 按钮规格

- 主按钮：高度 88rpx，圆角 999rpx，背景 `primaryDeep`，文字 30rpx/700。
- 次按钮：高度 76rpx，圆角 999rpx，背景 `secondaryBg`，文字 `primaryDeep`。
- 小按钮：高度 56rpx，padding 0 24rpx，圆角 999rpx，文字 24rpx/700。
- 危险按钮：背景 `dangerBg`，文字 `danger`，不使用大面积纯红。
- 按压态：scale 0.97，opacity 0.86，duration 120ms。

### 4.8 状态色

- 成功：`success` + `successBg`，用于已付款、已完成、已启用。
- 警告：`warning` + `warningBg`，用于待审核、待确认、库存预警。
- 危险：`danger` + `dangerBg`，用于不可用、拒绝、退款风险。
- 信息：`primaryDeep` + `tagBg`，用于普通状态、筛选选中和后台提示。

## 5. 页面设计规范

### 5.1 商品首页 `pages/index/index`

- 页面目标：从普通商品列表升级为 App Store-like 商品发现页。
- 信息层级：大标题“商品”/欢迎语；用户头像或身份入口；搜索框；横向分类胶囊；今日精选大卡；新货、热销、常购横向频道；普通商品列表。
- 卡片结构：精选大卡突出图片、标题、标签、价格；横向小卡只展示核心商品名、标签和价格；普通列表卡承载加购和收藏。
- 主要组件：大标题、搜索框、胶囊频道、商品大卡、商品小卡、商品列表卡、空状态、骨架屏。
- 横屏适配：主内容最大 1400rpx；精选与频道可左右分栏，普通商品列表 3 列。
- 动效设计：页面 fade + translateY 16rpx；精选大卡 220ms；横向卡片 stagger 24ms。
- 不允许改变：搜索条件、商品详情跳转、加购、库存展示规则、普通用户敏感字段隐藏。

### 5.2 商品详情 `pages/product/detail`

- 页面目标：突出商品质感和下单决策，不暴露后台敏感信息。
- 信息层级：商品图；商品名；价格；可见标签；购买数量；业务说明；操作区。
- 卡片结构：首卡展示图片和核心信息，次卡展示规格、说明、配送和售后规则。
- 主要组件：商品 hero 图、信息卡、规格网格、数量 stepper、地址选择卡、底部操作栏。
- 横屏适配：图片左侧 40%-48%，信息右侧 52%-60%，底部操作栏不遮挡内容。
- 动效设计：图片/首卡 fade-up 220ms；按钮 press scale 120ms。
- 不允许改变：真实库存、成本价、供应商、`internalTags`、后台备注不得给普通用户展示。

### 5.3 购物车 `pages/cart/index`

- 页面目标：清晰展示商品行、数量操作和浮动结算。
- 信息层级：大标题；商品行列表；配送/地址信息；浮动结算栏。
- 卡片结构：商品图 128rpx；商品名最多 2 行；价格、数量控件、异常状态分层。
- 主要组件：购物车商品行、勾选控件、数量 stepper、地址选择卡、浮动结算栏。
- 横屏适配：商品列表与结算信息双列，结算栏固定在右侧或底部。
- 动效设计：结算栏 slide-up + fade 220ms；数量按钮只做 120ms press。
- 不允许改变：数量换算、地址选择、提交预订单流程、金额按分存储规则。

### 5.4 订单列表 `pages/order/list`

- 页面目标：让用户快速识别订单状态和下一步操作。
- 信息层级：大标题；状态筛选胶囊；订单卡列表；空状态。
- 卡片结构：订单号/时间；状态徽章；商品摘要；金额；下一步提示；主次操作。
- 主要组件：状态胶囊、订单卡、下一步提示条、付款状态徽章、合并发货提示。
- 横屏适配：订单卡 2 列，宽屏 3 列，状态筛选保持横向滚动。
- 动效设计：卡片 fade-up，列表长滚动不重复触发重动画。
- 不允许改变：订单状态、付款入口、售后入口、取消规则。

### 5.5 订单详情 `pages/order/detail`

- 页面目标：突出当前进度和可执行下一步。
- 信息层级：进度主卡；商品明细；付款/发货/售后模块；地址与备注。
- 卡片结构：当前进度卡放顶部，状态徽章清晰；操作按钮主次分明。
- 主要组件：状态步骤、商品明细卡、付款卡、发货卡、售后入口、确认弹窗。
- 横屏适配：主进度与商品明细左侧，辅助信息右侧。
- 动效设计：进度卡 220ms fade-up；弹窗 180ms scale + fade。
- 不允许改变：付款确认、发货、售后、取消、合并发货相关业务逻辑。

### 5.6 我的页面 `pages/profile/index`

- 页面目标：作为身份、订单、常购、收藏、后台入口集合。
- 信息层级：用户信息卡；常用入口；账号绑定；后台入口；法律与设置。
- 卡片结构：用户卡更轻，入口用 icon + 文案行，不堆大卡。
- 主要组件：用户资料卡、后台入口卡、常用操作网格、协议列表。
- 横屏适配：入口卡 2-3 列。
- 动效设计：入口卡轻微 fade-up；不对登录状态切换做重动画。
- 不允许改变：客服、财务、采购、超级管理员入口权限判断。

### 5.7 登录页 `pages/login/index` / `pages/login/password`

- 页面目标：干净可信，降低登录操作干扰。
- 信息层级：品牌/系统名；登录卡；协议提示；辅助入口。
- 卡片结构：登录卡宽 640rpx 内，圆角 36rpx，背景 `cardBg`。
- 主要组件：标题、输入框、主按钮、协议勾选、错误提示。
- 横屏适配：卡片居中，最大宽度 720rpx。
- 动效设计：登录卡 fade + translateY 16rpx，220ms。
- 不允许改变：登录方式、授权、手机号绑定、协议确认逻辑。

### 5.8 后台首页 `pages/admin/dashboard/index`

- 页面目标：成熟管理工作台，不是营销首页。
- 信息层级：工作台大标题；当前角色说明；今日待办；业务分组菜单；数据概览。
- 卡片结构：待办卡横向/网格；菜单按订单履约、商品库存、财务账款、系统配置分组。
- 主要组件：角色说明、时间筛选胶囊、统计卡、业务菜单卡、待办列表、榜单卡。
- 横屏适配：统计卡 4 列，业务菜单 3-4 列；宽屏最大 1400rpx。
- 动效设计：菜单卡 fade + translateY 12rpx，stagger 最大 120ms。
- 不允许改变：角色菜单可见范围、权限点、敏感数据返回和展示规则。

### 5.9 商品管理 `pages/admin/products`

- 页面目标：高密度管理商品，但信息不拥挤。
- 信息层级：标题；筛选/搜索；商品列表；编辑表单。
- 卡片结构：管理卡展示商品名、标签、价格、状态、操作按钮。
- 主要组件：搜索框、筛选胶囊、商品管理卡、编辑弹层、批量工具按钮。
- 横屏适配：筛选区左，列表右；或列表 2 列。
- 动效设计：筛选胶囊 160ms；编辑弹层 180ms。
- 不允许改变：商品字段、上下架、标签、推荐、兼容旧字段逻辑。

### 5.10 库存管理 `pages/admin/inventory`

- 页面目标：快速识别库存预警和可操作项。
- 信息层级：标题；筛选；库存卡/列表；批量操作区。
- 卡片结构：库存状态徽章、可售数量、预警状态分层显示。
- 主要组件：库存列表、状态徽章、预警标识、操作按钮。
- 横屏适配：筛选固定左侧，列表右侧。
- 动效设计：列表不做重动画；状态变化只做颜色过渡 160ms。
- 不允许改变：库存真实值只在有权限后台展示，普通用户不可见。

### 5.11 付款审核 `pages/admin/orders` / 付款相关后台

- 页面目标：财务快速识别待确认、部分付款、异常付款。
- 信息层级：状态筛选；待确认列表；付款截图入口；操作按钮。
- 卡片结构：金额突出，截图入口受权限控制，交易号等敏感字段不进入普通列表。
- 主要组件：付款状态徽章、金额卡、付款截图入口、确认弹窗。
- 横屏适配：列表与详情/操作区分栏。
- 动效设计：确认弹窗 scale + fade 180ms。
- 不允许改变：线下付款上传后进入 `pending_confirm`，不得改成直接 `paid`。

### 5.12 发货管理 `pages/admin/delivery/index` / `pages/admin/shipments/index`

- 页面目标：清晰处理待发货、合并发货、发货详情。
- 信息层级：状态筛选；发货组卡；订单摘要；操作区。
- 卡片结构：物流/收货信息默认脱敏，完整信息仅权限内显示。
- 主要组件：发货状态卡、订单摘要、物流信息区、合并发货提示。
- 横屏适配：发货组列表 2 列，详情页左右分栏。
- 动效设计：操作弹窗 180ms；列表不做重复入场动画。
- 不允许改变：合并发货、发货状态、地址权限和导出规则。

### 5.13 售后退款 `pages/after-sale/*` / `pages/admin/after-sales/*` / `pages/admin/refunds/*`

- 页面目标：明确流程状态，减少误操作。
- 信息层级：售后状态；原因；商品；金额；凭证；审核/退款操作。
- 卡片结构：状态徽章放顶部；危险操作使用低饱和红色按钮。
- 主要组件：状态卡、原因卡、凭证卡、审核操作区、危险确认弹窗。
- 横屏适配：详情左，操作右。
- 动效设计：状态卡 fade-up；危险确认弹窗 180ms。
- 不允许改变：客服不能最终退款，财务退款权限保持不变。

### 5.14 商品数据分析 `pages/admin/product-analytics/index`

- 页面目标：让采购/管理员快速看商品趋势。
- 信息层级：商品选择卡；指标摘要；销量折线图；成交均价折线图；报价变化折线图。
- 卡片结构：图表卡背景 `cardBg`，高度至少 360rpx，标题和更新时间明确。
- 主要组件：商品选择卡、时间胶囊、指标摘要卡、图表卡、空状态。
- 横屏适配：摘要卡 3-4 列，图表 2 列。
- 动效设计：图表加载 fade-in 220ms，不做复杂路径动画。
- 不允许改变：采购只能看商品分析相关数据，不能看到付款、退款、客户账款。

### 5.15 法律页面 `pages/legal/*`

- 页面目标：可读、可信、无营销装饰。
- 信息层级：大标题；更新时间；正文分节。
- 卡片结构：正文卡 padding 32rpx，行高 1.7。
- 主要组件：标题、更新时间、正文分节、返回入口。
- 横屏适配：正文最大宽度 960rpx 居中。
- 动效设计：只使用页面进入动画。
- 不允许改变：协议文本含义和确认流程。

## 6. 组件规范

| 组件 | 尺寸与样式 | 状态与交互 |
| --- | --- | --- |
| 大标题 | 60rpx/800，底部 8rpx 副标题 28rpx | 首屏出现 220ms fade-up |
| 横向频道栏 | 高 72rpx，左右 padding 24rpx，间距 16rpx | 选中胶囊背景 `primaryDeep`，文字白色 |
| 搜索框 | 高 80rpx，圆角 999rpx，背景 `searchBg`，边框 `borderLight` | focus 边框 `primaryLight` |
| 商品大卡 | 宽 620rpx，高 420rpx，圆角 36rpx，shadow card | 点击 scale 0.985 |
| 商品小卡 | 宽 280rpx，图片 280rpx 方形，圆角 28rpx | 加购按钮 56rpx |
| 订单卡片 | 通栏，padding 24rpx，圆角 28rpx | 状态徽章右上，操作按钮底部右对齐 |
| 购物车商品行 | 图 128rpx，行内 padding 24rpx | 数量 stepper 高 56rpx |
| 后台菜单卡片 | min-height 144rpx，圆角 28rpx | active scale 0.98 |
| 数据统计卡 | min-width 220rpx，高 150rpx | 数字 44rpx-56rpx |
| 图表卡片 | min-height 360rpx，padding 24rpx | loading fade-in |
| 胶囊标签 | 高 60rpx，padding 0 24rpx，圆角 999rpx | 选中/未选中 160ms 过渡 |
| 主按钮 | 高 88rpx，圆角 999rpx，背景 `primaryDeep` | active scale 0.97 |
| 次按钮 | 高 76rpx，背景 `secondaryBg` | 文字 `primaryDeep` |
| 危险按钮 | 高 76rpx，背景 `dangerBg` | 二次确认，不用纯红大面积 |
| 状态徽章 | 高 44rpx，padding 0 16rpx，圆角 999rpx | success/warning/danger/info |
| 输入框 | 高 80rpx，圆角 20rpx，背景 `searchBg` | focus 边框加深 |
| 弹窗 | 宽 640rpx 内，圆角 36rpx，padding 32rpx | scale 0.96 -> 1 |
| 空状态 | 图标 120rpx，标题 30rpx，说明 26rpx | 只做轻 fade |
| 骨架屏 | 圆角 20rpx，暖色 shimmer | 1.4s 循环，低对比 |
| toast/loading | 背景深色 0.86 alpha，圆角 20rpx | 不遮挡关键按钮超过必要时间 |

## 7. 动画规范

1. 页面进入：`opacity: 0 -> 1`，`translateY(20rpx) -> 0`，220ms，easeOut；包含 fixed 操作栏的页面使用纯 fade，进入动画结束后不得保留根节点 transform。
2. 卡片进入：fade-up，延迟按 index 24ms 递增，最大 120ms。
3. tab 选中：胶囊背景 scale 0.94 -> 1，opacity 0 -> 1，160ms。
4. 按钮按压：scale 0.97，opacity 0.86，120ms。
5. 商品卡片按压：scale 0.985，120ms，不影响列表滚动。
6. 弹窗：overlay fade 160ms，content scale 0.96 -> 1，180ms。
7. 底部结算栏：translateY 24rpx -> 0，opacity 0 -> 1，220ms。
8. 骨架屏：暖色 shimmer 1.4s，无明显闪烁。
9. 图表加载：容器 fade-in 220ms，禁止复杂路径绘制动画。
10. 禁止场景：搜索输入、高频数量加减、长列表滚动、后台分页、云函数请求完成批量动画。

## 8. 权限与业务保护条款

本轮 UI 重做只允许改变视觉、布局、动效和页面内非业务交互，不允许改变云函数、数据库集合、业务字段、状态码、订单/付款/退款/库存流转、页面路径和 tabBar 路由。

### 8.1 角色边界

- 普通用户只能访问前台页面，不得显示任何 `pages/admin/*` 后台入口、后台统计卡片、后台操作按钮或后台字段。
- 普通用户和 `super_admin` 可以显示前台 tabBar；`customer_service`、`finance`、`procurement` 不显示前台 tabBar，默认进入后台工作台。
- 采购只能看到商品、库存、报价导入、标签、推荐、商品分析相关入口；不得看到付款审核、退款记录、客户账款、客户欠款、付款截图、退款账户、支付配置和财务统计。
- 财务只能围绕付款、退款、账款、对账和财务导出工作；不得显示库存修改、库存导入、库存预警设置、商品上下架等库存/商品维护操作。
- 客服只能处理订单沟通、客户基础信息、备注、售后审核/流转等客服相关事项；不得显示最终退款、微信退款、退款打款确认等终态退款操作。
- `super_admin` 保持完整权限，但 UI 重做不得扩大其他角色权限。

### 8.2 敏感字段保护

- 普通用户前台不得展示真实库存、成本价、供应商、`internalTags`、后台备注、管理员标签、风险等级、付款截图地址、交易号、完整手机号、完整地址。
- 商品前台只能展示业务允许的可购状态、价格、公开标签和脱敏信息；库存只能用泛化文案，不显示精确数量。
- Figma 设计稿和文档示例数据不得使用真实手机号、真实地址、付款截图 URL、`openid`、银行卡号、退款账户或客户隐私。

### 8.3 后台数据卡片保护

- 后台首页、统计卡片、横向数据区和图表必须按权限渲染。
- 采购视角不得出现销售额、今日订单数、已付、未付、客户欠款、退款金额、付款截图数量等财务指标。
- 财务视角不得出现可直接修改库存、导入库存、设置预警库存的快捷操作。
- 任何设计稿中的“数据概览”必须标明对应权限，不得用统一卡片模板绕开权限判断。

### 8.4 路由与云函数稳定性

- 不新增、不重命名、不删除现有页面路径；`app.json` 中现有路由和 tabBar `pagePath` 必须保持兼容。
- 原则上不修改云函数；如发现 UI 需求必须触碰云函数，先单独报告，不直接改。
- 不新增绕过鉴权的前端直连数据库写入；下单、付款、退款、账款、库存等核心写入仍必须走云函数。
- 权限控制不能只依赖前端隐藏，必须继续以云函数鉴权和返回字段整形为准。

### 8.5 实现验收门槛

- 每轮 UI 实现后必须检查普通用户、客服、财务、采购、超级管理员五类视角。
- 必须确认采购看不到付款/退款/账款，财务不能改库存，客服不能最终退款，普通用户看不到后台和敏感字段。
- 必须确认云函数未被修改，页面路径未被破坏，前台 tabBar 可见性规则未被破坏。

## 9. Figma 交付规范

Figma 文件名称：`美妆批发小程序 App Store 风格优化`

当前 Figma 状态：

- 状态：未生成真实 Figma 页面稿。
- 实测：`whoami` 可正常返回账号计划；当前仅检测到一个 Starter 计划，没有可自动切换的其他团队/组织计划；历史测试中 `create_new_file` 可创建测试文件 `MCP 权限测试 - 可删除`（fileKey: `X9iOmTyBZyZLRNv5XAPB6Q`）。
- 阻塞点：对新测试文件执行最小 `use_figma` 写入时，Figma MCP 返回 Starter 计划调用上限拦截；本轮再次测试 `get_metadata` 只读元数据调用，也被同一个 Starter MCP 调用上限拦截。
- 2026-07-09 复查：本轮只执行账号状态确认，未继续重试 `get_metadata` / `use_figma`，避免继续消耗 Figma MCP 读写额度；当前连接仅返回一个 Starter 团队，且席位为 View，没有可自动切换的 Professional / Organization / Enterprise 团队或可编辑席位。
- 2026-07-09 追加修复尝试：检查本地 Figma 插件端点、Codex 登录缓存、主要状态库和 OAuth 安装恢复状态，未发现可直接修改的 Figma 团队、席位、额度或账号切换配置；本地插件与 MCP 工具暴露正常，阻断点仍在 Figma 账号计划 / 席位 / MCP 额度层。
- 结论：当前不是本地连接器完全损坏，也不是旧文件单点权限问题；真正阻塞是当前账号/团队处在 Starter + View 席位状态，且历史错误显示 Starter MCP 调用额度已拦截只读和写入类 Figma MCP 调用。这个问题无法通过修改本地脚本、重试测试文件、清理项目代码或重建 Figma 文件修复。
- 最新执行决策：Figma 插件当前不可用，本轮改为使用 `docs/figma.md` 作为设计规范，并在代码中落地设计系统；后续插件恢复后可根据 `docs/figma.md` 再同步到 Figma。后续热循环不再等待或重试 Figma 插件。
- 不记录内容：不把个人账号、邮箱、`planKey`、密钥或任何真实客户数据写入文档。
- 替代交付：以本文件中的 Design Tokens、Components、Frontend Pages、Admin Pages、Motion Spec 作为后续 Figma 搭建依据。
- 后续执行：需要先在 Figma 侧完成其中一种恢复动作：升级当前团队计划并授予可编辑席位；或切换 / 重新连接到拥有可用 MCP 额度和可编辑权限的团队账号。恢复后先运行 `whoami` 确认不是 Starter + View 状态，再执行一次 `get_metadata` / `use_figma` 同步本设计系统。

Figma 页面结构：

1. `00 Design Tokens`
   - Colors：按 4.1 色彩建变量。
   - Typography：页面大标题、分区标题、卡片标题、正文、辅助文字、金额。
   - Radius：xs/sm/md/lg/xl/xxl/pill。
   - Shadows：card/soft/float/button/tabBar。
   - Motion：press/fast/normal/slow/easeOut/easeInOut。
2. `01 Components`
   - Header / LargeTitle
   - Channel / CapsuleTabs
   - Input / Search
   - Card / FeaturedProduct
   - Card / ProductCompact
   - Card / Order
   - Card / AdminMenu
   - Card / Metric
   - Card / Chart
   - Button / Primary / Secondary / Danger
   - Badge / Status
   - Modal / Confirm
   - State / Empty / Skeleton / Loading
   - Navigation / FloatingTabBar
3. `02 Frontend Pages`
   - 商品首页
   - 商品详情
   - 购物车
   - 订单列表
   - 订单详情
   - 我的页面
   - 登录页
   - 法律页面
4. `03 Admin Pages`
   - 后台首页
   - 商品管理
   - 库存管理
   - 付款审核
   - 发货管理
   - 售后退款
   - 商品数据分析
5. `04 Motion Spec`
   - 页面进入
   - 卡片进入
   - tab 选中
   - 按钮按压
   - 弹窗
   - 结算栏
   - 骨架屏
   - 图表加载

交付要求：

- 所有组件优先使用 tokens，不硬编码散落颜色。
- 页面稿宽度至少包含 375px 移动端和 812px 横屏/宽屏参考。
- Figma 组件命名必须能映射到小程序组件或样式类。
- 附件图只可作为 reference / moodboard，不作为可复制 UI 资产。

## 10. 三轮热循环记录

### 10.1 第一轮：设计循环

- 子智能体 A：已完成参考图分析，确认核心方向是“大标题 -> 横向胶囊 -> 精选大卡 -> 列表分区 -> 浮动导航”，并明确不能照抄蓝色配色、图标、图片和内容。
- 子智能体 B：已输出 `docs/figma.md` 草稿，覆盖设计目标、Design Tokens、页面规范、组件规范、动画规范、Figma 交付规范和热循环记录模板。
- 子智能体 C：已输出 Figma 结构规划；真实 Figma 写入因 Starter 计划调用上限暂不可用，本文件承担结构化交付。
- 子智能体 G：已输出权限与业务保护条款，要求写入角色边界、敏感字段保护、后台数据卡片保护、路由与云函数稳定性。
- 中心智能体审查：本文件已合并 A/B/C/G 产出；第一轮只新增文档，不改业务代码、不改云函数、不发布、不上传。

完成条件检查：

- `docs/figma.md` 已创建。
- 设计方向清楚。
- Design Tokens 完整。
- 页面规范覆盖前台、后台、法律页面。
- 组件规范覆盖核心 UI 组件。
- 动画规范覆盖页面、卡片、tab、按钮、弹窗、结算栏、骨架屏、图表。
- 权限保护说明完整。

### 10.2 第二轮：实现循环

计划执行：

- 子智能体 D：前台页面实现，负责商品首页、商品详情、搜索、购物车、订单列表、订单详情、我的页面、登录页、法律页面。
- 子智能体 E：后台页面实现，负责后台首页、商品管理、库存管理、报价导入、付款审核、发货管理、售后退款、商品数据分析。
- 子智能体 F：组件与动画实现，负责公共 WXSS、token、motion、按钮、卡片、标签、输入框、弹窗、状态徽章、自定义 tabBar。
- 子智能体 G：权限和业务复查，确认云函数未动、权限未破坏、敏感字段未新增曝光。
- 子智能体 H：静态检查和体验验收，检查竖屏、横屏、编译、重叠、遮挡、滚动性能。

本轮中心智能体已落地的前台实现：

- `custom-tab-bar`：从贴底全宽面板改为居中悬浮奶油白胶囊，选中态增加 pill 背景和轻量进入动效；保留原 `visible` 权限判断、购物车角标和四个 tab 路由。
- `pages/order/list`：新增横向状态筛选胶囊，按本地订单状态分为全部、待审核、待付款、待确认、配送中、已完成；不改变 `getOrders` 查询、订单状态码或云函数。
- `pages/profile/index`：重排为大标题、身份卡、常用入口网格、后台入口、账号安全和协议列表；保留 `showCustomerEntries`、`showAdminEntry`、`backendOnly` 和 `syncTabBar(this, 3)` 逻辑。
- `pages/login/index` 与 `pages/login/password`：接入大标题、奶油白登录卡、沙漠金 pill 主按钮、页面进入动效和横竖屏类；保留微信登录、手机号密码登录、忘记密码和密码设置流程。
- `pages/legal/*`：统一大标题、正文卡、32rpx 圆角、宽屏最大 960rpx 和 `page-enter`；不改协议正文含义。
- `pages/address/list.json` 与 `pages/address/edit.json`：补齐 `ui-empty` / `ui-skeleton` 组件注册，修复地址页潜在编译风险。

本轮已知未完成项：

- Figma 真实页面稿仍受 Starter MCP 调用上限影响，无法生成或读取真实 Figma 画布。
- 后台审查发现旧后台入口、订单、退款、售后、发货等页面存在更深的权限/敏感字段展示风险；这些不能只靠视觉隐藏按钮解决，后续需要按权限点、云函数返回字段和页面展示一起单独处理。
- 本轮没有修改云函数、数据库集合、业务字段、状态码和权限定义。

### 10.3 第三轮：打磨循环

计划执行：

- 子智能体 H：体验复查首页高级感、商品卡片、底部导航、后台工作台和动效自然度。
- 子智能体 A：对照 App Store-like 目标复查是否仍像普通模板。
- 子智能体 B：同步更新本文件中的最终规范。
- 子智能体 C：同步更新 Figma 交付状态或结构。
- 中心智能体：做最终修正、验证和交付报告。

2026-07-09 续跑打磨记录：

- 子智能体 A/H 只读审查结论：当前最值得继续打磨的是商品数据分析页、商品详情横屏、购物车结算、订单列表行动层级和后台首页宽屏工作台。其中商品数据分析页收益最高，因为现状仍偏“表单 + 图表纵向堆叠”，不够像成熟管理工作台。
- 子智能体 G 只读审查结论：本轮继续只允许做 UI / UX，不得修改云函数、路由、权限规则、状态流转、敏感字段展示和危险操作确认；商品数据分析、库存管理、订单管理、后台首页是权限敏感页面，必须保留现有权限过滤和业务绑定。
- 中心智能体本轮执行：优先打磨 `pages/admin/product-analytics/index` 和 `pages/admin/inventory`，只改 WXML/WXSS 和一个页面卸载清理问题，不改云函数、不改接口参数、不改权限判断、不改状态码。
- 商品数据分析页：新增工作台 hero、当前时间和分析对象胶囊、横向时间范围胶囊、选中商品主卡、指标摘要卡、图表卡分组和宽屏双列图表布局；保留 `adminSearchProducts`、`getProductAnalytics`、canvas 绘图和自定义日期逻辑。
- 库存管理页：新增工作台 hero、库存数量胶囊、库存行卡片、日志行卡片、宽屏双列工作区；保留 `inventory:view`、`inventory:delete_all`、超级管理员判断、清空库存二次确认和倒计时。
- 修正项：`pages/admin/inventory.js` 原本存在重复 `onUnload` 定义，后一个覆盖前一个；本轮合并清理逻辑，让清空库存倒计时和方向监听都能在页面卸载时正确清理。
- 验证：使用 bundled Node 对 `pages/admin/inventory.js`、`pages/admin/product-analytics/index.js` 做语法检查通过；相关 JSON 解析通过；本轮改动文件 UTF-8 检查通过。当前目录 Git 状态检查仍返回 `fatal: not a git repository`，无法用 Git diff 作为差异证据。

2026-07-09 续跑前台打磨记录：

- 子智能体 H/G 只读审查结论：商品详情和购物车的接口调用、提交参数、地址/配送业务、底部安全区、行内点击事件和旧地址表单块都不能被 UI 改造触碰；重点检查商品详情横屏分栏、购物车商品行长文本、结算面板安全区和 WXML 标签闭合。
- 中心智能体本轮执行：优先打磨 `pages/product/detail` 和 `pages/cart/index`，只改 WXML/WXSS，不改 JS 业务流、不改云函数、不改路由、不改提交参数。
- 商品详情页：新增 `detail-layout`，由统一容器控制竖屏顺序和横屏左右分栏；横屏/宽屏下左侧固定商品 hero 图，右侧聚合商品信息、数量和配送方式，减少旧 `.hero` / `.product-card` 百分比规则互相打架。
- 商品详情页：数量卡加入说明和更清晰的金额分隔，配送选择保持原 radio 绑定和地址选择绑定；底部加入购物车和立即预下单按钮保持原事件和 disabled 状态。
- 购物车页：新增待提交商品分区标题，商品行卡片、图片、删除按钮、数量 stepper、配送方式和结算浮层做轻量视觉收敛；保留勾选、删除、数量加减、输入失焦、全选和提交预订单绑定。
- 验证：使用 bundled Node 对 `pages/product/detail.js`、`pages/cart/index.js` 做语法检查通过；`pages/product/detail.json`、`pages/cart/index.json`、`project.config.json` JSON 解析通过；两页 WXML `view` 标签计数平衡；本轮改动文件 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 续跑订单列表打磨记录：

- 子智能体 A/H 只读审查结论：订单列表需要继续增强“状态筛选 -> 订单动态 -> 单卡下一步”的行动层级，参考附件中 App Store 首屏的分区标题、横向胶囊、列表行扫描节奏和浮动导航轻盈感，但不得新增付款、售后或发货入口。
- 子智能体 G 只读审查结论：本轮只能做订单列表展示层，不得修改 `deriveOrderFilter`、`getOrders` 参数、订单状态码、付款状态映射、缓存逻辑、tabBar 同步或云函数；不得在前台列表新增付款截图、交易号、完整地址、完整手机号、后台备注或风险标签。
- 中心智能体本轮执行：只修改 `pages/order/list.wxml` 和 `pages/order/list.wxss`，保留 `selectOrderFilter`、`refreshOrders`、`goDetail` 事件绑定和 `summaryOnly: true` 查询。
- 订单列表页：筛选胶囊在加载或错误状态下也保留显示，新增“订单动态”分区标题和当前筛选笔数，减少空白状态下用户对状态入口的迷失。
- 订单卡片：改为状态色顶部细线、标题/状态头部、订单号、金额摘要面板、种类/数量指标、付款状态和“查看详情”行动胶囊的结构；不同 `orderFilter` 仅改变视觉强调，不改变业务语义。
- 验证：`pages/order/list.wxml` 的 `view` 标签计数平衡；关键事件绑定 `selectOrderFilter`、`refreshOrders`、`goDetail` 均存在；后续需在微信开发者工具中验收竖屏/横屏下订单卡片高度、长订单名、付款标签和合并发货提示。

2026-07-09 续跑后台订单管理打磨记录：

- 子智能体 A/H 只读审查结论：后台订单管理需要从普通流水账列表收敛为“订单队列工作台”，参考附件中的大标题、横向胶囊、精选卡和列表扫描节奏，但后台页应更密集、清晰、可处理，不做营销式大留白。
- 子智能体 G 只读审查结论：本轮只允许改 `pages/admin/orders` 展示层；不得修改 `getOrders`、`adminReviewOrder`、`adminUpdatePayment`、`exportOrdersExcel`、`cancelOrder`、`checkMergeShipmentEligibility` 等云函数调用语义，不得弱化取消、拒绝、付款确认和合并发货的确认边界。
- 中心智能体本轮执行：修改 `pages/admin/orders.wxml` 和 `pages/admin/orders.wxss`，新增后台工作台 hero、筛选汇总胶囊、订单队列分区、客户/履约信息面板、付款状态面板、商品明细标题和已选发货悬浮栏视觉收敛；保留筛选、导出、审核、付款确认、取消订单、备注、发货单和合并发货事件绑定。
- 横屏修正：旧横屏规则会把整张订单卡拆成三列，和新卡片结构冲突；本轮改为订单卡整体保持完整，卡内客户/履约信息双列、商品明细双列，避免地址、付款面板和备注块错位。
- 验证：`pages/admin/orders.js` 语法检查通过；`pages/admin/orders.json`、`project.config.json` JSON 解析通过；`pages/admin/orders.wxml` 的 `view` 标签计数平衡；关键事件绑定 `goShipments`、`load`、`confirmExport`、`review`、`markPayment`、`cancelOrder`、`toggleSelectOrder`、`createMergeShipmentFromSelection`、`saveOrderNote`、`clearOrderNote`、`loadOrderNoteLogs`、`resetFilters` 粗查通过；本轮改动文件 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 续跑商品管理打磨记录：

- 子智能体 A/H 只读审查结论：商品管理页是采购和超级管理员高频工作台，原结构偏“表单 + 筛选 + 批量工具 + 商品卡”纵向堆叠，缺少附件参考中的大标题、胶囊筛选、精选卡片层级和列表扫描节奏。
- 子智能体 G 只读审查结论：本轮只能改 `pages/admin/products` 展示层；不得修改 `adminSearchProducts`、`manageProduct`、`updateProductPrice`、`batchUpdateProductPrices`、`batchUpdateWarningStock`、`batchUpdateProductTags`、`generateProductIndexes` 等调用语义，不得改变上下架、价格单位、库存预警、内部标签或前台标签规则。
- 中心智能体本轮执行：修改 `pages/admin/products.wxml` 和 `pages/admin/products.wxss`，新增商品工作台 hero、当前商品/已选商品指标、筛选汇总胶囊、商品表单分组网格、批量工具箱、商品队列分区和缩略图商品卡；保留新建、编辑、保存、搜索、筛选、全选、批量上架、批量调价、批量预警、批量标签、补齐索引、单品改价和下架事件绑定。
- 横屏修正：横屏下表单进入双列网格，搜索栏横向排列，商品队列 2 列；宽屏商品队列 3 列，商品卡内部规格/标签双列，避免长商品名、内部标签和库存状态挤压。
- 验证：`pages/admin/products.js` 语法检查通过；`pages/admin/products.json`、`project.config.json` JSON 解析通过；`pages/admin/products.wxml` 的 `view` 标签计数平衡；关键事件绑定 `newProduct`、`onInput`、`onFormTagsChange`、`onActiveChange`、`onAutoHideChange`、`saveProduct`、`onSearchInput`、`searchNow`、`clearSearch`、`onSpecialFilterChange`、`onStockStatusFilterChange`、`onTagFilterChange`、`onDefectFilterChange`、`onInternalTagFilterInput`、`toggleSelectAll`、`bulkActivate`、`onBatchTypeChange`、`runBatchPrice`、`runBatchWarningStock`、`runBatchTag`、`runBatchInternalTag`、`generateIndexes`、`onProductSelect`、`onNewPriceInput`、`savePrice`、`editProduct`、`deleteProduct` 粗查通过；本轮改动文件 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 续跑发货履约打磨记录：

- 执行决策：停止继续尝试调用 Figma 插件，改用本文件作为设计源文档，并继续在 WXML/WXSS 中落地 App Store-like 沙漠金风格。
- 子智能体 Hubble 只读审查结论：发货链路中 `pages/admin/shipments/detail` 信息密度最高，`pages/admin/delivery/index` 次之，`pages/admin/shipments/index` 可做列表层级收敛；本轮只能做展示层，不得修改权限、动作值、云函数调用、导出、取消和完成语义。
- 中心智能体本轮执行：修改 `pages/admin/delivery/index.wxml`、`pages/admin/delivery/index.wxss`、`pages/admin/shipments/index.wxml`、`pages/admin/shipments/index.wxss`、`pages/admin/shipments/detail.wxml`、`pages/admin/shipments/detail.wxss`，新增发货工作台、履约工作台、发货单详情 hero、筛选汇总胶囊、订单/客户/履约信息面板、物流表单分区、订单/商品队列卡片和日志分区。
- 业务保护：保留 `load`、筛选 `bindchange`、`onDraftInput`、`uploadImage`、`updateDelivery`、`goOrders`、`onKeyword`、`search`、`goDetail`、`loadMore`、`onInput`、`saveInfo`、`confirmShipment`、`cancelShipment`、`completeShipment`、`exportPickingList`、`copyTrackingNo`、`copyExportLink`、`openExportFile` 等事件绑定；不改变 `confirm_shipping`、`mark_picked_up`、`complete`、`after_sales` 动作值。
- 横屏修正：发货管理横屏保持订单卡完整，仅在卡内将订单/履约信息和快递输入做双列；合并发货单列表横屏 2 列、宽屏 3 列；发货单详情横屏将客户地址与物流表单并排，订单/商品列表进入 2 到 3 列。
- 验证：`pages/admin/delivery/index.js`、`pages/admin/shipments/index.js`、`pages/admin/shipments/detail.js` 语法检查通过；对应 JSON 与 `project.config.json` JSON 解析通过；三页 WXML `view` 标签计数平衡；关键事件绑定粗查通过；未触碰 `cloudfunctions/**`。

2026-07-09 续跑报价/库存导入打磨记录：

- 执行决策：继续停止 Figma 插件重试，本轮以本文件和代码内设计系统作为落地依据，针对 `pages/admin/import` 导入链路做后台工作台视觉打磨。
- 子智能体 G/H 只读审查结论：导入链路属于高敏感后台入口，必须保留 `ensureAdmin("inventory:import")`、文件必选、解析缓存、预览跳转、`confirmImport` 二次确认、分批写入、`idempotencyKey`、错误/警告展示和历史详情绑定；本轮只能改 WXML/WXSS。
- 中心智能体本轮执行：修改 `pages/admin/import/index.wxml`、`pages/admin/import/index.wxss`、`pages/admin/import/preview/index.wxml`、`pages/admin/import/preview/index.wxss`、`pages/admin/import/history/index.wxml`、`pages/admin/import/history/index.wxss`，新增导入工作台 hero、文件状态指标、上传步骤卡、模式卡、导入预览指标、商品队列卡、导入历史记录卡和详情明细网格。
- 业务保护：保留 `goHistory`、`parseFile`、`chooseFile`、`choosePriceFile`、`onStockModeChange`、`onPriceModeChange`、`confirmImport`、`backToImport`、`onSelectedChange`、`onFieldInput`、`onActionChange`、`showDetail`、`backList` 等事件绑定；不改变 `stockMode` / `priceMode` 参数值、`ACTIONS` 值、价格按分、`MAX_RENDER_ITEMS` 只限制渲染不限制导入、`BATCH_SIZE` 分批提交和 `confirmMergedInventoryImport` 调用语义。
- 横屏修正：导入首页横屏/宽屏进入多列工作台；预览页横屏左侧固定确认与摘要，右侧保留商品队列；历史页宽屏下历史记录和明细卡进入 2 到 3 列，避免长文件名和原文信息挤压。
- 验证：`pages/admin/import/index.js`、`pages/admin/import/preview/index.js`、`pages/admin/import/history/index.js` 语法检查通过；对应 JSON 与 `project.config.json` JSON 解析通过；三页 WXML `view` 标签计数平衡；关键事件绑定粗查通过；未触碰 `cloudfunctions/**`。

2026-07-09 续跑售后退款打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文件中的“售后退款”页面规范，把售后管理和退款记录从普通列表升级为财务/客服可扫描的工作台。
- 子智能体 G/H 只读审查结论：售后两页必须保留 `ensureAdmin("after_sale:view")`，退款两页必须保留 `ensureAdmin("refund:view")`；不得改云函数、状态门槛、`data-field`、`data-action`、`data-id`、`data-index`、二次确认和幂等逻辑。
- 中心智能体本轮执行：修改 `pages/admin/after-sales/index/index.wxml`、`pages/admin/after-sales/index/index.wxss`、`pages/admin/after-sales/detail/index.wxml`、`pages/admin/after-sales/detail/index.wxss`、`pages/admin/refunds/index/index.wxml`、`pages/admin/refunds/index/index.wxss`、`pages/admin/refunds/detail/index.wxml`、`pages/admin/refunds/detail/index.wxss`，新增售后工作台 hero、退款记录 hero、筛选汇总胶囊、售后/退款队列卡、详情 hero、金额摘要网格、操作侧栏、凭证面板和日志面板。
- 业务保护：保留 `onStatusChange`、`onKeyword`、`load`、`exportExcel`、`copyExportLink`、`goDetail`、`goRefunds`、`review`、`confirmReceived`、`inspect`、`createRefund`、`complete`、`goRefund`、`chooseProofImages`、`removeProof`、`processRefund`、`wechatRefund`、`rejectRefund` 等事件绑定；保留 `pending_review`、`returned/waiting_return`、`received/inspecting`、`refundStatus === 'pending' && approvedRefundAmount > 0`、`refund.refundStatus !== 'refunded'` 等条件展示。
- 风险控制：退款列表不新增一键退款；线下退款仍通过 `processRefund` 内部金额校验和 `wx.showModal` 确认；售后审核仍保留 `data-action="approve/reject"` 和 `wx.showModal`；退款凭证删除改用 `catchtap`，减少误触父级。
- 横屏修正：售后/退款列表横屏下筛选区左右分栏、队列卡信息与指标分栏；详情页横屏下主信息在左、审核/退款处理侧栏在右并 sticky，避免危险操作被长内容淹没。
- 验证：四页 JS 语法检查通过；四页 JSON 与 `project.config.json` JSON 解析通过；四页 WXML 标签检查通过；关键绑定和 `data-*` 粗查通过；四页 WXSS 大括号检查通过；本轮改动文件 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 续跑财务账款打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文件中的后台财务工作台方向，把新版 `pages/admin/accounts/index` 和 `pages/admin/accounts/detail` 从普通表格卡升级为客户账款工作台。
- 子智能体 G/H 只读审查结论：账款两页必须保留 `ensureAdmin("customer:view_account")`；不得改 `load`、`onFilterChange`、`onSortChange`、`onKeyword`、`search`、`goDetail`、`recalc`、`markRisk`、`markSettled`、`updateRemark`、`updateRisk`、`exportStatement`、`openExportFile` 绑定，不得丢失 `data-id="{{item._id}}"`；结清、备注、风险仍由原弹窗/action sheet 确认。
- 中心智能体本轮执行：修改 `pages/admin/accounts/index.wxml`、`pages/admin/accounts/index.wxss`、`pages/admin/accounts/detail.wxml`、`pages/admin/accounts/detail.wxss`，新增财务账款 hero、筛选汇总、客户账款队列卡、未付金额主指标、客户详情 hero、账款汇总侧栏、订单明细、付款记录和账款流水分区。
- 业务保护：保留所有金额格式化字段展示，例如 `totalUnpaidText`、`totalOrderText`、`totalPaidText`、`todayText`、`historyText`、`pendingText`、`abnormalText`、`changeText`；未新增完整手机号、完整地址、付款截图、交易号、`fileUrl`、`operatorOpenid` 等敏感字段。
- 横屏修正：账款列表横屏下筛选区横向排列、客户信息和金额指标左右分栏；详情页横屏下主明细在左、账款汇总与操作按钮在右并 sticky，避免结清/风险/导出操作被长流水列表挤压。
- 验证：两页 JS 语法检查通过；两页 JSON 与 `project.config.json` JSON 解析通过；两页 WXML 标签检查通过；关键绑定和 `data-id` 粗查通过；敏感字段扫描通过；两页 WXSS 大括号检查通过；本轮改动文件 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 主界面与底部导航优先修订记录：

- 执行决策：Figma 插件当前不可用，本轮继续以 `docs/figma.md` 作为设计规范，并在代码中落地设计系统；后续插件恢复后可根据本文件再同步到 Figma。
- 参考附件方向：保留 App Store 的大标题、右上身份/快捷入口、横向胶囊频道、精选大卡和浮动底部导航层级，但不引入蓝色 App Store 配色，继续使用沙漠金、奶油白和轻商务质感。
- 首页结构调整：将原来分散的 hero、搜索卡、分类标题和推荐标题收敛为一个顶部频道区：大标题、收藏/常购/购物车快捷入口、单行搜索胶囊和横向分类频道；推荐区直接进入“今日精选”大卡和横向推荐商品流，减少首屏重复说明。
- 底部导航调整：沿用 `custom-tab-bar` 和原有四个 tab 路由，不新增第二套导航；移除自绘 home indicator，改为更矮、更透的浮动胶囊，选中项使用浅色 pill 和沙漠金高亮，购物车角标逻辑保持不变。
- 业务保护：保留 `goFavorite`、`goFrequent`、`goCart`、`onSearchFocus`、`onSearchInput`、`onSearchConfirm`、`clearSearch`、`onCategoryTap`、`onRecommendTabTap`、`goRecommend`、`goDetail`、`addToCart`、`toggleFavorite` 等绑定；未改首页 JS、云函数、权限、商品查询、推荐查询、购物车角标或 tab 路由。
- 横屏修正：顶部频道在横屏下左右留白加大，搜索胶囊保持合理最大宽度，分类频道按横屏安全区重新留边；底部导航横屏下变矮并居中，避免遮挡内容。
- 验证：`pages/index/index.js`、`custom-tab-bar/index.js` 语法检查通过；`pages/index/index.json`、`custom-tab-bar/index.json`、`project.config.json` JSON 解析通过；两处 WXML 标签检查通过；首页关键绑定粗查通过；首页与底部导航敏感字段扫描通过；两处 WXSS 大括号和 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 主界面混乱热修记录：

- 触发问题：微信开发者工具截图显示首页顶部快捷入口把标题区挤爆，`批发订货`、`商品`、副标题被压成逐字竖排，右侧购物车快捷入口溢出，首屏视觉层级混乱。
- 修复策略：三个顶部快捷入口只是导航入口，不需要原生 `button` 表单语义；本轮将 `home-icon-action` / `home-cart-action` 从原生 `button` 改为 `view` 点击区，避免微信默认按钮最小宽度撑开布局。
- 样式修正：将顶部标题区改为稳定的块级布局，右上快捷入口绝对定位并固定宽度；标题、副标题恢复正常横排；搜索和频道向上收紧，减少大面积空白。
- 业务保护：保留 `goFavorite`、`goFrequent`、`goCart` 点击事件；未改首页 JS、推荐/搜索/购物车逻辑、云函数、权限或 tab 路由。
- 验证：首页与底部导航 JS 语法检查通过；WXML 标签检查通过；首页关键绑定检查通过；确认顶部快捷入口不再使用原生 `button`；WXSS 大括号、JSON 解析、敏感字段扫描通过。

2026-07-09 首页首屏密度修订记录：

- 触发问题：用户反馈“这么大的界面只显示一个产品”。截图显示顶部频道、搜索、推荐标题、精选大卡和底部导航共同占用过多竖向空间，首屏只能完整看到一个精选商品，普通商品列表被底部导航遮挡。
- 设计修正：将首页目标从“精选大卡优先”调整为“紧凑商品流优先”。App Store-like 只保留信息层级，不保留过大的编辑卡尺寸。
- 首页密度调整：压缩顶部频道区高度，缩小标题、搜索胶囊、分类胶囊和推荐标题间距；将精选商品卡由大封面卡改为横向紧凑卡，图片固定为小封面，商品名、生产日期、标签、价格和加购按钮在右侧快速扫描。
- 商品流调整：普通商品卡图片、内边距、按钮和卡片间距同步缩小；首页 `page-with-tabbar` 底部留白减少，让商品列表更早露出。
- 底部导航调整：继续沿用 `custom-tab-bar`，将浮动导航高度从上一版继续压缩，图标和文字尺寸降低，减少遮挡商品列表。
- 业务保护：未改首页 JS、底部导航 JS、云函数、权限、商品查询、推荐查询、购物车角标、加购、收藏或路由。
- 验证：首页与底部导航 JS 语法检查通过；WXML 标签、WXSS 大括号、JSON 解析、关键绑定、敏感字段扫描通过。

2026-07-09 首页多横向商品分区修订记录：

- 触发问题：继续对照原始附件和用户反馈，单个“精选大卡”仍然过强，无法体现 App Store 信息流中连续横向分区的节奏。
- 结构修正：推荐区从 `visibleRecommendSections` 单频道展示改为 `recommendSections` 多频道展示；每个推荐频道都成为一条横向商品 rail，不再把第一个商品单独放大成大卡。
- 卡片规格：`home-rail-card` 固定为 224rpx 宽，图片 200rpx × 150rpx；商品名最多两行，生产日期和辅助信息单行截断，标签只保留一行，价格和加购按钮放在底部。
- 体验目标：首屏和下滑第一屏能看到多个商品和多个推荐分区开头，符合“新货 / 热销 / 常购横向滑动”的原始目标，同时避免模板化大卡占屏。
- 业务保护：保留 `goRecommend`、`goDetail`、`addToCart`、商品图片、标签、价格和禁用态绑定；未改首页 JS、推荐云函数、购物车逻辑、权限或路由。
- 验证：首页与底部导航 JS 语法检查通过；WXML 标签、WXSS 大括号、JSON 解析、关键绑定、敏感字段扫描通过。

2026-07-09 首页推荐频道三选一修订记录：

- 触发问题：用户明确要求“常购新货热销，用户三选一显示”。因此推荐频道不应全部堆叠展示。
- 结构修正：恢复使用 `recommendTabs`、`activeRecommendKey`、`visibleRecommendSections` 和 `onRecommendTabTap`；推荐区顶部显示三段单选频道，下面只渲染当前选中的一个推荐频道。
- 样式修正：新增 `home-recommend-switch`，作为常购 / 新货 / 热销等频道的单选控件；选中态保持沙漠金深色底和白字，未选中态为奶油白。
- 业务保护：仅修改首页 JS 的展示整形层，按 `frequent_purchase`、`new_arrivals`、`hot_selling` 过滤和排序；切换选择会写回首页推荐缓存，返回首页不跳回默认频道；未改推荐接口、推荐云函数、推荐数据结构、购物车加购逻辑、商品详情跳转、权限或路由；`addToCart` 仍可从 `visibleRecommendSections` 查找当前商品。
- 验证：首页 JS 语法检查通过；WXML 标签、WXSS 大括号、JSON 解析、关键绑定和敏感字段扫描通过。

2026-07-09 购物车主流程打磨记录：

- 执行决策：继续不调用 Figma 插件，按附件中 App Store 的白底大标题、清晰列表和轻浮动操作栏层级，把购物车从偏横幅式页面收敛为更轻的预订单确认页。
- 结构修正：修改 `pages/cart/index.wxml`、`pages/cart/index.wxss`、`pages/cart/index.js`；顶部从大渐变横幅改成白底大标题和右侧轻胶囊操作，商品分区文案统一为中文，配送分区改为“配送信息”，移除永不渲染的旧地址直填模板。
- 视觉修正：购物车商品卡、图片、数量 stepper、删除按钮、配送卡和底部留白同步压缩，保持底部结算栏与自定义 tabBar 的安全距离，同时让商品列表更早进入视野。
- 业务保护：保留 `clearCart`、`retryLoad`、`goShop`、`toggleItem`、`removeItem`、`changeQty`、`onQtyInput`、`onQtyBlur`、`onDeliveryTypeChange`、`chooseAddress`、`addAddress`、`toggleAll`、`submitCartOrder` 等绑定；未改 `submitCartOrder` 云函数调用、幂等、手机号校验、地址 ID 提交、数量换算或金额按分语义。
- 隐私展示：新增页面内 `receiverPhoneDisplay` 展示整形；如果地址只有完整手机号，购物车只显示脱敏手机号，不把完整手机号直接绑定到 WXML。
- 验证：购物车 JS 语法检查通过；`pages/cart/index.json` 与 `project.config.json` JSON 解析通过；购物车 WXML 标签检查通过；关键绑定和 WXML 直接敏感字段显示检查通过；购物车 WXSS 大括号和 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 商品详情转化页打磨记录：

- 执行决策：继续不调用 Figma 插件，按附件中 App Store 的媒体卡、大标题和轻浮动操作栏层级，把商品详情从“重复信息 + 大遮罩图”收敛为更清晰的选品确认页。
- 结构修正：修改 `pages/product/detail.wxml`、`pages/product/detail.wxss`、`pages/product/detail.js`；商品名集中到页面大标题区，商品图改为干净媒体卡，详情卡只承载价格、标签、规格、品类、品牌、生产日期和说明，避免商品名重复展示。
- 视觉修正：大图高度和阴影降低，详情卡/数量卡/配送卡圆角和间距收紧；底部操作栏从贴边整条底栏改为奶油白轻浮动胶囊，横屏和宽屏下保留安全区。
- 业务保护：保留 `toggleFavorite`、`changeQty`、`onQtyInput`、`onQtyBlur`、`onDeliveryTypeChange`、`chooseAddress`、`addAddress`、`addToCart`、`submitOrder`、`goShop` 等绑定；未改 `createOrder`、`addToCart`、幂等、手机号校验、地址 ID 提交、金额按分或自动审核逻辑。
- 隐私展示：移除永不渲染的旧地址直填模板；新增页面内 `receiverPhoneDisplay` 展示整形，避免 WXML 直接回退显示完整手机号。
- 验证：商品详情 JS 语法检查通过；`pages/product/detail.json` 与 `project.config.json` JSON 解析通过；商品详情 WXML 标签检查通过；关键绑定和 WXML 直接完整手机号兜底检查通过；商品详情 WXSS 大括号和 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 前台订单列表打磨记录：

- 执行决策：继续不调用 Figma 插件，按附件中 App Store 的白底大标题、横向胶囊和可扫描列表节奏，把订单列表从偏厚重卡片页收敛为订单状态信息流。
- 结构修正：修改 `pages/order/list.wxml` 和 `pages/order/list.wxss`；顶部从渐变横幅改为白底大标题，右侧显示当前订单数量；筛选胶囊保持横向滚动；分区文案从 `ORDER FLOW` 改为中文“订单状态”。
- 视觉修正：订单卡从顶部状态色条改为左侧状态色条，卡片内边距、金额面板、操作胶囊和间距同步压缩；横屏继续使用 2 列、宽屏 3 列布局。
- 业务保护：保留 `selectOrderFilter`、`refreshOrders`、`goDetail`、`data-id="{{item._id}}"`、`data-filter="{{item.value}}"` 等绑定；未改 `getOrders` 调用、订单状态、付款状态、发货状态、筛选派生、缓存、分页、下拉刷新或 tabBar 同步逻辑。
- 验证：订单列表 JS 语法检查通过；`pages/order/list.json` 与 `project.config.json` JSON 解析通过；订单列表 WXML 标签检查通过；关键绑定检查通过；订单列表 WXSS 大括号和 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 前台订单详情打磨记录：

- 执行决策：继续不调用 Figma 插件，按附件中 App Store 的白底大标题、当前状态主卡和清晰列表节奏，把订单详情从厚重渐变页收敛为“进度、明细、配送、售后”可执行页面。
- 结构修正：修改 `pages/order/detail.wxml`、`pages/order/detail.wxss`、`pages/order/detail.js`；顶部从渐变 hero 改为白底大标题和状态胶囊；当前进度卡、状态步骤、订单摘要、商品明细、配送信息、合并发货、售后服务和取消订单入口保持原有模块。
- 视觉修正：详情卡圆角、边框、阴影、`kv` 行距和按钮间距同步收紧；付款/发货/售后等操作仍保留在对应状态卡内，避免把危险或条件操作做成固定按钮。
- 隐私展示：新增 `shippingAddressDisplay` 展示整形，优先使用 `shippingAddressMasked`，没有时本地脱敏手机号和地址；WXML 不再直接绑定 `shippingAddress.receiverPhone`、`shippingAddress.fullAddress` 或 `shippingAddress.detailAddress`。
- 业务保护：保留 `triggerAutoReview`、`goPayment`、`goAfterSaleApply`、`goAfterSaleDetail`、`copyTrackingNo`、`cancelOrder` 绑定；未改 `getOrders`、`autoReviewOrder`、`cancelOrder`、付款入口、售后入口、快递单号复制、订单状态、取消条件、幂等或云函数逻辑。
- 验证：订单详情 JS 语法检查通过；`pages/order/detail.json` 与 `project.config.json` JSON 解析通过；订单详情 WXML 标签检查通过；关键绑定和 WXML 直接敏感字段显示检查通过；订单详情 WXSS 大括号和 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 前台付款页打磨记录：

- 执行决策：继续不调用 Figma 插件，按附件中 App Store 的白底大标题、清晰分区和列表扫描节奏，把付款页从直接进入账款卡的表单页收敛为“确认金额、选择方式、查看收款信息、上传凭证”的操作流。
- 结构修正：修改 `pages/payment/payment.wxml` 和 `pages/payment/payment.wxss`；新增付款页大标题和状态胶囊，账款合计卡、付款方式卡、收款二维码/银行卡信息、微信支付提示和付款凭证上传区统一用 `payment-card` 层级。
- 视觉修正：待付金额主视觉更集中，账款指标网格压缩，付款方式卡改为更轻的可选列表，二维码、银行卡字段、上传截图、备注和提交按钮圆角/间距统一；横屏下标题跨两列，金额卡左侧 sticky，操作区右侧滚动。
- 业务保护：保留 `selectMethod`、`previewQr`、`copyText`、`copyAllBankInfo`、`startWechatPay`、`previewScreenshot`、`removeScreenshot`、`chooseImages`、`onRemarkInput`、`submitOfflineProof` 等绑定；未改 `getEnabledPaymentMethods`、`selectOrderPaymentMethod`、`submitOfflinePaymentProof`、`createWechatPayOrder`、截图上传、幂等、付款状态或云函数逻辑。
- 付款语义：页面文案继续明确“上传凭证后等待财务确认”，提交成功仍提示等待财务确认，不把线下付款暗示为已到账。
- 验证：付款页 JS 语法检查通过；`pages/payment/payment.json` 与 `project.config.json` JSON 解析通过；付款页 WXML 标签检查通过；关键绑定、`submitOfflinePaymentProof` 和等待财务确认文案检查通过；付款页 WXSS 大括号和 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 前台售后申请打磨记录：

- 执行决策：继续不调用 Figma 插件，按附件中 App Store 的白底大标题、主摘要卡和分步骤表单节奏，把售后申请从普通卡片堆叠收敛为“确认订单、选择原因、说明问题、选择商品、填写金额、上传凭证”的申请流。
- 结构修正：修改 `pages/after-sale/apply.wxml` 和 `pages/after-sale/apply.wxss`；新增售后申请大标题和状态胶囊，订单信息改为主摘要卡，提交按钮包裹为轻浮动样式并补“提交后请等待客服审核，退款不会自动完成”提示。
- 视觉修正：步骤标签、表单输入、商品选择行、数量输入、凭证图片网格和提交区统一圆角、边框和沙漠金选中态；可退金额在摘要卡右侧突出显示。
- 业务保护：保留 `onTypeChange`、`onReasonChange`、`onInput`、`toggleItem`、`onQuantityInput`、`chooseImages`、`removeImage`、`submit` 等绑定；未改 `getOrders`、`createAfterSaleRequest`、上传凭证、退款金额校验、原因字数校验、幂等或售后状态逻辑。
- 售后语义：提交成功仍提示“售后申请已提交，请等待客服审核”，页面也明确退款不会自动完成，不弱化客服审核和后续退款流程。
- 验证：售后申请 JS 语法检查通过；`pages/after-sale/apply.json` 与 `project.config.json` JSON 解析通过；WXML 标签检查通过（`input` 按 WXML 自闭合单独检查）；关键绑定、`createAfterSaleRequest` 和等待客服审核文案检查通过；售后申请 WXSS 大括号和 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

2026-07-09 前台售后详情打磨记录：

- 执行决策：继续不调用 Figma 插件，按附件中 App Store 的白底大标题、状态摘要和时间线节奏，把售后详情从普通信息卡堆叠收敛为“处理进度、申请内容、售后商品、审核信息、退货物流、时间线”的状态页。
- 结构修正：修改 `pages/after-sale/detail.wxml` 和 `pages/after-sale/detail.wxss`；新增售后详情大标题和状态胶囊，首卡改为售后单号、订单号、申请金额和退款状态的摘要卡，其余模块保持原顺序。
- 视觉修正：售后状态卡、申请内容、售后商品、审核信息、退货物流和时间线统一圆角、边框、阴影和沙漠金状态样式；凭证图片、物流输入和时间线节点更易扫描。
- 业务保护：保留 `onInput`、`submitLogistics` 绑定；未改 `getMyAfterSaleDetail`、`submitReturnLogistics`、退货物流提交、状态映射、金额格式化、退款状态或售后流程逻辑。
- 验证：售后详情 JS 语法检查通过；`pages/after-sale/detail.json` 与 `project.config.json` JSON 解析通过；WXML 标签检查通过（`input` 按 WXML 自闭合单独检查）；关键绑定、`getMyAfterSaleDetail` 和 `submitReturnLogistics` 调用检查通过；售后详情 WXSS 大括号和 UTF-8 检查通过；未触碰 `cloudfunctions/**`。

## 11. 后续实现文件边界

允许修改：

- `miniprogram/app.wxss`
- `miniprogram/styles/*.wxss`
- `miniprogram/custom-tab-bar/*`
- `miniprogram/pages/**/*.wxml`
- `miniprogram/pages/**/*.wxss`
- 页面内非业务交互 JS
- `miniprogram/utils/motion.js`
- 公共 UI 组件样式
- `docs/figma.md`

原则上不修改：

- `cloudfunctions/**`
- 数据库集合
- 业务字段名
- 状态码
- 权限规则
- `miniprogram/app.json` 页面路径和 tabBar `pagePath`

如确需修改云函数或权限逻辑，必须先单独报告，不直接改。

2026-07-09 登录与账号安全页样式收口记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的白底大标题、奶油白卡片、沙漠金胶囊和轻量动效规范收口登录入口。
- 结构修正：登录页保留微信快捷登录、手机号密码登录、忘记密码、协议跳转；密码页保留设置/修改密码表单，仅为新增的卡片头部和模式胶囊补齐 WXSS。
- 视觉修正：`login-hero` 增加短金色引导线，`login-card-head` 与 `security-card-head` 统一标题层级，`mode-pill` 使用轻量胶囊状态，避免登录页继续停留在半成品模板状态。
- 业务保护：未改登录授权、密码校验、重置申请、隐私政策/用户协议跳转、`session.redirectAfterLogin` 或任何云函数。

2026-07-09 我的页主入口打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文档中 `pages/profile/index` 的账号中心规范，把 `我的` 页从卡片堆叠继续收敛为“身份主卡、常用服务、后台入口、安全、协议”的清晰入口页。
- 结构修正：身份主卡新增统一标题行，账号状态上移为胶囊；手机号、常用入口、后台管理、账号安全和协议说明统一使用 `profile-card-head` 分组；后台角色使用 `role-pill` 承载。
- 视觉修正：压缩常用入口卡片高度和分组间距，统一 `section-kicker`、分组标题、胶囊、列表行和卡片内边距，保持沙漠金、奶油白和轻量圆角风格。
- 业务保护：保留 `showAdminEntry`、`showCustomerEntries`、`backendOnly` 可见性条件和所有跳转/退出/昵称编辑绑定；未改后台权限、登录状态、资料读取、手机号绑定或任何云函数。

2026-07-09 收藏与常购列表打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的商品列表卡、胶囊筛选和白底大标题规范，处理首页快捷入口后的收藏和常购两个高频商品列表页。
- 结构修正：收藏页和常购页顶部从旧渐变横幅改为 `section-kicker`、`page-title`、`page-desc` 和右侧返回首页胶囊；常购页保留排序胶囊，商品卡改为整卡进入详情。
- 视觉修正：两页商品行统一为奶油白卡片、156rpx 稳定图片、两侧信息布局、状态胶囊、小型加购按钮和轻量按压反馈；常购页去掉单独“详情”按钮，减少列表操作噪音。
- 业务保护：保留收藏取消、收藏切换、加购、排序、分页、下拉刷新、空状态、商品详情跳转和首页跳转；未改 `getFavoriteList`、`getFrequentPurchaseList`、`addToCart`、`toggleFavorite`、`removeFavorite` 或任何云函数。

2026-07-09 推荐列表页打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的推荐频道、搜索胶囊和商品列表卡规范，处理首页推荐区 `查看更多` 的下钻列表页。
- 结构修正：推荐列表页顶部从旧渐变横幅改为 `section-kicker`、`page-title`、`page-desc`；搜索区从卡片表单改为单行搜索胶囊，分类继续横向滚动，列表统计与排序形成轻量工具行。
- 视觉修正：商品卡统一为奶油白卡片、156rpx 稳定图片、两行标题、标签、价格和小型加购按钮，保持与收藏/常购页一致的列表节奏。
- 业务保护：保留 `sectionKey` 校验、`getRecommendProducts`、搜索、清空、分类、排序、分页、加购、商品详情跳转和无效推荐区空状态；未改推荐云函数、推荐规则、权限或路由。

2026-07-09 地址、绑定手机号与售后列表打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的白底大标题、奶油白卡片、轻量胶囊和可扫描列表节奏，收口前台支线流程：地址列表、地址编辑、绑定手机号和售后列表。
- 地址列表：顶部改为大标题和地址数量胶囊；地址卡加入左侧状态线、默认地址胶囊、选择模式提示和更轻的底部新增地址浮动按钮；页面内新增 `receiverPhoneDisplay` 展示整形，缺少后端脱敏手机号时本地脱敏后再渲染。
- 地址编辑：从单张普通表单卡改为配送信息大标题、订单选择模式胶囊、表单分组头和统一圆角按钮；保留收货人、手机号、省市区、详细地址、地址标签、默认地址开关和删除/设默认操作。
- 绑定手机号：从普通卡片堆叠改为账号安全大标题、绑定状态胶囊、当前手机号状态卡、微信授权绑定主卡和手动填写备用卡；保持 `getPhoneNumber` 授权、手动绑定、换号确认和绑定成功返回流程不变。
- 售后列表：新增售后服务大标题和数量胶囊；售后卡改为左侧状态线、状态胶囊、售后类型/退款状态双指标、申请金额突出和提交时间辅助信息；保留整卡进入售后详情。
- 业务保护：未改云函数、页面路由、地址保存/删除/设默认、订单地址选择、手机号绑定云函数调用、售后读取或详情跳转；仅做 WXML/WXSS 和地址列表展示整形 JS。

2026-07-09 后台配置页打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的后台工作台、配置卡片和胶囊状态规范，收口 `pages/admin/recommend`、`pages/admin/settings` 和 `pages/admin/admins` 三个配置类页面。
- 推荐配置：从普通表单列表改为推荐工作台大标题、频道概览胶囊、带左侧状态线的推荐区卡片、启停状态胶囊、双列配置表单和横向商品预览；保留启停、字段输入、展示方式选择、单区保存和排序保存。
- 业务配置：从普通卡片表单改为系统配置大标题、支付/自提/合并发货胶囊、配置分组卡、开关说明行和宽屏双列表单；保留支付方式保存、自提配置保存、合并发货配置保存及所有开关/输入绑定。
- 管理员管理：从旧方角卡片和黑色按钮改为系统权限大标题、管理员数量胶囊、新增管理员卡、管理员状态卡、角色/权限指标、编辑角色卡和日志列表；保留新增管理员、编辑角色、禁用/启用二次确认、权限日志和操作日志读取。
- 业务保护：未改 `ensureAdmin` 权限点、云函数调用、角色选项、危险操作确认、推荐区保存结构、支付/自提/合并发货设置结构或页面路由；仅改 WXML/WXSS，并对管理员权限数量做展示兜底。

2026-07-09 客户管理页打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的后台客户工作台规范，收口 `pages/admin/customers/index` 和 `pages/admin/customers/detail`。
- 客户列表：从普通搜索表单和流水卡片改为客户工作台大标题、客户检索卡、风险状态线客户卡、手机号/今日订单/历史未付/当前未付指标格、标签胶囊和备注短摘要；保留整卡进入客户详情。
- 客户详情：从卡片堆叠改为客户详情大标题、手机号卡、账款指标卡、后台备注编辑卡、最近订单和日志分区；备注、标签、风险等级仍按原输入和保存流程处理。
- 隐私与权限：客户详情手机号展示改为优先使用 `phoneMasked`，没有脱敏字段时才回退原字段；列表继续使用 `phoneDisplay || phoneMasked`；保留 `finance` 角色拦截，不新增客户付款截图、完整地址、退款账户或其他敏感字段。
- 业务保护：未改 `getAccountSummary`、`getAdminCustomerDetail`、`updateCustomerAdminNote`、风险等级语义、备注清空确认、分页、搜索或页面路由；仅改 WXML/WXSS 和展示字段优先级。

2026-07-09 库存预警与未售分析打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的后台工作台、摘要指标、胶囊筛选和可扫描商品队列规范，收口 `pages/admin/stock-alerts` 和 `pages/admin/unsold`。
- 库存预警：新增库存工作台大标题、低库存/缺货摘要卡、预警筛选卡、批量修改卡、带左侧状态线的商品卡和紧凑操作区；保留一键检查、缺货自动下架、批量修改、单品保存、自动下架开关、编辑商品和库存日志入口。
- 未售分析：从旧表单和商品卡堆叠改为商品运营大标题、四个摘要指标、横向时间胶囊、自定义时间查询、筛选排序卡、商品队列标题、指标格和操作按钮组；保留导出、筛选、排序、改价、调库存、重点关注、清仓标记和下架二次确认。
- 权限与业务保护：未改 `ensureAdmin("inventory:view")`、`ensureAdmin("product:view")`、`getStockAlerts`、`updateProductWarningStock`、`batchUpdateWarningStock`、`updateStockAlertStatus`、`getUnsoldProducts`、`updateProductPrice` 调用语义；未改价格按分、库存数量、上下架、权限、路由或云函数。
- 验证：库存预警和未售分析 JS 语法检查通过；对应 JSON 和 `project.config.json` 解析通过；两页 WXML 标签、关键绑定、WXSS 大括号和 UTF-8 检查通过；敏感字段扫描未命中客户/付款/账款类字段。

2026-07-09 支付配置、法律页和兼容入口打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的后台配置工作台、分组弹层、文档阅读页和兼容入口收口规范，处理支付配置、法律说明页、旧后台首页和旧账款入口。
- 支付配置：新增财务配置 hero、支付方式摘要、微信支付状态卡、带状态线的支付方式卡、二维码信息块和分组表单弹层；保留 `getAdminPaymentMethods`、新增/编辑、启停、删除、二维码上传、预览、银行卡字段、保存和敏感变更确认。
- 法律说明页：只改五个法律页 WXSS，不改正文内容；统一标题卡、文档卡、长文本行距、宽屏最大阅读宽度和沙漠金引导线。
- 兼容入口：旧 `pages/admin/dashboard` 和 `pages/admin/accounts` 改为轻工作台/账款摘要卡样式；保留旧菜单过滤、库存检查、未售分析入口、刷新和标记历史已付。
- 验证：支付配置、法律页、旧后台首页和旧账款入口 JS 语法检查通过；对应 JSON 和 `project.config.json` 解析通过；WXML 标签、关键绑定、WXSS 大括号和 UTF-8 检查通过。

2026-07-09 合并发货确认页打磨记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的发货履约工作台、状态胶囊、指标格和确认操作页规范，收口 `pages/admin/shipments/merge-confirm`。
- 结构修正：新增发货履约大标题、客户摘要卡、地址卡、订单信息卡、商品汇总卡和确认创建主按钮；地址一致性用状态胶囊提示，失败原因保留在顶部危险提示。
- 业务保护：保留 `eligibility.canMerge`、失败原因、地址不一致提示、`summary.orders`、`itemSummary`、`createShipment`、幂等键、二次确认弹窗和创建后跳转详情；未改云函数、金额、付款记录、库存或合并规则。
- 验证：合并发货确认页 JS 语法检查通过；对应 JSON 和 `project.config.json` 解析通过；WXML 标签、关键绑定、WXSS 大括号和 UTF-8 检查通过。

2026-07-09 法律页内联样式与圆角收口记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的长文阅读页、状态胶囊和新版圆角规范收尾代码实现。
- 法律说明页：五个法律页正文不变，仅把章节标题、小节标题和尾注的 WXML 内联样式迁移为 `legal-heading`、`legal-subheading`、`legal-subheading-spaced`、`legal-footnote` class，并在各页面 WXSS 中承载样式。
- 圆角收口：订单详情已付款徽标改为 pill，售后提示、后台订单备注输入和日志区域改为 20rpx 圆角，后台首页可点击指标值改为 pill；`profile` 手绘订单图标保留原图形圆角。
- 业务保护：未改法律正文、页面 JS、云函数、订单/付款/售后/备注保存流程、统计接口或权限判断。

2026-07-09 页面标题命名与窄屏显示收口记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的大标题、胶囊状态和移动端文本不溢出规范做代码侧收尾。
- 标题体系：售后、购物车、订单、付款、密码和法律页的页面标题不再使用泛化 `title` class，改为 `page-title`、`legal-title`、`card-title` 或页面专属标题类。
- 后台 hero：发货、订单、商品、履约和发货单详情标题去掉全局 `title` 依赖，把字号、字重和行高放进自身 class，并把短标题从强制单行改为可自然换行，降低窄屏溢出风险。
- 业务保护：未改页面路由、事件绑定、云函数、权限判断、订单/售后/付款/发货业务流程或任何数据字段。

2026-07-09 底部导航样式折叠收口记录：

- 执行决策：继续不调用 Figma 插件，按本文档中的浮动底部导航、轻量毛玻璃和紧凑胶囊规范整理当前实现。
- 底部导航：`custom-tab-bar/index.wxss` 从多段覆盖式样式折叠为单一最终样式，保留 98rpx 高度、浮动胶囊、选中态浅色底、沙漠金图标、购物车角标、横屏安全区和宽屏居中规则。
- Token 同步：`miniprogram/styles/theme.wxss` 中 `--tabbar-height` 同步为 98rpx，`--tabbar-shell-height` 同步为 140rpx，避免设计 token 与真实导航高度继续漂移。
- 业务保护：未改 tab 路由、tabBar 可见性、切换逻辑、购物车角标刷新或任何云函数。

2026-07-09 首页满意版冻结记录：

- 执行决策：用户确认当前商品首页截图“比较满意”，后续 UI 收尾以该主页为冻结基准，不再继续压缩、重构或替换首页布局。
- 主页基准：保留大标题、顶部快捷入口、搜索胶囊、分类胶囊、常购/新货/热销三选一、横向商品 rail、普通商品列表和当前浮动底部导航。
- 底部空间：主页保留 140rpx tabBar 留白；购物车因固定结算栏保留 300rpx 留白，避免结算栏与浮动 tabBar 遮挡。
- 业务保护：未改首页 WXML/WXSS/JS、tab 路由、推荐频道逻辑、搜索、分类、商品详情、加购、收藏、购物车角标或任何云函数。

2026-07-09 非首页颜色 token 收口记录：

- 执行决策：在首页已冻结的前提下，继续做不影响首页观感的低风险 UI 收尾，只统一非首页残留颜色值。
- 颜色收口：后台首页的主操作卡、时间范围选中态和警告态改回沙漠金/项目危险色 token；商品数据分析、售后申请和我的页的小写白色与旧浅红色边框统一到当前设计系统。
- 业务保护：未改首页；未改任何 WXML/JS、云函数、权限、图表、售后申请提交、个人资料、tabBar 或页面路由。

2026-07-09 订单与退款颜色一致性收口记录：

- 执行决策：继续不调用 Figma 插件，并保持首页冻结，只处理非首页目标扫描中剩余的颜色写法不一致。
- 颜色收口：订单详情、后台订单和退款详情中的已付款徽标、取消按钮、凭证删除按钮统一使用 `#FFFFFF`，清理小写白色残留。
- 业务保护：未改首页；未改 WXML/JS、订单状态、付款状态、取消订单、退款处理、凭证上传/删除、权限、云函数或路由。

2026-07-09 全量静态验收补充记录：

- 执行决策：继续不调用 Figma 插件，基于当前本地代码做完成度证据补强，不改变首页冻结版。
- 验收覆盖：JSON、WXSS、路由文件完整性、WXML `view` 标签、JS 语法、WXML 事件绑定、`ui-*` 组件注册、`page-enter` 动画根节点和横竖屏根类均已做全量静态检查。
- 验收结论：静态检查通过；当前仍无法替代微信开发者工具真实编译、真机横屏、底部遮挡和低端机动效性能验收。
- 业务保护：全量验收未要求上传云函数、发布小程序或连接生产环境。

2026-07-09 商品详情横屏决策面板收口记录：

- 执行决策：保持首页冻结，不调用 Figma，只对商品详情横屏/宽屏决策区做低风险视觉收口。
- 结构收口：商品详情根节点新增 `product-detail-page`，横屏商品图从 560rpx 收紧到 500rpx，宽屏继续保留 560rpx；右侧商品信息、数量和配送卡片组成紧凑决策面板，减少横屏下大图挤压信息的问题。
- 业务保护：未改商品读取、收藏、加购、数量、配送、地址选择、预下单、幂等、自动审核、云函数或路由；普通用户仍不展示真实库存、成本价、供应商或 `internalTags`。

2026-07-09 订单列表下一步提示收口记录：

- 执行决策：保持首页冻结，不调用 Figma，只对 `pages/order/list` 做展示层优化，补齐“状态 -> 下一步 -> 详情”的卡片扫描路径。
- 结构收口：订单卡在金额摘要和付款状态之间新增紧凑下一步提示条，由现有订单状态和付款状态派生展示文案；状态色仅用于视觉引导，不新增付款、售后、发货或取消入口。
- 业务保护：未改 `getOrders` 参数、`deriveOrderFilter` 结果、分页、缓存、下拉刷新、tabBar 同步、订单状态码、付款状态码、云函数或路由；未新增付款截图、交易号、完整地址、完整手机号、后台备注、风险标签等敏感字段展示。

2026-07-09 首页关联入口列表收口记录：

- 执行决策：保持首页冻结，不调用 Figma，只收口从首页进入的收藏、常购和推荐列表页，避免主页高级感在二级列表中断裂。
- 结构收口：`pages/favorite/index`、`pages/frequent/index`、`pages/recommend/list` 统一为大标题、右侧数量胶囊、分区标题和紧凑商品队列；推荐列表保留搜索、分类胶囊和排序选择。
- 业务保护：未改首页、底部导航、三页 JS、商品查询、搜索归一化、分类、排序、整卡详情、加购、收藏/取消收藏、分页、下拉刷新、云函数、权限或路由；普通用户仍不展示真实库存、成本价、供应商、`internalTags` 或后台备注。

2026-07-10 售后详情进度层级收口记录：

- 执行决策：保持首页冻结，不调用 Figma，只对 `pages/after-sale/detail` 做展示层收口，让用户从售后详情顶部就能判断进度、退款状态和下一步物流动作。
- 结构收口：顶部状态卡加入三段进度条和指标格；申请说明、商品明细、审核结果、退货处理、处理记录统一为分区标题；待退货物流填写区改为提示面板。
- 业务保护：未改售后详情 JS、售后状态、退款状态、金额字段、物流提交参数、日志读取、云函数、权限或路由；未新增完整手机号、地址、付款截图、后台风险标签或其他敏感字段展示。

2026-07-10 固定操作栏真实预览修复记录：

- 执行决策：保持首页满意版冻结，不调用 Figma；使用微信开发者工具 Stable `v2.01.2510280` 的 iPhone 15 Pro 模拟器补做真实预览，并优先修复影响操作可达性的定位问题。
- 预览发现：主页、订单页和我的页信息层级与当前基准一致；购物车结算栏和商品详情底部操作栏在首轮预览中缺失，属于功能可见性问题而不是视觉偏好问题。
- 根因与修复：`page-enter` 根动画保留位移 `transform`，改变了后代固定定位上下文；将购物车、商品详情、地址列表、导入预览、后台订单、支付方式六页根节点改为无位移 `fade-in`，固定操作区重新相对手机视口定位。
- 真实验证：购物车的“全选 / 合计 / 提交预订单”已显示在浮动 tabBar 上方；商品详情的“加入购物车 / 立即预下单”已显示在屏幕底部；主页代码和视觉均未改动；微信开发者工具最终调试器为 `Errors: 0`。
- 业务保护：未改事件绑定、页面 JS、云函数、权限、支付、导入、订单、购物车、地址或预下单逻辑；未上传文件、未提交表单、未调用 Figma、未上传云函数、未发布小程序。

2026-07-10 付款页决策层级收口记录：

- 执行决策：保持首页冻结，不调用 Figma；按附件 App Store-like 的“单一主信息 + 紧凑辅助指标 + 清晰选择列表”处理订单付款页。
- 金额层级：主数字改为当前订单实际未付金额，账户总待付、历史未付和订单已付降为三列摘要；避免用户把账户总欠款误认为本次订单必须支付的金额。
- 方式列表：移除付款方式区域的卡片套卡片表现，改为带单选圆点、名称、类型、推荐标记和说明的连续列表；选中项仅使用浅沙金背景强调。
- 凭证流程：二维码、银行卡复制、微信支付、截图上传、备注和提交凭证仍按所选方式条件展示；凭证提交后继续进入财务确认，不显示到账成功文案。
- 真实验证：从真实待付款订单进入付款页，iPhone 15 Pro 首屏可看清订单金额、账户摘要和付款方式；下半页二维码、上传区、备注与提交按钮无重叠，微信开发者工具调试器为 `Errors: 0`。
- 业务保护：未改付款页 JS、云函数、支付配置、凭证上传、幂等、微信支付失败边界、财务确认语义或敏感信息可见范围；未执行真实付款、上传或提交动作。

2026-07-10 售后申请页表单压缩记录：

- 执行决策：保持首页冻结，不调用 Figma；按附件 App Store-like 的紧凑分区和信息优先级，将售后申请从六张步骤卡收敛为四个业务区块。
- 订单摘要：订单号只保留一处，可退金额作为主指标，订单金额、已付和已退作为三列辅助数据，删除重复五行金额明细。
- 申请信息：类型与原因并排，详细原因和客户备注连续呈现；保留最少字数提示、picker 和所有输入绑定。
- 售后范围：商品选择、申请数量和退款金额合并在一张卡中；问题凭证单独保留上传入口和最多 6 张说明，提交区与页面卡片同宽。
- 真实验证：从已付款订单进入申请页，iPhone 15 Pro 首屏能看到订单摘要、申请信息和售后范围开头，下半页商品、金额、凭证及提交区无遮挡；个人中心“我的售后”空状态正常；最终调试器为 `Errors: 0`。当前无售后记录，因此详情页未做运行时状态验证。
- 业务保护：未改售后申请 JS、云函数、类型/原因选项、金额上限、图片上传、幂等、退款或审核语义；未提交售后申请或执行生产写操作。

2026-07-10 地址操作区收口记录：

- 执行决策：保持首页冻结，不调用 Figma；按附件 App Store-like 的紧凑行动区处理地址卡，不重做地址表单。
- 列表操作：三个地址操作按钮改为同排等宽；默认地址不再显示不可用的“设为默认”，只保留编辑和删除，减少无效控件与卡片高度。
- 编辑操作：编辑默认地址时隐藏重复的“设为默认地址”；收货人、手机号、省市区、详细地址、标签、默认开关、保存和删除仍完整保留。
- 真实验证：iPhone 15 Pro 中地址卡操作不再换行，固定新增按钮未遮挡内容；编辑页字段完整，默认地址操作区只保留保存和删除；手机号在列表继续使用掩码，开发者工具为 `Errors: 0`。
- 业务保护：未改地址 JS、云函数、选择模式、本地地址桥接、默认地址语义或历史订单快照；未保存、删除、新增或更改真实地址。

2026-07-10 账号操作页信息密度收口记录：

- 执行决策：保持首页满意版与底部导航冻结，不调用 Figma；继续按附件的 App Store-like 简洁层级收口手机号和密码操作页。
- 手机号页：将当前状态、微信授权、手动填写三张卡合并为一个绑定面板；当前脱敏号码降为单行摘要，微信手机号作为主操作，手动填写保留为同卡备用路径；已绑定状态动态显示“更换手机号”。
- 密码页：删除卡片中第二套“设置/修改密码”标题、模式胶囊和重复说明，保留页面大标题与一组带标签的表单；首次设置和修改密码状态继续由原 `mode` 决定。
- 真实验证：微信开发者工具 Stable `v2.01.2510280` 的 iPhone 15 Pro 模拟器中，已绑定手机号、首次设置密码、修改密码三种状态均无溢出、遮挡或卡片套卡片；调试器为 `Errors: 0`，问题面板为 0。
- 业务保护：未改手机号绑定、微信授权、手动号码校验、密码校验、云函数、权限或返回逻辑；未提交号码、未设置或修改密码、未调用 Figma、未上传云函数、未发布小程序。

2026-07-11 四个主 Tab 参考图续优化记录：

- 范围重开：此前“首页满意版冻结”仍保留为历史决策；本轮因用户明确上传四张新参考图并要求继续优化，重新开放商品首页、购物车、订单列表、“我的”和 `custom-tab-bar`，未扩大到其他页面或云函数。
- 参考映射：图 1 对应商品首页的信息入口、搜索与商品层级；图 2 对应购物车商品清单和结算层级；图 3 对应订单筛选与摘要卡；图 4 对应个人资料、服务入口和设置列表。只提取布局、密度、色彩与交互层级，不复制参考图中的 VIP、企业认证、示例商品、虚构分类或不存在的业务按钮。
- 视觉方向：按 `finesse-ui` 的 `product` 路线执行，参数为 `SOUL=3`、`SPECTACLE=1`、`DENSITY=8`；使用暖白底、深墨主操作、克制沙金辅助色、红棕金额和暖色毛玻璃底部导航，不引入远程字体、图片热链、Three.js、GSAP 或外部运行时依赖。
- 页面结果：首页保留真实分类、常购/新货/热销、搜索、推荐与全部商品；推荐频道按用户确认恢复为三段式胶囊切换，推荐卡恢复浅金圆形 `+`，完整商品列表恢复浅金长胶囊 `+ 加购`；购物车保留选择、数量、配送、地址、价格变更和提交；订单保留动态筛选、真实状态、金额与下一步；个人页突出昵称和脱敏手机号，保留手机号、订单、地址、售后、后台、密码、协议和退出入口。
- 底部导航：按用户最新确认改为 `rgba(255, 253, 249, 0.86)` 暖色毛玻璃，使用单层 `blur(26rpx) saturate(135%)`、暖白实色回退、内高光和克制阴影；购物车角标使用组件内固定红棕/暖白色，继续显示真实数量并保留 `99+` 上限。
- 响应式收口：订单超宽屏使用双列卡片并将金额与种类/数量改为上下摘要，避免半宽卡片碰撞；购物车超宽屏使用商品主栏和紧凑结算侧栏，文字与数量器可安全换行；个人页普通横屏保持单列，仅真正宽屏进入双列。
- 真实验证：微信开发者工具 Stable `v2.01.2510290` 中完成 iPhone 15 Pro 竖屏、iPad 与 iPad Pro 12.9-inch 宽屏检查；最新一轮重新编译后，常购/新货/热销三段胶囊可实际切换，推荐卡浅金圆形 `+`、完整商品列表浅金长胶囊 `+ 加购`、毛玻璃底栏和真实角标 `4` 均正常显示；宽屏按钮规则已移除旧 `88rpx` 裁切。最后一次读取为 `Errors: 0`、问题面板 0；warnings 为当前环境/弃用提示。
- 业务保护：未改页面 JS、路由、云调用、订单/付款/发货/退款/地址语义、权限或脱敏逻辑；未展示真实库存、成本、供应商、后台备注、完整手机号/地址、付款截图或交易号；未调用 Figma、未上传云函数、未发布小程序。
