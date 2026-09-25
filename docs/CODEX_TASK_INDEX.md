# 项目任务索引

> 更新时间：2026-09-25
> 用途：在另一台电脑快速恢复项目上下文，不替代源代码、测试和正式设计文档。

## 当前总状态

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| 微信小程序客户侧 | 已有完整主体 | 商品、购物车、预下单、订单、付款、地址、售后和个人中心均在 `miniprogram/` |
| 网页运营后台 | 本地实现持续推进 | Vue 3/Vite/TypeScript，包含真实模式、Mock 模式、BFF、权限和运营模块 |
| 云函数与共享服务 | 本地代码已覆盖大量业务 | 事务、CAS、幂等、审计、outbox、状态机和字段投影逐步收口 |
| CloudBase 真实环境 | 未完成验收 | 未作为本地测试通过的替代证明 |
| 云函数上传 | 未执行 | 需要单独确认函数范围和环境 |
| 网页后台部署 | 未执行 | 需要隔离测试环境、网关和 secret 验证 |
| 小程序发布 | 未执行 | 需要微信开发者工具和发布确认 |
| 浏览器/开发者工具/真机 | 未完成完整验收 | 本地单测和构建不能替代端到端验证 |

## 阶段索引

### P1-P2：基础加固

- 订单、付款、地址、库存、设置、权限、脱敏、幂等和状态机的兼容性加固。
- 重点原则：服务端鉴权、金额按分、CAS、幂等、审计和不向客户侧返回后台敏感字段。
- 继续工作前先阅读：`docs/idempotency.md`、`docs/admin-permissions.md`、`docs/database.md`。

### P3：报价与库存导入

- 已有报价导入和库存导入的 preview/confirm/resume 流程。
- 关键约束：严格匹配、整数分、版本校验、`IMPORT_PREVIEW_STALE`、幂等、部分恢复、库存/价格日志和 outbox。
- 主要代码：`cloudfunctions/adminWebApi/lib/importService.js`、`cloudfunctions/adminWebApi/lib/importFileParser.js`、`shared/contracts/admin-api-v1.ts`。
- 下一步：重新运行定向测试，确认当前代码与历史验证记录一致；之后再考虑 CloudBase 测试环境验证。

### P4：发货与合并发货

- 已有单订单发货、合并发货、物流编辑/撤销、完成发货等 canonical 服务和状态机基础。
- 关键约束：订单项归属、状态守卫、请求摘要、幂等和 fail-closed。
- 主要代码：`cloudfunctions/common/services/shipmentStateMachine.js`、`cloudfunctions/shipmentGroups/`、`admin-web/src/modules/shipments/`。
- 下一步：补齐真实环境和双端业务验收，不把内存事务测试当作 CloudBase 证明。

### P5：账款与导出

- 已有客户账款重算、受控线下结算和权限安全导出基础。
- 关键约束：整数分、账款流水、精确权限、CSV UTF-8 BOM/RFC 4180、可取消导出。
- 主要入口：`recalculateCustomerAccount`、`exportCustomerStatement`、`adminWebApi` 账款路由。
- 下一步：确认财务/客服/采购/超级管理员的真实可见范围并完成端到端验收。

### P6：管理员与权限

- 已有管理员创建、密码/session 策略、停用/恢复和最后一个超级管理员保护。
- 关键约束：scrypt 密码策略、Idempotency-Key、HMAC、会话失效、操作日志和 `admin_users` 权威状态。
- 主要入口：`adminWebAuth`、`adminWebApi`、`adminCreationService`、`adminStatusService`。
- 下一步：继续独立复审权限和敏感字段，随后再规划测试环境部署。

## 继续工作的第一步

1. 阅读 `AGENTS.md`、`README.md`、`PRODUCT.md`、`docs/CODEX_HANDOFF.md`。
2. 确认 Node.js `>=20.19`，安装 `admin-web` 和目标云函数依赖。
3. 查看 `git status --short --branch`、`git log --oneline -10` 和 `git remote -v`。
4. 先运行 admin-web 定向测试、类型检查、lint 和构建，再修改业务代码。
5. 修改云函数时同步检查入口、`package.json`、调用方、权限分支、返回结构和部署清单。
6. 上传云函数、真实数据写入、后台部署和小程序发布必须单独确认，不能由本地 Git 推送自动触发。

## 证据边界

- 历史记录中的本地测试、构建和静态检查只证明对应代码快照在本地通过。
- CloudBase 集合、索引、真实事务、真实数据、浏览器、微信开发者工具、真机和线上延迟必须重新验证。
- 不要把 `.codex/`、`.worktrees/`、`node_modules/`、日志、会话数据库或私密配置作为继续任务的前置依赖。
