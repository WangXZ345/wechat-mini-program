const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const indexPath = path.join(__dirname, "index.js");

async function withGetAdminCustomerAddresses(run) {
  const originalLoad = Module._load;
  const query = {
    where() { return query; },
    limit() { return query; },
    async get() {
      return {
        data: [{
          _id: "address-1",
          userId: "user-1",
          status: "active",
          receiverName: "张三",
          receiverPhone: "13800138000",
          regionText: "上海市 浦东新区",
          detailAddress: "世纪大道完整门牌号",
          fullAddress: "上海市 浦东新区 世纪大道完整门牌号",
          isDefault: true
        }]
      };
    }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() {
      return {
        command: {},
        collection(name) {
          assert.equal(name, "customer_addresses");
          return query;
        }
      };
    }
  };
  const auth = {
    async requireAnyPermission(permissions) {
      assert.deepEqual(permissions, ["customer:view_address_masked", "customer:view_address_full"]);
      return {
        _id: "procurement-1",
        role: "procurement",
        permissions: ["customer:view_address_masked"]
      };
    }
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename === indexPath) {
      if (request === "wx-server-sdk") return fakeCloud;
      if (request === "./auth") return auth;
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[require.resolve(indexPath)];
  try {
    await run(require(indexPath));
  } finally {
    delete require.cache[require.resolve(indexPath)];
    Module._load = originalLoad;
  }
}

test("procurement without explicit permission receives masked addresses from the real handler", async () => {
  await withGetAdminCustomerAddresses(async ({ main }) => {
    const result = await main({ userId: "user-1" });

    assert.equal(result.ok, true);
    assert.equal(result.data.canViewFullAddress, false);
    assert.equal(result.data.addresses.length, 1);
    assert.equal(result.data.addresses[0].receiverPhone, "");
    assert.equal(result.data.addresses[0].receiverPhoneMasked, "138****8000");
    assert.equal(result.data.addresses[0].detailAddress.includes("完整门牌号"), false);
    assert.equal(result.data.addresses[0].fullAddress.includes("完整门牌号"), false);
  });
});
