"use strict";

const crypto = require("crypto");

const INVENTORY_IMPORT_PROOF_VERSION = "inventory-import-preview-v1";
const INVENTORY_IMPORT_MANIFEST_VERSION = "inventory-import-manifest-v1";
const PRODUCT_SCAN_PAGE_SIZE = 500;
const PRODUCT_SCAN_MAX_ROWS = 10000;

function normalizeProofText(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function normalizePreviewRowIdentity(row = {}) {
  return {
    rowNo: Number(row.rowNo || 0),
    action: normalizeProofText(row.action),
    source: row.source === "quote" ? "quote" : "inventory",
    baseName: normalizeProofText(row.baseName),
    specification: normalizeProofText(row.specification),
    productionDate: normalizeProofText(row.productionDate),
    matchedProductId: normalizeProofText(row.matchedProductId),
    productIndex: normalizeProofText(row.productIndex),
    skuCode: normalizeProofText(row.skuCode)
  };
}

function normalizeProductIdentity(product) {
  if (!product) return null;
  return {
    id: normalizeProofText(product._id || product.id),
    name: normalizeProofText(product.name),
    baseName: normalizeProofText(product.baseName),
    specification: normalizeProofText(product.specification),
    productionDate: normalizeProofText(product.productionDate),
    productIndex: normalizeProofText(product.productIndex),
    skuCode: normalizeProofText(product.skuCode)
  };
}

function canonicalInventoryImportProofPayload(importRecordId, row, product) {
  return {
    version: INVENTORY_IMPORT_PROOF_VERSION,
    importRecordId: normalizeProofText(importRecordId),
    row: normalizePreviewRowIdentity(row),
    product: normalizeProductIdentity(product)
  };
}

function canonicalizeInventoryImportValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeInventoryImportValue);
  if (!value || typeof value !== "object") return value;
  const output = {};
  Object.keys(value).sort().forEach((key) => {
    const item = value[key];
    if (item === undefined || typeof item === "function") return;
    output[key] = canonicalizeInventoryImportValue(item);
  });
  return output;
}

function buildInventoryImportProof(importRecordId, row, product) {
  const canonical = JSON.stringify(canonicalInventoryImportProofPayload(importRecordId, row, product));
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  return `${INVENTORY_IMPORT_PROOF_VERSION}:${hash}`;
}

function buildInventoryImportManifestHash(items) {
  const canonical = JSON.stringify(canonicalizeInventoryImportValue(Array.isArray(items) ? items : []));
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  return `${INVENTORY_IMPORT_MANIFEST_VERSION}:${hash}`;
}

function normalizeInventoryMatchText(value) {
  return normalizeProofText(value).replace(/\s+/g, "").toLowerCase();
}

function productMatchesInventoryIdentity(product, row) {
  return Boolean(product) &&
    product.isDeleted !== true &&
    normalizeInventoryMatchText(product.name) === normalizeInventoryMatchText(row && row.baseName) &&
    normalizeInventoryMatchText(product.specification) === normalizeInventoryMatchText(row && row.specification) &&
    normalizeProofText(product.productionDate) === normalizeProofText(row && row.productionDate);
}

async function scanInventoryProducts(collection, {
  pageSize = PRODUCT_SCAN_PAGE_SIZE,
  maxRows = PRODUCT_SCAN_MAX_ROWS
} = {}) {
  const safePageSize = Math.max(1, Math.min(PRODUCT_SCAN_PAGE_SIZE, Number(pageSize || PRODUCT_SCAN_PAGE_SIZE)));
  const safeMaxRows = Math.max(safePageSize, Math.min(PRODUCT_SCAN_MAX_ROWS, Number(maxRows || PRODUCT_SCAN_MAX_ROWS)));
  const products = [];
  let offset = 0;
  while (offset < safeMaxRows) {
    const limit = Math.min(safePageSize, safeMaxRows - offset);
    const result = await collection
      .orderBy("_id", "asc")
      .skip(offset)
      .limit(limit)
      .get();
    const page = Array.isArray(result && result.data) ? result.data : [];
    products.push(...page);
    if (page.length < limit) return { products, truncated: false };
    offset += page.length;
  }
  return { products, truncated: true };
}

function samePreviewRowIdentity(left, right) {
  return JSON.stringify(normalizePreviewRowIdentity(left)) === JSON.stringify(normalizePreviewRowIdentity(right));
}

module.exports = {
  INVENTORY_IMPORT_MANIFEST_VERSION,
  INVENTORY_IMPORT_PROOF_VERSION,
  PRODUCT_SCAN_MAX_ROWS,
  PRODUCT_SCAN_PAGE_SIZE,
  buildInventoryImportManifestHash,
  buildInventoryImportProof,
  canonicalizeInventoryImportValue,
  canonicalInventoryImportProofPayload,
  normalizePreviewRowIdentity,
  normalizeProductIdentity,
  normalizeInventoryMatchText,
  normalizeProofText,
  productMatchesInventoryIdentity,
  scanInventoryProducts,
  samePreviewRowIdentity
};
