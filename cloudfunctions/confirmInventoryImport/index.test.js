"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const handlerPath = path.join(__dirname, "index.js");
const PROOF_VERSION = "inventory-import-preview-v1";
const MANIFEST_VERSION = "inventory-import-manifest-v1";

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function testProof(importRecordId, row, product) {
  const payload = {
    version: PROOF_VERSION,
    importRecordId: text(importRecordId),
    row: {
      rowNo: Number(row.rowNo || 0),
      action: text(row.action),
      source: row.source === "quote" ? "quote" : "inventory",
      baseName: text(row.baseName),
      specification: text(row.specification),
      productionDate: text(row.productionDate),
      matchedProductId: text(row.matchedProductId),
      productIndex: text(row.productIndex),
      skuCode: text(row.skuCode)
    },
    product: product ? {
      id: text(product._id || product.id),
      name: text(product.name),
      baseName: text(product.baseName),
      specification: text(product.specification),
      productionDate: text(product.productionDate),
      productIndex: text(product.productIndex),
      skuCode: text(product.skuCode)
    } : null
  };
  return `${PROOF_VERSION}:${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const output = {};
  Object.keys(value).sort().forEach((key) => {
    if (value[key] !== undefined && typeof value[key] !== "function") output[key] = canonicalize(value[key]);
  });
  return output;
}

function testManifest(items) {
  const canonical = JSON.stringify(canonicalize(items));
  return `${MANIFEST_VERSION}:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

function product(id, overrides = {}) {
  return {
    _id: id,
    name: "兰蔻粉水",
    baseName: "兰蔻粉水",
    specification: "400ml",
    productionDate: "2026-03",
    productIndex: `INDEX-${id}`,
    skuCode: `SKU-${id}`,
    stock: 5,
    warningStock: 10,
    price: 1000,
    isDeleted: false,
    isActive: true,
    ...overrides
  };
}

function previewRow(overrides = {}) {
  return {
    rowNo: 1,
    rawName: "兰蔻粉水 400ml 2026-03 库存 12",
    baseName: "兰蔻粉水",
    specification: "400ml",
    productionDate: "2026-03",
    productIndex: "",
    skuCode: "",
    stock: 12,
    warningStock: 10,
    price: 1200,
    matchedProductId: "product-1",
    source: "inventory",
    action: "update",
    selected: true,
    errorMessage: "",
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function matches(row, query) {
  return Object.entries(query || {}).every(([key, expected]) => {
    if (expected && typeof expected === "object" && Object.hasOwn(expected, "__neq")) {
      return row[key] !== expected.__neq;
    }
    return row[key] === expected;
  });
}

function setup({
  products,
  previewItems,
  record = {},
  downloadedPreviewItems = previewItems,
  previewFileContent = null,
  failInventoryLogAdd = false,
  mutateRecordBeforeTransaction = null,
  importItems = [],
  inventoryLogs = [],
  idempotencyEarlyResult = null
}) {
  const defaultPreviewFileID = "cloud://test/preview.json";
  const state = {
    products: Object.fromEntries(products.map((item) => [item._id, clone(item)])),
    records: {
      "import-1": {
        _id: "import-1",
        status: "parsed",
        previewFileID: defaultPreviewFileID,
        previewManifestHash: testManifest(previewItems),
        totalRows: previewItems.length,
        ...clone(record)
      }
    },
    previewItems: clone(downloadedPreviewItems),
    idempotencyPayloads: [],
    collections: {
      import_record_items: clone(importItems),
      inventory_logs: clone(inventoryLogs),
      price_logs: []
    }
  };

  const command = {
    neq(value) {
      return { __neq: value };
    },
    inc(value) {
      return { __inc: value };
    }
  };

  function rowsFor(name) {
    if (name === "products") return Object.values(state.products);
    if (name === "import_records") return Object.values(state.records);
    state.collections[name] = state.collections[name] || [];
    return state.collections[name];
  }

  function applyUpdate(target, data) {
    Object.entries(data || {}).forEach(([key, value]) => {
      if (value && typeof value === "object" && Object.hasOwn(value, "__inc")) {
        target[key] = Number(target[key] || 0) + Number(value.__inc || 0);
      } else {
        target[key] = value;
      }
    });
  }

  function collection(name) {
    function queryBuilder(query = null) {
      let skipValue = 0;
      let limitValue = Number.MAX_SAFE_INTEGER;
      const builder = {
        orderBy() {
          return builder;
        },
        skip(value) {
          skipValue = Number(value || 0);
          return builder;
        },
        limit(value) {
          limitValue = Number(value);
          return builder;
        },
        async get() {
          const filtered = query ? rowsFor(name).filter((row) => matches(row, query)) : rowsFor(name);
          return { data: filtered.slice(skipValue, skipValue + limitValue).map(clone) };
        }
      };
      return builder;
    }

    return {
      doc(id) {
        return {
          async get() {
            const value = name === "products" ? state.products[id] : name === "import_records" ? state.records[id] : rowsFor(name).find((row) => row._id === id);
            return { data: value ? clone(value) : null };
          },
          async update({ data }) {
            const target = name === "products" ? state.products[id] : name === "import_records" ? state.records[id] : rowsFor(name).find((row) => row._id === id);
            if (!target) throw new Error(`missing ${name}/${id}`);
            applyUpdate(target, data);
            return { stats: { updated: 1 } };
          }
        };
      },
      where(query) {
        return queryBuilder(query);
      },
      orderBy(field, direction) {
        return queryBuilder().orderBy(field, direction);
      },
      skip(value) {
        return queryBuilder().skip(value);
      },
      limit(value) {
        return queryBuilder().limit(value);
      },
      async add({ data }) {
        if (name === "inventory_logs" && failInventoryLogAdd) {
          throw new Error("injected inventory log failure");
        }
        if (name === "products") {
          const id = `product-created-${Object.keys(state.products).length + 1}`;
          state.products[id] = { _id: id, ...clone(data) };
          return { _id: id };
        }
        const id = `${name}-${rowsFor(name).length + 1}`;
        rowsFor(name).push({ _id: id, ...clone(data) });
        return { _id: id };
      }
    };
  }

  const db = {
    command,
    serverDate: () => new Date("2026-07-23T00:00:00.000Z"),
    async createCollection() {},
    collection,
    async runTransaction(work) {
      if (mutateRecordBeforeTransaction) {
        applyUpdate(state.records["import-1"], clone(mutateRecordBeforeTransaction));
      }
      const snapshot = clone({
        products: state.products,
        records: state.records,
        collections: state.collections
      });
      try {
        return await work(db);
      } catch (err) {
        state.products = snapshot.products;
        state.records = snapshot.records;
        state.collections = snapshot.collections;
        throw err;
      }
    }
  };
  const sdk = {
    DYNAMIC_CURRENT_ENV: "dynamic",
    init() {},
    database: () => db,
    async downloadFile({ fileID }) {
      assert.equal(fileID, state.records["import-1"].previewFileID);
      return {
        fileContent: Buffer.from(
          previewFileContent === null ? JSON.stringify(state.previewItems) : previewFileContent,
          "utf8"
        )
      };
    }
  };
  const auth = {
    async requirePermission(permission) {
      assert.equal(permission, "inventory:import");
      return {
        _id: "admin-1",
        id: "admin-1",
        openid: "admin-openid",
        role: "inventory",
        permissions: ["inventory:import"],
        isActive: true
      };
    }
  };
  const idempotency = {
    async beginIdempotentAction(options) {
      state.idempotencyPayloads.push(clone(options.payload));
      return { recordId: "idem-1" };
    },
    async finishIdempotentAction() {},
    async failIdempotentAction() {},
    idempotencyEarlyReturn() {
      return idempotencyEarlyResult;
    },
    idempotencyErrorResponse() {
      return null;
    },
    firstSuccessData(value) {
      return value && value.data !== undefined ? value.data : value;
    }
  };
  const stockAlert = {
    normalizeWarningStock(value) {
      if (value === undefined || value === null || value === "") return 10;
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) throw new Error("预警库存必须是非负整数");
      return number;
    },
    buildStockStatusUpdate(current, { stock, warningStock, now }) {
      return {
        stock,
        warningStock,
        stockStatus: stock <= 0 ? "out_of_stock" : stock <= warningStock ? "warning" : "in_stock",
        updatedAt: now
      };
    },
    async syncStockAlertRecord() {}
  };

  delete require.cache[require.resolve(handlerPath)];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return sdk;
    if (parent && parent.filename === handlerPath && request === "./auth") return auth;
    if (parent && parent.filename === handlerPath && request === "./idempotency") return idempotency;
    if (parent && parent.filename === handlerPath && request === "./stockAlert") return stockAlert;
    return originalLoad.call(this, request, parent, isMain);
  };
  let handler;
  try {
    handler = require(handlerPath);
  } finally {
    Module._load = originalLoad;
  }

  return { handler, state };
}

async function confirm(handler, item, overrides = {}) {
  const items = Array.isArray(item) ? item.map(clone) : [clone(item)];
  return handler.main({
    importRecordId: "import-1",
    mode: "override",
    items,
    idempotencyKey: "inventory-proof-test",
    ...overrides
  });
}

test("normal confirmation accepts the server preview proof and updates the matched product", async () => {
  const originalProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, originalProduct);
  const { handler, state } = setup({ products: [originalProduct], previewItems: [row] });

  const result = await confirm(handler, row);

  assert.equal(result.ok, true);
  assert.equal(result.data.successRows, 1);
  assert.equal(state.products["product-1"].stock, 12);
});

