const HAPTIC_ENABLED = true;
const THROTTLE_MS = 300;

const TYPE_MAP = {
  light: "light",
  medium: "medium",
  heavy: "heavy",
  selection: "light",
  success: "medium",
  warning: "medium",
  error: "heavy"
};

const lastVibrateAt = {};

function canUseTypedVibrate() {
  try {
    return typeof wx !== "undefined"
      && typeof wx.canIUse === "function"
      && wx.canIUse("vibrateShort.object.type");
  } catch (err) {
    return false;
  }
}

function vibrate(type = "light") {
  if (!HAPTIC_ENABLED) return;
  if (typeof wx === "undefined" || typeof wx.vibrateShort !== "function") return;

  const key = TYPE_MAP[type] ? type : "light";
  const now = Date.now();
  if (lastVibrateAt[key] && now - lastVibrateAt[key] < THROTTLE_MS) return;
  lastVibrateAt[key] = now;

  try {
    if (canUseTypedVibrate()) {
      wx.vibrateShort({ type: TYPE_MAP[key] || "light" });
      return;
    }
    wx.vibrateShort();
  } catch (err) {
    try {
      wx.vibrateShort();
    } catch (fallbackErr) {
      // Haptic feedback must never block the original user action.
    }
  }
}

function light() {
  vibrate("light");
}

function medium() {
  vibrate("medium");
}

function heavy() {
  vibrate("heavy");
}

function error() {
  vibrate("error");
}

function success() {
  vibrate("success");
}

function warning() {
  vibrate("warning");
}

function selection() {
  vibrate("selection");
}

module.exports = {
  light,
  medium,
  heavy,
  error,
  success,
  warning,
  selection
};
