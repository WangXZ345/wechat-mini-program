"use strict";

const cloud = require("wx-server-sdk");
const { requirePermission } = require("./auth");
const idempotency = require("./common/idempotency");
const { ownerKeyFor } = require("./common/syncEvents");
const { createPaymentMutationService } = require("./paymentMutationService");
const { createHandler } = require("./handler");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const service = createPaymentMutationService({
  db,
  idempotency,
  ownerKeyFor,
  syncOwnerPepper: process.env.SYNC_OWNER_PEPPER,
  recalculateAccount({ userId, userOpenid }) {
    return cloud.callFunction({
      name: "recalculateCustomerAccount",
      data: { userId, userOpenid }
    });
  }
});

exports.main = createHandler({
  service,
  requirePermission,
  db,
  callFunction(name, data) {
    return cloud.callFunction({ name, data });
  }
});
