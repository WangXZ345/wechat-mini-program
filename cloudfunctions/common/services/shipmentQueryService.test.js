const test = require("node:test");
const assert = require("node:assert/strict");
const { createShipmentQueryService, WEB_SHIPMENT_STATUSES } = require("./shipmentQueryService");

function commandSet() {
  const compare = (op, value) => ({
    __op: op,
    value,
    and(other) { return { __op: "and", values: [this, other] }; }
  });
  return {
    in: (values) => ({ __op: "in", values }),
    lt: (value) => compare("lt", value),
    and: (values) => ({ __op: "and", values }),
    or: (values) => ({ __op: "or", values })
  };
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  return value;
}

function matchesValue(actual, expected) {
  if (!expected || typeof expected !== "object" || !expected.__op) {
    if (Array.isArray(actual)) return actual.some((value) => comparable(value) === comparable(expected));
    return comparable(actual) === comparable(expected);
  }
  if (expected.__op === "in") {
    if (Array.isArray(actual)) return actual.some((value) => expected.values.includes(value));
    return expected.values.includes(actual);
  }
  if (expected.__op === "lt") return comparable(actual) < comparable(expected.value);
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
      async get() {
        if ((options.failCollections || []).includes(name)) throw new Error("missing index or collection");
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
        return { data: rows.slice(state.skip, state.skip + state.limit) };
      }
    };
    return {
      ...query,
      doc(id) {
        return {
          async get() {
            if ((options.failCollections || []).includes(name)) throw new Error("collection unavailable");
            return { data: (collections[name] || []).find((row) => row._id === id) || null };
          }
        };
      }
    };
  }
  return { db: { collection }, command };
}

function activeActor(role, permissions) {
  return { id: `${role}-1`, role, status: "active", isActive: true, permissions };
}

function group(overrides = {}) {
  return {
    _id: "sg-1",
    shipmentNo: "SHP-001",
    shippingStatus: "pending_shipment",
    orderIds: ["order-1"],
    orderNos: ["ORD-001"],
    orderCount: 1,
    totalItemCount: 3,
    customerName: "张三",
    customerPhoneMasked: "13800138000",
    shippingCompany: "顺丰",
    trackingNo: "SF123456789",
    trackingNoList: ["SF123456789"],
    shippingAddressSnapshot: { receiverName: "张三", receiverPhone: "13800138000", regionText: "上海市", detailAddress: "浦东新区完整地址" },
    shippingAddressMasked: { receiverName: "张三", receiverPhoneMasked: "13800138000", regionText: "上海市", detailAddressMasked: "浦东新区完整地址" },
    totalOrderAmount: 12345,
    version: 2,
    createdAt: new Date("2026-07-13T01:00:00Z"),
    updatedAt: new Date("2026-07-13T02:00:00Z"),
    openid: "secret-openid",
    userId: "secret-user",
    idempotencyKey: "secret-idempotency",
    businessKey: "secret-business",
    updatedBy: "secret-operator",
    shipmentImages: ["cloud://secret-image"],
    ...overrides
  };
}

const LIST_KEYS = [
  "addressConsistent", "carrier", "completedAt", "createdAt", "customerMasked", "id",
  "orderCount", "orderNosPreview", "shipmentNo", "shippedAt", "status", "totalItemCount",
  "trackingMasked", "updatedAt", "version"
].sort();

test("web list enforces active shipment viewers and returns a strict remasked whitelist", async () => {
  const { db, command } = fakeDatabase({ shipment_groups: [group()], orders: [] });
  const service = createShipmentQueryService({ db, command });
  const actor = activeActor("customer_service", ["shipment:view", "shipment:view_address_masked"]);
  const page = await service.listWebShipments({ actor, query: { pageSize: 20, status: "pending_shipment", search: "SHP-001" } });
  assert.deepEqual(Object.keys(page.items[0]).sort(), LIST_KEYS);
  assert.equal(page.items[0].customerMasked.includes("13800138000"), false);
  assert.match(page.items[0].customerMasked, /\*+/);
  assert.equal(page.items[0].trackingMasked.includes("SF123456789"), false);
  assert.match(page.items[0].trackingMasked, /\*+/);
  assert.equal(Object.hasOwn(page.items[0], "totalOrderAmountCents"), false);
  assert.equal(JSON.stringify(page).includes("secret-"), false);

  await assert.rejects(
    () => service.listWebShipments({ actor: activeActor("procurement", ["shipment:view"]), query: {} }),
    (error) => error.code === "FORBIDDEN" && error.statusCode === 403
  );
  await assert.rejects(
    () => service.listWebShipments({ actor: { ...actor, isActive: false }, query: {} }),
    (error) => error.code === "FORBIDDEN"
  );
  await assert.rejects(
    () => service.listWebShipments({ actor: activeActor("customer_service", []), query: {} }),
    (error) => error.code === "FORBIDDEN"
  );
  await assert.rejects(
    () => service.listWebShipments({ actor: activeActor("customer", ["shipment:view"]), query: {} }),
    (error) => error.code === "FORBIDDEN"
  );
});

