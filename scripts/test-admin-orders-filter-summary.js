const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const templatePath = path.join(__dirname, "..", "miniprogram", "pages", "admin", "orders.wxml");
const template = fs.readFileSync(templatePath, "utf8");

assert.match(
  template,
  /wx:if="\{\{selectedOrderStatusLabel === '全部' && selectedPaymentStatusLabel === '全部'\}\}"[^>]*>全部订单<\/view>/,
  "订单和付款状态均未筛选时，顶部摘要应显示“全部订单”"
);
assert.doesNotMatch(
  template,
  /<view class="hero-filter-pill">\{\{selectedOrderStatusLabel\}\} · \{\{selectedPaymentStatusLabel\}\}<\/view>/,
  "顶部摘要不应在默认状态显示“全部 · 全部”"
);

console.log("admin orders filter summary regression check passed");
