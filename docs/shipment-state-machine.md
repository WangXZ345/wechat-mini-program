# 统一发货状态机契约

## 范围与入口

唯一规则源是 `cloudfunctions/common/services/shipmentStateMachine.js`。`adminWebApi/lib` 与 `shipmentGroups` 中的同名文件必须是字节一致的部署副本。本阶段只提供纯守卫与事务计划，不开放 admin-web/P4 写路由，不执行数据库写入，也不修改库存、账款或付款。

公开接口：

- `normalizeShipmentStatus(entity)`：将当前记录归一化为唯一发货状态。
- `assertShipmentTransition(input)`：纯校验；失败抛出安全、稳定的 `ShipmentTransitionError`。
- `planShipmentTransition(input)`：返回深冻结的最小事务计划。

输入为 `{command, actor, order?, orders?, shipment?, settings?, expectedVersion, logistics?}`。调用方不得信任前端状态或权限，必须在 CloudBase transaction 内重新读取当前记录后调用。

## 状态与旧数据归一化

状态集合只有 `created`、`pending_shipment`、`shipped`、`completed`、`cancelled`、`abnormal`。`completed`、`cancelled`、`abnormal` 是不可逆终态。

优先读取 `shippingStatus`。缺失时：

| 旧字段 | 归一化结果 |
| --- | --- |
| `deliveryStatus=shipped` | `shipped` |
| `deliveryStatus=completed` | `completed` |
| `deliveryStatus=after_sales` | `abnormal` |
| 已审核订单（含 `approved_pending_payment`、`pending_payment_confirm`、`paid`、`partial_paid`、`unpaid` 等兼容业务状态）或 `deliveryStatus=waiting_shipping` | `pending_shipment` |

未知、空白或显式 `shippingStatus` 与上述终态旧字段冲突时返回 `SHIPMENT_STATUS_INVALID`，不得猜测。`paymentStatus=paid` 本身不是订单已审核证据，不能把 `pending_review` 等未审核记录归一化为可发货状态。

## 合法转换矩阵

| command | 实体 | 合法来源 | 目标 | 精确权限 |
| --- | --- | --- | --- | --- |
| `ship_single_order` | 单订单 | `pending_shipment` | `shipped` | `shipment:ship` 或兼容 `order:ship` |
| `add_orders_to_merge` | 订单集合 | 全部 `pending_shipment` | `created` | `shipment:merge` |
| `confirm_merge` | 合并单 | `created` | `pending_shipment` | `shipment:merge` |
| `edit_logistics` | 合并单或单订单 | `created` | `pending_shipment` | `shipment:update` |
| `edit_logistics` | 合并单或单订单 | `pending_shipment` | `pending_shipment` | `shipment:update` |
| `cancel_pending` | 合并单或单订单 | `created` | `cancelled` | `shipment:cancel` |
| `cancel_pending` | 合并单或单订单 | `pending_shipment` | `cancelled` | `shipment:cancel` |
| `confirm_shipment` | 合并单 | `created` | `shipped` | `shipment:ship` |
| `confirm_shipment` | 合并单 | `pending_shipment` | `shipped` | `shipment:ship` |
| `complete_shipment` | 合并单或单订单 | `shipped` | `completed` | `shipment:complete` |

所有未列出的边均非法，包括重复发货、重复完成、重复取消和任何终态转换，统一 fail closed 为 `SHIPMENT_TRANSITION_NOT_ALLOWED`。合并单命令还必须逐笔校验关联订单来源状态：`confirm_merge`、`confirm_shipment`、合并单 `cancel_pending` 要求订单为 `pending_shipment`，合并单 `complete_shipment` 要求订单为 `shipped`，终态订单不得被回退。

## 守卫与错误码

守卫顺序是 command、active actor、允许角色（`super_admin` / `customer_service`）与精确权限、显式版本、状态、订单审核/付款、合并候选、绑定一致性、物流完整性。即使权限数组被错误注入，`procurement`、`finance` 等非发货角色也不能执行写命令。

