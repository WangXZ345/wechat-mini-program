"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const handlerPath = path.join(__dirname, "handler.js");

function loadHandlerModule() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath);
}

function admin(overrides = {}) {
  return {
    _id: "admin-db-id",
    id: "admin-db-id",
    openid: "trusted-openid",
    role: "finance",
    permissions: ["payment:confirm"],
    status: "active",
    isActive: true,
    ...overrides
  };
}

function mutationResult(overrides = {}) {
  return {
    paymentId: "payment-1",
    orderNo: "SO-001",
    status: "paid",
    version: 3,
    updatedAt: new Date("2026-07-16T00:00:00.000Z"),
    affected: 1,
    reused: false,
    decision: "confirm",
    accountRecalculationPending: false,
    updatedCount: 1,
    ...overrides
  };
}

function audit({ operationId, orderId, paymentId, index, count, seedOrderId = "order-1", requestedStatus = "paid" }) {
  const decision = requestedStatus === "unpaid" ? "reject" : requestedStatus === "abnormal" ? "abnormal" : "confirm";
  const childOperationId = `${operationId}:${orderId}`;
  const businessKey = `payment_mutation:${childOperationId}:${paymentId}:${decision}`;
  return {
    rootOperationId: operationId,
    operationKind: "legacy_payment",
    operationMemberCount: count,
    operationMemberIndex: index,
    operationSeedOrderId: seedOrderId,
    requestedPaymentStatus: requestedStatus,
    sourceId: childOperationId,
    businessKey,
    decision,
    resourceId: paymentId,
    orderId,
    journal: {
      schemaVersion: 1,
      payment: { id: paymentId, orderId },
      order: { id: orderId, latestPaymentRecordId: paymentId },
      result: mutationResult({ paymentId, updatedCount: count })
    }
  };
}

function database({ logs = [], order = null, failLogs = null, failOrder = null } = {}) {
  return {
    collection(name) {
      if (name === "admin_operation_logs") {
        return {
          where(query) {
            assert.equal(query.operationKind, "legacy_payment");
            return {
              limit(value) {
                assert.equal(value, 101);
                return {
                  async get() {
                    if (failLogs) throw failLogs;
                    return { data: logs.filter((row) => row.rootOperationId === query.rootOperationId) };
                  }
                };
              }
            };
          }
        };
      }
      if (name === "orders") {
        return {
          doc(id) {
            return {
              async get() {
                if (failOrder) throw failOrder;
                return { data: order && order._id === id ? order : null };
              }
            };
          }
        };
      }
      throw new Error(`unexpected collection ${name}`);
    }
  };
}

function setup(options = {}) {
  const { createHandler } = loadHandlerModule();
  const commands = [];
  const permissions = [];
  const calls = [];
  const service = options.service || {
    async updateLegacyPayment(command) {
      commands.push(command);
      return options.result || mutationResult();
    }
  };
  const handler = createHandler({
    service,
    db: options.db || database({ order: { _id: "order-1", paymentBatchId: "", userId: "user-1", userOpenid: "owner-1" } }),
    async requirePermission(permission) {
      permissions.push(permission);
      return options.admin || admin();
    },
    randomId: options.randomId || (() => "server-generated-uuid"),
    async callFunction(name, data) {
      calls.push({ name, data });
      if (options.callFunctionError) throw options.callFunctionError;
      return options.callFunctionResult || { result: { data: { success: true, updatedCount: data.orderIds.length } } };
    }
  });
  return { handler, commands, permissions, calls };
}