test("rejects confirmation when the matched product identity changed after preview", async () => {
  const originalProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, originalProduct);
  const changedProduct = product("product-1", { name: "兰蔻粉水新名称" });
  const { handler, state } = setup({ products: [changedProduct], previewItems: [row] });

  const result = await confirm(handler, row);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
});

test("rejects confirmation when the matched product SKU changed after preview", async () => {
  const originalProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, originalProduct);
  const changedProduct = product("product-1", { skuCode: "SKU-CHANGED" });
  const { handler, state } = setup({ products: [changedProduct], previewItems: [row] });

  const result = await confirm(handler, row);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
});

test("rejects a tampered productId even when the target has the same specification and date", async () => {
  const originalProduct = product("product-1");
  const otherProduct = product("product-2", { name: "其他商品", stock: 9 });
  const row = previewRow();
  row.previewProof = testProof("import-1", row, originalProduct);
  const tampered = { ...row, matchedProductId: "product-2" };
  const { handler, state } = setup({ products: [originalProduct, otherProduct], previewItems: [row] });

  const result = await confirm(handler, tampered);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-2"].stock, 9);
});

test("rejects a tampered productId before reusing a legacy product-key inventory log", async () => {
  const originalProduct = product("product-1");
  const otherProduct = product("product-2", { name: "其他商品", baseName: "其他商品", stock: 9 });
  const row = previewRow();
  row.previewProof = testProof("import-1", row, originalProduct);
  const tampered = { ...row, matchedProductId: "product-2" };
  const { handler, state } = setup({
    products: [originalProduct, otherProduct],
    previewItems: [row],
    inventoryLogs: [{
      businessKey: "import_inventory:import-1:product-2",
      sourceType: "import",
      sourceId: "import-1",
      relatedImportId: "import-1",
      productId: "product-2",
      beforeStock: 5,
      afterStock: 12,
      changeAmount: 7,
      reason: "import_override"
    }]
  });

  const result = await confirm(handler, tampered);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
  assert.equal(state.products["product-2"].stock, 9);
  assert.equal(state.collections.import_record_items.length, 0);
  assert.equal(state.records["import-1"].status, "parsed");
});

