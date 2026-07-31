# 美妆批发后台极空间外网部署设计

日期：2026-07-23  
状态：待用户复核  
目标环境：CloudBase 测试环境 `cloud1-d7g4mbc5r2fac4a77`  
公网入口：极空间自带 HTTPS 远程访问地址

## 1. 目标与完成条件

将现有 `admin-web/` 从依赖 Windows 本机 `127.0.0.1:4173` 的开发服务，迁移为极空间 NAS 上可自动恢复、可从外网访问的单容器服务，同时继续读取小程序所在测试环境的真实业务数据。

完成条件：

1. NAS 重启或容器异常退出后，后台能自动恢复运行。
2. 用户通过极空间提供的固定 HTTPS 地址访问登录页。
3. 浏览器只访问同源 `/api/admin/v1`，不直接持有 CloudBase action secret。
4. 管理员可登录，并能读取工作台、商品、订单、付款和账款真实测试数据。
5. refresh cookie、CSRF、权限和字段脱敏边界保持不变。
6. 同步轮询可继续工作；不承诺固定 1–3 秒延迟。
7. 不连接生产环境、不发布小程序、不修改核心业务数据。

## 2. 不在本次范围

- 不把小程序客户订货端改成网页商城。
- 不迁移或复制 CloudBase 数据库。
- 不新增生产域名、生产环境或正式发布流程。
- 不修改订单、库存、账款、付款、退款等业务语义。
- 不把管理员密码、pepper、token、cursor secret 或 action secret 写入仓库、镜像或浏览器产物。
- 不解决当前与部署无关的已有未提交修改。

## 3. 推荐架构

采用一个专用 Node.js 生产容器：

```text
外网浏览器
  -> 极空间 HTTPS 远程访问
  -> NAS 容器公开端口
     -> 静态文件服务：admin-web/dist
     -> 同源代理：/api/admin/v1/**
        -> CloudBase 测试环境 HTTP 网关
           -> adminWebAuth / adminWebApi
           -> 测试环境业务集合
```

选择单容器而不是 Vite 开发服务器的原因：

- 只保留一个需要监控和重启的服务。
- 前端与 API 保持同源，现有 HttpOnly Cookie 和 CSRF 设计可以继续使用。
- action secret 只在服务端内存和 NAS 私密挂载文件中出现。
- 可以明确处理 SPA fallback、静态缓存、代理超时和健康检查。
- 不把开发服务器暴露到公网。

## 4. 容器组件

### 4.1 多阶段镜像

构建阶段使用 Node 20：

1. 安装锁定依赖。
2. 运行 test + real 模式构建。
3. 执行现有真实构建扫描，拒绝 Mock 数据和私密配置进入产物。

运行阶段只包含：

- `admin-web/dist/`
- 最小生产网关脚本
- Node 运行时

运行阶段不包含源代码依赖树、测试工具、`.env` 或本机私密配置。

### 4.2 静态文件服务

- `/assets/**` 使用长期缓存和 immutable。
- `index.html` 禁止长期缓存，避免更新后继续加载旧入口。
- 未匹配 API 的前端路由返回 `index.html`。
- `/healthz` 返回不含敏感信息的健康状态。
- 禁止目录浏览。

### 4.3 BFF 反向代理

只代理 `/api/admin/v1/**` 到已确认的 CloudBase 测试网关。

代理必须：

- 保留 HTTP 方法、路径、query、请求体和必要响应头。
- 覆盖而不是透传浏览器提供的 `Origin`。
- 注入固定的极空间公网 HTTPS Origin。
- 从只读 secret 文件读取并注入 `X-Admin-Action-Secret`。
- 不在日志中记录 Authorization、Cookie、Set-Cookie、CSRF、action secret 或请求体。
- 保留 `Set-Cookie`，使 refresh session 仍由同源 HttpOnly Cookie 管理。
- 普通请求使用与现有前端一致的超时边界；同步补偿请求允许 45 秒以上。
- 对写请求不做自动重试；浏览器 transport 的幂等规则保持现状。

## 5. 配置与密钥

公开配置可放入 Compose 环境变量：

- `ADMIN_WEB_PUBLIC_ORIGIN`：极空间生成的 HTTPS origin，只包含 scheme + host + 可选端口。
- `ADMIN_WEB_BFF_TARGET`：当前测试环境 CloudBase 网关 origin。
- `PORT`：容器监听端口。
- `NODE_ENV=production`

私密配置：

- `ADMIN_WEB_ACTION_SECRET_FILE=/run/secrets/admin_web_action_secret`

action secret 内容存放在 NAS 管理员专用目录，通过只读文件挂载进入容器。Compose 文件只保存文件路径，不保存 secret 值。

容器启动时必须校验：

- 公网 Origin 是 HTTPS 且不含 path、query、hash 或账号密码。
- BFF target 是 HTTPS。
- secret 文件存在、非空且长度符合现有安全要求。
- 配置失败时直接退出，不降级为 Mock 或不安全代理。

## 6. CloudBase Origin 调整

