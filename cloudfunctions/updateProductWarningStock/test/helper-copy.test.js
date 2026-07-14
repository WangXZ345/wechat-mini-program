const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("deployable inventory warning service copy matches the canonical service", () => {
  const canonical = path.resolve(__dirname, "../../common/services/inventoryWarningService.js");
  const deployable = path.resolve(__dirname, "../inventoryWarningService.js");
  assert.equal(fs.readFileSync(deployable, "utf8"), fs.readFileSync(canonical, "utf8"));
});

test("function-local service proxy does not depend on the parent cloudfunctions directory", () => {
  const proxy = fs.readFileSync(path.resolve(__dirname, "../service.js"), "utf8");
  assert.equal(proxy.includes("../common"), false);
  assert.match(proxy, /\.\/inventoryWarningService/);
});
