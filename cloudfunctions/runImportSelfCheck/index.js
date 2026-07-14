const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail, runImportSelfCheck } = require("./common/mergedImportService");

exports.main = async (event) => {
  try {
    return ok(await runImportSelfCheck(event || {}));
  } catch (err) {
    return fail(err.message || "导入自检失败");
  }
};
