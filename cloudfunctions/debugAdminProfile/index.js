const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function getOpenid() {
  return cloud.getWXContext().OPENID;
}

exports.main = async () => {
  try {
    const openid = getOpenid();

    // 查询原始管理员记录
    const res = await db.collection("admin_users").where({
      openid,
      isActive: _.neq(false),
      status: _.neq("disabled")
    }).limit(1).get();

    const admin = res.data && res.data[0];

    return {
      ok: true,
      debug: {
        openid,
        found: !!admin,
        rawAdmin: admin || null,
        role: admin ? admin.role : null,
        permissions: admin ? admin.permissions : null,
        isActive: admin ? admin.isActive : null,
        status: admin ? admin.status : null,
        isSuperAdmin: admin ? admin.isSuperAdmin : null
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      stack: err.stack
    };
  }
};
