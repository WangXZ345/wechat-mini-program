const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { ok, fail, getImportDetail } = require("./common/mergedImportService");

exports.main = async (event) => {
  try {
    return ok(await getImportDetail(event || {}));
  } catch (err) {
    return fail(err.message || "获取导入详情失败");
  }
};