test("legacy adapter preserves paid, partial aliases, abnormal, and unpaid inputs", async (t) => {
  const cases = [
    [{ orderId: "order-1", paymentStatus: "paid", paymentMethod: "bank" }, "paid"],
    [{ orderId: "order-1", paymentStatus: "partial_paid", paidAmount: "6.00" }, "partial_paid"],
    [{ orderId: "order-1", paymentStatus: "partial", paidAmountCents: 600 }, "partial"],
    [{ orderId: "order-1", isPartial: true, paidAmount: "600" }, undefined],
    [{ orderId: "order-1", paymentStatus: "abnormal" }, "abnormal"],
    [{ orderId: "order-1", paymentStatus: "unpaid", paymentRemark: "截图不清晰" }, "unpaid"]
  ];
  for (const [event, exactStatus] of cases) {
    await t.test(exactStatus || "isPartial fallback", async () => {
      const { handler, commands, permissions } = setup();
      const response = await handler({ ...event, idempotencyKey: "legacy-key-0001" });
      assert.equal(response.ok, true);
      assert.deepEqual(permissions, ["payment:confirm"]);
      assert.equal(commands.length, 1);
      assert.equal(commands[0].input.orderId, "order-1");
      assert.equal(commands[0].input.paymentStatus, exactStatus);
      assert.equal(commands[0].input.isPartial, event.isPartial);
      assert.equal(commands[0].input.paidAmount, event.paidAmount);
      assert.equal(commands[0].input.paidAmountCents, event.paidAmountCents);
      assert.equal(commands[0].input.paymentMethod, event.paymentMethod);
      assert.equal(commands[0].idempotencyKey, "legacy-key-0001");
      assert.equal(commands[0].allowMissingIdempotencyKey, false);
    });
  }
});

test("legacy adapter preserves remark fallback semantics and sends only one normalized remark", async (t) => {
  const cases = [
    { name: "non-empty remark wins", event: { remark: "  主备注  ", paymentRemark: "备用备注" }, expected: "主备注" },
    { name: "empty remark falls back", event: { remark: "", paymentRemark: "  备用备注  " }, expected: "备用备注" },
    { name: "whitespace remark falls back", event: { remark: "   ", paymentRemark: "备用备注" }, expected: "备用备注" },
    { name: "both empty stay empty", event: { remark: " ", paymentRemark: "  " }, expected: "" }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { handler, commands } = setup();
      const response = await handler({ orderId: "order-1", paymentStatus: "paid", idempotencyKey: "legacy-key-0001", ...item.event });
      assert.equal(response.ok, true);
      assert.equal(commands[0].input.remark, item.expected);
      assert.equal(Object.hasOwn(commands[0].input, "paymentRemark"), false);
    });
  }
});

test("legacy adapter forwards applyBatch false exactly so canonical processing stays on the seed order", async () => {
  const { handler, commands } = setup();
  const response = await handler({ orderId: "order-1", paymentStatus: "paid", applyBatch: false, idempotencyKey: "legacy-key-0001" });
  assert.equal(response.ok, true);
  assert.equal(commands[0].input.orderId, "order-1");
  assert.equal(commands[0].input.applyBatch, false);
});

test("legacy adapter derives actor only from the trusted permission result", async () => {
  const { handler, commands } = setup();
  const response = await handler({
    orderId: "order-1",
    paymentStatus: "paid",
    idempotencyKey: "legacy-key-0001",
    actor: admin({ _id: "forged-admin" }),
    adminId: "forged-admin",
    openid: "forged-openid",
    role: "super_admin",
    permissions: ["*"]
  });
  assert.equal(response.ok, true);
  assert.deepEqual(commands[0].actor, {
    id: "admin-db-id",
    openid: "trusted-openid",
    role: "finance",
    permissions: ["payment:confirm"],
    status: "active",
    isActive: true,
    sourceClient: "miniprogram"
  });
  assert.equal(Object.hasOwn(commands[0].input, "actor"), false);
  assert.equal(Object.hasOwn(commands[0].input, "openid"), false);
});

test("legacy adapter generates a server operation key when the caller omits one", async () => {
  const { handler, commands } = setup({ randomId: () => "random-operation-id" });
  const response = await handler({ orderId: "order-1", paymentStatus: "paid" });
  assert.equal(response.ok, true);
  assert.equal(commands[0].idempotencyKey, "legacy_payment_random-operation-id");
  assert.equal(commands[0].allowMissingIdempotencyKey, false);
});

test("legacy adapter returns exact committed batch context and refreshes purchase stats once", async () => {
  const operationId = "legacy-key-0001";
  const logs = [
    audit({ operationId, orderId: "order-2", paymentId: "payment-2", index: 1, count: 2 }),
    audit({ operationId, orderId: "order-1", paymentId: "payment-1", index: 0, count: 2 })
  ];
  const { handler, calls } = setup({
    result: mutationResult({ updatedCount: 2, affected: 2 }),
    db: database({ logs, order: { _id: "order-1", paymentBatchId: "batch-1", userId: "user-1", userOpenid: "owner-1" } })
  });
  const response = await handler({ orderId: "order-1", paymentStatus: "paid", idempotencyKey: operationId });
  assert.deepEqual(response, {
    ok: true,
    data: {
      orderId: "order-1",
      orderIds: ["order-1", "order-2"],
      updatedCount: 2,
      paymentBatchId: "batch-1",
      userId: "user-1",
      userOpenid: "owner-1",
      paymentStatus: "paid",
      purchaseStatsResult: { success: true, updatedCount: 2 }
    }
  });
  assert.deepEqual(calls, [{ name: "updateUserPurchaseStats", data: { orderIds: ["order-1", "order-2"] } }]);
});

