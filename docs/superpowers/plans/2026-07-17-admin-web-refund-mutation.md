# Admin Web Refund Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Web refund page's Mock-only mutations and `501 SERVICE_NOT_MIGRATED` path with one shared, transaction-safe refund service used by both `afterSales` and `adminWebApi`.

**Architecture:** Put refund creation, offline confirmation, rejection, immutable recovery evidence, recalculation ownership, and safe sync outbox writes in `cloudfunctions/common/services/refundMutationService.js`. Deployment-local copies in `afterSales/common/services/` and `adminWebApi/lib/` must be byte-identical to the canonical file and are adapters only. The Web BFF validates a strict DTO, enforces finance/super-admin role boundaries, and returns a safe projection; the Vue page uses a dedicated contract and never falls back to Mock in Real mode.

**Tech Stack:** Node.js CommonJS CloudBase cloud functions, CloudBase transactions, shared idempotency service, Vue 3, TypeScript, Zod, Vitest, Node test runner.

## Global Constraints

- Work only in `D:\王希哲\NEW\.worktrees\admin-web-payment-review` on branch `codex/admin-web-payment-review`.
- Do not upload cloud functions, connect to a real CloudBase environment, deploy the Web app, publish the mini-program, or write production/test-cloud data.
- Preserve integer-cent money storage, existing order/payment/refund limits, inventory restoration timing, role permissions, and legacy mini-program action names.
- A return-required after-sale may be refunded only after a completed inspection; `received` and `inspecting` are not sufficient.
- Web refund mutations are restricted to active `finance` and `super_admin`, even if another role is injected with a refund permission string.
- `createWechatPayRefund` and `handleWechatRefundNotify` remain explicit fail-closed stubs and must perform zero business writes.
- Real-mode failures must not fall back to Mock data or display a success state.
- Do not expose `openid`, `userId`, full refund account data, proof URLs, WeChat transaction identifiers, or raw internal journal data in Web responses or sync events.
- Do not swallow transaction write failures. A failed `order_items`, log, journal, or sync event write must abort the whole transaction.
- Do not create a Git commit unless the user explicitly asks to save a Git version.

---

### Task 1: Canonical Refund Transaction And Recovery Service

**Files:**
- Create: `cloudfunctions/common/services/refundMutationService.js`
- Create: `cloudfunctions/common/services/refundMutationService.test.js`
- Create: `cloudfunctions/afterSales/common/services/refundMutationService.js`
- Create: `cloudfunctions/adminWebApi/lib/refundMutationService.js`
- Modify: `cloudfunctions/afterSales/index.js`

**Interfaces:**
- Consumes: `{ db, idempotency, ownerKeyFor, syncOwnerPepper, recalculateAccount, now, randomId }`.
- Produces: `createRefundMutationService(dependencies)`.
- Produces service methods:

```js
service.createRefundRecord({ actor, input, idempotencyKey, strict })
service.processOfflineRefund({ actor, input, idempotencyKey, strict })
service.rejectRefund({ actor, input, idempotencyKey, strict })
```

- Strict `processOfflineRefund` input:

```js
{
  refundRecordId,
  refundAmountCents,
  expectedRefundStatus,
  expectedRefundVersion,
  expectedRefundUpdatedAt,
  financeRemark,
  refundProofFileIds
}
```

- Strict `rejectRefund` input:

```js
{
  refundRecordId,
  expectedRefundStatus,
  expectedRefundVersion,
  expectedRefundUpdatedAt,
  rejectReason
}
```

- Public result:

```js
{
  item: { id, refundNo, status, version, updatedAt, amountCents },
  affected,
  reused,
  action,
  accountRecalculationPending
}
```

- [ ] **Step 1: Write failing role, amount, state, snapshot, and rollback tests**

Add Node tests which prove:

```js
await assert.rejects(
  () => service.processOfflineRefund(commandFor({ role: "customer_service" })),
  error => error.code === "FORBIDDEN"
);
await assert.rejects(
  () => service.processOfflineRefund(commandFor({ refundAmountCents: 10.5 })),
  error => error.code === "INVALID_REFUND_AMOUNT"
);
await assert.rejects(
  () => service.processOfflineRefund(commandFor({ afterSaleStatus: "received" })),
  error => error.code === "RETURN_INSPECTION_REQUIRED"
);
```

