"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BATCH_LIMITS,
  BatchContractError,
  normalizeBatchRequest
} = require("../lib/batchContract");
const { executeBatch, fingerprintBatchItem } = require("../lib/batchExecutor");

function request(items, overrides = {}) {
  return {
    requestId: "request-001",
    batchId: "batch-001",
    items,
    ...overrides
  };
}

function item(id, overrides = {}) {
  return {
    id,
    key: `item-key-${id}`,
    version: 1,
    payload: { selected: true },
    ...overrides
  };
}

test("normalizes a bounded batch request without retaining caller object references", () => {
  const source = request([item("one")]);
  const normalized = normalizeBatchRequest(source);
  source.items[0].payload.selected = false;

  assert.deepEqual(normalized, request([item("one")]));
  assert.notEqual(normalized, source);
  assert.notEqual(normalized.items[0], source.items[0]);
});

test("rejects item count and serialized payload byte limits before any item runs", () => {
  assert.throws(
    () => normalizeBatchRequest(request(Array.from({ length: BATCH_LIMITS.maxItems + 1 }, (_, index) => item(String(index))))),
    (error) => error instanceof BatchContractError && error.code === "BATCH_ITEM_LIMIT_EXCEEDED"
  );
  assert.throws(
    () => normalizeBatchRequest(request([item("large", { payload: { value: "x".repeat(BATCH_LIMITS.maxRequestBytes) } })])),
    (error) => error instanceof BatchContractError && error.code === "BATCH_PAYLOAD_LIMIT_EXCEEDED"
  );
});

test("rejects duplicate ids or keys and unsafe id, key, version, or credential fields", () => {
  const invalidCases = [
    [request([item("same"), item("same", { key: "item-key-other" })]), "BATCH_DUPLICATE_ITEM_ID"],
    [request([item("one"), item("two", { key: "item-key-one" })]), "BATCH_DUPLICATE_ITEM_KEY"],
    [request([item("bad id")]), "BATCH_ITEM_ID_INVALID"],
    [request([item("one", { key: "bad key" })]), "BATCH_ITEM_KEY_INVALID"],
    [request([item("one", { version: -1 })]), "BATCH_ITEM_VERSION_INVALID"],
    [request([item("one", { payload: { authorization: "Bearer private" } })]), "BATCH_SENSITIVE_FIELD_FORBIDDEN"]
  ];

  for (const [input, code] of invalidCases) {
    assert.throws(
      () => normalizeBatchRequest(input),
      (error) => error instanceof BatchContractError && error.code === code,
      code
    );
  }
});

test("rejects prototype mutation keys without polluting cloned payload prototypes", () => {
  const protoPayload = JSON.parse('{"__proto__":{"polluted":"yes"}}');
  for (const payload of [
    protoPayload,
    { prototype: { polluted: "yes" } },
    { constructor: { prototype: { polluted: "yes" } } }
  ]) {
    assert.throws(
      () => normalizeBatchRequest(request([item("one", { payload })])),
      (error) => error instanceof BatchContractError && error.code === "BATCH_UNSAFE_PAYLOAD_KEY"
    );
  }
  assert.equal(Object.prototype.polluted, undefined);

  const legal = normalizeBatchRequest(request([item("safe", { payload: { nested: { value: 1 } } })]));
  assert.deepEqual(legal.items[0].payload, { nested: { value: 1 } });
  assert.equal(Object.getPrototypeOf(legal.items[0].payload), Object.prototype);
  assert.equal(Object.getPrototypeOf(legal.items[0].payload.nested), Object.prototype);
});