极空间远程访问创建后会得到最终 HTTPS 地址。必须把它加入测试环境以下云函数的 `ADMIN_WEB_ALLOWED_ORIGINS`：

- `adminWebApi`
- `adminWebAuth`

调整方式：

- 保留现有本机测试 Origin，追加极空间 HTTPS Origin，避免破坏本地回退入口。
- 两个云函数使用完全一致的 allowlist。
- 不改变 action secret、token/password pepper、bootstrap secret、cursor secret 等其他配置。
- 修改并上传前必须再次取得用户对测试环境云函数操作的明确确认。
- 云函数名按 A–Z 上传：`adminWebApi`、`adminWebAuth`。

如果极空间远程访问地址发生变化，必须先更新 allowlist，再切换入口；否则登录和 API 会返回 `ORIGIN_NOT_ALLOWED`。

## 7. 极空间部署顺序

1. 在本地完成容器文件和生产网关实现。
2. 运行单元测试、类型检查、ESLint、真实模式构建和产物扫描。
3. 本地构建并启动容器，验证静态页面、SPA fallback、健康检查和代理错误边界。
4. 将部署目录上传到极空间的受限目录。
5. 在极空间 Docker/Compose 图形界面创建项目，配置端口、只读 secret 挂载、健康检查和 `restart: unless-stopped`。
6. 启动容器并先在局域网验证。
7. 在极空间“远程访问”中将该容器网页端口添加为外网应用，取得 HTTPS 地址。
8. 将最终 HTTPS Origin 写入容器公开配置并重启容器。
9. 经用户明确确认后，更新测试环境两个云函数的 Origin allowlist。
10. 完成外网登录、真实读取和同步验收。

## 8. 安全设计

- 公网只开放极空间 HTTPS 入口，不直接暴露 CloudBase action secret。
- 容器端口优先仅由极空间反向代理访问；是否同时保留 LAN 端口由极空间能力决定。
- 网关设置基础安全响应头，包括 `X-Content-Type-Options`、`Referrer-Policy` 和合理的 CSP。
- 不在前端 localStorage 保存 access/refresh token；沿用当前内存 access token、HttpOnly refresh cookie 和 sessionStorage CSRF。
- 健康检查不访问业务数据，不输出环境 ID 以外的私密配置。
- 日志只记录时间、方法、规范化路径、状态码、耗时和随机 request id。
- NAS 账号必须启用强密码；如设备支持，启用双重认证。

## 9. 验证清单

### 9.1 本地静态验证

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`
- 容器镜像构建成功。
- 镜像/产物扫描未包含演示账号、Mock 数据、action secret 或本机私密路径。

### 9.2 本地容器验证

- `/healthz` 返回 200。
- `/login` 和深层 SPA 路由刷新可正常加载。
- 未配置、错误或缺失 secret 时容器拒绝启动。
- API 代理不接受浏览器伪造的上游 Origin/action-secret。
- 静态 404、API 404 和网关不可达错误不会回退成 `index.html`。

### 9.3 NAS 局域网验证

- 容器状态 healthy。
- 重启容器后自动恢复。
- NAS 重启后自动启动。
- 局域网页面加载正常；在 CloudBase allowlist 完成前，不把 API 403 误判为网页部署失败。

### 9.4 外网真实测试环境验收

- 极空间 HTTPS 地址可打开登录页。
- 管理员登录成功，refresh cookie 为 Secure、HttpOnly。
- 工作台、商品、订单、付款、账款读取成功。
- 无权限角色仍返回 403 或不含敏感字段。
- 同步轮询能恢复并更新页面状态。
- 浏览器控制台无 mixed-content、CORS、cookie 或 CSP 错误。
- CloudBase 与容器日志不包含密码、token、Cookie、手机号、地址或付款敏感内容。

## 10. 更新与回滚

更新：

1. 本地完成并验证新镜像。
2. 为镜像使用明确版本标签，不覆盖唯一可回滚标签。
3. 在极空间更新 Compose 镜像标签并重新创建容器。
4. 登录和核心只读路径通过后再清理旧镜像。

回滚：

1. 将 Compose 镜像标签切回上一版。
2. 重新创建容器。
3. 如果只是容器故障，CloudBase allowlist 可继续保留极空间 Origin。
4. 如果极空间公网地址被废弃，再从两个测试云函数 allowlist 中移除该 Origin。

回滚不修改业务数据库，也不需要回滚小程序前端。

## 11. 交付边界

本设计批准后，实施阶段预计新增或修改：

- `admin-web/Dockerfile`
- `admin-web/.dockerignore`
- `admin-web/docker-compose.zspace.yml`
- `admin-web/server/` 下的最小生产网关及测试
- `admin-web/README.md` 的极空间部署说明
- 可选的 NAS 部署示例目录，但不包含真实 secret

实施完成后将明确区分：

- 本地新增的容器和网关文件；
- 已在极空间创建的容器与远程访问入口；
- 已更新并上传的测试云函数配置；
- 尚未触碰的生产环境和小程序发布。