test("legacy product-key log without rowNo is rejected when the manifest maps the product to multiple rows", async () => {
  const currentProduct = product("product-1");
  const rowOne = previewRow();
  rowOne.previewProof = testProof("import-1", rowOne, currentProduct);
  const rowTwo = previewRow({ rowNo: 2 });
  rowTwo.previewProof = testProof("import-1", rowTwo, currentProduct);
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [rowOne, rowTwo],
    importItems: [{
      businessKey: "import_row:import-1:row:1",
      importRecordId: "import-1",
      rowNo: 1,
      action: "update",
      selected: true,
      finalProductId: "product-1"
    }],
    inventoryLogs: [{
      businessKey: "import_inventory:import-1:product-1",
      sourceType: "import",
      sourceId: "import-1",
      relatedImportId: "import-1",
      productId: "product-1",
      beforeStock: 5,
      afterStock: 12,
      changeAmount: 7,
      reason: "import_override"
    }]
  });

  const result = await confirm(handler, rowTwo, { idempotencyKey: "legacy-product-cross-row" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
  assert.equal(state.collections.import_record_items.length, 1);
  assert.equal(state.records["import-1"].status, "parsed");
});

test("legacy product-key log without rowNo is reused when the manifest maps the product to one row", async () => {
  const currentProduct = product("product-1", { stock: 12 });
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [row],
    inventoryLogs: [{
      businessKey: "import_inventory:import-1:product-1",
      sourceType: "import",
      sourceId: "import-1",
      relatedImportId: "import-1",
      productId: "product-1",
      beforeStock: 5,
      afterStock: 12,
      changeAmount: 7,
      reason: "import_override"
    }]
  });

  const result = await confirm(handler, row, { idempotencyKey: "legacy-product-unique-row" });

  assert.equal(result.ok, true);
  assert.equal(result.data.successRows, 1);
  assert.equal(state.products["product-1"].stock, 12);
  assert.equal(state.collections.import_record_items.length, 1);
  assert.equal(state.records["import-1"].status, "imported");
});

test("existing error row validates proof and current product before reuse", async () => {
  const originalProduct = product("product-1");
  const otherProduct = product("product-2", { name: "其他商品", baseName: "其他商品", stock: 9 });
  const row = previewRow();
  row.previewProof = testProof("import-1", row, originalProduct);
  const tampered = { ...row, matchedProductId: "product-2" };
  const existingError = {
    businessKey: "import_row:import-1:row:1",
    importRecordId: "import-1",
    rowNo: 1,
    action: "error",
    selected: false,
    errorMessage: "previous failure"
  };
  const { handler, state } = setup({
    products: [originalProduct, otherProduct],
    previewItems: [row],
    importItems: [existingError]
  });

  const result = await confirm(handler, tampered, { idempotencyKey: "error-row-tampered-product" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.collections.import_record_items.length, 1);
  assert.equal(state.records["import-1"].status, "parsed");
});

test("existing error row is reused after its trusted update binding is validated", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [row],
    importItems: [{
      businessKey: "import_row:import-1:row:1",
      importRecordId: "import-1",
      rowNo: 1,
      action: "error",
      selected: false,
      errorMessage: "previous failure"
    }]
  });

  const result = await confirm(handler, row, { idempotencyKey: "error-row-trusted-reuse" });

  assert.equal(result.ok, true);
  assert.equal(result.data.failedRows, 1);
  assert.equal(state.products["product-1"].stock, 5);
  assert.equal(state.collections.import_record_items.length, 1);
  assert.equal(state.records["import-1"].status, "imported");
});

test("rejects a row-key inventory log whose immutable ownership evidence is inconsistent", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [row],
    inventoryLogs: [{
      businessKey: "import_inventory:import-1:row:1",
      rowNo: 1,
      sourceType: "import",
      sourceId: "another-import",
      relatedImportId: "another-import",
      productId: "product-1",
      beforeStock: 5,
      afterStock: 12,
      changeAmount: 7,
      reason: "import_override"
    }]
  });

  const result = await confirm(handler, row);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
  assert.equal(state.collections.import_record_items.length, 0);
  assert.equal(state.records["import-1"].status, "parsed");
});

for (const [label, logOverrides] of [
  ["product", { productId: "product-2" }],
  ["row", { rowNo: 2 }],
  ["stock change", { afterStock: 11, changeAmount: 6 }],
  ["row number type", { rowNo: "1" }],
  ["stock number type", { beforeStock: "5", afterStock: "12", changeAmount: "7" }]
]) {
  test(`rejects a row-key inventory log with mismatched ${label} evidence`, async () => {
    const currentProduct = product("product-1");
    const row = previewRow();
    row.previewProof = testProof("import-1", row, currentProduct);
    const { handler, state } = setup({
      products: [currentProduct],
      previewItems: [row],
      inventoryLogs: [{
        businessKey: "import_inventory:import-1:row:1",
        rowNo: 1,
        sourceType: "import",
        sourceId: "import-1",
        relatedImportId: "import-1",
        productId: "product-1",
        beforeStock: 5,
        afterStock: 12,
        changeAmount: 7,
        reason: "import_override",
        ...logOverrides
      }]
    });

    const result = await confirm(handler, row);

    assert.equal(result.ok, false);
    assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
    assert.equal(state.products["product-1"].stock, 5);
    assert.equal(state.collections.import_record_items.length, 0);
    assert.equal(state.records["import-1"].status, "parsed");
  });
}

test("rejects confirmation when productIndex is changed from the stored preview row", async () => {
  const currentProduct = product("product-1");
  const row = previewRow({ productIndex: "PREVIEW-INDEX" });
  row.previewProof = testProof("import-1", row, currentProduct);
  const tampered = { ...row, productIndex: "TAMPERED-INDEX" };
  const { handler, state } = setup({ products: [currentProduct], previewItems: [row] });

  const result = await confirm(handler, tampered);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].productIndex, "INDEX-product-1");
  assert.equal(state.products["product-1"].stock, 5);
});