test("fails closed on payload depth, node, and single-string limits", () => {
  let deep = { value: true };
  for (let index = 0; index <= BATCH_LIMITS.maxPayloadDepth; index += 1) deep = { nested: deep };
  assert.throws(
    () => normalizeBatchRequest(request([item("deep", { payload: deep })])),
    (error) => error instanceof BatchContractError && error.code === "BATCH_PAYLOAD_DEPTH_EXCEEDED"
  );

  const manyNodes = { values: Array.from({ length: BATCH_LIMITS.maxPayloadNodes + 1 }, () => null) };
  assert.throws(
    () => normalizeBatchRequest(request([item("nodes", { payload: manyNodes })])),
    (error) => error instanceof BatchContractError && error.code === "BATCH_PAYLOAD_NODE_LIMIT_EXCEEDED"
  );

  assert.throws(
    () => normalizeBatchRequest(request([item("string", { payload: { value: "x".repeat(BATCH_LIMITS.maxStringBytes + 1) } })])),
    (error) => error instanceof BatchContractError && error.code === "BATCH_STRING_LIMIT_EXCEEDED"
  );
});

test("stops traversing as soon as the incremental request byte budget is exceeded", () => {
  let lateFieldRead = false;
  const payload = { first: "x".repeat(BATCH_LIMITS.maxRequestBytes) };
  Object.defineProperty(payload, "late", {
    enumerable: true,
    get() {
      lateFieldRead = true;
      throw new Error("late field must not be read");
    }
  });

  assert.throws(
    () => normalizeBatchRequest(request([item("large", { payload })])),
    (error) => error instanceof BatchContractError && error.code === "BATCH_PAYLOAD_LIMIT_EXCEEDED"
  );
  assert.equal(lateFieldRead, false);

  let escapedLateFieldRead = false;
  const escapedPayload = { first: Array.from({ length: 5 }, () => "\"".repeat(50_000)) };
  Object.defineProperty(escapedPayload, "late", {
    enumerable: true,
    get() {
      escapedLateFieldRead = true;
      throw new Error("escaped late field must not be read");
    }
  });
  assert.throws(
    () => normalizeBatchRequest(request([item("escaped", { payload: escapedPayload })])),
    (error) => error instanceof BatchContractError && error.code === "BATCH_PAYLOAD_LIMIT_EXCEEDED"
  );
  assert.equal(escapedLateFieldRead, false);
});

test("produces deterministic all-success counts and passes explicit correlation contexts", async () => {
  const contexts = [];
  const result = await executeBatch(request([item("one"), item("two")]), {
    async handleItem(input, context) {
      contexts.push({ input, context });
      return { status: "success", code: "OK", message: "处理成功" };
    }
  });

  assert.equal(result.overallStatus, "success");
  assert.deepEqual(result.counts, {
    total: 2,
    success: 2,
    skipped: 0,
    validation: 0,
    not_allowed: 0,
    conflict: 0,
    permission: 0,
    business_error: 0,
    failed: 0,
    retryable: 0
  });
  assert.deepEqual(result.items.map((entry) => entry.id), ["one", "two"]);
  assert.deepEqual(contexts[0].context, {
    requestId: "request-001",
    batchId: "batch-001",
    itemId: "one",
    itemKey: "item-key-one",
    expectedVersion: 1,
    operationLogContext: { requestId: "request-001", batchId: "batch-001", itemKey: "item-key-one" },
    syncEventContext: { requestId: "request-001", batchId: "batch-001", itemKey: "item-key-one" },
    signal: contexts[0].context.signal
  });
  assert.equal(contexts[0].input.payload.selected, true);
});

