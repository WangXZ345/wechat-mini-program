# 客户预下单 + 库存管理微信小程序

这是一个基于微信小程序原生框架和云开发的项目骨架，面向美妆/批发类商品销售场景。当前版本已经覆盖商品展示、客户预下单、库存隐藏、自动/人工审批、库存扣减、付款截图提交、后台商品/订单/库存/账款/支付配置管理。

## 目录结构

```text
.
├── project.config.json
├── miniprogram
│   ├── app.js
│   ├── app.json
│   ├── app.wxss
│   ├── utils
│   │   ├── api.js
│   │   ├── auth.js
│   │   └── status.js
│   └── pages
│       ├── index
│       ├── product
│       ├── order
│       ├── payment
│       └── admin
├── cloudfunctions
│   ├── login
│   ├── getProducts
│   ├── createOrder
│   ├── autoReviewOrder
│   ├── adminReviewOrder
│   ├── getOrders
│   ├── submitPayment
│   ├── adminUpdatePayment
│   ├── manageProduct
│   ├── adminDashboard
│   ├── getSettings
│   ├── updateSettings
│   ├── getAccountSummary
│   ├── getCustomerAccountSummary
│   ├── adminListCustomerAccounts
│   ├── adminGetCustomerAccountDetail
│   ├── updateAccountOnOrderApproved
│   ├── submitPaymentScreenshot
│   ├── confirmPayment
│   ├── rejectPaymentScreenshot
│   ├── markPaymentAbnormal
│   ├── updateCustomerRiskLevel
│   ├── updateCustomerRemark
│   ├── markCustomerSettled
│   ├── recalculateCustomerAccount
│   ├── exportCustomerStatement
│   ├── updateCustomerAccount
│   └── getInventoryLogs
└── docs
    ├── database.md
    └── test-plan.md
```

## 初始化步骤

1. 使用微信开发者工具导入当前目录。
2. 在 `project.config.json` 中把 `appid` 从 `touristappid` 改成你自己的小程序 AppID。
3. 在微信开发者工具中开通云开发，并复制云环境 ID。
4. 在 `miniprogram/app.js` 里把 `globalData.envId` 改成你的云环境 ID；也可以保持空字符串，让工具使用当前默认环境。
5. 在云开发数据库中创建 `docs/database.md` 里列出的集合。
6. 部署 `cloudfunctions` 下的所有云函数，并为每个函数安装依赖。
7. 在 `admin_users` 集合里添加管理员 openid：

```json
{
  "openid": "你的管理员 openid",
  "isActive": true,
  "createdAt": "数据库时间"
}
```

8. 进入小程序后台页面，新增商品、库存和支付方式后，即可从用户端提交预下单。

## 核心业务规则

- 用户端只读取上架商品，不返回真实库存数量。
- 创建订单时，云函数根据库存判断走自动审核或人工审核。
- 库存充足的订单进入 `auto_reviewing`，前端延迟约 10 秒调用 `autoReviewOrder` 完成批准与扣库存。
- 库存不足或商品异常的订单进入 `pending_admin`，必须由管理员人工批准或拒绝。
- 批准订单时使用事务再次检查库存，避免库存扣成负数。
- 订单通过后才允许选择支付方式和上传付款截图。
- 付款截图上传到云存储后，订单进入商家付款确认状态。
- 客户账款使用“分”为单位记录金额，避免浮点误差。
- 客户账款中心按客户汇总累计下单、累计已付、当前未付、今日新增、历史未付、待确认付款和付款异常。
- 风险客户 `risky` 默认进入人工审核；`blocked` 客户禁止提交订单。
- 同一客户当天订单金额写入 `todayOrderAmount`；历史未付会自动合并到付款页本次应付总额。

## 金额约定

所有价格和金额字段都使用整数“分”为单位：

- 商品单价 199.00 元，填写 `19900`
- 商品单价 88.50 元，填写 `8850`
- 页面展示时统一转换为 `xx.xx` 元

## 后续建议

- 把自动审核改为云函数定时触发器或消息队列，避免依赖前端 `setTimeout`。
- 增加订单取消和库存恢复云函数。
- 增加付款截图预览、下载和备注字段。
- 增加管理员操作日志、客户标签和批量导入商品。
- 根据实际结算习惯，把客户账款拆成账单表和付款流水表。
