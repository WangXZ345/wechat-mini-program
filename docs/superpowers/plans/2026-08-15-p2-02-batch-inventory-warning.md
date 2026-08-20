# P2-02 Batch Inventory Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the real admin-web batch warning-threshold write path with strict per-product snapshots, partial-result reporting, and no stock mutation.

**Architecture:** Keep the browser behind the existing BFF and reuse the canonical `inventoryWarningService.setWarningStock` for every item. The BFF adapts the strict P1-06 batch request into independent canonical calls, derives a stable per-item idempotency key, and returns the P1-06 `BatchResult`; the existing resource page validates selected snapshots, submits one common threshold, and summarizes every failed product.

**Tech Stack:** Vue 3, TypeScript, Element Plus, Vitest, Node.js `node:test`, CloudBase cloud functions.

## Global Constraints

- Work only in `D:\王希哲\NEW`; preserve every pre-existing uncommitted change and do not commit, upload, deploy, publish, or call production.
- Use `apply_patch` for edits. Never reset, clean, delete, or overwrite unrelated work.
- The batch limit is the P1-06 limit of 50 items. Every item carries a non-negative safe-integer `version`; warning thresholds are integers from 0 through 99999.
- Reuse permission `inventory:set_warning`; do not expand procurement access to price, account, payment, settings, or other domains.
- Only warning-related product fields may change through the canonical service. `stock` must remain unchanged; no parallel collection or alternate write path is allowed.
- Successful items must retain canonical inventory log, operation log, and `sync_events` behavior. Failed items must not emit success records.
- Preserve strict request fields, CSRF, session actor revalidation, safe public error messages, and stable per-item results. Never echo payloads or sensitive fields.
- Follow RED -> observed expected failure -> minimal GREEN. Do not weaken or delete existing tests.
- Existing P1 files are dirty dependency artifacts. Inspect each target diff before editing and report any overlap that cannot be preserved.

---

### Task 1: Open the real batch warning path end to end

**Files:**
- Modify: `cloudfunctions/adminWebApi/index.js`
- Modify: `cloudfunctions/adminWebApi/test/inventory-warning-mutation.test.js` or create `cloudfunctions/adminWebApi/test/inventory-warning-batch-mutation.test.js`
- Modify: `admin-web/src/config/resources.ts`
- Modify: `admin-web/src/modules/resources/OperationsView.vue`
- Modify: `admin-web/src/modules/resources/OperationsView.spec.ts`
- Modify: `admin-web/src/services/transport/batch-result-model.ts`
- Modify: `admin-web/src/services/transport/batch-result-model.spec.ts`
- Read-only verification: `cloudfunctions/common/services/inventoryWarningService.js`, `cloudfunctions/adminWebApi/lib/batchContract.js`, `cloudfunctions/adminWebApi/lib/batchExecutor.js`, `cloudfunctions/updateProductWarningStock/test/inventoryWarningService.test.js`

**Interfaces:**
- Consumes: `executeBatch(rawRequest, { handleItem }, options)` from `cloudfunctions/adminWebApi/lib/batchExecutor.js` and `inventoryWarningService.setWarningStock({ actor, input, idempotencyKey, requestId, batchId, requireExpectedVersion: true })`.
- Produces request: `{ requestId, batchId, items: Array<{ id, key, version, payload: { warningThreshold, expectedWarningThreshold, reason } }> }` with unique product `id` and `key` values.
- Produces response: P1-06 `BatchResult` with `requestId`, `batchId`, `overallStatus`, exact `counts`, and one public result per product.
- Produces frontend parser: `parseBatchResult(value: unknown): BatchResult`, which fails closed on malformed aggregate or item data before the UI reports success.

- [ ] **Step 1: Write backend RED tests**

  Add behavior tests that currently fail because `inventory/batch-warning` is unmigrated. Cover: route enabled for `inventory` and `inventory-alerts`; strict body/header and 50-item limit; duplicate product identity rejected before writes; all-success and mixed success/version-conflict/not-found results; exact actor and per-item `expectedVersion`/`expectedWarningThreshold`; stable per-item idempotency keys on duplicate submission; permission and CSRF before the handler; safe error output; later items continue after one failure.

- [ ] **Step 2: Observe backend RED**

  Run from the repository root:

  ```powershell
  & 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test 'cloudfunctions/adminWebApi/test/inventory-warning-mutation.test.js' 'cloudfunctions/adminWebApi/test/inventory-warning-batch-mutation.test.js'
  ```

  Expected: the new batch cases fail because `inventoryWarningRoute` accepts only `set-warning` and dispatch returns the unmigrated/mutation-not-supported error. Record the exact failing test count and messages.