test("classifies mixed handler outcomes without echoing input payloads", async () => {
  const outcomes = {
    one: { status: "success", code: "OK", message: "完成" },
    two: { status: "skipped", code: "UNCHANGED", message: "无需处理", retryable: false },
    three: { status: "validation", code: "INVALID_ROW", message: "数据无效", retryable: false },
    four: { status: "not_allowed", code: "STATE_BLOCKED", message: "当前状态不可处理" },
    five: { status: "permission", code: "FORBIDDEN", message: "无权限" },
    six: { status: "business_error", code: "DEPENDENCY_BUSY", message: "服务繁忙", retryable: true }
  };
  const result = await executeBatch(request(Object.keys(outcomes).map((id) => item(id, {
    payload: { harmless: `private-${id}` }
  }))), {
    async handleItem(input) { return outcomes[input.id]; }
  });

  assert.equal(result.overallStatus, "partial");
  assert.deepEqual(result.counts, {
    total: 6,
    success: 1,
    skipped: 1,
    validation: 1,
    not_allowed: 1,
    conflict: 0,
    permission: 1,
    business_error: 1,
    failed: 4,
    retryable: 1
  });
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("produces deterministic all-failed output for explicit conflicts and permissions", async () => {
  const result = await executeBatch(request([item("one"), item("two")]), {
    async handleItem(input) {
      return input.id === "one"
        ? { status: "conflict", code: "DATA_VERSION_CONFLICT", message: "数据已更新", retryable: true }
        : { status: "permission", code: "FORBIDDEN", message: "无权限", retryable: false };
    }
  });

  assert.equal(result.overallStatus, "failed");
  assert.equal(result.counts.conflict, 1);
  assert.equal(result.counts.permission, 1);
  assert.equal(result.counts.failed, 2);
  assert.equal(result.counts.retryable, 1);
});

test("isolates unexpected per-item exceptions and continues later items", async () => {
  const calls = [];
  const result = await executeBatch(request([item("one"), item("two"), item("three")]), {
    async handleItem(input) {
      calls.push(input.id);
      if (input.id === "two") throw new Error("database password leaked here");
      return { status: "success", code: "OK", message: "完成" };
    }
  });

  assert.deepEqual(calls, ["one", "two", "three"]);
  assert.deepEqual(result.items.map((entry) => entry.status), ["success", "business_error", "success"]);
  assert.equal(result.items[1].code, "BATCH_ITEM_FAILED");
  assert.equal(result.items[1].retryable, false);
  assert.equal(JSON.stringify(result).includes("password"), false);
});

test("times out a slow item without automatic retry and continues", async () => {
  const result = await executeBatch(request([item("slow"), item("fast")]), {
    async handleItem(input, context) {
      if (input.id === "slow") {
        await new Promise((resolve) => {
          context.signal.addEventListener("abort", resolve, { once: true });
        });
      }
      return { status: "success", code: "OK", message: "完成" };
    }
  }, { itemTimeoutMs: 10 });

  assert.deepEqual(result.items.map((entry) => entry.status), ["business_error", "success"]);
  assert.equal(result.items[0].code, "BATCH_ITEM_TIMEOUT");
  assert.equal(result.items[0].retryable, false);
});

test("enforces configured chunk order and per-chunk concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const started = [];
  const releaseFirstChunk = [];
  const execution = executeBatch(request([item("1"), item("2"), item("3"), item("4")]), {
    async handleItem(input) {
      started.push(input.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (["1", "2"].includes(input.id)) {
        await new Promise((resolve) => releaseFirstChunk.push(resolve));
      }
      active -= 1;
      return { status: "success", code: "OK", message: "完成" };
    }
  }, { chunkSize: 2, concurrency: 2, itemTimeoutMs: 1000 });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["1", "2"]);
  releaseFirstChunk.splice(0).forEach((resolve) => resolve());
  const result = await execution;

  assert.equal(maxActive, 2);
  assert.deepEqual(started, ["1", "2", "3", "4"]);
  assert.deepEqual(result.items.map((entry) => entry.id), ["1", "2", "3", "4"]);
});

test("reuses trusted completed successes on duplicate submission and executes only retry items", async () => {
  const calls = [];
  const stored = new Map([
    ["batch-001:item-key-one", { id: "one", key: "item-key-one", status: "success", code: "OK", message: "此前已完成", retryable: false, fingerprint: fingerprintBatchItem(item("one")) }]
  ]);
  const result = await executeBatch(request([item("one"), item("two")]), {
    async getCompletedResult(context) { return stored.get(`${context.batchId}:${context.itemKey}`); },
    async saveItemResult(entry, context) { stored.set(`${context.batchId}:${context.itemKey}`, entry); },
    async handleItem(input) {
      calls.push(input.id);
      return { status: "success", code: "OK", message: "本次完成" };
    }
  });

  assert.deepEqual(calls, ["two"]);
  assert.equal(result.items[0].reused, true);
  assert.equal(result.items[0].message, "处理成功");
  assert.equal(stored.get("batch-001:item-key-two").status, "success");
  assert.equal(result.counts.success, 2);
});

test("never treats a previous failure as completed success during retry", async () => {
  const calls = [];
  const result = await executeBatch(request([item("retry")]), {
    async getCompletedResult() {
      return { id: "retry", key: "item-key-retry", status: "conflict", code: "DATA_VERSION_CONFLICT", message: "旧失败", retryable: true };
    },
    async handleItem(input) {
      calls.push(input.id);
      return { status: "success", code: "OK", message: "重试成功" };
    }
  });

  assert.deepEqual(calls, ["retry"]);
  assert.equal(result.items[0].status, "success");
  assert.equal(result.items[0].reused, false);
});

test("fingerprints id, key, version, and payload before reusing a completed success", async () => {
  const receipts = new Map();
  const calls = [];
  const fingerprints = [];
  const dependencies = {
    async getCompletedResult(context) {
      fingerprints.push(context.itemFingerprint);
      return receipts.get(`${context.batchId}:${context.itemKey}`);
    },
    async saveItemResult(receipt, context) {
      assert.equal(receipt.fingerprint, context.itemFingerprint);
      assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
      receipts.set(`${context.batchId}:${context.itemKey}`, receipt);
    },
    async handleItem(input, context) {
      calls.push(`${input.version}:${input.payload.selected}`);
      assert.equal(Object.hasOwn(context, "itemFingerprint"), false);
      return { status: "success", code: "OK", message: "处理成功" };
    }
  };

  const original = request([item("one")]);
  const first = await executeBatch(original, dependencies);
  const replay = await executeBatch(original, dependencies);
  const changedVersion = await executeBatch(request([item("one", { version: 2 })]), dependencies);
  const changedPayload = await executeBatch(request([item("one", { payload: { selected: false } })]), dependencies);

  assert.deepEqual(calls, ["1:true"]);
  assert.equal(first.items[0].reused, false);
  assert.equal(replay.items[0].reused, true);
  for (const changed of [changedVersion, changedPayload]) {
    assert.equal(changed.items[0].status, "conflict");
    assert.equal(changed.items[0].code, "BATCH_ITEM_FINGERPRINT_CONFLICT");
    assert.equal(changed.items[0].retryable, false);
  }
  assert.notEqual(fingerprints[0], fingerprints[2]);
  assert.notEqual(fingerprints[0], fingerprints[3]);
  assert.equal(JSON.stringify(replay).includes("selected"), false);
});

test("keeps a successful handler result non-retryable when receipt persistence fails", async () => {
  let handlerCalls = 0;
  let saveCalls = 0;
  const result = await executeBatch(request([item("one")]), {
    async handleItem() {
      handlerCalls += 1;
      return { status: "success", code: "OK", message: "处理成功" };
    },
    async saveItemResult() {
      saveCalls += 1;
      throw new Error("receipt store unavailable");
    }
  });

  assert.equal(handlerCalls, 1);
  assert.equal(saveCalls, 1);
  assert.equal(result.items[0].status, "success");
  assert.equal(result.items[0].retryable, false);
  assert.equal(result.counts.success, 1);
  assert.equal(result.counts.retryable, 0);
});

test("bounds completed-result lookup by the batch deadline and skips work not yet started", async () => {
  let handlerCalls = 0;
  const startedAt = Date.now();
  const result = await executeBatch(request([item("one"), item("two")]), {
    async getCompletedResult() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return undefined;
    },
    async handleItem() {
      handlerCalls += 1;
      return { status: "success", code: "OK", message: "处理成功" };
    }
  }, { concurrency: 1, chunkSize: 2, batchDeadlineMs: 5 });

  assert.ok(Date.now() - startedAt < 50);
  assert.equal(handlerCalls, 0);
  assert.deepEqual(result.items.map((entry) => [entry.status, entry.code, entry.retryable]), [
    ["business_error", "BATCH_DEADLINE_EXCEEDED", false],
    ["skipped", "BATCH_DEADLINE_EXCEEDED", true]
  ]);
});

