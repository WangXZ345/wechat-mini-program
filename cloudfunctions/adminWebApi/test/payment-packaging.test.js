"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const {
  REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES
} = require("../../common/services/refundMutationService");

const scriptPath = path.join(
  __dirname,
  "../../../scripts/package-admin-web-cloudfunctions.ps1"
);
const repositoryRoot = path.join(__dirname, "../../..");
const deploymentDocumentPath = path.join(
  repositoryRoot,
  "docs/web-admin-test-deployment-and-rollback.md"
);
let fixture;

function copyInstalledRuntimePackage(packageName, fromDirectory, destinationNodeModules, visited = new Map()) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [fromDirectory] });
  const packageDirectory = path.dirname(packageJsonPath);
  const metadata = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (visited.has(metadata.name)) {
    assert.equal(visited.get(metadata.name), metadata.version, `runtime package version conflict: ${metadata.name}`);
    return;
  }
  visited.set(metadata.name, metadata.version);
  const destination = path.join(destinationNodeModules, metadata.name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(packageDirectory, destination, {
    recursive: true,
    filter(sourcePath) {
      const name = path.basename(sourcePath);
      const relative = path.relative(packageDirectory, sourcePath);
      return !relative.split(path.sep).includes("node_modules")
        && !["test", "tests", "__tests__", ".github"].includes(name)
        && !/\.(?:test|spec)\.js$/i.test(name);
    }
  });
  for (const dependency of Object.keys(metadata.dependencies || {})) {
    copyInstalledRuntimePackage(dependency, packageDirectory, destinationNodeModules, visited);
  }
}

function readPackagingScript() {
  return fs.readFileSync(scriptPath, "utf8");
}

function fixtureRoot() {
  if (fixture) return fixture;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refund-packaging-"));
  const root = path.join(tempRoot, "repository");
  const source = path.join(repositoryRoot, "cloudfunctions");
  const target = path.join(root, "cloudfunctions");
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.split(path.sep).includes("node_modules");
    }
  });
  copyInstalledRuntimePackage(
    "jszip",
    path.join(source, "adminWebApi"),
    path.join(target, "adminWebApi", "node_modules")
  );
  fixture = { tempRoot, root };
  return fixture;
}

function runPackaging(name) {
  const current = fixtureRoot();
  const output = path.join(current.tempRoot, "outputs", name);
  const result = childProcess.spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-RepositoryRoot", current.root,
      "-OutputDirectory", output
    ],
    {
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true
    }
  );
  return { ...result, output, manifestPath: path.join(output, "package-manifest.json") };
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function deploymentDocumentFunctions() {
  const document = fs.readFileSync(deploymentDocumentPath, "utf8");
  const section = document.split("## 4. 云函数部署清单与打包边界")[1]
    .split("### 4.1 临时打包规则")[0];
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
}

test.after(() => {
  if (fixture) fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
});

test("guarded package includes adminUpdatePayment in the exact A-Z function list", () => {
  const script = readPackagingScript();

  assert.match(
    script,
    /\$paymentUpdateSource\s*=\s*Join-Path \$root "cloudfunctions\\adminUpdatePayment"/
  );
  assert.match(
    script,
    /functions\s*=\s*@\("adminDashboard", "adminGetCustomerAccountDetail", "adminListCustomerAccounts", "adminReviewOrder", "adminUpdatePayment", "adminWebApi", "adminWebAuth", "afterSales", "batchUpdateProductTags", "cancelOrder", "cleanupSyncEvents", "getOrders", "getSyncEvents", "getUnsoldProducts", "manageProduct", "recalculateCustomerAccount", "shipmentGroups", "updateProductPrice", "updateProductWarningStock"\)/
  );
});

