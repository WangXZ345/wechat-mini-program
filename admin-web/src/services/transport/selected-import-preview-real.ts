import type { ImportMode, ImportPreviewRow } from "@/modules/imports/mock-import-preview";

export function buildMockImportPreview(_mode: ImportMode, _fileName = ""): ImportPreviewRow[] {
  void _mode;
  void _fileName;
  throw new Error("Mock import preview cannot run in real data mode");
}
