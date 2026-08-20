# P2-01 Order Internal Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the admin-web order-detail internal note UI to a real, permission-gated, append-only, idempotent CloudBase write path.

**Architecture:** Add a canonical `orderNoteService` used by `adminWebApi`, persist compatibility summary fields plus append records in `note_logs`, and write audit/sync events in the same transaction. Extend the strict order detail DTO with permission-gated note entries and keep customer queries stripped.

**Tech Stack:** Node.js CommonJS cloud functions, CloudBase transactions, Vue 3, TypeScript, Zod, Vitest, Node test runner.

## Global Constraints

- Work only in `D:\王希哲\NEW`; preserve all existing dirty P1-03 through P1-08 changes and do not reset or overwrite unrelated files.
- No production connection, CloudBase upload, admin-web deployment, mini-program publish, real account operation, destructive command, or real business-data write.
- Use `orders`, `note_logs`, `admin_operation_logs`, and `sync_events`; do not create a parallel collection or business system.
- Require active server-side authorization for `order:edit_remark`; UI visibility is not a security boundary.
- Note content is 1 to 500 trimmed characters, rendered as text, and never included in operation logs, sync events, customer responses, or console logs.
- Require `expectedVersion` and `Idempotency-Key`; a duplicate request must reuse one append result and a concurrent stale request must fail with `DATA_VERSION_CONFLICT`.
- Follow RED, observe the expected failure, then implement the smallest GREEN; never weaken or delete a test to pass.
- Keep canonical and deployable copies hash-identical wherever this repository's packaging/tests require parity.

---

### Task 1: Real order internal-note end-to-end slice

**Files:**
- Create: `cloudfunctions/common/services/orderNoteService.js`
- Create: `cloudfunctions/common/services/orderNoteService.test.js`
- Create or modify: `cloudfunctions/adminWebApi/lib/orderNoteService.js`
- Modify: `cloudfunctions/adminWebApi/index.js`
- Create: `cloudfunctions/adminWebApi/test/order-note-mutation.test.js`
- Modify: `cloudfunctions/adminWebApi/lib/orderQueryService.js`
- Modify: `cloudfunctions/common/services/orderQueryService.js`
- Modify: `cloudfunctions/getOrders/orderQueryService.js`
- Modify: `cloudfunctions/common/services/orderQueryService.test.js`
- Modify: `cloudfunctions/adminWebApi/test/order-query-route.test.js`
- Modify: `cloudfunctions/getOrders/index.test.js`
- Modify: `admin-web/src/services/transport/order-query-contract.ts`
- Create: `admin-web/src/services/transport/order-query-contract.spec.ts`
- Modify: `admin-web/src/modules/orders/OrderDetailView.vue`
- Modify: `admin-web/src/modules/orders/OrderDetailView.spec.ts`
- Modify only if packaging parity requires it: `scripts/package-admin-web-cloudfunctions.ps1`

**Interfaces:**
- Consumes: `idempotency.runIdempotentAction`, `idempotency.assertIdempotencyKey`, `operationOutbox.writeOperationBundle`, `operationOutbox.buildSyncEvent`, `order:edit_remark`, generic `transport.mutate`.
- Produces: `createOrderNoteService({ db, idempotency, now, randomId }).appendNote(command)`, `POST /orders/remark`, and `OrderDetail.internalNotes?: OrderInternalNote[]`.

- [ ] **Step 1: Write backend RED tests**

Add tests that invoke real service/route code and fail because `appendNote` and the route do not exist. Hand-derived fixtures must cover: success shape, unauthorized actor, empty/non-string/501-char content, unknown body field, missing order, missing/invalid version, stale version, repeated idempotency key, concurrent stale append, and audit/outbox failure rollback. The service fixture must expose stored `orders`, `note_logs`, `admin_operation_logs`, `sync_events`, and idempotency records for outcome assertions.

- [ ] **Step 2: Run backend RED and confirm the failure reason**

Run:

```powershell
$node=(Get-Command node).Source
& $node --test cloudfunctions/common/services/orderNoteService.test.js
& $node --test cloudfunctions/adminWebApi/test/order-note-mutation.test.js
```

Expected: tests fail specifically because the service/route and returned note contract are missing, not because of a fixture or syntax error.

- [ ] **Step 3: Implement the minimal canonical write service and API route**

Implement strict normalization equivalent to:

```js
const input = {
  orderId: cleanString(raw.orderId, 128),
  content: raw.content.trim(),
  expectedVersion: assertNonNegativeSafeInteger(raw.expectedVersion)
};
```

