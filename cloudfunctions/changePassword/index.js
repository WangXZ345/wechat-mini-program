const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
}

function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) return false;
  try {
    const hash = Buffer.from(hashPassword(password, storedSalt), "hex");
    const expected = Buffer.from(storedHash, "hex");
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch (err) {
    return false;
  }
}

function generatePasswordHash(password) {
  const salt = crypto.randomBytes(32).toString("hex");
  const hash = hashPassword(password, salt);
  return { hash, salt };
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const oldPassword = String(event.oldPassword || "");
  const newPassword = String(event.newPassword || "");
  const confirmPassword = String(event.confirmPassword || "");
  const now = db.serverDate();

  if (!openid) return { ok: false, code: "NO_OPENID", message: "请先登录" };
  if (!oldPassword) return { ok: false, code: "OLD_PASSWORD_REQUIRED", message: "请输入原密码" };
  if (newPassword.length < 6) {
    return { ok: false, code: "PASSWORD_TOO_SHORT", message: "新密码长度至少 6 位" };
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, code: "PASSWORD_MISMATCH", message: "两次输入的新密码不一致" };
  }

  try {
    const usersResult = await db.collection("users").where({ openid }).limit(1).get();
    const user = usersResult.data && usersResult.data[0];
    if (!user) return { ok: false, code: "USER_NOT_FOUND", message: "用户不存在，请先登录" };
    if (user.status === "disabled") {
      return { ok: false, code: "USER_DISABLED", message: "账号已被禁用，请联系客服" };
    }
    if (!user.hasPassword || !verifyPassword(oldPassword, user.passwordHash, user.passwordSalt)) {
      return { ok: false, code: "INVALID_OLD_PASSWORD", message: "原密码错误，请检查后重试" };
    }

    const { hash, salt } = generatePasswordHash(newPassword);
    await db.collection("users").doc(user._id).update({
      data: {
        passwordHash: hash,
        passwordSalt: salt,
        hasPassword: true,
        passwordUpdatedAt: now,
        updatedAt: now
      }
    });

    return { ok: true, data: { hasPassword: true }, message: "密码修改成功" };
  } catch (err) {
    console.error("changePassword error:", err && err.message || err);
    return { ok: false, code: "CHANGE_PASSWORD_FAILED", message: "修改密码失败，请稍后重试" };
  }
};
