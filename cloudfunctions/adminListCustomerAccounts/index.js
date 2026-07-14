const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;
const { requirePermission } = require("./auth");
const { createAccountQueryService } = require("./accountQueryService");

const accountQueryService = createAccountQueryService({ db, command });

exports.main = async (event = {}) => {
  try {
    const actor = await requirePermission("customer:view_basic");
    const data = await accountQueryService.listLegacyAccounts({ actor, query: event });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, message: error.message || "获取客户账款列表失败" };
  }
};