test("rejects confirmation when skuCode is changed from the stored preview row", async () => {
  const currentProduct = product("product-1");
  const row = previewRow({ skuCode: "PREVIEW-SKU" });
  row.previewProof = testProof("import-1", row, currentProduct);
  const tampered = { ...row, skuCode: "TAMPERED-SKU" };
  const { handler, state } = setup({ products: [currentProduct], previewItems: [row] });

  const result = await confirm(handler, tampered);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].skuCode, "SKU-product-1");
  assert.equal(state.products["product-1"].stock, 5);
});

for (const field of ["productIndex", "skuCode"]) {
  for (const [typeName, storedValue, requestValue] of [
    ["number", "123", 123],
    ["object", "[object Object]", {}],
    ["null", "", null]
  ]) {
    test(`rejects non-string ${field} request input of type ${typeName}`, async () => {
      const currentProduct = product("product-1");
      const row = previewRow({ [field]: storedValue });
      row.previewProof = testProof("import-1", row, currentProduct);
      const tampered = { ...row, [field]: requestValue };
      const { handler, state } = setup({ products: [currentProduct], previewItems: [row] });

      const result = await confirm(handler, tampered, {
        idempotencyKey: `non-string-${field}-${typeName}`
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
      assert.equal(state.products["product-1"].stock, 5);
    });
  }
}

test("rejects non-string preview identity before an idempotency early return", async () => {
  const currentProduct = product("product-1");
  const row = previewRow({ productIndex: "123" });
  row.previewProof = testProof("import-1", row, currentProduct);
  const tampered = { ...row, productIndex: 123 };
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [row],
    idempotencyEarlyResult: { ok: true, data: { reused: true } }
  });

  const result = await confirm(handler, tampered, {
    idempotencyKey: "non-string-before-idempotency-reuse"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
});

test("rejects every tampered trusted preview identity before an idempotency early return", async () => {
  const tamperCases = [
    ["rowNo", 2],
    ["action", "create"],
    ["source", "quote"],
    ["baseName", "篡改商品"],
    ["specification", "TAMPERED-SPEC"],
    ["productionDate", "2099-12"],
    ["matchedProductId", "product-2"],
    ["productIndex", "TAMPERED-INDEX"],
    ["skuCode", "TAMPERED-SKU"],
    ["previewProof", `${PROOF_VERSION}:tampered`]
  ];
  const observations = [];

  for (const [field, value] of tamperCases) {
    const currentProduct = product("product-1");
    const storedRow = previewRow();
    storedRow.previewProof = testProof("import-1", storedRow, currentProduct);
    const requestRow = { ...storedRow, [field]: value };
    const { handler, state } = setup({
      products: [currentProduct],
      previewItems: [storedRow],
      idempotencyEarlyResult: { ok: true, data: { reused: true, successRows: 1 } }
    });

    const result = await confirm(handler, requestRow, {
      idempotencyKey: "trusted-preview-identity-reuse"
    });
    observations.push({
      field,
      ok: result.ok,
      code: result.code || "",
      reused: Boolean(result.data && result.data.reused),
      beginCalls: state.idempotencyPayloads.length,
      stock: state.products["product-1"].stock
    });
  }

  assert.deepEqual(observations, tamperCases.map(([field]) => ({
    field,
    ok: false,
    code: "INVENTORY_IMPORT_PREVIEW_CONFLICT",
    reused: false,
    beginCalls: 0,
    stock: 5
  })));
});

test("rejects proof copied from another preview row", async () => {
  const productOne = product("product-1");
  const productTwo = product("product-2", { name: "雅诗兰黛小棕瓶", baseName: "雅诗兰黛小棕瓶", specification: "50ml" });
  const first = previewRow();
  first.previewProof = testProof("import-1", first, productOne);
  const second = previewRow({
    rowNo: 2,
    rawName: "雅诗兰黛小棕瓶 50ml 2026-03 库存 8",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml",
    stock: 8,
    matchedProductId: "product-2"
  });
  second.previewProof = testProof("import-1", second, productTwo);
  const reused = { ...first, previewProof: second.previewProof };
  const { handler, state } = setup({ products: [productOne, productTwo], previewItems: [first, second] });

  const result = await confirm(handler, reused);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
});

test("legacy update without a verified manifest fails closed", async () => {
  const currentProduct = product("product-1");
  const legacyRow = previewRow();
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [legacyRow],
    record: { previewManifestHash: "" }
  });

  const result = await confirm(handler, legacyRow);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
  assert.equal(state.collections.inventory_logs.length, 0);
});

test("legacy client may omit proof from a new proof-bearing preview", async () => {
  const currentProduct = product("product-1");
  const storedRow = previewRow();
  storedRow.previewProof = testProof("import-1", storedRow, currentProduct);
  const legacyRequestRow = { ...storedRow };
  delete legacyRequestRow.previewProof;
  const { handler, state } = setup({ products: [currentProduct], previewItems: [storedRow] });

  const result = await confirm(handler, legacyRequestRow);

  assert.equal(result.ok, true);
  assert.equal(result.data.successRows, 1);
  assert.equal(state.products["product-1"].stock, 12);
});

test("legacy update without a server preview row is rejected because client/server identity cannot be compared", async () => {
  const currentProduct = product("product-1");
  const legacyRow = previewRow();
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [],
    record: { previewFileID: "", totalRows: 1 }
  });

  const result = await confirm(handler, legacyRow);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
});

test("legacy request without proof rejects ambiguous exact matches instead of choosing one", async () => {
  const firstProduct = product("product-1");
  const duplicateProduct = product("product-2", { productIndex: "DUPLICATE", skuCode: "DUPLICATE" });
  const legacyRow = previewRow();
  const { handler, state } = setup({ products: [firstProduct, duplicateProduct], previewItems: [legacyRow] });

  const result = await confirm(handler, legacyRow);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
  assert.equal(state.products["product-2"].stock, 5);
});