test("web list accepts exactly six statuses and exposes amounts only with dashboard sales permission", async () => {
  const statuses = ["created", "pending_shipment", "shipped", "completed", "cancelled", "abnormal"];
  const { db, command } = fakeDatabase({
    shipment_groups: statuses.map((status, index) => group({ _id: `sg-${index}`, shipmentNo: `SHP-${index}`, shippingStatus: status, updatedAt: new Date(2026, 6, index + 1) })),
    orders: []
  });
  const service = createShipmentQueryService({ db, command });
  const actor = activeActor("finance", ["shipment:view", "dashboard:view_sales"]);
  assert.deepEqual(Array.from(WEB_SHIPMENT_STATUSES), statuses);
  for (const status of statuses) {
    const page = await service.listWebShipments({ actor, query: { status } });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].status, status);
    assert.equal(page.items[0].totalOrderAmountCents, 12345);
  }
  await assert.rejects(
    () => service.listWebShipments({ actor, query: { status: "approved" } }),
    (error) => error.code === "SHIPMENT_QUERY_INVALID" && error.statusCode === 400
  );
});

test("web list search matches only complete shipment, order, or tracking numbers", async () => {
  const collections = {
    shipment_groups: [
      group(),
      group({ _id: "sg-2", shipmentNo: "SHP-002", orderIds: ["order-2"], orderNos: ["ORD-002"], trackingNo: "YT987654321", trackingNoList: ["YT987654321"] })
    ],
    orders: [{ _id: "order-2", orderNo: "ORD-002", mergeShipmentId: "sg-2" }]
  };
  const { db, command } = fakeDatabase(collections);
  const service = createShipmentQueryService({ db, command });
  const actor = activeActor("customer_service", ["shipment:view"]);
  assert.deepEqual((await service.listWebShipments({ actor, query: { search: "SHP-001" } })).items.map((row) => row.id), ["sg-1"]);
  assert.deepEqual((await service.listWebShipments({ actor, query: { search: "ORD-002" } })).items.map((row) => row.id), ["sg-2"]);
  assert.deepEqual((await service.listWebShipments({ actor, query: { search: "YT987654321" } })).items.map((row) => row.id), ["sg-2"]);
  assert.equal((await service.listWebShipments({ actor, query: { search: "SHP" } })).items.length, 0);
});

test("web list uses stable updatedAt plus id cursors, caps page size, and rejects bad cursors", async () => {
  const updatedAt = new Date("2026-07-13T02:00:00Z");
  const { db, command } = fakeDatabase({
    shipment_groups: ["a", "b", "c"].map((id) => group({ _id: id, shipmentNo: `SHP-${id}`, updatedAt })),
    orders: []
  });
  const service = createShipmentQueryService({ db, command });
  const actor = activeActor("customer_service", ["shipment:view"]);
  const first = await service.listWebShipments({ actor, query: { pageSize: 2 } });
  const second = await service.listWebShipments({ actor, query: { pageSize: 2, cursor: first.nextCursor } });
  assert.deepEqual(first.items.map((row) => row.id), ["c", "b"]);
  assert.deepEqual(second.items.map((row) => row.id), ["a"]);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal((await service.listWebShipments({ actor, query: { pageSize: 999 } })).pageSize, 100);
  await assert.rejects(
    () => service.listWebShipments({ actor, query: { cursor: "not-a-cursor" } }),
    (error) => error.code === "SHIPMENT_CURSOR_INVALID" && error.statusCode === 400
  );
  await assert.rejects(
    () => service.listWebShipments({ actor, query: { cursor: first.nextCursor, status: "created" } }),
    (error) => error.code === "SHIPMENT_CURSOR_INVALID"
  );
});

