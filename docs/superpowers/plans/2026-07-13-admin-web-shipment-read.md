# Admin Web Shipment Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/shipments` 升级为基于真实 `shipment_groups`、`orders`、`shipment_group_items` 和 `shipment_logs` 的安全合并发货单列表与专用只读详情，同时保持小程序读取兼容和所有 Real 发货写操作关闭。

**Architecture:** 新增 canonical `shipmentQueryService` 作为唯一读取业务层；小程序 `shipmentGroups` 使用 legacy projector，`adminWebApi` 使用严格 Web projector。Web 通过 Zod 严格合同解析列表/详情，新增专用详情页；同步事件只触发重读。

**Tech Stack:** Node.js 20、`wx-server-sdk` CloudBase 查询、原生 `node:test`、Vue 3、TypeScript、Zod 4、Element Plus、Vitest。

## Global Constraints

- 仅做合并发货单读取，不开放合并、发货、物流编辑、取消、完成或导出。
- 不连接生产环境，不上传云函数，不创建真实索引，不执行真实数据写入。
- 金额使用整数分；客服不返回金额，财务和超级管理员按现有金额权限投影。
- Web 完整地址只认 `shipment:view_address_full`，不得使用通用客户地址权限提升。
- 列表始终脱敏运单号；详情仅 `super_admin` 或具 `shipment:update`/`shipment:ship` 时返回完整运单。
- 不返回 openid、userId、幂等键、businessKey、原始操作人 ID、before/after、云文件 ID、原始内部标签。
- `procurement`、普通用户和无效管理员默认拒绝。
- 不改变小程序读取 wrapper 名称、参数和外层 `{ok,data}` 合同；不修改 `shipmentGroups` 写 action。
- 当前目录不是 Git 仓库；跳过 worktree/commit，以测试证据、文件清单和 SHA256 哈希作为审查依据。

---

### Task 1: Canonical Shipment Query Service and Legacy Read Adapters

**Files:**
- Create: `cloudfunctions/common/services/shipmentQueryService.js`
- Create: `cloudfunctions/common/services/shipmentQueryService.test.js`
- Modify: `cloudfunctions/shipmentGroups/index.js`
- Test: `cloudfunctions/shipmentGroups/index.test.js`

**Interfaces:**
- Consumes: injected `{ db, command }` and authenticated actor objects with `role/status/isActive/permissions`.
- Produces: `createShipmentQueryService({db, command})` with `listWebShipments({actor,query})`, `getWebShipment({actor,id})`, `listLegacyShipmentGroups({actor,query})`, and `getLegacyShipmentGroupDetail({actor,id})`.
- Errors: `ShipmentQueryError(code,message,statusCode)` with stable codes `FORBIDDEN`, `SHIPMENT_NOT_FOUND`, `SHIPMENT_QUERY_INVALID`, `SHIPMENT_CURSOR_INVALID`, `SHIPMENT_RELATED_ROWS_LIMIT_EXCEEDED`, `SHIPMENT_READ_FAILED`.

- [ ] **Step 1: Write failing canonical permission and list tests**

Create fixtures containing two groups with equal `updatedAt`, six valid statuses, dirty masked phone/tracking fields, amounts, raw IDs, addresses and internal fields. Assert:

```js
const service = createShipmentQueryService({ db, command });
const page = await service.listWebShipments({
  actor: activeActor("customer_service", ["shipment:view", "shipment:view_address_masked"]),
  query: { pageSize: 20, status: "pending_shipment", search: "SHP-001" }
});
assert.deepEqual(Object.keys(page.items[0]).sort(), [
  "addressConsistent", "carrier", "completedAt", "createdAt", "customerMasked",
  "id", "orderCount", "orderNosPreview", "shipmentNo", "shippedAt", "status",
  "totalItemCount", "trackingMasked", "updatedAt", "version"
].sort());
assert.equal(Object.hasOwn(page.items[0], "totalOrderAmountCents"), false);
assert.match(page.items[0].customerMasked, /\*+/);
assert.match(page.items[0].trackingMasked, /\*+/);
await assert.rejects(
  service.listWebShipments({ actor: activeActor("procurement", ["product:view"]), query: {} }),
  (error) => error.code === "FORBIDDEN"
);
```

Also assert `created/pending_shipment/shipped/completed/cancelled/abnormal` validation, exact shipment/order/tracking search, `pageSize` cap, opaque cursor rejection, and stable `updatedAt + _id` page boundaries.

