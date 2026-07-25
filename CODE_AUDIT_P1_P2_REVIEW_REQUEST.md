# P1/P2 整改代码审阅说明

## 1. 审阅目标

请审阅 `main` 分支从基线提交 `07eae28` 到 `HEAD` 的代码变化。
P1/P2 核心代码提交为 `22c1681 fix: harden P1 P2 order and payment flows`；
其后的提交只更新本审阅说明和部署状态。

本轮只处理原代码审计报告中的 P1/P2。P0 中的真实 CloudBase transaction API
兼容性、真实并发、生产唯一索引和冲突行为不属于本轮修改目标，请仅在本轮代码使这些风险
恶化或引入新回归时将其列为 finding。

请优先输出可操作问题，按以下级别排序：

- `Critical`：可能导致数据损坏、越权、重复扣库存/入账、支付或订单核心流程严重错误。
- `Important`：能够稳定触发的业务回归、安全缺口、部署缺失或旧数据不兼容。
- `Minor`：不阻断交付的可维护性、覆盖率或低风险健壮性问题。

每个 finding 请提供文件路径、行号、触发条件、实际影响和建议修复方向。如果没有
Critical/Important，请明确写出，并单独列出剩余环境风险和测试缺口。

## 2. 必须保持的项目语义

- 购物车和下单阶段不预留、不扣减库存；只有自动审核或人工审核批准时，才在事务内扣库存并写账款。
- 金额继续使用整数分，不迁移订单、账款、付款、发货、退款或风险客户核心字段和状态。
- `risk` 继续表示进入人工审核，`blocked` 继续表示禁止下单。
- 普通用户和无显式权限的后台角色不得看到完整地址、手机号、付款截图、账款和内部字段。
- 线下付款凭证提交后继续进入 `pending_confirm`，不得直接变成 `paid`。
- 旧订单、旧状态别名、旧库存/账款流水和旧调用入口必须继续兼容。

## 3. 本轮主要修改

### 3.1 地址权限与发货投影

- 移除 `procurement` 角色直接查看/导出完整地址的遗留捷径，改为超级管理员或显式权限放行。
- 对 legacy 发货数据进行服务端重新脱敏，使用严格返回白名单并剥离内部字段。
- 同步 27 份实际 `address.js` helper；当前扫描结果为一个唯一 SHA256，且 `procurement` 命中为 0。

### 3.2 付款凭证

- 付款截图必须是 CloudBase fileID，并归属于当前订单约定目录。
- 拒绝其他订单路径、HTTP URL、路径穿越、重复 fileID 和超过安全上限的截图。
- 无效的 `maxPaymentScreenshotCount` 配置回退默认值 3；有效值保持 1-9 限幅和旧兼容语义。

### 3.3 库存导入预览绑定

- `parseInventoryFile` 生成由 manifest、行身份和匹配商品身份决定的 canonical preview proof。
- `confirmInventoryImport` 在幂等 early-return 前校验 verified manifest、唯一 stored row、完整 canonical identity 和 proof。
- 拒绝跨行 proof、商品身份变化、`productId/productIndex/skuCode` 等篡改、无可信 manifest 的旧 update/create，以及歧义商品匹配。
- 保留 `serverBatch`、旧客户端可省略回传 proof、旧状态和 mode 重放兼容。

### 3.4 后台订单分页

- 后台订单页接入服务端分页、请求锁、去重追加和 `hasMore`。
- 新筛选的 page 1 请求只有成功后才提交 applied filter；失败后继续加载使用旧筛选和正确页码，避免跨筛选混页。

### 3.5 审核、状态和账款

- 自动审核与人工审核复用 canonical 库存变更、批准和状态策略。
- 库存与账款继续通过 `inventory_logs.businessKey`、`account_logs.businessKey` 和 `accountIncluded` 做业务级幂等。
- 账款业务日固定按 UTC+8 计算，不依赖宿主机时区。
- 取消、审核、付款和发货状态继续识别既有别名；错误码和状态优先级应保持兼容。

### 3.6 同步事件与打包

- 自动审核的批准、风险转人工和库存不足转人工都在同一订单事务中写入订单级 `sync_events`。
- 事件使用确定性 eventId、安全 owner HMAC、7 天 TTL、`sourceClient=system`，不得携带 openid、地址、手机号、库存量或付款截图。
- guarded admin 包和 auto-review 独立包会从 canonical 源复制并校验 helper hash，拒绝测试、私钥、凭据、导出和临时审阅文件。
- `adminReviewOrder` 与 `adminWebApi` 源码目录中的审核 primitive/status policy 已同步为 canonical 字节副本，普通云函数目录本身不再依赖目录外的 `cloudfunctions/common`；测试同时约束源码副本和 guarded 包副本 hash。

## 4. 交叉文件说明

以下文件在 P1/P2 开始前已有用户改动，本轮没有回滚，并在当前提交中一起保存；请同时检查它们与本轮逻辑的组合结果：

- `admin-web/src/services/transport/http-transport.ts`
- `admin-web/src/services/transport/http-transport.spec.ts`
- `miniprogram/pages/admin/orders.wxml`
- `scripts/test-admin-orders-filter-summary.js`

其中 45 秒 sync catch-up timeout 与 Task 7 的同步恢复目标一致；订单页摘要与筛选脚本需要和本轮分页逻辑共同保持兼容。

## 5. 已执行验证

