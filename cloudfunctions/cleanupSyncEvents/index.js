const cloud = require("wx-server-sdk");
const { authorizeCleanup } = require("./security");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;

function missingCollection(err) {
  return /collection not exists|Table not exist|COLLECTION_NOT_EXIST|ResourceNotFound/i.test(String(err && err.message || err || ""));
}

async function findAdmin(openid) {
  const result = await db.collection("admin_users")
    .where({ openid, isActive: command.neq(false) })
    .limit(1)
    .get();
  return result.data && result.data[0] || null;
}

exports.main = async (event = {}) => {
  const limit = Math.max(1, Math.min(500, Number(event.limit || 100)));
  try {
    const authorized = await authorizeCleanup({
      event,
      context: cloud.getWXContext(),
      env: process.env,
      findAdmin
    });
    if (!authorized) return { ok: false, code: "FORBIDDEN", message: "Cleanup is not authorized" };
    const expired = await db.collection("sync_events")
      .where({ expiresAt: command.lt(new Date()) })
      .orderBy("expiresAt", "asc")
      .limit(limit)
      .get();
    const ids = (expired.data || []).map((row) => row && row._id).filter(Boolean);
    if (ids.length) {
      await Promise.all(ids.map((id) => db.collection("sync_events").doc(id).remove()));
    }
    return {
      ok: true,
      data: {
        deletedCount: ids.length,
        hasMore: ids.length === limit
      }
    };
  } catch (err) {
    if (missingCollection(err)) {
      return { ok: true, data: { deletedCount: 0, hasMore: false, collectionMissing: true } };
    }
    console.error("cleanupSyncEvents failed", String(err && err.message || err || "").slice(0, 160));
    return { ok: false, code: "SYNC_EVENT_CLEANUP_FAILED", message: "Unable to clean expired sync events" };
  }
};

exports._test = { missingCollection, findAdmin };
