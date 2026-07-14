const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  BATCH_MAX_ITEMS,
  LEGACY_BATCH_MAX_ITEMS,
  createProductTagService,
  normalizeManyPublicInput,
  normalizeManyLegacyInput
} = require("../productTagService");
const { createDatabase, createIdempotency } = require("../../updateProductPrice/test/helpers");

function actor(overrides = {}) {
  return {
    id: "admin-1",
    openid: "openid-1",
    role: "procurement",
    permissions: ["product:tag:batch_update"],
    status: "active",
    isActive: true,
    sourceClient: "admin_web",
    ...overrides
  };
}

function product(overrides = {}) {
  return {
    _id: "product-1",
    name: "测试商品",
    brand: "测试品牌",
    productIndex: "P000001",
    tags: [],
    internalTags: [],
    isNew: false,
    isDefective: false,
    isHot: false,
    isFrequent: false,
    defectDescription: "",
    version: 3,
    updatedAt: new Date("2026-07-10T08:00:00.000Z"),
    ...overrides
  };
}

function state(overrides = {}) {
  return {
    products: [product()],
    product_tag_logs: [],
    admin_operation_logs: [],
    sync_events: [],
    ...structuredClone(overrides)
  };
}

function setup(initialState = state(), options = {}) {
  const db = createDatabase(initialState, options.database || {});
  const productUpdates = [];
  const runTransaction = db.runTransaction.bind(db);
  db.runTransaction = (callback) => runTransaction((tx) => {
    const collection = tx.collection.bind(tx);
    return callback({
      ...tx,
      collection(name) {
        const target = collection(name);
        if (name !== "products") return target;
        return {
          ...target,
          doc(id) {
            const document = target.doc(id);
            return {
              ...document,
              async update(request) {
                productUpdates.push({ id, data: structuredClone(request.data) });
                return document.update(request);
              }
            };
          }
        };
      }
    });
  });
  const idempotency = options.idempotency || createIdempotency();
  return {
    db,
    productUpdates,
    service: createProductTagService({
      db,
      idempotency,
      now: () => new Date("2026-07-11T08:00:00.000Z")
    })
  };
}

function publicCommand(overrides = {}) {
  return {
    actor: actor(),
    input: {
      scope: "public",
      tag: "新货",
      present: true,
      items: [{ id: "product-1", expectedVersion: 3, expectedPresent: false }],
      reason: "批量设置标签",
      ...overrides.input
    },
    idempotencyKey: "product-tag-key-0001",
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "input"))
  };
}

test("deployable product tag service copies match the canonical implementation", () => {
  const canonical = fs.readFileSync(path.resolve(__dirname, "../../common/services/productTagService.js"), "utf8");
  assert.equal(fs.readFileSync(path.resolve(__dirname, "../productTagService.js"), "utf8"), canonical);
  assert.equal(fs.readFileSync(path.resolve(__dirname, "../../adminWebApi/lib/productTagService.js"), "utf8"), canonical);
});

test("strict Web input caps raw items before deduplication and only deduplicates identical snapshots", () => {
  const normalized = normalizeManyPublicInput({
    scope: "public",
    tag: "热销",
    present: true,
    items: [
      { id: " product-1 ", expectedVersion: 3, expectedPresent: false },
      { id: "product-1", expectedVersion: 3, expectedPresent: false }
    ],
    reason: " 设置热销 "
  });
  assert.deepEqual(normalized.items, [{ id: "product-1", expectedVersion: 3, expectedPresent: false }]);
  assert.equal(normalized.reason, "设置热销");
  assert.throws(
    () => normalizeManyPublicInput({
      scope: "public",
      tag: "热销",
      present: true,
      items: Array.from({ length: BATCH_MAX_ITEMS + 1 }, () => ({
        id: "product-1",
        expectedVersion: 3,
        expectedPresent: false
      }))
    }),
    (error) => error.code === "BATCH_LIMIT_EXCEEDED"
  );
  assert.throws(
    () => normalizeManyPublicInput({
      scope: "public",
      tag: "热销",
      present: true,
      items: [
        { id: "product-1", expectedVersion: 3, expectedPresent: false },
        { id: "product-1", expectedVersion: 3, expectedPresent: true }
      ]
    }),
    (error) => error.code === "BATCH_ITEM_CONFLICT"
  );
  for (const invalid of [
    { scope: "internal", tag: "新货", present: true, items: [{ id: "p", expectedVersion: 0, expectedPresent: false }] },
    { scope: "public", tag: "内部", present: true, items: [{ id: "p", expectedVersion: 0, expectedPresent: false }] },
    { scope: "public", tag: "新货", present: 1, items: [{ id: "p", expectedVersion: 0, expectedPresent: false }] },
    { scope: "public", tag: "新货", present: true, items: [{ id: "p", expectedVersion: 0, expectedPresent: false, identity: "forged" }] },
    { scope: "public", tag: "新货", present: true, items: [{ id: "p", expectedVersion: 0, expectedPresent: false }], productIds: ["p"] }
  ]) {
    assert.throws(() => normalizeManyPublicInput(invalid));
  }
});

