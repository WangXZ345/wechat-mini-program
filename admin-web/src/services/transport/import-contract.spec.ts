import { describe, expect, it } from "vitest";
import { parseImportPreviewResult, parseImportReceiptPage } from "./import-contract";

describe("import preview transport contract", () => {
  it("accepts complete counts for a truncated 5000-row preview", () => {
    const parsed = parseImportPreviewResult({
      affected: 0,
      message: "ok",
      item: {
        importRecordId: "import-1",
        status: "previewed",
        fileHash: "a".repeat(64),
        parseHash: "b".repeat(64),
        fileType: "csv",
        headers: ["sku", "name", "stock"],
        mapping: { sku: "sku", name: "name", value: "stock" },
        rows: [],
        counts: { total: 5000, valid: 4999, failed: 1, ready: 4999, validation: 1, truncated: true },
        previewTruncated: true
      }
    });
    expect(parsed.status).toBe("previewed");
    if (parsed.status !== "mapping_required") {
      expect(parsed.counts.total).toBe(5000);
      expect(parsed.counts.failed).toBe(1);
      expect(parsed.counts.truncated).toBe(true);
    }
  });

  it("rejects inconsistent complete counts instead of trusting visible rows", () => {
    expect(() => parseImportPreviewResult({
      affected: 0,
      message: "bad",
      item: {
        importRecordId: "import-1",
        status: "previewed",
        fileHash: "a".repeat(64),
        parseHash: "b".repeat(64),
        fileType: "csv",
        headers: ["sku", "name", "stock"],
        mapping: { name: "name", value: "stock" },
        rows: [],
        counts: { total: 5000, valid: 5000, failed: 1, ready: 5000, validation: 1, truncated: true }
      }
    } as never)).toThrow("导入预览响应无效");
  });

  it("accepts the strict mapping_required union without a batch id", () => {
    const parsed = parseImportPreviewResult({
      affected: 0,
      message: "mapping",
      item: {
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
      }
    });
    expect(parsed.status).toBe("mapping_required");
    if (parsed.status === "mapping_required") expect(parsed.requiredFields).toEqual(["name", "value"]);
  });

  it("rejects malformed preview rows instead of rendering coerced receipt data", () => {
    expect(() => parseImportPreviewResult({
      affected: 0,
      message: "bad row",
      item: {
        importRecordId: "import-1",
        status: "previewed",
        fileHash: "a".repeat(64),
        parseHash: "b".repeat(64),
        fileType: "csv",
        headers: ["sku", "name", "stock"],
        mapping: { sku: "sku", name: "name", value: "stock" },
        rows: [{ row: 2, status: "ready", code: "OK", message: "可处理" }],
        counts: { total: 1, valid: 1, failed: 0, ready: 1, validation: 0, truncated: false },
        previewTruncated: false
      }
    } as never)).toThrow("导入预览响应无效");
  });
});

describe("import receipt cursor contract", () => {
  it("requires a non-numeric opaque cursor for a non-first page", () => {
    expect(() => parseImportReceiptPage({
      items: [], total: 3, page: 2, pageSize: 2, nextCursor: null
    }, { page: 2, pageSize: 2 })).toThrow("导入明细响应无效");
    expect(() => parseImportReceiptPage({
      items: [], total: 3, page: 1, pageSize: 2, nextCursor: "2"
    }, { page: 1, pageSize: 2 })).toThrow("导入明细响应无效");
  });
});
