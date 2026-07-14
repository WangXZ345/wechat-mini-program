const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function isMissingCollection(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

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
    await ensureCollection("user_search_history");
    const limit = Math.min(20, Math.max(1, parseInt(event.limit, 10) || 10));
    const res = await db.collection("user_search_history")
      .where({ openid })
      .orderBy("lastSearchedAt", "desc")
      .limit(limit)
      .get();
    const list = (res.data || []).map((item) => ({
      keyword: item.keyword,
      lastSearchedAt: item.lastSearchedAt,
      searchCount: Number(item.searchCount || 1)
    }));
    return { ok: true, data: { list } };
  } catch (err) {
    if (isMissingCollection(err)) return { ok: true, data: { list: [] } };
    return { ok: false, message: err.message || "获取最近搜索失败" };
  }
};