test("web list maps collection and index failures to a safe 503 instead of empty success", async () => {
  const broken = fakeDatabase({ shipment_groups: [group()], orders: [] }, { failCollections: ["shipment_groups"] });
  const actor = activeActor("customer_service", ["shipment:view"]);
  await assert.rejects(
    () => createShipmentQueryService(broken).listWebShipments({ actor, query: {} }),
    (error) => error.code === "SHIPMENT_READ_FAILED" && error.statusCode === 503 && !error.message.includes("index")
  );
});

function detailCollections(overrides = {}) {
  const baseGroup = group({
    orderIds: ["order-1", "order-missing"],
    orderCount: 2,
    totalItemCount: 2,
    adminRemark: "联系 13800138000 后处理",
    cancelReason: "内部取消原因",
    createdBy: "secret-created-by",
    shippedBy: "secret-shipped-by",
    cancelledBy: "secret-cancelled-by"
  });
  return {
    shipment_groups: [baseGroup],
    orders: [{
      _id: "order-1", orderNo: "ORD-001", status: "paid", paymentStatus: "paid", shippingStatus: "pending_shipment",
      totalAmount: 12345, createdAt: new Date("2026-07-13T00:00:00Z"), openid: "order-openid", userId: "order-user"
    }],
    shipment_group_items: [{
      _id: "item-1", shipmentGroupId: "sg-1", orderId: "order-1", orderNo: "ORD-001", productId: "product-1",
      productName: "精华", brand: "品牌", category: "护肤", specification: "30ml", productionDate: "2026-01-01",
      quantity: 2, unitPrice: 6000, subtotal: 12000, tags: ["内部标签"], operatorId: "item-operator"
    }],
    shipment_logs: Array.from({ length: 101 }, (_, index) => ({
      _id: `log-${String(index).padStart(3, "0")}`,
      shipmentGroupId: "sg-1",
      action: index === 0 ? "ship" : "update",
      operatorRole: "customer_service",
      operatorOpenid: `secret-openid-${index}`,
      operatorId: `secret-operator-${index}`,
      businessKey: `secret-business-${index}`,
      idempotencyKey: `secret-key-${index}`,
      beforeData: { trackingNo: "BEFORE-SECRET" },
      afterData: { trackingNo: "AFTER-SECRET" },
      remark: "请联系 13900139000",
      createdAt: new Date(Date.UTC(2026, 6, 13, 0, index))
    })),
    ...overrides
  };
}

test("web detail joins bounded relations and applies strict role projections", async () => {
  const collections = detailCollections();
  const { db, command } = fakeDatabase(collections);
  const service = createShipmentQueryService({ db, command });
  const customerService = activeActor("customer_service", [
    "shipment:view", "shipment:update", "customer:view_address_full", "shipment:view_address_masked"
  ]);
  const detail = await service.getWebShipment({ actor: customerService, id: "sg-1" });
  assert.equal(detail.shipment.trackingNo, "SF123456789");
  assert.equal(detail.shipment.shippingAddress, undefined);
  assert.equal(detail.shipment.shippingAddressMasked.receiverPhoneMasked, "138****8000");
  assert.notEqual(detail.shipment.shippingAddressMasked.detailAddressMasked, "浦东新区完整地址");
  assert.equal(detail.shipment.totalOrderAmountCents, undefined);
  assert.equal(detail.shipment.adminRemark.includes("13800138000"), false);
  assert.equal(detail.orders[0].totalAmountCents, undefined);
  assert.deepEqual(detail.itemSummary, [{
    productId: "product-1", productName: "精华", brand: "品牌", category: "护肤", specification: "30ml",
    productionDate: "2026-01-01", totalQuantity: 2, orderNos: ["ORD-001"]
  }]);
  assert.equal(detail.logs.length, 100);
  assert.equal(detail.logsHasMore, true);
  assert.equal(detail.logs[0].remark.includes("13900139000"), false);
  assert.equal(detail.relatedDataStatus, "partial");
  assert.deepEqual(detail.warnings, ["部分关联订单缺失，数据可能不完整"]);
  for (const forbidden of [
    "order-openid", "order-user", "secret-openid", "secret-operator", "secret-business", "secret-key",
    "BEFORE-SECRET", "AFTER-SECRET", "cloud://secret-image", "内部标签", "item-operator", "6000", "12000"
  ]) assert.equal(JSON.stringify(detail).includes(forbidden), false, forbidden);

  const finance = await service.getWebShipment({
    actor: activeActor("finance", ["shipment:view", "dashboard:view_sales", "customer:view_address_full"]),
    id: "sg-1"
  });
  assert.equal(finance.shipment.trackingNo, undefined);
  assert.match(finance.shipment.trackingMasked, /\*+/);
  assert.equal(finance.shipment.shippingAddress, undefined);
  assert.equal(finance.shipment.totalOrderAmountCents, 12345);
  assert.equal(finance.orders[0].totalAmountCents, 12345);
  assert.equal(finance.shipment.adminRemark, undefined);

  const superAdmin = await service.getWebShipment({
    actor: activeActor("super_admin", ["shipment:view", "shipment:view_address_full", "dashboard:view_sales"]),
    id: "sg-1"
  });
  assert.equal(superAdmin.shipment.trackingNo, "SF123456789");
  assert.equal(superAdmin.shipment.shippingAddress.detailAddress, "浦东新区完整地址");
  assert.equal(superAdmin.shipment.shippingAddress.receiverPhone, undefined);
  assert.equal(superAdmin.shipment.shippingAddress.receiverPhoneMasked, "138****8000");
});

