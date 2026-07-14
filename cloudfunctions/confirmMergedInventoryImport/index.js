const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail, confirmMergedInventoryImport } = require("./common/mergedImportService");

exports.main = async (event) => {
  try {
    return ok(await confirmMergedInventoryImport(event || {}));
  } catch (err) {
    return fail(err.message || "确认导入失败");
  }
};
