# Admin Web Account Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/accounts` 升级为基于真实 `customer_accounts`、`account_logs` 和 `orders` 的安全账款列表与专用只读详情，同时保持小程序旧读取入口兼容和所有账款写/导出关闭。

**Architecture:** 新增 canonical `accountQueryService` 作为唯一读取业务层；小程序旧入口使用 legacy projector，`adminWebApi` 使用严格 Web projector。Web 通过 Zod 严格合同解析列表/详情并新增专用详情页；同步事件只触发重读。

**Tech Stack:** Node.js 20、`wx-server-sdk` CloudBase 查询、原生 `node:test`、Vue 3、TypeScript、Zod 4、Element Plus、Vitest。

## Global Constraints

- 只做账款读取，不开放重算、修改、结清、导出或付款操作。
- 不调用 `recalculateCustomerAccount`，不创建集合，不执行读取副作用。
- 只允许 active `finance/super_admin` 且具 `customer:view_account` 的 Web 会话。
- 金额为安全整数分，当前字段优先，旧字段只做兼容回退；脏值 fail closed。
- Web 不返回 openid、完整手机号/地址、凭证、交易号、内部备注、风险信息、操作人标识和幂等字段。
- 列表使用 `updatedAt + _id` 稳定游标；详情关联订单最多 50 条、流水最多 100 条。
- 不改变旧小程序 wrapper 名称、参数、权限和 `{ok,data}` 外层合同。
- 不连接生产环境，不上传云函数，不创建真实索引，不部署 Web，不发布小程序。
- 当前目录不依赖 Git 作为完成证据；使用测试、文件清单和 SHA256 门禁。

---

### Task 1: Canonical Account Query Service and Legacy Adapters

**Files:**
- Create: `cloudfunctions/common/services/accountQueryService.js`
- Create: `cloudfunctions/common/services/accountQueryService.test.js`
- Create deploy copies in `cloudfunctions/adminWebApi/lib/`, `cloudfunctions/adminListCustomerAccounts/`, `cloudfunctions/adminGetCustomerAccountDetail/`
- Modify: `cloudfunctions/adminListCustomerAccounts/index.js`
- Modify: `cloudfunctions/adminGetCustomerAccountDetail/index.js`
- Test: both legacy wrapper test files

