"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const {
  MAX_IMPORT_FILE_BYTES,
  buildMappedPreview,
  parseImportFile
} = require("../lib/importFileParser");

function file(name, mimeType, buffer, overrides = {}) {
  return {
    name,
    mimeType,
    size: buffer.length,
    contentBase64: buffer.toString("base64"),
    ...overrides
  };
}

function rejectsCode(operation, code) {
  return assert.rejects(operation, (error) => error && error.code === code, code);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipBuffer(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, source] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8");
    const compressed = zlib.deflateRawSync(content);
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    const local = Buffer.concat([localHeader, nameBuffer, compressed]);
    locals.push(local);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([centralHeader, nameBuffer]));
    offset += local.length;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, central, end]);
}

function forgeCentralUncompressedSizes(buffer, entryNames, declaredSize = 1) {
  const result = Buffer.from(buffer);
  const names = new Set(entryNames);
  for (let offset = 0; offset <= result.length - 46;) {
    if (result.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = result.readUInt16LE(offset + 28);
    const extraLength = result.readUInt16LE(offset + 30);
    const commentLength = result.readUInt16LE(offset + 32);
    const name = result.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (names.has(name)) result.writeUInt32LE(declaredSize, offset + 24);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

function realXlsx(overrides = {}) {
  const worksheet = overrides.worksheet || `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>A-1</t></is></c><c r="B2"><v>10</v></c></row>
      </sheetData>
    </worksheet>`;
  return zipBuffer({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": worksheet,
    ...(overrides.entries || {})
  });
}

test("validates file signatures and MIME instead of trusting the extension", async () => {
  await rejectsCode(
    () => parseImportFile(file("prices.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from("sku,price\nA,1"))),
    "IMPORT_FILE_SIGNATURE_MISMATCH"
  );
  await rejectsCode(
    () => parseImportFile(file("prices.csv", "application/pdf", Buffer.from("sku,price\nA,1"))),
    "IMPORT_FILE_MIME_INVALID"
  );
});

test("rejects oversized, size-mismatched and malformed UTF-8 text files", async () => {
  const oversized = Buffer.alloc(MAX_IMPORT_FILE_BYTES + 1, 0x61);
  await rejectsCode(() => parseImportFile(file("large.csv", "text/csv", oversized)), "IMPORT_FILE_TOO_LARGE");
  await rejectsCode(
    () => parseImportFile(file("wrong-size.csv", "text/csv", Buffer.from("a,b"), { size: 99 })),
    "IMPORT_FILE_SIZE_MISMATCH"
  );
  await rejectsCode(
    () => parseImportFile(file("broken.csv", "text/csv", Buffer.from([0x73, 0x6b, 0x75, 0x0a, 0xc3, 0x28]))),
    "IMPORT_FILE_ENCODING_INVALID"
  );
});

test("rejects duplicate normalized headers and formula, script or log injection cells", async () => {
  await rejectsCode(
    () => parseImportFile(file("duplicate.csv", "text/csv", Buffer.from("SKU, sku ,price\nA,A,10"))),
    "IMPORT_HEADER_DUPLICATE"
  );
  for (const dangerous of ["=WEBSERVICE(\"https://evil.invalid\")", "@SUM(1,1)", "\u001b[31mforged-log", "<script>alert(1)</script>"]) {
    const csv = Buffer.from(`sku,name,price\nA,"${dangerous.replaceAll('"', '""')}",10`);
    await rejectsCode(
      () => parseImportFile(file("dangerous.csv", "text/csv", csv)),
      "IMPORT_DANGEROUS_CELL"
    );
  }
});

test("rejects compatibility-normalized formula prefixes and scans columns beyond the header", async () => {
  for (const dangerous of ["-1+1", "  -42", "＝1＋1", "\u200b@SUM(1,1)"]) {
    const csv = Buffer.from(`sku,name,price\nA,"${dangerous}",10`);
    await rejectsCode(() => parseImportFile(file("dangerous.csv", "text/csv", csv)), "IMPORT_DANGEROUS_CELL");
  }
  await rejectsCode(
    () => parseImportFile(file("extra.csv", "text/csv", Buffer.from("sku,name\nA,Safe,=HYPERLINK(1)"))),
    "IMPORT_DANGEROUS_CELL"
  );
  await rejectsCode(
    () => parseImportFile(file("extra.csv", "text/csv", Buffer.from("sku,name\nA,Safe,extra"))),
    "IMPORT_COLUMN_COUNT_EXCEEDED"
  );
});

test("parses CSV and tab-delimited TXT then maps only selected headers", async () => {
  const parsed = await parseImportFile(file(
    "inventory.txt",
    "text/plain",
    Buffer.from("SKU\t商品名称\t库存\tignored\nA-1\t安全商品\t12\tdrop-me")
  ));
  const preview = buildMappedPreview(parsed, {
    sku: "SKU",
    name: "商品名称",
    value: "库存"
  }, { required: ["name", "value"] });

  assert.equal(parsed.fileType, "txt");
  assert.deepEqual(parsed.headers, ["SKU", "商品名称", "库存", "ignored"]);
  assert.deepEqual(preview.rows, [{
    row: 2,
    values: { sku: "A-1", name: "安全商品", value: "12" },
    status: "ready",
    code: "OK",
    message: "可处理"
  }]);
  assert.equal(Object.hasOwn(preview.rows[0].values, "ignored"), false);
  assert.match(preview.parseHash, /^[a-f0-9]{64}$/);
});

test("suggests an initial mapping only from the injected header profile", async () => {
  const parsed = await parseImportFile(file(
    "quotes.csv",
    "text/csv",
    Buffer.from("商品编号,商品名称,报价\nA-1,安全商品,1200")
  ));
  const preview = buildMappedPreview(parsed, {}, {
    required: ["name", "value"],
    aliases: {
      sku: ["sku", "商品编号"],
      name: ["name", "商品名称"],
      value: ["price", "报价"]
    }
  });
  assert.deepEqual(preview.mapping, { sku: "商品编号", name: "商品名称", value: "报价" });
  assert.equal(preview.counts.ready, 1);
});

test("parses a real xlsx through the runtime parser and fails closed for legacy xls", async () => {
  const xlsxBuffer = realXlsx();
  const xlsBuffer = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from("workbook")]);

  const parsed = await parseImportFile(file("prices.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsxBuffer));
  assert.equal(parsed.sheetName, "Inventory");
  assert.deepEqual(parsed.headers, ["SKU", "Price"]);
  assert.deepEqual(parsed.rows[0].cells, ["A-1", "10"]);
  await rejectsCode(() => parseImportFile(file("prices.xls", "application/vnd.ms-excel", xlsBuffer)), "IMPORT_FILE_TYPE_UNSUPPORTED");
});

test("rejects formulas, macros, external relationships and oversized expanded xlsx entries", async () => {
  const formula = realXlsx({
    worksheet: `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c></row><row r="2"><c r="A2"><f>HYPERLINK("https://evil.invalid")</f><v>1</v></c><c r="B2"><v>10</v></c></row></sheetData></worksheet>`
  });
  const selfClosingFormula = realXlsx({
    worksheet: `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c></row><row r="2"><c r="A2"><f/><v>1</v></c><c r="B2"><v>10</v></c></row></sheetData></worksheet>`
  });
  await rejectsCode(
    () => parseImportFile(file("formula.xlsx", "application/octet-stream", formula)),
    "IMPORT_DANGEROUS_CELL"
  );
  await rejectsCode(
    () => parseImportFile(file("self-closing-formula.xlsx", "application/octet-stream", selfClosingFormula)),
    "IMPORT_DANGEROUS_CELL"
  );
  await rejectsCode(
    () => parseImportFile(file("macro.xlsx", "application/octet-stream", realXlsx({ entries: { "xl/vbaProject.bin": Buffer.from("macro") } }))),
    "IMPORT_XLSX_UNSAFE_PACKAGE"
  );
  await rejectsCode(
    () => parseImportFile(file("external.xlsx", "application/octet-stream", realXlsx({ entries: { "xl/worksheets/_rels/sheet1.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" TargetMode="External" Target="https://evil.invalid"/></Relationships>` } }))),
    "IMPORT_XLSX_EXTERNAL_RELATIONSHIP"
  );
  await rejectsCode(
    () => parseImportFile(file("bomb.xlsx", "application/octet-stream", realXlsx({ entries: { "xl/theme/theme1.xml": "x".repeat(9 * 1024 * 1024) } }))),
    "IMPORT_XLSX_EXPANDED_SIZE_EXCEEDED"
  );
});

test("rejects numeric XML entity formula prefixes in real xlsx cells", async () => {
  const encodedFormula = realXlsx({
    worksheet: `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>&#xFF1D;1+1</t></is></c><c r="B2"><v>10</v></c></row></sheetData></worksheet>`
  });
  await rejectsCode(
    () => parseImportFile(file("entity-formula.xlsx", "application/octet-stream", encodedFormula)),
    "IMPORT_DANGEROUS_CELL"
  );
});

test("counts directory entries and rejects unneeded xlsx package objects", async () => {
  const directories = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`padding-${index}/`, ""]));
  await rejectsCode(
    () => parseImportFile(file("many-entries.xlsx", "application/octet-stream", realXlsx({ entries: directories }))),
    "IMPORT_XLSX_ENTRY_LIMIT_EXCEEDED"
  );
  await rejectsCode(
    () => parseImportFile(file("unneeded-object.xlsx", "application/octet-stream", realXlsx({ entries: { "xl/custom-object.dat": "not-needed" } }))),
    "IMPORT_XLSX_UNSAFE_PACKAGE"
  );
});

test("enforces actual streamed xlsx expansion limits when central directory sizes are forged", async () => {
  const perEntryName = "xl/theme/theme1.xml";
  const forgedEntry = forgeCentralUncompressedSizes(realXlsx({
    entries: { [perEntryName]: "x".repeat(8 * 1024 * 1024 + 1) }
  }), [perEntryName]);
  await rejectsCode(
    () => parseImportFile(file("forged-entry-size.xlsx", "application/octet-stream", forgedEntry)),
    "IMPORT_XLSX_EXPANDED_SIZE_EXCEEDED"
  );

  const totalNames = ["docProps/app.xml", "xl/styles.xml", "xl/theme/theme1.xml"];
  const expanded = "x".repeat(7 * 1024 * 1024);
  const oversizedTotal = realXlsx({
    entries: Object.fromEntries(totalNames.map((name) => [name, expanded]))
  });
  await rejectsCode(
    () => parseImportFile(file("total-size.xlsx", "application/octet-stream", oversizedTotal)),
    "IMPORT_XLSX_EXPANDED_SIZE_EXCEEDED"
  );
});