- [ ] **Step 2: Run canonical list tests and verify RED**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/common/services/shipmentQueryService.test.js
```

Expected: FAIL because `shipmentQueryService.js` and its exports do not exist.

- [ ] **Step 3: Implement minimal canonical list path**

Implement exact constants and API:

```js
const WEB_SHIPMENT_STATUSES = new Set(["created", "pending_shipment", "shipped", "completed", "cancelled", "abnormal"]);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function createShipmentQueryService({ db, command }) {
  if (!db || !command) throw new Error("shipment query service requires db and command");
  async function listWebShipments({ actor, query = {} } = {}) {
    const normalized = normalizeWebListQuery(query);
    assertShipmentView(actor);
    return queryWebShipmentPage(normalized, actor);
  }
  return { listWebShipments };
}
```

Use `updatedAt DESC, _id DESC`; cursor must encode versioned JSON `{v:1,updatedAt,id}` and reject malformed/oversized values. Missing collection/query/index errors map to `SHIPMENT_READ_FAILED 503`, never an empty success.

- [ ] **Step 4: Run list tests and verify GREEN**

Run the Step 2 command. Expected: list/permission/search/cursor tests pass.

- [ ] **Step 5: Write failing Web detail projection and cap tests**

Assert one detail joins group/orders/items/logs, hides raw fields, projects finance/customer service/super admin differently, returns `partial` for missing related order, fails above 100 orders or 500 item rows, and returns latest 100 of 101 logs with `logsHasMore=true`.

```js
const detail = await service.getWebShipment({ actor: customerService, id: "sg-1" });
assert.equal(detail.shipment.trackingNo, "SF123456789");
assert.equal(Object.hasOwn(detail.shipment, "shippingAddressSnapshot"), false);
assert.equal(Object.hasOwn(detail.shipment, "totalOrderAmountCents"), false);
assert.equal(Object.hasOwn(detail.logs[0], "operatorOpenid"), false);
assert.equal(Object.hasOwn(detail.logs[0], "beforeData"), false);
assert.equal(detail.logsHasMore, true);
```

- [ ] **Step 6: Verify detail tests RED, implement detail, verify GREEN**

Run Step 2 command before implementation and confirm failures are caused by missing detail behavior. Implement bounded batch reads and role projectors, then rerun until green.

- [ ] **Step 7: Add legacy compatibility tests before changing `shipmentGroups`**

Capture the current list/detail contract required by mini-program pages:

```js
assert.deepEqual(Object.keys(list.data).sort(), ["groups", "hasMore", "page", "pageSize"].sort());
assert.ok(Array.isArray(detail.data.orders));
assert.ok(Array.isArray(detail.data.itemSummary));
assert.ok(Array.isArray(detail.data.logs));
assert.ok(detail.data.shipmentGroup);
```

Verify RED against a test seam that expects `shipmentGroups` read actions to delegate to the canonical service.

- [ ] **Step 8: Convert only the two legacy read actions to adapters**

Inject the canonical service into `shipmentGroups/index.js`; route only `getAdminShipmentGroups` and `getShipmentGroupDetail` through `listLegacyShipmentGroups`/`getLegacyShipmentGroupDetail`. Preserve all write action code and existing wrapper responses.

- [ ] **Step 9: Run Task 1 tests**

```powershell
$node='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test cloudfunctions/common/services/shipmentQueryService.test.js cloudfunctions/shipmentGroups/index.test.js
```

Expected: all Task 1 tests pass.

---

### Task 2: BFF Shipment Routes, Safe Errors, and Packaging

**Files:**
- Modify: `cloudfunctions/adminWebApi/index.js`
- Modify: `cloudfunctions/adminWebApi/lib/core.js`
- Create: `cloudfunctions/adminWebApi/test/shipment-query.test.js`
- Modify: `scripts/package-admin-web-cloudfunctions.ps1`

**Interfaces:**
- Consumes: `createShipmentQueryService` from Task 1.
- Produces: dedicated `GET /shipments` and `GET /shipments/:id` dispatch with `shipment:view` and safe envelopes; generic resource path must not run for shipments.

- [ ] **Step 1: Write failing BFF route tests**

Assert dispatch calls only the canonical service, passes the authenticated principal, preserves query/id, rejects procurement before DB access, maps known errors to safe 400/403/404/503, and never exposes injected error messages.

```js
const response = await dispatchHttp({ method: "GET", path: "/shipments/sg-1", auth: customerService }, deps);
assert.equal(response.shipment.id, "sg-1");
assert.deepEqual(calls[0], { actor: customerService, id: "sg-1" });
```

- [ ] **Step 2: Run BFF test and verify RED**

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test cloudfunctions/adminWebApi/test/shipment-query.test.js
```

Expected: FAIL because shipments still use the generic collection path.

- [ ] **Step 3: Implement dedicated BFF route and remove generic shipment projection authority**

Require `./lib/shipmentQueryService`, construct the service with `{db,command}`, add route predicates before generic resource list/get, and map errors through a shipment-specific safe mapper. Keep shipment mutations at `501 SERVICE_NOT_MIGRATED`.

