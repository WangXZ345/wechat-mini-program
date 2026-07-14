const cloud = require("wx-server-sdk");
const { publicPhoneProfile } = require("./common/phone");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const MAX_NICKNAME_LENGTH = 20;

function ok(data) {
  return { ok: true, data };
}

function fail(message, code) {
  return { ok: false, code, message };
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeNickname(value) {
  return String(value || "").trim();
}

function validateNickname(value) {
  const nickname = normalizeNickname(value);
  if (!nickname) {
    const err = new Error("请输入昵称");
    err.code = "INVALID_NICKNAME";
    throw err;
  }
  if (Array.from(nickname).length > MAX_NICKNAME_LENGTH) {
    const err = new Error(`昵称不能超过 ${MAX_NICKNAME_LENGTH} 个字符`);
    err.code = "INVALID_NICKNAME";
    throw err;
  }
  return nickname;
}

async function getOrCreateUser(openid, event = {}) {
  const now = db.serverDate();
  const shouldUpdateNickname = hasOwn(event, "nickname");
  const nextNickname = shouldUpdateNickname ? validateNickname(event.nickname) : "";
  const res = await db.collection("users").where({ openid }).limit(1).get();
  const existing = res.data[0];
  if (existing) {
    const patch = { lastLoginAt: now, updatedAt: now };
    if (shouldUpdateNickname && nextNickname !== (existing.nickname || "")) patch.nickname = nextNickname;
    if (event.avatarUrl && event.avatarUrl !== existing.avatarUrl) patch.avatarUrl = String(event.avatarUrl).trim();
    await db.collection("users").doc(existing._id).update({ data: patch });
    return { ...existing, ...patch };
  }

  const data = {
    openid,
    nickname: shouldUpdateNickname ? nextNickname : "",
    avatarUrl: String(event.avatarUrl || "").trim(),
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
  };
  const created = await db.collection("users").add({ data });
  return { _id: created._id, ...data };
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail("登录状态无效，请重新进入小程序", "LOGIN_REQUIRED");

  try {
    const user = await getOrCreateUser(openid, event);
    return ok({
      profile: {
        openid,
        openidSuffix: openid.slice(-6),
        nickname: user.nickname || "",
        avatarUrl: user.avatarUrl || "",
        ...publicPhoneProfile(user)
      }
    });
  } catch (err) {
    return fail(err.message || "获取个人资料失败", err.code);
  }
};
