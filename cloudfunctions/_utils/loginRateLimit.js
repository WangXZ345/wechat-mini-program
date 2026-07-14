/**
 * 登录失败计数和限制
 * 使用内存存储，重启后清空
 */

// 存储格式: { phone: { count: 3, lockedUntil: timestamp } }
const loginFailures = {};

const MAX_ATTEMPTS = 5; // 最大失败次数
const LOCK_DURATION_MS = 10 * 60 * 1000; // 锁定时长 10 分钟
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 计数窗口 5 分钟

/**
 * 检查是否被锁定
 * @param {string} phone - 手机号
 * @returns {{locked: boolean, remainingSeconds: number}}
 */
function checkLocked(phone) {
  const record = loginFailures[phone];
  if (!record) {
    return { locked: false, remainingSeconds: 0 };
  }

  const now = Date.now();

  // 检查是否过了锁定时间
  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return { locked: true, remainingSeconds };
  }

  // 锁定时间已过，清除记录
  if (record.lockedUntil && now >= record.lockedUntil) {
    delete loginFailures[phone];
    return { locked: false, remainingSeconds: 0 };
  }

  return { locked: false, remainingSeconds: 0 };
}

/**
 * 记录登录失败
 * @param {string} phone - 手机号
 * @returns {{locked: boolean, remainingSeconds: number, attempts: number}}
 */
function recordFailure(phone) {
  const now = Date.now();
  const record = loginFailures[phone];

  if (!record) {
    loginFailures[phone] = {
      count: 1,
      firstAttemptAt: now,
      lockedUntil: null
    };
    return { locked: false, remainingSeconds: 0, attempts: 1 };
  }

  // 如果第一次尝试时间超过窗口期，重置计数
  if (now - record.firstAttemptAt > ATTEMPT_WINDOW_MS) {
    loginFailures[phone] = {
      count: 1,
      firstAttemptAt: now,
      lockedUntil: null
    };
    return { locked: false, remainingSeconds: 0, attempts: 1 };
  }

  // 增加失败计数
  record.count++;

  // 达到最大失败次数，锁定账号
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCK_DURATION_MS;
    const remainingSeconds = Math.ceil(LOCK_DURATION_MS / 1000);
    return { locked: true, remainingSeconds, attempts: record.count };
  }

  return { locked: false, remainingSeconds: 0, attempts: record.count };
}

/**
 * 清除失败计数（登录成功后调用）
 * @param {string} phone - 手机号
 */
function clearFailures(phone) {
  delete loginFailures[phone];
}

module.exports = {
  checkLocked,
  recordFailure,
  clearFailures
};