test("legacy create without a preview file is rejected instead of trusting the client row", async () => {
  const createRow = previewRow({
    matchedProductId: "",
    action: "create",
    baseName: "全新商品",
    rawName: "全新商品 30ml",
    specification: "30ml",
    productionDate: ""
  });
  const { handler, state } = setup({
    products: [],
    previewItems: [],
    record: { previewFileID: "", previewManifestHash: "", totalRows: 1 }
  });

  const result = await confirm(handler, createRow);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(Object.keys(state.products).length, 0);
});

test("legacy create with an unanchored preview file is rejected", async () => {
  const createRow = previewRow({
    matchedProductId: "",
    action: "create",
    baseName: "全新商品",
    rawName: "全新商品 30ml",
    specification: "30ml",
    productionDate: ""
  });
  const { handler, state } = setup({
    products: [],
    previewItems: [createRow],
    record: { previewManifestHash: "" }
  });

  const result = await confirm(handler, createRow);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(Object.keys(state.products).length, 0);
});

test("anchored create succeeds only while no normalized exact product exists", async () => {
  const createRow = previewRow({
    matchedProductId: "",
    action: "create",
    baseName: "全新商品",
    rawName: "全新商品 30ml",
    specification: "30ml",
    productionDate: ""
  });
  createRow.previewProof = testProof("import-1", createRow, null);
  const { handler, state } = setup({ products: [], previewItems: [createRow] });

  const result = await confirm(handler, createRow);

  assert.equal(result.ok, true);
  assert.equal(result.data.successRows, 1);
  assert.equal(Object.values(state.products).some((item) => item.name === "全新商品"), true);
});

test("anchored create rejects a normalized exact product added after preview", async () => {
  const createRow = previewRow({
    matchedProductId: "",
    action: "create",
    baseName: "全新商品",
    rawName: "全新商品 30ml",
    specification: "30ml",
    productionDate: ""
  });
  createRow.previewProof = testProof("import-1", createRow, null);
  const existing = product("product-1", {
    name: "全 新商品",
    baseName: "全 新商品",
    specification: "30 ml",
    productionDate: ""
  });
  const { handler, state } = setup({ products: [existing], previewItems: [createRow] });

  const result = await confirm(handler, createRow);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(Object.keys(state.products).length, 1);
});

test("duplicate rowNo values in one client request are rejected before writes", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({ products: [currentProduct], previewItems: [row] });

  const result = await confirm(handler, [row, row], { mode: "add" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
  assert.equal(state.collections.inventory_logs.length, 0);
});

test("same add-mode batch with a new idempotency key applies each row only once", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({ products: [currentProduct], previewItems: [row] });

  const first = await confirm(handler, row, {
    mode: "add",
    isFirstBatch: true,
    isFinalBatch: false,
    idempotencyKey: "inventory-replay-first"
  });
  const second = await confirm(handler, row, {
    mode: "add",
    isFirstBatch: true,
    isFinalBatch: false,
    idempotencyKey: "inventory-replay-second"
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(state.products["product-1"].stock, 17);
  assert.equal(state.collections.inventory_logs.length, 1);
  assert.equal(state.collections.inventory_logs[0].businessKey, "import_inventory:import-1:row:1");
});

test("serverBatch offset replay does not add the same row twice", async () => {
  const productOne = product("product-1");
  const productTwo = product("product-2", {
    name: "雅诗兰黛小棕瓶",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml"
  });
  const first = previewRow();
  first.previewProof = testProof("import-1", first, productOne);
  const second = previewRow({
    rowNo: 2,
    rawName: "雅诗兰黛小棕瓶 50ml 2026-03 库存 8",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml",
    stock: 8,
    matchedProductId: "product-2"
  });
  second.previewProof = testProof("import-1", second, productTwo);
  const { handler, state } = setup({ products: [productOne, productTwo], previewItems: [first, second] });
  const event = {
    importRecordId: "import-1",
    mode: "add",
    serverBatch: true,
    offset: 0,
    batchSize: 1
  };

  const firstResult = await handler.main({ ...event, idempotencyKey: "server-batch-first" });
  const replayResult = await handler.main({ ...event, idempotencyKey: "server-batch-replay" });

  assert.equal(firstResult.ok, true);
  assert.equal(replayResult.ok, true);
  assert.equal(state.products["product-1"].stock, 17);
  assert.equal(state.collections.inventory_logs.length, 1);
});

test("ignore row replay records and counts the row only once", async () => {
  const ignored = previewRow({
    matchedProductId: "",
    action: "ignore",
    selected: false,
    baseName: "忽略商品",
    rawName: "忽略商品"
  });
  ignored.previewProof = testProof("import-1", ignored, null);
  const { handler, state } = setup({ products: [], previewItems: [ignored] });
  const event = {
    mode: "override",
    isFirstBatch: true,
    isFinalBatch: false
  };

  assert.equal((await confirm(handler, ignored, { ...event, idempotencyKey: "ignore-first" })).ok, true);
  assert.equal((await confirm(handler, ignored, { ...event, idempotencyKey: "ignore-replay" })).ok, true);
  assert.equal(state.collections.import_record_items.length, 1);
  assert.equal(state.records["import-1"].skippedRows, 1);
});

test("inventory log failure rolls back the preceding product mutation", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [row],
    failInventoryLogAdd: true
  });

  const result = await confirm(handler, row, { mode: "add" });

  assert.equal(result.ok, false);
  assert.equal(state.products["product-1"].stock, 5);
  assert.equal(state.collections.inventory_logs.length, 0);
});

test("proof update rejects a second normalized exact product added after preview", async () => {
  const originalProduct = product("product-1");
  const duplicate = product("product-2", { productIndex: "INDEX-2", skuCode: "SKU-2" });
  const row = previewRow();
  row.previewProof = testProof("import-1", row, originalProduct);
  const { handler, state } = setup({ products: [originalProduct, duplicate], previewItems: [row] });

  const result = await confirm(handler, row);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
});

