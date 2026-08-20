# P2-03 System Settings Save Design

## Scope

This change opens the existing admin-web `/settings` page for real HTTP saves without adding a parallel settings collection or bypassing the BFF. It covers only these persisted fields in `settings/system_settings`:

- `enableOfflineQrPayment`
- `enableBankTransfer`
- `enableWechatPay` (readable, but this task cannot turn it on)
- `requirePaymentProofForOfflinePayment`
- `allowMultiplePaymentRecords`
- `maxPaymentScreenshotCount`
- `lowStockDefaultThreshold`
- `sessionIdleMinutes`

The existing mini-program `getSettings` and `updateSettings` entrypoints remain compatible. Payment account, QR code, bank card, merchant key, and credential edits remain owned by the existing `paymentMethods` service and are not accepted by the system-settings endpoint.

## Chosen Approach

Use one canonical `systemSettingsService` with deployable byte-identical copies. `adminWebApi` exposes the strict Web contract; `updateSettings` calls the same service as a compatibility adapter. This keeps validation, versioning, logging, and consumer defaults in one place.

Rejected alternatives:

1. Calling the legacy `updateSettings` cloud function from `adminWebApi` would preserve its broad event shape, non-atomic writes, and missing CAS/idempotency guarantees.
2. Updating settings directly inside each BFF route would duplicate validation and make `getSettings`, `updateSettings`, and admin-web diverge.

## Write Contract

`POST /api/admin/v1/settings/update` requires:

- an active `super_admin` with canonical `system:settings` permission;
- a valid session CSRF token;
- an `Idempotency-Key` header;
- `expectedVersion` as a non-negative integer;
- all eight setting fields with exact JSON types and no unknown fields.

Ranges are `maxPaymentScreenshotCount=1..9`, `lowStockDefaultThreshold=0..99999`, and `sessionIdleMinutes=5..240`. `enableWechatPay=true` is rejected with `WECHAT_PAY_NOT_CONFIGURED`; this task must not enable or simulate WeChat Pay.

The service compares `expectedVersion` and updates inside one transaction. No-op saves return `affected=0` without version, audit, payment log, or sync-event changes. Exact replay returns the first result; the same idempotency key with a changed payload conflicts.

## Persistence And Audit

The transaction updates only the field whitelist plus `version`, `updatedAt`, and non-sensitive operator metadata. Unknown stored fields are preserved.

For a changed save it also writes:

- one `admin_operation_logs` record using the existing operation-outbox schema and only `updatedAt`/`version` in its safe summary;
- one `sync_events` invalidation event, `settings.updated`, scoped to `system_settings` and `super_admin`;
- one `payment_method_logs` record when any payment-related setting changes, containing only the six global payment fields and no account, QR, key, token, openid, or proof URL.

The response and UI change summary use field labels plus boolean/integer before and after values. They never include payment method secrets.

## Read And Consumer Behavior

`GET /settings/system` continues to project a stable public ID of `system`, adds `sessionIdleMinutes`, and never returns unknown or sensitive stored fields. Legacy `getSettings` returns the same new fields and version under `systemSettings`.

The two previously hard-coded consumers become setting-backed:

- The admin-web product create dialog reads `settings/system` whenever a new create form opens and uses `lowStockDefaultThreshold` as its initial warning value. An explicit operator edit still wins.
- Admin sessions store an `idleTimeoutMinutes` snapshot. New logins read the current setting; refresh reads it again and starts a new idle window. Existing sessions retain their prior snapshot until refresh. Sessions that predate this field remain compatible until refresh. Both `adminWebAuth` and `adminWebApi` reject a snapshot whose `lastActivityAt + idleTimeoutMinutes` has elapsed.

Saving a shorter idle period does not revoke current sessions. Explicit session revocation remains a separate administrator action.

## Frontend Behavior

HTTP mode is writable after a real settings record loads. Before save, the page compares the loaded snapshot with the form and shows a confirmation containing each changed field and its before/after value. A version conflict keeps the draft and tells the operator to reload. Successful save replaces the form and baseline with the server DTO.

The WeChat Pay switch remains disabled in this task. The offline QR and bank-transfer switches continue to affect the existing `paymentMethods` availability logic, while payment-proof and screenshot-count fields continue to affect offline proof submission.

## Verification

Tests must first demonstrate these failures on the current code:

- HTTP settings page cannot save;
- `settings/update` ends at `SERVICE_NOT_MIGRATED`;
- strict validation, CAS, idempotency, audit/sync, and safe payment logs do not exist;
- settings projection omits `sessionIdleMinutes`;
- product creation still starts at hard-coded warning threshold 10;
- sessions do not enforce a settings-backed idle snapshot.

GREEN verification covers the focused backend/frontend suites, legacy `getSettings`/`updateSettings` and `paymentMethods` regressions, admin auth/API session suites, `vue-tsc`, ESLint, Vite real build, JavaScript syntax checks, byte-identical deployable copies, and `git diff --check`. No CloudBase, browser runtime, WeChat DevTools, upload, deployment, publication, or production write is authorized.
