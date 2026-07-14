const cloud = require("wx-server-sdk");
const {
  cleanString,
  ownerKeyFor,
  readSyncBatch
} = require("./common/syncEvents");
const { activeAdmin, boundedRolePermissions } = require("./security");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;

async function currentPrincipal(openid) {
  const result = await db.collection("admin_users")
    .where({ openid, isActive: command.neq(false) })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  const admin = result.data && result.data[0];
  if (activeAdmin(admin)) {
    return {
      kind: "admin",
      id: cleanString(admin._id || admin.id, 128),
      role: admin.role,
      permissions: boundedRolePermissions(admin.role, admin.permissions),
      status: "active"
    };
  }
  return {
    kind: "user",
    role: "user",
    permissions: [],
    openid,
    ownerKey: ownerKeyFor(openid, process.env.SYNC_OWNER_PEPPER || "")
  };
}

function inputTopics(event) {
  if (Array.isArray(event.topics)) return event.topics;
  if (Array.isArray(event.entityTypes)) return event.entityTypes;
  return event.topics || event.entityTypes || "";
}

exports.main = async (event = {}) => {
  try {
    const context = cloud.getWXContext();
    const openid = cleanString(context && context.OPENID, 128);
    if (!openid) return { ok: false, code: "AUTH_REQUIRED", message: "Unable to identify current user" };
    const principal = await currentPrincipal(openid);
    const data = await readSyncBatch({
      db,
      command,
      principal,
      cursor: cleanString(event.cursor, 8192),
      topics: inputTopics(event),
      limit: event.limit,
      cursorSecret: process.env.SYNC_CURSOR_SECRET || process.env.SYNC_OWNER_PEPPER,
      fallbackClient: "miniprogram"
    });
    return { ok: true, data };
  } catch (err) {
    const code = err && ["INVALID_SYNC_CURSOR", "SYNC_CURSOR_CONFIG_REQUIRED"].includes(err.code)
      ? err.code
      : "SYNC_READ_FAILED";
    if (code !== "INVALID_SYNC_CURSOR") console.error("getSyncEvents failed", cleanString(err && err.message, 160));
    return {
      ok: false,
      code,
      message: code === "INVALID_SYNC_CURSOR"
        ? "Sync cursor is invalid"
        : code === "SYNC_CURSOR_CONFIG_REQUIRED"
          ? "Sync cursor security is not configured"
          : "Unable to read sync events"
    };
  }
};

exports._test = { activeAdmin, boundedRolePermissions, currentPrincipal, inputTopics };
