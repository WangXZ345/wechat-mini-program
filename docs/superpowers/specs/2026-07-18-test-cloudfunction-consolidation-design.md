# 测试环境云函数兼容入口退役设计

## 目标

在不升级测试环境套餐、不连接生产环境、不修改业务数据的前提下，释放 4 个云函数名额，部署网页版后台所需的 4 个新入口，并让网页版通过测试环境真实数据与同步游标工作。

目标环境固定为 `cloud1-d7g4mbc5r2fac4a77`。

## 退役范围

仅退役以下 4 个测试环境远端兼容入口：

- `getAdminAfterSaleDetail`
- `getAdminAfterSales`
- `getAdminRefundDetail`
- `getAdminRefunds`

这 4 个函数不包含独立业务实现，只把请求和可信的微信调用者身份转发给聚合入口 `afterSales`。当前小程序 `miniprogram/utils/api.js` 已对对应 action 优先调用 `afterSales`，只有聚合入口不存在时才回退到旧函数。

本轮保留仓库中的兼容入口源码和 Git 历史，不删除本地目录。这样可避免无必要的源码破坏，并为测试环境回滚保留完整材料。后续部署清单继续采用显式函数名单，不会因为源码仍存在而自动重新部署这些入口。

## 保留边界

- `adminWebAuth` 保持独立，负责 Web 凭证、session、CSRF、限流和安全日志。
- `adminWebApi` 保持独立，负责 Web BFF 路由、权限投影、严格 DTO 和共享业务服务适配。
- `getSyncEvents` 保持独立，负责基于 `WXContext.OPENID` 的小程序同步读取。
- `cleanupSyncEvents` 保持独立，负责过期同步事件清理；只有确认远端触发器配置后才启用计划任务。
- `afterSales` 继续作为售后与退款的公开聚合入口，内部业务规则保持在 canonical services 中。
- 不合并订单审核、付款确认、库存、账款或退款事务边界。

## 部署顺序

1. 只读核对测试环境、函数状态和触发器。
2. 下载 4 个待退役函数的远端完整备份并生成哈希清单。
3. 确认 `afterSales` 在测试环境可用，且本地目标包包含对应聚合 action。
4. 逐个删除 4 个测试环境远端兼容入口，每删除一个立即复核远端状态。
5. 创建并上传 `adminWebApi`、`adminWebAuth`、`cleanupSyncEvents`、`getSyncEvents`。
6. 上传其余 15 个已批准的现有目标函数，确保共享 service 与兼容入口一致。
7. 配置测试环境所需的 Web Auth/API/Sync 环境变量、HTTP 访问边界和必要索引。
8. 仅对测试管理员执行凭证初始化；不输出密码、token、openid 或客户隐私。
9. 配置本地 Real 模式 BFF，启动网页版并完成浏览器验收。

## 回滚

- 每个旧函数删除前必须有可读的远端备份、`index.js`、`package.json` 和 SHA-256 清单。
- 如果删除旧入口后、创建新入口前发现异常，直接从备份重新创建旧入口。
- 如果新入口创建后发现异常，先删除对应失败的新入口，再从备份恢复对应旧入口。
- 不删除 `afterSales`，不修改生产环境，不清空集合。

## 实时数据语义

网页版的“实时”定义为：

- 页面首次读取来自测试环境真实 CloudBase 集合，不使用 Mock 数据。
- Web 通过 `adminWebApi /sync/events` 使用签名游标轮询 `sync_events` 和受控 fallback。
- 同步事件只触发前端缓存失效与重新读取，不作为业务真值。
- UI 在可见和在线状态下按现有客户端策略轮询；断线恢复后从 cursor 补读。
- 本轮不承诺 WebSocket 推送，也不通过写订单、库存、账款或客户数据制造测试事件。

## 验收标准

1. 测试环境中 4 个旧兼容入口不存在，4 个 Web/Sync 新入口存在且状态可用。
2. 19 个批准目标函数的部署结果逐项可核对，失败项不得被报告为成功。
3. Real 模式的 `/api/admin/v1/auth/profile` 不再返回 `BFF_PROXY_NOT_CONFIGURED`。
4. 测试管理员可登录网页版，工作台和至少两个业务列表读取测试环境真实数据。
5. 浏览器网络请求不访问 Mock transport，构建资产不包含已知测试数据标记。
6. `/sync/events` 能返回合法 cursor/事件批次或安全的空批次，前端同步状态正常。
7. 不发布小程序，不连接生产环境，不修改订单、库存、账款、客户或付款业务数据。

