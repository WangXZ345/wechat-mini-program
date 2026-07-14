const crypto = require("crypto");

function cleanString(value, max = 4096) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

function safeSecretEqual(left, right) {
  const a = cleanString(left);
  const b = cleanString(right);
  if (!a || !b) return false;
  const leftHash = crypto.createHash("sha256").update(a).digest();
  const rightHash = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

async function authorizeCleanup(options = {}) {
  const configuredSecret = cleanString(options.env && options.env.SYNC_CLEANUP_SECRET);
  const suppliedSecret = cleanString(options.event && options.event.secret);
  if (configuredSecret.length >= 32 && safeSecretEqual(configuredSecret, suppliedSecret)) return true;

  const openid = cleanString(options.context && options.context.OPENID, 128);
  if (!openid || typeof options.findAdmin !== "function") return false;
  const admin = await options.findAdmin(openid).catch(() => null);
  return Boolean(admin
    && admin.role === "super_admin"
    && admin.isActive !== false
    && admin.status !== "disabled");
}

module.exports = { cleanString, safeSecretEqual, authorizeCleanup };
