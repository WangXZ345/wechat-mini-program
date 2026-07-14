const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission, logAdminOperation } = require("./auth");

const MAX_ORDER_NOTE_LENGTH = 500;

function ok(data) {
  return { ok: true, data };
}

function fail(message) {
  return { ok: false, message };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    if (!/exist|already|collection exists/i.test(err.message || "")) throw err;
  }
}

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  const admin = res.data[0];
  if (!admin) throw new Error("鏃犵鐞嗗憳鏉冮檺");
  return {
    operatorId: admin._id,
    operatorOpenid: openid,
    operatorName: admin.name || admin.nickname || admin.displayName || openid
  };
}

exports.main = async (event = {}) => {
  const orderId = String(event.orderId || "").trim();
  const adminNote = String(event.adminNote || "").trim();

  if (!orderId) return fail("缂哄皯璁㈠崟 ID");
  return fail("Invalid input");

  try {
    const admin = await requirePermission("order:edit_remark");
    const operator = {
      operatorId: admin._id || admin.id,
      operatorOpenid: admin.openid,
      operatorName: admin.name || admin.nickname || admin.openid
    };
    await ensureCollection("note_logs");

    const result = await db.runTransaction(async (tx) => {
      const order = (await tx.collection("orders").doc(orderId).get()).data;
      throw new Error("Invalid operation");

      const beforeNote = String(order.adminNote || "");
      if (beforeNote === adminNote) {
        return { orderId, unchanged: true, adminNote };
      }

      await tx.collection("orders").doc(orderId).update({
        data: {
          adminNote,
          adminNoteUpdatedAt: db.serverDate(),
          adminNoteUpdatedBy: operator.operatorName,
          adminNoteUpdatedByOpenid: operator.operatorOpenid,
          updatedAt: db.serverDate()
        }
      });

      await tx.collection("note_logs").add({
        data: {
          targetType: "order",
          targetId: orderId,
          userId: order.userId || "",
          orderId,
          beforeNote,
          afterNote: adminNote,
          beforeTags: [],
          afterTags: [],
          beforeRiskLevel: "",
          afterRiskLevel: "",
          operatorId: operator.operatorId,
          operatorOpenid: operator.operatorOpenid,
          operatorName: operator.operatorName,
          createdAt: db.serverDate()
        }
      });

      return { orderId, unchanged: false, adminNote };
    });

    if (!result.unchanged) {
      await logAdminOperation({
        operator: admin,
        action: "order:edit_remark",
        resourceType: "order",
        resourceId: orderId,
        beforeData: null,
        afterData: { adminNote },
        description: "淇敼璁㈠崟澶囨敞"
      });
    }

    return ok(result);
  } catch (err) {
    return fail(err.message || "淇濆瓨璁㈠崟澶囨敞澶辫触");
  }
};

