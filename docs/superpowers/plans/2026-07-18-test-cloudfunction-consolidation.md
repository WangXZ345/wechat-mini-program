# Test Cloud Function Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 释放测试环境 4 个云函数名额，部署网页版真实数据入口，并验证网页版的真实读取与游标同步。

**Architecture:** 保留 `afterSales` 作为售后/退款聚合入口，只退役 4 个无独立业务逻辑的只读兼容函数。Web 认证、BFF、小程序同步和清理任务继续由 4 个边界明确的新函数承担，Real 模式通过同源 BFF 访问测试 CloudBase。

**Tech Stack:** WeChat CloudBase, WeChat DevTools CLI, Node.js, Vue 3, Vite, TypeScript, PowerShell

## Global Constraints

- 目标环境只能是 `cloud1-d7g4mbc5r2fac4a77`。
- 不连接生产环境，不发布小程序，不修改订单、库存、账款、客户或付款业务数据。
- 不输出或提交密码、secret、token、openid、手机号、地址或付款凭证。
- 删除范围只能是 `getAdminAfterSaleDetail`、`getAdminAfterSales`、`getAdminRefundDetail`、`getAdminRefunds`。
- 上传范围只能是已批准的 19 个目标函数。
- 任何失败必须保留原始结果并停止扩大变更。

---

### Task 1: 固化本地基线与部署输入

**Files:**
- Read: `project.config.json`
- Read: `.codex-cloudfunction-deploy/admin-web-nineteen-functions-guarded-20260718-030709/`
- Read: `.codex-cloudfunction-deploy/admin-web-nineteen-functions-staging-20260718-0755/`
- Create: `.codex-cloudfunction-deploy/admin-web-consolidation-20260718/`

**Interfaces:**
- Consumes: 已批准的 guarded 包和固定环境 ID。
- Produces: 只读预检记录、函数名单和本地哈希证据。

- [ ] **Step 1: 核对 Git 工作区并保留用户未提交文件**

Run: `git status --short`

Expected: 保留 `miniprogram/pages/admin/orders.wxml` 和 `scripts/test-admin-orders-filter-summary.js`，不暂存、不回滚。

- [ ] **Step 2: 校验项目配置与 19 函数名单**

Run: PowerShell 解析 `project.config.json`，确认 `cloudfunctionRoot`；按 A-Z 输出 19 个目录并确认每个目录存在 `index.js`、`package.json`。

Expected: 19/19 完整，环境 ID 不从仓库秘密文件推断。

- [ ] **Step 3: 运行部署 Skill dry run**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\bin\.codex\skills\upload-new-wechat-cloudfunctions\scripts\upload-new-wechat-cloudfunctions.ps1" `
  -ProjectRoot "D:\王希哲\NEW\.codex-cloudfunction-deploy\admin-web-nineteen-functions-staging-20260718-0755" `
  -EnvId "cloud1-d7g4mbc5r2fac4a77" `
  -Names adminDashboard,adminGetCustomerAccountDetail,adminListCustomerAccounts,adminReviewOrder,adminUpdatePayment,adminWebApi,adminWebAuth,afterSales,batchUpdateProductTags,cancelOrder,cleanupSyncEvents,getOrders,getSyncEvents,getUnsoldProducts,manageProduct,recalculateCustomerAccount,shipmentGroups,updateProductPrice,updateProductWarningStock `
  -TryFullDeploy -DryRun
```

Expected: 19 个函数全部进入计划，`uploadPerformed=false`。

### Task 2: 备份并退役 4 个兼容入口

**Files:**
- Create: `.codex-cloudfunction-deploy/admin-web-retired-wrapper-backup-<timestamp>/`
- Do not delete: `cloudfunctions/getAdminAfterSaleDetail/`
- Do not delete: `cloudfunctions/getAdminAfterSales/`
- Do not delete: `cloudfunctions/getAdminRefundDetail/`
- Do not delete: `cloudfunctions/getAdminRefunds/`

**Interfaces:**
- Consumes: 测试环境只读函数清单和 CloudBase CLI。
- Produces: 4/4 远端备份、哈希清单、4 个空闲函数名额。

- [ ] **Step 1: 只读核对 4 个函数状态和触发器**

Run: 使用 WeChat DevTools/CloudBase CLI 查询 4 个函数的状态、HTTP/定时/数据库触发器。

Expected: 函数存在且没有独立触发器；如发现触发器，停止删除并报告。

- [ ] **Step 2: 下载 4 个函数并生成哈希清单**

Run: 对每个函数执行远端下载，验证目录、`index.js`、`package.json`，然后用 `Get-FileHash -Algorithm SHA256` 生成清单。

Expected: 4/4 备份完整，清单保存在备份目录，不包含 secret。

- [ ] **Step 3: 核对聚合入口**

