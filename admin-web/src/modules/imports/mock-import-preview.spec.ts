import { describe, expect, it } from "vitest";
import { buildMockImportPreview } from "./mock-import-preview";

describe("buildMockImportPreview", () => {
  it("keeps a normal demo file confirmable", () => {
    const rows = buildMockImportPreview("quotes", "quotes.csv");
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.status === "error")).toBe(false);
  });

  it("retains an explicit invalid-file error path", () => {
    const rows = buildMockImportPreview("inventory", "inventory-invalid.xlsx");
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)).toMatchObject({ status: "error", after: -3 });
  });
});
