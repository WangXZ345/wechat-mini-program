# P1-08 统一发货状态机与转换守卫设计

## 1. 范围

本任务只建立服务端唯一发货状态机、转换守卫和事务写入计划接口，供后续 P4-01 至 P4-04 调用。它不开放新的 HTTP/云函数写路由，不启用 admin-web 发货按钮，不上传云函数，不连接生产，也不再次扣库存或修改账款、付款。

现有 `shipmentGroups` 写入口属于兼容入口。若本次接线，只允许把其状态、权限、付款、版本和一致性判断委托给 canonical service；不得改变响应外壳、集合名或既有幂等机制，也不得把 P4 页面闭环提前实现。

## 2. 唯一状态模型

发货状态统一为：

| 状态 | 语义 | 可继续转换 |
| --- | --- | --- |
| `created` | 发货单已建立，物流信息可为空 | 编辑物流、确认发货、取消 |
| `pending_shipment` | 等待确认发货，物流信息可编辑 | 编辑物流、确认发货、取消 |
| `shipped` | 已确认发货 | 完成 |
| `completed` | 发货终态 | 无 |
| `cancelled` | 取消终态 | 无 |
| `abnormal` | 人工异常态，当前任务不定义自动恢复 | 无 |

旧订单/发货单兼容读取规则：优先读取 `shippingStatus`；缺失时把 `deliveryStatus=shipped/completed/after_sales` 映射为 `shipped/completed/abnormal`；其余已审核且未发货旧订单映射为 `pending_shipment`。未知、空值或相互冲突的数据必须返回受控错误，不得猜测可写状态。

## 3. 命令与转换表

canonical command 至少覆盖：

| 命令 | 实体 | 合法来源 | 目标/结果 | 权限 |
| --- | --- | --- | --- | --- |
| `ship_single_order` | 单订单 | `pending_shipment` | `shipped` | `shipment:ship` 或既有兼容 `order:ship` |
| `add_orders_to_merge` | 订单集合 | 全部 `pending_shipment` | 生成/加入 `created` 合并单计划 | `shipment:merge` |
| `confirm_merge` | 合并单 | `created` | `pending_shipment` | `shipment:merge` |
| `edit_logistics` | 合并单/单订单 | `created`、`pending_shipment` | 状态不回退；保持原状态或从 `created` 进入 `pending_shipment` | `shipment:update` |
| `cancel_pending` | 合并单/单订单 | `created`、`pending_shipment` | `cancelled`；合并订单解除有效绑定并回到 `pending_shipment` | `shipment:cancel` |
| `confirm_shipment` | 合并单 | `created`、`pending_shipment` | `shipped`，订单同步为 `shipped` | `shipment:ship` |
| `complete_shipment` | 合并单/单订单 | `shipped` | `completed`，订单同步为 `completed` | `shipment:complete` |

`completed`、`cancelled` 和 `abnormal` 不允许任何转换。新请求对 `shipped` 再次确认发货、对 `completed` 再次完成、对 `cancelled` 再次取消均 fail closed；只有 P1-04 在进入守卫前识别出的同幂等键同载荷重放可以复用历史结果。

## 4. 守卫顺序

守卫按以下顺序执行并返回稳定错误码：

1. 校验 command、actor active 状态和 exact permission；不信任前端按钮或会话注入权限。
2. 校验 `expectedVersion` 为非负安全整数；旧记录缺失 `version` 兼容为 `0`，但调用方仍必须显式提交 `expectedVersion=0`。
3. 校验实体标识、当前状态和终态不可逆；未知状态 fail closed。
4. 发货类命令重新核验订单处于已审核业务状态，以及付款设置：`requirePaidBeforeShipment=true` 时只允许 `paid`，仅在 `allowPartialPaidShipment=true` 时允许 `partial_paid`。
5. 合并命令校验订单非自提、属于同一客户、地址策略允许、无其它有效合并单、无重复订单、未发货/未完成。
6. 合并单命令校验 `orderIds` 与每个订单的 `mergeShipmentId`/`shipmentGroupId` 一致；跨客户、缺订单、重复绑定或部分绑定均拒绝。
7. 物流确认校验承运商和运单号；编辑物流不能改变付款、账款、库存或订单审核字段。

错误对象只包含安全的 `code`、`message`、`statusCode` 和不含客户标识/地址/付款凭证的 `details`。

## 5. 服务接口与事务计划

canonical 模块位于 `cloudfunctions/common/services/shipmentStateMachine.js`，部署副本必须与 `cloudfunctions/adminWebApi/lib/shipmentStateMachine.js` 和需要接线的 `shipmentGroups` 副本 SHA-256 一致。

公开接口：

```js
normalizeShipmentStatus(entity)
assertShipmentTransition(input)
planShipmentTransition(input)
```

`assertShipmentTransition` 是纯守卫；`planShipmentTransition` 在守卫通过后返回不可变、最小字段白名单的事务计划：`shipmentPatch`、`orderPatches`、`fromStatus`、`toStatus`、`requiredPermission`。补丁只允许发货归属、物流、版本、时间和操作者引用字段，不包含 `stock`、库存流水、金额、账款或付款字段。实际 P4 写服务必须在一个 CloudBase transaction 中重新读取记录、再次调用守卫并应用完整计划；路由不得复制状态判断。

## 6. 测试与交付

使用 `node:test` 表驱动覆盖每条合法边和所有非法边，重点覆盖：角色/权限、付款条件、跨客户合并、有效合并单冲突、旧记录 `version=0`、版本冲突、重复发货/完成/取消、终态不可逆、未知状态、物流字段缺失，以及计划中没有库存/账款/付款字段。

验证包含 canonical 单测、部署副本哈希、`shipmentGroups` 兼容测试、adminWebApi 相关订单/付款/库存回归、admin-web 类型检查/Lint/真实模式构建和独立负向审查。真实 CloudBase transaction、微信开发者工具、浏览器写路径、云函数上传、admin-web 部署和生产数据均保持未验证/未执行。
