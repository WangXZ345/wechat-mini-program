const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("鏃犵鐞嗗憳鏉冮檺");
}

function safeExtension(value) {
  const ext = String(value || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext || "jpg";
}

exports.main = async (event = {}) => {
  try {
    await requirePermission("order:view");
    const fileContent = event.fileContent;
    if (!fileContent) return { ok: false, message: "缂哄皯鍥剧墖鍐呭" };
    const buffer = Buffer.from(String(fileContent).replace(/^data:image\/\w+;base64,/, ""), "base64");
    if (!buffer.length) return { ok: false, message: "鍥剧墖鍐呭涓虹┖" };

    const cloudPath = `delivery/${Date.now()}-${Math.floor(Math.random() * 100000)}.${safeExtension(event.extension)}`;
    const uploaded = await cloud.uploadFile({ cloudPath, fileContent: buffer });
    return { ok: true, data: { fileID: uploaded.fileID, imageUrl: uploaded.fileID } };
  } catch (err) {
    return { ok: false, message: "Operation failed" };
  }
};