test("proof update accepts the same normalized name and specification semantics as parse", async () => {
  const normalizedProduct = product("product-1", {
    name: "兰 蔻粉水",
    baseName: "兰 蔻粉水",
    specification: "400 ml"
  });
  const row = previewRow();
  row.previewProof = testProof("import-1", row, normalizedProduct);
  const { handler, state } = setup({ products: [normalizedProduct], previewItems: [row] });

  const result = await confirm(handler, row);

  assert.equal(result.ok, true);
  assert.equal(result.data.successRows, 1);
  assert.equal(result.data.failedRows, 0);
  assert.equal(state.products["product-1"].stock, 12);
});

test("unique matching scans beyond 1000 products before authorizing proof update", async () => {
  const originalProduct = product("product-1");
  const fillers = Array.from({ length: 999 }, (_, index) => product(`filler-${index}`, {
    name: `填充商品-${index}`,
    baseName: `填充商品-${index}`,
    productIndex: `FILLER-${index}`,
    skuCode: `FILLER-${index}`
  }));
  const duplicate = product("product-after-1000", { productIndex: "LATE", skuCode: "LATE" });
  const row = previewRow();
  row.previewProof = testProof("import-1", row, originalProduct);
  const { handler, state } = setup({
    products: [originalProduct, ...fillers, duplicate],
    previewItems: [row]
  });

  const result = await confirm(handler, row);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
});

test("same preview fileID with replaced canonical content fails the manifest check", async () => {
  const productOne = product("product-1");
  const productTwo = product("product-2", {
    name: "雅诗兰黛小棕瓶",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml",
    stock: 9
  });
  const original = previewRow();
  original.previewProof = testProof("import-1", original, productOne);
  const replacement = previewRow({
    rawName: "雅诗兰黛小棕瓶 50ml 2026-03 库存 8",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml",
    stock: 8,
    matchedProductId: "product-2"
  });
  replacement.previewProof = testProof("import-1", replacement, productTwo);
  const { handler, state } = setup({
    products: [productOne, productTwo],
    previewItems: [original],
    downloadedPreviewItems: [replacement]
  });

  const result = await confirm(handler, replacement);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-2"].stock, 9);
});

test("invalid replacement content at the same preview fileID returns a preview conflict", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [row],
    previewFileContent: "{not-json"
  });

  const result = await confirm(handler, row);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
});

test("transaction rejects a changed preview manifest hash even when fileID is unchanged", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [row],
    mutateRecordBeforeTransaction: { previewManifestHash: `${MANIFEST_VERSION}:changed` }
  });

  const result = await confirm(handler, row);

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PREVIEW_CONFLICT");
  assert.equal(state.products["product-1"].stock, 5);
});

test("idempotency payload is stable whether an old client echoes the stored proof or omits it", async () => {
  const currentProduct = product("product-1");
  const storedRow = previewRow();
  storedRow.previewProof = testProof("import-1", storedRow, currentProduct);
  const idempotencyEarlyResult = { ok: true, data: { reused: true, successRows: 1 } };
  const withProof = setup({ products: [currentProduct], previewItems: [storedRow], idempotencyEarlyResult });
  const withoutProof = setup({ products: [currentProduct], previewItems: [storedRow], idempotencyEarlyResult });
  const oldClientRow = { ...storedRow };
  delete oldClientRow.previewProof;

  const withProofResult = await confirm(withProof.handler, storedRow);
  const withoutProofResult = await confirm(withoutProof.handler, oldClientRow);

  assert.equal(withProofResult.ok, true);
  assert.equal(withProofResult.data.reused, true);
  assert.equal(withoutProofResult.ok, true);
  assert.equal(withoutProofResult.data.reused, true);
  assert.deepEqual(
    withProof.state.idempotencyPayloads[0].itemKeys,
    withoutProof.state.idempotencyPayloads[0].itemKeys
  );
});

test("replaying row one as a client final batch cannot complete a two-row manifest", async () => {
  const productOne = product("product-1");
  const productTwo = product("product-2", {
    name: "雅诗兰黛小棕瓶",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml"
  });
  const rowOne = previewRow();
  rowOne.previewProof = testProof("import-1", rowOne, productOne);
  const rowTwo = previewRow({
    rowNo: 2,
    rawName: "雅诗兰黛小棕瓶 50ml 2026-03 库存 8",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml",
    stock: 8,
    matchedProductId: "product-2"
  });
  rowTwo.previewProof = testProof("import-1", rowTwo, productTwo);
  const { handler, state } = setup({
    products: [productOne, productTwo],
    previewItems: [rowOne, rowTwo]
  });

  assert.equal((await confirm(handler, rowOne, {
    mode: "add",
    isFinalBatch: false,
    idempotencyKey: "row-one-first"
  })).ok, true);
  assert.equal(state.records["import-1"].status, "importing");

  assert.equal((await confirm(handler, rowOne, {
    mode: "add",
    isFinalBatch: true,
    idempotencyKey: "row-one-final-replay"
  })).ok, true);
  assert.equal(state.records["import-1"].status, "importing");
  assert.equal(state.records["import-1"].importedAt, null);

  assert.equal((await confirm(handler, rowTwo, {
    mode: "add",
    isFinalBatch: false,
    idempotencyKey: "row-two-last"
  })).ok, true);
  assert.equal(state.records["import-1"].status, "imported");
  assert.ok(state.records["import-1"].importedAt);
});

test("server batch starting at offset one stays importing until row one is covered", async () => {
  const productOne = product("product-1");
  const productTwo = product("product-2", {
    name: "雅诗兰黛小棕瓶",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml"
  });
  const rowOne = previewRow();
  rowOne.previewProof = testProof("import-1", rowOne, productOne);
  const rowTwo = previewRow({
    rowNo: 2,
    rawName: "雅诗兰黛小棕瓶 50ml 2026-03 库存 8",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml",
    stock: 8,
    matchedProductId: "product-2"
  });
  rowTwo.previewProof = testProof("import-1", rowTwo, productTwo);
  const { handler, state } = setup({
    products: [productOne, productTwo],
    previewItems: [rowOne, rowTwo]
  });

  assert.equal((await handler.main({
    importRecordId: "import-1",
    mode: "override",
    serverBatch: true,
    offset: 1,
    batchSize: 1,
    idempotencyKey: "offset-one-first"
  })).ok, true);
  assert.equal(state.records["import-1"].status, "importing");

  assert.equal((await handler.main({
    importRecordId: "import-1",
    mode: "override",
    serverBatch: true,
    offset: 0,
    batchSize: 1,
    idempotencyKey: "offset-zero-last"
  })).ok, true);
  assert.equal(state.records["import-1"].status, "imported");
});