test("web detail scrubs separated, prefixed, full-width, and zero-width phone sequences without damaging normal text", async () => {
  const zeroWidthPhone = "1\u200B3\u200B9\u200B0\u200B0\u200B1\u200B3\u200B9\u200B0\u200B0\u200B0";
  const collections = detailCollections({
    shipment_groups: [group({
      orderIds: ["order-1"],
      adminRemark: "联系 +86 138-0013-8000，普通备注保持不变",
      cancelReason: "取消联系：＋８６ １３８ ００１３ ８０００；取消说明保持"
    })],
    shipment_logs: [{
      _id: "log-variant",
      shipmentGroupId: "sg-1",
      action: "cancel",
      operatorRole: "customer_service",
      remark: `日志联系 ${zeroWidthPhone}，日志说明保持`,
      createdAt: new Date("2026-07-13T03:00:00Z")
    }]
  });
  const { db, command } = fakeDatabase(collections);
  const detail = await createShipmentQueryService({ db, command }).getWebShipment({
    actor: activeActor("customer_service", ["shipment:view", "shipment:update", "shipment:cancel"]),
    id: "sg-1"
  });
  assert.equal(detail.shipment.adminRemark, "联系 138****8000，普通备注保持不变");
  assert.equal(detail.shipment.cancelReason, "取消联系：138****8000；取消说明保持");
  assert.equal(detail.logs[0].remark, "日志联系 139****9000，日志说明保持");
});

test("web detail fails closed above order and item limits", async () => {
  const actor = activeActor("customer_service", ["shipment:view"]);
  const tooManyOrders = detailCollections({
    shipment_groups: [group({ orderIds: Array.from({ length: 101 }, (_, index) => `order-${index}`) })],
    orders: [], shipment_group_items: [], shipment_logs: []
  });
  await assert.rejects(
    () => createShipmentQueryService(fakeDatabase(tooManyOrders)).getWebShipment({ actor, id: "sg-1" }),
    (error) => error.code === "SHIPMENT_RELATED_ROWS_LIMIT_EXCEEDED" && error.statusCode === 503
  );

  const tooManyItems = detailCollections({
    shipment_group_items: Array.from({ length: 501 }, (_, index) => ({
      _id: `item-${index}`, shipmentGroupId: "sg-1", orderId: "order-1", productId: `product-${index}`, productName: `商品 ${index}`, quantity: 1
    })),
    shipment_logs: []
  });
  await assert.rejects(
    () => createShipmentQueryService(fakeDatabase(tooManyItems)).getWebShipment({ actor, id: "sg-1" }),
    (error) => error.code === "SHIPMENT_RELATED_ROWS_LIMIT_EXCEEDED" && error.statusCode === 503
  );
});

test("web detail distinguishes not found from safe relation read failures", async () => {
  const actor = activeActor("customer_service", ["shipment:view"]);
  const healthy = fakeDatabase(detailCollections());
  await assert.rejects(
    () => createShipmentQueryService(healthy).getWebShipment({ actor, id: "missing" }),
    (error) => error.code === "SHIPMENT_NOT_FOUND" && error.statusCode === 404
  );
  const broken = fakeDatabase(detailCollections(), { failCollections: ["shipment_logs"] });
  await assert.rejects(
    () => createShipmentQueryService(broken).getWebShipment({ actor, id: "sg-1" }),
    (error) => error.code === "SHIPMENT_READ_FAILED" && error.statusCode === 503 && !error.message.includes("collection")
  );
});

