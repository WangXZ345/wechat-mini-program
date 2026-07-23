# Task 3 执行报告：受限安全反向代理

## 状态

- 工作目录：`D:\王希哲\NEW\.worktrees\admin-web-zspace`
- 分支：`codex/admin-web-zspace`
- 起始基线：`111a8425372bd1a842bed8834f5dd3ec5326b70b`
- 范围：仅新增 `admin-web/server/proxy-handler.mjs`、`admin-web/server/proxy-handler.test.mjs` 和本报告。
- 未执行：push、merge、上传、发布、生产连接、真实数据写入。

## 变更摘要

1. 新增公开生产工厂 `createProxyHandler(config, requestUpstream)`，没有暴露 `testRequest` 或其他测试专用生产方法。
2. 仅代理 `/api/admin/v1` 本身及其子路径；其他路径返回 `false`，API 命名空间内的畸形编码、双重编码、路径穿越、NUL、反斜杠和 fragment 返回结构化 `400 BFF_INVALID_PATH`，不向上游发请求。
3. 请求头使用显式白名单：
   - 保留 `Authorization`、`Cookie`、`X-Admin-CSRF`、`Idempotency-Key`、内容协商/类型、`Content-Length`、`User-Agent`、`X-Request-Id`。
   - 强制覆盖 `Host`、`Origin`、`X-Admin-Action-Secret`。
   - 不盲传 `Connection`、`Forwarded`、`X-Forwarded-*`、客户端伪造 action secret 和其他 hop-by-hop/未知头。
4. 响应头使用显式白名单，保留 `Set-Cookie`、`Content-Disposition`、`Content-Type`、缓存、编码、认证、重试和 request-id 等必要头，不透传未知内部头。
5. 请求和响应均采用流式转发并处理双向背压；默认请求体上限为 1 MiB：
   - 声明的 `Content-Length` 超限时，在创建上游请求前返回 `413 BFF_REQUEST_TOO_LARGE`。
   - chunked/未知长度请求在累计超限时中止上游并返回 413。
6. 统一处理 client abort、upstream abort/error/timeout、迟到错误和 `headersSent`：
   - 未发送下游头时返回无上游细节的固定 JSON 502/504。
   - 已发送下游头后只关闭连接，不拼接第二个错误体。
   - 成功结束后的迟到 transport error 不覆盖已完成响应。
7. 上游 API 404 作为 API 响应原样返回，不回退 SPA。

## TDD：RED

### RED 1：模块和安全代理契约尚不存在

命令：

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test server/proxy-handler.test.mjs
```

关键输出：

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\server\proxy-handler.mjs'
tests 1
pass 0
fail 1
```

### RED 2：请求体上限尚未实现

同一命令，加入声明长度与 chunked 超限测试后：

```text
tests 6
pass 4
fail 2
200 !== 413
```

### RED 3：重复背压导致第二次暂停后无法恢复

同一命令，加入多次 `drain` 测试后：

```text
tests 7
pass 6
fail 1
Error: proxy stalled after repeated upstream backpressure
```

修复方式是每次 `outgoing.write()` 返回 `false` 时都注册对应的一次性 `drain` 恢复，而不是只在初始化时监听一次。

### 测试夹具纠正

生命周期测试首轮发现注入的假 `IncomingMessage` 缺少真实对象具有的 `destroy()`，产生测试结束后的异步 `TypeError`。这是测试夹具不完整，不是生产失败；补齐公开 Node 流接口后重新运行，12/12 通过。没有为测试向生产代码添加专用方法。

## TDD：GREEN

