# Task 1 Report: Fail-Closed Runtime Configuration

## 实现摘要

- 新增 `loadGatewayConfig(env, readSecret)`，对公共 HTTPS 源站、上游 BFF 目标、端口、构建目录、上游超时和动作密钥文件进行 fail-closed 校验与归一化。
- 公共源站只接受无路径、凭据、查询参数或片段的 HTTPS scheme + host；上游目标允许 HTTPS 路径但拒绝凭据、查询参数和片段。
- 动作密钥从 `ADMIN_WEB_ACTION_SECRET_FILE` 以 UTF-8 读取，去除首尾空白后要求至少 32 个字符且不含控制换行字符。
- 增加 gateway 脚本和生产启动脚本；不包含任何实际密钥或环境值。

## 文件

- `admin-web/server/config.mjs`（新增）
- `admin-web/server/config.test.mjs`（新增）
- `admin-web/package.json`（修改）

## RED 命令与失败原因

```powershell
cd admin-web
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test server/config.test.mjs
```

结果：退出码 `1`；测试导入阶段因 `ERR_MODULE_NOT_FOUND` 找不到 `admin-web/server/config.mjs` 而失败。这正是新增配置模块前的预期 RED，非测试拼写或断言错误。

## GREEN 命令与结果

```powershell
cd admin-web
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test server/config.test.mjs
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8')); console.log('PACKAGE_JSON_OK')"
```

随后从 worktree 根目录运行：

```powershell
git diff --check -- admin-web/package.json admin-web/server/config.mjs admin-web/server/config.test.mjs
```

结果：配置测试 `7/7` 通过；`git diff --check` 退出码 `0`；`PACKAGE_JSON_OK`。测试覆盖生产配置归一化、五种非法公共源站和过短密钥。

## 自查

- `loadGatewayConfig` 使用注入的 `readSecret`，测试不会读取本机密钥；默认读取器是 `readFileSync(path, "utf8")`。
- 所有数值使用整数范围校验：端口 `1024-65535`，上游超时 `45000-120000ms`。
- 返回对象被冻结；公开源站使用 `.origin`，不会保留路径或认证信息。
- 仅修改 Task 1 指定的运行配置、测试和 package scripts；未连接生产、未上传、未发布。

## 关注点

- `test:gateway` 已按简报引用后续任务会新增的 `static-handler`、`proxy-handler` 与 `server` 测试；在这些文件尚未落地前，不能将完整 `npm test` 视为本 Task 的可运行验证。本 Task 已按要求执行并通过 focused config 测试。
- `start` 指向后续任务将新增的 `server/index.mjs`；当前不会启动服务，这是按简报预留的运行接口。
