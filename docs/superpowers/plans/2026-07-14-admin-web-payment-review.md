# Payment Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将付款确认/驳回收敛到 Web 与小程序共用的严格、幂等、事务性服务，并开放 Web 单笔全额确认与驳回。

**Architecture:** canonical `paymentMutationService` 负责付款记录、订单、账款、配送日志、审计和 outbox；`adminUpdatePayment` 变成旧小程序兼容适配器；`adminWebApi` 只做 session、CSRF、严格合同和安全响应。付款列表补充版本并只把订单当前凭证视为待确认。

**Tech Stack:** Node.js CommonJS CloudBase functions, existing idempotency/sync helpers, Vue 3, TypeScript, Zod, Vitest, Node test runner, PowerShell packaging.

## Global Constraints

- 上传付款截图不代表已付款；财务确认后才更新状态。
- 金额以安全整数分存储和计算，Web 不得提交最终付款金额、订单 ID或账款值。
- 重复确认不得重复写 `payment_records`、`account_logs` 或客户账款。
- Web 仅 active `finance/super_admin` 可写；确认需 `payment:confirm`，驳回需 `payment:update_status`。
- 旧 `adminUpdatePayment` 参数和 `{ok,data|message}` 兼容，旧 `partial_paid/abnormal/applyBatch` 语义保留。
- 事务内写审计和不含金额/PII/凭证 URL的 `sync_events`。
- 不修改现有 UI 风格；不连接生产、不上传云函数、不执行真实付款或发布。

---

### Task 1: Canonical payment service and RED/GREEN domain tests

**Files:**
- Create: `cloudfunctions/common/services/paymentMutationService.js`
- Create: `cloudfunctions/common/services/paymentMutationService.test.js`

**Interfaces:**
- Produces `createPaymentMutationService({ db, idempotency, ownerKeyFor, syncOwnerPepper, recalculateAccount, now, randomId })`.
- Produces `reviewWebPayment({ actor, input, idempotencyKey })`.
- Produces `updateLegacyPayment({ actor, input, idempotencyKey, allowMissingIdempotencyKey })`.
- Both return `{ paymentId, orderNo, status, version, updatedAt, affected, reused, decision, accountRecalculationPending, updatedCount }` without PII or proof URLs.

- [ ] **Step 1: Write failing contract tests.** Add tests requiring active finance/super_admin, exact confirm/reject permissions, strict `paymentId/expectedStatus/expectedVersion/expectedUpdatedAt`, required reject reason, forbidden client amount/order/actor fields, and legacy aliases.
- [ ] **Step 2: Verify RED.** Run `node --test cloudfunctions/common/services/paymentMutationService.test.js`; expected failure is `MODULE_NOT_FOUND` or missing exported API, not a test syntax error.
- [ ] **Step 3: Implement normalization only.** Add `PaymentMutationError`, strict actor normalization, safe integer/date/text helpers, `versionOf`, legacy money parser isolated from the Web path, and exact input allowlists.
- [ ] **Step 4: Add failing transaction tests.** Cover full confirm, reject, partial legacy, abnormal legacy, zero/overpay/dirty amount, stale latest record, stale order status, version/time conflict, same-key replay, changed-payload conflict, processing recovery, duplicate business logs, rollback at every companion write, batch >100/cross-customer, and account recalculation success/failure.
- [ ] **Step 5: Verify transaction RED.** Run the focused test and confirm new assertions fail because no domain writes occur.
- [ ] **Step 6: Implement the transaction.** Re-read record/order, calculate amounts server-side, update the original pending record in place, update order/account, write unique `account_logs`, conditional `delivery_logs`, `admin_operation_logs`, owner/admin `sync_events`, and increment record/order versions. Use `limit(2)` conflict checks and shared `runIdempotentAction` recovery.
- [ ] **Step 7: Verify GREEN.** Run the focused test until all service cases pass, then run `node --check` on the service.

### Task 2: Legacy `adminUpdatePayment` consolidation

**Files:**
- Modify: `cloudfunctions/adminUpdatePayment/index.js`
- Create: `cloudfunctions/adminUpdatePayment/paymentMutationService.js`
- Create or modify: `cloudfunctions/adminUpdatePayment/index.test.js`
- Inspect: `cloudfunctions/adminUpdatePayment/auth.js`, `cloudfunctions/adminUpdatePayment/common/idempotency.js`, `cloudfunctions/adminUpdatePayment/package.json`

**Interfaces:**
- Legacy event keeps `orderId`, `paymentStatus`, `isPartial`, `paidAmount`, `paidAmountCents`, `remark/paymentRemark`, `applyBatch`, `idempotencyKey`.
- Legacy response keeps `{ok:true,data}` or `{ok:false,message,code?}` and owner identifiers needed by existing callers.

- [ ] **Step 1: Write failing adapter tests.** Assert old four-status payloads, missing legacy snapshots/key compatibility, actor derived only from `requirePermission`, exact envelope, and stable idempotency errors.
- [ ] **Step 2: Verify RED.** Run adapter tests and confirm they expose duplicated legacy transaction behavior.
- [ ] **Step 3: Replace the handler with a thin adapter.** Instantiate the canonical service with local idempotency and owner-key helpers; map legacy input/output without accepting forged actor/openid.
- [ ] **Step 4: Verify GREEN.** Run canonical and adapter tests together and compare canonical/local service SHA256.