- 非 `node_modules` Node 测试：81 个文件，843/843 通过。
- P1/P2 独立最终复验集合：378/378 通过。
- admin-web Vitest：32 个文件，460/460 通过。
- admin-web typecheck、lint、Vite test-mode build 通过；real-build 扫描 61 个文本资产通过。
- 当前改动/新增 JS：81/81 `node --check` 通过。
- 提交前 staged 文件 UTF-8 严格读取：91/91 通过；无 replacement character。
- 小程序后台订单分页与筛选摘要脚本通过；WXML 28 个唯一 handler，缺失 0。
- 两套 PowerShell 打包脚本 parser 通过；临时包内 JS 187/187 通过。
- 打包 manifest：`forbiddenFileCount=0`、`uploadPerformed=false`。
- `git diff --check` 通过，仅有 Windows CRLF/LF 转换提示。

## 6. 已知 Minor

### 6.1 地址 helper 自动发现

`cloudfunctions/common/addressCopies.test.js` 当前硬编码 26 个同步目标，不能自动发现未来新增的
第 28 份 `address.js`。当前仓库实际 27 份地址 helper 已通过全局枚举、hash 一致性和
`procurement` 残留为 0 的检查，因此这是未来防漂移能力不足，不是当前权限回退。

请判断该问题是否仍为 Minor，或是否存在会使其升级的实际部署路径。

### 6.2 稀疏旧订单 owner key

`cloudfunctions/autoReviewOrder/handler.js` 的自动审核同步事件 owner key 使用
`userOpenid || openid`；人工审核路径还兼容 `userId`。当前创建订单入口会保存
`userOpenid`，尚无证据表明正常历史订单仅有 `userId`，因此暂列 Minor。

请检查生产是否可能存在“只有 `userId`、没有 `userOpenid/openid`”且仍会进入自动审核的旧订单。
如果存在，应先通过 `userId` 查回真实 openid，再生成 owner HMAC；不能直接用 `userId`
生成，否则无法与 `getSyncEvents` 当前 openid 的 owner key 对齐。

## 7. 部署状态

用户已确认以下 30 个云函数均已上传，并在核心代码提交 `22c1681` 后重新上传了最后修复涉及的两个函数：

- `adminReviewOrder`
- `adminWebApi`

其余 28 个函数本轮收口阶段没有再次修改。全部上传状态来自用户确认；Codex 没有重新连接云环境核验函数版本/hash，也没有执行真实数据写入，因此“已上传”不等同于已完成云端运行验收。

完整 30 个函数账本：

1. `addMyAddress`
2. `adminReviewOrder`
3. `adminUpdatePayment`
4. `adminWebApi`
5. `autoReviewOrder`
6. `cancelMergeShipment`
7. `cancelOrder`
8. `checkMergeShipmentEligibility`
9. `completeShipment`
10. `confirmInventoryImport`
11. `confirmShipment`
12. `createMergeShipment`
13. `createOrder`
14. `deleteMyAddress`
15. `exportOrdersExcel`
16. `exportShipmentPickingList`
17. `getAdminCustomerAddresses`
18. `getAdminShipmentGroups`
19. `getDefaultAddress`
20. `getMyAddresses`
21. `getOrders`
22. `getShipmentGroupDetail`
23. `getSyncEvents`
24. `parseInventoryFile`
25. `paymentMethods`
26. `setDefaultAddress`
27. `shipmentGroups`
28. `submitCartOrder`
29. `updateMyAddress`
30. `updateShipmentInfo`

小程序仍需确认以下文件已在微信开发者工具重新编译/预览并发布：

- `miniprogram/pages/admin/orders.js`
- `miniprogram/pages/admin/orders.wxml`
- `miniprogram/pages/admin/orders.wxss`
- `miniprogram/pages/payment/payment.js`

admin-web/BFF 的本地 test/build 不等同于已部署；如本次需要交付 web admin，仍需用当前源码重新构建和部署。

## 8. 尚未验证的环境边界

- 真实 CloudBase transaction API、真实并发和生产唯一索引冲突行为。
- `sync_events.eventId` 唯一索引、`createdAt + _id` 查询索引和 `expiresAt` 精确 7 天 TTL。
- `SYNC_OWNER_PEPPER`、`SYNC_CURSOR_SECRET` 的生产值和长度。
- `inventory_logs`、`account_logs`、`import_record_items` 的业务键唯一性及旧 sparse 数据。
- 付款文件真实存在性、上传者归属、ACL，以及库存预览云文件真实可读性。
- 微信开发者工具预览、真机和真实角色权限验收。

本地 mock/静态测试能够证明分支、回滚意图、DTO 和打包契约，但不能替代上述真实环境验证。

## 9. 建议审阅命令与输出格式

请以 Git 中的实际提交为唯一代码依据，不要直接采信本文或本地验证报告的结论：

```powershell
git log --oneline --decorate 07eae28..HEAD
git show --stat --oneline 22c1681
git diff --find-renames 07eae28..HEAD
git status --short
```

请先输出 findings，按 `Critical`、`Important`、`Minor` 排序；每项必须包含文件、行号、触发路径、影响和修复建议。然后单独回答：

1. 本轮是否改变了“审核批准时才扣库存并写账款”的项目语义；
2. 是否存在权限、脱敏、付款凭证、库存导入、分页或同步事件回归；
3. 30 个云函数的源码/打包依赖是否完整；
4. 哪些结论仍必须依赖真实 CloudBase、索引、ACL、微信开发者工具或真机验证；
5. 在排除 P0 的前提下，当前提交是否可以保留在 `main`。

如果没有 Critical/Important，请明确写出 `Critical 0 / Important 0`，不要为了与本文结论一致而省略独立检查。