Cover stale status/version/updatedAt, approval-limit overflow, paid-limit overflow, duplicate immutable evidence, missing immutable evidence, more than 100 historical refund rows, proof-count/format limits, and every transaction write failure including `order_items`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/common/services/refundMutationService.test.js
```

Expected: fail because `createRefundMutationService` and the strict refund behavior do not exist.

- [ ] **Step 3: Implement strict validation and immutable evidence**

Implement:

```js
class RefundMutationError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function createRefundMutationService(dependencies = {}) {
  return {
    createRefundRecord,
    processOfflineRefund,
    rejectRefund
  };
}
```

The service must use deterministic business keys, query recovery evidence with `limit(2)`, reject duplicate/conflicting evidence, cross-check confirmed refund evidence against `after_sales.actualRefundAmount` and `orders.totalRefundAmount`, and freeze the committed public result in `admin_operation_logs.journal`.

- [ ] **Step 4: Implement atomic mutation, safe outbox, and recalculation recovery**

Within the business transaction:

```js
await writeRefundRecord(...);
await writeAfterSale(...);
await writeOrder(...);
await writeOrderItems(...);
await writeAccountLog(...);
await writeRefundLog(...);
await writeAfterSaleLog(...);
await writeAdminJournal(...);
await writeOwnerSyncEvent(...);
await writeAdminSyncEvent(...);
```

The journal must contain a recalculation owner, expected order version, and completion business key. A retry after committed-business/failed-idempotency-finalization must recover only from the journal and matching immutable rows, then retry account recalculation and compare-before-clear the marker.

- [ ] **Step 5: Adapt legacy `afterSales` actions to the shared service**

Keep existing action names and legacy payload aliases, but map them to the shared service. Strict Web-only expected snapshots remain optional for legacy mini-program calls; role, amount, state, evidence, transaction, and idempotency protections remain mandatory.

- [ ] **Step 6: Copy canonical service and verify byte identity**

Copy the canonical implementation to both deployment-local paths, then verify:

```powershell
Get-FileHash cloudfunctions/common/services/refundMutationService.js
Get-FileHash cloudfunctions/afterSales/common/services/refundMutationService.js
Get-FileHash cloudfunctions/adminWebApi/lib/refundMutationService.js
```

Expected: all three SHA-256 hashes are identical.

- [ ] **Step 7: Run focused tests and confirm GREEN**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/common/services/refundMutationService.test.js
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check cloudfunctions/afterSales/index.js
```

Expected: all refund service tests pass and `afterSales/index.js` parses.

### Task 2: Web BFF Refund Mutation Contract

**Files:**
- Modify: `cloudfunctions/adminWebApi/index.js`
- Modify: `cloudfunctions/adminWebApi/lib/core.js`
- Create: `cloudfunctions/adminWebApi/test/refund-mutation.test.js`
- Modify: `cloudfunctions/adminWebApi/test/core.test.js`
- Modify: `cloudfunctions/adminWebApi/test/projection-security.test.js`

**Interfaces:**
- Consumes: `createRefundMutationService`.
- Produces working `POST /api/admin/v1/refunds/process` and `POST /api/admin/v1/refunds/reject`.
- Keeps unsupported Web create and WeChat refund routes explicit `404 MUTATION_NOT_SUPPORTED`.

- [ ] **Step 1: Write failing route, permission, CSRF, DTO, and projection tests**

Cover:

```js
assert.equal(response.item.status, "refunded");
assert.equal("userId" in response, false);
assert.equal("openid" in response, false);
await assert.rejects(() => dispatchAs("customer_service"), error => error.statusCode === 403);
await assert.rejects(() => dispatchWithWrongCsrf(), error => error.code === "CSRF_VALIDATION_FAILED");
```

Also prove missing idempotency key, stale expected snapshot, unknown request keys, injected limits/roles/openids, and invalid service responses fail closed.

- [ ] **Step 2: Run the BFF refund test and confirm RED**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/adminWebApi/test/refund-mutation.test.js
```

Expected: fail with `SERVICE_NOT_MIGRATED` or missing refund route helpers.

- [ ] **Step 3: Implement the strict BFF adapter**

Add route detection, role assertion, input normalizers, error mapping, service invocation, and response projection:

```js
if (refundMutationRoute(route)) {
  assertWebRefundMutation(auth.principal);
  const normalized = normalizeRefundMutation(request, route.mutationAction);
  const result = route.mutationAction === "process"
    ? await service.processOfflineRefund(command)
    : await service.rejectRefund(command);
  return refundMutationResult(result, request.requestId);
}
```

The BFF must never pass `role`, `openid`, `userId`, paid amount, approved amount, or a client-computed refund limit to the service.

- [ ] **Step 4: Align refund read projection and canonical statuses**

The refund list/detail projection must include only:

```js
{
  id,
  refundNo,
  orderNo,
  customerMasked,
  method,
  status,
  amountCents,
  version,
  updatedAt
}
```

Use canonical statuses: `pending`, `processing`, `refunded`, `partial_refunded`, `failed`, `rejected`, `cancelled`.

- [ ] **Step 5: Run BFF tests and confirm GREEN**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/adminWebApi/test/refund-mutation.test.js cloudfunctions/adminWebApi/test/core.test.js cloudfunctions/adminWebApi/test/projection-security.test.js
```

Expected: all selected BFF tests pass.

### Task 3: Web Refund UI Contract And Real/Mock Parity

