# 网页后台真实双端同步测试

> **2026-07-13 付款与账款只读切片：** Web `/accounts` 与 `/payments` 列表/详情已通过 canonical `accountQueryService/paymentQueryService` 和 BFF 专用路由具备重新查询路径；Mock/HTTP 状态筛选、严格 DTO、稳定游标和只读详情已本地完成。账款重算、修改、结清、导出、付款确认/驳回及凭证预览继续关闭。当前 16 函数 local-only 保护包 `.codex-cloudfunction-deploy/admin-web-seventeen-functions-guarded-20260713-202500/` 含 149 个 JS、25 个 JSON、0 个禁止目录，`uploadPerformed=false`；未执行真实 CloudBase 查询、索引或双端事件测试。

> **2026-07-13 合并发货单只读说明：** Web 合并发货单列表/详情已通过 canonical `shipmentQueryService` 和 BFF `GET /shipments`、`GET /shipments/:id` 具备重新查询路径，`shipmentGroups` 旧列表/详情 action 使用兼容 adapters；Mock/HTTP cursor 与严格 DTO 已本地完成。该范围不含单订单发货，所有发货写/导出在 Real 模式均保持关闭；`merge/ship/edit` 返回 501，未登记的 `cancel/complete/export` 返回 404。该切片使用 14 函数历史保护包，当前候选已扩展为 16 函数包；未执行真实 CloudBase 查询、索引、上传、部署或双端事件测试，因此 RT-09 仍不得标记通过。

> **2026-07-13 订单说明：** Web 订单列表/详情和审核/驳回已具备 canonical 路径；本轮没有产生真实小程序订单事件，RT-04/RT-05 仍为“未执行”，不得宣称 1-3 秒双端同步完成。

> **2026-07-12 库存/取消事件历史：** canonical 库存调整与取消订单事件当时已完成本地实现；对应十一函数包现已过期。所有真实 Web <-> 小程序用例仍为“未执行”。

> **历史商品写事件记录：** 商品 create/edit outbox 与对应双端用例仍有效；`188/188` 和 `191343` 十函数包是旧阶段证据，当前以顶部库存/取消事件更新为准。

> 状态：测试矩阵已创建，真实测试环境尚未部署，本文件中的业务用例当前均不得标记通过。

## 1. 环境前置

- 已人工确认环境为隔离测试环境，环境 ID 与 `VITE_CLOUDBASE_ENV_ID` 一致。
- 若获批执行隔离测试，当前候选范围的十六个目标云函数必须指向同一测试环境（A-Z）：`adminDashboard`、`adminGetCustomerAccountDetail`、`adminListCustomerAccounts`、`adminReviewOrder`、`adminWebApi`、`adminWebAuth`、`batchUpdateProductTags`、`cancelOrder`、`cleanupSyncEvents`、`getOrders`、`getSyncEvents`、`getUnsoldProducts`、`manageProduct`、`shipmentGroups`、`updateProductPrice`、`updateProductWarningStock`。当前仅有 local-only 保护包，尚未上传或部署；最终包为 `.codex-cloudfunction-deploy/admin-web-seventeen-functions-guarded-20260713-202500/`，含 149 个 JS、25 个 JSON。
- 测试域名 HTTPS、同源 `/api/admin/v1`、Cookie、Origin、CSRF 和 secret 已验证。
- 使用虚构测试商品、测试账号和脱敏数据，不使用正式商品或客户数据。
- 每个写用例记录 `requestId`、`businessKey`、`eventId`、业务提交时间、事件收到时间和 refetch 完成时间。

## 2. 证据状态定义

| 状态 | 含义 |
| --- | --- |
| 未执行 | 未连接确认的测试环境 |
| 阻断 | 前置接口/环境不可用 |
| 失败 | 已执行且结果不符合要求 |
| 通过 | Web、小程序和数据库证据完整，且无重复业务写 |

Mock、单元测试、静态构建或 collection fallback 只能作为局部证据，不能把本表改成“通过”。

