const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const {
  trimKeyword,
  normalizeKeyword,
  isValidSearchKeyword,
  isSensitiveKeyword
} = require("./common/search");

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

async function pruneHistory(openid) {
  const res = await db.collection("user_search_history")
    .where({ openid })
    .orderBy("lastSearchedAt", "desc")
    .skip(20)
    .limit(50)
    .get();
  const expired = res.data || [];
  for (let i = 0; i < expired.length; i += 1) {
    await db.collection("user_search_history").doc(expired[i]._id).remove();
  }
}

async function updateSearchStats(keyword, normalizedKeyword, resultCount, now) {
  if (isSensitiveKeyword(keyword)) return;
  const collection = db.collection("search_stats");
  const existed = await collection.where({ normalizedKeyword }).limit(1).get();
  if (existed.data && existed.data.length) {
    await collection.doc(existed.data[0]._id).update({
      data: {
        keyword,
        resultCount: Number(resultCount || 0),
        searchCount: _.inc(1),
        lastSearchedAt: now,
        updatedAt: now
      }
    });
    return;
  }
  await collection.add({
    data: {
      keyword,
      normalizedKeyword,
      resultCount: Number(resultCount || 0),
      searchCount: 1,
      lastSearchedAt: now,
      createdAt: now,
      updatedAt: now
    }
  });
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    if (!openid) return { ok: false, message: "无法获取用户身份" };

    const keyword = trimKeyword(event.keyword || "");
    if (!isValidSearchKeyword(keyword)) {
      return { ok: true, data: { saved: false, reason: "INVALID_KEYWORD" } };
    }
    const normalizedKeyword = normalizeKeyword(keyword);
    const now = new Date();
    await ensureCollection("user_search_history");
    const collection = db.collection("user_search_history");
    const existed = await collection.where({ openid, normalizedKeyword }).limit(1).get();

    if (existed.data && existed.data.length) {
      await collection.doc(existed.data[0]._id).update({
        data: {
          keyword,
          searchCount: _.inc(1),
          lastSearchedAt: now,
          updatedAt: now
        }
      });
    } else {
      await collection.add({
        data: {
          openid,
          userId: wxContext.UNIONID || openid,
          keyword,
          normalizedKeyword,
          searchCount: 1,
          lastSearchedAt: now,
          createdAt: now,
          updatedAt: now
        }
      });
    }

    await pruneHistory(openid);
    try {
      await updateSearchStats(keyword, normalizedKeyword, event.resultCount, now);
    } catch (err) {
      if (!isMissingCollection(err)) throw err;
    }
    return { ok: true, data: { saved: true } };
  } catch (err) {
    if (isMissingCollection(err)) {
      return { ok: false, message: "user_search_history 集合不存在，请先创建集合后重试" };
    }
    return { ok: false, message: err.message || "保存最近搜索失败" };
  }
};