test("replaying an ignored row as final cannot complete an unprocessed manifest row", async () => {
  const ignored = previewRow({
    matchedProductId: "",
    action: "ignore",
    selected: false,
    baseName: "忽略商品",
    rawName: "忽略商品"
  });
  ignored.previewProof = testProof("import-1", ignored, null);
  const currentProduct = product("product-2", {
    name: "雅诗兰黛小棕瓶",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml"
  });
  const update = previewRow({
    rowNo: 2,
    rawName: "雅诗兰黛小棕瓶 50ml 2026-03 库存 8",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml",
    stock: 8,
    matchedProductId: "product-2"
  });
  update.previewProof = testProof("import-1", update, currentProduct);
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [ignored, update]
  });

  assert.equal((await confirm(handler, ignored, {
    isFinalBatch: false,
    idempotencyKey: "ignore-first"
  })).ok, true);
  assert.equal((await confirm(handler, ignored, {
    isFinalBatch: true,
    idempotencyKey: "ignore-final-replay"
  })).ok, true);
  assert.equal(state.records["import-1"].status, "importing");
  assert.equal(state.records["import-1"].importedAt, null);
});

test("a zero-commit replay with a different mode returns a conflict and preserves the stored mode", async () => {
  const productOne = product("product-1");
  const productTwo = product("product-2", {
    name: "雅诗兰黛小棕瓶",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml"
  });
  const rowOne = previewRow();
  rowOne.previewProof = testProof("import-1", rowOne, productOne);
  const rowTwo = previewRow({
    rowNo: 2,
    rawName: "雅诗兰黛小棕瓶 50ml 2026-03 库存 8",
    baseName: "雅诗兰黛小棕瓶",
    specification: "50ml",
    stock: 8,
    matchedProductId: "product-2"
  });
  rowTwo.previewProof = testProof("import-1", rowTwo, productTwo);
  const { handler, state } = setup({
    products: [productOne, productTwo],
    previewItems: [rowOne, rowTwo]
  });

  assert.equal((await confirm(handler, rowOne, {
    mode: "add",
    isFinalBatch: false,
    idempotencyKey: "mode-add-first"
  })).ok, true);
  const replay = await confirm(handler, rowOne, {
    mode: "override",
    isFinalBatch: true,
    idempotencyKey: "mode-override-replay"
  });

  assert.equal(replay.ok, false);
  assert.equal(replay.code, "INVENTORY_IMPORT_MODE_CONFLICT");
  assert.equal(state.records["import-1"].mode, "add");
  assert.equal(state.records["import-1"].status, "importing");
});

test("an imported record rejects replay with a different mode before returning reused", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({
    products: [currentProduct],
    previewItems: [row],
    record: {
      status: "imported",
      mode: "add",
      successRows: 1,
      failedRows: 0,
      skippedRows: 0
    }
  });

  const result = await confirm(handler, row, {
    mode: "override",
    idempotencyKey: "completed-mode-conflict"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_MODE_CONFLICT");
  assert.equal(state.records["import-1"].mode, "add");
  assert.equal(state.records["import-1"].status, "imported");
});

test("an imported record reuses the completed result when the mode matches", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler } = setup({
    products: [currentProduct],
    previewItems: [row],
    record: {
      status: "imported",
      mode: "add",
      successRows: 1,
      failedRows: 0,
      skippedRows: 0
    }
  });

  const result = await confirm(handler, row, {
    mode: "add",
    idempotencyKey: "completed-mode-reuse"
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.reused, true);
  assert.equal(result.data.successRows, 1);
});

for (const entryPoint of ["serverBatch", "empty items"]) {
  for (const [requestedMode, expectedOk] of [["add", true], ["override", false]]) {
    test(`an imported record handles ${entryPoint} replay with ${requestedMode} mode`, async () => {
      const currentProduct = product("product-1");
      const row = previewRow();
      row.previewProof = testProof("import-1", row, currentProduct);
      const { handler, state } = setup({
        products: [currentProduct],
        previewItems: [row],
        record: {
          status: "imported",
          mode: "add",
          successRows: 1,
          failedRows: 0,
          skippedRows: 0
        }
      });
      const entryEvent = entryPoint === "serverBatch"
        ? { serverBatch: true, offset: 0, batchSize: 1 }
        : { items: [] };

      const result = await handler.main({
        importRecordId: "import-1",
        mode: requestedMode,
        idempotencyKey: `completed-${entryPoint}-${requestedMode}`,
        ...entryEvent
      });

      assert.equal(result.ok, expectedOk);
      if (expectedOk) {
        assert.equal(result.data.reused, true);
        assert.equal(result.data.successRows, 1);
      } else {
        assert.equal(result.code, "INVENTORY_IMPORT_MODE_CONFLICT");
      }
      assert.equal(state.records["import-1"].mode, "add");
      assert.equal(state.records["import-1"].status, "imported");
    });
  }
}

test("completed serverBatch does not treat stored legacy identity fields as request input", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  delete row.productIndex;
  delete row.skuCode;
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler } = setup({
    products: [currentProduct],
    previewItems: [row],
    record: {
      status: "imported",
      mode: "add",
      successRows: 1,
      failedRows: 0,
      skippedRows: 0
    }
  });

  const result = await handler.main({
    importRecordId: "import-1",
    mode: "add",
    serverBatch: true,
    idempotencyKey: "completed-server-batch-legacy-stored-row"
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.reused, true);
  assert.equal(result.data.successRows, 1);
});