test("explicit public set synchronizes tags and legacy flags in one transaction", async () => {
  const originalInternalTags = [" 仅内部 ", "超长内部标签不应被公开操作规范化"];
  const originalFrequent = "legacy-frequent-value";
  const originalDefectDescription = `  ${"原瑕疵说明".repeat(110)}  `;
  const initial = state({
    products: [product({
      tags: ["新货", "legacy-private"],
      internalTags: originalInternalTags,
      isNew: false,
      isHot: true,
      isFrequent: originalFrequent,
      defectDescription: originalDefectDescription
    })]
  });
  const subject = setup(initial);
  const result = await subject.service.setManyPublicTags(publicCommand({
    input: {
      present: false,
      items: [{ id: "product-1", expectedVersion: 3, expectedPresent: true }]
    }
  }));
  const snapshot = subject.db.snapshot();
  const updated = snapshot.products[0];

  assert.equal(result.changedCount, 1);
  assert.equal(result.unchangedCount, 0);
  assert.deepEqual(updated.tags, ["热销"]);
  assert.equal(updated.isNew, false);
  assert.equal(updated.isDefective, false);
  assert.equal(updated.isHot, true);
  assert.equal(updated.isFrequent, originalFrequent);
  assert.equal(updated.defectDescription, originalDefectDescription);
  assert.deepEqual(updated.internalTags, originalInternalTags);
  assert.equal(updated.version, 4);
  assert.equal(updated.tagUpdatedBy, "openid-1");
  assert.equal(updated.searchText.includes("热销"), true);
  assert.equal(updated.searchText.includes("超长内部标签"), false);
  assert.equal(snapshot.product_tag_logs.length, 1);
  assert.equal(snapshot.admin_operation_logs.length, 1);
  assert.equal(snapshot.sync_events.length, 1);
  assert.equal(snapshot.sync_events[0].audience, "public");
  assert.deepEqual(snapshot.sync_events[0].changedFields, ["updatedAt", "version"]);
  assert.equal(snapshot.admin_operation_logs[0].operatorOpenid, "openid-1");
  const publicEvent = JSON.stringify(snapshot.sync_events[0]);
  const minimalAudit = JSON.stringify(snapshot.admin_operation_logs[0]);
  for (const sensitive of ["新货", "热销", "超长内部标签", "原瑕疵说明", "openid-1"]) {
    assert.equal(publicEvent.includes(sensitive), false, sensitive);
  }
  for (const tagValue of ["新货", "热销", "超长内部标签"]) {
    assert.equal(minimalAudit.includes(tagValue), false, tagValue);
  }
});

test("strict public changed update writes only the public product-field allowlist", async () => {
  const subject = setup();
  const result = await subject.service.setManyPublicTags(publicCommand());

  assert.equal(result.changedCount, 1);
  assert.equal(subject.productUpdates.length, 1);
  assert.deepEqual(Object.keys(subject.productUpdates[0].data).sort(), [
    "isDefective",
    "isHot",
    "isNew",
    "searchText",
    "tags",
    "tagUpdatedAt",
    "tagUpdatedBy",
    "updatedAt",
    "version"
  ].sort());
  for (const field of ["internalTags", "isFrequent", "defectDescription"]) {
    assert.equal(Object.hasOwn(subject.productUpdates[0].data, field), false, field);
  }
});

test("no-op returns before every business write", async () => {
  const originalInternalTags = [" 采购关注 ", "超长内部标签不应阻止公开标签无操作"];
  const originalDefectDescription = ` ${"瑕".repeat(520)} `;
  const subject = setup(state({
    products: [product({
      tags: ["热销"],
      internalTags: originalInternalTags,
      isHot: true,
      isFrequent: "legacy-frequent-value",
      defectDescription: originalDefectDescription
    })]
  }));
  const before = subject.db.snapshot();
  const result = await subject.service.setManyPublicTags(publicCommand({
    input: {
      tag: "热销",
      present: true,
      items: [{ id: "product-1", expectedVersion: 3, expectedPresent: true }]
    }
  }));
  assert.equal(result.changedCount, 0);
  assert.equal(result.unchangedCount, 1);
  assert.deepEqual(subject.db.snapshot(), before);
  assert.equal(subject.db.snapshot().products[0].version, 3);
});

test("expectedPresent catches legacy writers that changed a tag without incrementing version", async () => {
  const subject = setup(state({
    products: [product({ tags: ["新货"], isNew: false, version: 3 })]
  }));
  const result = await subject.service.setManyPublicTags(publicCommand());
  assert.deepEqual(result.failures, [{ id: "product-1", code: "DATA_VERSION_CONFLICT" }]);
  assert.equal(result.failedCount, 1);
  assert.equal(subject.db.snapshot().product_tag_logs.length, 0);
});