test("never starts a handler at or after the injected batch deadline and densely skips the remainder", async () => {
  let currentTime = 1_000;
  const startTimes = [];
  const items = Array.from({ length: BATCH_LIMITS.maxItems }, (_, index) => item(String(index)));
  const result = await executeBatch(request(items), {
    now: () => currentTime,
    async handleItem() {
      startTimes.push(currentTime);
      currentTime += 4;
      return { status: "success", code: "OK", message: "处理成功" };
    }
  }, { concurrency: 5, chunkSize: 20, itemTimeoutMs: 1000, batchDeadlineMs: 15 });

  assert.deepEqual(startTimes, [1_000, 1_004, 1_008, 1_012]);
  assert.equal(startTimes.every((startedAt) => startedAt < 1_015), true);
  assert.equal(result.items.length, BATCH_LIMITS.maxItems);
  for (let index = 0; index < result.items.length; index += 1) {
    assert.equal(Object.prototype.hasOwnProperty.call(result.items, index), true);
  }
  assert.deepEqual(result.items.slice(4).map((entry) => entry.id), items.slice(4).map((entry) => entry.id));
  assert.equal(result.items.slice(4).every((entry) => entry.status === "skipped" && entry.code === "BATCH_DEADLINE_EXCEEDED" && entry.retryable), true);
  assert.equal(result.counts.success, 4);
  assert.equal(result.counts.skipped, 46);
  assert.ok(BATCH_LIMITS.defaultBatchDeadlineMs < 60_000);
  assert.ok(BATCH_LIMITS.maxBatchDeadlineMs < 60_000);
});