**Files:**
- Create: `admin-web/src/services/transport/refund-mutation-contract.ts`
- Create: `admin-web/src/services/transport/refund-mutation-contract.spec.ts`
- Modify: `admin-web/src/services/transport/http-transport.ts`
- Modify: `admin-web/src/services/transport/http-transport.spec.ts`
- Modify: `admin-web/src/services/transport/mock-transport.ts`
- Modify: `admin-web/src/services/transport/mock-transport.spec.ts`
- Modify: `admin-web/src/services/transport/mock-data.ts`
- Modify: `admin-web/src/config/resources.ts`
- Modify: `admin-web/src/modules/resources/OperationsView.vue`
- Modify: `admin-web/src/modules/resources/OperationsView.spec.ts`

**Interfaces:**
- Produces `buildRefundProcessPayload`, `buildRefundRejectPayload`, and `parseRefundMutationResult`.
- Uses the existing generic dialog but sends refund-specific fields and expected snapshots.

- [ ] **Step 1: Write failing frontend contract and UI tests**

Prove:

```ts
expect(buildRefundProcessPayload(row, form)).toEqual({
  refundRecordId: row.id,
  refundAmountCents: row.amountCents,
  expectedRefundStatus: row.status,
  expectedRefundVersion: row.version,
  expectedRefundUpdatedAt: row.updatedAt,
  financeRemark: form.remark,
  refundProofFileIds: []
});
```

Verify only `pending`, `processing`, and `failed` records show process/reject actions; `refunded`, `partial_refunded`, `rejected`, and `cancelled` do not. Verify Mock and Real enforce the same role/status/DTO/result contract.

- [ ] **Step 2: Run focused frontend tests and confirm RED**

Run:

```powershell
Set-Location admin-web
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules/vitest/vitest.mjs run src/services/transport/refund-mutation-contract.spec.ts src/modules/resources/OperationsView.spec.ts src/services/transport/http-transport.spec.ts src/services/transport/mock-transport.spec.ts
```

Expected: fail because the refund contract and canonical state gating are missing.

- [ ] **Step 3: Implement contract, transport mapping, and canonical states**

Use Zod to reject missing version/timestamp, non-integer cents, unknown states, and unsafe response fields. Real transport sends the strict payload and preserves `401/403/409/501/503` errors without Mock fallback. Mock transport uses the same validator and role/status rules.

- [ ] **Step 4: Implement state-gated refund actions**

Keep the current page layout. For `process`, default the amount to the immutable row amount and require a current version/timestamp. For `reject`, require a non-empty reason. Rotate the idempotency key after success or conflict, but retain it for an unchanged network retry.

- [ ] **Step 5: Run focused tests, typecheck, and build**

Run:

```powershell
Set-Location admin-web
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules/vitest/vitest.mjs run src/services/transport/refund-mutation-contract.spec.ts src/modules/resources/OperationsView.spec.ts src/services/transport/http-transport.spec.ts src/services/transport/mock-transport.spec.ts
npm run typecheck
npm run build
```

Expected: focused tests, typecheck, and build all pass.

### Task 4: Regression, Documentation, Packaging, And Independent Review

**Files:**
- Modify: `scripts/package-admin-web-cloudfunctions.ps1`
- Modify: `docs/after-sales-refunds.md`
- Modify: `docs/admin-web-api-mapping.md`
- Modify: `docs/admin-web-integration-progress.md`
- Modify: `docs/admin-web-realtime-test.md`
- Modify: `docs/web-admin-test-deployment-and-rollback.md`

**Interfaces:**
- Produces an auditable deployment candidate only; `uploadPerformed` remains `false`.

- [ ] **Step 1: Add packaging hash and forbidden-file gates**

The packaging script must verify all three refund service copies match the canonical SHA-256 and include every changed cloud function in the A-Z manifest. It must reject `.env`, credentials, private keys, customer exports, and temporary review files.

- [ ] **Step 2: Update docs with exact implemented and unverified boundaries**

Document canonical statuses, role matrix, immutable evidence, recalculation recovery, sync events, Web routes, required indexes, rollback steps, and the fact that CloudBase transactions/indexes, live BFF/Cookie/CSRF, dual-end sync, 1-3 second latency, upload, deployment, and publishing remain unverified.

- [ ] **Step 3: Run all Cloud and Web tests**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/common/services/*.test.js cloudfunctions/adminWebApi/test/*.test.js cloudfunctions/afterSales/test/*.test.js miniprogram/pages/admin/after-sales/detail/index.test.js
Set-Location admin-web
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules/vitest/vitest.mjs run
npm run typecheck
npm run build
```

Expected: zero failures.

- [ ] **Step 4: Run static safety checks and package dry run**

Run:

```powershell
git diff --check
rg -n "�" cloudfunctions admin-web/src docs scripts miniprogram
powershell -ExecutionPolicy Bypass -File scripts/package-admin-web-cloudfunctions.ps1
```

Expected: no diff errors, no replacement characters in changed files, package verification succeeds, and `uploadPerformed=false`.

- [ ] **Step 5: Perform independent final review**

The review thread must check:

```text
spec compliance
transaction rollback
immutable evidence recovery
refund and paid amount ceilings
return inspection gate
role hard boundary
safe BFF projection
sync outbox
Mock/Real parity
package manifest and no production action
```

Critical or Important findings return to the implementation thread for a focused fix and re-review before delivery.
