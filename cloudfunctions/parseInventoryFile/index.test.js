"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
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

function defaultProduct(overrides = {}) {
  return {
    _id: "product-1",
    name: "兰蔻粉水 2026-03",
    baseName: "兰蔻粉水 2026-03",
    specification: "400ml",
    productionDate: "",
    productIndex: "INDEX-1",
    skuCode: "SKU-1",
    stock: 5,
    warningStock: 10,
    price: 1000,
    isDeleted: false,
    ...overrides
  };
}

function loadParser({ products = [defaultProduct()] } = {}) {
  const state = {
    uploadedItems: null,
    record: null,
    recordUpdate: null
  };
  const db = {
    command: {
      neq(value) {
        return { __neq: value };
      }
    },
    serverDate: () => new Date("2026-07-23T00:00:00.000Z"),
    async createCollection() {},
    collection(name) {
      if (name === "products") {
        let skipValue = 0;
        let limitValue = Number.MAX_SAFE_INTEGER;
        const query = {
          orderBy() {
            return query;
          },
          skip(value) {
            skipValue = Number(value || 0);
            return query;
          },
          limit(value) {
            limitValue = Number(value);
            return query;
          },
          async get() {
            return { data: products.slice(skipValue, skipValue + limitValue) };
          }
        };
        return query;
      }
      if (name === "import_records") {
        return {
          async add({ data }) {
            state.record = data;
            return { _id: "import-1" };
          },
          doc(id) {
            assert.equal(id, "import-1");
            return {
              async update({ data }) {
                state.recordUpdate = data;
              }
            };
          }
        };
      }
      throw new Error(`unexpected collection ${name}`);
    }
  };
  const sdk = {
    DYNAMIC_CURRENT_ENV: "dynamic",
    init() {},
    database: () => db,
    async downloadFile({ fileID }) {
      assert.equal(fileID, "cloud://test/inventory.txt");
      return { fileContent: Buffer.from("兰蔻粉水 400ml 2026-03 库存 12", "utf8") };
    },
    async uploadFile({ cloudPath, fileContent }) {
      assert.equal(cloudPath, "inventory-import/previews/import-1.json");
      state.uploadedItems = JSON.parse(fileContent.toString("utf8"));
      return { fileID: "cloud://test/preview.json" };
    }
  };
  const auth = {
    async requirePermission(permission) {
      assert.equal(permission, "inventory:import");
      return { _id: "admin-1", openid: "admin-openid", role: "inventory", permissions: ["inventory:import"], isActive: true };
    }
  };
  const stockAlert = {
    normalizeWarningStock(value) {
      if (value === undefined || value === null || value === "") return 10;
      return Number(value);
    },
    getStockStatus(stock, warningStock) {
      return stock <= 0 ? "out_of_stock" : stock <= warningStock ? "warning" : "in_stock";
    }
  };

  delete require.cache[require.resolve(handlerPath)];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") return sdk;
    if (request === "xlsx") return {};
    if (parent && parent.filename === handlerPath && request === "./auth") return auth;
    if (parent && parent.filename === handlerPath && request === "./stockAlert") return stockAlert;
    return originalLoad.call(this, request, parent, isMain);
  };
  let parser;
  try {
    parser = require(handlerPath);
  } finally {
    Module._load = originalLoad;
  }
  return { parser, products, state };
}

test("parse preview stores a deterministic proof bound to the record, row, and matched product identity", async () => {
  const { parser, products, state } = loadParser();

  const result = await parser.main({
    fileID: "cloud://test/inventory.txt",
    fileName: "inventory.txt",
    mode: "override"
  });

  assert.equal(result.ok, true);
  assert.equal(state.uploadedItems.length, 1);
  assert.equal(state.uploadedItems[0].matchLevel, "exact");
  assert.equal(state.uploadedItems[0].matchedProductId, "product-1");
  assert.equal(state.uploadedItems[0].previewProof, testProof("import-1", state.uploadedItems[0], products[0]));
  assert.equal(state.recordUpdate.previewManifestHash, testManifest(state.uploadedItems));
});

