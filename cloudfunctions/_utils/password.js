const crypto = require("crypto");

/**
 * 生成随机 salt
 * @param {number} length - salt 长度，默认 32
 * @returns {string} hex 编码的 salt
 */
function generateSalt(length = 32) {
  return crypto.randomBytes(length).toString("hex");
}

/**
 * 使用 PBKDF2 对密码进行哈希
 * @param {string} password - 明文密码
 * @param {string} salt - 盐值
 * @returns {string} hex 编码的密码哈希
 */
function hashPassword(password, salt) {
  if (!password || !salt) {
    throw new Error("密码和盐值不能为空");
  }
  // 使用 PBKDF2，迭代 100000 次，输出 64 字节
  const hash = crypto.pbkdf2Sync(
    password,
    salt,
    100000,
    64,
    "sha512"
  );
  return hash.toString("hex");
}

/**
 * 验证密码
 * @param {string} password - 用户输入的密码
 * @param {string} storedHash - 存储的密码哈希
 * @param {string} storedSalt - 存储的盐值
 * @returns {boolean} 密码是否匹配
 */
function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) {
    return false;
  }
  try {
    const hash = hashPassword(password, storedSalt);
    // 使用 timingSafeEqual 防止时序攻击
    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(storedHash, "hex")
    );
  } catch (err) {
    return false;
  }
}

/**
 * 生成密码哈希和盐值
 * @param {string} password - 明文密码
 * @returns {{hash: string, salt: string}}
 */
function generatePasswordHash(password) {
  if (!password) {
    throw new Error("密码不能为空");
  }
  const salt = generateSalt();
  const hash = hashPassword(password, salt);
  return { hash, salt };
}

/**
 * 手机号脱敏
 * @param {string} phone - 完整手机号
 * @returns {string} 脱敏后的手机号
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== "string") return "";
  if (phone.length !== 11) return phone;
  return phone.substring(0, 3) + "****" + phone.substring(7);
}

module.exports = {
  generateSalt,
  hashPassword,
  verifyPassword,
  generatePasswordHash,
  maskPhone
};
