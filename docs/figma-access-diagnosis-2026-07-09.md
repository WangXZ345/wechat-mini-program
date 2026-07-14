# Figma MCP 访问诊断记录 2026-07-09

## 结论

本次复测后，Figma 仍然被当前账号的 Starter 计划 MCP 调用上限拦截，且当前连接只暴露出一个 Starter 团队和 View 席位。该问题不是本地项目代码、微信小程序文件、云函数或单个 Figma 文件损坏导致，不能通过修改本仓库文件修复。

## 已做检查

- `whoami` 可正常返回账号状态，说明 Figma 连接器不是完全离线。
- 当前只发现一个 Figma plan：`tier=starter`，`seat=View`。
- 未发现可自动切换的 Professional / Organization / Enterprise 团队或可编辑席位。
- 对现有 Figma 文件执行最小 `get_metadata` 读取仍失败，返回：

```text
You've reached the Figma MCP tool call limit on the Starter plan.
```

## 本轮尝试修复

- 2026-07-09 再次执行 `whoami`，连接仍可正常返回账号状态，说明本地 Figma MCP 连接器没有完全失效。
- 当前连接仍只返回一个 Starter 团队，且当前账号在该团队内仍是 `View` 席位。
- 当前 Codex 暴露的 Figma 工具只有身份检查、文件创建、读结构、截图、素材上传、设计系统搜索和写入设计等能力，未暴露可自动清空额度、升级计划、切换账号或重连授权的工具。
- 追加排查本地插件配置：Figma 插件仍指向官方 MCP 端点 `https://mcp.figma.com/mcp`，插件包和 MCP 工具暴露正常。
- 追加排查本地 Codex 状态：`auth.json` 仅是 Codex/OpenAI 登录缓存，不是 Figma OAuth 来源；`state_5.sqlite`、`sqlite/codex-dev.db` 和 `.codex-global-state.json` 未发现可直接修改的 Figma 团队、席位、额度或账号切换配置。
- 追加确认 OAuth 安装恢复状态为空，没有发现本地残留恢复状态把连接强制指向旧团队或旧账号。
- 因此本轮没有继续调用 `get_metadata`、`use_figma`、`create_new_file` 或 `generate_figma_design`，避免在已知 Starter 调用上限状态下继续消耗额度。
- 结论保持不变：这是 Figma 账号计划 / 席位 / MCP 调用额度层面的阻塞，不能通过修改本地小程序代码、清理项目文件、重建测试 Figma 文件或重复调用 MCP 工具修复。

## 处理边界

本次没有继续重试 `use_figma` 写入、`create_new_file` 新建文件或 `generate_figma_design` 捕获页面，避免继续消耗 Figma MCP 调用额度。

最新边界：按当前执行要求，后续不再继续尝试调用 Figma 插件，也不再等待 Figma 连接恢复；UI/UX 优化继续以 `docs/figma.md` 和代码内设计系统作为交付依据。

## 恢复路径

要继续把设计写入 Figma，需要先在 Figma / Codex 连接侧完成其中一种操作：

1. 升级当前 Figma 团队计划，并授予当前账号可编辑席位。
2. 切换或重新连接到一个有可用 MCP 调用额度、且当前账号拥有编辑权限的 Figma 团队。
3. 完成后先运行 `whoami`，确认不再是 `starter + View`，再执行 `get_metadata` 或 `use_figma`。

在恢复前，UI 优化只能继续以本地小程序代码和文档作为交付，不应继续尝试 Figma 读写。
