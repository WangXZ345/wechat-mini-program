# 网页后台权限与字段隔离设计

> 状态：第一轮权限冻结（2026-07-11）  
> 原则：前端菜单仅改善体验，后端鉴权和响应投影才是安全边界。

## 1. 身份权威

- `admin_users` 是管理员 principal、角色、状态和权限的唯一可信来源。
- `users.isAdmin`、浏览器传入的 `role/permissions/openid` 均不可信。
- 合法 Web 后台角色只有 `customer_service`、`finance`、`procurement`、`super_admin`。
- `user` 不得建立 Web 管理员会话，不得调用 Web 管理接口。
- 每次高风险请求重新读取 `admin_users`，校验 `isActive != false`、`status != disabled`、角色合法及所需权限。
- 超级管理员仍受库存事务、退款上限、订单状态机和幂等约束。

## 2. 页面权限矩阵

符号：`R` 只读，`W` 可执行职责内写操作，`-` 不可见/不可访问。

| 页面/模块 | user | customer_service | finance | procurement | super_admin |
| --- | --- | --- | --- | --- | --- |
| 登录 | 拒绝 | W | W | W | W |
| 工作台基础 | - | R | R | R | R |
| 商品管理 | - | - | - | W | W |
| 商品价格/标签/推荐 | - | - | - | W | W |
| 库存/预警/库存日志 | - | - | - | W | W |
| 报价/库存导入 | - | - | - | W | W |
| 商品销量和价格分析 | - | 可选 R | 可选 R | R | R |
| 订单 | - | W | R | - | W |
| 发货/合并发货 | - | W | R | - | W |
| 售后审核 | - | W | R | - | W |
| 付款审核 | - | - | W | - | W |
| 客户账款/对账 | - | - | W | - | W |
| 退款处理 | - | - | 仅已审核退款 W | - | W |
| 客户基础资料 | - | 掩码 R | 财务职责内 R | - | W |
| 管理员管理 | - | - | - | - | W |
| 操作日志 | - | 职责内 R | 职责内 R | 职责内 R | R |
| 系统设置 | - | - | - | - | W |

`customer_service` 和 `finance` 的商品分析只有在 `product:analytics:view` 被允许分配时显示；不因此扩展商品或库存写权限。

## 3. 接口权限矩阵

| 接口能力 | 所需权限 | customer_service | finance | procurement | super_admin |
| --- | --- | --- | --- | --- | --- |
| 工作台基础 | `dashboard:view_basic` | 允许 | 允许 | 允许 | 允许 |
| 销售/财务指标 | `dashboard:view_sales/finance` | 拒绝 | 允许 | 拒绝 | 允许 |
| 商品查询 | `product:view` | 按业务最小投影 | 按业务最小投影 | 允许 | 允许 |
| 商品创建/编辑 | `product:create/update` | 拒绝 | 拒绝 | 允许 | 允许 |
| 改价/上下架 | `product:update_price/status` | 拒绝 | 拒绝 | 允许 | 允许 |
| 库存查询/调整 | `inventory:view/update` | 拒绝 | 拒绝 | 允许 | 允许 |
| 库存/报价导入 | `inventory:import` | 拒绝 | 拒绝 | 允许 | 允许 |
| 订单查询/审核 | `order:view/review` | 允许 | 只读 | 拒绝 | 允许 |
| 订单拒绝 | `order:reject` | 允许 | 拒绝 | 拒绝 | 允许 |
| 付款查看/确认 | `payment:view_screenshot/confirm` | 拒绝 | 允许 | 拒绝 | 允许 |
| 账款 | `customer:view_account` | 拒绝 | 允许 | 拒绝 | 允许 |
| 发货 | `shipment:view/ship/update/merge` | 允许 | 只读 | 拒绝 | 允许 |
| 售后审核 | `after_sale:view/review` | 允许 | 只读 | 拒绝 | 允许 |
| 退款处理 | `refund:view/process` | 拒绝 | 已审核记录允许 | 拒绝 | 允许 |
| 管理员管理 | `admin:*` | 拒绝 | 拒绝 | 拒绝 | 允许 |
| 操作日志 | `operation_log:view` | 职责内 | 职责内 | 职责内 | 允许 |
| 同步事件 | 按角色 scope | 订单/发货/售后 | 付款/退款/账款 | 商品/库存 | 全部合法 scope |

服务端权限检查不能只依赖单个宽泛 `action`。BFF 路由必须将 HTTP method + route 映射到固定 handler 和权限，未知 action 直接拒绝。

## 4. 字段级脱敏

| 字段/数据 | user | customer_service | finance | procurement | super_admin |
| --- | --- | --- | --- | --- | --- |
| 真实库存 | 不返回 | 不返回 | 不返回 | 返回 | 返回 |
| 成本价/供应商/内部标签 | 不返回 | 不返回 | 不返回 | 职责内返回 | 返回 |
| 管理员备注/后台标签 | 不返回 | 职责内最小值 | 职责内最小值 | 不返回 | 返回 |
| 客户手机号 | 掩码/本人必要场景 | 掩码 | 财务必要场景可完整 | 不返回 | 权限内返回 |
| 客户地址 | 掩码/当前订单必要场景 | 掩码 | 财务必要场景按权限 | 不返回 | 权限内返回 |
| 付款截图/交易号 | 不返回 | 不返回 | 返回 | 不返回 | 返回 |
| 客户账款 | 不返回 | 不返回 | 返回 | 不返回 | 返回 |
| 退款账户/凭证 | 不返回 | 不返回 | 已审核退款返回 | 不返回 | 返回 |
| `openid`/内部 ID | 不返回 | 不返回 | 不返回 | 不返回 | 仅服务端使用，页面通常不返回 |
| password hash/salt/token | 永不返回 | 永不返回 | 永不返回 | 永不返回 | 永不返回 |