test("fails retry closed by status and explicit transient or refresh-safe codes", async () => {
  const outcomes = [
    { status: "validation", code: "INVALID_ROW", retryable: true },
    { status: "not_allowed", code: "STATE_BLOCKED", retryable: true },
    { status: "permission", code: "FORBIDDEN", retryable: true },
    { status: "skipped", code: "UNCHANGED", retryable: true },
    { status: "conflict", code: "IDEMPOTENCY_KEY_CONFLICT", retryable: true },
    { status: "conflict", code: "DATA_VERSION_CONFLICT", retryable: true },
    { status: "business_error", code: "DEPENDENCY_BUSY", retryable: true },
    { status: "business_error", code: "BATCH_ITEM_FAILED", retryable: true }
  ];
  const result = await executeBatch(request(outcomes.map((_, index) => item(String(index)))), {
    async handleItem(input) {
      return { ...outcomes[Number(input.id)], message: "固定结果" };
    }
  });

  assert.deepEqual(result.items.map((entry) => entry.retryable), [false, false, false, false, false, true, true, false]);
  assert.equal(result.counts.retryable, 2);
});

test("deep-freezes handler input and correlation context while retaining captured identity", async () => {
  const saved = [];
  const result = await executeBatch(request([item("one"), item("two")]), {
    async saveItemResult(receipt, context) {
      saved.push({ receipt, context });
    },
    async handleItem(input, context) {
      if (input.id === "two") {
        input.id = "forged-two";
        return { status: "success", code: "OK", message: "不应到达" };
      }
      for (const mutation of [
        () => { input.id = "forged-one"; },
        () => { input.payload.selected = false; },
        () => { context.itemKey = "forged-key"; },
        () => { context.operationLogContext.itemKey = "forged-log-key"; },
        () => { context.syncEventContext.itemKey = "forged-event-key"; }
      ]) {
        assert.throws(mutation, TypeError);
      }
      return { status: "success", code: "OK", message: "处理成功" };
    }
  });

  assert.deepEqual(result.items.map((entry) => [entry.id, entry.key, entry.version, entry.status]), [
    ["one", "item-key-one", 1, "success"],
    ["two", "item-key-two", 1, "business_error"]
  ]);
  assert.deepEqual(saved.map(({ receipt, context }) => [receipt.id, receipt.key, receipt.version, context.itemId, context.itemKey]), [
    ["one", "item-key-one", 1, "one", "item-key-one"],
    ["two", "item-key-two", 1, "two", "item-key-two"]
  ]);
  assert.equal(JSON.stringify(result).includes("forged"), false);
});