test("adding a defective tag warns without blocking and removing it preserves the description", async () => {
  const adding = setup();
  const added = await adding.service.setManyPublicTags(publicCommand({
    input: { tag: "瑕疵" },
    idempotencyKey: "product-tag-defect-add-0001"
  }));
  assert.equal(added.changedCount, 1);
  assert.equal(added.warningCount, 1);
  assert.equal(adding.db.snapshot().products[0].isDefective, true);

  const removing = setup(state({
    products: [product({
      tags: ["瑕疵"],
      isDefective: true,
      defectDescription: "外盒压痕"
    })]
  }));
  const removed = await removing.service.setManyPublicTags(publicCommand({
    input: {
      tag: "瑕疵",
      present: false,
      items: [{ id: "product-1", expectedVersion: 3, expectedPresent: true }]
    },
    idempotencyKey: "product-tag-defect-remove-0001"
  }));
  assert.equal(removed.warningCount, 0);
  assert.equal(removing.db.snapshot().products[0].defectDescription, "外盒压痕");
});

test("legacy adapter caps cleaned unique IDs at 200 and keeps internal tags out of public sync", async () => {
  assert.equal(LEGACY_BATCH_MAX_ITEMS, 200);
  const deduplicated = normalizeManyLegacyInput({
    productIds: Array.from({ length: 201 }, () => " product-1 ")
  });
  assert.deepEqual(deduplicated.items, [{ id: "product-1" }]);
  assert.throws(
    () => normalizeManyLegacyInput({
      productIds: Array.from({ length: LEGACY_BATCH_MAX_ITEMS + 1 }, (_, index) => `product-${index + 1}`)
    }),
    (error) => error.code === "BATCH_LIMIT_EXCEEDED"
  );
  const subject = setup(state({
    products: [product({ tags: ["热销"], isHot: false })]
  }));
  const result = await subject.service.setManyLegacyTags({
    actor: actor({ sourceClient: "miniprogram" }),
    input: {
      productIds: ["product-1"],
      addInternalTags: ["采购关注"],
      setFlags: {}
    },
    idempotencyKey: "legacy-product-tag-key-0001",
    batchOperationId: "legacy-product-tag-key-0001"
  });
  const snapshot = subject.db.snapshot();
  assert.equal(result.changedCount, 1);
  assert.deepEqual(snapshot.products[0].tags, ["热销"]);
  assert.equal(snapshot.products[0].isHot, true);
  assert.deepEqual(snapshot.products[0].internalTags, ["采购关注"]);
  assert.equal(snapshot.products[0].searchText.includes("采购关注"), false);
  assert.equal(snapshot.sync_events[0].audience, "public");
  assert.equal(JSON.stringify(snapshot.sync_events[0]).includes("采购关注"), false);

  const internalOnly = setup(state({
    products: [product({ tags: ["热销"], isHot: true })]
  }));
  await internalOnly.service.setManyLegacyTags({
    actor: actor({ sourceClient: "miniprogram" }),
    input: { productIds: ["product-1"], addInternalTags: ["仅后台"] },
    idempotencyKey: "legacy-internal-only-key-0001"
  });
  assert.equal(internalOnly.db.snapshot().sync_events[0].audience, "admin");
  assert.equal(internalOnly.db.snapshot().sync_events[0].isPublic, false);
});

test("transaction failure rolls back product and all three companion writes", async () => {
  const subject = setup(state(), { database: { failAddCollection: "sync_events" } });
  const before = subject.db.snapshot();
  await assert.rejects(
    subject.service.setManyPublicTags(publicCommand()),
    /simulated sync_events write failure/
  );
  assert.deepEqual(subject.db.snapshot(), before);
});

function processingIdempotency() {
  const base = createIdempotency();
  let calls = 0;
  return {
    ...base,
    async runIdempotentAction(config, executor) {
      calls += 1;
      if (calls === 1) {
        await executor();
        return { ok: false, code: "IDEMPOTENCY_PROCESSING", message: "操作正在处理中" };
      }
      const recovered = await config.recoverProcessingResult();
      return recovered
        ? { ok: true, data: { ...recovered, duplicate: true, idempotencyStatus: "success" } }
        : { ok: false, code: "IDEMPOTENCY_PROCESSING", message: "操作正在处理中" };
    }
  };
}

test("processing replay recovers a committed item from product_tag_logs", async () => {
  const subject = setup(state(), { idempotency: processingIdempotency() });
  await assert.rejects(
    subject.service.setManyPublicTags(publicCommand()),
    (error) => error.code === "IDEMPOTENCY_PROCESSING"
  );
  const recovered = await subject.service.setManyPublicTags(publicCommand());
  assert.equal(recovered.changedCount, 1);
  assert.equal(recovered.duplicate, true);
  assert.equal(subject.db.snapshot().product_tag_logs.length, 1);
  assert.equal(subject.db.snapshot().admin_operation_logs.length, 1);
  assert.equal(subject.db.snapshot().sync_events.length, 1);
});

test("whole-batch idempotency replays the summary and rejects another payload", async () => {
  const subject = setup();
  const first = await subject.service.setManyPublicTags(publicCommand());
  const replay = await subject.service.setManyPublicTags(publicCommand());
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(subject.db.snapshot().product_tag_logs.length, 1);
  await assert.rejects(
    subject.service.setManyPublicTags(publicCommand({ input: { reason: "另一个原因" } })),
    (error) => error.code === "IDEMPOTENCY_KEY_CONFLICT" && error.statusCode === 409
  );
});