Run: 确认远端 `afterSales` 为可用状态；运行本地 `afterSales` 定向测试。

Expected: 聚合入口可用，本地对应 action 测试通过。

- [ ] **Step 4: 逐个删除并复核**

Run: 依次删除 `getAdminAfterSaleDetail`、`getAdminAfterSales`、`getAdminRefundDetail`、`getAdminRefunds`，每次删除后立即查询函数状态。

Expected: 仅这 4 个函数返回不存在，其余函数状态不变。

### Task 3: 上传 19 个目标云函数

**Files:**
- Read: `.codex-cloudfunction-deploy/admin-web-nineteen-functions-staging-20260718-0755/cloudfunctions/`
- Create: `.codex-cloudfunction-deploy/<upload-result>.json`

**Interfaces:**
- Consumes: 4 个空闲名额和 19 函数 staging 包。
- Produces: 19 个测试环境目标函数的逐项部署结果。

- [ ] **Step 1: 上传 4 个新函数**

Run: 使用 upload Skill 的显式名单和 `-TryFullDeploy` 上传 `adminWebApi`、`adminWebAuth`、`cleanupSyncEvents`、`getSyncEvents`。

Expected: 4/4 创建成功且状态可用；任何一个失败立即停止后续覆盖上传。

- [ ] **Step 2: 上传 15 个现有函数**

Run: 使用相同 staging 项目和 `-TryFullDeploy` 上传其余 15 个函数。

Expected: 输出 A-Z 成功/失败清单和结果 JSON；嵌套目录不得以 `filesCount 0` 冒充成功。

- [ ] **Step 3: 远端复核**

Run: 查询 19 个函数状态并与本地显式名单对齐。

Expected: 19/19 存在且可用，4 个旧兼容入口仍不存在。

### Task 4: 配置测试 Web 基础设施

**Files:**
- Read: `docs/web-admin-test-deployment-and-rollback.md`
- Read: `admin-web/.env.example`
- Modify locally only: ignored Real/BFF environment configuration

**Interfaces:**
- Consumes: 已部署的 `adminWebAuth`、`adminWebApi`、`getSyncEvents`、`cleanupSyncEvents`。
- Produces: 测试环境 Web session、HTTP BFF、同步游标和必要索引。

- [ ] **Step 1: 生成并配置服务端 secrets**

Run: 使用加密随机源生成不少于 32 字符的测试 secrets，直接写入测试环境配置，不打印值、不写入 Git。

Expected: `ADMIN_WEB_ENV`、Origin、token/password/action/sync secrets 完整，客户端 `VITE_*` 不含服务端 secret。

- [ ] **Step 2: 核对并创建必要索引**

Run: 只读核对设计文档列出的 auth/session/sync 索引；仅创建缺失索引。

Expected: 不删除、不重建现有索引，不修改业务文档。

- [ ] **Step 3: 初始化测试管理员凭证**

Run: 从测试环境现有 active `admin_users` 中选择已确认管理员，调用一次性 bootstrap；完成后关闭 bootstrap 并轮换配置。

Expected: 不输出账号密码/令牌；管理员 profile、role、permissions 与测试环境一致。

- [ ] **Step 4: 配置本地 Real BFF**

Run: 设置被 Git 忽略的本地 Real 配置，指向测试环境 HTTPS/Auth/API 入口，启动未占用端口。

Expected: `/api/admin/v1/auth/profile` 不再返回 `BFF_PROXY_NOT_CONFIGURED`。

### Task 5: 浏览器真实数据与同步验收

**Files:**
- Read: `admin-web/src/stores/realtime.ts`
- Read: `admin-web/src/services/`
- Do not modify business collections

**Interfaces:**
- Consumes: Real BFF 和测试管理员 session。
- Produces: 页面、网络、同步状态和日志证据。

- [ ] **Step 1: 运行本地静态与测试验证**

Run: Cloud 全量测试、Web 全量测试、TypeScript、ESLint、Vite Real build、资产 Mock 标记扫描。

Expected: 所有命令 exit 0；报告实际测试数量。

- [ ] **Step 2: 浏览器登录并验证真实读取**

Run: 在浏览器打开 Real URL，登录测试管理员，检查工作台、订单/商品和售后/退款中至少两个列表。

Expected: 网络请求命中 Real BFF；页面数据来自测试环境；无 Mock transport 请求。

- [ ] **Step 3: 验证同步游标**

Run: 检查 `/sync/events` 首次读取、后续 cursor 读取、空批次和前端同步状态。

Expected: cursor 合法，断线/重试不清空业务页面；不制造业务数据写入。

- [ ] **Step 4: 记录最终边界**

Run: 汇总删除、上传、索引、配置、浏览器验收和未验证项。

Expected: 明确“测试环境已部署”“小程序未发布”“生产环境未连接”“业务数据未修改”。

