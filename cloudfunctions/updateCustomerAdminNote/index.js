const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission, logAdminOperation } = require("./auth");

const MAX_CUSTOMER_NOTE_LENGTH = 1000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 10;
const RISK_LEVELS = ["normal", "important", "slow_pay", "risk", "blocked"];

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

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : String(value || "").split(/[,，、\n]/);
  const normalized = Array.from(new Set(tags.map((tag) => String(tag || "").trim()).filter(Boolean)));
  if (normalized.length > MAX_TAGS) throw new Error("Too many tags");
  if (normalized.some((tag) => tag.length > MAX_TAG_LENGTH)) throw new Error("Tag is too long");
  return normalized;
}

async function findUser(tx, userId) {
  try {
    const user = (await tx.collection("users").doc(userId).get()).data;
    if (user) return user;
  } catch (err) {
    // Continue with openid lookup.
  }
  const byOpenid = await tx.collection("users").where({ openid: userId }).limit(1).get();
  return byOpenid.data[0] || null;
}

async function findAccount(tx, user) {
  const filters = [];
  if (user._id) filters.push({ userId: user._id });
  if (user.openid) filters.push({ userOpenid: user.openid });
  for (const where of filters) {
    const res = await tx.collection("customer_accounts").where(where).limit(1).get();
    if (res.data[0]) return res.data[0];
  }
  return null;
}

exports.main = async (event = {}) => {
  const userId = String(event.userId || "").trim();
  const adminNote = String(event.adminNote || "").trim();
  const riskLevel = String(event.riskLevel || "normal").trim();
  let adminTags = [];

  if (!userId) return fail("缂哄皯瀹㈡埛 ID");
  if (adminNote.length > MAX_CUSTOMER_NOTE_LENGTH) return fail("Customer note is too long");
  if (!RISK_LEVELS.includes(riskLevel)) return fail("椋庨櫓绛夌骇闈炴硶");

  try {
    adminTags = normalizeTags(event.adminTags);
    const admin = await requirePermission("customer:edit_remark");
    const operator = {
      operatorId: admin._id || admin.id,
      operatorOpenid: admin.openid,
      operatorName: admin.name || admin.nickname || admin.openid
    };
    await ensureCollection("customer_accounts");
    await ensureCollection("note_logs");

    const result = await db.runTransaction(async (tx) => {
      const user = await findUser(tx, userId);
      if (!user) throw new Error("Customer not found");

      let account = await findAccount(tx, user);
      if (!account) {
        const created = await tx.collection("customer_accounts").add({
          data: {
            userId: user._id,
            userOpenid: user.openid || "",
            nickname: user.nickname || "",
            phone: user.phone || "",
            totalOrderAmount: 0,
            totalPaidAmount: 0,
            totalUnpaidAmount: 0,
            unpaidAmount: 0,
            todayOrderAmount: 0,
            historyUnpaidAmount: 0,
            pendingConfirmAmount: 0,
            abnormalAmount: 0,
            abnormalCount: 0,
            orderCount: 0,
            paidOrderCount: 0,
            unpaidOrderCount: 0,
            partialPaidOrderCount: 0,
            riskLevel: "normal",
            adminNote: "",
            adminTags: [],
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        });
        account = { _id: created._id, userId: user._id, userOpenid: user.openid || "", adminNote: "", adminTags: [], riskLevel: "normal" };
      }

      const beforeNote = String(account.adminNote || account.adminRemark || "");
      const beforeTags = Array.isArray(account.adminTags) ? account.adminTags : [];
      const beforeRiskLevel = account.riskLevel || "normal";
      const tagsChanged = JSON.stringify(beforeTags) !== JSON.stringify(adminTags);
      const changed = beforeNote !== adminNote || tagsChanged || beforeRiskLevel !== riskLevel;

      if (!changed) {
        return { userId: user._id, accountId: account._id, unchanged: true };
      }

      await tx.collection("customer_accounts").doc(account._id).update({
        data: {
          adminNote,
          adminTags,
          riskLevel,
          adminNoteUpdatedAt: db.serverDate(),
          adminNoteUpdatedBy: operator.operatorName,
          adminNoteUpdatedByOpenid: operator.operatorOpenid,
          updatedAt: db.serverDate()
        }
      });

      await tx.collection("note_logs").add({
        data: {
          targetType: "customer",
          targetId: user._id,
          userId: user._id,
          orderId: "",
          beforeNote,
          afterNote: adminNote,
          beforeTags,
          afterTags: adminTags,
          beforeRiskLevel,
          afterRiskLevel: riskLevel,
          operatorId: operator.operatorId,
          operatorOpenid: operator.operatorOpenid,
          operatorName: operator.operatorName,
          createdAt: db.serverDate()
        }
      });

      return { userId: user._id, accountId: account._id, unchanged: false };
    });

    if (!result.unchanged) {
      await logAdminOperation({
        operator: admin,
        action: "customer:edit_remark",
        resourceType: "customer",
        resourceId: result.userId || userId,
        beforeData: null,
        afterData: { adminNote, adminTags, riskLevel },
        description: "淇敼瀹㈡埛澶囨敞"
      });
    }

    return ok(result);
  } catch (err) {
    return fail(err.message || "淇濆瓨瀹㈡埛澶囨敞澶辫触");
  }
};

