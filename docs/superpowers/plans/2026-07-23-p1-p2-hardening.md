# P1/P2 安全与一致性整改实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every production-code change. Each task is implemented by a fresh subagent and independently reviewed before final verification.

**Goal:** 在不改变库存扣减时机、订单业务语义、权限模型和旧数据兼容的前提下，完成已确认的 P1 与 P2 整改。

**Architecture:** P1 采用局部、可回归的安全修复；P2 只抽取现有审核/状态/同步规则，不引入新业务状态或数据迁移。所有云函数继续通过服务端写核心集合，前端不新增数据库直写。

**Tech Stack:** 微信小程序原生前端、Node.js 云函数、CloudBase 数据库事务、Vue/Vite admin-web、`node:test`。

## Global Constraints

- P0 事务 API 兼容性、真实云并发和生产唯一索引本轮不处理。
- 购物车和下单阶段不预留、不扣减库存；只在自动审核或人工审核批准时事务扣减。
- 不新增 Redis 锁、`manual_reviewing`、`lifecycleStatus` 或客户分配模型。
- 金额继续使用整数分；不更名集合、云函数、订单核心字段或现有状态码。
- 不降低手机号、地址、付款截图、客户账款和后台字段的权限边界。
- 保留旧订单、旧字段别名和旧入口兼容。
- 不修改生产配置，不连接生产环境写数据，不上传云函数，不发布小程序。
- 不提交或推送 Git；保留并兼容工作区现有未提交改动。

---

### Task 1: 移除采购角色完整地址遗留捷径

**Files:**
- Modify: `cloudfunctions/common/services/shipmentQueryService.js`
- Modify: `cloudfunctions/adminWebApi/lib/shipmentQueryService.js`
- Test: `cloudfunctions/common/services/shipmentQueryService.test.js`
- Test: `cloudfunctions/adminWebApi/test/projection-security.test.js`
- Test as needed: `cloudfunctions/adminWebApi/test/shipment-query.test.js`

**Interfaces:**
- Consumes: 项目现有 `shipment:view_address_full`、`customer:view_address_full` 权限。
- Produces: `fullAddressAllowed` 只由超级管理员或显式完整地址权限决定，`procurement` 角色本身不再构成放行条件。

- [ ] 写一个失败测试：具有 `shipment:view` 但没有完整地址权限的采购角色只能看到脱敏地址。
- [ ] 运行覆盖测试并确认失败原因是采购角色捷径仍然存在。
- [ ] 删除 canonical 与 admin-web 副本中的角色捷径，不改变手机号脱敏和其他角色权限。
- [ ] 运行三组发货/投影测试并确认通过。
- [ ] 对两个运行时副本做哈希或内容一致性检查。

### Task 2: 加强付款截图文件归属校验

**Files:**
- Modify: `cloudfunctions/paymentMethods/index.js`
- Create if needed: `cloudfunctions/paymentMethods/paymentProofPolicy.js`
- Test: `cloudfunctions/paymentMethods/index.test.js` or a focused new `node:test` file in the same directory
- Modify only if required for compatible payloads: `miniprogram/pages/payment/payment.js`

**Interfaces:**
- Consumes: `orderId`、当前用户身份、客户端上传的 CloudBase `fileID`。
- Produces: 仅接受属于当前订单约定目录的 CloudBase 文件标识；拒绝 HTTP URL、路径穿越、其他订单前缀和超量文件。

- [ ] 先定位现有上传路径与 `submitOfflinePaymentProof` 数据流，记录当前允许格式。
- [ ] 写失败测试覆盖：合法当前订单文件、其他订单文件、HTTP URL、路径穿越、重复文件和超过上限。
- [ ] 运行测试并确认安全负例在修改前被错误接受。
- [ ] 实现纯策略函数并在服务端提交入口调用；错误返回使用稳定英文 `code` 和安全中文 `message`。
- [ ] 如现有客户端路径不满足策略，仅做最小兼容调整，不改变付款状态 `pending_confirm`。
- [ ] 运行付款方式、付款提交及相关语法检查。
- [ ] 文档化边界：仓库不能证明云存储规则，仍需后续环境核查。

### Task 3: 将库存导入确认绑定到预览结果

**Files:**
- Modify: `cloudfunctions/parseInventoryImport/index.js`
- Modify: `cloudfunctions/confirmInventoryImport/index.js`
- Create if useful: `cloudfunctions/common/inventoryImportProof.js` plus deployable copies/proxies following existing packaging convention
- Test: corresponding parse/confirm inventory import tests

**Interfaces:**
- Consumes: 预览行、匹配商品身份、当前商品关键身份字段。
- Produces: 服务端生成的确定性预览证明；确认时重新计算并校验商品 ID、名称、规格/SKU 等匹配身份，过期或不一致返回冲突错误。

- [ ] 先追踪预览 payload、确认 payload 和当前事务重读逻辑。
- [ ] 写失败测试覆盖：正常确认、预览后商品身份变化、篡改 `productId`、复用其他预览行证明和旧客户端缺证明的兼容行为。
- [ ] 运行测试并确认身份变化/篡改在修改前未被拒绝。
- [ ] 生成不含秘密但不可被客户端随意改写后仍通过的确定性证明；确认阶段从可信字段重新计算。
- [ ] 保留现有精确匹配、歧义拒绝和旧数据兼容，不自动选择模糊匹配商品。
- [ ] 运行导入相关测试、JS 语法检查和 JSON 检查。

### Task 4: 为小程序后台订单页接入后端分页

