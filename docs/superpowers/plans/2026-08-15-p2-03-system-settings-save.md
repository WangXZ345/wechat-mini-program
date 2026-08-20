# P2-03 System Settings Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the existing admin-web system settings page for secure real saves and make the saved payment, inventory-default, and session-idle values affect their real consumers.

**Architecture:** A canonical `systemSettingsService` owns the settings whitelist, validation, optimistic concurrency, idempotency, audit, payment logs, and sync event. `adminWebApi` supplies the strict HTTP boundary, while `updateSettings` remains a compatible adapter. A small session-policy helper snapshots and enforces the session idle value in both auth cloud functions.

**Tech Stack:** Node.js 22, `node:test`, WeChat CloudBase database transactions, Vue 3, TypeScript, Vitest, Element Plus.

## Global Constraints

- Keep `settings/system_settings` as the only system-settings document.
- Browser writes must pass `adminWebApi`; no direct CloudBase writes.
- Only active `super_admin` may use the Web save route.
- Preserve unknown stored settings and existing mini-program entrypoints.
- Do not enable or simulate WeChat Pay.
- Do not upload cloud functions, deploy admin-web, publish the mini-program, connect production, or write real data.

---

### Task 1: Canonical Settings Mutation

**Files:**
- Create: `cloudfunctions/common/services/systemSettingsService.js`
- Create: `cloudfunctions/common/services/systemSettingsService.test.js`
- Create: `cloudfunctions/adminWebApi/lib/systemSettingsService.js`
- Create: `cloudfunctions/updateSettings/systemSettingsService.js`
- Modify: `scripts/package-admin-web-cloudfunctions.ps1`

**Interfaces:**
- Produces: `createSystemSettingsService({ db, idempotency, operationOutbox, now? })`
- Produces: `readSettings({ actor? })` and `saveSettings({ actor, input, expectedVersion, idempotencyKey, requestId, strict })`

- [ ] Write service tests for exact field validation, super-admin authorization, masked-placeholder rejection, WeChat Pay closed behavior, no-op, CAS, replay/conflict, payment log, operation log, sync event, rollback, and stored-field preservation.
- [ ] Run `node --test cloudfunctions/common/services/systemSettingsService.test.js` and confirm RED because the module does not exist.
- [ ] Implement the minimal canonical service and byte-identical deployable copies.
- [ ] Update packaging hash/copy guards for the new service.
- [ ] Re-run the focused service test and confirm GREEN.

### Task 2: Admin Web API Route And DTO

**Files:**
- Create: `cloudfunctions/adminWebApi/test/settings-mutation.test.js`
- Modify: `cloudfunctions/adminWebApi/index.js`
- Modify: `cloudfunctions/adminWebApi/lib/core.js`
- Modify: `cloudfunctions/adminWebApi/test/core.test.js`
- Modify: `cloudfunctions/adminWebApi/test/session-security.test.js`

**Interfaces:**
- Consumes: `systemSettingsService.saveSettings()`
- Produces: `POST /api/admin/v1/settings/update` `MutationResult<SettingsRecord>`

- [ ] Write route tests for strict body parsing, exact super-admin permission, CSRF before service, idempotency, expected version, safe result projection, and known error mapping.
- [ ] Change the existing session-security expectation from `SERVICE_NOT_MIGRATED` to a service-boundary assertion and run it to confirm RED.
- [ ] Add route normalization, actor derivation, error mapping, response projection, and dispatch before the generic 501 fallback.
- [ ] Add `sessionIdleMinutes` to the settings read projection and prove sensitive fields remain absent.
- [ ] Run the settings API and core tests and confirm GREEN.

### Task 3: Legacy Settings Compatibility

**Files:**
- Create: `cloudfunctions/getSettings/index.test.js`
- Create: `cloudfunctions/updateSettings/index.test.js`
- Modify: `cloudfunctions/getSettings/index.js`
- Modify: `cloudfunctions/updateSettings/index.js`

**Interfaces:**
- Consumes: canonical settings fields and service.
- Preserves: existing `paymentMethods`, `pickupSettings`, and merge-shipment event shapes.

- [ ] Write RED tests proving `getSettings` omits version/default inventory/session values and legacy `updateSettings` does not delegate system writes to the canonical service.
- [ ] Add the fields to `getSettings` and route only `event.systemSettings` through the canonical service while retaining payment-method and pickup writes.
- [ ] Run both entrypoint tests plus existing `paymentMethods` tests and confirm GREEN.

### Task 4: Session Idle Snapshot

**Files:**
- Create: `cloudfunctions/common/services/adminSessionPolicy.js`
- Create: `cloudfunctions/common/services/adminSessionPolicy.test.js`
- Create: `cloudfunctions/adminWebAuth/sessionPolicy.js`
- Create: `cloudfunctions/adminWebApi/lib/sessionPolicy.js`
- Modify: `cloudfunctions/adminWebAuth/index.js`
- Modify: `cloudfunctions/adminWebApi/lib/session.js`
- Modify: `cloudfunctions/adminWebAuth/test/persistence.test.js`
- Modify: `cloudfunctions/adminWebApi/test/session-security.test.js`
- Modify: `scripts/package-admin-web-cloudfunctions.ps1`

**Interfaces:**
- Produces: `readSessionIdleMinutes(source)`, `assertSessionIdleLifetime(session, nowMs)`, and snapshot field `idleTimeoutMinutes`.

- [ ] Write RED tests for range/default normalization, legacy sessions, expired snapshots, new-login snapshot, and refresh snapshot renewal.
- [ ] Implement and copy the policy helper, then call it at login, refresh, and both access-session boundaries.
- [ ] Re-run admin auth/API session suites and confirm GREEN.

### Task 5: Settings And Product Frontend

**Files:**
- Modify: `admin-web/src/modules/settings/SettingsView.spec.ts`
- Modify: `admin-web/src/modules/settings/SettingsView.vue`
- Modify: `admin-web/src/modules/products/ProductEditorDialog.spec.ts`
- Modify: `admin-web/src/modules/products/ProductEditorDialog.vue`
- Modify: `admin-web/src/types/api.ts`

**Interfaces:**
- Consumes: `transport.get("settings", "system")` and `transport.mutate("settings", "update", ...)`.
- Produces: writable HTTP form, safe before/after confirmation, and setting-backed create-product warning default.

- [ ] Write RED tests proving HTTP save is disabled, no change summary is shown, and create-product warning starts at hard-coded 10.
- [ ] Remove the HTTP read-only gate, retain a disabled WeChat Pay switch, track a loaded baseline, and show only changed safe values in confirmation.
- [ ] Load settings when a create-product dialog opens and apply `lowStockDefaultThreshold` before operator edits.
- [ ] Run both component specs and the HTTP transport spec and confirm GREEN.

### Task 6: Verification And Review

**Files:**
- Verify all files above and deployable copies.

- [ ] Run focused RED/GREEN evidence commands and record pass/fail counts and exit codes.
- [ ] Run relevant backend and frontend regressions, `vue-tsc`, ESLint, Vite real build, JavaScript syntax checks, package/hash checks, and `git diff --check`.
- [ ] Dispatch an independent read-only review for security, privacy, concurrency, compatibility, and task-scope findings.
- [ ] Fix each important finding through a new RED/GREEN cycle and repeat the relevant verification.
- [ ] Comment the issue with evidence and remaining runtime/deployment risk, re-read its latest version, and move it to `in_review`.
