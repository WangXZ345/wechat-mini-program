# Order Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将订单人工审核/驳回收敛到 Web 与小程序共用的严格、幂等、事务性 `orderReviewService`，并开放 Web 单笔动作。

**Architecture:** 新增 canonical `cloudfunctions/common/services/orderReviewService.js`，旧 `adminReviewOrder` 只做兼容适配；`adminWebApi` 只做 session/CSRF/严格合同与安全 DTO。审核通过在单事务内聚合订单明细、校验库存、扣减库存、入账、写审计和 `sync_events`；驳回只更新订单与审计/outbox。

**Tech Stack:** Node.js CommonJS cloud functions, CloudBase transactions, existing idempotency helpers, Vue 3 + TypeScript + Vitest, PowerShell verification.

## Global Constraints

- 保持 `pending_admin`/`auto_reviewing` 起始状态和 `approved_pending_payment` 结果状态。
- 审核通过仍在服务端扣库存；驳回不扣库存；金额以整数分存储。
- 旧 `adminReviewOrder` 参数和 `{ok,data/message}` 响应兼容。
- Web 必须发送 `expectedVersion`、`expectedStatus`、`Idempotency-Key`，禁止浏览器直接写集合。
- 不开放批量审核；不上传云函数、不连接生产环境、不执行真实数据写入。

---

### Task 1: Canonical review service contract and pure validation

**Files:**
- Create: `cloudfunctions/common/services/orderReviewService.js`
- Create: `cloudfunctions/common/services/orderReviewService.test.js`

**Interfaces:**
- Produces `createOrderReviewService({ db, command, stockAlert, idempotency })`.
- Produces `reviewOrder({ actor, input, idempotencyKey, strict })` returning `{ item, affected, reused, decision, requestId }`.

- [ ] **Step 1: Write failing tests** for actor permission, strict snapshots, decision/reason normalization, quantity/amount safety, status guards, same-product aggregation, and 100-row overflow.
- [ ] **Step 2: Run the focused test** and confirm failures are caused by the missing service contract.
- [ ] **Step 3: Implement only normalization and validation helpers**, including `OrderReviewError`, `normalizeActor`, `normalizeInput`, safe integer checks, and grouped items.
- [ ] **Step 4: Run the focused test** and confirm the validation suite passes.

### Task 2: Transactional approve/reject and idempotency recovery

**Files:**
- Modify: `cloudfunctions/common/services/orderReviewService.js`
- Modify: `cloudfunctions/common/services/orderReviewService.test.js`
- Inspect/reuse: `cloudfunctions/common/idempotency.js`, `cloudfunctions/common/services/inventoryMutationService.js`

**Interfaces:**
- `reviewOrder` performs one transaction and uses `order_deduct:<orderId>:<productId>` and `order_debt:<orderId>` business keys.

- [ ] **Step 1: Add failing transaction tests** for multi-product approval, duplicate product aggregation, insufficient stock zero-write, rejected order zero inventory/account writes, duplicate success replay, conflicting idempotency payload, and transaction rollback.
- [ ] **Step 2: Run focused tests** and confirm each new behavior fails.
- [ ] **Step 3: Implement the minimum transaction**, re-reading the order and all items, validating existing business logs, updating products/order/account/logs, incrementing order version, and writing value-free sync events.
- [ ] **Step 4: Add post-commit recovery tests** proving a committed business result can be reconstructed when the idempotency record is still processing.
- [ ] **Step 5: Run the service test file** and confirm all service tests pass.

### Task 3: Legacy adapter consolidation

**Files:**
- Modify: `cloudfunctions/adminReviewOrder/index.js`
- Modify: `cloudfunctions/adminReviewOrder/index.test.js` (create if absent)
- Modify: `cloudfunctions/adminReviewOrder/package.json`
- Create/flatten as required: `cloudfunctions/adminReviewOrder/orderReviewService.js`

- [ ] **Step 1: Add failing adapter tests** for old approve/reject payloads, missing legacy snapshots, old response envelope, and actor derivation from `admin_users`.
- [ ] **Step 2: Run the adapter tests** and confirm they fail against the duplicated implementation.
- [ ] **Step 3: Replace the duplicated transaction with the canonical adapter**, preserving old messages/envelope while mapping safe stable errors.
- [ ] **Step 4: Run adapter and canonical tests together** and confirm both contracts pass.

### Task 4: Strict BFF routes and Web transport contract

**Files:**
- Modify: `cloudfunctions/adminWebApi/index.js`
- Modify: `cloudfunctions/adminWebApi/lib/core.js`
- Create/modify: `cloudfunctions/adminWebApi/test/order-review-mutation.test.js`
- Create/modify: `admin-web/src/services/transport/order-review-contract.ts`
- Create/modify: `admin-web/src/services/transport/order-review-contract.spec.ts`
- Modify: `admin-web/src/services/transport/http-transport.ts`
- Modify: `admin-web/src/services/transport/http-transport.spec.ts`

- [ ] **Step 1: Write failing strict-contract and route tests** for exact fields, required headers, permission mapping, safe result projection, 400/403/409/503 errors, and no actor/amount/stock fields.
- [ ] **Step 2: Run tests** and confirm the current `501 SERVICE_NOT_MIGRATED` path fails them.
- [ ] **Step 3: Add strict normalization, BFF dispatch, error allowlist, and HTTP parsing** for `/orders/review` and `/orders/reject`.
- [ ] **Step 4: Run BFF and transport tests** and confirm they pass.

### Task 5: Mock transport and existing Web action UI

**Files:**
- Modify: `admin-web/src/services/transport/mock-transport.ts`
- Modify: `admin-web/src/services/transport/mock-transport.spec.ts`
- Modify: `admin-web/src/config/resources.ts`
- Modify: `admin-web/src/modules/resources/OperationsView.vue`
- Modify: `admin-web/src/modules/resources/OperationsView.spec.ts`

- [ ] **Step 1: Add failing Mock/UI tests** for `order:review`/`order:reject`, status eligibility, required reject reason, version conflict refresh, loading/error states, and batch-review remaining disabled.
- [ ] **Step 2: Run the tests** and confirm Mock returns unmigrated/incorrect behavior.
- [ ] **Step 3: Implement Mock state transitions and the smallest existing-dialog integration**, preserving current dense layout and sync refresh behavior.
- [ ] **Step 4: Run focused Web tests, typecheck, and lint.**

### Task 6: Independent review, regression, packaging and documentation

**Files:**
- Modify: `docs/admin-web-integration-progress.md`
- Modify: `docs/admin-web-api-mapping.md`
- Modify: `docs/admin-web-integration-plan.md`
- Modify: `docs/admin-web-realtime-test.md`
- Modify: `docs/web-admin-test-deployment-and-rollback.md`
- Modify: `scripts/package-admin-web-cloudfunctions.ps1`

- [ ] **Step 1: Run an independent read-only security/compatibility review** against the original design and all changed files.
- [ ] **Step 2: Fix only review findings with a new failing test first.**
- [ ] **Step 3: Run full Web tests, all target cloud-function tests, JS syntax checks, JSON parsing, typecheck, lint, Mock/Real builds, and browser checks.
- [ ] **Step 4: Generate a fresh guarded package**, verify A-Z function list, canonical hashes, exclusion rules, and `uploadPerformed=false`.
- [ ] **Step 5: Update documents with exact counts and package hash; explicitly state no upload, no deployment, and no real dual-end verification.