**Files:**
- Modify: `miniprogram/pages/admin/orders.js`
- Modify carefully, preserving existing user changes: `miniprogram/pages/admin/orders.wxml`
- Modify if needed: `miniprogram/pages/admin/orders.wxss`
- Test: extend `scripts/test-admin-orders-filter-summary.js` or create a focused admin orders pagination test

**Interfaces:**
- Consumes: `getOrders` 的 `page`、`pageSize`、`hasMore` 返回。
- Produces: 首次加载重置分页；筛选变化重置分页；加载更多追加且去重；请求锁避免重复追加；无更多数据时停止请求。

- [ ] 写失败测试覆盖首次请求参数、第二页追加、筛选重置、重复点击请求锁和 `hasMore=false`。
- [ ] 运行测试并确认当前页面没有分页状态/追加行为。
- [ ] 增加最小分页状态和 `loadMore` 方法，保留现有筛选、审核、付款、发货及用户未提交的 WXML 改动。
- [ ] 增加低干扰的加载更多/无更多提示，不重设计页面。
- [ ] 运行页面测试、JS 语法、WXML 静态绑定检查。

### Task 5: 统一自动审核与 canonical 审核的核心规则

**Files:**
- Modify: `cloudfunctions/autoReviewOrder/index.js`
- Modify as required: `cloudfunctions/common/services/orderReviewService.js`
- Modify as required: `cloudfunctions/common/services/inventoryMutationService.js`
- Add deployable copy/proxy and packaging support only if canonical service reuse requires it
- Test: `cloudfunctions/autoReviewOrder/handler.test.js` and focused service tests

**Interfaces:**
- Consumes: 现有订单明细、风险等级、库存业务键 `order_deduct:${orderId}:${productId}`、账款业务键 `order_debt:${orderId}`。
- Produces: 自动审核复用 canonical 的可测试纯规则或库存变更原语，同时保留自动审核的风险客户和库存不足转人工逻辑。

- [ ] 先列出自动与人工审核在库存、账款、版本、业务键和错误处理上的差异。
- [ ] 写失败测试固定自动审核必须保留的语义：风险客户转 `pending_admin`、库存不足转人工、重复业务键不重复扣减、批准后才入账。
- [ ] 抽取或复用最小公共原语，不把管理员权限校验套到系统自动审核上。
- [ ] 让自动审核补齐安全版本递增和与 canonical 一致的业务元数据，但不改变现有状态名称。
- [ ] 不处理 P0 的事务 API 形态、云端并发或索引部署。
- [ ] 运行自动审核、人工审核、库存变更和账款相关测试。

### Task 6: 集中订单状态判定与转换规则

**Files:**
- Create: `cloudfunctions/common/orderStatusPolicy.js`
- Modify: `cloudfunctions/common/services/orderReviewService.js`
- Modify: `cloudfunctions/cancelOrder/orderCancellationService.js`
- Modify: `cloudfunctions/autoReviewOrder/index.js`
- Add deployable copies/proxies only where现有云函数打包方式要求
- Test: focused policy tests plus affected service tests

**Interfaces:**
- Produces: 命名的状态集合和纯函数，例如 `canReviewOrder(status)`、`isApprovedOrder(status, paymentStatus)`、`canCancelOrder(order)`；继续读取 `status`、`paymentStatus`、`deliveryStatus`、`shippingStatus`。
- Does not produce: 新字段、新状态、旧数据迁移或批量回填。

- [ ] 写失败测试覆盖审核、批准、拒绝、取消、已付款和已发货边界。
- [ ] 实现无数据库依赖的纯策略模块。
- [ ] 仅替换三个已验证服务中的重复状态集合/判断，不扩大到全部页面。
- [ ] 保持所有现有错误码和用户可见文案兼容。
- [ ] 运行策略、审核、取消及订单查询回归测试。

### Task 7: 补齐订单审核的 `sync_events` 覆盖

**Files:**
- Modify: `cloudfunctions/autoReviewOrder/index.js`
- Modify as needed: `cloudfunctions/common/syncEvents.js` or a focused canonical helper
- Modify packaging script if deployable helper copy is required
- Test: auto-review and sync-event focused tests

**Interfaces:**
- Consumes: 自动审核最终状态、订单版本、所有者安全键生成能力。
- Produces: 自动审核通过、风险转人工、库存不足转人工各自的确定性 `eventId`；事件只包含安全投影所需字段，不写手机号、地址、openid 或付款截图。

- [ ] 写失败测试覆盖三个自动审核结果及重复调用事件复用。
- [ ] 复用现有同步事件安全投影和 TTL 约定，不另建 outbox。
- [ ] 在同一订单事务内写事件；事件写入失败时不允许订单状态单独提交。
- [ ] 不承诺或实现“稳定 1–3 秒”，只保证事件覆盖和可恢复游标语义。
- [ ] 运行 sync、auto-review、admin-web 查询相关测试。

### Task 8: 独立总体验证

**Files:**
- No production changes unless a Critical/Important review finding is returned to a dedicated fixer.

- [ ] 独立审查七项变更是否符合本计划和 `AGENTS.md`。
- [ ] 检查无关改动、敏感信息、权限回退、库存语义变化和部署遗漏。
- [ ] 运行受影响的完整测试集、JS 语法、JSON 解析、admin-web lint/test/build（仅在受影响时）。
- [ ] 输出需要上传的云函数 A-Z 列表、仅需重新编译的小程序文件和未验证边界。
- [ ] 明确尚未上传、尚未发布、未执行 P0/真实云环境验证。
