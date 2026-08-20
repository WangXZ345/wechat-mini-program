"use strict";

function timestamp(value) {
  if (!value) return NaN;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
}

function processingStartedAt(record = {}) {
  for (const field of ["lockedAt", "updatedAt", "createdAt"]) {
    const time = timestamp(record[field]);
    if (Number.isFinite(time)) return time;
  }
  return NaN;
}

function sameExecution(candidate = {}, current = {}) {
  return String(candidate.executionLeaseDigest || "") === String(current.executionLeaseDigest || "")
    && Number(candidate.executionAttempt || 0) === Number(current.executionAttempt || 0);
}

function createCleanupCore({ db } = {}) {
  if (!db || typeof db.runTransaction !== "function") {
    throw new Error("cleanup idempotency requires db.runTransaction");
  }

  async function markExpired(records, errorCode, errorMessage, cutoff) {
    const cutoffTime = timestamp(cutoff);
    if (!Number.isFinite(cutoffTime)) throw new Error("cleanup cutoff is invalid");
    let updated = 0;
    const seen = new Set();
    for (const candidate of records || []) {
      if (!candidate || !candidate._id || seen.has(candidate._id)) continue;
      seen.add(candidate._id);
      const changed = await db.runTransaction(async (transaction) => {
        const response = await transaction.collection("idempotency_records").doc(candidate._id).get();
        const current = response && response.data;
        if (!current
          || current.status !== "processing"
          || !sameExecution(candidate, current)
          || !(processingStartedAt(current) < cutoffTime)) {
          return false;
        }
        await transaction.collection("idempotency_records").doc(candidate._id).update({
          data: {
            status: "expired",
            errorCode,
            errorMessage,
            updatedAt: db.serverDate()
          }
        });
        return true;
      }).catch(() => false);
      if (changed) updated += 1;
    }
    return updated;
  }

  async function removeExpired(records, now) {
    const nowTime = timestamp(now);
    if (!Number.isFinite(nowTime)) throw new Error("cleanup time is invalid");
    let removed = 0;
    const seen = new Set();
    for (const candidate of records || []) {
      if (!candidate || !candidate._id || seen.has(candidate._id)) continue;
      seen.add(candidate._id);
      const changed = await db.runTransaction(async (transaction) => {
        const response = await transaction.collection("idempotency_records").doc(candidate._id).get();
        const current = response && response.data;
        if (!current || current.status === "processing" || !(timestamp(current.expiresAt) < nowTime)) return false;
        await transaction.collection("idempotency_records").doc(candidate._id).remove();
        return true;
      }).catch(() => false);
      if (changed) removed += 1;
    }
    return removed;
  }

  return { markExpired, removeExpired };
}

module.exports = { createCleanupCore, processingStartedAt, sameExecution };
