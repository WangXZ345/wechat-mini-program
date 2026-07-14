const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { requirePermission } = require("./auth");

async function requireAdmin() {
  const openid = cloud.getWXContext().OPENID;
  const res = await db.collection("admin_users").where({ openid, isActive: _.neq(false) }).limit(1).get();
  if (!res.data.length) throw new Error("无管理员权限");
}

exports.main = async (event) => {
  const { accountId, mark } = event;
  if (!accountId) return { ok: false, message: "缺少账款 ID" };
  if (!["paid", "unpaid"].includes(mark)) return { ok: false, message: "操作无效" };

  try {
    await requirePermission("customer:view_account");
    const account = (await db.collection("customer_accounts").doc(accountId).get()).data;
    if (!account) return { ok: false, message: "账款不存在" };
    if (mark === "paid") {
      const unpaid = Number(account.unpaidAmount || 0);
      await db.collection("customer_accounts").doc(accountId).update({
        data: {
          unpaidAmount: 0,
          paidAmount: _.inc(unpaid),
          updatedAt: db.serverDate()
        }
      });
    } else {
      await db.collection("customer_accounts").doc(accountId).update({
        data: { updatedAt: db.serverDate() }
      });
    }
    return { ok: true, data: { accountId } };
  } catch (err) {
    return { ok: false, message: err.message || "更新账款失败" };
  }
};