Proxy 专项最终命令：

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test server/proxy-handler.test.mjs
```

最终结果：

```text
tests 15
pass 15
fail 0
skipped 0
```

覆盖点包括：

- 安全请求头覆盖与白名单；
- `Set-Cookie`、`Content-Disposition` 等响应头；
- 非 API/畸形 API URL 不访问上游；
- 脱敏 502/504；
- 声明长度和 chunked 请求体上限；
- 请求重复背压；
- timeout、上游首字节前/后 abort、client abort、迟到错误；
- API 404 不回退 SPA；
- 响应首块在上游结束前到达；
- 生产配置未提供 override 时使用 1 MiB 默认上限。

## 最终验证

### Task 1–3 gateway 联跑与语法

```powershell
$node = 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --check server/proxy-handler.mjs
& $node --check server/proxy-handler.test.mjs
& $node --test server/config.test.mjs server/static-handler.test.mjs server/proxy-handler.test.mjs
```

结果：

```text
tests 37
pass 36
fail 0
skipped 1
```

唯一 skip 是既有 Windows 环境无法创建测试用文件 symlink（`EPERM`）；directory junction 越界测试仍通过。

### 定向 ESLint

项目现有 ESLint 配置只为 `*.ts`/`*.vue` 声明 Node globals，既有 `server/config.mjs` 也会因此报 `URL/process no-undef`。未越界修改全局 ESLint 配置，改用等价的定向命令声明 Node globals，并关闭与既有安全正则相同的 `no-control-regex` 规则：

```powershell
& $node node_modules/eslint/bin/eslint.js server/proxy-handler.mjs server/proxy-handler.test.mjs `
  --max-warnings=0 --global Buffer --global URL --global setImmediate `
  --global setTimeout --global clearTimeout --global queueMicrotask `
  --rule 'no-control-regex: off'
```

结果：exit code 0，0 errors，0 warnings。

### 稳定性与静态检查

- Proxy 专项连续重复 5 次：全部 PASS。
- `git diff --check -- admin-web/server/proxy-handler.mjs admin-web/server/proxy-handler.test.mjs`：exit code 0。
- UTF-8 replacement character、private-key marker、AKIA 模式扫描：clean。

## 自查

- [x] 没有 `testRequest` 或测试专用生产入口。
- [x] 真实 loopback HTTP upstream 覆盖正常流、404、首字节前/后中断；注入仅用于精确制造 timeout/error/backpressure/client-abort 边界。
- [x] 未缓冲完整请求或响应；测试端收集响应只用于断言。
- [x] 请求体有明确且已测试的 1 MiB 默认上限。
- [x] 浏览器传入的 `Host`、`Origin`、action secret 被覆盖。
- [x] `Authorization`、`Cookie`、`X-Admin-CSRF`、`Idempotency-Key` 按白名单保留。
- [x] `Forwarded`、`X-Forwarded-*`、hop-by-hop 和未知内部头不盲传。
- [x] Proxy 自身错误体是固定结构，不含异常文本、上游地址或 action secret。
- [x] `headersSent` 后不追加 JSON，只断开不完整流。
- [x] API 404 由 API 链路返回，不进入 SPA fallback。

## 关注点与验证边界

1. 当前业务写接口为 JSON，导入页面只提交文件名/预览结果而不上传二进制，因此默认 1 MiB 足够；未来若新增文件直传，需要在受控配置中显式提高 `maxRequestBodyBytes` 并补容量测试。
2. 上游应用层 4xx 业务 JSON 为保持现有错误码/文案契约而流式透传，仍需由 BFF 自身脱敏；`>=500` 已按下方 Fix Review 改为有界缓冲和最小安全 envelope 重建。
3. 验证使用本机 loopback HTTP 加公开 `requestUpstream` 注入，未连接测试 CloudBase、未验证公网 TLS/证书/NAS 网络，也未连接生产。
4. 基线 `package.json` 的 `test:gateway` 还列出后续 Task 4 的 `server/server.test.mjs`，当前文件尚不存在；因此本任务使用明确的 Task 1–3 三文件联跑，不把缺少后续任务文件误报为 Task 3 失败。

## Fix Review

### 审查结论与修复

根据 Task 3 安全审查的 Needs changes，在同一 worktree 追加以下修复；仍只修改 Task 3 实现、测试和本报告。

1. 请求体 DoS 与连接终止：
   - 删除错误路径中的 `request.resume()` 无限排空。
   - 超限 413、非法路径/方法及上游在浏览器上传结束前提前完成时，暂停并解绑本代理的请求体监听，响应显式设置 `Connection: close`。
   - 错误响应 `finish` 后销毁 incoming request/socket；真实慢速 chunked 客户端验证可稳定收到完整 413 后连接关闭。
   - 已等待的旧 `drain` 回调同时检查 terminal/close 状态；上游提前完成后不会重新 `resume()` 未结束上传。
   - 正常已完成请求不设置 `Connection: close`，真实 keep-alive agent 连续两次请求复用同一 socket。
