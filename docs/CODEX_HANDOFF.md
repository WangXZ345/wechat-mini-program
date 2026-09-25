# 项目跨设备交接摘要

> 生成日期：2026-09-25
> 说明：本文是项目代码与本地验证边界的交接摘要，不包含 Codex 会话、浏览器状态、数据库快照、生产凭据或本机运行时文件。

## 1. 项目概述

这是一个面向美妆/批发类商品销售场景的微信小程序与网页后台系统：

- 微信小程序是客户侧入口，负责商品浏览、购物车、预下单、订单、付款凭证、地址、售后和个人中心。
- `admin-web/` 是运营后台，面向采购、财务、客服和超级管理员，提供商品、库存、订单、付款、账款、发货、售后、退款、导入、设置和操作日志等运营能力。
- `cloudfunctions/` 是微信云开发函数和共享服务层，负责鉴权、业务校验、事务写入、库存/付款/账款状态、幂等、审计和同步事件。
- `shared/` 保存前后端共用的接口合同；`docs/` 保存架构、数据、权限、部署、验证和实施记录。

项目的核心原则是：小程序客户侧与网页后台复用同一套 CloudBase 数据和服务端业务规则，不建立第二套业务数据库；金额统一按整数“分”存储；敏感数据必须由后端鉴权和响应投影保护。

## 2. 项目目标

1. 保持微信小程序作为客户订货端，兼容现有商品、购物车、下单、付款、地址、售后和订单履约流程。
2. 建立角色感知、可审计、可回放和可恢复的网页运营后台。
3. 将后台真实写操作逐步收口到 canonical service，使用服务端权限、事务、CAS、幂等、审计日志和 operation outbox，避免前端或 Mock 伪造业务成功。
4. 保护客户手机号、地址、付款凭证、账款、风险等级、内部备注和管理员数据，确保前端隐藏不是唯一安全边界。
5. 在真实 CloudBase、隔离测试环境、浏览器、微信开发者工具和真机完成验证后，再进行云函数上传、后台部署和小程序发布。

## 3. 当前代码结构

当前 Git 工作区约有 1508 个已跟踪文件，其中包括：

- `miniprogram/`：微信小程序原生前端。
- `admin-web/`：Vue 3 + Vite + TypeScript 网页后台及同源 BFF。
- `cloudfunctions/`：约 165 个云函数目录，其中约 163 个带 `package.json`。
- `shared/`：共享 TypeScript API 合同。
- `docs/`：项目文档、测试计划、部署说明和实施记录。
- `scripts/`：打包、验证和回归脚本。

主要请求路径：

```text
admin-web
  -> same-origin BFF
  -> adminWebAuth / adminWebApi / getSyncEvents
  -> shared canonical services and CloudBase collections

miniprogram
  -> existing cloud functions and shared services
  -> the same CloudBase collections
```

## 4. 当前进度判断

### 已纳入当前本地代码的范围

- P1-P2：订单、付款、地址、库存、设置、幂等、权限、脱敏和基础状态机的兼容性加固。
- P3：报价导入和库存导入的真实服务路径，包含预览、确认、恢复、严格校验、CAS、幂等、审计和 outbox 设计。
- P4：单订单发货、合并发货、物流编辑/撤销、完成发货等服务端写入基础。
- P5：客户账款重算、受控线下结算、权限安全的客户账款导出。
- P6：安全创建管理员、管理员停用/恢复、最后一个超级管理员保护、会话失效和相关操作日志。
- `admin-web/`：真实数据模式和 Mock 模式边界、BFF、登录/session、权限菜单、订单/商品/库存/导入/付款/账款/发货/售后/退款/管理员/设置等页面与传输合同。
- `cloudfunctions/adminWebApi/`：批量合同、导入解析与执行、错误模型、请求校验、幂等、订单备注、付款变更、发货状态机和系统设置服务。

### 当前 Git 状态

- 当前分支：`main`
- 当前本地提交：`158f743`，提交说明为 `feat(admin): checkpoint real write foundations`
- 远程分支：`origin/main` 当前为 `d5c4afb`
- 本地相对远程：领先 1 个提交，工作区无未提交改动
- 远程仓库地址：`WangXZ345/wechat-mini-program`

