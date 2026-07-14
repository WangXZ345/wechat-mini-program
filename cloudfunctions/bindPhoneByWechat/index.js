const cloud = require("wx-server-sdk");
const { normalizePhone, maskPhone, publicPhoneProfile } = require("./common/phone");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PHONE_CONFLICT_MESSAGE = "该手机号已绑定其他账号，请联系商家处理。";

function ok(data) {
  return { ok: true, data };
}

function fail(message, code) {
  return { ok: false, code, message };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (err) {
    const message = String((err && err.message) || err || "");
    if (!/already exists|collection exists|DATABASE_COLLECTION_ALREADY_EXIST|already_exist|exist/i.test(message)) throw err;
  }
}

async function getOrCreateUser(openid) {
  const now = db.serverDate();
  const res = await db.collection("users").where({ openid }).limit(1).get();
  if (res.data[0]) return res.data[0];
  const data = {
    openid,
    nickname: "",
    avatarUrl: "",
    phoneNumber: "",
    phoneMasked: "",
    phoneVerified: false,
    phoneBindMethod: "",
    phoneBoundAt: null,
    phoneUpdatedAt: null,
    phoneChangeCount: 0,
    createdAt: now,
    updatedAt: now
  };
  const created = await db.collection("users").add({ data });
  return { _id: created._id, ...data };
}

async function getPhoneByWechatCode(code) {
  if (!code) throw new Error("授权 code 为空，请重新授权");
  if (!cloud.openapi || !cloud.openapi.phonenumber || !cloud.openapi.phonenumber.getPhoneNumber) {
    throw new Error("当前云函数环境不支持手机号授权接口，请检查基础库和云开发能力");
  }
  const result = await cloud.openapi.phonenumber.getPhoneNumber({ code });
  const info = result.phone_info || result.phoneInfo || {};
  const phoneNumber = info.phoneNumber || info.purePhoneNumber || info.pure_phone_number || "";
  if (!phoneNumber) throw new Error("微信手机号授权未返回手机号，请重新授权");
  return normalizePhone(phoneNumber);
}

async function assertPhoneNotUsed(phoneNumber, openid) {
  const byNew = await db.collection("users").where({ phoneNumber, openid: _.neq(openid) }).limit(1).get();
  if (byNew.data[0]) throw new Error(PHONE_CONFLICT_MESSAGE);
  const byLegacy = await db.collection("users").where({ phone: phoneNumber, openid: _.neq(openid) }).limit(1).get();
  if (byLegacy.data[0]) throw new Error(PHONE_CONFLICT_MESSAGE);
}

async function getMaxPhoneChangePerDay() {
  const res = await db.collection("settings").doc("system_settings").get().catch(() => null);
  const settings = res && res.data ? res.data : {};
  return Math.max(1, Number(settings.maxPhoneChangePerDay || 3));
}

async function assertChangeLimit(openid, user, maxPhoneChangePerDay) {
  if (!user.phoneNumber && !user.phone) return;
  await ensureCollection("phone_bind_logs");
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await db.collection("phone_bind_logs")
    .where({ openid, action: "update", createdAt: _.gte(since) })
    .count();
  if (Number(count.total || 0) >= maxPhoneChangePerDay) {
    throw new Error("手机号更换过于频繁，请稍后再试");
  }
}

async function writePhoneLog({ user, openid, beforePhone, afterPhone, beforeVerified, action }) {
  await ensureCollection("phone_bind_logs");
  await db.collection("phone_bind_logs").add({
    data: {
      userId: user._id,
      openid,
      beforePhoneMasked: maskPhone(beforePhone),
      afterPhoneMasked: maskPhone(afterPhone),
      beforePhoneVerified: Boolean(beforeVerified),
      afterPhoneVerified: true,
      bindMethod: "wechat",
      action,
      operatorType: "user",
      operatorId: user._id,
      operatorOpenid: openid,
      ipInfo: null,
      userAgent: "",
      createdAt: db.serverDate()
    }
  });
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return fail("登录状态无效，请重新进入小程序", "LOGIN_REQUIRED");

  try {
    const phoneNumber = await getPhoneByWechatCode(String(event.code || "").trim());
    const user = await getOrCreateUser(openid);
    const beforePhone = user.phoneNumber || user.phone || "";
    const beforeVerified = Boolean(user.phoneVerified);
    const samePhone = beforePhone === phoneNumber;

    await assertPhoneNotUsed(phoneNumber, openid);
    if (!samePhone) await assertChangeLimit(openid, user, await getMaxPhoneChangePerDay());

    const now = db.serverDate();
    const action = beforePhone && !samePhone ? "update" : "bind";
    const phoneMasked = maskPhone(phoneNumber);
    const patch = {
      phoneNumber,
      phoneMasked,
      phoneVerified: true,
      phoneBindMethod: "wechat",
      phoneUpdatedAt: now,
      updatedAt: now
    };
    if (!user.phoneBoundAt) patch.phoneBoundAt = now;
    if (!samePhone && beforePhone) patch.phoneChangeCount = _.inc(1);

    await db.collection("users").doc(user._id).update({ data: patch });
    if (!samePhone || !beforeVerified || user.phoneBindMethod !== "wechat") {
      await writePhoneLog({ user, openid, beforePhone, afterPhone: phoneNumber, beforeVerified, action });
    }

    return ok({
      message: "手机号绑定成功",
      profile: publicPhoneProfile({ ...user, ...patch, phoneNumber })
    });
  } catch (err) {
    const message = err.message || "微信手机号授权绑定失败";
    return fail(message, message === PHONE_CONFLICT_MESSAGE ? "PHONE_CONFLICT" : undefined);
  }
};