test("legacy projectors preserve mini-program list and detail response shapes", async () => {
  const collections = detailCollections({ shipment_logs: detailCollections().shipment_logs.slice(0, 2) });
  const { db, command } = fakeDatabase(collections);
  const service = createShipmentQueryService({ db, command });
  const actor = activeActor("customer_service", ["shipment:view", "shipment:view_address_masked"]);
  const list = await service.listLegacyShipmentGroups({
    actor,
    query: { page: 1, pageSize: 20, status: "pending_shipment", keyword: "SHP-001" }
  });
  assert.deepEqual(Object.keys(list).sort(), ["groups", "hasMore", "page", "pageSize"].sort());
  assert.equal(list.groups[0].shipmentNo, "SHP-001");
  assert.equal(list.groups[0].shippingAddressSnapshot, null);
  assert.ok(list.groups[0].shippingAddress);

  const detail = await service.getLegacyShipmentGroupDetail({ actor, id: "sg-1" });
  assert.ok(detail.shipmentGroup);
  assert.ok(Array.isArray(detail.orders));
  assert.ok(Array.isArray(detail.items));
  assert.ok(Array.isArray(detail.itemSummary));
  assert.ok(Array.isArray(detail.logs));
  assert.equal(detail.orders[0].orderId, "order-1");
  assert.equal(detail.orders[0].totalAmount, 12345);
  assert.equal(detail.itemSummary[0].totalQuantity, 2);
  assert.deepEqual(detail.itemSummary[0].orderNos, ["ORD-001"]);
});

test("legacy shipment query masks the address for procurement without a full-address permission", async () => {
  const collections = detailCollections({
    shipment_groups: [group({ unexpectedPrivateField: "must-not-leak" })]
  });
  const { db, command } = fakeDatabase(collections);
  const service = createShipmentQueryService({ db, command });
  const actor = activeActor("procurement", ["shipment:view", "shipment:view_address_masked"]);

  const list = await service.listLegacyShipmentGroups({
    actor,
    query: { page: 1, pageSize: 20, status: "pending_shipment", keyword: "SHP-001" }
  });

  assert.equal(list.groups[0].shippingAddressSnapshot, null);
  assert.ok(list.groups[0].shippingAddress);
  assert.equal(Object.hasOwn(list.groups[0].shippingAddress, "detailAddress"), false);
  assert.equal(Object.hasOwn(list.groups[0].shippingAddress, "detailAddressMasked"), true);
  assert.equal(list.groups[0].shippingAddress.receiverPhoneMasked, "138****8000");
  assert.equal(list.groups[0].shippingAddress.detailAddressMasked.includes("完整地址"), false);
  assert.deepEqual(list.groups[0].shippingAddressMasked, list.groups[0].shippingAddress);
  assert.equal(list.groups[0].customerPhoneMasked, "138****8000");
  for (const field of ["openid", "userId", "idempotencyKey", "businessKey", "updatedBy"]) {
    assert.equal(Object.hasOwn(list.groups[0], field), false, field);
  }
  assert.equal(Object.hasOwn(list.groups[0], "unexpectedPrivateField"), false);
});

test("legacy shipment query preserves the full-address contract with explicit permission", async () => {
  const source = group();
  const { db, command } = fakeDatabase(detailCollections({ shipment_groups: [source] }));
  const service = createShipmentQueryService({ db, command });
  const actor = activeActor("procurement", ["shipment:view", "shipment:view_address_full"]);

  const list = await service.listLegacyShipmentGroups({ actor, query: { page: 1, pageSize: 20 } });

  assert.deepEqual(list.groups[0].shippingAddressSnapshot, source.shippingAddressSnapshot);
  assert.deepEqual(list.groups[0].shippingAddress, source.shippingAddressSnapshot);
  assert.equal(list.groups[0].shippingAddress.receiverPhone, "13800138000");
  for (const field of ["openid", "userId", "idempotencyKey", "businessKey", "updatedBy"]) {
    assert.equal(Object.hasOwn(list.groups[0], field), false, field);
  }
});

module.exports = { activeActor, fakeDatabase, group };
