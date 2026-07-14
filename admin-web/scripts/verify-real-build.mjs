import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import process from "node:process";

const distDir = resolve(process.cwd(), process.argv[2] || "dist");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".txt"]);
const forbidden = [
  { label: "demo password", pattern: /demo-pass/i },
  { label: "demo account", pattern: /\b(?:procurement|customer_service|finance|super_admin)\.demo\b/i },
  { label: "mock transport implementation", pattern: /\bMockTransport\b|MOCK_REQUEST_FAILED|\bmockRows\b/ },
  { label: "mock product data", pattern: /演示柔雾唇釉|演示修护精华|演示控油散粉|\bDEMO-10[1-9]\b/ },
  { label: "server-only action secret configuration", pattern: /ADMIN_WEB_ACTION_SECRET|X-Admin-Action-Secret/i }
];

const actionSecret = process.env.ADMIN_WEB_ACTION_SECRET?.trim() || "";

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (textExtensions.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
}

let files;
try {
  files = await collectFiles(distDir);
} catch (error) {
  process.stderr.write(`Real build verification could not read ${distDir}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (!files.length) {
  process.stderr.write(`Real build verification found no text assets in ${distDir}.\n`);
  process.exit(1);
}

const failures = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) failures.push(`${rule.label}: ${file}`);
  }
  if (actionSecret.length >= 12 && content.includes(actionSecret)) {
    failures.push(`configured action secret value: ${file}`);
  }
}

if (failures.length) {
  process.stderr.write("Real build contains forbidden mock data:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Real build verification passed (${files.length} text assets scanned).\n`);
