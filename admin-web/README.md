# 网页后台管理系统

独立的 Vue 3 + Vite + TypeScript 网页后台。微信小程序仍是客户订货端；本工程只通过受认证的 Web BFF 调用共享业务服务，不直接连接 CloudBase 数据库，也不保存第二套业务数据。

## 运行模式

数据模式与环境名称分离：

| 配置 | 说明 |
| --- | --- |
| `VITE_DATA_MODE=real` | 只使用 `HttpBffTransport`；失败时不会回退 Mock |
| `VITE_DATA_MODE=mock` | 只使用本地 `MockTransport` 和虚构掩码数据 |
| `VITE_APP_ENV=local/test/staging/production` | 环境名称，不再决定数据来源 |
| `VITE_CLOUDBASE_ENV_ID` | 公开的 CloudBase 环境标识；real 模式必填 |
| `VITE_API_BASE_URL` | BFF 地址；real 模式必填，测试默认同源 `/api/admin/v1` |
| `VITE_REQUEST_TIMEOUT_MS` | 请求超时，测试默认 12000ms |
| `VITE_REALTIME_MODE=mock/polling/off` | 同步通道；real 模式禁止 `mock` |
| `VITE_RELEASE` | 前端发布标识，不得包含密钥 |

real 模式缺少环境 ID 或 API 地址时会拒绝启动和构建。当前 `.env.test` 只包含可公开的测试配置，并固定到测试环境 `cloud1-d7g4mbc5r2fac4a77`；不得用该文件指向生产环境。

## 本地启动

需要 Node.js 20.19 或更高版本及 npm，依赖已安装时无需再次安装。

默认命令启动 test + real 模式：

```bash
npm run dev
```

开发服务器固定为 `http://127.0.0.1:4173` 并启用 `strictPort`。当前没有已确认的 BFF URL，所以未配置代理时：

- 登录页显示“未配置测试 BFF 连接”；
- `/api/admin/v1/**` 返回结构化 `503 BFF_PROXY_NOT_CONFIGURED`；
- 不返回 Vite 的 `index.html`，也不回退演示数据。

获得已确认的测试 BFF URL 后，只给开发服务器设置非 `VITE_*` 环境变量：

```powershell
$env:ADMIN_WEB_BFF_PROXY_TARGET = "https://confirmed-test-bff.example"
$env:ADMIN_WEB_BFF_PROXY_ORIGIN = "http://127.0.0.1:4173"
$env:ADMIN_WEB_ACTION_SECRET = "从安全配置读取，不要写入仓库"
npm run dev
```

这三个 `ADMIN_WEB_*` 值只由 Vite 开发服务器读取，不会打进浏览器产物。代理会覆盖浏览器传入值，向 BFF 注入经校验的 `Origin` 和 `X-Admin-Action-Secret`。配置了 target 但缺少 origin 或 secret 时，开发服务器会拒绝启动；当前尚无已确认 URL 或 secret，不要填写猜测值。

`VITE_API_BASE_URL` 只接受 `/api/...` 形式的单斜杠同源路径，或不含账号密码、query、hash 的绝对 HTTP(S) URL；`//host`、反斜杠和相对路径会被拒绝。远程地址必须使用 HTTPS，只有 `test` 环境的 loopback 地址可使用 HTTP。proxy target 使用同一安全策略，proxy origin 还必须是无路径的纯 origin。

显式启动本地 Mock：

```bash
npm run dev:mock
```

Mock 登录：

- `procurement.demo` / `demo-pass`
- `customer_service.demo` / `demo-pass`
- `finance.demo` / `demo-pass`
- `super_admin.demo` / `demo-pass`

Mock 记录均为虚构掩码数据，不连接 BFF、CloudBase 或小程序业务库，页面刷新会重置内存业务数据。

## 构建

默认构建固定使用 test + real：

```bash
npm run build
```

该命令在构建后执行 `scripts/verify-real-build.mjs`。如果产物包含 `demo-pass`、`.demo` 演示账号、`MockTransport`、`mockRows`、演示商品记录、服务端 action-secret 配置名/header 名，或当前环境中的真实 action secret 值，构建会失败。

只有组件演示或本地 Mock 验收可以显式构建：

```bash
npm run build:mock
```

`build:mock` 不能作为测试环境或正式环境产物。

## HTTP BFF 与会话

`HttpBffTransport` 统一处理 `{ ok, data, code?, message?, requestId?, serverTime?, meta?, error? }`。安全读取遇到网络错误或 5xx 最多重试一次；业务写不做网络重试，401 刷新后只重放一次且保持原 `Idempotency-Key`。

- access token 只保存在 Web 内存，通过 `Authorization: Bearer` 发送。
- refresh token 只能由同源 BFF 写入 `HttpOnly; Secure; SameSite` Cookie。
- CSRF token 只存当前标签页 `sessionStorage`，不写 `localStorage`。
- `/auth/profile` 使用 POST；没有任何本地会话材料时不会发送无意义 refresh 请求。
- login、refresh、远程 logout 串行执行；logout 先同步清空本地身份和轮询状态，迟到的旧响应不能覆盖新会话。
- profile 在 transport 边界做字段白名单归一，浏览器不展开数据库原记录。

## 页面与权限

已实现登录、工作台、商品、库存、库存预警、报价导入、库存导入、订单、商品分析、付款、账款、发货、售后、退款、管理员、操作日志、系统设置、403 和 404；商品与订单有独立详情路由。

菜单和路由守卫共用 `src/config/navigation.ts` 与 `src/config/access.ts`。前端权限只改善体验，真实 BFF 必须基于 `admin_users` 重新验证角色、状态、权限和字段投影。采购角色不会获得付款、退款、客户账款、完整手机号或完整地址页面。

当前 HTTP 模式的业务写服务仍未迁移，资源写按钮、导入和设置保持只读；不能把 real 模式描述为完整可写后台。

## 实时同步

`CursorSyncClient` 使用 cursor 补偿和 2 秒前台轮询基线，支持断网状态、指数退避、页面恢复补齐和局部缓存失效。事件只触发重新查询，不携带完整敏感业务值，也不会触发业务写操作。

真实 1-3 秒双端同步必须在隔离测试环境部署 BFF、事件 outbox 和小程序同步客户端后再验收。本地 real 构建通过不代表同步已验证。

## 验证

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

`npm run test:e2e` 需要已安装 Playwright Chromium。本地 Mock、静态检查和构建不能替代真实 BFF、数据库权限、Cookie/CSRF、事务幂等或小程序双端同步测试。

## 部署边界

本工程当前只完成本地 Web 前端、真实/Mock 构建隔离和 transport 契约。尚未上传云函数、创建数据库集合或索引、连接测试/生产数据、部署 Web、发布小程序。测试部署时应让 Web 测试版和小程序体验版访问同一套隔离测试业务库，并通过同源 HTTPS `/api` 转发到 Web BFF。