- [ ] **Step 4: Run BFF tests and verify GREEN**

Run Step 2 command. Expected: all shipment BFF tests pass.

- [ ] **Step 5: Add packaging RED gate**

Extend packaging tests or script verification so the candidate package must contain identical SHA256 copies at:

```text
adminWebApi/lib/shipmentQueryService.js
shipmentGroups/shipmentQueryService.js
```

and include the `shipmentGroups` cloudfunction. Verify the gate fails before copy/hash changes.

- [ ] **Step 6: Update packaging script and verify targeted gate**

Copy canonical service into both cloudfunction roots, add manifest hash `canonicalShipmentQueryServiceSha256`, include `shipmentGroups` in A-Z order, and retain `uploadPerformed=false`.

---

### Task 3: Strict Web Contract and Transport Alignment

**Files:**
- Create: `admin-web/src/services/transport/shipment-query-contract.ts`
- Create: `admin-web/src/services/transport/shipment-query-contract.spec.ts`
- Modify: `admin-web/src/services/transport/http-transport.ts`
- Modify: `admin-web/src/services/transport/http-transport.spec.ts`
- Modify: `admin-web/src/services/transport/mock-data.ts`
- Modify: `admin-web/src/services/transport/mock-transport.ts`
- Modify: `admin-web/src/services/transport/mock-transport.spec.ts`
- Modify: `admin-web/src/types/api.ts`

**Interfaces:**
- Produces: `ShipmentSummary`, `ShipmentDetail`, `parseShipmentList`, `parseShipmentDetail`.
- `AdminTransport` gains the explicit method `getShipmentDetail(id: string): Promise<ShipmentDetail>`; the details page must not use generic `get`.

- [ ] **Step 1: Write failing Zod contract tests**

Accept only the exact DTO in the approved spec. Use `.strict()` at every object level. Explicitly reject payloads containing `trackingNo` in list, `orderIds`, `shippingAddressSnapshot`, `openid`, `operatorOpenid`, `beforeData`, `afterData`, raw item `unitPrice/subtotal/tags`, invalid status, invalid date, negative quantity, unsafe integer or unexpected field.

