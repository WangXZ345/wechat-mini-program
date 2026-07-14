const test = require("node:test");
const assert = require("node:assert/strict");
const { createOrderQueryService } = require("./orderQueryService");

function commandSet() {
  const compare = (op, value) => ({ __op: op, value, and(other) { return { __op: "and", values: [this, other] }; } });
  return {
    in: (values) => ({ __op: "in", values }),
    neq: (value) => compare("neq", value),
    lt: (value) => compare("lt", value),
    lte: (value) => compare("lte", value),
    gte: (value) => compare("gte", value),
    and: (values) => ({ __op: "and", values }),
    or: (values) => ({ __op: "or", values })
  };
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function matchesValue(actual, expected) {
  if (expected && expected.__regex) return expected.__regex.test(String(actual || ""));
  if (!expected || typeof expected !== "object" || !expected.__op) return comparable(actual) === comparable(expected);
  if (expected.__op === "in") return expected.values.includes(actual);
  if (expected.__op === "neq") return actual !== expected.value;
  if (expected.__op === "lt") return comparable(actual) < comparable(expected.value);
  if (expected.__op === "lte") return comparable(actual) <= comparable(expected.value);
  if (expected.__op === "gte") return comparable(actual) >= comparable(expected.value);
  if (expected.__op === "and") return expected.values.every((part) => matchesValue(actual, part));
  return false;
}

function matches(row, where) {
  if (!where || !Object.keys(where).length) return true;
  if (where.__op === "and") return where.values.every((part) => matches(row, part));
  if (where.__op === "or") return where.values.some((part) => matches(row, part));
  return Object.entries(where).every(([key, expected]) => matchesValue(row[key], expected));
}

function fakeDatabase(collections, options = {}) {
  const command = commandSet();
  function collection(name) {
    const state = { where: {}, skip: 0, limit: Infinity, orders: [] };
    const query = {
      where(value) { state.where = value || {}; return query; },
      skip(value) { state.skip = value; return query; },
      limit(value) { state.limit = value; return query; },
      orderBy(field, direction) { state.orders.push([field, direction]); return query; },
      async count() {
        if (options.failCount) throw new Error("count unavailable");
        return { total: (collections[name] || []).filter((row) => matches(row, state.where)).length };
      },
      async get() {
        const rows = (collections[name] || []).filter((row) => matches(row, state.where)).slice();
        rows.sort((left, right) => {
          for (const [field, direction] of state.orders) {
            const a = comparable(left[field]);
            const b = comparable(right[field]);
            if (a === b) continue;
            const result = a < b ? -1 : 1;
            return direction === "desc" ? -result : result;
          }
          return 0;
        });
        const data = rows.slice(state.skip, state.skip + state.limit);
        if (typeof options.onGet === "function") options.onGet({ name, skip: state.skip, limit: state.limit, returned: data.length });
        return { data };
      }
    };
    return {
      ...query,
      doc(id) {
        return { async get() {
          if (options.docError) throw new Error("database unavailable");
          return { data: (collections[name] || []).find((row) => row._id === id) || null };
        } };
      }
    };
  }
  return {
    command,
    db: {
      collection,
      RegExp({ regexp, options: flags }) { return { __regex: new RegExp(regexp, flags) }; }
    }
  };
}

function principal(role, permissions) {
  return { id: `${role}-1`, role, status: "active", isActive: true, permissions };
}

test("web list joins real items and uses a stable createdAt plus id cursor", async () => {
  const createdAt = new Date("2026-07-13T00:00:00.000Z");
  const { db, command } = fakeDatabase({
    orders: ["a", "b", "c"].map((id) => ({ _id: id, orderNo: `NO-${id}`, userId: `u-${id}`, status: "pending_admin", createdAt, customerPhoneMasked: `138****120${id === "a" ? 1 : id === "b" ? 2 : 3}` })),
    order_items: ["a", "b", "c"].map((id) => ({ _id: `i-${id}`, orderId: id, productName: `商品 ${id}`, quantity: 2 })),
    users: [],
    customer_accounts: []
  });
  const service = createOrderQueryService({ db, command });
  const actor = principal("customer_service", ["order:view", "customer:view_phone_masked"]);
  const first = await service.listWebOrders({ principal: actor, query: { pageSize: 2 } });
  const second = await service.listWebOrders({ principal: actor, query: { pageSize: 2, cursor: first.nextCursor, page: 2 } });
  assert.deepEqual(first.items.map((row) => row.id), ["c", "b"]);
  assert.deepEqual(second.items.map((row) => row.id), ["a"]);
  assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 3);
  assert.equal(first.items[0].itemSummary, "商品 c");
  assert.equal(first.items[0].customerMasked.includes("138****1203"), true);
});

