const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const ALLOWED_TYPES = ["xlsx", "xls", "txt"];
const { requirePermission } = require("./auth");

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("无管理员权限");
  return openid;
}

function getFileType(fileName = "") {
  const match = String(fileName).toLowerCase().match(/\.([^.]+)$/);
  return match ? match[1] : "";
}

exports.main = async (event) => {
  try {
    const admin = await requirePermission("inventory:import");
    const operatorId = admin.openid;
    const { fileID, fileUrl = "", fileName = "" } = event;
    const fileType = getFileType(fileName || fileID);

    if (!fileID) return fail("缺少文件 ID");
    if (!ALLOWED_TYPES.includes(fileType)) return fail("不支持的文件格式");

    return ok({
      fileID,
      fileUrl,
      fileName: fileName || fileID.split("/").pop(),
      fileType,
      operatorId
    });
  } catch (err) {
    return fail(err.message || "登记上传文件失败");
  }
};