2026-07-11 至 2026-07-12 已完成本地浏览器局部回归：真实模式登录页 fail closed 且可访问；Mock 模式库存预警值和商品改价可保存并刷新列表；商品分析可切换 7/30/90 天、显示当前售价和图表。批量上架混选 active `DEMO-101` 与 inactive `DEMO-103` 时，页面提示“按当前版本”“冲突不覆盖”，提交后显示“已上架 1 个商品”，刷新后 `DEMO-103` 为在售；390x844 无横向溢出，Mock/Real 控制台无 warn/error。此证据未连接测试 BFF、CloudBase 或小程序，所以下列真实双端用例状态保持不变。

商品分析阶段和旧函数包的计数只作为历史证据。合并发货单切片最终本地结果为云函数 `392/392`、Web `285/285`，TypeScript、ESLint、Mock/Real build 和 Real 资产扫描通过；这些仍不能替代真实双端证据。

最终十函数包 `.codex-cloudfunction-deploy/admin-web-ten-functions-guarded-20260712-170536/` 的脚本和独立校验通过：10 个函数、78 个 JS、16 个 JSON、0 个禁止目录，78/78 JS 语法与 16/16 JSON 解析通过，`uploadPerformed=false`。canonical `productTagService` SHA256 为 `57E5C085679A36274F8C9D0A40ECF0479D93696C8737BB8D995D63BE745B5075`，idempotency SHA256 为 `CC88961F31A619414F00BEC68BF59E1E6822BE627E5147AB15FFF3FDC210C974`，recommend SHA256 为 `FDAABF2B45F2E9224013B6A6D4797F0975F8EE69970DA13E7DA18E77ED3DFA1B`；recommend 门禁同步并校验实际使用者 `manageProduct/recommend.js` 与 `manageProduct/common/recommend.js`。这些本地证据仍不能把真实双端状态改为“通过”；`145328` 九函数包及更早包均已过期。

旧 dry-run 为两个分析入口设置的 `timeout=60` 只是历史部署运行边界；未连接真实 CloudBase、未做索引/数据规模/超时压测，不能据此推断 1-3 秒同步或分析性能达标。

## 3. 双端业务矩阵

