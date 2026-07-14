const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const { trimKeyword, normalizeKeyword, isValidSearchKeyword } = require("./common/search");

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist/i.test(message)) return;
    if (/createCollection is not a function/i.test(message)) return;
    throw err;
  }
}

exports.main = async (event = {}) => {
  try {
    const openid = cloud.getWXContext().OPENID;
    if (!openid) return { ok: false, message: "无法获取用户身份" };
    const keyword = trimKeyword(event.keyword || "");
    if (!isValidSearchKeyword(keyword)) return { ok: true, data: { deleted: 0 } };
    await ensureCollection("user_search_history");
    const res = await db.collection("user_search_history")
      .where({ openid, normalizedKeyword: normalizeKeyword(keyword) })
      .remove();
    return { ok: true, data: { deleted: Number(res.stats && res.stats.removed || 0) } };
  } catch (err) {
    return { ok: false, message: err.message || "删除最近搜索失败" };
  }
};
