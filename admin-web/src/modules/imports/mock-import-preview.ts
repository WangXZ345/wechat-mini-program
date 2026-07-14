export type ImportMode = "quotes" | "inventory";

export interface ImportPreviewRow {
  row: number;
  sku: string;
  name: string;
  before: number;
  after: number;
  status: "changed" | "unchanged" | "new" | "error";
  message: string;
}

const quoteRows: ImportPreviewRow[] = [
  { row: 2, sku: "DEMO-101", name: "演示柔雾唇釉", before: 6500, after: 6900, status: "changed", message: "上涨 4.00 元" },
  { row: 3, sku: "DEMO-102", name: "演示修护精华", before: 15800, after: 15800, status: "unchanged", message: "无变化" },
  { row: 4, sku: "DEMO-109", name: "演示新商品", before: 0, after: 7900, status: "new", message: "待创建匹配" }
];

const inventoryRows: ImportPreviewRow[] = [
  { row: 2, sku: "DEMO-101", name: "演示柔雾唇釉", before: 246, after: 286, status: "changed", message: "增加 40" },
  { row: 3, sku: "DEMO-102", name: "演示修护精华", before: 54, after: 42, status: "changed", message: "减少 12" },
  { row: 4, sku: "DEMO-103", name: "演示控油散粉", before: 0, after: 0, status: "unchanged", message: "无变化" }
];

const invalidRows: Record<ImportMode, ImportPreviewRow> = {
  quotes: { row: 5, sku: "INVALID", name: "演示错误行", before: 0, after: -100, status: "error", message: "报价必须为非负整数分" },
  inventory: { row: 5, sku: "INVALID", name: "演示错误行", before: 12, after: -3, status: "error", message: "库存不能为负数" }
};

export function buildMockImportPreview(mode: ImportMode, fileName = ""): ImportPreviewRow[] {
  const rows = mode === "quotes" ? quoteRows : inventoryRows;
  const includeInvalidRow = /(?:invalid|error)/i.test(fileName);
  return includeInvalidRow ? [...rows, invalidRows[mode]] : [...rows];
}
