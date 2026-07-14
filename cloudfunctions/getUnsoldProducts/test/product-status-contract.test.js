const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const originalLoad = Module._load;
Module._load = function loadWithCloudStubs(request, parent, isMain) {
  if (request === "wx-server-sdk") {
    return {
      DYNAMIC_CURRENT_ENV: "test",
      init() {},
      database() {
        return {
          command: {},
          runTransaction() {},
          collection() {},
          createCollection() {},
          serverDate() { return new Date("2026-07-11T08:00:00.000Z"); }
        };
      }
    };
  }
  if (request === "xlsx") return {};
  return originalLoad(request, parent, isMain);
};
const { shapeProduct, statusActor } = require("../index")._test;
Module._load = originalLoad;

test("unsold product DTO carries a strict version for optimistic status writes", () => {
  const direct = shapeProduct({ _id: "p1", isActive: true, version: 5 }, {}, {});
  const compatible = shapeProduct({ _id: "p2", isActive: true, dataVersion: 3 }, {}, {});
  const missing = shapeProduct({ _id: "p3", isActive: true }, {}, {});
  const invalid = shapeProduct({ _id: "p4", isActive: true, version: "7" }, {}, {});
  assert.equal(direct.version, 5);
  assert.equal(compatible.version, 3);
  assert.equal(missing.version, 0);
  assert.equal(invalid.version, 0);
});

test("unsold status actor ignores client identity and keeps the authenticated admin", () => {
  assert.deepEqual(statusActor({
    _id: "admin-1",
    openid: "openid-1",
    role: "procurement",
    permissions: ["product:update_status"],
    status: "active",
    isActive: true
  }), {
    id: "openid-1",
    openid: "openid-1",
    role: "procurement",
    permissions: ["product:update_status"],
    status: "active",
    isActive: true,
    sourceClient: "miniprogram"
  });
});

test("deployable status service matches canonical and idempotency proxy resolves canonical", () => {
  assert.equal(
    fs.readFileSync(path.resolve(__dirname, "../productStatusService.js"), "utf8"),
    fs.readFileSync(path.resolve(__dirname, "../../common/services/productStatusService.js"), "utf8")
  );
  assert.equal(require("../idempotency"), require("../../common/idempotency"));
});