### 尚未完成或尚未证明的边界

- 尚未把当前本地 `HEAD` 推送到 GitHub。
- 尚未上传本次涉及的云函数。
- 尚未部署网页后台。
- 尚未发布小程序。
- 尚未在真实 CloudBase 上完成完整事务、集合/索引和真实数据写入验收。
- 尚未完成浏览器完整验收、微信开发者工具验收和真机验收。
- 双端实时同步的在线 1-3 秒延迟仍属于目标，不能仅凭本地测试标记为已通过。
- 旧云函数中仍可能存在重复的权限、手机号、幂等和服务副本；在逐函数审计前，不能宣称整个仓库已经完全统一。

## 5. GitHub 上传范围建议

### 建议上传

- 当前 Git 已跟踪的项目源代码：`miniprogram/`、`admin-web/`、`cloudfunctions/`、`shared/`、`scripts/`。
- 项目说明和规则：`README.md`、`PRODUCT.md`、`AGENTS.md`、`design-model.yaml`、`.gitignore`、`.gitattributes`。
- 项目文档：`docs/`，包括数据库、架构、权限、幂等、实时同步、导入、部署、回滚、测试和历史实施记录。
- 需求和验证资料：`项目背景规划.docx`、`售后退款闭环验证报告.md`、`CODE_AUDIT_P1_P2_REVIEW_REQUEST.md`。
- 本交接文件：`docs/CODEX_HANDOFF.md`。
- 可复现开发所需的 `package.json`、lockfile、环境变量示例和非敏感测试配置。

### 明确不上传

- `.codex/`、`.codex-runtime/`、`.codex-cloudfunction-deploy/`、`.codegraph/`、`.claude/`、`.agents/`、`.worktrees/`、`.superpowers/` 下未跟踪的运行时、会话、缓存、隔离工作树和临时保护包。
- Codex 会话 JSONL、SQLite、索引、浏览器/CDP 状态和完整聊天记录；跨设备继续任务应依靠本项目交接文档，而不是迁移会话数据库。
- `node_modules/`、构建产物、coverage、Playwright 报告、日志和临时导出文件。
- `project.private.config.json`、真实 `.env`、密钥、证书、token、私有账号配置和任何生产凭据。

### 需要保留并单独标注的文件

- `admin-web/.env.example`、`admin-web/zspace.env.example`：作为配置模板保留。
- `admin-web/.env.mock`、`admin-web/.env.test`：当前只包含本地 Mock/测试环境配置，但依赖测试环境 ID 和地址；上传前应保持测试用途说明，不把它们当作生产配置。
- 当前仓库已有少量被 Git 跟踪的 `.superpowers/sdd/*-report.md` 历史报告；本次不新增运行时文件，也不上传其余被忽略的执行状态。

## 6. 另一台电脑继续任务的建议顺序

1. 克隆或拉取 `main`，确认 `origin/main` 已包含当前交接提交。
2. 安装 Node.js `>=20.19`，再按 `admin-web/package.json` 和各云函数 `package.json` 安装依赖。
3. 先阅读本文件、`AGENTS.md`、`README.md`、`PRODUCT.md` 和 `docs/web-admin-test-deployment-and-rollback.md`。
4. 本地先运行静态检查、定向测试和 admin-web 构建；不要把本地 Mock 结果当作 CloudBase 验收。
5. 继续开发时保持“本地实现、云端上传、后台部署、小程序发布”四个状态分开记录。
6. 任何上传云函数、生产配置、真实数据写入或发布操作，都必须重新确认环境、范围和回滚方案。

## 7. 本次上传前的待确认事项

- 是否把当前本地 `main` 的 1 个未推送提交推送到现有 `origin/main`。
- 是否接受新增并上传本文件作为跨设备交接入口。
- 是否保持现有 GitHub 仓库和分支不变，不创建新仓库、不改变仓库可见性。
- 是否按本文件的排除清单过滤本机运行状态、会话数据、缓存、临时保护包和私密配置。
