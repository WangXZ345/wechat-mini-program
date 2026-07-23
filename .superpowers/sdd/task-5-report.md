# Task 5 Report: Docker 与极空间 Compose 包

## 变更摘要

- 新增 `admin-web/Dockerfile`：以 `node:20-alpine` 多阶段构建真实模式；构建阶段执行 `npm ci`、gateway 测试和既有真实构建扫描；运行阶段仅复制 `dist/` 与 `server/`，以非 root `node` 用户监听 `8080`，并提供 `/healthz` healthcheck。
- 新增 `admin-web/.dockerignore`：排除 Git、依赖、构建产物、报告、日志、`secrets` 与私有环境文件；显式保留公开的 `.env.test` 以支持真实模式构建。
- 新增 `admin-web/docker-compose.zspace.yml`：面向极空间 Compose UI 的单服务模板，使用 `18080:8080`、`restart: unless-stopped`、只读 secret bind mount；未通过环境变量传入 action secret。另启用只读根文件系统、`/tmp` tmpfs、`no-new-privileges` 与移除 Linux capabilities。
- 新增 `admin-web/zspace.env.example`：仅包含公开首启 `ADMIN_WEB_PUBLIC_ORIGIN=https://bootstrap.invalid` 和唯一测试 BFF target。
- 新增 `admin-web/server/container-contract.test.mjs`，并纳入 `test:gateway`，静态约束 Dockerfile、`.dockerignore`、Compose 和公开环境模板。

## RED / GREEN

- RED：首次执行 `node --test server/container-contract.test.mjs` 时，3 个契约测试均因 `Dockerfile`、`.dockerignore` 和 Compose 文件不存在而失败（`ENOENT`）。
- GREEN：配置文件实现后，容器契约测试 3/3 通过；完整 gateway 测试 60 通过、1 跳过、0 失败。跳过项是 Windows 当前权限不允许测试创建文件 symlink，属于既有静态处理测试环境限制。

## 检查结果

- 使用 bundled Node 24.14.0 直接执行完整 `node --test` gateway 测试集合：通过（60 pass、1 skip、0 fail）。本机 `npm` 不在 PATH，因此未能直接调用 `npm run test:gateway`；执行的 Node 测试文件与该脚本完全一致。
- 使用 bundled Node 执行真实模式 build 等价链：`vue-tsc --noEmit`、`vite build --mode test` 和 `scripts/verify-real-build.mjs` 均通过；真实构建扫描了 61 个文本资源。
- 新增 `server/container-contract.test.mjs` 的 ESLint 检查通过。
- `git diff --check` 针对 Task 5 文件通过。
- 全量 `eslint . --max-warnings=0` 未通过，原因是仓库既有 server Node globals / control-regex 配置问题；本任务新增测试的 lint 问题已修复，未扩大修改现有 lint 配置。
- `Get-Command docker` 返回 `DOCKER_NOT_INSTALLED`。

## 未验证边界

- 未运行 `docker compose ... config`、未构建镜像、未检查 image history 或容器文件系统；本机未安装 Docker。
- 未在极空间执行 Compose UI 导入、镜像构建、启动、healthcheck、secret bind mount 或多架构运行时验证。以上应由 Task 7 在目标极空间环境完成。
- 未创建真实 secret、`.env` 或任何生产连接；未上传、未发布、未 push/merge。

## Fix Review: RED / GREEN

- RED command: `node --test server/container-contract.test.mjs`（使用 bundled Node）。输出为 `pass 1`、`fail 2`：Dockerfile 仍整目录复制 `/app/server` 且采用 `wget`，Compose 仍使用普通 `volumes` bind mount，未声明 top-level secret。
- GREEN command: `node --test server/container-contract.test.mjs`。输出为 `pass 3`、`fail 0`。契约现强制：构建阶段 `package-lock.json` + `npm ci`、`.env.*` 排除且显式 `!.env.test`、运行阶段仅复制五个生产模块且禁止任何 `*.test.mjs`、non-root `USER node`、Node 20 `fetch` healthcheck、Compose hardening、top-level secret 的 source/target/mode/file 层级与唯一 BFF target。
- 运行时镜像现在只包含 `dist/` 和五个 gateway 生产模块（`config.mjs`、`static-handler.mjs`、`proxy-handler.mjs`、`server.mjs`、`index.mjs`）；不复制 `server/` 目录、测试或容器契约测试。
- Compose 使用 top-level `admin_web_action_secret`，来源为相对 Compose 目录的 `./secrets/admin_web_action_secret`，服务采用 long syntax 以 `/run/secrets/admin_web_action_secret` 的默认 target 文件名挂载并设置 mode `0444`；保留 `ADMIN_WEB_ACTION_SECRET_FILE` 文件路径，不传入 secret 值。
- Task 6 文档交接要求：必须明确宿主 `secrets/admin_web_action_secret` 文件只应由管理员读取，且上述相对路径以 Compose 文件目录为基准。

## Fix Review: 验证边界

- 完整 gateway 测试与真实模式构建/扫描仍在本机以 bundled Node 执行；Docker 仍不可用，因此未运行镜像 build、`docker compose config`、image history 或容器文件系统检查。