test("detail applies role-specific amount, phone, address, remark and risk projection", async () => {
  const collections = {
    orders: [{
      _id: "order-1", orderNo: "NO-1", userId: "user-1", status: "pending_admin", totalAmount: 12345,
      riskLevelSnapshot: "risk", adminNote: "仅审核可见", createdAt: new Date("2026-07-13T00:00:00Z"),
      shippingAddressSnapshot: { receiverName: "张三", receiverPhone: "13800138000", regionText: "上海市", detailAddress: "浦东新区完整地址" }
    }],
    order_items: [{ _id: "item-1", orderId: "order-1", productId: "product-1", productName: "精华", quantity: 2, unitPrice: 5000, totalAmount: 10000 }],
    users: [{ _id: "user-1", openid: "secret-openid", nickname: "张三", phoneNumber: "13800138000" }],
    customer_accounts: [{ _id: "account-1", userId: "user-1", riskLevel: "blocked", unpaidAmount: 9000 }]
  };
  const { db, command } = fakeDatabase(collections);
  const service = createOrderQueryService({ db, command });
  const reviewer = await service.getWebOrder({
    principal: principal("customer_service", ["order:view", "order:review", "order:edit_remark", "customer:view_phone_masked", "customer:view_address_masked"]),
    id: "order-1"
  });
  assert.equal(reviewer.totalAmountCents, undefined);
  assert.equal(reviewer.items[0].unitPriceCents, undefined);
  assert.equal(reviewer.customer.phone, undefined);
  assert.equal(reviewer.shippingAddress, undefined);
  assert.equal(reviewer.shippingAddressMasked.regionText, "上海市");
  assert.equal(reviewer.riskLevelSnapshot, "risk");
  assert.equal(reviewer.adminRemark, "仅审核可见");
  assert.equal(JSON.stringify(reviewer).includes("secret-openid"), false);
  assert.equal(JSON.stringify(reviewer).includes("13800138000"), false);

  const finance = await service.getWebOrder({
    principal: principal("finance", ["order:view", "dashboard:view_sales", "customer:view_phone_full", "customer:view_address_full"]),
    id: "order-1"
  });
  assert.equal(finance.totalAmountCents, 12345);
  assert.equal(finance.items[0].unitPriceCents, 5000);
  assert.equal(finance.customer.phone, "13800138000");
  assert.equal(finance.shippingAddress.receiverPhone, "13800138000");
  assert.equal(finance.riskLevelSnapshot, undefined);
  assert.equal(finance.adminRemark, undefined);
});

test("search is real, count errors fail closed, and procurement is rejected", async () => {
  const collections = {
    orders: [{ _id: "order-1", orderNo: "PO-7788", customerPhoneMasked: "139****7788", createdAt: new Date("2026-07-13T00:00:00Z") }],
    order_items: [], users: [], customer_accounts: []
  };
  const actor = principal("customer_service", ["order:view", "customer:view_phone_masked"]);
  const healthy = fakeDatabase(collections);
  const service = createOrderQueryService(healthy);
  const result = await service.listWebOrders({ principal: actor, query: { search: "7788", pageSize: 20 } });
  assert.equal(result.items.length, 1);
  await assert.rejects(
    () => service.listWebOrders({ principal: principal("procurement", ["product:view"]), query: {} }),
    (error) => error.code === "FORBIDDEN"
  );
  const broken = fakeDatabase(collections, { failCount: true });
  await assert.rejects(
    () => createOrderQueryService(broken).listWebOrders({ principal: actor, query: {} }),
    (error) => error.code === "ORDER_COUNT_FAILED"
  );
});

test("web order status filters cover real payment-era and legacy order states", async () => {
  const statuses = ["pending_system", "paid", "unpaid", "partial_paid", "abnormal", "refunded"];
  const collections = {
    orders: statuses.map((status, index) => ({ _id: `order-${index}`, orderNo: `NO-${index}`, status, createdAt: new Date(2026, 6, index + 1) })),
    order_items: [], users: [], customer_accounts: []
  };
  const { db, command } = fakeDatabase(collections);
  const service = createOrderQueryService({ db, command });
  const actor = principal("customer_service", ["order:view"]);
  for (const status of statuses) {
    const result = await service.listWebOrders({ principal: actor, query: { status } });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].status, status);
  }
});

