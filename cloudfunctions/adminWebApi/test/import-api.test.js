"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const api = require("../index");
const core = require("../lib/core");

const { dispatch, importRoute, normalizeImportMutation } = api._test;
const csrfToken = "csrf-token-for-import";
const config = { tokenPepper: "p".repeat(32) };

function auth(permissions = ["inventory:import"]) {
  return {
    principal: { id: "admin-1", role: "procurement", permissions, status: "active" },
    rawAdmin: { _id: "raw-admin", openid: "server-openid", role: "procurement" },
    session: { csrfTokenHash: security.tokenHash(csrfToken, config.tokenPepper) }
  };
}

function request(action = "preview", overrides = {}) {
  const body = action === "preview" ? {
    type: "inventory",
    file: { name: "inventory.csv", mimeType: "text/csv", size: 20, contentBase64: "c2t1LG5hbWUsc3RvY2s=" },
    mapping: { sku: "sku", name: "name", value: "stock" }
  } : {
    type: "inventory",
    file: { name: "inventory.csv", mimeType: "text/csv", size: 20, contentBase64: "c2t1LG5hbWUsc3RvY2s=" },
    mapping: { sku: "sku", name: "name", value: "stock" },
    previewRecordId: "import-1",
    expectedFileHash: "a".repeat(64),
    expectedParseHash: "b".repeat(64)
  };
  return {
    route: { action: "mutate", resource: "imports", mutationAction: action },
    body,
    headers: { "x-admin-csrf": csrfToken, "idempotency-key": `import-${action}-key-001` },
    http: true,
    requestId: `request-import-${action}`,
    ...overrides
  };
}

test("registers only preview, confirm and resume import mutations with exact permission", () => {
  assert.deepEqual(core.parseHttpRoute("/api/admin/v1/imports/preview", "POST"), { action: "mutate", resource: "imports", mutationAction: "preview" });
  assert.equal(core.getMutationPermission("imports", "preview"), "inventory:import");
  assert.equal(core.getMutationPermission("imports", "confirm"), "inventory:import");
  assert.equal(core.getMutationPermission("imports", "resume"), "inventory:import");
  assert.throws(() => core.getMutationPermission("imports", "execute"), (error) => error.code === "MUTATION_NOT_SUPPORTED");
  assert.equal(importRoute({ resource: "imports", mutationAction: "preview" }), true);
  assert.equal(importRoute({ resource: "products", mutationAction: "import-confirm" }), false);
});

test("normalizes the import body and rejects actor or unknown client fields", () => {
  const normalized = normalizeImportMutation(request());
  assert.equal(normalized.idempotencyKey, "import-preview-key-001");
  assert.equal(normalized.input.type, "inventory");
  assert.equal(normalized.input.file.name, "inventory.csv");
  for (const field of ["actor", "operatorId", "openid", "idempotencyKey", "unknown"]) {
    assert.throws(
      () => normalizeImportMutation(request("preview", { body: { ...request().body, [field]: "forged" } })),
      (error) => error.code === "INVALID_REQUEST_BODY",
      field
    );
  }
});

test("dispatch checks permission and CSRF before deriving the server actor", async () => {
  let command;
  const previewResult = {
    importRecordId: "import-1",
    status: "previewed",
    fileHash: "a".repeat(64),
    parseHash: "b".repeat(64),
    fileType: "csv",
    headers: ["sku", "name", "stock"],
    mapping: { sku: "sku", name: "name", value: "stock" },
    rows: [],
    counts: { total: 0, valid: 0, failed: 0, ready: 0, validation: 0, truncated: false },
    previewTruncated: false
  };
  const dependencies = { importService: { async preview(value) { command = value; return previewResult; } } };
  const result = await dispatch(request(), auth(), config, dependencies);

  assert.equal(command.actor.id, "admin-1");
  assert.equal(command.actor.openid, "server-openid");
  assert.equal(command.actor.sourceClient, "admin_web");
  assert.equal(command.idempotencyKey, "import-preview-key-001");
  assert.equal(result.item.importRecordId, "import-1");
  assert.equal(result.item.previewTruncated, false);
  assert.equal(result.affected, 0);

  await assert.rejects(dispatch(request(), auth([]), config, dependencies), (error) => error.code === "FORBIDDEN");
  await assert.rejects(
    dispatch(request("preview", { headers: { "idempotency-key": "import-preview-key-001" } }), auth(), config, dependencies),
    (error) => error.code === "CSRF_VALIDATION_FAILED"
  );
});

