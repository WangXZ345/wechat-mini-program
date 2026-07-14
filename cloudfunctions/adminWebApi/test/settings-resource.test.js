const test = require("node:test");
const assert = require("node:assert/strict");
const { listResource } = require("../index")._test;

const settingsAdmin = {
  role: "super_admin",
  status: "active",
  permissions: ["*"]
};

test("settings singleton cannot be enumerated through the generic list route", async () => {
  await assert.rejects(
    () => listResource("settings", {}, settingsAdmin),
    (err) => err.code === "RESOURCE_ID_REQUIRED" && err.statusCode === 400
  );
});
