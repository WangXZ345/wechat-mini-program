const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../index");

function actor() {
  return { id: "admin-1", role: "customer_service", status: "active", isActive: true, permissions: ["order:view"] };
}

test("orders list and detail use the canonical service", async () => {
  const originalList = _test.defaultOrderQueryService.listWebOrders;
  const originalGet = _test.defaultOrderQueryService.getWebOrder;
  const calls = [];
  _test.defaultOrderQueryService.listWebOrders = async (input) => {
    calls.push(["list", input]);
    return { items: [{ id: "order-1" }], total: 1, page: 1, pageSize: 20, nextCursor: null };
  };
  _test.defaultOrderQueryService.getWebOrder = async (input) => {
    calls.push(["get", input]);
    return { id: "order-1", items: [] };
  };
  try {
    const principal = actor();
    const list = await _test.listResource("orders", { page: 1, pageSize: 20, status: "pending_admin" }, principal);
    const detail = await _test.getResource("orders", "order-1", principal);
    assert.equal(list.items[0].id, "order-1");
    assert.equal(detail.id, "order-1");
    assert.equal(calls[0][1].principal, principal);
    assert.equal(calls[0][1].query.status, "pending_admin");
    assert.equal(calls[1][1].id, "order-1");
  } finally {
    _test.defaultOrderQueryService.listWebOrders = originalList;
    _test.defaultOrderQueryService.getWebOrder = originalGet;
  }
});

test("order query errors are mapped to safe public errors", () => {
  const count = _test.orderQueryApiError({ code: "ORDER_COUNT_FAILED", message: "raw database message", statusCode: 503 });
  assert.equal(count.code, "ORDER_COUNT_FAILED");
  assert.equal(count.statusCode, 503);
  assert.equal(count.message, "订单计数失败，请稍后重试");
  const read = _test.orderQueryApiError({ code: "ORDER_READ_FAILED", message: "raw collection name", statusCode: 503 });
  assert.equal(read.code, "ORDER_READ_FAILED");
  assert.equal(read.statusCode, 503);
  assert.equal(read.message, "订单数据读取失败，请稍后重试");
  const items = _test.orderQueryApiError({ code: "ORDER_ITEMS_LIMIT_EXCEEDED", message: "raw limit detail", statusCode: 503 });
  assert.equal(items.code, "ORDER_ITEMS_LIMIT_EXCEEDED");
  assert.equal(items.statusCode, 503);
  assert.equal(items.message, "订单明细过多，请缩小查询范围后重试");
  const scan = _test.orderQueryApiError({ code: "ORDER_SEARCH_SCAN_LIMIT_EXCEEDED", message: "raw scan detail", statusCode: 503 });
  assert.equal(scan.code, "ORDER_SEARCH_SCAN_LIMIT_EXCEEDED");
  assert.equal(scan.statusCode, 503);
  assert.equal(scan.message, "订单搜索范围过大，请增加筛选条件后重试");
  const unknown = _test.orderQueryApiError(new Error("secret collection failure"));
  assert.equal(unknown.code, "ORDER_QUERY_FAILED");
  assert.equal(unknown.statusCode, 500);
  assert.equal(unknown.message, "订单数据读取失败");
});