**Interfaces:**
- `createAccountQueryService({db, command})`
- `listWebAccounts({actor, query})`
- `getWebAccount({actor, id})`
- `listLegacyAccounts({actor, query})`
- `getLegacyAccountDetail({actor, selector})`
- Stable errors: `FORBIDDEN`, `ACCOUNT_QUERY_INVALID`, `ACCOUNT_CURSOR_INVALID`, `ACCOUNT_DATA_INVALID`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_READ_FAILED`.

- [ ] Write failing permission, amount precedence, four-status, search and stable-cursor tests.
- [ ] Run canonical tests and confirm RED because the service does not exist.
- [ ] Implement minimal list path with strict actor validation, bounded query and Web projector.
- [ ] Run list tests and confirm GREEN.
- [ ] Write failing detail tests for orders/logs caps, partial state and sensitive-field stripping.
- [ ] Run detail tests RED; implement detail; rerun GREEN.
- [ ] Freeze current legacy wrapper contracts in tests before changing wrappers.
- [ ] Convert wrappers into thin adapters without introducing writes or widening permissions.
- [ ] Copy canonical service byte-for-byte to three deployment directories and assert SHA256 equality.

### Task 2: BFF Dedicated Account Routes and Packaging Gates

**Files:**
- Modify: `cloudfunctions/adminWebApi/index.js`
- Modify: `cloudfunctions/adminWebApi/test/index.test.js`
- Modify: `scripts/package-admin-web-cloudfunctions.ps1`
- Test: packaging/route tests

**Interfaces:**
- `GET /accounts` -> `listWebAccounts`
- `GET /accounts/:id` -> `getWebAccount`
- Registered account export remains permission + CSRF guarded and returns `501 SERVICE_NOT_MIGRATED`.

- [ ] Write failing route tests for dedicated dispatch, 400/403/404/503 and no raw projector fallback.
- [ ] Run route tests RED; add dedicated routes before generic resource routing.
- [ ] Run route tests GREEN and verify unsupported writes remain fail closed.
- [ ] Add both changed legacy functions and account-service hash gates to the guarded package script.
- [ ] Verify package excludes `node_modules`, `test`, `tests`, `__tests__`.

### Task 3: Strict Web Account Contract and Transport

**Files:**
- Create: `admin-web/src/services/transport/account-query-contract.ts`
- Create: `admin-web/src/services/transport/account-query-contract.spec.ts`
- Modify: `admin-web/src/services/transport/http-transport.ts`
- Modify: `admin-web/src/services/transport/http-transport.spec.ts`
- Modify: `admin-web/src/services/transport/mock-transport.ts`
- Modify: `admin-web/src/services/transport/mock-transport.spec.ts`
- Modify: `admin-web/src/types/api.ts`

**Interfaces:**
- `AccountSummary`, `AccountDetail`, `AccountQueryStatus`
- `AdminTransport.getAccountDetail(id, signal?)`
- Per-filter cursor chain for `/accounts`.

- [ ] Write failing strict Zod tests for exact keys, safe integer cents, dates, statuses and forbidden sensitive fields.
- [ ] Run contract tests RED; implement parsers; rerun GREEN.
- [ ] Write failing HTTP tests for cursor chaining, filter reset, direct page jump rejection, detail and safe errors.
- [ ] Implement HTTP transport and confirm GREEN.
- [ ] Write failing Mock tests for finance/super_admin allow, customer_service/procurement deny, aligned filters/search and detail.
- [ ] Implement Mock behavior without enabling writes; confirm GREEN.

### Task 4: Account List, Drawer and Read-only Detail UI

**Files:**
- Modify: `admin-web/src/config/resources.ts`
- Modify: `admin-web/src/config/resources.spec.ts`
- Modify: `admin-web/src/modules/resources/OperationsView.vue`
- Modify: `admin-web/src/modules/resources/OperationsView.spec.ts`
- Create: `admin-web/src/modules/accounts/AccountDetailView.vue`
- Create: `admin-web/src/modules/accounts/AccountDetailView.spec.ts`
- Modify: `admin-web/src/router/index.ts`
- Modify: `admin-web/src/router/index.spec.ts`

- [ ] Write failing resource tests for real statuses, columns, exact search copy and all writes disabled.
- [ ] Implement list definition and confirm tests GREEN.
- [ ] Write failing drawer/navigation tests; add “打开详情页” for accounts only; confirm GREEN.
- [ ] Write failing detail tests for skeleton, success, empty relations, partial, 404, 503 retry, coalesced refresh and no mutation.
- [ ] Implement `AccountDetailView.vue`, route guard and sync-triggered reread; confirm targeted tests GREEN.

### Task 5: Independent Review, Regression, Browser QA, Docs and Guarded Package

**Files:**
- Modify: the five admin-web integration documents
- Create: a new timestamped local-only guarded package

- [ ] Run independent backend/security review; fix all P0/P1 with failing regressions first.
- [ ] Run all cloudfunction tests and all Web tests.
- [ ] Run TypeScript, ESLint, Mock build, Real/test build and Real asset scan.
- [ ] Run `node --check`, JSON parse and UTF-8 replacement-character scans for changed files/package.
- [ ] Browser-test Mock list/detail and Real/test login/loading at 390/1024/1280 with console inspection.
- [ ] Update five integration documents with exact completed/unverified boundaries.
- [ ] Generate guarded package, verify function list A-Z, hashes, excluded directories and `uploadPerformed=false`.
- [ ] Obtain final independent review and report no upload/deploy/production writes.
