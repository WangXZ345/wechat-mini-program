"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPaymentProofFileIDs, PaymentProofPolicyError } = require("./paymentProofPolicy");

const orderId = "order-current";
const fileID = (path) => `cloud://test-env.123/${path}`;

test("accepts CloudBase payment proof file IDs in the current order directory", () => {
  const files = [
    fileID("payments/order-current/1710000000000-0.jpg"),
    fileID("payments/order-current/1710000000001-1.png")
  ];

  assert.deepEqual(assertPaymentProofFileIDs(files, { orderId, maxCount: 3 }), files);
});

test("accepts the legacy current-order payment proof filename format", () => {
  const files = [fileID("payments/order-current-1710000000000-0.jpg")];

  assert.deepEqual(assertPaymentProofFileIDs(files, { orderId, maxCount: 3 }), files);
});

test("rejects a legacy payment proof path for a similar order ID", () => {
  assert.throws(
    () => assertPaymentProofFileIDs([fileID("payments/order-current-extra-1710000000000-0.jpg")], { orderId, maxCount: 3 }),
    (err) => err instanceof PaymentProofPolicyError && err.code === "PAYMENT_PROOF_ORDER_MISMATCH" && err.message === "付款截图与当前订单不匹配，请重新上传"
  );
});

test("rejects a payment proof file ID from another order", () => {
  assert.throws(
    () => assertPaymentProofFileIDs([fileID("payments/order-other/1710000000000-0.jpg")], { orderId, maxCount: 3 }),
    (err) => err instanceof PaymentProofPolicyError && err.code === "PAYMENT_PROOF_ORDER_MISMATCH" && err.message === "付款截图与当前订单不匹配，请重新上传"
  );
});

test("rejects an HTTP URL instead of a CloudBase file ID", () => {
  assert.throws(
    () => assertPaymentProofFileIDs(["https://example.test/payment-proof.jpg"], { orderId, maxCount: 3 }),
    (err) => err instanceof PaymentProofPolicyError && err.code === "PAYMENT_PROOF_INVALID_FILE_ID" && err.message === "付款截图文件无效，请重新上传"
  );
});

test("rejects payment proof paths containing traversal segments", () => {
  assert.throws(
    () => assertPaymentProofFileIDs([fileID("payments/order-current/../order-other/proof.jpg")], { orderId, maxCount: 3 }),
    (err) => err instanceof PaymentProofPolicyError && err.code === "PAYMENT_PROOF_INVALID_FILE_PATH" && err.message === "付款截图路径无效，请重新上传"
  );
});

test("rejects payment proof paths containing double-encoded traversal separators", () => {
  assert.throws(
    () => assertPaymentProofFileIDs([fileID("payments/order-current/%252e%252e%252Forder-other/proof.jpg")], { orderId, maxCount: 3 }),
    (err) => err instanceof PaymentProofPolicyError && err.code === "PAYMENT_PROOF_INVALID_FILE_PATH" && err.message === "付款截图路径无效，请重新上传"
  );
});

test("rejects duplicate payment proof file IDs", () => {
  const proof = fileID("payments/order-current/1710000000000-0.jpg");
  assert.throws(
    () => assertPaymentProofFileIDs([proof, proof], { orderId, maxCount: 3 }),
    (err) => err instanceof PaymentProofPolicyError && err.code === "PAYMENT_PROOF_DUPLICATE" && err.message === "付款截图不能重复上传"
  );
});

test("rejects payment proof file IDs beyond the configured screenshot limit", () => {
  assert.throws(
    () => assertPaymentProofFileIDs([
      fileID("payments/order-current/1710000000000-0.jpg"),
      fileID("payments/order-current/1710000000001-1.jpg"),
      fileID("payments/order-current/1710000000002-2.jpg"),
      fileID("payments/order-current/1710000000003-3.jpg")
    ], { orderId, maxCount: 3 }),
    (err) => err instanceof PaymentProofPolicyError && err.code === "PAYMENT_PROOF_LIMIT_EXCEEDED" && err.message === "付款截图最多上传 3 张"
  );
});
