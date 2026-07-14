const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  try {
    if (openid) {
      const usersResult = await db.collection("users").where({ openid }).limit(1).get();
      const user = usersResult.data && usersResult.data[0];
      if (user) {
        await db.collection("users").doc(user._id).update({
          data: {
            lastLogoutAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        });
      }
    }
  } catch (err) {
    console.error("logout error:", err && err.message || err);
  }

  return { ok: true, data: { loggedOut: true } };
};
