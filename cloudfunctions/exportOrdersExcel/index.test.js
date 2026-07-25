const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const indexPath = path.join(__dirname, "index.js");

async function withExportOrdersExcel(run) {
  const originalLoad = Module._load;
  let exportedRows = null;
  const order = {
    _id: "order-1",
    orderNo: "ORDER-001",
    userId: "user-1",
    status: "approved",
    shippingType: "delivery",
    shippingAddressSnapshot: {
      receiverName: "张三",
      receiverPhone: "13800138000",
      regionText: "上海市 浦东新区",
      detailAddress: "世纪大道完整门牌号",
      fullAddress: "上海市 浦东新区 世纪大道完整门牌号",
      addressTag: "公司"
    },
    productId: "product-1",
    productName: "测试商品",
    quantity: 1,
    unitPrice: 100,
    totalAmount: 100
  };
  const rowsByCollection = {
    orders: [order],
    users: [],
    customer_accounts: [],
    order_items: [],
    products: []
  };

  function queryFor(name) {
    const query = {
      where() { return query; },
      orderBy() { return query; },
      skip() { return query; },
      limit() { return query; },
      async get() { return { data: rowsByCollection[name] || [] }; },
      async add() { return { _id: "record-1" }; }
    };
    return query;
  }

  const fakeDb = {
    command: {
      neq(value) { return value; },
      in(value) { return value; },
      gte(value) { return { and() { return value; } }; },
      lte(value) { return value; }
    },
    collection(name) { return queryFor(name); },
    async createCollection() {},
    serverDate() { return new Date("2026-07-24T00:00:00Z"); }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() { return fakeDb; },
    getWXContext() { return { OPENID: "procurement-openid" }; },
    async uploadFile() { return { fileID: "cloud://test/export.xlsx" }; },
    async getTempFileURL() {
      return { fileList: [{ tempFileURL: "https://example.test/export.xlsx" }] };
    }
  };
  const fakeXlsx = {
    utils: {
      aoa_to_sheet(rows) {
        exportedRows = rows;
        return {};
      },
      encode_cell({ r, c }) { return `${r}:${c}`; },
      book_new() { return {}; },
      book_append_sheet() {}
    },
    write() { return Buffer.from("xlsx"); }
  };
  const auth = {
    async requirePermission(permission) {
      assert.equal(permission, "order:export");
      return {
        _id: "procurement-1",
        openid: "procurement-openid",
        role: "procurement",
        permissions: ["order:export"]
      };
    }
  };
  const phone = {
    canViewFullPhone() { return false; },
    maskPhone() { return "***"; }
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename === indexPath) {
      if (request === "wx-server-sdk") return fakeCloud;
      if (request === "xlsx") return fakeXlsx;
      if (request === "./auth") return auth;
      if (request === "./phone") return phone;
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[require.resolve(indexPath)];
  try {
    await run(require(indexPath), () => exportedRows);
  } finally {
    delete require.cache[require.resolve(indexPath)];
    Module._load = originalLoad;
  }
}

test("procurement without explicit permission exports only masked addresses from the real handler", async () => {
  await withExportOrdersExcel(async ({ main }, getExportedRows) => {
    const result = await main({ exportType: "summary" });

    assert.equal(result.ok, true);
    const [headers, row] = getExportedRows();
    const value = (title) => row[headers.indexOf(title)];
    assert.equal(value("收货手机号"), "138****8000");
    assert.equal(value("详细地址").includes("完整门牌号"), false);
    assert.equal(value("完整地址").includes("完整门牌号"), false);
  });
});