Use `runIdempotentAction` around one transaction. In the transaction read `orders/{orderId}`, compare version, add one `note_logs` record, update `{ adminNote, adminRemark, adminNoteUpdatedAt, adminNoteUpdatedBy, updatedAt, version }`, then call `writeOperationBundle`. The public result is `{ note, version, updatedAt, changed, reused }`; do not return or log openid.

Add route helpers for `orders/remark`: strict body fields `id/content/expectedVersion`, idempotency header, safe error mapping, dependency injection for tests, and a result envelope with `affected`, `item`, `message`, and `requestId`.

- [ ] **Step 4: Run backend GREEN**

Run the two commands from Step 2 and the relevant existing suites:

```powershell
& $node --test cloudfunctions/adminWebApi/test/order-query-route.test.js cloudfunctions/adminWebApi/test/core.test.js
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 5: Write query and customer-isolation RED tests**

Add tests proving authorized details receive `internalNotes: []` or safe entries, unauthorized details omit `internalNotes/adminRemark`, missing `note_logs` degrades to `[]`, and customer `getOrders` cannot expose `internalNotes`, `content`, `authorId`, `authorRole`, or `authorName` from order-shaped input.

- [ ] **Step 6: Run query RED and confirm the failure reason**

```powershell
& $node --test cloudfunctions/common/services/orderQueryService.test.js
& $node --test cloudfunctions/getOrders/index.test.js
```

Expected: new authorized-note tests fail because the query does not yet load/project append records; customer negative tests must identify any leaked field rather than merely inspect source text.

- [ ] **Step 7: Implement permission-gated note projection and copy parity**

Load at most 100 order `note_logs`, newest first, only after `order:edit_remark` authorization. Normalize `content || afterNote`, omit invalid/empty entries, convert dates to ISO, and project only the six DTO fields. Keep the three `orderQueryService.js` copies byte-identical.

- [ ] **Step 8: Run query GREEN and copy checks**

```powershell
& $node --test cloudfunctions/common/services/orderQueryService.test.js
& $node --test cloudfunctions/getOrders/index.test.js
Get-FileHash cloudfunctions/common/services/orderQueryService.js,cloudfunctions/adminWebApi/lib/orderQueryService.js,cloudfunctions/getOrders/orderQueryService.js -Algorithm SHA256
```

Expected: tests pass and all three SHA-256 hashes match.

- [ ] **Step 9: Write frontend RED tests**

Add contract/UI tests for optional permission-gated notes, real submit arguments, disabled blank submit, 500-character boundary, 501-character client rejection, idempotency-key reuse after a failed request, version refresh after success, conflict display, and XSS content rendered as text with no injected DOM node.

- [ ] **Step 10: Run frontend RED and confirm the failure reason**

```powershell
Set-Location admin-web
& $node .\node_modules\vitest\vitest.mjs run src/services/transport/order-query-contract.spec.ts src/modules/orders/OrderDetailView.spec.ts
```

Expected: new tests fail because the strict DTO and page do not yet support `internalNotes` or mutation.

- [ ] **Step 11: Implement the minimal strict DTO and order-detail interaction**

Add `OrderInternalNote` to the Zod contract with strict bounds and optional `internalNotes`. In `OrderDetailView.vue`, show the editor only when `internalNotes !== undefined`; use Element Plus textarea/button/alert, keep the current content as text interpolation, retain an idempotency key across a retry of unchanged content, call `transport.mutate("orders", "remark", { id, content, expectedVersion }, options)`, and merge the returned note/version or reload safely.

- [ ] **Step 12: Run frontend GREEN**

Run the command from Step 10. Expected: all selected tests pass with zero failures and no Vue warnings caused by the new component behavior.

- [ ] **Step 13: Run full scoped verification**

```powershell
Set-Location D:\王希哲\NEW\cloudfunctions\adminWebApi
& $node --test test/*.test.js
Set-Location D:\王希哲\NEW\cloudfunctions\getOrders
& $node --test index.test.js
Set-Location D:\王希哲\NEW\admin-web
& $node .\node_modules\vitest\vitest.mjs run
& $node .\node_modules\vue-tsc\bin\vue-tsc.js --noEmit -p tsconfig.app.json
& $node .\node_modules\eslint\bin\eslint.js . --max-warnings=0
& $node .\node_modules\vite\bin\vite.js build --mode test
& $node scripts/verify-real-build.mjs
Set-Location D:\王希哲\NEW
git diff --check
```

Record every exit code and test pass/fail/skip count. Separately report any Windows baseline warning/skip. Do not claim CloudBase, browser E2E, WeChat DevTools, real-device, deployment, upload, publish, or production verification.