test("ready preview response rejects inconsistent counts and sensitive row fields", async () => {
  const valid = {
    importRecordId: "import-1",
    status: "previewed",
    fileHash: "a".repeat(64),
    parseHash: "b".repeat(64),
    fileType: "csv",
    headers: ["sku", "name", "stock"],
    mapping: { sku: "sku", name: "name", value: "stock" },
    rows: [{ row: 2, values: { sku: "A", name: "Safe", value: "1" }, status: "ready", code: "OK", message: "可处理" }],
    counts: { total: 1, valid: 1, failed: 0, ready: 1, validation: 0, truncated: false },
    previewTruncated: false
  };
  for (const result of [
    { ...valid, counts: { ...valid.counts, failed: 1 } },
    { ...valid, rows: [{ ...valid.rows[0], operatorOpenid: "sensitive" }] }
  ]) {
    await assert.rejects(
      dispatch(request(), auth(), config, { importService: { async preview() { return result; } } }),
      (error) => error.code === "INVALID_SERVICE_RESPONSE"
    );
  }
});

test("mapping_required preview passes strict parse context without a persisted batch id", async () => {
  const mappingRequired = {
    status: "mapping_required",
    headers: ["货号", "品名", "数量"],
    suggestedMapping: { sku: "货号" },
    requiredFields: ["name", "value"],
    mappingErrors: [
      { field: "name", code: "IMPORT_MAPPING_REQUIRED", message: "请选择对应表头" },
      { field: "value", code: "IMPORT_MAPPING_REQUIRED", message: "请选择对应表头" }
    ],
    fileHash: "a".repeat(64),
    parseContext: { hash: "b".repeat(64), fileType: "csv", sheetName: "", headerRow: 1, rowCount: 1 }
  };
  const dependencies = { importService: { async preview() { return mappingRequired; } } };
  const result = await dispatch({ ...request(), body: { ...request().body, mapping: {} } }, auth(), config, dependencies);

  assert.equal(result.item.status, "mapping_required");
  assert.equal(Object.hasOwn(result.item, "importRecordId"), false);
  assert.deepEqual(result.item.headers, mappingRequired.headers);
  assert.deepEqual(result.item.parseContext, mappingRequired.parseContext);
  assert.equal(result.message, "请完成表头映射后重新校验");
});

test("reads import detail and receipt items through the existing imports resource with exact permission", async () => {
  const calls = [];
  const dependencies = {
    importService: {
      async getDetail(command) { calls.push(["detail", command]); return { importRecordId: command.importRecordId, status: "partial", counts: { total: 2, success: 1, failed: 1 } }; },
      async listItems(command) { calls.push(["items", command]); return { items: [{ id: "row-2", row: 2, status: "success", code: "OK", retryable: false, reused: true, updatedAt: null }], total: 1, page: 1, pageSize: 20, nextCursor: null }; }
    }
  };
  const detail = await dispatch({ route: { action: "get", resource: "imports", id: "import-1" }, query: {}, requestId: "detail-request" }, auth(), config, dependencies);
  const items = await dispatch({ route: { action: "importItems", resource: "imports", id: "import-1" }, query: { page: "1", pageSize: "20" }, requestId: "items-request" }, auth(), config, dependencies);

  assert.equal(detail.importRecordId, "import-1");
  assert.equal(items.items[0].id, "row-2");
  assert.equal(calls[0][1].actor.id, "admin-1");
  assert.equal(calls[0][1].actor.openid, "server-openid");
  assert.deepEqual(calls[1][1].query, { page: "1", pageSize: "20" });
  await assert.rejects(
    dispatch({ route: { action: "importItems", resource: "imports", id: "import-1" }, query: {}, requestId: "forbidden-request" }, auth([]), config, dependencies),
    (error) => error.code === "FORBIDDEN"
  );
});
