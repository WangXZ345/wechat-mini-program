const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail, getImportHistory } = require("./common/mergedImportService");

exports.main = async () => {
  try {
    return ok(await getImportHistory());
  } catch (err) {
    return fail(err.message || "获取导入历史失败");
  }
};