test("canonical preview proof binds the row productIndex", () => {
  const { buildInventoryImportProof } = require("../common/inventoryImportProof");
  const row = {
    rowNo: 1,
    action: "update",
    source: "inventory",
    baseName: "兰蔻粉水",
    specification: "400ml",
    productionDate: "2026-03",
    matchedProductId: "product-1",
    productIndex: "PREVIEW-INDEX",
    skuCode: "PREVIEW-SKU"
  };
  const original = buildInventoryImportProof("import-1", row, defaultProduct());
  const tampered = buildInventoryImportProof("import-1", { ...row, productIndex: "TAMPERED-INDEX" }, defaultProduct());

  assert.notEqual(tampered, original);
});

test("canonical preview proof binds the row skuCode", () => {
  const { buildInventoryImportProof } = require("../common/inventoryImportProof");
  const row = {
    rowNo: 1,
    action: "update",
    source: "inventory",
    baseName: "兰蔻粉水",
    specification: "400ml",
    productionDate: "2026-03",
    matchedProductId: "product-1",
    productIndex: "PREVIEW-INDEX",
    skuCode: "PREVIEW-SKU"
  };
  const original = buildInventoryImportProof("import-1", row, defaultProduct());
  const tampered = buildInventoryImportProof("import-1", { ...row, skuCode: "TAMPERED-SKU" }, defaultProduct());

  assert.notEqual(tampered, original);
});

test("parse preview rejects multiple exact product matches instead of selecting the first one", async () => {
  const products = [
    defaultProduct(),
    defaultProduct({ _id: "product-2", productIndex: "INDEX-2", skuCode: "SKU-2" })
  ];
  const { parser, state } = loadParser({ products });

  const result = await parser.main({
    fileID: "cloud://test/inventory.txt",
    fileName: "inventory.txt",
    mode: "override"
  });

  assert.equal(result.ok, true);
  assert.equal(state.uploadedItems[0].matchLevel, "multiple");
  assert.equal(state.uploadedItems[0].action, "error");
  assert.equal(state.uploadedItems[0].matchedProductId, "");
  assert.equal(state.uploadedItems[0].candidates.length, 2);
});

test("parse and confirm share trimmed production-date identity semantics", async () => {
  const { parser, state } = loadParser({
    products: [defaultProduct({ productionDate: "   " })]
  });

  const result = await parser.main({
    fileID: "cloud://test/inventory.txt",
    fileName: "inventory.txt",
    mode: "override"
  });

  assert.equal(result.ok, true);
  assert.equal(state.uploadedItems[0].matchLevel, "exact");
  assert.equal(state.uploadedItems[0].matchedProductId, "product-1");
});

test("parse preview paginates beyond 1000 products before deciding a match is unique", async () => {
  const first = defaultProduct();
  const fillers = Array.from({ length: 999 }, (_, index) => defaultProduct({
    _id: `filler-${index}`,
    name: `填充商品-${index}`,
    baseName: `填充商品-${index}`,
    productIndex: `FILLER-${index}`,
    skuCode: `FILLER-${index}`
  }));
  const duplicateAfterFirstPage = defaultProduct({
    _id: "product-after-1000",
    productIndex: "INDEX-LATE",
    skuCode: "SKU-LATE"
  });
  const { parser, state } = loadParser({
    products: [first, ...fillers, duplicateAfterFirstPage]
  });

  const result = await parser.main({
    fileID: "cloud://test/inventory.txt",
    fileName: "inventory.txt",
    mode: "override"
  });

  assert.equal(result.ok, true);
  assert.equal(state.uploadedItems[0].matchLevel, "multiple");
  assert.equal(state.uploadedItems[0].action, "error");
  assert.equal(state.uploadedItems[0].candidates.length, 2);
});

test("parse and confirm deployable proof helpers are byte-identical to the canonical helper", () => {
  const canonical = path.join(__dirname, "..", "common", "inventoryImportProof.js");
  const copies = [
    path.join(__dirname, "common", "inventoryImportProof.js"),
    path.join(__dirname, "..", "confirmInventoryImport", "common", "inventoryImportProof.js")
  ];
  assert.equal(fs.existsSync(canonical), true);
  const canonicalSource = fs.readFileSync(canonical);
  for (const copy of copies) {
    assert.equal(fs.existsSync(copy), true);
    assert.deepEqual(fs.readFileSync(copy), canonicalSource);
  }
});
