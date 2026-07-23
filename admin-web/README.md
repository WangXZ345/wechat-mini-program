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

## 极空间部署（测试环境）

以下步骤只面向隔离测试环境的极空间 Docker Compose 项目；不发布小程序、不连接生产环境，也不将 secret 粘贴到聊天、截图或 Git。上传 `admin-web/` 后，建议使用管理员可写、普通用户不可浏览的项目目录，例如：

```text
<极空间受限目录>/beauty-wholesale-admin-web/
├── docker-compose.zspace.yml
├── zspace.env                 # 从 zspace.env.example 复制；不提交
├── Dockerfile
├── server/
├── dist/                       # 由镜像构建产生，不必手工复制
└── secrets/
    └── admin_web_action_secret # 宿主机 secret；不提交、不截图
```

Compose 项目目录就是上述 `beauty-wholesale-admin-web/`；`docker-compose.zspace.yml` 中的 `./secrets/admin_web_action_secret` 相对此目录解析。`zspace.env.example` 只包含可公开的变量，首次启动可临时保留 `ADMIN_WEB_PUBLIC_ORIGIN=https://bootstrap.invalid`，顶层 secret 必须单独保存在 `secrets/admin_web_action_secret`，不得写进 Compose 环境变量、`zspace.env` 或镜像。

容器以 UID 1000 运行。因此在宿主机上，secret 文件必须由数值 UID 1000 拥有并设为 `0400`，或使用 ACL 仅向 UID 1000 授予只读权限。启动前和后续 Task 7 均须在容器内验证该文件实际可读；如果验证失败，停止处理权限问题，绝不能改成 `0444`、全局可读，也不能改为 root 运行时绕过问题。

### 部署顺序

1. 将已验证的 `admin-web/` 上传至极空间中仅管理员可写的 Compose 项目目录，并在该目录创建 `secrets/admin_web_action_secret`；不要截图或把内容写入 Compose。
2. 复制 `zspace.env.example` 为同目录的私有 `zspace.env`。首次仅使用 `ADMIN_WEB_PUBLIC_ORIGIN=https://bootstrap.invalid`；`ADMIN_WEB_BFF_TARGET` 必须是已经确认的隔离测试 BFF HTTPS 地址。
3. 在极空间 Docker 的 Compose 项目界面导入同目录 `docker-compose.zspace.yml`，确认项目目录正确、默认宿主端口为 `18080`，然后启动。只先验收服务状态为 `healthy` 和容器内 secret 可读；不要把 bootstrap 地址用于登录。
4. 在极空间远程访问中把宿主端口 `18080` 添加为网页服务。记录极空间给出的完整 HTTPS 地址，并从中精确提取 `scheme + host + 可选端口` 作为 `ZSPACE_PUBLIC_ORIGIN`。
5. 若远程访问 URL 带有 path-prefix（例如 `https://host/prefix/`），立即停止部署：当前网关按站点根路径设计，须先设计并验证 base-path 支持；不要通过修改 CloudBase 配置来规避该问题。
6. 用精确的 `ZSPACE_PUBLIC_ORIGIN` 替换 `zspace.env` 中的 bootstrap origin，在 Compose GUI 中重新创建容器，并再次确认 `healthy`、`/healthz` 和容器内 secret 读取。
7. 仅在用户明确确认后，才分别把该精确 origin 加入测试环境两个云函数的 allowlist：`adminWebApi`、`adminWebAuth`（A-Z 顺序）。保留本地 origin，不使用 wildcard；此步骤不上传或发布小程序。
8. 最终验收只做外网登录和代表性的真实读取。不得以订单、库存、账款、付款或客户数据写操作来证明连通性。

### 更新、版本标签与回滚

更新前记录正在运行的镜像标签（当前 Compose 示例为 `beauty-wholesale-admin-web:2026-07-23`）、Compose 文件版本和当前可用的 `ZSPACE_PUBLIC_ORIGIN`。更新时先在本地完成本 README 的验证命令，再上传同一版本的项目目录，在 Compose GUI 中将 `image` 标签改为新的明确版本标签后重新创建容器，并复核健康检查与只读验收。

如需回滚，将 Compose 中镜像标签切回上一条已记录标签并重新创建容器。镜像回滚不修改业务数据库；只有远程 HTTPS 地址确认废弃后，才在用户确认后从测试 allowlist 中删除对应 origin。不得删除 local origin 或以 wildcard 替代精确 origin。

## 部署边界

本轮仅准备了极空间测试环境的 Compose 包和部署说明，尚未在 Docker、极空间 NAS 或真实远程 HTTPS origin 上运行或验证；也尚未执行本轮任何云函数 allowlist 修改、云函数上传、Web 部署或小程序发布。真实验收应让 Web 测试版和小程序体验版访问同一套隔离测试业务库，并通过同源 HTTPS `/api` 转发到 Web BFF；本地检查、镜像构建和容器健康检查均不能替代该验收。