| ID | 场景 | Web 证据 | 小程序证据 | 数据/幂等证据 | 延迟 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| RT-01A | Web 修改商品售价，小程序列表与详情刷新 | 本地改价 service/UI 完成；云端待采集 | 待采集 | `products.price/version`、单条 `price_logs`、最小 `sync_events`；no-op 零写 | 待测 | 本地实现完成，真实双端未执行 |
| RT-01B | Web 修改商品名称，小程序详情刷新 | metadata-only 编辑本地完成；云端待采集 | 待采集 | 与小程序 `manageProduct.update` 共用 canonical `productWriteService`；旧客户端兼容边界保留 | 待测 | 本地实现完成，真实双端未执行 |
| RT-02 | Web 显式上下架，小程序不可继续新增加购 | 本地 service/BFF 回归通过；云端待采集 | 待采集 | `expectedVersion + expectedIsActive`；`products/admin_operation_logs/sync_events` 同事务；no-op 零写 | 待测 | 本地实现完成，真实双端未执行 |
| RT-02A | 小程序 `manageProduct/delete` 或 `getUnsoldProducts/deactivate` 显式停用，Web 商品列表刷新 | 待采集 | 两个薄适配器本地回归通过 | 与 Web 共用 canonical `productStatusService` | 待测 | 本地实现完成，真实双端未执行 |
| RT-02B | Web 显式批量上架后，小程序列表与详情刷新 | 本地 service/BFF/UI/Mock 回归通过；云端待采集 | 待采集 | 最多 100 个原始快照；逐项 `expectedVersion + expectedIsActive`；变化项分别同事务写商品/日志/outbox；部分成功不覆盖冲突项 | 待测 | 本地实现完成，真实双端未执行 |
| RT-02C | 小程序 `manageProduct.bulkActivate` 批量上架后，Web 商品列表刷新 | 待采集 | canonical 薄适配器与跨页选择逻辑本地回归通过 | 与 Web 共用 `productStatusService`；旧 `productIds`/缺失 key 兼容；同 key 异 payload 不污染原记录 | 待测 | 本地实现完成，真实双端未执行 |
| RT-02D | Web 显式添加/移除公开标签后，小程序列表、搜索与首页推荐刷新 | 本地 service/BFF/UI/Mock 回归通过；云端待采集 | 待采集 | 最多 100 个原始快照；逐项 `expectedVersion + expectedPresent`；只写公开标签/flags/审计时间/version/searchText，保留 `internalTags/isFrequent/defectDescription`；变化项的商品、标签日志、操作日志、最小 outbox 同事务，no-op 零业务写 | 待测 | 本地实现完成，真实双端未执行 |
| RT-02E | 小程序 `batchUpdateProductTags` 修改公开或内部标签后，Web 商品列表按权限刷新 | 待采集 | 旧参数/返回、公开/内部标签及清洗去重后 200 个唯一商品上限的薄适配器本地回归通过 | 与 Web 共用 `productTagService`；Web DTO 不返回 `internalTags`；同 key 异 payload 不污染原记录 | 待测 | 本地实现完成，真实双端未执行 |
| RT-03 | Web 调整库存，其他后台窗口刷新 | canonical 调整 service/UI 本地完成；云端待采集 | 不展示真实库存 | 服务端 delta、单条 inventory log 与最小事件；真实事务待验证 | 待测 | 本地实现完成，真实双端未执行 |
| RT-03A | Web 修改单商品预警值，小程序后台与另一 Web 窗口刷新 | 待采集 | 普通用户不接收 inventory 事件 | 商品 version、inventory log、`inventory.warning_updated` 各一次；同 key 不重复 | 待测 | 本地实现完成，真实双端未执行 |
| RT-03B | 小程序 `updateProductWarningStock` 修改预警值，Web 库存页刷新 | 待采集 | 旧 event/响应保持兼容 | 与 Web 共用 canonical service；原阈值冲突不静默覆盖 | 待测 | 本地实现完成，真实双端未执行 |
| RT-03C | 商品、订单或库存事件使 Web 商品分析刷新 | 待采集；本地已验证 250ms 合并刷新和 60 秒可见页兜底 | 待采集 | 重新调用 canonical `getOverview()`，事件只失效缓存，不触发业务写 | 待测 | 本地 UI/契约完成，真实事件未执行 |
| RT-04 | 小程序下单，Web 订单列表出现 | 待采集 | 待采集 | 未重复订单 | 待测 | 未执行 |
| RT-05 | Web 审核订单，小程序状态与 Web 库存刷新 | canonical `orderReviewService`/BFF/UI 本地完成；云端待采集 | 旧 `adminReviewOrder` adapter 本地兼容，真实待采集 | 审核一次、扣库存一次；真实事务/幂等待验证 | 待测 | 本地实现完成，真实双端未执行 |
| RT-06 | Web 取消符合条件的订单，小程序显示取消 | 待采集 | 待采集 | 必须恢复库存一次且失败可观测 | 待测 | 本地事务回补与回滚测试已通过；真实 CloudBase/双端仍待执行 |
| RT-07 | 小程序上传付款凭证，Web 财务待办出现 | 待采集 | 待采集 | 仍为 pending_confirm | 待测 | 未执行 |
| RT-08 | Web 财务确认付款，小程序付款状态更新 | 待采集 | 待采集 | payment/account log 各一次 | 待测 | 未执行 |
| RT-09 | Web 发货/合并发货，小程序物流更新 | 写操作仍禁用；已登记动作返回 501、未登记动作返回 404；只读列表/详情本地完成 | 待采集 | 不改金额、不重复扣库存 | 待测 | 阻断：发货写未迁移 |
| RT-09A | 小程序合并发货变化后 Web 列表/详情刷新 | canonical 合并发货单读取、严格 DTO 与 cursor 本地完成；云端待采集 | legacy read adapters 本地兼容，真实写事件待采集 | 仅重新查询，不执行 Web 业务写；单订单发货不在该页面范围 | 待测 | 本地读取完成，真实双端未执行 |
| RT-10 | 小程序申请售后，Web 客服待办出现 | 待采集 | 待采集 | 售后记录唯一 | 待测 | 未执行 |
| RT-11 | Web 客服审核售后，小程序状态更新 | 待采集 | 待采集 | 财务没有审核权限 | 待测 | 未执行 |
| RT-12 | Web 财务处理已审核退款，小程序更新 | 待采集 | 待采集 | 金额上限、流水与库存恢复一次 | 待测 | 未执行 |

