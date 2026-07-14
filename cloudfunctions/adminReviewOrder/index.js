const cloud = require("wx-server-sdk");
const { requirePermission } = require("./auth");
const { createOrderReviewService } = require("./orderReviewService");
const { createHandler } = require("./handler");
const { ownerKeyFor } = require("./common/syncEvents");
const stockAlert = require("./stockAlert");
const idempotency = require("./common/idempotency");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const service = createOrderReviewService({
  db,
  command: db.command,
  stockAlert,
  idempotency,
  ownerKeyFor,
  syncOwnerPepper: process.env.SYNC_OWNER_PEPPER,
  recalculateAccount({ userId, userOpenid }) {
    return cloud.callFunction({ name: "recalculateCustomerAccount", data: { userId, userOpenid } });
  }
});

exports.main = createHandler({ service, requirePermission });