test("legacy adapter falls back to the seed order with a warning when immutable context cannot be read", async () => {
  const { handler, calls } = setup({
    result: mutationResult({ status: "rejected", decision: "reject", affected: 1 }),
    db: database({ failLogs: new Error("context unavailable") })
  });
  const response = await handler({ orderId: "order-1", paymentStatus: "unpaid", idempotencyKey: "legacy-key-0001" });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.orderIds, ["order-1"]);
  assert.equal(response.data.orderId, "order-1");
  assert.equal(response.data.paymentStatus, "unpaid");
  assert.equal(response.data.warning, "付款状态已提交，购买统计仅按入口订单刷新");
  assert.deepEqual(calls, [{ name: "updateUserPurchaseStats", data: { orderIds: ["order-1"] } }]);
});

test("legacy adapter treats a no-op without immutable journals as a safe seed-order fallback", async () => {
  const { handler } = setup({ result: mutationResult({ affected: 0, reused: true }) });
  const response = await handler({ orderId: "order-1", paymentStatus: "paid", idempotencyKey: "legacy-key-0001" });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.orderIds, ["order-1"]);
  assert.equal(response.data.updatedCount, 1);
  assert.equal(response.data.warning, "付款状态已提交，购买统计仅按入口订单刷新");
});

test("purchase stats failure is best-effort and never changes committed payment success", async () => {
  const { handler } = setup({ callFunctionError: Object.assign(new Error("stats unavailable"), { code: "STATS_DOWN" }) });
  const response = await handler({ orderId: "order-1", paymentStatus: "abnormal", idempotencyKey: "legacy-key-0001" });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.purchaseStatsResult, { success: false, warning: "stats unavailable" });
});

test("purchase stats never runs before canonical mutation succeeds", async () => {
  const error = Object.assign(new Error("请求已被用于其他操作，请刷新后重试"), { code: "IDEMPOTENCY_KEY_CONFLICT" });
  const { handler, calls } = setup({ service: { async updateLegacyPayment() { throw error; } } });
  const response = await handler({ orderId: "order-1", paymentStatus: "paid", idempotencyKey: "legacy-key-0001" });
  assert.deepEqual(response, { ok: false, code: "IDEMPOTENCY_KEY_CONFLICT", message: "请求已被用于其他操作，请刷新后重试" });
  assert.deepEqual(calls, []);
});

test("legacy adapter keeps the failure envelope and never accepts a missing order id", async () => {
  const { handler, permissions, commands, calls } = setup();
  assert.deepEqual(await handler({ paymentStatus: "paid" }), { ok: false, code: "ORDER_ID_REQUIRED", message: "缺少订单 ID" });
  assert.deepEqual(permissions, []);
  assert.deepEqual(commands, []);
  assert.deepEqual(calls, []);
});

test("adapter source contains no duplicate account recalculation or admin audit side effect", () => {
  const source = fs.readFileSync(handlerPath, "utf8");
  assert.equal(source.includes("recalculateCustomerAccount"), false);
  assert.equal(source.includes("logAdminOperation"), false);
});

test("function-local payment, idempotency, and sync modules preserve the canonical source contract", () => {
  const pairs = [
    [path.join(__dirname, "paymentMutationService.js"), path.join(__dirname, "..", "common", "services", "paymentMutationService.js")],
    [path.join(__dirname, "common", "idempotency.js"), path.join(__dirname, "..", "common", "idempotency.js")],
    [path.join(__dirname, "common", "syncEvents.js"), path.join(__dirname, "..", "common", "syncEvents.js")]
  ];
  for (const [local, canonical] of pairs) {
    const localSource = fs.readFileSync(local);
    const canonicalSource = fs.readFileSync(canonical);
    assert.equal(crypto.createHash("sha256").update(localSource).digest("hex"), crypto.createHash("sha256").update(canonicalSource).digest("hex"));
  }
});
