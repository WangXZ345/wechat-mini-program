"use strict";

class PaymentProofPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PaymentProofPolicyError";
    this.code = code;
  }
}

function policyError(code, message) {
  return new PaymentProofPolicyError(code, message);
}

function decodeSegmentUntilStable(segment) {
  let current = segment;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch (_) {
      return null;
    }
    if (decoded === current) return decoded;
    current = decoded;
  }
  return null;
}

function cloudPathFromFileID(fileID) {
  const match = /^cloud:\/\/[^/\s]+\/(.+)$/.exec(fileID);
  if (!match) {
    throw policyError("PAYMENT_PROOF_INVALID_FILE_ID", "付款截图文件无效，请重新上传");
  }
  const cloudPath = match[1];
  const segments = cloudPath.split("/");
  const hasTraversal = !cloudPath
    || cloudPath.startsWith("/")
    || cloudPath.includes("\\")
    || segments.some((segment) => {
      const decoded = decodeSegmentUntilStable(segment);
      return !decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    });
  if (hasTraversal) {
    throw policyError("PAYMENT_PROOF_INVALID_FILE_PATH", "付款截图路径无效，请重新上传");
  }
  return cloudPath;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function belongsToCurrentOrder(cloudPath, orderId) {
  const orderKey = String(orderId || "").trim();
  if (!orderKey) return false;
  if (cloudPath.startsWith(`payments/${orderKey}/`)) return true;
  const legacyPattern = new RegExp(`^payments/${escapeRegExp(orderKey)}-\\d{10,}-\\d+\\.(?:jpg|jpeg|png|webp)$`, "i");
  return legacyPattern.test(cloudPath);
}

function assertPaymentProofFileIDs(fileIDs, { orderId, maxCount }) {
  const files = Array.isArray(fileIDs) ? fileIDs.map((value) => String(value || "").trim()).filter(Boolean) : [];
  const limit = Number(maxCount);
  if (files.length > limit) {
    throw policyError("PAYMENT_PROOF_LIMIT_EXCEEDED", `付款截图最多上传 ${limit} 张`);
  }

  const seen = new Set();
  for (const fileID of files) {
    if (seen.has(fileID)) {
      throw policyError("PAYMENT_PROOF_DUPLICATE", "付款截图不能重复上传");
    }
    seen.add(fileID);
    const cloudPath = cloudPathFromFileID(fileID);
    if (!belongsToCurrentOrder(cloudPath, orderId)) {
      throw policyError("PAYMENT_PROOF_ORDER_MISMATCH", "付款截图与当前订单不匹配，请重新上传");
    }
  }
  return files;
}

module.exports = {
  PaymentProofPolicyError,
  assertPaymentProofFileIDs
};
