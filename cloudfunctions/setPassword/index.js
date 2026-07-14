const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function maskPhone(phone) {
  const value = String(phone || "").replace(/\D/g, "");
  const normalized = value.length > 11 ? value.slice(-11) : value;
  if (!/^1[3-9]\d{9}$/.test(normalized)) return "";
  return `${normalized.slice(0, 3)}****${normalized.slice(7)}`;
}

function generatePasswordHash(password) {
  const salt = crypto.randomBytes(32).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return { hash, salt };
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const password = String(event.password || "");
  const confirmPassword = String(event.confirmPassword || "");
  const now = db.serverDate();

  if (!openid) return { ok: false, code: "NO_OPENID", message: "请先登录" };
  if (password.length < 6) {
    return { ok: false, code: "PASSWORD_TOO_SHORT", message: "密码长度至少 6 位" };
  }
  if (password !== confirmPassword) {
    return { ok: false, code: "PASSWORD_MISMATCH", message: "两次输入的密码不一致" };
  }

  try {
    const usersResult = await db.collection("users").where({ openid }).limit(1).get();
    const user = usersResult.data && usersResult.data[0];
    if (!user) return { ok: false, code: "USER_NOT_FOUND", message: "用户不存在，请先登录" };
    if (user.status === "disabled") {
      return { ok: false, code: "USER_DISABLED", message: "账号已被禁用，请联系客服" };
    }

    const { hash, salt } = generatePasswordHash(password);
    const phone = user.phone || user.phoneNumber || "";
    await db.collection("users").doc(user._id).update({
      data: {
        passwordHash: hash,
        passwordSalt: salt,
        hasPassword: true,
        phoneMasked: user.phoneMasked || maskPhone(phone),
        passwordUpdatedAt: now,
        updatedAt: now
      }
    });

    return {
      ok: true,
      data: {
        hasPassword: true,
        phoneMasked: user.phoneMasked || maskPhone(phone)
      },
      message: "密码设置成功"
    };
  } catch (err) {
    console.error("setPassword error:", err && err.message || err);
    return { ok: false, code: "SET_PASSWORD_FAILED", message: "设置密码失败，请稍后重试" };
  }
};
