const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const { trimKeyword, isSensitiveKeyword } = require("./common/search");

function isMissingCollection(err) {
  const message = String((err && err.message) || err || "");
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(message);
}

exports.main = async (event = {}) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(event.limit, 10) || 10));
    const res = await db.collection("search_stats")
      .orderBy("searchCount", "desc")
      .limit(limit * 2)
      .get();
    const list = (res.data || [])
      .map((item) => ({
        keyword: trimKeyword(item.keyword),
        searchCount: Number(item.searchCount || 0),
        resultCount: Number(item.resultCount || 0),
        lastSearchedAt: item.lastSearchedAt
      }))
      .filter((item) => item.keyword && !isSensitiveKeyword(item.keyword))
      .slice(0, limit);
    return { ok: true, data: { list } };
  } catch (err) {
    if (isMissingCollection(err)) return { ok: true, data: { list: [] } };
    return { ok: false, message: err.message || "获取热门搜索失败" };
  }
};
