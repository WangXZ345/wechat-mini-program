"use strict";

const crypto = require("crypto");

const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5000;
const MAX_IMPORT_HEADERS = 100;
const MAX_CELL_BYTES = 8192;
const MAX_PREVIEW_ROWS = 200;
const MAX_XLSX_ENTRIES = 128;
const MAX_XLSX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_XLSX_TOTAL_BYTES = 20 * 1024 * 1024;
const FILE_TYPES = new Set(["xlsx", "csv", "txt"]);
const MIME_TYPES = Object.freeze({
  xlsx: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream"
  ]),
  csv: new Set(["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"]),
  txt: new Set(["text/plain", "text/tab-separated-values"])
});

class ImportFileError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "ImportFileError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function fail(code, message, statusCode, details) {
  throw new ImportFileError(code, message, statusCode, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeFileName(value) {
  if (typeof value !== "string") fail("IMPORT_FILE_NAME_INVALID", "文件名无效");
  const name = value.trim();
  if (!name || name.length > 180 || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    fail("IMPORT_FILE_NAME_INVALID", "文件名无效");
  }
  return name;
}

function extensionOf(name) {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = match ? match[1] : "";
  if (!FILE_TYPES.has(extension)) fail("IMPORT_FILE_TYPE_UNSUPPORTED", "仅支持 xlsx、csv 或 txt 文件", 415);
  return extension;
}

function normalizeMime(value) {
  if (typeof value !== "string") fail("IMPORT_FILE_MIME_INVALID", "文件 MIME 类型无效", 415);
  return value.split(";", 1)[0].trim().toLowerCase();
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail("IMPORT_FILE_CONTENT_INVALID", "文件内容编码无效");
  }
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length || buffer.toString("base64") !== value) fail("IMPORT_FILE_CONTENT_INVALID", "文件内容编码无效");
  return buffer;
}

function startsWith(buffer, bytes) {
  return bytes.every((value, index) => buffer[index] === value);
}

function assertSignature(type, buffer) {
  if (type === "xlsx" && !startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    fail("IMPORT_FILE_SIGNATURE_MISMATCH", "文件内容与 xlsx 扩展名不一致", 415);
  }
  if ((type === "csv" || type === "txt") && buffer.includes(0)) {
    fail("IMPORT_FILE_SIGNATURE_MISMATCH", "文本文件包含二进制内容", 415);
  }
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch (_) {
    fail("IMPORT_FILE_ENCODING_INVALID", "文本文件必须使用 UTF-8 编码", 415);
  }
}

function normalizeHeader(value) {
  return String(value === undefined || value === null ? "" : value)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function displayCell(value) {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value).trim();
}

function dangerousCell(value) {
  if (typeof value !== "string") return false;
  if (Buffer.byteLength(value, "utf8") > MAX_CELL_BYTES) return true;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return true;
  const normalized = value.normalize("NFKC");
  const text = normalized.replace(/^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]+/iu, "");
  if (/^[=+\-@]/.test(text)) return true;
  if (/<\/?script\b|javascript\s*:|data\s*:\s*text\/html/i.test(text)) return true;
  return false;
}

function assertSafeCells(aoa) {
  for (const row of aoa) {
    for (const value of row) {
      if (dangerousCell(value)) fail("IMPORT_DANGEROUS_CELL", "文件包含公式、脚本或日志注入内容", 422);
    }
  }
}

function delimiterFor(text, type) {
  const first = text.split(/\r?\n/, 1)[0] || "";
  const counts = [
    ["\t", (first.match(/\t/g) || []).length],
    [",", (first.match(/,/g) || []).length],
    [";", (first.match(/;/g) || []).length]
  ].sort((left, right) => right[1] - left[1]);
  if (counts[0][1] === 0) {
    if (type === "txt") fail("IMPORT_HEADER_INVALID", "TXT 文件必须使用制表符、逗号或分号分隔");
    return ",";
  }
  return counts[0][0];
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) fail("IMPORT_FILE_PARSE_FAILED", "文件包含未闭合的引号");
  cells.push(current);
  return cells;
}

function parseText(buffer, type) {
  const text = decodeUtf8(buffer);
  const delimiter = delimiterFor(text, type);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  return lines.map((line) => parseDelimitedLine(line, delimiter));
}