## 4. 断线、补拉与循环

| ID | 场景 | 期望 | 状态 |
| --- | --- | --- | --- |
| RT-N1 | Web 断网期间小程序下单 | 重连后从 cursor 补齐订单事件并局部刷新 | 未执行 |
| RT-N2 | 小程序离线期间 Web 改价 | `onShow`/网络恢复后获取最新商品 | 未执行 |
| RT-N3 | cursor 篡改或过期 | 清除无效 cursor，执行模块级刷新，不泄漏内部 mark | 未执行 |
| RT-N4 | 同一 event 重复投递 | 只重复安全 refetch，不重复写业务 | 未执行 |
| RT-N5 | 收到 Web 来源事件 | 小程序不再次提交相同业务写，Web 不形成循环 | 未执行 |
| RT-N6 | 事件积压超过单页 | 按 `hasMore` 连续补拉，无同毫秒记录遗漏 | 未执行 |

## 5. 权限与字段同步测试

- `procurement` 事件 topic 仅商品和库存；不得收到 payment/refund/account。
- Web 商品分析只允许 active `procurement/super_admin` 且需 `product:analytics:view`；销售额摘要仅 `super_admin`，库存变化还需 `inventory:view`。小程序 `adminDashboard` 保留既有可分配权限，不套用 Web 硬角色限制。
- Web 单商品改价只允许 active `procurement/super_admin` 且需 `product:update_price`；显式上下架与显式批量上架需 `product:update_status`；批量公开标签需 `product:tag:batch_update`。这些写入口都必须经过 CSRF、`Idempotency-Key` 和服务端当前值/version 守卫，Web 不得得到 `internalTags`。
- `finance` 不得收到商品/库存写权限，也不能审核售后。
- `customer_service` 不得收到付款确认或最终退款能力。
- 普通用户只能收到本人必要的商品/订单/付款/发货/售后状态通知，不含后台字段。
- 事件不得含完整手机号、地址、付款截图 URL、退款账户、账款值、openid、token 或原始内部游标。

## 6. 通过门槛

- RT-01A、RT-01B、RT-02、RT-02A、RT-02B、RT-02C、RT-02D、RT-02E、RT-03 至 RT-12、RT-03C、RT-N1 至 RT-N6 全部在同一隔离测试环境执行；未迁移的名称编辑先解除阻断，RT-06 的库存恢复缺口也必须先解除。
- 在线正常网络端到端 P95 达到 1-3 秒目标；超出时保留样本和原因，不隐瞒。
- 重复点击、重放请求和重复事件不产生重复库存、付款、账款、发货或退款写入。
- 小程序旧入口完整回归通过。

## 7. 当前结论

本地代码已有 cursor、退避、无效 cursor 恢复、角色 topic 过滤，受控商品/库存/订单共享写 service，以及合并发货单 canonical 重新查询路径。没有测试环境 Web 与小程序体验版的双端证据，在线 1-3 秒未测量，当前真实同步结论：**未完成验收**。

独立 `cloudfunctions/getProductAnalytics` 仍是会合成 `current_product` 报价点的 legacy 实现；当前小程序源码走 `adminDashboard` canonical 入口，因此该 legacy 函数不在十四函数候选清单中。`cancelOrder` 本地回补缺口已修复，但真实 CloudBase 与双端取消/库存/账款验证仍不得用 Mock 或内存事务结果替代。
