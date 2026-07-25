"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.join(__dirname, "../../..");
const canonicalPolicy = path.join(
  repositoryRoot,
  "cloudfunctions/common/orderStatusPolicy.js"
);
const deployablePolicy = path.join(__dirname, "../orderStatusPolicy.js");
const packagingScript = path.join(
  repositoryRoot,
  "scripts/package-admin-web-cloudfunctions.ps1"
);

test("cancelOrder source contains an exact deployable order-status policy copy", () => {
  assert.equal(
    fs.readFileSync(deployablePolicy, "utf8"),
    fs.readFileSync(canonicalPolicy, "utf8")
  );
});

test("guarded package overwrites cancelOrder policy from canonical source", () => {
  const script = fs.readFileSync(packagingScript, "utf8");
  assert.match(
    script,
    /Copy-Item -LiteralPath \$canonicalOrderStatusPolicy -Destination \(Join-Path \$cancelTarget "orderStatusPolicy\.js"\) -Force/
  );
  assert.match(
    script,
    /\$orderStatusPolicySourceHash -ne \$orderStatusPolicyCancelHash/
  );
});