额外规则：

- `sync_events.changedFields` 只含字段名白名单，不含值。
- 列表默认返回摘要，完整敏感字段只在明确权限的详情 API 按需获取。
- 日志不写密码、令牌、完整手机号、完整地址、付款截图 URL、退款账户或 openid。
- Web 响应使用字段白名单，不使用 `{ ...raw }` 展开数据库记录。

## 5. 菜单映射

| 菜单组 | 菜单 | 权限条件 |
| --- | --- | --- |
| 总览 | 工作台 | `dashboard:view_basic` |
| 商品库存 | 商品管理 | `product:view` |
| 商品库存 | 库存管理 | `inventory:view` |
| 商品库存 | 库存预警 | `inventory:view` 或 `inventory:set_warning` |
| 商品库存 | 报价/库存导入 | `inventory:import` |
| 商品库存 | 商品分析 | `product:analytics:view` |
| 订单履约 | 订单 | `order:view` |
| 订单履约 | 发货/合并发货 | `shipment:view` |
| 财务 | 付款审核 | `payment:confirm` 或 `payment:view_screenshot` |
| 财务 | 客户账款 | `customer:view_account` |
| 售后 | 售后审核 | `after_sale:view` |
| 售后 | 退款处理 | `refund:view` |
| 管理 | 管理员 | `admin:view` |
| 管理 | 操作日志 | `operation_log:view` |
| 管理 | 系统设置 | `system:settings` |

菜单与路由使用同一 `RouteAccess` 配置。隐藏菜单不代表获得或失去权限；直接输入 URL 仍由路由守卫和后端拒绝。

## 6. 网页路由守卫

路由守卫顺序：

1. 等待 `authStore.bootstrap()` 完成。
2. `requiresAuth` 且无有效会话时跳转 `/login`，保留安全的相对 redirect。
3. 后端 profile 返回 `user`、非法角色、disabled 或 inactive 时清会话并拒绝。
4. 检查 route meta 中 `roles`、`permissionsAny`、`permissionsAll`。
5. 不满足时进入 `/403`，不预取受限页面数据。
6. 角色/权限变更事件到达时重新获取 profile；当前路由不再合法则退出该页面。

前端不得从 URL、localStorage 或请求参数恢复 role/permissions。

## 7. 后端权限校验

每个请求执行：

```text
校验来源/CSRF
-> 解析会话或受信 WXContext
-> 查询 admin_users
-> 校验 active/status/合法 role/authVersion
-> 计算角色允许权限
-> 固定路由权限校验
-> DTO 校验
-> 字段投影/领域 service 二次校验
-> 审计
```

Web `ActorContext` 只能由服务端构造。业务 service 不能信任 BFF 传入的价格、库存、付款状态、退款上限或当前角色；必须从数据库重新读取并验证。

## 8. Web 会话与凭证

### 8.1 凭证

- `admin_web_credentials` 通过 `adminId` 关联 `admin_users`。
- 密码使用 scrypt（或部署验证可用的 Argon2id）和每账号随机盐；保存算法与参数版本。
- 最少 12 位；未知账号也执行 dummy hash，统一返回 `INVALID_CREDENTIALS`。
- 管理员 Web 凭证不能放入当前会被原样展开的 `admin_users` 响应。

### 8.2 会话

- Access token 10-15 分钟，只在内存使用，服务端只保存 SHA-256 hash。
- Refresh token 7 天滑动、30 天绝对上限，轮换并检测复用。
- 同源部署使用 `__Host-admin_refresh`、`HttpOnly`、`Secure`、`SameSite=Lax` Cookie。
- Session 记录绑定 `adminId`、`sessionId`、token hash、`authVersionSnapshot`、有效期、最后活动、撤销时间和散列后的 IP/UA。
- 角色变更、禁用和改密递增 `authVersion` 并撤销相关会话。
- 登录限流必须持久化，不能使用函数实例内存对象。

若部署条件无法提供同源安全 Cookie，先增加同域 BFF，不降级为长期 `localStorage` 令牌。

## 9. 已知现有风险

- `getAdminUsers` 和部分 admin profile 路径可能展开原始管理员记录，Web 必须改为白名单响应。
- `getCurrentAdminProfile` 当前会在读取时 seed 权限数据，Web 高频 profile 不应产生写副作用。
- `paymentMethods`、`afterSales` 的 `_callerOpenid` 回退字段不得作为 Web 身份入口。
- auth/permissions/phone 多份副本存在规则漂移；修改权限时必须同步构建产物并校验 hash。
- 现有地址兼容逻辑曾允许采购查看完整地址，与本设计冲突；Web 投影必须立即拒绝，公共规则在测试回归后再统一修正。
- `createAdminUser`、`updateAdminRole` 当前存在阻断逻辑；恢复前必须补齐邀请/设密、最后一名超级管理员保护、会话吊销和审计。

## 10. 权限验收准则

- 对五种角色逐路由、逐 API、逐敏感字段验证。
- 采购请求付款/退款/账款/完整联系方式返回 403，响应体也不得夹带字段。
- 财务不能修改商品库存或审核售后，不能处理未审核退款。
- 客服不能调整库存、确认付款或最终退款。
- user、disabled、inactive、非法 role 均不能建立会话。
- super_admin 的重复确认、超额退款和非法库存操作仍被业务规则拒绝。

