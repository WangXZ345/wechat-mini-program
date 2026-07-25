"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repositoryRoot = path.join(__dirname, "../..");
const scriptPath = path.join(repositoryRoot, "scripts/package-auto-review-order.ps1");
let tempRoot;

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

test.after(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("source tree contains exact self-contained canonical dependency copies", () => {
  for (const [fileName, canonicalDirectory] of [
    ["inventoryMutationService.js", "cloudfunctions/common/services"],
    ["orderApprovalService.js", "cloudfunctions/common/services"],
    ["orderStatusPolicy.js", "cloudfunctions/common"],
    ["syncEvents.js", "cloudfunctions/common"]
  ]) {
    assert.equal(
      fs.readFileSync(path.join(__dirname, fileName), "utf8"),
      fs.readFileSync(path.join(repositoryRoot, canonicalDirectory, fileName), "utf8"),
      `${fileName} must be an exact canonical source copy`
    );
  }
});

test("auto-review package flattens and hash-verifies canonical deployment dependencies", () => {
  const script = fs.readFileSync(scriptPath, "utf8");
  assert.match(
    script,
    /\$canonicalInventoryMutationService\s*=\s*Join-Path \$root "cloudfunctions\\common\\services\\inventoryMutationService\.js"/
  );
  assert.match(
    script,
    /\$canonicalOrderApprovalService\s*=\s*Join-Path \$root "cloudfunctions\\common\\services\\orderApprovalService\.js"/
  );
  assert.match(
    script,
    /\$canonicalOrderStatusPolicy\s*=\s*Join-Path \$root "cloudfunctions\\common\\orderStatusPolicy\.js"/
  );
  assert.match(
    script,
    /\$canonicalSyncEvents\s*=\s*Join-Path \$root "cloudfunctions\\common\\syncEvents\.js"/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalInventoryMutationService -Destination \(Join-Path \$target "inventoryMutationService\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalOrderApprovalService -Destination \(Join-Path \$target "orderApprovalService\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalOrderStatusPolicy -Destination \(Join-Path \$target "orderStatusPolicy\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalSyncEvents -Destination \(Join-Path \$target "syncEvents\.js"\) -Force/
  );
  assert.match(script, /Canonical auto-review dependency hash verification failed/);
  assert.match(script, /uploadPerformed\s*=\s*\$false/);
});

test("auto-review package executes locally with one deployable function and exact canonical hashes", () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-package-"));
  const output = path.join(tempRoot, "package");
  const result = childProcess.spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-RepositoryRoot", repositoryRoot,
      "-OutputDirectory", output
    ],
    {
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true
    }
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const target = path.join(output, "autoReviewOrder");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(output, "package-manifest.json"), "utf8").replace(/^\uFEFF/, "")
  );
  assert.deepEqual(manifest.functions, ["autoReviewOrder"]);
  assert.equal(manifest.uploadPerformed, false);
  assert.equal(fs.existsSync(path.join(target, "index.js")), true);
  assert.equal(fs.existsSync(path.join(target, "handler.js")), true);
  assert.equal(fs.existsSync(path.join(target, "handler.test.js")), false);
  assert.equal(fs.existsSync(path.join(target, "node_modules")), false);
  assert.doesNotThrow(() => require(path.join(target, "handler.js")));
  assert.deepEqual(
    fs.readdirSync(target, { recursive: true })
      .filter((entry) => /\.(test|spec)\.js$/i.test(String(entry))),
    []
  );
  assert.equal(
    sha256(path.join(target, "inventoryMutationService.js")),
    sha256(path.join(repositoryRoot, "cloudfunctions/common/services/inventoryMutationService.js"))
  );
  assert.equal(
    sha256(path.join(target, "orderApprovalService.js")),
    sha256(path.join(repositoryRoot, "cloudfunctions/common/services/orderApprovalService.js"))
  );
  assert.equal(
    sha256(path.join(target, "orderStatusPolicy.js")),
    sha256(path.join(repositoryRoot, "cloudfunctions/common/orderStatusPolicy.js"))
  );
  assert.equal(
    manifest.canonicalOrderStatusPolicySha256,
    sha256(path.join(repositoryRoot, "cloudfunctions/common/orderStatusPolicy.js"))
  );
  assert.equal(
    sha256(path.join(target, "syncEvents.js")),
    sha256(path.join(repositoryRoot, "cloudfunctions/common/syncEvents.js"))
  );
  assert.equal(
    manifest.canonicalSyncEventsSha256,
    sha256(path.join(repositoryRoot, "cloudfunctions/common/syncEvents.js"))
  );
  assert.equal(
    sha256(path.join(target, "stockAlert.js")),
    sha256(path.join(repositoryRoot, "cloudfunctions/_utils/stockAlert.js"))
  );
});
