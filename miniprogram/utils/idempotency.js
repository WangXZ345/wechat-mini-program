function randomText() {
  return Math.random().toString(36).slice(2, 10);
}

function generateIdempotencyKey(actionType) {
  const action = String(actionType || "action").replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 40);
  return `${action}*${Date.now()}*${randomText()}`;
}

const DEFAULT_SUBMIT_KEY_MAX_AGE_MS = 2 * 60 * 1000;

function storageKey(scene) {
  return `idempotency_submit_${scene}`;
}

function normalizeSubmitKeyRecord(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { value: raw, createdAt: 0, legacy: true };
  if (raw && typeof raw === "object" && raw.value) {
    return {
      value: String(raw.value || ""),
      createdAt: Number(raw.createdAt || 0),
      legacy: false
    };
  }
  return null;
}

function getOrCreateSubmitKey(scene, options = {}) {
  const key = storageKey(scene);
  const now = Date.now();
  const maxAgeMs = Number(options.maxAgeMs === undefined ? DEFAULT_SUBMIT_KEY_MAX_AGE_MS : options.maxAgeMs);
  const record = normalizeSubmitKeyRecord(wx.getStorageSync(key));
  if (record && record.value && record.legacy) {
    if (options.reuseLegacy === false) {
      clearSubmitKey(scene);
    } else {
      clearSubmitKey(scene);
    }
  }
  const isFresh = record && record.value
    && (!maxAgeMs || (record.createdAt && now - record.createdAt <= maxAgeMs));
  if (isFresh) return record.value;

  const value = generateIdempotencyKey(scene);
  wx.setStorageSync(key, { value, createdAt: now });
  return value;
}

function createSubmitKey(scene) {
  const key = storageKey(scene);
  const value = generateIdempotencyKey(scene);
  wx.setStorageSync(key, { value, createdAt: Date.now() });
  return value;
}

function clearSubmitKey(scene) {
  wx.removeStorageSync(storageKey(scene));
}

function getButtonLockKey(action, targetId) {
  return `${action || "action"}:${targetId || "default"}`;
}

module.exports = {
  generateIdempotencyKey,
  getOrCreateSubmitKey,
  createSubmitKey,
  clearSubmitKey,
  getButtonLockKey
};