| 错误码 | 含义 |
| --- | --- |
| `SHIPMENT_COMMAND_INVALID` | 未知命令 |
| `INVALID_ACTOR` | actor 缺身份、角色或非 active |
| `FORBIDDEN` | 缺少命令要求的精确权限 |
| `EXPECTED_VERSION_REQUIRED` / `EXPECTED_VERSION_INVALID` | 请求未显式提供合法非负安全整数版本 |
| `DATA_VERSION_CONFLICT` | 存储版本非法或不匹配 |
| `SHIPMENT_STATUS_INVALID` | 状态未知、空白或冲突 |
| `SHIPMENT_TRANSITION_NOT_ALLOWED` | 非法状态边或终态重试 |
| `SHIPMENT_ORDER_NOT_APPROVED` | 订单业务审核状态不允许发货 |
| `SHIPMENT_PAYMENT_REQUIRED` | 付款设置不允许发货 |
| `SHIPMENT_PICKUP_NOT_ALLOWED` | 自提订单加入合并发货 |
| `SHIPMENT_CUSTOMER_MISMATCH` | 合并订单跨客户，或 shipment 客户与订单客户不一致 |
| `SHIPMENT_ORDER_DUPLICATE` | 候选订单重复或标识无效 |
| `SHIPMENT_ALREADY_BOUND` | 订单已有有效合并发货绑定 |
| `SHIPMENT_ADDRESS_MISMATCH` | 设置不允许不同地址合并 |
| `SHIPMENT_BINDING_INCONSISTENT` | 发货单、orderIds 与订单绑定不一致 |
| `SHIPMENT_LOGISTICS_REQUIRED` | 确认发货缺承运商或运单号 |

错误仅暴露 `code`、安全 `message`、`statusCode` 和可选安全 `details`，不得包含客户标识、地址、付款凭证等敏感数据。

## 付款、版本与幂等边界

`requirePaidBeforeShipment=true` 时仅允许 `paid`；仅当 `allowPartialPaidShipment=true` 时额外允许 `partial_paid`。设置明确为不要求付款时仍必须通过订单已审核检查。

客户一致性按兼容身份字段求证：所有记录有相同非空 `userId` 即视为同一客户；否则，仅在所有记录有相同非空 `userOpenid`/`openid` 时视为同一客户。合并候选订单以及 shipment 与其绑定订单都使用同一规则；标识全空、冲突或无法找到共同标识一律返回 `SHIPMENT_CUSTOMER_MISMATCH`。单独的 `paymentStatus=paid` 仍不能证明订单已经审核。

调用方必须显式提交 `expectedVersion`。旧记录缺 `version` 只把当前值兼容为 `0`，调用方仍须提交 `0`。`add_orders_to_merge` 必须提供有效的未来 shipment `_id`，不能退回首订单或生成空绑定；其单一版本参数采用 fail-closed 规则：候选发货上下文和每笔订单必须具有同一个当前版本并与 `expectedVersion` 相等。后续 P4 若需要每订单独立版本，必须显式扩展契约，不得放宽检查。

同幂等键同载荷的成功重放只能由 P1-04 在进入状态机前返回历史结果。进入状态机的新请求即使业务载荷相同，也不能绕过终态和重复转换守卫。

## 事务计划白名单

计划对象固定只含 `fromStatus`、`toStatus`、`requiredPermission`、`shipmentPatch`、`orderPatches`，并递归冻结。补丁只允许：

- 状态：`shippingStatus`、兼容 `deliveryStatus`、`mergeShipmentStatus`；
- 绑定：`mergeShipmentId`、`shipmentGroupId`、`isMergedShipment`；
- 物流：`shippingCompany`、`trackingNo`、`trackingNoList`；
- 并发与操作者：`version`、`updatedBy`。

任何 key 匹配 `stock`、`inventory`、`amount`、`account`、`payment`、`price`、`debt`、`balance` 都必须拒绝。合并发货、完成和取消计划同步生成 shipment 与逐订单补丁；取消合并时订单解除有效绑定并回到 `pending_shipment`。

## P4 接入与当前阻塞

P4 写服务必须在同一 CloudBase transaction 中完成：读取 shipment/orders/settings，核验 authenticated actor，调用 `planShipmentTransition`，按完整计划写入，并让任意失败回滚全部写入。路由和 handler 不得再定义状态数组或复制判断。

现有 `cloudfunctions/shipmentGroups/index.js` 写入口尚未委托。其调用方未显式提供 `expectedVersion`，且旧实现仍允许部分重复完成/取消/发货复用；在不改 UI/API 契约的 P1-08 范围内无法安全接线。它是明确的 P4 迁移 blocker，不能默认 `expectedVersion=0`。现有 `{ok,data}` / `{ok:false,code,message}` 外壳保持不变，adminWebApi shipment mutation 仍返回既有 `SERVICE_NOT_MIGRATED`，没有开放新路由。