function zipReader(dependencies) {
  if (dependencies && dependencies.JSZip) return dependencies.JSZip;
  try {
    return require("jszip");
  } catch (_) {
    fail("IMPORT_EXCEL_PARSER_UNAVAILABLE", "XLSX 解析依赖未安装", 500);
  }
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (entity, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(codePoint);
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlAttribute(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(source).match(new RegExp(`(?:^|\\s)${escaped}=(?:\"([^\"]*)\"|'([^']*)')`, "i"));
  return decodeXml(match ? match[1] === undefined ? match[2] : match[1] : "");
}

function assertSafeXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("IMPORT_XLSX_UNSAFE_PACKAGE", "XLSX 包含不安全 XML 声明", 422);
}

function columnIndexFromCellRef(reference) {
  const match = String(reference || "").match(/^([A-Z]+)[1-9][0-9]*$/i);
  if (!match) return null;
  let value = 0;
  for (const character of match[1].toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  const index = value - 1;
  if (!Number.isSafeInteger(index) || index >= MAX_IMPORT_HEADERS) {
    fail("IMPORT_HEADER_LIMIT_EXCEEDED", `表头最多 ${MAX_IMPORT_HEADERS} 列`, 413);
  }
  return index;
}

function textValues(xml, tagName) {
  const values = [];
  const expression = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match;
  while ((match = expression.exec(String(xml)))) values.push(decodeXml(match[1]));
  return values;
}

function parseSharedStringsXml(xml) {
  assertSafeXml(xml);
  return (String(xml).match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/gi) || [])
    .map((item) => textValues(item, "t").join(""));
}

function parseWorksheetXml(xml, sharedStrings) {
  assertSafeXml(xml);
  if (/<(?:[A-Za-z_][\w.-]*:)?f(?:\s|\/?>)/i.test(xml) || /<(?:[A-Za-z_][\w.-]*:)?hyperlink(?:\s|\/?>)/i.test(xml)) {
    fail("IMPORT_DANGEROUS_CELL", "Excel 文件包含公式、链接或脚本", 422);
  }
  const rows = [];
  const rowExpression = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/gi;
  let rowMatch;
  while ((rowMatch = rowExpression.exec(String(xml)))) {
    const cells = [];
    const cellExpression = /<c([^>]*)>([\s\S]*?)<\/c>/gi;
    let cellMatch;
    while ((cellMatch = cellExpression.exec(rowMatch[1]))) {
      const attributes = cellMatch[1] || "";
      const body = cellMatch[2] || "";
      const referenceIndex = columnIndexFromCellRef(xmlAttribute(attributes, "r"));
      const column = referenceIndex === null ? cells.length : referenceIndex;
      const type = xmlAttribute(attributes, "t");
      let value = "";
      if (type === "s") {
        const index = Number(textValues(body, "v")[0]);
        value = Number.isSafeInteger(index) && index >= 0 ? sharedStrings[index] || "" : "";
      } else if (type === "inlineStr") {
        value = textValues(body, "t").join("");
      } else {
        value = textValues(body, "v")[0] || "";
      }
      cells[column] = value;
    }
    rows.push(Array.from({ length: cells.length }, (_, index) => cells[index] === undefined ? "" : cells[index]));
  }
  return rows;
}

function normalizedZipPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function unsafeXlsxEntry(name) {
  return /(?:^|\/)(?:vbaProject\.bin|macrosheets|externalLinks|embeddings|oleObjects|activeX|customUI|connections\.xml|queryTables|pivotCache|printerSettings|media|drawings)(?:\/|$)/i.test(name)
    || /\.(?:bin|exe|dll|js|vbs|ps1)$/i.test(name);
}

function requiredXlsxEntry(name) {
  return /^\[Content_Types\]\.xml$/i.test(name)
    || /^_rels\/\.rels$/i.test(name)
    || /^docProps\/(?:app|core|custom)\.xml$/i.test(name)
    || /^xl\/workbook\.xml$/i.test(name)
    || /^xl\/_rels\/workbook\.xml\.rels$/i.test(name)
    || /^xl\/(?:sharedStrings|styles)\.xml$/i.test(name)
    || /^xl\/theme\/theme[1-9][0-9]*\.xml$/i.test(name)
    || /^xl\/worksheets\/sheet[1-9][0-9]*\.xml$/i.test(name);
}

function zipEntrySize(entry) {
  const value = entry && entry._data && entry._data.uncompressedSize;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function expandedSizeError() {
  return new ImportFileError("IMPORT_XLSX_EXPANDED_SIZE_EXCEEDED", "XLSX 解压后内容过大", 413);
}

function readBoundedZipEntry(entry, expandedState) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let entryBytes = 0;
    let settled = false;
    let stream;
    const failRead = (error) => {
      if (settled) return;
      settled = true;
      if (stream) stream.pause();
      reject(error instanceof ImportFileError
        ? error
        : new ImportFileError("IMPORT_FILE_PARSE_FAILED", "XLSX 文件无法解析", 422));
    };
    try {
      stream = entry.internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          if (settled) return;
          const data = Buffer.from(chunk);
          if (entryBytes + data.length > MAX_XLSX_ENTRY_BYTES
            || expandedState.bytes + data.length > MAX_XLSX_TOTAL_BYTES) {
            failRead(expandedSizeError());
            return;
          }
          entryBytes += data.length;
          expandedState.bytes += data.length;
          chunks.push(data);
        })
        .on("error", failRead)
        .on("end", () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks, entryBytes));
        })
        .resume();
    } catch (error) {
      failRead(error);
    }
  });
}