2. 失败重入：
   - 在执行 `destroy()`、写响应或其他副作用之前原子锁定 `terminalLocked`。
   - `destroyUpstream()` 幂等；同一 upstream 连续触发 `aborted -> error -> close` 只生成一次稳定 502。
   - upstream/outgoing 使用持续 `error` sink，late second error 被安全忽略，不产生测试结束后的 uncaught exception。
3. 平台级 5xx 脱敏：
   - 仅对 `>=500` 响应做最大 64 KiB 有界缓冲；2xx 继续流式，4xx 保持现有业务契约。
   - HTML、解析失败、超限和非规范 JSON 重建为固定 `{ ok:false, code:"BFF_UPSTREAM_ERROR", message:"后台服务暂时不可用" }`。
   - 仅当顶层 envelope 同时满足 `ok === false`、规范大写 code、规范 requestId 和 JSON content type 时，投影顶层 `code`/`requestId`；message 固定泛化，绝不复制 `error`、`meta`、`stack`、nested、serverTime 或原 body。
   - 规范 501 `SERVICE_NOT_MIGRATED` 保留 status/code/requestId，但不暴露原始迁移细节。
   - 5xx 重建响应仅保留 `Set-Cookie`、`Retry-After`、`WWW-Authenticate`、`X-Request-Id` 等最小安全头，并覆盖 JSON content headers。
4. 方法白名单：
   - 只允许 `GET`、`POST`、`OPTIONS`。
   - `HEAD`、`TRACE` 及其他方法本地返回 405，带 `Allow: GET, POST, OPTIONS`，不创建 upstream、不注入 action secret。
   - `OPTIONS` 继续代理到现有 BFF 边界。
5. 双向背压：
   - 保留既有请求方向重复 `drain` 测试。
   - 新增响应方向连续三次 `write(false) -> pause -> drain -> resume` 测试，确认每轮都恢复且数据完整。

### Review RED

新增审查用例后的命令：

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test server/proxy-handler.test.mjs
```

关键输出：

```text
tests 23
pass 16
fail 7
actual connection: keep-alive (expected close)
upstream destroy calls: 3 (expected 1)
platform HTML/JSON and oversized 5xx were returned unsanitized
HEAD returned upstream 204 (expected local 405)
```

第一版 GREEN 后 23 个断言本身通过，但测试 runner 检出一条异步噪音：

```text
Error: A resource generated asynchronous activity after the test ended.
Error: late error
```

该结果未被当作通过。原因是 `.once("error")` 在第一次重入 error 后移除，第二个 late error 无监听；改为持续 error sink 后重新验证。

最终自查又用精确用例复现 stale `drain` 竞态：

```text
tests 1
pass 0
fail 1
requestResumeCalls: 1 (expected 0)
```

修正 `drain` 恢复条件后，该用例及全套专项测试均通过。

### Review GREEN

Proxy 专项最终结果：

```text
tests 25
pass 25
fail 0
skipped 0
无异步资源或 uncaught error 噪音
```

Task 1–3 gateway 联跑：

```text
tests 47
pass 46
fail 0
skipped 1
```

唯一 skip 仍是 Windows 环境文件 symlink 创建 `EPERM`；junction 越界保护测试通过。

稳定性与静态检查：

- Proxy 25 项连续重复 5 次：全部 PASS。
- `node --check`：实现和测试均 exit code 0。
- 定向 ESLint：0 errors，0 warnings。
- `git diff --check`：exit code 0。
- 未连接 CloudBase/NAS/生产，未 push、merge、upload 或发布。

### Review 后剩余验证边界

1. 64 KiB 只用于平台 5xx 安全重建，不改变 2xx 流式响应；如果未来 BFF 合法 5xx envelope 超过该上限，会安全降级为 `BFF_UPSTREAM_ERROR`。
2. 规范 5xx code 仅在同时存在合法顶层 requestId 时保留；不完整 envelope 会安全降级，调用方应以 HTTP status 和 `BFF_UPSTREAM_ERROR` 处理。
3. 连接关闭测试使用真实本机 HTTP socket/keep-alive agent；公网 TLS、CloudBase 平台和 NAS 反代链路仍未连接或实测。
