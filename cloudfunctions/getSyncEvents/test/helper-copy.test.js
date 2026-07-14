const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("deployable sync helper copies match the canonical helper", () => {
  const canonical = path.resolve(__dirname, "../../common/syncEvents.js");
  const miniFunctionCopy = path.resolve(__dirname, "../common/syncEvents.js");
  const webFunctionCopy = path.resolve(__dirname, "../../adminWebApi/lib/syncEvents.js");
  assert.equal(digest(miniFunctionCopy), digest(canonical));
  assert.equal(digest(webFunctionCopy), digest(canonical));
});