- [ ] **Step 2: Run contract tests and verify RED**

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' test -- shipment-query-contract.spec.ts
```

Expected: FAIL because contract module does not exist.

- [ ] **Step 3: Implement strict types and parsers, verify GREEN**

Use Zod schemas with the exact field names from the design. Convert parse failures to `ApiError("发货数据响应格式无效", "INVALID_SHIPMENT_CONTRACT", 502)` without echoing raw payloads.

- [ ] **Step 4: Write HTTP transport RED tests**

Assert `/shipments` uses `parseShipmentList`, `/shipments/:id` uses `parseShipmentDetail`, malformed overexposed responses are rejected, 403 does not invalidate the session, and 404/503 preserve public codes.

- [ ] **Step 5: Implement HTTP shipment cursor handling and detail parsing**

Add a shipment cursor map parallel to the existing order cursor behavior. Never fall back to generic unparsed `safeGet<T>` for shipments.

- [ ] **Step 6: Write Mock RED tests and align Mock behavior**

Assert Mock list/detail requires `shipment:view`, returns the same key sets as Real DTO, applies status/exact-number search, and never exposes raw fields. Add one complete detail fixture with orders, item summary, logs, `relatedDataStatus` and `warnings`.

- [ ] **Step 7: Run Task 3 tests**

```powershell
$pnpm='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
& $pnpm test -- shipment-query-contract.spec.ts http-transport.spec.ts mock-transport.spec.ts
& $pnpm typecheck
```

Expected: targeted tests and typecheck pass.

---

### Task 4: Shipment List Truthfulness and Dedicated Detail UI

**Files:**
- Modify: `admin-web/src/config/resources.ts`
- Modify: `admin-web/src/modules/resources/OperationsView.vue`
- Modify: `admin-web/src/modules/resources/OperationsView.spec.ts`
- Modify: `admin-web/src/router/index.ts`
- Create: `admin-web/src/modules/shipments/ShipmentDetailView.vue`
- Create: `admin-web/src/modules/shipments/ShipmentDetailView.spec.ts`

**Interfaces:**
- Consumes: `ShipmentSummary`/`ShipmentDetail` and transport method from Task 3.
- Produces: `/shipments/:id` read-only page and Drawer navigation.

- [ ] **Step 1: Write list and routing RED tests**

Assert title is `合并发货单`, description states the single-order boundary, search placeholder asks for complete number, six status options exist, Drawer exposes “打开详情页”, and route `/shipments/:id` requires `shipment:view`.

- [ ] **Step 2: Verify RED and implement minimal list/routing changes**

Run:

```powershell
& 'C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' test -- OperationsView.spec.ts
```

Expected before implementation: failures for title/status/detail navigation. Implement only approved text/status/route/navigation changes; keep every shipment action without `realEnabled:true`.

- [ ] **Step 3: Write dedicated detail page RED tests**

Cover skeleton, success sections, masked/full conditional fields already decided by DTO, empty orders/items/logs, partial warning, 404, 503 retry, and absence of mutate/write buttons.

```ts
expect(wrapper.text()).toContain("发货单详情");
expect(wrapper.text()).toContain("关联数据不完整");
expect(transport.mutate).not.toHaveBeenCalled();
```

- [ ] **Step 4: Implement `ShipmentDetailView.vue` and verify GREEN**

The page loads once on mount, coalesces concurrent refreshes, keeps previous real data during silent refresh, shows fixed safe warnings, and never derives financial or address permissions in the browser; it renders only fields present in the server DTO.

- [ ] **Step 5: Run Task 4 tests and typecheck**

```powershell
$pnpm='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
& $pnpm test -- OperationsView.spec.ts ShipmentDetailView.spec.ts
& $pnpm typecheck
```

Expected: all Task 4 tests and typecheck pass.

---

### Task 5: Documentation, Full Regression, Independent Review, and Guarded Package

**Files:**
- Modify: `docs/admin-web-data-audit.md`
- Modify: `docs/admin-web-api-mapping.md`
- Modify: `docs/admin-web-integration-plan.md`
- Modify: `docs/admin-web-realtime-test.md`
- Modify: `docs/admin-web-integration-progress.md`
- Modify: `scripts/package-admin-web-cloudfunctions.ps1`
- Output: a new timestamped directory under `.codex-cloudfunction-deploy/`, with its exact path captured from the packaging script result.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: current documentation, fresh verification evidence and a local-only guarded package.

- [ ] **Step 1: Update all five integration documents**

Record exact current state:合并发货单列表/详情本地完成；单订单发货和所有发货写操作未接；真实 CloudBase、索引、上传、部署和双端验证未执行。Replace stale package/test counts with the final fresh results only after running them.

- [ ] **Step 2: Run targeted backend and Web tests**

```powershell
$node='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test cloudfunctions/common/services/shipmentQueryService.test.js cloudfunctions/shipmentGroups/index.test.js cloudfunctions/adminWebApi/test/shipment-query.test.js
$pnpm='C:\Users\bin\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
& $pnpm test -- shipment-query-contract.spec.ts http-transport.spec.ts mock-transport.spec.ts OperationsView.spec.ts ShipmentDetailView.spec.ts
```

- [ ] **Step 3: Run full regression**

```powershell
$tests=Get-ChildItem -LiteralPath cloudfunctions -Recurse -Filter *.test.js -File | Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } | ForEach-Object { $_.FullName }
& $node --test @tests
& $pnpm test
& $pnpm typecheck
& $pnpm lint
& $pnpm build:mock
& $pnpm build
```

Every command must exit 0. Existing `ws` optional dependency and Rollup third-party PURE comments may be reported as known non-blocking warnings; no new warning is acceptable without review.

- [ ] **Step 4: Run static safety checks**

Run `node --check` on every modified/packaged JS, parse every modified/packaged JSON, scan modified text for U+FFFD, and search Real build assets for Mock credentials/data markers.

- [ ] **Step 5: Independent security/compatibility review**

Reviewer checks the approved design requirement by requirement, prioritizing raw-field leakage, finance address escalation, procurement access, stable pagination, collection error handling, legacy compatibility, write-button state and unrelated changes. Any P0/P1 returns to the responsible implementer and is re-reviewed.

- [ ] **Step 6: Generate and verify local guarded package**

Run the existing packaging script with a new timestamped output. Verify:

```text
uploadPerformed=false
shipmentGroups included in A-Z function list
canonical shipmentQueryService hash equals both packaged copies
0 *.test.* / *.spec.* files
0 node_modules directories
all packaged JS node --check clean
all packaged JSON parses
```

Do not upload or deploy.

## Plan Self-Review

- Spec coverage: Tasks 1-5 cover canonical service, legacy adapters, BFF, strict DTO, Mock/Real parity, truthful list, dedicated detail, permissions, errors, caps, documentation, review, regression and packaging.
- Scope: no single-order shipment or mutation work is included.
- Type consistency: `ShipmentSummary`, `ShipmentDetail`, `parseShipmentList`, `parseShipmentDetail` and the transport detail method are introduced in Task 3 and consumed in Task 4.
- Placeholder scan: every task contains concrete files, commands, interfaces and expected results. Task 3 mandates explicit `getShipmentDetail` to avoid generic bypass.
- Repository adaptation: no Git worktree/commit steps because `D:\王希哲\NEW` is not a Git repository.