test("masked permissions re-mask dirty compatibility fields instead of trusting their names", async () => {
  const collections = {
    orders: [{
      _id: "order-1", orderNo: "NO-1", userId: "user-1", status: "pending_admin", createdAt: new Date(),
      customerPhoneMasked: "13800138000",
      shippingAddressSnapshot: {
        receiverName: "张三", receiverPhoneMasked: "13800138000", regionText: "上海市", detailAddressMasked: "浦东新区完整地址"
      }
    }],
    order_items: [], users: [{ _id: "user-1", nickname: "张三" }], customer_accounts: []
  };
  const { db, command } = fakeDatabase(collections);
  const detail = await createOrderQueryService({ db, command }).getWebOrder({
    principal: principal("customer_service", ["order:view", "customer:view_phone_masked", "customer:view_address_masked"]),
    id: "order-1"
  });
  assert.equal(detail.customer.phoneMasked, "138****8000");
  assert.equal(detail.shippingAddressMasked.receiverPhoneMasked, "138****8000");
  assert.notEqual(detail.shippingAddressMasked.detailAddressMasked, "浦东新区完整地址");
  assert.equal(JSON.stringify(detail).includes("13800138000"), false);
  assert.equal(JSON.stringify(detail).includes("浦东新区完整地址"), false);
});

test("legacy customer response strips admin fields and re-masks compatibility phone values", async () => {
  const collections = {
    orders: [{
      _id: "order-public", orderNo: "NO-PUBLIC", userOpenid: "customer-openid", status: "pending_admin", createdAt: new Date(),
      customerPhoneMasked: "13800138000", adminNote: "后台备注", adminRemark: "管理员备注", customerRemark: "内部客户备注",
      shipmentRemark: "发货内部备注", orderSource: "internal-channel", riskLevelSnapshot: "risk", idempotencyKey: "secret-key"
    }],
    order_items: [], users: [], customer_accounts: []
  };
  const { db, command } = fakeDatabase(collections);
  const result = await createOrderQueryService({ db, command }).listLegacyOrders({
    userOpenid: "customer-openid", filters: {}, page: 1, pageSize: 20
  });
  const json = JSON.stringify(result.orders[0]);
  assert.equal(result.orders[0].customerPhoneMasked, "138****8000");
  for (const secret of ["后台备注", "管理员备注", "内部客户备注", "发货内部备注", "internal-channel", "secret-key", "risk"]) {
    assert.equal(json.includes(secret), false);
  }
});

test("legacy customer response recursively removes private address payment transaction and product metadata", async () => {
  const collections = {
    orders: [{
      _id: "order-public", orderNo: "NO-PUBLIC", userOpenid: "customer-openid", status: "pending_admin", createdAt: new Date(),
      customerPhoneMasked: "13800138000", customerPhoneSnapshot: "13900139000", customerPhone: "13400134000",
      buyerPhone: "13300133000", buyerPhoneMasked: "13300133000",
      nestedCompatibility: { auditOpenid: "nested-private-openid", contactMobile: "13200132000" },
      shippingAddressSnapshot: {
        receiverName: "张三", receiverPhone: "13700137000", regionText: "上海市浦东新区", detailAddress: "世纪大道 1000 号完整地址"
      },
      internalTags: ["订单内部标签"], adminTags: ["管理员标签"], riskLevelSnapshot: "blocked", riskReason: "人工风控原因",
      paymentScreenshotUrl: "cloud://private-proof", paymentScreenshotUrls: ["cloud://private-proof-2"], paymentFileID: "private-file",
      latestPaymentRecordId: "payment-record-secret", paymentRecordId: "payment-record-secret-2", wechatPayTransactionId: "wechat-transaction-secret",
      wechatPayOutTradeNo: "merchant-trade-secret", transactionNo: "bank-transaction-secret",
      user: { phone: "13600136000", phoneNumber: "13500135000", openid: "private-openid", internalTags: ["用户内部标签"] }
    }],
    order_items: [{
      _id: "item-1", orderId: "order-public", productName: "公开商品", quantity: 1,
      internalTags: ["商品内部标签"], costPrice: 123, costPriceCents: 123, supplierName: "秘密供应商", supplierId: "supplier-secret"
    }],
    users: [], customer_accounts: []
  };
  const { db, command } = fakeDatabase(collections);
  const result = await createOrderQueryService({ db, command }).listLegacyOrders({
    userOpenid: "customer-openid", filters: {}, page: 1, pageSize: 20
  });
  const order = result.orders[0];
  const json = JSON.stringify(order);
  assert.equal(order.customerPhoneMasked, "138****8000");
  assert.equal(order.buyerPhoneMasked, "133****3000");
  assert.equal(order.shippingAddressSnapshot, undefined);
  assert.equal(order.shippingAddress.receiverPhoneMasked, "137****7000");
  assert.notEqual(order.shippingAddress.detailAddressMasked, "世纪大道 1000 号完整地址");
  for (const secret of [
    "customer-openid", "nested-private-openid", "13900139000", "13700137000", "13400134000", "13300133000", "13200132000",
    "世纪大道 1000 号完整地址", "13600136000", "13500135000", "private-openid",
    "订单内部标签", "管理员标签", "商品内部标签", "秘密供应商", "supplier-secret", "cloud://private-proof",
    "private-file", "payment-record-secret", "payment-record-secret-2", "wechat-transaction-secret", "merchant-trade-secret",
    "bank-transaction-secret", "blocked", "人工风控原因"
  ]) assert.equal(json.includes(secret), false, `legacy customer payload leaked ${secret}`);
});