test("publishes only strict codes and fixed messages without sensitive handler text", async () => {
  const outcomes = [
    { status: "success", code: "bad code", message: "手机号 13800138000" },
    { status: "validation", code: "INVALID_ROW", message: "地址 上海市测试路 88 号" },
    { status: "business_error", code: "DEPENDENCY_BUSY", message: "openid=o-private paymentProof=file-private", retryable: true },
    { status: "skipped", code: "UNCHANGED", message: "idempotency-key=private-key" }
  ];
  const result = await executeBatch(request(outcomes.map((_, index) => item(String(index)))), {
    async handleItem(input) { return outcomes[Number(input.id)]; }
  });
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.items.map((entry) => [entry.code, entry.message]), [
    ["OK", "处理成功"],
    ["INVALID_ROW", "数据校验失败"],
    ["DEPENDENCY_BUSY", "服务暂时不可用"],
    ["UNCHANGED", "无需处理"]
  ]);
  assert.equal(result.items.every((entry) => /^[A-Z][A-Z0-9_]{1,63}$/.test(entry.code)), true);
  for (const sensitive of ["13800138000", "上海市测试路", "o-private", "file-private", "private-key", "paymentProof", "idempotency-key"]) {
    assert.equal(serialized.includes(sensitive), false, sensitive);
  }
});

test("never retries a started handler that can commit after timeout or deadline", async () => {
  for (const scenario of [
    { options: { itemTimeoutMs: 5, batchDeadlineMs: 100 }, code: "BATCH_ITEM_TIMEOUT" },
    { options: { itemTimeoutMs: 100, batchDeadlineMs: 5 }, code: "BATCH_DEADLINE_EXCEEDED" }
  ]) {
    let lateSideEffects = 0;
    const result = await executeBatch(request([item("late")]), {
      async handleItem() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lateSideEffects += 1;
        return { status: "success", code: "OK", message: "晚到成功" };
      }
    }, scenario.options);

    assert.equal(result.items[0].status, "business_error");
    assert.equal(result.items[0].code, scenario.code);
    assert.equal(result.items[0].retryable, false);
    assert.equal(result.counts.retryable, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(lateSideEffects, 1);
  }
});

test("maps identifier-like handler codes through a status-specific public allowlist", async () => {
  const unsafeCodes = [
    "OPENID_OABC123",
    `F${"A".repeat(63)}`,
    "PHONE_13800138000",
    "ADDRESS_SHANGHAI_88",
    "PAYMENT_PROOF_FILE_PRIVATE",
    "TOKEN_SUPERSECRET",
    "IDEMPOTENCY_KEY_PRIVATE"
  ];
  const outcomes = [
    { status: "success", code: unsafeCodes[0] },
    { status: "conflict", code: unsafeCodes[1] },
    { status: "validation", code: unsafeCodes[2] },
    { status: "not_allowed", code: unsafeCodes[3] },
    { status: "business_error", code: unsafeCodes[4], retryable: true },
    { status: "permission", code: unsafeCodes[5] },
    { status: "skipped", code: unsafeCodes[6], retryable: true }
  ];
  const result = await executeBatch(request(outcomes.map((_, index) => item(String(index)))), {
    async handleItem(input) { return { ...outcomes[Number(input.id)], message: "不公开" }; }
  });
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.items.map((entry) => entry.code), [
    "OK",
    "CONFLICT",
    "VALIDATION_ERROR",
    "NOT_ALLOWED",
    "BATCH_ITEM_FAILED",
    "FORBIDDEN",
    "SKIPPED"
  ]);
  for (const unsafe of unsafeCodes) assert.equal(serialized.includes(unsafe), false, unsafe);
});