async function readBoundedZipEntries(entries) {
  const contents = new Map();
  const expandedState = { bytes: 0 };
  for (const entry of entries) {
    const name = normalizedZipPath(entry.name);
    contents.set(name, await readBoundedZipEntry(entry, expandedState));
  }
  return contents;
}

function readZipText(contents, name) {
  const content = contents.get(name);
  if (!content) return "";
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/^\uFEFF/, "");
  } catch (_) {
    fail("IMPORT_FILE_ENCODING_INVALID", "XLSX XML 必须使用 UTF-8 编码", 415);
  }
  assertSafeXml(text);
  return text;
}

function workbookSheets(workbookXml, relationshipsXml, availableSheetFiles) {
  const targets = new Map();
  const relationExpression = /<Relationship\b([^>]*)\/?\s*>/gi;
  let relation;
  while ((relation = relationExpression.exec(relationshipsXml))) {
    const id = xmlAttribute(relation[1], "Id");
    const target = normalizedZipPath(xmlAttribute(relation[1], "Target"));
    if (!id || !target) continue;
    const path = target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}`;
    targets.set(id, path);
  }
  const sheets = [];
  const sheetExpression = /<sheet\b([^>]*)\/?\s*>/gi;
  let sheet;
  while ((sheet = sheetExpression.exec(workbookXml))) {
    const relationshipId = xmlAttribute(sheet[1], "r:id");
    const path = targets.get(relationshipId);
    if (path && availableSheetFiles.has(path)) sheets.push({ sheetName: xmlAttribute(sheet[1], "name") || path, path });
  }
  return sheets.length ? sheets : Array.from(availableSheetFiles).sort().map((path) => ({ sheetName: path.split("/").pop(), path }));
}

async function parseWorkbook(buffer, dependencies) {
  const JSZip = zipReader(dependencies);
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch (error) {
    if (error instanceof ImportFileError) throw error;
    fail("IMPORT_FILE_PARSE_FAILED", "XLSX 文件无法解析", 422);
  }
  const allEntries = Object.values(zip.files || {}).filter(Boolean);
  if (allEntries.length > MAX_XLSX_ENTRIES) fail("IMPORT_XLSX_ENTRY_LIMIT_EXCEEDED", "XLSX 文件条目过多", 413);
  for (const entry of allEntries) {
    const name = normalizedZipPath(entry.unsafeOriginalName || entry.name);
    if (!name || name.includes("../") || name.startsWith("..") || unsafeXlsxEntry(name)) {
      fail("IMPORT_XLSX_UNSAFE_PACKAGE", "XLSX 包含宏或不需要的嵌入对象", 422);
    }
  }
  const entries = allEntries.filter((entry) => !entry.dir);
  if (!entries.length) fail("IMPORT_FILE_EMPTY", "Excel 文件没有可解析的数据", 422);
  let expandedBytes = 0;
  for (const entry of entries) {
    const size = zipEntrySize(entry);
    if (size === null) fail("IMPORT_XLSX_UNSAFE_PACKAGE", "XLSX 条目大小无效", 422);
    if (size > MAX_XLSX_ENTRY_BYTES) fail("IMPORT_XLSX_EXPANDED_SIZE_EXCEEDED", "XLSX 单个条目解压后过大", 413);
    expandedBytes += size;
    if (expandedBytes > MAX_XLSX_TOTAL_BYTES) fail("IMPORT_XLSX_EXPANDED_SIZE_EXCEEDED", "XLSX 解压后内容过大", 413);
  }
  if (entries.some((entry) => {
    const name = normalizedZipPath(entry.name);
    return !requiredXlsxEntry(name) && !/\.rels$/i.test(name);
  })) {
    fail("IMPORT_XLSX_UNSAFE_PACKAGE", "XLSX 包含不需要的包对象", 422);
  }
  const contents = await readBoundedZipEntries(entries);
  for (const entry of entries.filter((item) => /\.rels$/i.test(item.name))) {
    const xml = readZipText(contents, normalizedZipPath(entry.name));
    if (/TargetMode\s*=\s*(?:"External"|'External')/i.test(xml)) {
      fail("IMPORT_XLSX_EXTERNAL_RELATIONSHIP", "XLSX 包含外部关系", 422);
    }
  }
  if (entries.some((entry) => !requiredXlsxEntry(normalizedZipPath(entry.name)))) {
    fail("IMPORT_XLSX_UNSAFE_PACKAGE", "XLSX 包含不需要的包对象", 422);
  }
  const contentTypes = readZipText(contents, "[Content_Types].xml");
  if (!contentTypes || /macroEnabled|vbaProject|oleObject|externalLink|activeX/i.test(contentTypes)) {
    fail("IMPORT_XLSX_UNSAFE_PACKAGE", "XLSX 内容类型不安全", 422);
  }
  const workbookXml = readZipText(contents, "xl/workbook.xml");
  const relationshipsXml = readZipText(contents, "xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relationshipsXml) fail("IMPORT_FILE_PARSE_FAILED", "XLSX 工作簿结构不完整", 422);
  const sharedStringsXml = readZipText(contents, "xl/sharedStrings.xml");
  const sharedStrings = sharedStringsXml ? parseSharedStringsXml(sharedStringsXml) : [];
  assertSafeCells([sharedStrings]);
  const availableSheetFiles = new Set(entries.map((entry) => normalizedZipPath(entry.name)).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)));
  const sheetDefinitions = workbookSheets(workbookXml, relationshipsXml, availableSheetFiles);
  let selected = null;
  for (const definition of sheetDefinitions) {
    const xml = readZipText(contents, definition.path);
    const aoa = parseWorksheetXml(xml, sharedStrings);
    assertSafeCells(aoa);
    const score = aoa.slice(0, 12).reduce((best, row) => Math.max(best, Array.isArray(row) ? row.filter((value) => String(value).trim()).length : 0), 0);
    if (!selected || score > selected.score) selected = { sheetName: definition.sheetName, aoa, score };
  }
  if (!selected || !selected.aoa.length) fail("IMPORT_FILE_EMPTY", "Excel 文件没有可解析的数据", 422);
  return selected;
}

function chooseHeaderIndex(aoa) {
  let selected = { index: -1, score: 0 };
  aoa.slice(0, 12).some((row, index) => {
    const score = Array.isArray(row) ? row.filter((value) => String(value).trim()).length : 0;
    if (score < 2) return false;
    selected = { index, score };
    return true;
  });
  if (selected.index < 0 || selected.score < 2) fail("IMPORT_HEADER_INVALID", "文件缺少可识别的表头", 422);
  return selected.index;
}

function normalizeTable(aoa) {
  if (!Array.isArray(aoa) || !aoa.length) fail("IMPORT_FILE_EMPTY", "文件没有可解析的数据", 422);
  assertSafeCells(aoa);
  const headerIndex = chooseHeaderIndex(aoa);
  const sourceHeaders = aoa[headerIndex].map(displayCell);
  if (sourceHeaders.length > MAX_IMPORT_HEADERS) fail("IMPORT_HEADER_LIMIT_EXCEEDED", `表头最多 ${MAX_IMPORT_HEADERS} 列`, 413);
  const normalized = new Set();
  const headers = sourceHeaders.map((header, index) => {
    const value = String(header || "").trim();
    if (!value) fail("IMPORT_HEADER_INVALID", `第 ${index + 1} 列表头为空`, 422);
    if (dangerousCell(value)) fail("IMPORT_DANGEROUS_CELL", "表头包含公式、脚本或日志注入内容", 422);
    const key = normalizeHeader(value);
    if (normalized.has(key)) fail("IMPORT_HEADER_DUPLICATE", "文件包含重复表头", 422);
    normalized.add(key);
    return value;
  });
  const rows = [];
  for (let index = headerIndex + 1; index < aoa.length; index += 1) {
    const source = Array.isArray(aoa[index]) ? aoa[index] : [];
    if (source.length > headers.length) fail("IMPORT_COLUMN_COUNT_EXCEEDED", "数据列数不能超过表头列数", 422);
    const cells = headers.map((_, column) => displayCell(source[column]));
    if (!cells.some((value) => String(value).trim())) continue;
    rows.push({ row: index + 1, cells });
    if (rows.length > MAX_IMPORT_ROWS) fail("IMPORT_ROW_LIMIT_EXCEEDED", `文件最多 ${MAX_IMPORT_ROWS} 行`, 413);
  }
  if (!rows.length) fail("IMPORT_FILE_EMPTY", "文件没有可导入的数据", 422);
  assertSafeCells(rows.map((row) => row.cells));
  return { headers, rows, headerRow: headerIndex + 1 };
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function mappingHash(mapping) {
  return sha256(Buffer.from(stableSerialize(mapping || {}), "utf8"));
}

async function parseImportFile(rawFile, dependencies = {}) {
  if (!isPlainObject(rawFile)) fail("IMPORT_FILE_INVALID", "文件内容无效");
  const allowed = new Set(["name", "mimeType", "size", "contentBase64"]);
  if (Object.keys(rawFile).some((key) => !allowed.has(key))) fail("IMPORT_FILE_INVALID", "文件包含不允许的字段");
  const name = safeFileName(rawFile.name);
  const fileType = extensionOf(name);
  const mimeType = normalizeMime(rawFile.mimeType);
  if (!MIME_TYPES[fileType].has(mimeType)) fail("IMPORT_FILE_MIME_INVALID", "文件 MIME 类型与格式不匹配", 415);
  if (!Number.isSafeInteger(rawFile.size) || rawFile.size <= 0) fail("IMPORT_FILE_SIZE_INVALID", "文件大小无效");
  if (rawFile.size > MAX_IMPORT_FILE_BYTES) fail("IMPORT_FILE_TOO_LARGE", "文件不能超过 10 MB", 413);
  const buffer = decodeBase64(rawFile.contentBase64);
  if (buffer.length !== rawFile.size) fail("IMPORT_FILE_SIZE_MISMATCH", "文件大小与内容不一致", 409);
  assertSignature(fileType, buffer);
  let aoa;
  let sheetName = "";
  if (fileType === "csv" || fileType === "txt") {
    aoa = parseText(buffer, fileType);
  } else {
    const parsed = await parseWorkbook(buffer, dependencies);
    aoa = parsed.aoa;
    sheetName = parsed.sheetName;
  }
  const table = normalizeTable(aoa);
  const parseContextHash = sha256(Buffer.from(stableSerialize({
    fileHash: sha256(buffer),
    fileType,
    sheetName,
    headerRow: table.headerRow,
    headers: table.headers,
    rowCount: table.rows.length
  }), "utf8"));
  return {
    name,
    mimeType,
    size: buffer.length,
    fileType,
    fileHash: sha256(buffer),
    parseContextHash,
    sheetName,
    ...table
  };
}

function normalizeMapping(mapping, headers) {
  if (!isPlainObject(mapping)) fail("IMPORT_MAPPING_INVALID", "表头映射无效");
  const headerLookup = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const selected = new Set();
  const normalized = {};
  for (const [target, source] of Object.entries(mapping)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(target) || typeof source !== "string") {
      fail("IMPORT_MAPPING_INVALID", "表头映射无效");
    }
    const actual = headerLookup.get(normalizeHeader(source));
    if (!actual) fail("IMPORT_MAPPING_HEADER_MISSING", "所选表头不存在", 409);
    const sourceKey = normalizeHeader(actual);
    if (selected.has(sourceKey)) fail("IMPORT_MAPPING_DUPLICATE", "同一表头不能映射到多个字段", 422);
    selected.add(sourceKey);
    normalized[target] = actual;
  }
  return normalized;
}

function suggestedMapping(headers, profile, supplied) {
  const result = { ...supplied };
  const aliases = profile && isPlainObject(profile.aliases) ? profile.aliases : {};
  const lookup = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const selected = new Set(Object.values(result).map(normalizeHeader));
  for (const [target, candidates] of Object.entries(aliases)) {
    if (result[target] || !Array.isArray(candidates)) continue;
    const source = candidates.map((candidate) => lookup.get(normalizeHeader(candidate))).find((header) => header && !selected.has(normalizeHeader(header)));
    if (!source) continue;
    result[target] = source;
    selected.add(normalizeHeader(source));
  }
  return result;
}

function buildMappedPreview(parsed, rawMapping, profile = {}) {
  if (!parsed || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) fail("IMPORT_PARSE_RESULT_INVALID", "解析结果无效", 500);
  const supplied = normalizeMapping(rawMapping, parsed.headers);
  const mapping = normalizeMapping(suggestedMapping(parsed.headers, profile, supplied), parsed.headers);
  const required = Array.isArray(profile.required) ? profile.required : [];
  const missingMapping = required.filter((field) => !mapping[field]);
  if (missingMapping.length) fail("IMPORT_MAPPING_REQUIRED", "请完成必填表头映射", 422, {
    headers: parsed.headers.slice(),
    suggestedMapping: mapping,
    requiredFields: required.slice(),
    mappingErrors: missingMapping.map((field) => ({ field, code: "IMPORT_MAPPING_REQUIRED", message: "请选择对应表头" })),
    fileHash: parsed.fileHash,
    parseContext: {
      hash: parsed.parseContextHash,
      fileType: parsed.fileType,
      sheetName: parsed.sheetName,
      headerRow: parsed.headerRow,
      rowCount: parsed.rows.length
    }
  });
  const positions = Object.fromEntries(Object.entries(mapping).map(([target, header]) => [target, parsed.headers.indexOf(header)]));
  const allRows = parsed.rows.map((row) => {
    const values = Object.fromEntries(Object.entries(positions).map(([target, index]) => [target, row.cells[index]]));
    const missing = required.filter((field) => String(values[field] === undefined ? "" : values[field]).trim() === "");
    return {
      row: row.row,
      values,
      status: missing.length ? "validation" : "ready",
      code: missing.length ? "IMPORT_REQUIRED_VALUE_MISSING" : "OK",
      message: missing.length ? "必填字段为空" : "可处理"
    };
  });
  const counts = {
    total: allRows.length,
    valid: allRows.filter((row) => row.status === "ready").length,
    failed: allRows.filter((row) => row.status === "validation").length,
    ready: allRows.filter((row) => row.status === "ready").length,
    validation: allRows.filter((row) => row.status === "validation").length,
    truncated: allRows.length > MAX_PREVIEW_ROWS
  };
  const parseHash = sha256(Buffer.from(stableSerialize({
    fileType: parsed.fileType,
    headers: parsed.headers,
    mapping,
    rows: allRows.map((row) => ({ row: row.row, values: row.values }))
  }), "utf8"));
  return {
    mapping,
    mappingHash: mappingHash(mapping),
    parseHash,
    counts,
    allRows,
    rows: allRows.slice(0, MAX_PREVIEW_ROWS),
    previewTruncated: allRows.length > MAX_PREVIEW_ROWS
  };
}

module.exports = {
  FILE_TYPES,
  ImportFileError,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_HEADERS,
  MAX_IMPORT_ROWS,
  MAX_PREVIEW_ROWS,
  MAX_XLSX_ENTRIES,
  MAX_XLSX_ENTRY_BYTES,
  MAX_XLSX_TOTAL_BYTES,
  buildMappedPreview,
  mappingHash,
  normalizeHeader,
  parseImportFile,
  stableSerialize
};