test("unfinished serverBatch updates a stored legacy row with missing identity fields", async () => {
  const currentProduct = product("product-1");
  const row = previewRow();
  delete row.productIndex;
  delete row.skuCode;
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({ products: [currentProduct], previewItems: [row] });

  const result = await handler.main({
    importRecordId: "import-1",
    mode: "override",
    serverBatch: true,
    offset: 0,
    batchSize: 1,
    idempotencyKey: "unfinished-update-missing-identity"
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.successRows, 1);
  assert.equal(state.products["product-1"].stock, 12);
  assert.equal(state.records["import-1"].status, "imported");
});

test("unfinished serverBatch updates a stored legacy row with numeric identity fields", async () => {
  const currentProduct = product("product-1");
  const row = previewRow({ productIndex: 101, skuCode: 202 });
  row.previewProof = testProof("import-1", row, currentProduct);
  const { handler, state } = setup({ products: [currentProduct], previewItems: [row] });

  const result = await handler.main({
    importRecordId: "import-1",
    mode: "override",
    serverBatch: true,
    offset: 0,
    batchSize: 1,
    idempotencyKey: "unfinished-update-numeric-identity"
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.successRows, 1);
  assert.equal(state.products["product-1"].stock, 12);
  assert.equal(state.products["product-1"].productIndex, "101");
  assert.equal(state.products["product-1"].skuCode, "202");
});

test("unfinished serverBatch creates a stored legacy row with missing identity fields", async () => {
  const row = previewRow({
    matchedProductId: "",
    action: "create",
    baseName: "新商品",
    rawName: "新商品 400ml 2026-03 库存 12"
  });
  delete row.productIndex;
  delete row.skuCode;
  row.previewProof = testProof("import-1", row, null);
  const { handler, state } = setup({ products: [], previewItems: [row] });

  const result = await handler.main({
    importRecordId: "import-1",
    mode: "override",
    serverBatch: true,
    offset: 0,
    batchSize: 1,
    idempotencyKey: "unfinished-create-missing-identity"
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.successRows, 1);
  assert.equal(Object.keys(state.products).length, 1);
  assert.equal(state.products["product-created-1"].stock, 12);
  assert.equal(state.products["product-created-1"].skuCode, "");
});

test("unfinished serverBatch creates a stored legacy row with numeric identity fields", async () => {
  const row = previewRow({
    matchedProductId: "",
    action: "create",
    baseName: "新商品",
    rawName: "新商品 400ml 2026-03 库存 12",
    productIndex: 101,
    skuCode: 202
  });
  row.previewProof = testProof("import-1", row, null);
  const { handler, state } = setup({ products: [], previewItems: [row] });

  const result = await handler.main({
    importRecordId: "import-1",
    mode: "override",
    serverBatch: true,
    offset: 0,
    batchSize: 1,
    idempotencyKey: "unfinished-create-numeric-identity"
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.successRows, 1);
  assert.equal(Object.keys(state.products).length, 1);
  assert.equal(state.products["product-created-1"].productIndex, "101");
  assert.equal(state.products["product-created-1"].skuCode, "202");
});

test("unfinished serverBatch ignores a stored legacy row with missing identity fields", async () => {
  const row = previewRow({
    matchedProductId: "",
    action: "ignore",
    selected: false,
    baseName: "忽略商品",
    rawName: "忽略商品"
  });
  delete row.productIndex;
  delete row.skuCode;
  row.previewProof = testProof("import-1", row, null);
  const { handler, state } = setup({ products: [], previewItems: [row] });

  const result = await handler.main({
    importRecordId: "import-1",
    mode: "override",
    serverBatch: true,
    offset: 0,
    batchSize: 1,
    idempotencyKey: "unfinished-ignore-missing-identity"
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.skippedRows, 1);
  assert.equal(state.collections.import_record_items.length, 1);
  assert.equal(state.collections.import_record_items[0].action, "ignore");
  assert.equal(state.records["import-1"].status, "imported");
});

test("unfinished serverBatch ignores a stored legacy row with numeric identity fields", async () => {
  const row = previewRow({
    matchedProductId: "",
    action: "ignore",
    selected: false,
    baseName: "忽略商品",
    rawName: "忽略商品",
    productIndex: 101,
    skuCode: 202
  });
  row.previewProof = testProof("import-1", row, null);
  const { handler, state } = setup({ products: [], previewItems: [row] });

  const result = await handler.main({
    importRecordId: "import-1",
    mode: "override",
    serverBatch: true,
    offset: 0,
    batchSize: 1,
    idempotencyKey: "unfinished-ignore-numeric-identity"
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.skippedRows, 1);
  assert.equal(state.collections.import_record_items.length, 1);
  assert.equal(state.collections.import_record_items[0].action, "ignore");
  assert.equal(state.records["import-1"].status, "imported");
});

test("processed-row coverage fails conservatively when the bounded scan is truncated", async () => {
  const previewItems = Array.from({ length: 10001 }, (_, index) => previewRow({
    rowNo: index + 1,
    matchedProductId: "",
    action: "ignore",
    selected: false,
    baseName: `忽略商品-${index + 1}`,
    rawName: `忽略商品-${index + 1}`
  }));
  previewItems.forEach((item) => {
    item.previewProof = testProof("import-1", item, null);
  });
  const importItems = previewItems.map((item) => ({
    businessKey: `import_row:import-1:row:${item.rowNo}`,
    importRecordId: "import-1",
    rowNo: item.rowNo,
    action: "ignore",
    selected: false
  }));
  const { handler, state } = setup({
    products: [],
    previewItems,
    importItems
  });

  const result = await confirm(handler, previewItems[0], {
    isFinalBatch: true,
    idempotencyKey: "processed-row-scan-truncated"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVENTORY_IMPORT_PROCESSED_ROWS_TRUNCATED");
  assert.equal(state.records["import-1"].status, "parsed");
  assert.equal(state.records["import-1"].importedAt, undefined);
});
