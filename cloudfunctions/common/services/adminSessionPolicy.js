"use strict";

const DEFAULT_IDLE_MINUTES = 30;

function readSessionIdleMinutes(source = {}) {
  const value = source && typeof source === "object" ? source.sessionIdleMinutes : source;
  return Number.isSafeInteger(value) && value >= 5 && value <= 240 ? value : DEFAULT_IDLE_MINUTES;
}

function assertSessionIdleLifetime(session = {}, nowMs = Date.now()) {
  const timeout = session.idleTimeoutMinutes;
  if (!Number.isSafeInteger(timeout) || timeout < 5 || timeout > 240) return;
  const lastActivity = new Date(session.lastActivityAt).getTime();
  if (!Number.isFinite(lastActivity) || lastActivity + timeout * 60 * 1000 <= nowMs) {
    const error = new Error("登录状态因长时间未操作而失效");
    error.code = "SESSION_IDLE_EXPIRED";
    error.statusCode = 401;
    throw error;
  }
}

module.exports = { DEFAULT_IDLE_MINUTES, readSessionIdleMinutes, assertSessionIdleLifetime };
