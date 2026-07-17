# Admin Web Return Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 将退货确认收货和退货验货收敛到 Web 与小程序共用的严格、幂等、事务性服务，并在满足权限、库存和售后状态机约束后开放 Web 写路由。

**Architecture:** `returnInspectionService` 接受可信 `ActorContext`，在一个 CloudBase transaction 中更新 `after_sales`、`orders`、可售退货库存、`inventory_logs`、售后日志、管理员日志和最小 `sync_events`。`afterSales` 只保留旧小程序参数/返回适配；`adminWebApi` 只负责 session、CSRF、严格 DTO 和安全错误投影；Web transport 与 Mock 使用同一份严格合同。

**Tech Stack:** Node.js CommonJS CloudBase functions, existing idempotency/sync helpers, Vue 3, TypeScript, Vitest, Node test runner, PowerShell packaging.

## Global Constraints

- 只能连接当前测试环境；不得上传云函数、部署 Web、发布小程序或写入真实业务数据。
- 不改变订单状态规则、库存扣减/恢复时机、退款金额上限、售后人工审核规则或既有幂等语义。
- 客服/超级管理员可确认收货和验货；财务和采购不能执行退货验收。
- 确认收货只允许 `waiting_return` 或 `returned`；验货只允许 `received` 或 `inspecting`。
- 只有 `itemCondition === "sellable"` 且 `canRestock === true` 才能恢复普通库存；库存回补必须以售后商品行和唯一业务键为准。
- 所有 Web 写请求必须包含 CSRF、幂等键、严格 `expectedStatus/expectedVersion/expectedUpdatedAt` 快照；浏览器不得提交最终库存、actor、openid、订单或敏感字段。
- 退款待处理状态 `refund_pending` 不得直接标记为 `completed`。
- 不把 Mock 与 Real 混合展示；Real 失败必须显示真实错误，不回退演示数据。
- 不声称实时同步完成，除非真实双端测试证据存在。

---

### Task 1: Shared return inspection domain service

**Files:**
- Create: `cloudfunctions/common/services/returnInspectionService.js`
- Create: `cloudfunctions/common/services/test/returnInspectionService.test.js`
- Modify: `cloudfunctions/afterSales/index.js`
- Modify: `cloudfunctions/afterSales/test/return-snapshot.test.js`

**Interfaces:**
- `createReturnInspectionService({ db, idempotency, now, getAfterSaleById, writeAfterSaleLog, writeAdminOperation, snapshot, ownerKeyFor, syncOwnerPepper, incrementInventory })`
- `confirmReturnReceived({ actor, input, idempotencyKey })`
- `inspectReturnItems({ actor, input, idempotencyKey })`
- Return safe `{ afterSaleId, afterSaleStatus, version, updatedAt, restoredQuantity, affected, reused }`.

- [x] **Step 1: Write failing tests** for actor role/permission boundaries, strict input allowlists, status guards, version/time conflicts, required idempotency, rejected non-sellable restock, unique per-product restock business key, same-key replay, changed-payload conflict, transaction rollback, and owner-scoped sync event without PII.
- [x] **Step 2: Run focused tests to verify RED** with `node --test cloudfunctions/common/services/test/returnInspectionService.test.js`; expected failure is missing module/export or missing method, not a syntax error.
- [x] **Step 3: Implement normalization and transaction** using existing `idempotency` and log helpers; increment the after-sale version exactly once per successful mutation and preserve legacy status/output.
- [x] **Step 4: Adapt `afterSales`** so `confirmReturnReceived` and `inspectReturnItems` call the canonical service while preserving old event aliases and `{ok,data|message}` envelope.
- [x] **Step 5: Run focused GREEN tests** and `node --check` on changed production files.

### Task 2: Web BFF receive/inspect routes

**Files:**
- Modify: `cloudfunctions/adminWebApi/index.js`
- Modify: `cloudfunctions/adminWebApi/lib/core.js`
- Create: `cloudfunctions/adminWebApi/lib/returnInspectionService.js`
- Create: `cloudfunctions/adminWebApi/test/return-inspection-mutation.test.js`

**Interfaces:**
- `POST /api/admin/v1/after-sales/receive` and `POST /api/admin/v1/after-sales/inspect`.
- Receive body: `{ afterSaleId, expectedStatus, expectedVersion, expectedUpdatedAt, remark }`.
- Inspect body: `{ afterSaleId, expectedStatus, expectedVersion, expectedUpdatedAt, itemCondition, canRestock, restockQuantity, inspectionRemark }`.
- Actor is derived from the validated Web session; public result contains no order/customer/payment/inventory log details.

- [x] **Step 1: Write failing BFF tests** for route parsing, exact body fields, CSRF and idempotency, customer-service/super-admin allow, finance/procurement deny, safe 400/403/409/501 mapping, and result whitelist.
- [x] **Step 2: Run focused tests to verify RED** while routes still return `SERVICE_NOT_MIGRATED`.
- [x] **Step 3: Implement strict normalization, service adapter and dispatch branches** reusing the canonical service; enable `realEnabled` only after route tests pass.
- [x] **Step 4: Run focused BFF tests and JS syntax checks.**

### Task 3: Web transport/UI contract and Mock parity

**Files:**
- Create: `admin-web/src/services/transport/return-inspection-contract.ts`
- Create: `admin-web/src/services/transport/return-inspection-contract.spec.ts`
- Modify: `admin-web/src/services/transport/http-transport.ts`
- Modify: `admin-web/src/services/transport/mock-transport.ts`
- Modify: `admin-web/src/config/resources.ts`
- Modify: `admin-web/src/modules/resources/OperationsView.vue`
- Modify: related Web specs

- [x] **Step 1: Write failing contract/UI tests** for strict receive/inspect payloads, current status gating, role permissions, idempotency-key reuse on retry, and no sensitive fields in results.
- [x] **Step 2: Run focused Vitest tests to verify RED.**
- [x] **Step 3: Implement HTTP and Mock mutations**, keeping Real disabled until BFF tests are green and preserving existing layout and status labels.
- [x] **Step 4: Run focused Vitest, `vue-tsc`, and ESLint.**

### Task 4: Packaging, sync, independent review and regression

**Files:**
- Modify: `scripts/package-admin-web-cloudfunctions.ps1`
- Modify: `docs/admin-web-api-mapping.md`
- Modify: `docs/admin-web-data-audit.md`
- Modify: `docs/admin-web-integration-plan.md`
- Modify: `docs/admin-web-integration-progress.md`
- Modify: `docs/admin-web-realtime-test.md`
- Modify: `docs/web-admin-test-deployment-and-rollback.md`

- [x] **Step 1: Add canonical service copy/hash/manifest checks** for both `adminWebApi` and `afterSales`; verify A-Z function list and `uploadPerformed=false`.
- [x] **Step 2: Run an independent read-only review** over status machine, permissions, sensitive projection, idempotency, inventory business keys, sync event payload and deployment copy.
- [x] **Step 3: Fix every accepted Critical/Important finding test-first and re-review.**
- [x] **Step 4: Run full Cloud/Web tests, JS syntax checks, JSON parsing, typecheck, lint, Mock/Real builds and local browser regression.**
- [x] **Step 5: Update documents with exact evidence and clearly list unverified CloudBase/dual-end tests.**
