# P1-08 Unified Shipment State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立唯一的服务端发货状态机、转换守卫和安全事务计划，供 P4-01 至 P4-04 复用，并让既有兼容入口不再各自发明状态规则。

**Architecture:** 以纯函数 canonical service 统一状态归一化、权限/付款/版本/合并一致性守卫和最小事务补丁；部署副本用 SHA-256 门禁保持一致。既有路由只允许最小委托接线，不开放新的 admin-web/P4 写闭环。

**Tech Stack:** Node.js、CommonJS、`node:test`、CloudBase 兼容数据模型、PowerShell、Vue/TypeScript 既有回归工具。

## Global Constraints

- 保持原生微信小程序 + admin-web + BFF + CloudBase 架构，不新增平行集合、接口或业务系统。
- 金额继续按整数分；状态机和事务计划不得修改库存、账款或付款。
- `completed`、`cancelled`、`abnormal` 终态不可逆；新请求的重复完成/取消/发货必须 fail closed。
- P1-04 同幂等键同载荷重放发生在守卫之前，允许复用历史结果；不得用这一规则掩盖新请求的非法重复转换。
- `expectedVersion` 必填；旧记录缺失 `version` 只兼容为当前版本 `0`。
- 默认只做本地代码和测试；不上传云函数、不部署 admin-web、不发布小程序、不连接生产、不发送真实写请求。
- 保留工作区内 P1-03 至 P1-07 和用户的未提交改动，不回滚、不覆盖、不混入无关重构。

---

### Task 1: Canonical Transition Table and Fail-Closed Guard

**Files:**
- Create: `cloudfunctions/common/services/shipmentStateMachine.js`
- Create: `cloudfunctions/common/services/shipmentStateMachine.test.js`

**Interfaces:**
- Produces: `ShipmentTransitionError`, `SHIPMENT_COMMANDS`, `SHIPMENT_STATUSES`, `normalizeShipmentStatus(entity)`, `assertShipmentTransition(input)`, `planShipmentTransition(input)`.
- Input: `{command, actor, order?, orders?, shipment?, settings?, expectedVersion, logistics?}`.
- Output: frozen transition plan containing only `fromStatus`, `toStatus`, `requiredPermission`, `shipmentPatch`, and `orderPatches`.

- [ ] **Step 1: Write the table-driven RED tests**

Cover all legal edges from the design plus every other source status as illegal. Add focused cases for inactive actor, missing exact permission, missing/invalid/mismatched version, legacy version `0`, unknown/conflicting status, unpaid/partial-paid settings, pickup order, cross-customer merge, duplicate order IDs, active merge binding, mismatched group/order binding, missing logistics, and terminal repeat attempts.

