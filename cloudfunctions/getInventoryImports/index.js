const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function loadPreviewItems(record) {
  if (!record || !record.previewFileID) return [];
  const file = await cloud.downloadFile({ fileID: record.previewFileID });
  const text = file.fileContent.toString("utf8");
  const items = JSON.parse(text);
  return Array.isArray(items) ? items : [];
}

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("无管理员权限");
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    if (!/exist|already|collection exists/i.test(err.message || "")) {
      throw err;
    }
  }
}

exports.main = async (event) => {
  try {
    await requirePermission("inventory:import");
    await ensureCollection("import_records");
    await ensureCollection("import_record_items");
    const { importRecordId = "" } = event;
    if (importRecordId) {
      const record = (await db.collection("import_records").doc(importRecordId).get()).data;
      const items = await db.collection("import_record_items")
        .where({ importRecordId })
        .orderBy("rowNo", "asc")
        .limit(1000)
        .get();
      if (items.data.length) return ok({ record, items: items.data });
      return ok({ record, items: await loadPreviewItems(record) });
    }

    const records = await db.collection("import_records")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();
    return ok({ records: records.data });
  } catch (err) {
    return fail(err.message || "获取导入记录失败");
  }
};

