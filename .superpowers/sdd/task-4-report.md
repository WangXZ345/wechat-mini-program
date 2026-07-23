# Task 4 执行报告：生产服务器、安全响应头与优雅退出

## 变更摘要

- 新增 `admin-web/server/server.mjs`
  - 组合 Task 1–3 已有的 `createProxyHandler` 与 `createStaticHandler`，未重写其安全逻辑。
  - API 优先交给代理；代理拒绝 API 路径时直接返回固定 JSON 404，不进入 SPA。
  - health、静态、API、404、500 均带本地安全响应头。
  - CSP 只允许本地脚本与连接；为 Vue/Element Plus/ECharts 保留本地资源、内联样式、`data:`/`blob:` 图片和本地字体能力；禁止远程脚本、`object`、frame。
  - handler 在 headers 未发送时抛错，返回固定脱敏 JSON 500；headers 已发送时只销毁响应，不拼接第二个响应。
- 新增 `admin-web/server/index.mjs`
  - 读取 `loadGatewayConfig` 后创建真实生产 server 并监听 `0.0.0.0`。
  - 配置失败和监听失败使用固定错误文案、设置非零退出码，不输出异常详情或 secret。
  - `SIGTERM`/`SIGINT` 先停止接收新连接并关闭 idle 连接；生产默认 10 秒宽限后强制关闭剩余连接，避免活跃流无限阻塞退出。
- 新增 `admin-web/server/server.test.mjs`
  - 所有 HTTP 集成测试使用 loopback 和临时端口；上游夹具也只在本机运行。

## RED / GREEN

### 第一轮：server 工厂

- RED 命令：
  - bundled Node `--test server/server.test.mjs`
- RED 结果：
  - `ERR_MODULE_NOT_FOUND`，缺少 `server/server.mjs`，符合预期。
- GREEN 结果：
  - 服务组合层专项测试 7/7 通过。

### 第二轮：入口与关闭

- RED 命令：
  - bundled Node `--test server/server.test.mjs`
- RED 结果：
  - `ERR_MODULE_NOT_FOUND`，缺少 `server/index.mjs`，符合预期。
- GREEN 结果：
  - Task 4 专项测试 11/11 通过。

## 验证结果

- Task 4 专项：11 tests，11 pass，0 fail，0 skip。
- 完整 gateway 套件（package.json 中 `test:gateway` 的等价展开命令）：
  - 58 tests，57 pass，0 fail，1 skip。
  - skip 是 Windows 环境无法创建文件 symlink（`EPERM`），属于既有静态 handler 测试的显式跳过分支。
- `node --check`：
  - `server/server.mjs`
  - `server/index.mjs`
  - `server/server.test.mjs`
  - 全部 exit 0。
- `git diff --check -- admin-web/server admin-web/package.json`：exit 0。
- Task 4 三个文件在显式补充 Node globals 后执行 ESLint：exit 0。

说明：bundled Node 路径只有 `node.exe`，没有 `npm.cmd`，因此未直接执行 `npm run test:gateway`，而是按 `package.json` 原样展开为：

```text
node --test server/config.test.mjs server/static-handler.test.mjs server/proxy-handler.test.mjs server/server.test.mjs
```

## 自查

- 未改动 Task 1–3 的 `config.mjs`、`static-handler.mjs`、`proxy-handler.mjs` 或其测试。
- 未给 `createAdminWebServer` 暴露测试专用方法；依赖注入仅接受正常的 handler/server/runtime 组合边界。
- API 502 和 404 均保持 JSON，不回退 `index.html`。
- 静态资源 404 保持 `text/plain`，未伪装为 API envelope。
- 上游传入的不安全 CSP 与 `X-Frame-Options` 未进入客户端响应；响应使用本地固定安全值。
- streaming handler 在 headersSent 后抛错时，客户端只观察到被中止的部分响应，没有追加 `GATEWAY_INTERNAL_ERROR`。
- 配置失败与端口冲突子进程均 code 1，stderr 不含测试 secret。
- `SIGTERM` 与 `SIGINT` 均覆盖活跃响应强制收尾，测试上限 500ms 内完成并移除信号监听。
- 未 push、merge、上传、发布或连接生产；测试上游仅为 loopback 临时服务。

## 关注点

- 仓库当前 `eslint.config.js` 只为 `*.ts`/`*.vue` 配置 Node globals；直接 lint 任意 `*.mjs` 都会产生 `process`、`Buffer`、`URL` 等 `no-undef`。本任务未扩大范围修改共享 ESLint 配置，专项 lint 通过 CLI 显式补充 Node globals 完成。
- 生产优雅退出默认宽限为 10 秒；测试将该值缩短为 30ms，以验证活跃响应不会导致无限挂起。
- 本次是本地隔离分支代码与自动化验证，没有在真实极空间 NAS、反向代理或生产流量环境中运行。