- [ ] **Step 3: Implement the minimal BFF adapter**

  Import `executeBatch`. Extend only the inventory-warning route to accept `batch-warning`. For the batch branch:

  - require the same authenticated active actor, CSRF protection, and `inventory:set_warning` permission already enforced by the generic mutation boundary and canonical service;
  - validate the idempotency header with the existing helper;
  - pass the strict `{ requestId, batchId, items }` body through `executeBatch`, preserving the 50-item bound and duplicate rejection from `batchContract`;
  - for each item, accept only payload fields `warningThreshold`, `expectedWarningThreshold`, and `reason`; require `item.id === item.key` so product identity cannot diverge; map `item.version` to canonical `expectedVersion`;
  - derive a fixed-length per-item idempotency key from the outer idempotency key plus item identity using SHA-256, so a repeated identical request reuses the canonical result and a changed payload with the same key conflicts;
  - call only `setWarningStock`; map validation, not-found, conflict, permission, and service failures to the P1-06 public statuses/codes without exposing raw database messages;
  - do not add receipts, collections, stock writes, permission bypasses, or alternate logging.

- [ ] **Step 4: Verify backend GREEN and canonical invariants**

  Run:

  ```powershell
  & 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test 'cloudfunctions/adminWebApi/test/inventory-warning-mutation.test.js' 'cloudfunctions/adminWebApi/test/inventory-warning-batch-mutation.test.js' 'cloudfunctions/adminWebApi/test/batch-framework.test.js' 'cloudfunctions/updateProductWarningStock/test/inventoryWarningService.test.js'
  ```

  Expected: all selected tests pass, including the canonical assertions that stock is unchanged and success writes inventory log plus operation/sync records transactionally.

- [ ] **Step 5: Write frontend RED tests**

  Extend `batch-result-model.spec.ts` with strict parser cases for all-success, partial, malformed counts/items, unsafe retry flags, and duplicate identities. Extend `OperationsView.spec.ts` so real mode must enable `batch-warning`, reject empty/over-50/duplicate/invalid snapshot selections, submit exact item snapshots with a common integer threshold, keep the same idempotency context for an unchanged retry, rotate it after the payload changes, display exact success/failure counts plus failed product IDs/reasons, close and reload after a valid result, and remain closed without `inventory:set_warning`.

- [ ] **Step 6: Observe frontend RED**

  Run from `admin-web`:

  ```powershell
  & 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '..\node_modules\vitest\vitest.mjs' run 'src/services/transport/batch-result-model.spec.ts' 'src/modules/resources/OperationsView.spec.ts' --reporter=verbose
  ```

  Expected: new cases fail because the real bulk action is disabled and there is no strict batch parser/submission branch. Record the exact failures.

- [ ] **Step 7: Implement the minimal frontend flow**

  - Mark only the two existing `batch-warning` resource definitions as `realEnabled: true`.
  - Validate 1 through 50 selected rows; require unique safe product IDs, valid current warning thresholds, and non-negative safe-integer versions.
  - Reuse the existing action dialog for one common threshold and optional reason. Build exact batch items with product ID as both `id` and `key`, row version as `version`, and the desired/current threshold plus reason in `payload`.
  - Keep `requestId`, `batchId`, and the HTTP idempotency header stable for an unchanged retry and rotate the context when the batch payload changes.
  - Parse the response with `parseBatchResult`, recompute/verify counts from items, and fail closed on malformed responses. Show exact counts and failed product IDs with safe reasons; refresh the real list so persisted thresholds are re-read.
  - Keep single-item `set-warning`, inventory adjustment, mock behavior, and every unrelated resource action unchanged.

- [ ] **Step 8: Verify frontend GREEN**

  Run the two targeted Vitest files again. Expected: both files pass with zero failures and no warnings caused by the new cases.

- [ ] **Step 9: Run fresh regression and build checks**

  Run from `admin-web`:

  ```powershell
  & 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '..\node_modules\vitest\vitest.mjs' run 'src/modules/resources/OperationsView.spec.ts' 'src/services/transport/http-transport.spec.ts' 'src/services/transport/batch-result-model.spec.ts'
  & 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '..\node_modules\typescript\bin\tsc' --noEmit -p tsconfig.app.json
  ```

  Then use the bundled npm runtime or project-local CLIs to run `npm run lint` and `npm run build`. From the repository root run the complete `cloudfunctions/adminWebApi` test suite, `git diff --check`, syntax checks for every changed `.js`, and a focused sensitive-field scan. Report each command, exit code, pass/fail/skip count, and any Windows baseline limitation separately.

- [ ] **Step 10: Self-review and write the execution report**

  Confirm the diff contains no unrelated changes, no stock assignment in the batch adapter, no new collection, no raw sensitive logging, and no upload/deploy action. Write the required report with baseline, modified files, RED/GREEN evidence, regression/build evidence, remaining risks, and deployment scope. Do not commit in this dirty shared checkout.