test("guarded package includes afterSales and the canonical review service hash gate", () => {
  const script = readPackagingScript();

  assert.match(
    script,
    /\$afterSalesSource\s*=\s*Join-Path \$root "cloudfunctions\\afterSales"/
  );
  assert.match(script, /Assert-File \(Join-Path \$afterSalesSource "index\.js"\)/);
  assert.match(script, /Copy-SourceTree \$afterSalesSource \$afterSalesTarget/);
  assert.match(
    script,
    /\$canonicalAfterSaleReviewService\s*=\s*Join-Path \$root "cloudfunctions\\common\\services\\afterSaleReviewService\.js"/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalAfterSaleReviewService -Destination \(Join-Path \$apiTarget "lib\\afterSaleReviewService\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalAfterSaleReviewService -Destination \(Join-Path \$afterSalesTarget "common\\services\\afterSaleReviewService\.js"\) -Force/
  );
  assert.match(script, /Canonical after-sale review service hash verification failed/);
  assert.match(script, /canonicalAfterSaleReviewServiceSha256\s*=\s*\$afterSaleReviewServiceSourceHash/);
  assert.match(script, /AfterSaleReviewServiceHashVerified\s*=\s*\$true/);
});

test("guarded package flattens and hash-verifies the shared order approval primitive", () => {
  const script = readPackagingScript();

  assert.match(
    script,
    /\$canonicalOrderApprovalService\s*=\s*Join-Path \$root "cloudfunctions\\common\\services\\orderApprovalService\.js"/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalOrderApprovalService -Destination \(Join-Path \$apiTarget "lib\\orderApprovalService\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalOrderApprovalService -Destination \(Join-Path \$reviewTarget "orderApprovalService\.js"\) -Force/
  );
  assert.match(script, /Canonical order approval service hash verification failed/);
  assert.match(
    script,
    /canonicalOrderApprovalServiceSha256\s*=\s*\$orderApprovalServiceSourceHash/
  );
  assert.match(script, /OrderApprovalServiceHashVerified\s*=\s*\$true/);
});

test("guarded package flattens and hash-verifies the shared order status policy", () => {
  const script = readPackagingScript();

  assert.match(
    script,
    /\$canonicalOrderStatusPolicy\s*=\s*Join-Path \$root "cloudfunctions\\common\\orderStatusPolicy\.js"/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalOrderStatusPolicy -Destination \(Join-Path \$apiTarget "lib\\orderStatusPolicy\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalOrderStatusPolicy -Destination \(Join-Path \$reviewTarget "orderStatusPolicy\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalOrderStatusPolicy -Destination \(Join-Path \$cancelTarget "orderStatusPolicy\.js"\) -Force/
  );
  assert.match(script, /Canonical order status policy hash verification failed/);
  assert.match(
    script,
    /canonicalOrderStatusPolicySha256\s*=\s*\$orderStatusPolicySourceHash/
  );
  assert.match(script, /OrderStatusPolicyHashVerified\s*=\s*\$true/);
});

test("raw admin deployment directories contain self-contained canonical review dependencies", () => {
  const pairs = [
    [
      "cloudfunctions/common/services/orderApprovalService.js",
      "cloudfunctions/adminReviewOrder/orderApprovalService.js"
    ],
    [
      "cloudfunctions/common/services/orderApprovalService.js",
      "cloudfunctions/adminWebApi/lib/orderApprovalService.js"
    ],
    [
      "cloudfunctions/common/orderStatusPolicy.js",
      "cloudfunctions/adminReviewOrder/orderStatusPolicy.js"
    ],
    [
      "cloudfunctions/common/orderStatusPolicy.js",
      "cloudfunctions/adminWebApi/lib/orderStatusPolicy.js"
    ]
  ];

  for (const [canonicalRelativePath, deploymentRelativePath] of pairs) {
    const canonicalPath = path.join(repositoryRoot, canonicalRelativePath);
    const deploymentPath = path.join(repositoryRoot, deploymentRelativePath);
    assert.equal(sha256(deploymentPath), sha256(canonicalPath), deploymentRelativePath);
    assert.doesNotMatch(
      fs.readFileSync(deploymentPath, "utf8"),
      /require\(["']\.\.[\\/]/,
      deploymentRelativePath
    );
  }
});

test("guarded package includes the canonical return snapshot helper", () => {
  const script = readPackagingScript();
  assert.match(script, /\$canonicalReturnSnapshot\s*=\s*Join-Path \$root "cloudfunctions\\common\\services\\returnSnapshot\.js"/);
  assert.match(script, /Copy-Item -LiteralPath \$canonicalReturnSnapshot -Destination \(Join-Path \$afterSalesTarget "common\\services\\returnSnapshot\.js"\) -Force/);
  assert.match(script, /returnSnapshotSourceHash -ne \$returnSnapshotLegacyHash/);
});

test("guarded package copies the canonical return inspection and inventory adapters", () => {
  const script = readPackagingScript();
  assert.match(script, /\$canonicalReturnInspectionService\s*=\s*Join-Path \$root "cloudfunctions\\common\\services\\returnInspectionService\.js"/);
  assert.match(script, /Copy-Item -LiteralPath \$canonicalReturnInspectionService -Destination \(Join-Path \$apiTarget "lib\\returnInspectionService\.js"\) -Force/);
  assert.match(script, /Copy-Item -LiteralPath \$canonicalReturnInspectionService -Destination \(Join-Path \$afterSalesTarget "common\\services\\returnInspectionService\.js"\) -Force/);
  assert.match(script, /Copy-Item -LiteralPath \$canonicalInventoryMutationService -Destination \(Join-Path \$afterSalesTarget "common\\services\\inventoryMutationService\.js"\) -Force/);
  assert.match(script, /Copy-Item -LiteralPath \$canonicalStockAlert -Destination \(Join-Path \$afterSalesTarget "_utils\\stockAlert\.js"\) -Force/);
  assert.match(script, /Copy-Item -LiteralPath \$canonicalIdempotency -Destination \(Join-Path \$afterSalesTarget "idempotency\.js"\) -Force/);
  assert.match(script, /Copy-Item -LiteralPath \$canonicalIdempotency -Destination \(Join-Path \$afterSalesTarget "common\\idempotency\.js"\) -Force/);
  assert.match(script, /Copy-Item -LiteralPath \$canonicalSyncEvents -Destination \(Join-Path \$afterSalesTarget "common\\syncEvents\.js"\) -Force/);
  assert.match(script, /returnInspectionServiceSourceHash -ne \$returnInspectionServiceApiHash/);
});

test("guarded package copies and hash-verifies every payment deployment copy", () => {
  const script = readPackagingScript();

  assert.match(
    script,
    /\$canonicalPaymentMutationService\s*=\s*Join-Path \$root "cloudfunctions\\common\\services\\paymentMutationService\.js"/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalPaymentMutationService -Destination \(Join-Path \$apiTarget "lib\\paymentMutationService\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalPaymentMutationService -Destination \(Join-Path \$paymentUpdateTarget "paymentMutationService\.js"\) -Force/
  );
  assert.match(
    script,
    /\$paymentMutationServiceSourceHash -ne \$paymentMutationServiceApiHash -or \$paymentMutationServiceSourceHash -ne \$paymentMutationServiceLegacyHash/
  );
  assert.match(script, /Canonical payment mutation service hash verification failed/);
  assert.match(script, /canonicalPaymentMutationServiceSha256\s*=\s*\$paymentMutationServiceSourceHash/);
  assert.match(script, /PaymentMutationServiceHashVerified\s*=\s*\$true/);
});

test("guarded package hash-verifies payment idempotency and sync helper copies", () => {
  const script = readPackagingScript();

  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalIdempotency -Destination \(Join-Path \$paymentUpdateTarget "common\\idempotency\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalSyncEvents -Destination \(Join-Path \$paymentUpdateTarget "common\\syncEvents\.js"\) -Force/
  );
  assert.match(
    script,
    /\$idempotencySourceHash -ne \$idempotencyPaymentUpdateHash/
  );
  assert.match(
    script,
    /\$syncEventsSourceHash -ne \$syncEventsPaymentUpdateHash/
  );
  assert.match(script, /uploadPerformed\s*=\s*\$false/);
  assert.match(script, /UploadPerformed\s*=\s*\$false/);
});

test("guarded package includes every changed refund cloud function in exact A-Z order", () => {
  const script = readPackagingScript();

  assert.match(
    script,
    /\$recalculateAccountSource\s*=\s*Join-Path \$root "cloudfunctions\\recalculateCustomerAccount"/
  );
  assert.match(
    script,
    /functions\s*=\s*@\("adminDashboard", "adminGetCustomerAccountDetail", "adminListCustomerAccounts", "adminReviewOrder", "adminUpdatePayment", "adminWebApi", "adminWebAuth", "afterSales", "batchUpdateProductTags", "cancelOrder", "cleanupSyncEvents", "getOrders", "getSyncEvents", "getUnsoldProducts", "manageProduct", "recalculateCustomerAccount", "shipmentGroups", "updateProductPrice", "updateProductWarningStock"\)/
  );
});

test("guarded package copies and hash-verifies all refund mutation service copies", () => {
  const script = readPackagingScript();

  assert.match(
    script,
    /\$canonicalRefundMutationService\s*=\s*Join-Path \$root "cloudfunctions\\common\\services\\refundMutationService\.js"/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalRefundMutationService -Destination \(Join-Path \$apiTarget "lib\\refundMutationService\.js"\) -Force/
  );
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalRefundMutationService -Destination \(Join-Path \$afterSalesTarget "common\\services\\refundMutationService\.js"\) -Force/
  );
  assert.match(
    script,
    /\$refundMutationServiceSourceHash -ne \$refundMutationServiceApiHash -or \$refundMutationServiceSourceHash -ne \$refundMutationServiceLegacyHash/
  );
  assert.match(script, /Canonical refund mutation service hash verification failed/);
  assert.match(
    script,
    /canonicalRefundMutationServiceSha256\s*=\s*\$refundMutationServiceSourceHash/
  );
  assert.match(script, /RefundMutationServiceHashVerified\s*=\s*\$true/);
});

test("guarded package records all five refund unique-index requirements", () => {
  assert.deepEqual(
    REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES.map((entry) => ({
      collection: entry.collection,
      indexName: entry.indexName,
      unique: entry.unique,
      fields: [...entry.fields],
      sparse: entry.sparse
    })),
    [
      {
        collection: "admin_operation_logs",
        indexName: "uniq_refund_admin_operation_business_key",
        unique: true,
        fields: ["businessKey"],
        sparse: false
      },
      {
        collection: "account_logs",
        indexName: "uniq_refund_account_log_business_key",
        unique: true,
        fields: ["businessKey"],
        sparse: false
      },
      {
        collection: "refund_logs",
        indexName: "uniq_refund_log_business_key",
        unique: true,
        fields: ["businessKey"],
        sparse: false
      },
      {
        collection: "after_sale_logs",
        indexName: "uniq_refund_after_sale_log_business_key",
        unique: true,
        fields: ["businessKey"],
        sparse: false
      },
      {
        collection: "sync_events",
        indexName: "uniq_refund_sync_event_id",
        unique: true,
        fields: ["eventId"],
        sparse: false
      }
    ]
  );

  const script = readPackagingScript();
  for (const entry of REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES) {
    assert.match(script, new RegExp(entry.collection));
    assert.match(script, new RegExp(entry.indexName));
    assert.match(script, new RegExp(entry.fields[0]));
  }
  assert.match(
    script,
    /refundMutationRequiredUniqueIndexes\s*=\s*\$refundMutationRequiredUniqueIndexes/
  );
});

test("guarded package rejects forbidden secrets, exports, and temporary review files", () => {
  const script = readPackagingScript();

  assert.match(script, /Assert-NoForbiddenPackageFiles/);
  assert.match(script, /BEGIN .*PRIVATE KEY/);
  assert.match(script, /\.env/);
  assert.match(script, /credentials/);
  assert.match(script, /customer.*export/);
  assert.match(script, /\.superpowers/);
  assert.match(script, /forbiddenFileCount\s*=\s*0/);
});

test("guarded package executes in isolation and emits an auditable refund manifest", () => {
  const result = runPackaging("success");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(result.manifestPath), true);

  const manifest = JSON.parse(
    fs.readFileSync(result.manifestPath, "utf8").replace(/^\uFEFF/, "")
  );
  assert.equal(manifest.functions.length, 19);
  assert.deepEqual(manifest.functions, [...manifest.functions].sort());
  assert.deepEqual(deploymentDocumentFunctions(), manifest.functions);
  assert.equal(manifest.uploadPerformed, false);
  assert.equal(manifest.forbiddenFileCount, 0);
  assert.equal(manifest.jszipVersion, "3.10.1");
  assert.equal(manifest.jszipRuntimeBundled, true);
  assert.deepEqual(
    manifest.refundMutationRequiredUniqueIndexes,
    JSON.parse(JSON.stringify(REFUND_MUTATION_REQUIRED_UNIQUE_INDEXES))
  );

  const candidateRequire = createRequire(path.join(result.output, "adminWebApi/lib/importFileParser.js"));
  assert.equal(candidateRequire("jszip/package.json").version, "3.10.1");
  assert.equal(typeof candidateRequire("./importFileParser.js").parseImportFile, "function");
  assert.equal(typeof candidateRequire("./importService.js").createImportService, "function");

  const canonicalHash = sha256(
    path.join(fixtureRoot().root, "cloudfunctions/common/services/refundMutationService.js")
  );
  const apiHash = sha256(path.join(result.output, "adminWebApi/lib/refundMutationService.js"));
  const afterSalesHash = sha256(
    path.join(result.output, "afterSales/common/services/refundMutationService.js")
  );
  const canonicalIdempotencyHash = sha256(
    path.join(fixtureRoot().root, "cloudfunctions/common/idempotency.js")
  );
  const afterSalesTopLevelIdempotencyHash = sha256(
    path.join(result.output, "afterSales/idempotency.js")
  );
  const canonicalApprovalHash = sha256(
    path.join(fixtureRoot().root, "cloudfunctions/common/services/orderApprovalService.js")
  );
  const apiApprovalHash = sha256(
    path.join(result.output, "adminWebApi/lib/orderApprovalService.js")
  );
  const reviewApprovalHash = sha256(
    path.join(result.output, "adminReviewOrder/orderApprovalService.js")
  );
  const canonicalOrderStatusPolicyHash = sha256(
    path.join(fixtureRoot().root, "cloudfunctions/common/orderStatusPolicy.js")
  );
  const apiOrderStatusPolicyHash = sha256(
    path.join(result.output, "adminWebApi/lib/orderStatusPolicy.js")
  );
  const reviewOrderStatusPolicyHash = sha256(
    path.join(result.output, "adminReviewOrder/orderStatusPolicy.js")
  );
  const cancelOrderStatusPolicyHash = sha256(
    path.join(result.output, "cancelOrder/orderStatusPolicy.js")
  );
  assert.equal(manifest.canonicalRefundMutationServiceSha256, canonicalHash);
  assert.equal(apiHash, canonicalHash);
  assert.equal(afterSalesHash, canonicalHash);
  assert.equal(manifest.canonicalIdempotencySha256, canonicalIdempotencyHash);
  assert.equal(afterSalesTopLevelIdempotencyHash, canonicalIdempotencyHash);
  assert.equal(manifest.canonicalOrderApprovalServiceSha256, canonicalApprovalHash);
  assert.equal(apiApprovalHash, canonicalApprovalHash);
  assert.equal(reviewApprovalHash, canonicalApprovalHash);
  assert.equal(manifest.canonicalOrderStatusPolicySha256, canonicalOrderStatusPolicyHash);
  assert.equal(apiOrderStatusPolicyHash, canonicalOrderStatusPolicyHash);
  assert.equal(reviewOrderStatusPolicyHash, canonicalOrderStatusPolicyHash);
  assert.equal(cancelOrderStatusPolicyHash, canonicalOrderStatusPolicyHash);
  assert.doesNotThrow(() => require(path.join(result.output, "adminReviewOrder/orderReviewService.js")));
  assert.doesNotThrow(() => require(path.join(result.output, "adminWebApi/lib/orderReviewService.js")));
  assert.doesNotThrow(() => require(path.join(result.output, "cancelOrder/orderCancellationService.js")));
});

test("guarded package execution rejects every forbidden artifact without a manifest", async (t) => {
  const cases = [
    { name: "env", file: ".env", content: "SECRET=value" },
    { name: "credentials", file: "credentials.json", content: "{}" },
    {
      name: "private-key",
      file: "private-note.txt",
      content: "-----BEGIN PRIVATE KEY-----\nredacted\n-----END PRIVATE KEY-----"
    },
    { name: "customer-export", file: "customer-export.csv", content: "customer,total" },
    { name: "review", file: "review-refund.diff", content: "temporary review" }
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const injected = path.join(
        fixtureRoot().root,
        "cloudfunctions/adminWebApi",
        entry.file
      );
      fs.writeFileSync(injected, entry.content, "utf8");
      try {
        const result = runPackaging(`forbidden-${entry.name}`);
        assert.notEqual(result.status, 0, `${entry.name} unexpectedly packaged`);
        assert.equal(fs.existsSync(result.manifestPath), false);
      } finally {
        fs.rmSync(injected, { force: true });
      }
    });
  }
});
