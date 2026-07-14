const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const { getAdminByOpenid } = require("./auth");
const { publicPhoneProfile } = require("./phone");

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const now = db.serverDate();

  try {
    const users = await db.collection("users").where({ openid }).limit(1).get();
    let user = users.data[0];

    if (!user) {
      const created = await db.collection("users").add({
        data: {
          openid,
          nickname: event.nickname || "",
          avatarUrl: event.avatarUrl || "",
          phoneNumber: "",
          phoneMasked: "",
          phoneVerified: false,
          phoneBindMethod: "",
          phoneBoundAt: null,
          phoneUpdatedAt: null,
          phoneChangeCount: 0,
          lastLoginAt: now,
          createdAt: now,
          updatedAt: now
        }
      });
      user = {
        _id: created._id,
        openid,
        nickname: event.nickname || "",
        avatarUrl: event.avatarUrl || "",
        phoneNumber: "",
        phoneMasked: "",
        phoneVerified: false,
        phoneBindMethod: "",
        phoneBoundAt: null
      };
    } else if (event.nickname && event.nickname !== user.nickname) {
      await db.collection("users").doc(user._id).update({
        data: {
          nickname: event.nickname,
          updatedAt: now
        }
      });
      user.nickname = event.nickname;
    } else {
      await db.collection("users").doc(user._id).update({
        data: {
          lastLoginAt: now,
          updatedAt: now
        }
      });
    }

    const admin = await getAdminByOpenid(openid);

    return {
      ok: true,
      data: {
        user: (() => {
          const clean = { ...user, ...publicPhoneProfile(user) };
          delete clean.phoneNumber;
          delete clean.phone;
          return clean;
        })(),
        isAdmin: !!admin,
        adminProfile: admin ? {
          role: admin.role,
          roleName: admin.roleName,
          permissions: admin.permissions || [],
          status: admin.status || "active"
        } : null
      }
    };
  } catch (err) {
    return { ok: false, message: err.message || "登录失败" };
  }
};

