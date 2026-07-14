const test = require("node:test");
const assert = require("node:assert/strict");
const { buildStatusSnapshot } = require("../miniprogram/utils/productStatusSnapshot");

test("status snapshots follow version, dataVersion, then zero compatibility", () => {
  assert.deepEqual(buildStatusSnapshot({ _id: "p1", isActive: false, version: 5, dataVersion: 3 }), {
    id: "p1",
    expectedIsActive: false,
    expectedVersion: 5
  });
  assert.deepEqual(buildStatusSnapshot({ _id: "p2", isActive: true, dataVersion: 3 }), {
    id: "p2",
    expectedIsActive: true,
    expectedVersion: 3
  });
  assert.deepEqual(buildStatusSnapshot({ _id: "p3" }), {
    id: "p3",
    expectedIsActive: true,
    expectedVersion: 0
  });
});

test("status snapshots reject corrupt ids, states and versions", () => {
  assert.equal(buildStatusSnapshot({ _id: "", isActive: true, version: 0 }), null);
  assert.equal(buildStatusSnapshot({ _id: "p1", isActive: "false", version: 0 }), null);
  assert.equal(buildStatusSnapshot({ _id: "p1", isActive: false, version: "2" }), null);
  assert.equal(buildStatusSnapshot({ _id: "p1", isActive: false, version: -1 }), null);
});