### Task 3: Payment query authority and strict Web BFF mutation

**Files:**
- Modify: `cloudfunctions/common/services/paymentQueryService.js`
- Modify: `cloudfunctions/common/services/paymentQueryService.test.js`
- Modify: `cloudfunctions/adminWebApi/index.js`
- Modify: `cloudfunctions/adminWebApi/lib/core.js`
- Create: `cloudfunctions/adminWebApi/lib/paymentMutationService.js`
- Create: `cloudfunctions/adminWebApi/test/payment-mutation.test.js`
- Modify: `cloudfunctions/adminWebApi/test/payment-query.test.js`

**Interfaces:**
- Payment query DTO adds non-negative integer `version`.
- `pending_confirm` is returned only when record ID equals order `latestPaymentRecordId` and order is still pending confirmation.
- BFF actions call `reviewWebPayment` with server session actor and return the exact safe mutation result.

- [ ] **Step 1: Write failing query tests.** Add stale pending record, current pending record, confirmed/rejected history and version projection cases.
- [ ] **Step 2: Write failing BFF tests.** Cover exact request fields, required header key, permissions/role hard gate, CSRF-before-service, safe 400/403/404/409/503 mapping, result whitelist and 501 removal only for payment confirm/reject.
- [ ] **Step 3: Verify RED.** Run both focused test files; current stale query and `SERVICE_NOT_MIGRATED` behavior must fail.
- [ ] **Step 4: Implement query and BFF changes.** Filter stale pending records with bounded scanning/cursor semantics, add version, instantiate canonical mutation service, normalize exact bodies, and project safe results.
- [ ] **Step 5: Verify GREEN.** Run the focused BFF/query suite and `node --check` on changed production JS.

### Task 4: Strict Web transport, Mock and existing UI

**Files:**
- Modify: `admin-web/src/services/transport/payment-query-contract.ts`
- Modify: `admin-web/src/services/transport/payment-query-contract.spec.ts`
- Create: `admin-web/src/services/transport/payment-mutation-contract.ts`
- Create: `admin-web/src/services/transport/payment-mutation-contract.spec.ts`
- Modify: `admin-web/src/services/transport/http-transport.ts`
- Modify: `admin-web/src/services/transport/http-transport.spec.ts`
- Modify: `admin-web/src/services/transport/mock-transport.ts`
- Modify: `admin-web/src/services/transport/mock-transport.spec.ts`
- Modify: `admin-web/src/config/resources.ts`
- Modify: `admin-web/src/modules/resources/OperationsView.vue`
- Modify: `admin-web/src/modules/resources/OperationsView.spec.ts`

**Interfaces:**
- UI sends `{ id, expectedStatus, expectedVersion, expectedUpdatedAt, reason }` and the existing `Idempotency-Key` header.
- Real action buttons are enabled only for current `pending_confirm` rows and correct permission.
- Mock applies the same strict state transition without simulating CloudBase side effects or exposing sensitive fields.

- [ ] **Step 1: Write failing contract tests.** Require exact request/result Zod schemas and reject extra amount/order/actor/proof fields.
- [ ] **Step 2: Write failing transport/UI tests.** Assert confirm/reject exact payload, reason required, status eligibility, role matrix, conflict refresh/key rotation, network retry key reuse and Mock/HTTP result parity.
- [ ] **Step 3: Verify RED.** Run focused Vitest files and confirm payment mutations remain disabled/501.
- [ ] **Step 4: Implement the smallest UI/transport change.** Add payment-specialized payload construction and response parsing, `realEnabled:true`, disabled action rules for non-pending rows, and Mock state transitions while preserving layout.
- [ ] **Step 5: Verify GREEN.** Run focused tests, `vue-tsc --noEmit`, and ESLint for changed Web files.

### Task 5: Independent review, packaging, docs and full regression

**Files:**
- Modify: `scripts/package-admin-web-cloudfunctions.ps1`
- Modify: `docs/admin-web-data-audit.md`
- Modify: `docs/admin-web-api-mapping.md`
- Modify: `docs/admin-web-integration-plan.md`
- Modify: `docs/admin-web-realtime-test.md`
- Modify: `docs/admin-web-integration-progress.md`
- Modify as needed: `docs/web-admin-test-deployment-and-rollback.md`

- [ ] **Step 1: Run an independent read-only review.** Check the design, domain service, adapters, BFF, Web contract, role boundaries, sensitive fields, batch compatibility and deployment gates. Record Critical/Important findings.
- [ ] **Step 2: Fix findings test-first.** For every accepted finding, add a focused failing regression test, implement the minimum fix, rerun focused tests and re-review.
- [ ] **Step 3: Update packaging.** Add `adminUpdatePayment` to the A-Z function list; copy canonical payment service into both deployment locations; verify canonical SHA256 equality, forbidden-directory exclusion and `uploadPerformed=false`.
- [ ] **Step 4: Run full verification.** Run all cloud tests, all Web tests, production JS syntax checks, JSON parsing, TypeScript, ESLint, Mock build, test/Real build verification and local browser checks for confirm/reject error and success states.
- [ ] **Step 5: Update documents with exact evidence.** Record test counts, function/JS/JSON counts, package path/hash, changed functions, index recommendations, rollback and unexecuted real CloudBase/dual-end checks. Do not claim real-time synchronization.
