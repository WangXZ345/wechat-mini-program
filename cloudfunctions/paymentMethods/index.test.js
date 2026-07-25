"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function createFakeCloud() {
  let systemSettings = {
    maxPaymentScreenshotCount: 3,
    requirePaymentProofForOfflinePayment: true
  };
  const db = {
    command: {},
    serverDate: () => new Date(),
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (name === "settings" && id === "system_settings") {
                return { data: { ...systemSettings } };
              }
              return { data: null };
            }
          };
        }
      };
    }
  };
  const sdk = {
    DYNAMIC_CURRENT_ENV: "dynamic",
    init() {},
    database: () => db,
    getWXContext: () => ({ OPENID: "test-openid" })
  };
  return {
    sdk,
    setMaxPaymentScreenshotCount(value) {
      systemSettings = { ...systemSettings, maxPaymentScreenshotCount: value };
    }
  };
}

const fakeCloud = createFakeCloud();
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "wx-server-sdk") return fakeCloud.sdk;
  return originalLoad.call(this, request, parent, isMain);
};
const paymentMethods = require("./index");
const wrapper = require("../submitOfflinePaymentProof/index");
fakeCloud.sdk.callFunction = async ({ data }) => ({ result: await paymentMethods.main(data) });
Module._load = originalLoad;

test("submitOfflinePaymentProof wrapper preserves a payment proof policy error code", async () => {
  const result = await wrapper.main({
    orderId: "order-current",
    paymentMethodId: "method-1",
    screenshotUrls: ["https://example.test/payment-proof.jpg"]
  });

  assert.deepEqual(result, {
    ok: false,
    code: "PAYMENT_PROOF_INVALID_FILE_ID",
    message: "付款截图文件无效，请重新上传"
  });
});

test("submitOfflinePaymentProof normalizes screenshot limits before rejecting excess proofs", async (t) => {
  const screenshotUrls = Array.from(
    { length: 20 },
    (_, index) => `cloud://test-env.123/payments/order-current/17100000000${String(index).padStart(2, "0")}-${index}.jpg`
  );
  const cases = [
    { name: "NaN uses the trusted default", value: Number.NaN, expectedLimit: 3 },
    { name: "non-number uses the trusted default", value: "not-a-number", expectedLimit: 3 },
    { name: "Infinity uses the trusted default", value: Number.POSITIVE_INFINITY, expectedLimit: 3 },
    { name: "empty value uses the trusted default", value: "", expectedLimit: 3 },
    { name: "whitespace-only value uses the trusted default", value: " ", expectedLimit: 3 },
    { name: "empty array uses the trusted default", value: [], expectedLimit: 3 },
    { name: "boolean true uses the trusted default", value: true, expectedLimit: 3 },
    { name: "boolean false uses the trusted default", value: false, expectedLimit: 3 },
    { name: "integer remains compatible", value: 2, expectedLimit: 2 },
    { name: "numeric string remains compatible", value: "4", expectedLimit: 4 },
    { name: "numeric string is clamped at the low bound", value: "0", expectedLimit: 1 },
    { name: "numeric string is clamped at the high bound", value: "10", expectedLimit: 9 },
    { name: "zero keeps the existing default behavior", value: 0, expectedLimit: 3 },
    { name: "high value is clamped", value: 10, expectedLimit: 9 }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      fakeCloud.setMaxPaymentScreenshotCount(entry.value);
      const result = await paymentMethods.main({
        action: "submitOfflinePaymentProof",
        orderId: "order-current",
        paymentMethodId: "method-1",
        screenshotUrls
      });

      assert.deepEqual(result, {
        ok: false,
        code: "PAYMENT_PROOF_LIMIT_EXCEEDED",
        message: `付款截图最多上传 ${entry.expectedLimit} 张`
      });
    });
  }

  fakeCloud.setMaxPaymentScreenshotCount(3);
});
