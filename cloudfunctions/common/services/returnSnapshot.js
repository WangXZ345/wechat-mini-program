"use strict";

function cleanText(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value.$date) return new Date(value.$date);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function assertAfterSaleSnapshot(afterSale, event = {}, allowedStatuses = []) {
  if (allowedStatuses.length && event.expectedStatus !== undefined
    && !allowedStatuses.includes(cleanText(event.expectedStatus, 60))) {
    const err = new Error("售后单当前状态快照无效，请刷新后重试");
    err.code = "EXPECTED_STATUS_INVALID";
    throw err;
  }
  const currentVersion = Number(afterSale.version || 0);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    const err = new Error("售后单版本数据异常");
    err.code = "DATA_VERSION_INVALID";
    throw err;
  }
  if (event.expectedVersion !== undefined) {
    if (!Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 0) {
      const err = new Error("售后单版本无效，请刷新后重试");
      err.code = "EXPECTED_VERSION_INVALID";
      throw err;
    }
    if (event.expectedVersion !== currentVersion) {
      const err = new Error("售后单已变化，请刷新后重试");
      err.code = "DATA_VERSION_CONFLICT";
      throw err;
    }
  }
  if (event.expectedUpdatedAt !== undefined) {
    const expected = toDate(event.expectedUpdatedAt);
    const actual = toDate(afterSale.updatedAt);
    if (!expected || !actual || expected.getTime() !== actual.getTime()) {
      const err = new Error("售后单已变化，请刷新后重试");
      err.code = "DATA_VERSION_CONFLICT";
      throw err;
    }
  }
  return currentVersion;
}

function canCompleteAfterSale(status) {
  return ["approved", "refunded", "exchanged", "resent"].includes(cleanText(status, 60));
}

module.exports = { assertAfterSaleSnapshot, canCompleteAfterSale };