test("legacy customer response keeps old masked-only address records without restoring full fields", async () => {
  const collections = {
    orders: [{
      _id: "order-masked", orderNo: "NO-MASKED", userOpenid: "customer-openid", status: "pending_admin", createdAt: new Date(),
      shippingAddressMasked: {
        receiverName: "李四", receiverPhoneMasked: "13800138000", regionText: "深圳市南山区", detailAddressMasked: "科技园科苑路**"
      }
    }],
    order_items: [], users: [], customer_accounts: []
  };
  const { db, command } = fakeDatabase(collections);
  const result = await createOrderQueryService({ db, command }).listLegacyOrders({
    userOpenid: "customer-openid", filters: {}, page: 1, pageSize: 20
  });
  assert.equal(result.orders[0].shippingAddress.receiverPhoneMasked, "138****8000");
  assert.equal(result.orders[0].shippingAddressSnapshot, undefined);
  assert.equal(JSON.stringify(result.orders[0]).includes("13800138000"), false);
});

test("detail fails closed before returning more than 500 related order items", async () => {
  const collections = {
    orders: [{ _id: "order-1", orderNo: "NO-1", status: "pending_admin", createdAt: new Date() }],
    order_items: Array.from({ length: 501 }, (_, index) => ({ _id: `item-${index}`, orderId: "order-1", productName: `商品 ${index}`, quantity: 1 })),
    users: [], customer_accounts: []
  };
  const reads = [];
  const { db, command } = fakeDatabase(collections, { onGet: (call) => { if (call.name === "order_items") reads.push(call); } });
  await assert.rejects(
    () => createOrderQueryService({ db, command }).getWebOrder({ principal: principal("customer_service", ["order:view"]), id: "order-1" }),
    (error) => error.code === "ORDER_ITEMS_LIMIT_EXCEEDED" && error.statusCode === 503
  );
  assert.deepEqual(reads.map(({ skip, limit, returned }) => ({ skip, limit, returned })), [
    { skip: 0, limit: 100, returned: 100 },
    { skip: 100, limit: 100, returned: 100 },
    { skip: 200, limit: 100, returned: 100 },
    { skip: 300, limit: 100, returned: 100 },
    { skip: 400, limit: 100, returned: 100 },
    { skip: 500, limit: 1, returned: 1 }
  ]);
});

test("legacy keyword search paginates after filtering and still matches openid or user id", async () => {
  const collections = {
    orders: [
      { _id: "newest", orderNo: "NO-NEW", userId: "user-new", userOpenid: "openid-new", status: "pending_admin", createdAt: new Date("2026-07-13T02:00:00Z") },
      { _id: "target", orderNo: "NO-TARGET", userId: "target-user-id", userOpenid: "target-openid", status: "pending_admin", createdAt: new Date("2026-07-13T01:00:00Z") }
    ],
    order_items: [],
    users: [{ _id: "user-new", nickname: "普通客户" }, { _id: "target-user-id", openid: "target-openid", nickname: "目标客户" }],
    customer_accounts: []
  };
  const { db, command } = fakeDatabase(collections);
  const result = await createOrderQueryService({ db, command }).listLegacyOrders({
    principal: principal("customer_service", ["order:view"]),
    filters: { customerKeyword: "target-openid", includeCancelled: true },
    page: 1,
    pageSize: 1
  });
  assert.deepEqual(result.orders.map((order) => order._id), ["target"]);
  assert.equal(result.hasMore, false);
});

test("order detail maps database failures to a retryable safe error instead of not found", async () => {
  const { db, command } = fakeDatabase({ orders: [], order_items: [], users: [], customer_accounts: [] }, { docError: true });
  await assert.rejects(
    () => createOrderQueryService({ db, command }).getWebOrder({ principal: principal("customer_service", ["order:view"]), id: "order-1" }),
    (error) => error.code === "ORDER_READ_FAILED" && error.statusCode === 503
  );
});