- [ ] **Step 2: Run RED and record the expected failure**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/common/services/shipmentStateMachine.test.js
```

Expected: non-zero exit because `shipmentStateMachine.js`/exports do not exist; the failure must be caused by the missing behavior, not test syntax.

- [ ] **Step 3: Implement the minimal pure state machine**

Use frozen command metadata rather than route-specific `if` blocks. Errors must use stable codes such as `SHIPMENT_COMMAND_INVALID`, `INVALID_ACTOR`, `FORBIDDEN`, `EXPECTED_VERSION_REQUIRED`, `DATA_VERSION_CONFLICT`, `SHIPMENT_STATUS_INVALID`, `SHIPMENT_TRANSITION_NOT_ALLOWED`, `SHIPMENT_PAYMENT_REQUIRED`, `SHIPMENT_CUSTOMER_MISMATCH`, `SHIPMENT_ALREADY_BOUND`, `SHIPMENT_BINDING_INCONSISTENT`, and `SHIPMENT_LOGISTICS_REQUIRED`.

- [ ] **Step 4: Produce whitelist-only immutable plans**

For merged ship/complete/cancel, return synchronized shipment and per-order status/binding patches. Assert recursively that no produced key matches `stock`, `inventory`, `amount`, `account`, `payment`, `price`, `debt`, or `balance`.

- [ ] **Step 5: Run GREEN**

Run the Step 2 command and record exit code and pass/fail counts.

### Task 2: Deployable Copies and Compatible Server Delegation

**Files:**
- Create: `cloudfunctions/adminWebApi/lib/shipmentStateMachine.js`
- Create: `cloudfunctions/shipmentGroups/shipmentStateMachine.js`
- Modify only if required by tests: `cloudfunctions/shipmentGroups/index.js`
- Modify: `cloudfunctions/shipmentGroups/index.test.js`
- Create: `cloudfunctions/adminWebApi/test/shipment-state-machine-packaging.test.js`

**Interfaces:**
- Consumes the exact Task 1 exports.
- Existing `shipmentGroups` wrapper response remains `{ok,data}` / `{ok:false,code,message}`.

- [ ] **Step 1: Add RED hash/contract tests**

Assert all deployable copies are byte-identical to canonical, expose the same command table, and do not add adminWebApi write routes. Add static assertions that future shipment write handlers import the service instead of defining another status table.

- [ ] **Step 2: Add compatible delegation RED tests**

For any existing handler changed in this task, test that it calls the canonical guard with authenticated actor, current records, settings and explicit `expectedVersion`; verify a guard error causes zero collection updates. Do not require or implement a new UI/HTTP route.

- [ ] **Step 3: Copy the canonical module and minimally delegate**

Copy bytes exactly. If current callers cannot safely provide `expectedVersion` without broad UI changes, keep legacy write handlers unchanged and document them as a P4 migration blocker; do not silently default a write request's expected version. If safe callers already provide the field, replace only their duplicated guard predicates.

- [ ] **Step 4: Run targeted compatibility tests**

```powershell
$node='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test cloudfunctions/common/services/shipmentStateMachine.test.js cloudfunctions/shipmentGroups/index.test.js cloudfunctions/adminWebApi/test/shipment-state-machine-packaging.test.js
```

Record exact counts and any intentionally un-migrated compatibility path.

### Task 3: Transition Contract Documentation and Focused Regression

**Files:**
- Create: `docs/shipment-state-machine.md`
- Modify only if packaging gate requires it: `scripts/package-admin-web-cloudfunctions.ps1`

**Interfaces:**
- Documentation must list command/state/permission/error tables, old-data normalization, idempotency boundary, transaction requirement, and P4 adoption contract.

- [ ] **Step 1: Document the exact matrices**

Include every legal edge and explicitly state all non-listed edges are illegal. List fields a transaction plan may change and prohibited inventory/account/payment fields. State whether existing `shipmentGroups` writes are fully delegated or remain a named migration blocker.

- [ ] **Step 2: Run backend focused regression**

```powershell
$node='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test cloudfunctions/common/orderStatusPolicy.test.js cloudfunctions/common/services/shipmentQueryService.test.js cloudfunctions/common/services/shipmentStateMachine.test.js cloudfunctions/shipmentGroups/index.test.js cloudfunctions/adminWebApi/test/shipment-query.test.js cloudfunctions/adminWebApi/test/shipment-state-machine-packaging.test.js cloudfunctions/adminWebApi/test/payment-mutation.test.js cloudfunctions/adminWebApi/test/inventory-warning-mutation.test.js
```

- [ ] **Step 3: Run syntax, diff and copy gates**

Run `node --check` on each created/modified JS, compare SHA-256 of all state-machine copies, parse changed JSON if any, scan changed text for U+FFFD, and run `git diff --check`.

- [ ] **Step 4: Run admin-web validation without changing UI**

From `admin-web`, run the project-local targeted tests/typecheck/lint/real build commands available in `package.json`. Report Windows baseline failures separately and do not call the full suite green without its exit result.

- [ ] **Step 5: Independent negative review**

Review against the original issue and design, prioritizing illegal edge gaps, permission injection, unpaid shipment, cross-customer merge, active binding conflicts, terminal replay confusion, version fallback, sensitive details, forbidden patch keys, copy drift, unrelated changes and accidental route enablement. Critical/Important findings must be fixed and re-reviewed.

## Plan Self-Review

- Spec coverage: the three tasks cover state/status normalization, every legal and illegal edge, exact permissions, payment conditions, active merge binding, version conflicts, terminal irreversibility, old data, synchronized plans, deployable copies, compatibility and P4 adoption.
- Scope: no P4 page, new mutation route, upload, deploy, production connection, inventory/account/payment mutation or unrelated refactor is included.
- Type consistency: all consumers use the exact Task 1 CommonJS exports and the same `input -> frozen plan` contract.
- Placeholder scan: no TBD/TODO or unspecified implementation stage remains; the compatibility branch has an explicit fail-closed decision rule.
