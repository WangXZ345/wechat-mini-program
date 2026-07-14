const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const {
  ensureCollection,
  requirePermission,
  logAdminOperation
} = require("./common/cleanAuth");

const ALLOWED_TYPES = ["xlsx", "xls", "csv", "txt", "docx"];

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

function fileTypeOf(fileName = "", fileID = "") {
  const source = String(fileName || fileID || "").toLowerCase();
  const match = source.match(/\.([^.?]+)(?:\?|$)/);
  return match ? match[1] : "";
}

exports.main = async (event) => {
  try {
    const admin = await requirePermission("inventory:import");
    await ensureCollection("import_records");
    const {
      fileID = "",
      fileName = "",
      fileType = "",
      fileSize = 0,
      fileRole = "inventory"
    } = event || {};
    const type = fileType || fileTypeOf(fileName, fileID);
    if (!fileID) return fail("缺少文件 ID");
    if (!ALLOWED_TYPES.includes(type)) return fail("不支持的文件格式");

    await logAdminOperation({
      operator: admin,
      action: "upload_import_file",
      resourceType: "import_file",
      resourceId: fileID,
      afterData: { fileID, fileName, fileType: type, fileSize, fileRole },
      description: "上传库存/报价导入文件"
    });

    return ok({
      fileID,
      fileName: fileName || fileID.split("/").pop(),
      fileType: type,
      fileSize,
      fileRole,
      operatorId: admin._id || admin.id || "",
      operatorOpenid: admin.openid
    });
  } catch (err) {
    return fail(err.message || "登记上传文件失败");
  }
};
