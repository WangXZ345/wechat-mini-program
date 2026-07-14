const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail, parseMergedInventoryImport } = require("./common/mergedImportService");

exports.main = async (event) => {
  try {
    return ok(await parseMergedInventoryImport(event || {}));
  } catch (err) {
    return fail(err.message || "解析库存和报价表失败");
  }
};