test("rejects sparse or undefined array entries before fingerprint lookup or reuse", async () => {
  const emptyArrayItem = item("one", { payload: { values: [] } });
  const stored = {
    id: emptyArrayItem.id,
    key: emptyArrayItem.key,
    version: emptyArrayItem.version,
    status: "success",
    code: "OK",
    message: "处理成功",
    retryable: false,
    fingerprint: fingerprintBatchItem(emptyArrayItem)
  };
  let lookups = 0;
  const sparseValues = Array(1);

  await assert.rejects(
    () => executeBatch(request([item("one", { payload: { values: sparseValues } })]), {
      async getCompletedResult() { lookups += 1; return stored; },
      async handleItem() { throw new Error("must not execute"); }
    }),
    (error) => error instanceof BatchContractError && error.code === "BATCH_SPARSE_ARRAY_FORBIDDEN"
  );
  assert.throws(
    () => normalizeBatchRequest(request([item("one", { payload: { values: [undefined] } })])),
    (error) => error instanceof BatchContractError && error.code === "BATCH_PAYLOAD_INVALID"
  );
  assert.throws(
    () => fingerprintBatchItem(item("one", { payload: { values: sparseValues } })),
    (error) => error instanceof BatchContractError && error.code === "BATCH_SPARSE_ARRAY_FORBIDDEN"
  );
  assert.equal(lookups, 0);
});

test("rejects sparse, undefined, or null top-level items before identity access", async () => {
  const trailingHole = [item("one")];
  trailingHole.length = 2;
  const leadingHole = Array(2);
  leadingHole[1] = item("two");
  const invalidCases = [
    [Array(1), "BATCH_SPARSE_ARRAY_FORBIDDEN"],
    [trailingHole, "BATCH_SPARSE_ARRAY_FORBIDDEN"],
    [leadingHole, "BATCH_SPARSE_ARRAY_FORBIDDEN"],
    [[undefined], "BATCH_ITEM_INVALID"],
    [[null], "BATCH_ITEM_INVALID"]
  ];
  let handlerCalls = 0;

  for (const [items, code] of invalidCases) {
    await assert.rejects(
      () => executeBatch(request(items), {
        async handleItem() {
          handlerCalls += 1;
          return { status: "success", code: "OK", message: "不应执行" };
        }
      }),
      (error) => error instanceof BatchContractError && error.code === code,
      code
    );
  }
  assert.equal(handlerCalls, 0);
});

test("allows retry only for deadline-skipped items, never timeout or legacy skipped codes", async () => {
  const outcomes = [
    { status: "skipped", code: "BATCH_DEADLINE_EXCEEDED", retryable: true },
    { status: "skipped", code: "BATCH_ITEM_TIMEOUT", retryable: true },
    { status: "skipped", code: "SKIPPED", retryable: true },
    { status: "skipped", code: "LEGACY_RETRY", retryable: true }
  ];
  const result = await executeBatch(request(outcomes.map((_, index) => item(String(index)))), {
    async handleItem(input) { return { ...outcomes[Number(input.id)], message: "不公开" }; }
  });

  assert.deepEqual(result.items.map((entry) => [entry.code, entry.retryable]), [
    ["BATCH_DEADLINE_EXCEEDED", true],
    ["SKIPPED", false],
    ["SKIPPED", false],
    ["SKIPPED", false]
  ]);
  assert.equal(result.counts.retryable, 1);
});

test("keeps fingerprint only in receipt contexts, never the canonical handler context", async () => {
  let handlerContext;
  let lookupContext;
  let saveContext;
  const result = await executeBatch(request([item("one")]), {
    async getCompletedResult(context) {
      lookupContext = context;
      return undefined;
    },
    async saveItemResult(_receipt, context) {
      saveContext = context;
    },
    async handleItem(_input, context) {
      handlerContext = context;
      return { status: "success", code: "OK", message: "处理成功" };
    }
  });

  assert.equal(result.items[0].status, "success");
  assert.equal(Object.hasOwn(handlerContext, "itemFingerprint"), false);
  assert.equal(Object.hasOwn(handlerContext.operationLogContext, "itemFingerprint"), false);
  assert.equal(Object.hasOwn(handlerContext.syncEventContext, "itemFingerprint"), false);
  assert.match(lookupContext.itemFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(saveContext.itemFingerprint, lookupContext.itemFingerprint);
  for (const context of [handlerContext, lookupContext, saveContext]) {
    assert.equal(context.requestId, "request-001");
    assert.equal(context.batchId, "batch-001");
    assert.equal(context.itemId, "one");
    assert.equal(context.itemKey, "item-key-one");
    assert.equal(context.expectedVersion, 1);
    assert.ok(context.signal instanceof AbortSignal);
  }
});
